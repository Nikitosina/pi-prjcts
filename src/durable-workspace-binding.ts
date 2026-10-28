import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, hook, ToolTask, type Conversation, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { DurablePrepareWorkerEnvironment } from "./durable-plan-types.ts";
import { loadProject, type Project } from "./state.ts";
import { captureEvidenceBytes } from "./evidence.ts";
import { DurablePlanning } from "./durable-planning.ts";
import { workspaceIsolation } from "./workspace-isolation.ts";
import { workspaceCapabilities, workspacePhysicalLockPath, type WorkspaceAuthority } from "./workspace-capabilities.ts";
import { isolationProvider, type WorkspaceIntent } from "./workspace-types.ts";
import { githubWorkerTools } from "./github-worker.ts";
import { authorizationFingerprint } from "./workspace-authorization.ts";
import { commandExecution, commandResource, commandWorkerTools, hasUncertainCommands } from "./command-runtime.ts";
import type { OperationApprovals } from "./operation-approvals.ts";
import { loadDurableStanding, type DurableStanding } from "./durable-standing.ts";
import { worktreeSetup } from "./worktree-maintenance.ts";
import { verificationProviderProblem } from "./project-settings.ts";
import { artifactInstructions, ensureArtifactDir } from "./artifacts.ts";
import { plugins } from "./plugins.ts";
import { workerEnvironmentTools } from "./worker-environment-tools.ts";
import type { ResourceLeases } from "./resource-leases.ts";
import type { BackgroundCommands } from "./background-commands.ts";

/** Builds a trusted host callback; model work supplies only the persisted scope ID. */
export function durableWorkspaceBinding(input: { project: Project; configuredSkillLoader?: Pick<ResourceLoader, "getSkills">; conversation: () => Conversation; controlRoot: string; projectStanding?: DurableStanding; commands?: ReturnType<typeof commandExecution>; commandApprovals?: () => OperationApprovals; isClosed?: () => boolean; /** Whole-repository workers get lease and background-command tools when present. */ environment?: { leases: ResourceLeases; background: BackgroundCommands } }): DurablePrepareWorkerEnvironment | undefined {
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
    const plug = authorization.provider === "github" ? undefined : plugins.workspaceProvider(authorization.provider);
    if (authorization.provider !== "github" && !plug) throw new Error(`The workspace provider plugin "${authorization.provider}" is not loaded, so workers cannot start in this project; load it or remove the grant`);
    // Some checkout roots have no standing instructions of their own: the project folder is then the standing root.
    const repositoryRoot = plug?.standingAtProjectRoot ? projectRoot : realpathSync(selectedRepository.ownerCheckout);
    const selectedStanding = repositoryRoot === projectRoot ? projectStanding : loadDurableStanding(repositoryRoot);
    const repositoryStanding = repositoryRoot !== projectRoot ? selectedStanding : undefined;
    function assertStanding() {
      if ((plug?.standingAtProjectRoot ? projectRoot : realpathSync(selectedRepository.ownerCheckout)) !== repositoryRoot) throw new Error("Selected repository standing root changed");
      const current = loadDurableStanding(repositoryRoot);
      if (current.revision !== selectedStanding.revision || current.text !== selectedStanding.text) throw new Error("Selected repository standing instructions changed; frozen thread will not be retargeted");
    }
    assertStanding();
    const provider = isolationProvider(authorization.provider);
    // A thread that took over another's worktree uses that allocation's identity (same receipt, path and branch); the previous thread may not run again.
    const thread = await input.conversation().commit(async tx => {
      const state = await tx.doc(DurablePlanning, input.conversation().id), item = state.threads[request.threadId];
      const bound = Object.values(state.work).findLast(work => work.threadId === request.threadId && work.attempt?.boundTools)?.attempt?.boundTools;
      return { workspaceFrom: item?.workspaceFrom, transferredTo: item?.transferredTo, continueBranch: item?.continueBranch ? { ...item.continueBranch } : undefined, bound: bound ? [...bound] : undefined, workspaceConfigured: Boolean(item?.workspaceConfigured) };
    }, BACKGROUND_CONTEXT);
    if (thread.transferredTo) throw new Error(`This thread's worktree was handed to thread ${thread.transferredTo}; it can no longer run work. Send follow-ups to that thread.`);
    const allocationThread = thread.workspaceFrom ?? request.threadId;
    const intentId = stableUuid(`${input.project.id}:${allocationThread}:${scope.id}`), attemptId = stableUuid(`${intentId}:allocation`);
    const whole = scope.wholeRepository === true;
    const leaseOwner = plug ? plug.leaseOwner(input.project) : authorization.owner;
    const githubAuthorization = input.project.githubAuthorization?.find(item => item.repositoryId === repository.repositoryId && item.workspaceRevision === authorizationFingerprint(input.project));
    const publication = githubAuthorization;
    const isolation = workspaceIsolation({ conversation: input.conversation(), authority: { projectId: input.project.id, owner: leaseOwner }, authorizedRepositories: [{ repositoryId: repository.repositoryId, provider, approvedRoot: repository.approvedRoot, ownerCheckout: repository.ownerCheckout, fileOwnershipPrefix: repository.fileOwnershipPrefix }] });
    const taskText = (workId: string) => input.conversation().commit(async tx => (await tx.doc(DurablePlanning, input.conversation().id)).work[workId]?.text ?? "", BACKGROUND_CONTEXT);
    // A whole-repository thread starts from owner HEAD at its first allocation and keeps that base and branch on later dispatches.
    const receipts = whole ? (await isolation.snapshot()).receipts : [], allocated = receipts.find(item => item.intentId === intentId)?.scope;
    const continued = allocated ? undefined : thread.continueBranch;
    const bindContext = { project: input.project, repository, scopeId: scope.id, whole, scopeBaseRevision: scope.baseRevision, threadId: request.threadId, workId: request.workId, conversationId: request.conversationId, allocationThread, allocated, continued, root: input.conversation(), controlRoot: input.controlRoot, isClosed: () => input.isClosed?.() ?? false, taskText: () => taskText(request.workId) };
    // A provider plugin names the worktree and branch (frozen with the receipt); git derives them here.
    const plan = plug ? await plug.plan(bindContext) : undefined;
    const name = plan?.name ?? allocated?.workspaceName ?? `durable-${intentId.slice(0, 12)}`, workspacePath = allocated?.workspacePath ?? join(repository.approvedRoot, name);
    const baseRevision = plan?.baseRevision ?? (!whole ? scope.baseRevision : allocated?.baseRevision ?? (continued ? continued.sha : ownerHead(repository.ownerCheckout)));
    const branch = plan?.branch ?? allocated?.branch ?? (continued ? continued.name : publication ? `${publication.branchPrefix}${name}` : whole ? `pi/${name}` : name);
    const intent: WorkspaceIntent = { id: intentId, attemptId, action: "allocate", scope: { projectId: input.project.id, repositoryId: repository.repositoryId, provider, ownerCheckout: repository.ownerCheckout, approvedRoot: repository.approvedRoot, workspacePath, workspaceName: name, branch, baseRevision, headRevision: plan?.headRevision ?? allocated?.headRevision ?? (continued ? ownerHead(repository.ownerCheckout) : baseRevision), owner: leaseOwner, leaseReason: plan?.leaseReason ?? `durable workspace ${allocationThread}`, sharedObjectStore: plan ? plan.sharedObjectStore : null, fileOwnership: scope.files, capabilityProfileRevision: hash(JSON.stringify({ authorization, scope })), ...(whole ? { allowDirtyOwner: true as const } : {}), ...(plan ? plan.continueBranch ? { continueBranch: true as const } : {} : allocated?.continueBranch || continued ? { continueBranch: true as const } : {}) } };
    let receipt = await isolation.allocate(intent); if (receipt.state !== "allocated") receipt = await isolation.reconcile(intent);
    // A thread whose settled worktree was cleaned up gets it back on its kept branch (same path, same frozen binding).
    if (receipt.state === "released" && receipt.providerFacts.remove === "cleanup-unforced") {
      receipt = await isolation.revive(intent);
      if (receipt.state === "released") throw new Error(`This thread's worktree was cleaned up after its work settled and could not be restored: ${receipt.reason ?? "provider cannot re-create it"}. Start a new worker for follow-up work${receipt.reason?.includes("no longer exists") ? "" : ` and tell it to continue branch ${branch} (fetch it and push to it)`}.`);
    }
    if (receipt.state !== "allocated" || !receipt.workspacePath) throw new Error(`Workspace allocation is ${receipt.state}: ${receipt.reason ?? "no exact receipt"}`);
    if (JSON.stringify(receipt.scope) !== JSON.stringify(intent.scope)) throw new Error("Frozen workspace allocation receipt differs from current host scope; refusing registry publication");
    const attachment = plug ? await plug.attach({ ...bindContext, receipt, receipts, plan: plan! }) : undefined;
    // Setup runs once, for worktrees this dispatch created; its recorded result reaches the worker's frozen instructions and Settings.
    // A provider may run workers in a folder inside the worktree.
    const workDir = attachment ? attachment.workDir : receipt.workspacePath;
    const setup = whole ? await worktreeSetup({ command: allocated ? undefined : loadProject(input.project.id).worktreeSetup, controlRoot: input.controlRoot, intentId, workspacePath: receipt.workspacePath, cwd: workDir }) : "";
    await attachment?.start();
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
    if (attachment) tools.push(...await attachment.tools(authority));
    // Evidence folder per thread, in the project home (survives worktree cleanup); path in the instructions and $PI_ARTIFACTS_DIR.
    const artifacts = whole ? ensureArtifactDir(input.controlRoot, request.threadId) : undefined;
    let pluginNotes = "";
    if (whole) {
      // Plugin worker tools freeze with the thread: a bound thread keeps exactly what it had; only new threads follow the plugin's offer.
      for (const provider of plugins.workerTools()) {
        const offered = provider.create({ projectId: input.project.id, threadId: request.threadId, conversationId: request.conversationId });
        const kept = thread.bound ? offered.filter(tool => thread.bound!.includes(tool.name)) : !thread.workspaceConfigured && provider.offered(input.project.id) ? offered : [];
        if (kept.length) { tools.push(...kept); pluginNotes += provider.instructions ?? ""; }
      }
      const owners = ownerRoots(repository.ownerCheckout, workDir);
      const guard = workerShellGuard({ branch, workDir, ownerCheckout: repository.ownerCheckout, publication, attachmentGuard: attachment?.guard });
      const codingTools = createCodingTools(workDir, { bash: { spawnHook: ({ command, env, ...context }) => ({ ...context, env: { ...env, PI_ARTIFACTS_DIR: artifacts! }, command: guard(command) }) } });
      const builtins: ToolRegistration[] = codingTools.map(tool => defineTool({ name: tool.name, description: tool.description, parameters: tool.parameters, replay: "unsafe", async execute(args, api, context) {
        if (tool.name === "write" || tool.name === "edit") assertOutsideOwner(String((args as { path?: unknown }).path ?? ""), workDir, owners);
        return tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
      } }));
      const builtinNames = new Set(builtins.map(tool => tool.name));
      tools.splice(0, tools.length, ...tools.filter(tool => !(tool.name.startsWith("projects_workspace_") && /_(?:read|write|read_list|list)$/.test(tool.name)) && !builtinNames.has(tool.name)), ...builtins);
      if (input.environment) tools.push(...workerEnvironmentTools({ projectId: input.project.id, ...input.environment, target: () => ({ threadId: request.threadId, cwd: workDir, env: { ...process.env, PI_ARTIFACTS_DIR: artifacts! }, guard }) }));
    }
    const gitPolicy = { prefix: publication?.branchPrefix ?? "pi/", protected: publication ? [publication.baseBranch] : [] };
    // Deliberately uninstalled: ScopedAttempt publishes only after its post-preparation active/binding recheck.
    assertStanding();
    const extension = defineExtension({ name: `projects.workspace.${scope.id}.${intentId}.${request.conversationId}`, tools, hooks: [hook(ToolTask, { beforeTool: (_call, api) => {
      if (Number(api.conversationId) !== request.conversationId) return;
      try { assertStanding(); } catch (error) { return { block: error instanceof Error ? error.message : "Selected repository standing resources are unavailable" }; }
      if (attachment?.beforeTool) return attachment.beforeTool();
    } })] });
    // Skills now come from the role profile (instructions + projects_skill_file). The retired grant fingerprint stays in the hash so existing threads keep their binding revision.
    const handover = `${thread.workspaceFrom ? "\nThis worktree was taken over from an earlier worker thread; its branch, commits and uncommitted changes are here. Check the status first; the earlier thread can no longer work." : ""}${thread.continueBranch ? `\nThis worktree continues the existing branch ${branch} (tip ${thread.continueBranch.sha.slice(0, 12)}) of an existing PR. Commit on top and push to it; never open a second PR.` : ""}`;
    return { cwd: workDir, tools, extension, repositoryStanding, workerInstructions: `${whole ? `\n\nWorktree ${workDir} (branch ${branch}): run commands and make every edit here. Never cd into, run git against or write to the owner's checkout ${repository.ownerCheckout}; reading it is fine.` : ""}${handover}${whole ? `${attachment ? `\n${attachment.instructions}` : `\nPush to your branch or another project branch (${gitPolicy.prefix}*): git push origin HEAD:<branch>. You may fetch, merge, rebase and cherry-pick; after a rebase use --force-with-lease, only on project branches. Never push to ${[publication?.baseBranch, "main", "master"].filter((value, index, all) => value && all.indexOf(value) === index).join(", ")} or other branches, force-push plainly, delete branches or merge PRs.${publication ? ` Open or update a draft PR (open_draft_pr, against ${publication.baseBranch}) only when your task asks for a PR; pushing to an existing PR branch updates it.` : ""}`}\n${artifactInstructions(artifacts!, request.threadId)}${pluginNotes}` : ""}${setup ? `\n${setup}\n` : ""}`, bindingRevision: hash(JSON.stringify({ receipt: receipt.providerFacts, scope, workerSkillGrants: JSON.stringify(input.project.workerSkillGrants ?? []), names: tools.map(tool => tool.name), commands: (input.project.commandProfiles ?? []).filter(profile => profile.enabled && profile.scopeIds.includes(scope.id)).map(profile => ({ id: profile.id, revision: profile.revision })), ...(repositoryStanding?.text.length ? { repositoryStanding: hash(JSON.stringify(repositoryStanding)) } : {}) })) };
  };
}
/**
 * The shell policy of a whole-repository worker: its git pushes stay on project branches and its commands stay out of the owner's checkout.
 * Workers, their background commands and their verifiers all run commands through this one function; it is best-effort text matching, not a sandbox.
 */
export function workerShellGuard(input: { branch: string; workDir: string; ownerCheckout: string; publication?: { branchPrefix: string; baseBranch: string }; attachmentGuard?: (command: string) => string }): (command: string) => string {
  const gitPolicy = { prefix: input.publication?.branchPrefix ?? "pi/", protected: input.publication ? [input.publication.baseBranch] : [] };
  const owners = ownerRoots(input.ownerCheckout, input.workDir);
  return command => guardOwnerCheckout(input.attachmentGuard ? input.attachmentGuard(command) : guardWorkerGitCommand(command, input.branch, gitPolicy), input.workDir, owners);
}
/**
 * The shell policy a verifier's commands pass through: the one of the worker whose scope it verifies. Plugin workspace providers keep that policy
 * inside the plugin, which verifiers cannot reach, so those scopes are refused rather than run under a weaker one.
 */
export function verifierShell(project: Project, scopeId: string, workDir: string, branch: string | null): { guard: (command: string) => string } | { refusal: string } {
  const authorization = project.workspaceAuthorization, scope = authorization?.scopes.find(item => item.id === scopeId), repository = authorization?.repositories.find(item => item.repositoryId === scope?.repositoryId);
  if (!authorization || !scope || !repository) return { refusal: "The worker's workspace scope is no longer authorized for this project" };
  const unsupported = verificationProviderProblem(project);
  if (unsupported) return { refusal: unsupported };
  if (scope.wholeRepository !== true) return { refusal: "Verification requires the worker's whole-repository shell grant; folder-limited workers cannot gain general shell through a verifier" };
  const publication = project.githubAuthorization?.find(item => item.repositoryId === repository.repositoryId && item.workspaceRevision === authorizationFingerprint(project));
  return { guard: workerShellGuard({ branch: branch ?? "", workDir, ownerCheckout: repository.ownerCheckout, publication }) };
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
/** Real and given spellings of the owner checkout; empty when the worktree itself sits inside it (nothing to separate). */
function ownerRoots(checkout: string, workDir: string): string[] {
  const roots = [...new Set([resolve(checkout), realpathSync(checkout)])];
  return roots.some(root => inside(root, resolve(workDir)) || inside(root, realpathSync(workDir))) ? [] : roots;
}
function inside(root: string, path: string): boolean { return path === root || path.startsWith(root + sep); }
/** Best-effort accident guard (not a sandbox): refuses cd/pushd/git -C/redirect/tee targets inside the owner checkout; reads stay allowed. */
export function guardOwnerCheckout(command: string, workDir: string, owners: readonly string[]): string {
  if (!owners.length) return command;
  const hits = (path: string) => { const target = path.replace(/^["']|["']$/g, ""); return target !== "" && owners.some(root => inside(root, resolve(workDir, target))); };
  const blocked = command.split(/[;&|\n]+/).map(part => part.trim()).find(chunk => {
    const words = (chunk.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^["']|["']$/g, ""));
    const after = (name: string) => words.flatMap((word, index) => word === name ? [words.slice(index + 1).find(next => !next.startsWith("-")) ?? ""] : []);
    const flagged = words.flatMap((word, index) => word === "-C" || word === "--git-dir" || word === "--work-tree" ? [words[index + 1] ?? ""] : /^--(?:git-dir|work-tree)=/.test(word) ? [word.slice(word.indexOf("=") + 1)] : []);
    const redirected = [...chunk.matchAll(/(?:^|[^<>&\d])\d*>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)].map(match => match[1]);
    return [...after("cd"), ...after("pushd"), ...(words.includes("git") ? flagged : []), ...redirected, ...words.flatMap((word, index) => word === "tee" ? words.slice(index + 1).filter(next => !next.startsWith("-")) : [])].some(hits);
  });
  if (blocked === undefined) return command;
  const message = `Blocked: "${blocked.slice(0, 200)}" works in the owner's checkout (${owners[0]}), not in your worktree (${workDir}). Nothing in this command ran. Reading the owner checkout is fine; run commands and write files in your worktree. This check is best-effort.`;
  return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
}
function assertOutsideOwner(path: string, workDir: string, owners: readonly string[]): void {
  if (!owners.length || !path) return;
  let target = resolve(workDir, path); const tail: string[] = [];
  while (!existsSync(target) && dirname(target) !== target) { tail.unshift(target.slice(dirname(target).length + 1)); target = dirname(target); }
  const real = resolve(realpathSync(target), ...tail);
  if (owners.some(root => inside(root, real))) throw new Error(`${path} is inside the owner's checkout (${owners[0]}); write files in your worktree (${workDir}) instead. Reading the owner checkout is fine.`);
}
function ownerHead(checkout: string): string { return execFileSync("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableUuid(value: string): string { const hex = hash(value); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
