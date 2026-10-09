import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
import { worktreeSetup } from "./worktree-maintenance.ts";
import { artifactInstructions, ensureArtifactDir } from "./artifacts.ts";
import { arcBranchName, arcTicket, arcWorkerInstructions, freeName, guardWorkerArcCommand } from "./arc-worker-policy.ts";
import { arcWorkerTools } from "./arc-worker.ts";
import { arcFetchedTrunkHead, arcTakenNames, cli, runCli } from "./vcs.ts";

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
    const arc = authorization.provider === "arc";
    // The Arc root has no standing instructions of its own: the project folder (subpath) is the standing root.
    const repositoryRoot = arc ? projectRoot : realpathSync(selectedRepository.ownerCheckout);
    const selectedStanding = repositoryRoot === projectRoot ? projectStanding : loadDurableStanding(repositoryRoot);
    const repositoryStanding = repositoryRoot !== projectRoot ? selectedStanding : undefined;
    function assertStanding() {
      if ((arc ? projectRoot : realpathSync(selectedRepository.ownerCheckout)) !== repositoryRoot) throw new Error("Selected repository standing root changed");
      const current = loadDurableStanding(repositoryRoot);
      if (current.revision !== selectedStanding.revision || current.text !== selectedStanding.text) throw new Error("Selected repository standing instructions changed; frozen thread will not be retargeted");
    }
    assertStanding();
    const provider = authorization.provider === "github" ? "git" : "arc";
    const intentId = stableUuid(`${input.project.id}:${request.threadId}:${scope.id}`), attemptId = stableUuid(`${intentId}:allocation`);
    const whole = scope.wholeRepository === true;
    const arcAuthorization = arc ? input.project.arcAuthorization : undefined;
    const subpath = repository.subpath ?? "";
    // The lease owner names the project (distinguishable from the owner's own agent sessions in arc-wt list).
    const leaseOwner = arc ? `pi-projects:${input.project.id}` : authorization.owner;
    const githubAuthorization = input.project.githubAuthorization?.find(item => item.repositoryId === repository.repositoryId && item.workspaceRevision === authorizationFingerprint(input.project));
    const publication = githubAuthorization;
    const isolation = workspaceIsolation({ conversation: input.conversation(), authority: { projectId: input.project.id, owner: leaseOwner }, authorizedRepositories: [{ repositoryId: repository.repositoryId, provider, approvedRoot: repository.approvedRoot, ownerCheckout: repository.ownerCheckout, fileOwnershipPrefix: repository.fileOwnershipPrefix }] });
    const taskText = (workId: string) => input.conversation().commit(async tx => (await tx.doc(DurablePlanning, input.conversation().id)).work[workId]?.text ?? "", BACKGROUND_CONTEXT);
    const freeArcName = async (task: string, threadId: string) => freeName(arcBranchName(task, threadId), await arcTakenNames(repository.ownerCheckout));
    // A whole-repository thread starts from owner HEAD at its first allocation and keeps that base and branch on later dispatches.
    const receipts = whole ? (await isolation.snapshot()).receipts : [], allocated = receipts.find(item => item.intentId === intentId)?.scope;
    // Arc: the worktree and branch are named from the task (ticket key or thread) on first allocation, then frozen with the receipt.
    const arcName = arc && !allocated ? await freeArcName(await taskText(request.workId), request.threadId) : undefined;
    const name = allocated?.workspaceName ?? arcName ?? `durable-${intentId.slice(0, 12)}`, workspacePath = allocated?.workspacePath ?? join(repository.approvedRoot, name);
    const baseRevision = !whole ? scope.baseRevision : allocated?.baseRevision ?? (arc ? await arcFetchedTrunkHead(repository.ownerCheckout) : ownerHead(repository.ownerCheckout));
    const branch = allocated?.branch ?? (arc ? name : publication ? `${publication.branchPrefix}${name}` : whole ? `pi/${name}` : name);
    const intent: WorkspaceIntent = { id: intentId, attemptId, action: "allocate", scope: { projectId: input.project.id, repositoryId: repository.repositoryId, provider, ownerCheckout: repository.ownerCheckout, approvedRoot: repository.approvedRoot, workspacePath, workspaceName: name, branch, baseRevision, headRevision: baseRevision, owner: leaseOwner, leaseReason: arc ? `pi project ${input.project.name} thread ${request.threadId}` : `durable workspace ${request.threadId}`, sharedObjectStore: provider === "arc" ? repository.sharedObjectStore ?? null : null, fileOwnership: scope.files, capabilityProfileRevision: hash(JSON.stringify({ authorization, scope })), ...(whole ? { allowDirtyOwner: true as const } : {}) } };
    let receipt = await isolation.allocate(intent); if (receipt.state !== "allocated") receipt = await isolation.reconcile(intent);
    if (receipt.state === "released" && receipt.providerFacts.remove === "cleanup-unforced") throw new Error(`This thread's worktree was cleaned up after its work settled; branch ${branch} is kept. Delegate a new worker and tell it to continue branch ${branch} (fetch it and push to it).`);
    if (receipt.state !== "allocated" || !receipt.workspacePath) throw new Error(`Workspace allocation is ${receipt.state}: ${receipt.reason ?? "no exact receipt"}`);
    if (JSON.stringify(receipt.scope) !== JSON.stringify(intent.scope)) throw new Error("Frozen workspace allocation receipt differs from current host scope; refusing registry publication");
    // Setup runs once, for worktrees this dispatch created; its recorded result reaches the worker's frozen instructions and Settings.
    // Arc: the project folder inside the worktree is where workers (and the setup command) run.
    const workDir = subpath ? join(receipt.workspacePath, subpath) : receipt.workspacePath;
    if (arc && !existsSync(workDir)) throw new Error(`The project folder ${subpath} does not exist in the worktree ${receipt.workspacePath}`);
    const setup = whole ? await worktreeSetup({ command: allocated ? undefined : loadProject(input.project.id).worktreeSetup, controlRoot: input.controlRoot, intentId, workspacePath: receipt.workspacePath, cwd: workDir }) : "";
    // Arc worktrees are leased: renew on every dispatch, and again while tools run; a lost lease stops all further tool calls.
    let leaseLost: string | undefined, lastRenew = Date.now();
    const renewLease = async () => {
      const renewed = await runCli(cli.arcWt(), ["lease", "renew", name, "--owner", leaseOwner]);
      lastRenew = Date.now();
      leaseLost = renewed.code ? `The Arc worktree lease for ${name} could not be renewed (${renewed.stderr.trim().slice(-200) || `exit ${renewed.code}`}). Stop writing and report that this worktree needs the owner; do not retry.` : undefined;
    };
    if (arc) { await renewLease(); if (leaseLost) throw new Error(leaseLost); }
    const ownedBranches = new Set(receipts.filter(item => item.scope.provider === "arc").map(item => item.scope.branch));
    const authority: WorkspaceAuthority = { projectId: input.project.id, repositoryId: repository.repositoryId, provider, workspaceId: `${scope.id}:${receipt.intentId}:${request.conversationId}`, receiptId: receipt.intentId, attemptId: receipt.attemptId, leaseRevision: receipt.lease?.renewedAt ?? receipt.providerFacts.head ?? scope.baseRevision, workspaceRoot: receipt.workspacePath, files: scope.files, ...(whole ? { wholeRepository: true } : {}), expiresAt: "2099-01-01T00:00:00.000Z" };
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
    const arcPublication = arcAuthorization && arcAuthorization.workspaceRevision === authorizationFingerprint(input.project) ? arcAuthorization : undefined;
    if (arcPublication) tools.push(...await arcWorkerTools({ project: input.project, root: input.conversation(), workDir, branch, controlRoot: input.controlRoot, workspaceId: authority.workspaceId, conversationId: request.conversationId, scopeId: scope.id, workId: request.workId, authorization: arcPublication, isClosed: input.isClosed }));
    const gitPolicy = { prefix: publication?.branchPrefix ?? "pi/", protected: publication ? [publication.baseBranch] : [] };
    // Evidence folder per thread, in the project home (survives worktree cleanup); path in the instructions and $PI_ARTIFACTS_DIR.
    const artifacts = whole ? ensureArtifactDir(input.controlRoot, request.threadId) : undefined;
    if (whole) {
      const codingTools = createCodingTools(workDir, { bash: { spawnHook: ({ command, env, ...context }) => ({ ...context, env: { ...env, PI_ARTIFACTS_DIR: artifacts! }, command: arc ? guardWorkerArcCommand(command, { branch, owned: ownedBranches }) : guardWorkerGitCommand(command, branch, gitPolicy) }) } });
      const builtins: ToolRegistration[] = codingTools.map(tool => defineTool({ name: tool.name, description: tool.description, parameters: tool.parameters, replay: "unsafe", async execute(args, api, context) {
        return tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
      } }));
      const builtinNames = new Set(builtins.map(tool => tool.name));
      tools.splice(0, tools.length, ...tools.filter(tool => !(tool.name.startsWith("projects_workspace_") && /_(?:read|write|read_list|list)$/.test(tool.name)) && !builtinNames.has(tool.name)), ...builtins);
    }
    // Deliberately uninstalled: ScopedAttempt publishes only after its post-preparation active/binding recheck.
    assertStanding();
    const extension = defineExtension({ name: `projects.workspace.${scope.id}.${intentId}.${request.conversationId}`, tools, hooks: [hook(ToolTask, { beforeTool: (_call, api) => {
      if (Number(api.conversationId) !== request.conversationId) return;
      try { assertStanding(); } catch (error) { return { block: error instanceof Error ? error.message : "Selected repository standing resources are unavailable" }; }
      if (arc) return (async () => { if (!leaseLost && Date.now() - lastRenew > 60_000) await renewLease(); return leaseLost ? { block: leaseLost } : undefined; })();
    } })] });
    // Skills now come from the role profile (instructions + projects_skill_file). The retired grant fingerprint stays in the hash so existing threads keep their binding revision.
    return { cwd: workDir, tools, extension, repositoryStanding, workerInstructions: `${whole ? `\n\nYOLO whole-repository mode: use the built-in Pi coding tools in this worktree. You may run commands and edit any repository file. ${arc ? arcWorkerInstructions({ branch, login: arcAuthorization?.login, subpath, ticket: arcTicket(branch), baseRevision, pr: arcPublication !== undefined }) : `Your branch is ${branch}. You may fetch, merge, rebase, cherry-pick and resolve conflicts. Push to your branch, or to another existing project branch (${gitPolicy.prefix}*) when your task says to continue it (for example an open project PR): fetch it, work on top of it, and push with git push origin HEAD:<that branch>. After a rebase use --force-with-lease, only on project branches. Never push to ${[publication?.baseBranch, "main", "master"].filter((value, index, all) => value && all.indexOf(value) === index).join(", ")} or other non-project branches, never plain --force, delete branches or merge PRs; the owner approves merges.${publication ? ` Open or update a draft PR (GitHub open_draft_pr tool, after pushing your own branch, against ${publication.baseBranch}) only when your task asks for a PR; when you continue an existing PR branch, pushing updates that PR.` : ""}`}\n${artifactInstructions(artifacts!, request.threadId)}` : ""}${setup ? `\n${setup}\n` : ""}`, bindingRevision: hash(JSON.stringify({ receipt: receipt.providerFacts, scope, workerSkillGrants: JSON.stringify(input.project.workerSkillGrants ?? []), names: tools.map(tool => tool.name), commands: (input.project.commandProfiles ?? []).filter(profile => profile.enabled && profile.scopeIds.includes(scope.id)).map(profile => ({ id: profile.id, revision: profile.revision })), ...(repositoryStanding?.text.length ? { repositoryStanding: hash(JSON.stringify(repositoryStanding)) } : {}) })) };
  };
}
/** Pushes may target this worker's branch or any other project branch (the publication prefix); never the base/default branch. */
export function guardWorkerGitCommand(command: string, branch: string, policy: { prefix?: string; protected?: readonly string[] } = {}): string {
  // This shell-text check is best-effort, not a sandbox. It catches common git/gh forms before spawn; one blocked segment blocks the whole command.
  const prefix = policy.prefix && policy.prefix.length >= 2 ? policy.prefix : undefined;
  const guarded = new Set(["main", "master", "HEAD", ...(policy.protected ?? [])]);
  const project = (ref: string) => { const name = ref.replace(/^refs\/heads\//, ""); return !guarded.has(name) && (name === branch || (prefix !== undefined && name.startsWith(prefix) && name.length > prefix.length && !name.includes(".."))); };
  const chunks = command.split(/[;&|\n]+/).map(part => part.trim());
  const blocked = chunks.find(chunk => {
    const git = chunk.match(/(?:^|\s)git\s+(.*)$/)?.[1]?.trim().replace(/^(?:-[Cc]\s+\S+\s+)+/, "");
    if (git && /^branch\s+(?:-(?:D|d)|--delete)(?:\s|$)/.test(git)) return true;
    if (git && /^push(?:\s|$)/.test(git)) {
      const args = git.replace(/^push\s*/, "").split(/\s+/).filter(Boolean);
      if (args.some(value => /^--(?:force|mirror|all|tags|delete|prune)$/.test(value) || /^-[a-zA-Z]*[fd]/.test(value) && !value.startsWith("--"))) return true;
      const positional = args.filter(value => !value.startsWith("-"));
      const refs = positional[0] === "origin" || positional[0] === "upstream" || (positional.length > 1 && !positional[0].includes(":")) ? positional.slice(1) : positional;
      if (!refs.length) return true;
      for (const ref of refs) {
        if (ref.startsWith("+") || ref.startsWith(":")) return true;
        const target = ref.includes(":") ? ref.split(":").at(-1)! : ref;
        // A bare HEAD pushes the checked-out branch to its own name; best-effort as before.
        if (!(ref === "HEAD" || project(target))) return true;
      }
      const lease = args.find(value => value.startsWith("--force-with-lease"));
      if (lease?.includes("=") && !project(lease.slice(lease.indexOf("=") + 1).split(":")[0])) return true;
      return false;
    }
    if (/\bgh\s+pr\s+merge\b/.test(chunk)) return true;
    if (/\bgh\s+api\b[^;&|\n]*\bmerge\b/i.test(chunk)) return true;
    return false;
  });
  if (blocked === undefined) return command;
  const message = `Blocked by worker Git policy at: ${blocked.slice(0, 200)} -- push only to project branches${prefix ? ` (${prefix}*)` : ` (${branch})`}; --force-with-lease is allowed there, plain --force, +refs, deletes, mirror/all/tags, pushes to ${[...guarded].filter(name => name !== "HEAD").join("/")} and PR merges are not. Nothing in this command ran. This check is best-effort.`;
  return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
}
function ownerHead(checkout: string): string { return execFileSync("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableUuid(value: string): string { const hex = hash(value); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
