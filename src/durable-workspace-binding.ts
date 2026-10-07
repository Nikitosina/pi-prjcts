import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, hook, ToolTask, type Conversation, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { DurablePrepareWorkerEnvironment } from "./durable-plan-types.ts";
import { loadProject, type Project } from "./state.ts";
import { captureEvidenceBytes } from "./evidence.ts";
import { DurablePlanning } from "./durable-planning.ts";
import { workspaceIsolation } from "./workspace-isolation.ts";
import { workspaceCapabilities, workspacePhysicalLockPath, type WorkspaceAuthority } from "./workspace-capabilities.ts";
import type { WorkspaceIntent } from "./workspace-types.ts";
import { githubWorkerTools } from "./github-worker.ts";
import { authorizationFingerprint } from "./workspace-authorization.ts";
import { commandExecution, commandResource, commandWorkerTools, hasUncertainCommands } from "./command-runtime.ts";
import type { OperationApprovals } from "./operation-approvals.ts";
import { loadDurableStanding, type DurableStanding } from "./durable-standing.ts";
import { workerSkillBinding } from "./worker-skill-tool.ts";
import { protectedSkillBackingFiles } from "./worker-skill-backing.ts";

/** Builds a trusted host callback; model work supplies only the persisted scope ID. */
export function durableWorkspaceBinding(input: { project: Project; configuredSkillLoader?: Pick<ResourceLoader, "getSkills">; conversation: () => Conversation; controlRoot: string; projectStanding?: DurableStanding; commands?: ReturnType<typeof commandExecution>; commandApprovals?: () => OperationApprovals; isClosed?: () => boolean }): DurablePrepareWorkerEnvironment | undefined {
  const authorization = input.project.workspaceAuthorization;
  if (!authorization) return undefined;
  const projectRoot = realpathSync(input.project.cwd);
  const projectStanding = input.projectStanding ?? loadDurableStanding(projectRoot);
  const repositoryById = new Map(authorization.repositories.map(repository => [repository.repositoryId, repository]));
  const scopeById = new Map(authorization.scopes.map(scope => [scope.id, scope]));
  if (repositoryById.size !== authorization.repositories.length || scopeById.size !== authorization.scopes.length) throw new Error("Workspace authorization has duplicate repository or scope IDs");
  return async request => {
    const scope = scopeById.get(request.workspaceScopeId); if (!scope) throw new Error("Unknown host workspace scope");
    const repository = repositoryById.get(scope.repositoryId); if (!repository || repository.provider !== authorization.provider) throw new Error("Workspace scope repository/provider is not host-authorized");
    const selectedRepository = repository;
    const selectedScope = scope;
    if (scope.files.some(file => file.includes("\\") || file.split("/").some(part => !part || part === "." || part === "..") || !(file === repository.fileOwnershipPrefix || file.startsWith(`${repository.fileOwnershipPrefix}/`)))) throw new Error("Workspace scope files escape the host ownership prefix");
    const repositoryRoot = realpathSync(selectedRepository.ownerCheckout);
    const selectedStanding = repositoryRoot === projectRoot ? projectStanding : loadDurableStanding(repositoryRoot);
    const repositoryStanding = repositoryRoot !== projectRoot ? selectedStanding : undefined;
    function assertStanding() {
      if (realpathSync(selectedRepository.ownerCheckout) !== repositoryRoot) throw new Error("Selected repository standing root changed");
      const current = loadDurableStanding(repositoryRoot);
      if (current.revision !== selectedStanding.revision || current.text !== selectedStanding.text) throw new Error("Selected repository standing instructions changed; frozen thread will not be retargeted");
    }
    assertStanding();
    const provider = authorization.provider === "github" ? "git" : "arc";
    const intentId = stableUuid(`${input.project.id}:${request.threadId}:${scope.id}`), attemptId = stableUuid(`${intentId}:allocation`);
    const whole = scope.wholeRepository === true;
    const githubAuthorization = input.project.githubAuthorization?.find(item => item.repositoryId === repository.repositoryId && item.workspaceRevision === authorizationFingerprint(input.project));
    const publication = githubAuthorization;
    const name = `durable-${intentId.slice(0, 12)}`, workspacePath = join(repository.approvedRoot, name);
    const isolation = workspaceIsolation({ conversation: input.conversation(), authority: { projectId: input.project.id, owner: authorization.owner }, authorizedRepositories: [{ repositoryId: repository.repositoryId, provider, approvedRoot: repository.approvedRoot, ownerCheckout: repository.ownerCheckout, fileOwnershipPrefix: repository.fileOwnershipPrefix }] });
    // A whole-repository thread starts from owner HEAD at its first allocation and keeps that base and branch on later dispatches.
    const allocated = whole ? (await isolation.snapshot()).receipts.find(item => item.intentId === intentId)?.scope : undefined;
    const baseRevision = !whole ? scope.baseRevision : allocated?.baseRevision ?? ownerHead(repository.ownerCheckout);
    const branch = allocated?.branch ?? (publication ? `${publication.branchPrefix}${name}` : whole ? `pi/${name}` : name);
    const intent: WorkspaceIntent = { id: intentId, attemptId, action: "allocate", scope: { projectId: input.project.id, repositoryId: repository.repositoryId, provider, ownerCheckout: repository.ownerCheckout, approvedRoot: repository.approvedRoot, workspacePath, workspaceName: name, branch, baseRevision, headRevision: baseRevision, owner: authorization.owner, leaseReason: `durable workspace ${request.threadId}`, sharedObjectStore: provider === "arc" ? repository.sharedObjectStore ?? null : null, fileOwnership: scope.files, capabilityProfileRevision: hash(JSON.stringify({ authorization, scope })), ...(whole ? { allowDirtyOwner: true as const } : {}) } };
    let receipt = await isolation.allocate(intent); if (receipt.state !== "allocated") receipt = await isolation.reconcile(intent); if (receipt.state !== "allocated" || !receipt.workspacePath) throw new Error(`Workspace allocation is ${receipt.state}: ${receipt.reason ?? "no exact receipt"}`);
    if (JSON.stringify(receipt.scope) !== JSON.stringify(intent.scope)) throw new Error("Frozen workspace allocation receipt differs from current host scope; refusing registry publication");
    const authority: WorkspaceAuthority = { projectId: input.project.id, repositoryId: repository.repositoryId, provider, workspaceId: `${scope.id}:${receipt.intentId}:${request.conversationId}`, receiptId: receipt.intentId, attemptId: receipt.attemptId, leaseRevision: receipt.lease?.renewedAt ?? receipt.providerFacts.head ?? scope.baseRevision, workspaceRoot: receipt.workspacePath, files: scope.files, ...(whole ? { wholeRepository: true } : {}), expiresAt: "2099-01-01T00:00:00.000Z" };
    const configuredSkills = whole ? input.configuredSkillLoader?.getSkills().skills ?? [] : [];
    if (whole && !input.configuredSkillLoader) throw new Error("Configured Pi skills loader is unavailable for whole-repository worker");
    const configuredSkillInstructions = configuredSkills.length ? `\nConfigured Pi skills (read the listed SKILL.md files with read):\n${configuredSkills.map(skill => `- ${skill.name}: ${skill.description}; file=${skill.filePath}`).join("\n")}` : "";
    const protectedFiles = await protectedSkillBackingFiles();
    const skillBinding = workerSkillBinding(input.project, scope.id, () => loadProject(input.project.id), protectedFiles, async () => {
      if (input.isClosed?.()) throw new Error("Project runtime is closing");
      const current = loadProject(input.project.id);
      if (current.archived || current.deleted || authorizationFingerprint(current) !== authorizationFingerprint(input.project) || Number(request.conversationId) < 0) throw new Error("Worker skill owner or scope authorization changed");
      await input.conversation().commit(async tx => {
        const state = await tx.doc(DurablePlanning, input.conversation().id), work = state.work[request.workId];
        if (state.paused || state.pausing || !work || work.status !== "running" || work.workspaceScopeId !== selectedScope.id || Number(work.conversationId) !== request.conversationId || state.threads[work.threadId]?.activeWorkId !== work.id || work.threadId !== request.threadId) throw new Error("Skill read requires the active scoped worker");
      }, BACKGROUND_CONTEXT);
    });
    const commandProfiles = (input.project.commandProfiles ?? []).filter(profile => profile.enabled && profile.repositoryId === repository.repositoryId && profile.scopeIds.includes(scope.id));
    if (commandProfiles.length && !input.commands) throw new Error("Host command executor is unavailable");
    const lock = { controlRoot: input.controlRoot, databasePath: await workspacePhysicalLockPath(input.controlRoot, receipt.workspacePath), waitMs: commandProfiles.length ? 0 : 5000 };
    const tools = await workspaceCapabilities({ caller: "durable-worker", authority, binding: { role: "durable-worker", conversationId: request.conversationId }, validateAuthority: async (candidate, action) => {
      if (input.isClosed?.()) return { approved: false, blocker: "Project runtime is closing" };
      if (candidate.receiptId !== authority.receiptId) return { approved: false, blocker: "receipt mismatch" };
      if (action === "write" && await input.conversation().commit(tx => hasUncertainCommands(tx, input.conversation().id, commandResource(authority)), BACKGROUND_CONTEXT)) return { approved: false, blocker: "Workspace command outcome is unresolved; inspect before writing" };
      return { approved: true, authority };
    }, captureEvidence: scope.evidenceCapture ? async (captured, api, context) => {
      const root = input.conversation();
      async function active() {
        context.abortSignal?.throwIfAborted();
        const current = loadProject(input.project.id);
        if (input.isClosed?.() || current.deleted || current.archived || authorizationFingerprint(current) !== authorizationFingerprint(input.project) || Number(api.conversationId) !== request.conversationId) throw new Error("Evidence capture authority changed");
        await root.commit(async tx => {
          const state = await tx.doc(DurablePlanning, root.id), work = state.work[request.workId];
          if (state.paused || state.pausing || !work || work.status !== "running" || work.workspaceScopeId !== selectedScope.id || Number(work.conversationId) !== request.conversationId || state.threads[work.threadId]?.activeWorkId !== work.id) throw new Error("Evidence capture requires the active scoped worker");
        }, context);
      }
      await active();
      const record = await captureEvidenceBytes({ dir: input.controlRoot, filename: captured.path, title: captured.title, bytes: captured.bytes, sessionFile: null, native: { projectId: input.project.id, scopeId: scope.id, workId: request.workId, conversationId: request.conversationId, taskId: Number(api.taskId), callId: api.callId, sourcePath: captured.path } });
      await active();
      return record;
    } : undefined, writeLock: lock });
    if (input.commands) tools.push(...await commandWorkerTools({ executor: input.commands, approvals: input.commandApprovals, project: input.project, root: input.conversation(), authority, scopeId: scope.id, conversationId: request.conversationId, workId: request.workId, lock }));
    if (publication) tools.push(...await githubWorkerTools({ project: input.project, root: input.conversation(), authority, conversationId: request.conversationId, branch, scopeId: scope.id, workId: request.workId, baseRevision, publication, isClosed: input.isClosed }));
    if (whole) {
      const codingTools = createCodingTools(receipt.workspacePath, { bash: { spawnHook: ({ command, ...context }) => ({ ...context, command: guardWorkerGitCommand(command, branch) }) } });
      const builtins: ToolRegistration[] = codingTools.map(tool => defineTool({ name: tool.name, description: tool.description, parameters: tool.parameters, replay: "unsafe", async execute(args, api, context) {
        return tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
      } }));
      const skillTools = skillBinding.tools;
      const skillNames = new Set(skillTools.map(tool => tool.name));
      const builtinNames = new Set(builtins.map(tool => tool.name));
      tools.splice(0, tools.length, ...tools.filter(tool => !(tool.name.startsWith("projects_workspace_") && /_(?:read|write|read_list|list)$/.test(tool.name)) && !builtinNames.has(tool.name)), ...builtins.filter(builtin => !skillNames.has(builtin.name)), ...skillTools);
    } else tools.push(...skillBinding.tools);
    // Deliberately uninstalled: ScopedAttempt publishes only after its post-preparation active/binding recheck.
    assertStanding();
    const extension = defineExtension({ name: `projects.workspace.${scope.id}.${intentId}.${request.conversationId}`, tools, hooks: [hook(ToolTask, { beforeTool: (_call, api) => {
      if (Number(api.conversationId) !== request.conversationId) return;
      try { assertStanding(); } catch (error) { return { block: error instanceof Error ? error.message : "Selected repository standing resources are unavailable" }; }
    } })] });
    return { cwd: receipt.workspacePath, tools, extension, repositoryStanding, workerInstructions: `${skillBinding.instructions}${whole ? `${configuredSkillInstructions}\n\nYOLO whole-repository mode: use the built-in Pi coding tools in this worktree. You may run commands and edit any repository file. Commit and push only your branch ${branch}. Do not force-push, merge, delete branches, or push to the default branch. The owner approves merges.${publication ? ` After pushing, call the GitHub open_draft_pr tool with the pushed commit SHA to open or update the draft PR against ${publication.baseBranch}.` : ""}\n` : ""}`, bindingRevision: hash(JSON.stringify({ receipt: receipt.providerFacts, scope, workerSkillGrants: skillBinding.revision, names: tools.map(tool => tool.name), commands: (input.project.commandProfiles ?? []).filter(profile => profile.enabled && profile.scopeIds.includes(scope.id)).map(profile => ({ id: profile.id, revision: profile.revision })), ...(repositoryStanding?.text.length ? { repositoryStanding: hash(JSON.stringify(repositoryStanding)) } : {}) })) };
  };
}
export function guardWorkerGitCommand(command: string, branch: string): string {
  // This shell-text check is best-effort, not a sandbox. It catches common git/gh forms before spawn.
  const chunks = command.split(/[;&|\n]+/).map(part => part.trim());
  const denied = chunks.some(chunk => {
    const git = chunk.match(/(?:^|\s)git\s+(.*)$/)?.[1]?.trim().replace(/^(?:-C\s+\S+\s+)+/, "");
    if (git && /^(?:merge\b|branch\s+-(?:D|d)\b)/.test(git)) return true;
    if (git && /^push\b/.test(git)) {
      const args = git.replace(/^push\s+/, "");
      if (/--(?:force|force-with-lease|mirror|all|tags|delete)\b|(?:^|\s)-[fd]\b/.test(args)) return true;
      const refs = args.split(/\s+/).filter(value => value.includes(":"));
      if (refs.length) return refs.some(ref => ref.startsWith("+") || ref.startsWith(":") || ref.split(":").at(-1) !== branch);
      const targets = args.split(/\s+/).filter(value => !value.startsWith("-") && value !== "origin" && value !== "HEAD");
      return targets.some(target => target !== branch) || (!args.includes(branch) && !/\bHEAD\b/.test(args));
    }
    if (/\bgh\s+pr\s+merge\b/.test(chunk)) return true;
    if (/\bgh\s+api\b[^;&|\n]*\bmerge\b/i.test(chunk)) return true;
    return false;
  });
  return denied ? "printf '%s\\n' 'Blocked by worker Git policy: push only to this worker branch; no force-push, remote delete, merge, or branch delete. This check is best-effort.' >&2; exit 126" : command;
}
function ownerHead(checkout: string): string { return execFileSync("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableUuid(value: string): string { const hex = hash(value); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
