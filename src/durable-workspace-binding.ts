import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, hook, ToolTask, type Conversation, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { coordinatorExecutionTools } from "./coordinator-execution.ts";
import type { DurablePreparedWorkerEnvironment, DurableRole } from "./durable-types.ts";
import { loadProject, projectDir, type Project } from "./state.ts";
import { archiveHome, currentWorktreeRoot } from "./archive-host.ts";
import { captureEvidenceBytes } from "./evidence.ts";
import { Jobs, liveAgentIds } from "./jobs.ts";
import { workspaceIsolation } from "./workspace-isolation.ts";
import { workspaceCapabilities, workspacePhysicalLockPath, type WorkspaceAuthority } from "./workspace-capabilities.ts";
import { isolationProvider, type WorkspaceIntent, type WorkspaceReceipt } from "./workspace-types.ts";
import { githubWorkerTools } from "./github-worker.ts";
import { authorizationFingerprint } from "./workspace-authorization.ts";
import { commandExecution, commandResource, commandWorkerTools, hasUncertainCommands } from "./command-runtime.ts";
import { loadDurableStanding, type DurableStanding } from "./durable-standing.ts";
import { worktreeSetup } from "./worktree-maintenance.ts";
import { verificationProviderProblem } from "./project-settings.ts";
import { artifactInstructions, ensureArtifactDir } from "./artifacts.ts";
import { CACHE_VARIABLE, workspaceCacheInstructions, type WorkspaceCaches } from "./workspace-cache.ts";
import { plugins } from "./plugins.ts";
import { workerEnvironmentTools } from "./worker-environment-tools.ts";
import type { ResourceLeases } from "./resource-leases.ts";
import type { BackgroundCommands } from "./background-commands.ts";

/** Host-state check for detaching a retained worker allocation, never a persistent Coordinator allocation. */
export async function endedWorkerWorkspaceOwner(root: Conversation, receipt: WorkspaceReceipt): Promise<string | null> {
  return root.commit(async (tx) => {
    const state = await tx.doc(Jobs, root.id);
    const threadId = /^durable workspace (\S+)$/.exec(receipt.scope.leaseReason)?.[1];
    const agent = threadId ? state.agents[threadId] : undefined;
    if (
      !agent ||
      agent.role !== "worker" ||
      !agent.scopeId ||
      stableUuid(`${receipt.scope.projectId}:${agent.id}:${agent.scopeId}`) !== receipt.intentId
    )
      return "its owning worker thread cannot be identified from host state";
    const job = agent.jobId ? state.jobs[agent.jobId] : undefined;
    if (!job) return "its owning worker Job is missing from host state";
    if (agent.endedAt === null || job.status === "running" || liveAgentIds(state).includes(agent.id))
      return `its owning thread ${agent.id} is ${state.paused ? "suspended" : "live or retained"}`;
    return null;
  }, BACKGROUND_CONTEXT);
}

/** Builds a trusted host callback; model work supplies only the persisted scope ID. */
export type DurablePrepareWorkerEnvironment = (
  input: Readonly<{
    conversationId: number;
    workId: string;
    threadId: string;
    role: DurableRole;
    workspaceScopeId: string;
    taskText: string;
    /** The worker's thread already has its workspace tools bound (a restart re-prepares). */ configured: boolean;
    continueBranch?: { name: string; sha: string };
  }>,
) => Promise<DurablePreparedWorkerEnvironment>;

export function durableWorkspaceBinding(input: {
  project: Project;
  configuredSkillLoader?: Pick<ResourceLoader, "getSkills">;
  conversation: () => Conversation;
  controlRoot: string;
  projectStanding?: DurableStanding;
  commands?: ReturnType<typeof commandExecution>;
  isClosed?: () => boolean;
  /** Whole-repository workers get lease and background-command tools when present. */ environment?: {
    leases: ResourceLeases;
    background: BackgroundCommands;
  };
  caches?: WorkspaceCaches;
}): DurablePrepareWorkerEnvironment | undefined {
  const authorization = input.project.workspaceAuthorization;
  if (!authorization) return undefined;
  const projectRoot = realpathSync(input.project.cwd);
  const projectStanding = input.projectStanding ?? loadDurableStanding(projectRoot);
  const repositoryById = new Map(authorization.repositories.map((repository) => [repository.repositoryId, repository]));
  const scopeById = new Map(authorization.scopes.map((scope) => [scope.id, scope]));
  if (repositoryById.size !== authorization.repositories.length || scopeById.size !== authorization.scopes.length)
    throw new Error("Workspace authorization has duplicate repository or scope IDs");
  return async (request) => {
    const scope = scopeById.get(request.workspaceScopeId);
    if (!scope) throw new Error("Unknown host workspace scope");
    const repository = repositoryById.get(scope.repositoryId);
    if (!repository || repository.provider !== authorization.provider)
      throw new Error("Workspace scope repository/provider is not host-authorized");
    const selectedRepository = repository;
    if (
      scope.files.some(
        (file) =>
          file.includes("\\") ||
          file.split("/").some((part) => !part || part === "." || part === "..") ||
          !(file === repository.fileOwnershipPrefix || file.startsWith(`${repository.fileOwnershipPrefix}/`)),
      )
    )
      throw new Error("Workspace scope files escape the host ownership prefix");
    const plug = authorization.provider === "github" ? undefined : plugins.workspaceProvider(authorization.provider);
    if (authorization.provider !== "github" && !plug)
      throw new Error(
        `The workspace provider plugin "${authorization.provider}" is not loaded, so workers cannot start in this project; load it or remove the grant`,
      );
    // Some checkout roots have no standing instructions of their own: the project folder is then the standing root.
    const repositoryRoot = plug?.standingAtProjectRoot ? projectRoot : realpathSync(selectedRepository.ownerCheckout);
    const selectedStanding = repositoryRoot === projectRoot ? projectStanding : loadDurableStanding(repositoryRoot);
    const repositoryStanding = repositoryRoot !== projectRoot ? selectedStanding : undefined;
    function assertStanding() {
      if ((plug?.standingAtProjectRoot ? projectRoot : realpathSync(selectedRepository.ownerCheckout)) !== repositoryRoot)
        throw new Error("Selected repository standing root changed");
      const current = loadDurableStanding(repositoryRoot);
      if (current.revision !== selectedStanding.revision || current.text !== selectedStanding.text)
        throw new Error("Selected repository standing instructions changed; frozen thread will not be retargeted");
    }
    assertStanding();
    const provider = isolationProvider(authorization.provider);
    // A thread that took over another's worktree uses that allocation's identity (same receipt, path and branch); the previous thread may not run again.
    const thread = {
      continueBranch: request.continueBranch,
      bound: undefined as string[] | undefined,
      workspaceConfigured: request.configured,
    };
    const allocationThread = request.threadId;
    const intentId = stableUuid(`${input.project.id}:${allocationThread}:${scope.id}`),
      attemptId = stableUuid(`${intentId}:allocation`);
    const whole = scope.wholeRepository === true;
    const leaseOwner = plug ? plug.leaseOwner(input.project) : authorization.owner;
    const githubAuthorization = input.project.githubAuthorization?.find(
      (item) => item.repositoryId === repository.repositoryId && item.workspaceRevision === authorizationFingerprint(input.project),
    );
    const publication = githubAuthorization;
    const approvedRoot = currentWorktreeRoot(input.project.id, repository.approvedRoot);
    const isolation = workspaceIsolation({
      conversation: input.conversation(),
      authority: { projectId: input.project.id, owner: leaseOwner },
      oldHome: archiveHome(),
      endedWorktreeOwner: (receipt) => endedWorkerWorkspaceOwner(input.conversation(), receipt),
      authorizedRepositories: [
        {
          repositoryId: repository.repositoryId,
          provider,
          approvedRoot,
          ownerCheckout: repository.ownerCheckout,
          fileOwnershipPrefix: repository.fileOwnershipPrefix,
        },
      ],
    });
    // A whole-repository thread starts from owner HEAD at its first allocation and keeps that base and branch on later dispatches.
    const receipts = whole ? (await isolation.snapshot()).receipts : [],
      allocated = receipts.find((item) => item.intentId === intentId)?.scope;
    const continued = allocated ? undefined : thread.continueBranch;
    const bindContext = {
      project: input.project,
      repository,
      scopeId: scope.id,
      whole,
      scopeBaseRevision: scope.baseRevision,
      threadId: request.threadId,
      workId: request.workId,
      conversationId: request.conversationId,
      allocationThread,
      allocated,
      continued,
      root: input.conversation(),
      controlRoot: input.controlRoot,
      isClosed: () => input.isClosed?.() ?? false,
      taskText: () => Promise.resolve(request.taskText),
    };
    // A provider plugin names the worktree and branch (frozen with the receipt); git derives them here.
    const plan = plug ? await plug.plan(bindContext) : undefined;
    const name = plan?.name ?? allocated?.workspaceName ?? `durable-${intentId.slice(0, 12)}`,
      workspacePath = allocated?.workspacePath ?? join(approvedRoot, name);
    const baseRevision =
      plan?.baseRevision ??
      (!whole ? scope.baseRevision : (allocated?.baseRevision ?? (continued ? continued.sha : ownerHead(repository.ownerCheckout))));
    const branch =
      plan?.branch ??
      allocated?.branch ??
      (continued ? continued.name : publication ? `${publication.branchPrefix}${name}` : whole ? `pi/${name}` : name);
    const intent: WorkspaceIntent = {
      id: intentId,
      attemptId,
      action: "allocate",
      scope: {
        projectId: input.project.id,
        repositoryId: repository.repositoryId,
        provider,
        ownerCheckout: repository.ownerCheckout,
        approvedRoot,
        workspacePath,
        workspaceName: name,
        branch,
        baseRevision,
        headRevision: plan?.headRevision ?? allocated?.headRevision ?? (continued ? ownerHead(repository.ownerCheckout) : baseRevision),
        owner: leaseOwner,
        leaseReason: plan?.leaseReason ?? `durable workspace ${allocationThread}`,
        sharedObjectStore: plan ? plan.sharedObjectStore : null,
        fileOwnership: scope.files,
        capabilityProfileRevision: hash(JSON.stringify({ authorization, scope })),
        ...(whole ? { allowDirtyOwner: true as const } : {}),
        ...(plan
          ? plan.continueBranch
            ? { continueBranch: true as const }
            : {}
          : allocated?.continueBranch || continued
            ? { continueBranch: true as const }
            : {}),
      },
    };
    let receipt = await isolation.allocate(intent);
    if (receipt.state !== "allocated") receipt = await isolation.reconcile(intent);
    // A thread whose settled worktree was cleaned up gets it back on its kept branch (same path, same frozen binding).
    if (receipt.state === "released" && receipt.providerFacts.remove === "cleanup-unforced") {
      receipt = await isolation.revive(intent);
      if (receipt.state === "released")
        throw new Error(
          `This thread's worktree was cleaned up after its work settled and could not be restored: ${receipt.reason ?? "provider cannot re-create it"}. Start a new worker for follow-up work${receipt.reason?.includes("no longer exists") ? "" : ` and tell it to continue branch ${branch} (fetch it and push to it)`}.`,
        );
    }
    if (receipt.state !== "allocated" || !receipt.workspacePath)
      throw new Error(`Workspace allocation is ${receipt.state}: ${receipt.reason ?? "no exact receipt"}`);
    if (JSON.stringify(receipt.scope) !== JSON.stringify(intent.scope))
      throw new Error("Frozen workspace allocation receipt differs from current host scope; refusing registry publication");
    const attachment = plug ? await plug.attach({ ...bindContext, receipt, receipts, plan: plan! }) : undefined;
    // Setup runs once, for worktrees this dispatch created; its recorded result reaches the worker's frozen instructions and Settings.
    // A provider may run workers in a folder inside the worktree.
    const workDir = attachment ? attachment.workDir : receipt.workspacePath;
    const setup = whole
      ? await worktreeSetup({
          command: allocated ? undefined : loadProject(input.project.id).worktreeSetup,
          controlRoot: input.controlRoot,
          intentId,
          workspacePath: receipt.workspacePath,
          cwd: workDir,
        })
      : "";
    await attachment?.start();
    const authority: WorkspaceAuthority = {
      projectId: input.project.id,
      repositoryId: repository.repositoryId,
      provider,
      workspaceId: `${scope.id}:${receipt.intentId}:${request.conversationId}`,
      receiptId: receipt.intentId,
      attemptId: receipt.attemptId,
      leaseRevision: receipt.lease?.renewedAt ?? receipt.providerFacts.head ?? scope.baseRevision,
      workspaceRoot: receipt.workspacePath,
      files: scope.files,
      ...(whole ? { wholeRepository: true } : {}),
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const commandProfiles = (input.project.commandProfiles ?? []).filter(
      (profile) => profile.enabled && profile.repositoryId === repository.repositoryId && profile.scopeIds.includes(scope.id),
    );
    if (commandProfiles.length && !input.commands) throw new Error("Host command executor is unavailable");
    const lock = {
      controlRoot: input.controlRoot,
      databasePath: await workspacePhysicalLockPath(input.controlRoot, receipt.workspacePath),
      waitMs: commandProfiles.length ? 0 : 5000,
    };
    const tools = await workspaceCapabilities({
      caller: "durable-worker",
      authority,
      binding: { role: "durable-worker", conversationId: request.conversationId },
      validateAuthority: async (candidate, action) => {
        if (input.isClosed?.()) return { approved: false, blocker: "Project runtime is closing" };
        if (candidate.receiptId !== authority.receiptId) return { approved: false, blocker: "receipt mismatch" };
        if (
          action === "write" &&
          (await input
            .conversation()
            .commit((tx) => hasUncertainCommands(tx, input.conversation().id, commandResource(authority)), BACKGROUND_CONTEXT))
        )
          return { approved: false, blocker: "Workspace command outcome is unresolved; inspect before writing" };
        return { approved: true, authority };
      },
      captureEvidence: scope.evidenceCapture
        ? async (captured, api, context) => {
            const root = input.conversation();
            async function active() {
              context.abortSignal?.throwIfAborted();
              const current = loadProject(input.project.id);
              if (
                input.isClosed?.() ||
                current.deleted ||
                current.archived ||
                authorizationFingerprint(current) !== authorizationFingerprint(input.project) ||
                Number(api.conversationId) !== request.conversationId
              )
                throw new Error("Evidence capture authority changed");
              await root.commit(async (tx) => {
                const state = await tx.doc(Jobs, root.id),
                  job = state.jobs[request.workId];
                if (state.paused || !job || job.status !== "running" || Number(job.workerConversation) !== request.conversationId)
                  throw new Error("Evidence capture requires the active scoped worker");
              }, context);
            }
            await active();
            const record = await captureEvidenceBytes({
              dir: input.controlRoot,
              filename: captured.path,
              title: captured.title,
              bytes: captured.bytes,
              sessionFile: null,
              native: {
                projectId: input.project.id,
                scopeId: scope.id,
                workId: request.workId,
                conversationId: request.conversationId,
                taskId: Number(api.taskId),
                callId: api.callId,
                sourcePath: captured.path,
              },
            });
            await active();
            return record;
          }
        : undefined,
      writeLock: lock,
    });
    if (input.commands)
      tools.push(
        ...(await commandWorkerTools({
          executor: input.commands,
          project: input.project,
          root: input.conversation(),
          authority,
          scopeId: scope.id,
          conversationId: request.conversationId,
          workId: request.workId,
          lock,
        })),
      );
    if (publication)
      tools.push(
        ...(await githubWorkerTools({
          project: input.project,
          root: input.conversation(),
          authority,
          conversationId: request.conversationId,
          branch,
          scopeId: scope.id,
          workId: request.workId,
          baseRevision,
          publication,
          isClosed: input.isClosed,
        })),
      );
    if (attachment) tools.push(...(await attachment.tools(authority)));
    // Evidence folder per thread, in the project home (survives worktree cleanup); path in the instructions and $PI_ARTIFACTS_DIR.
    const artifacts = whole ? ensureArtifactDir(input.controlRoot, request.threadId) : undefined;
    const cache = whole ? input.caches?.forIntent(intentId) : undefined;
    let pluginNotes = "";
    if (whole) {
      // Plugin worker tools freeze with the thread: a bound thread keeps exactly what it had; only new threads follow the plugin's offer.
      for (const provider of plugins.workerTools()) {
        const offered = provider.create({
          projectId: input.project.id,
          threadId: request.threadId,
          conversationId: request.conversationId,
        });
        const kept = thread.bound
          ? offered.filter((tool) => thread.bound!.includes(tool.name))
          : !thread.workspaceConfigured && provider.offered(input.project.id)
            ? offered
            : [];
        if (kept.length) {
          tools.push(...kept);
          pluginNotes += provider.instructions ?? "";
        }
      }
      const owners = ownerRoots(repository.ownerCheckout, workDir);
      const guard = workerShellGuard({
        branch,
        workDir,
        ownerCheckout: repository.ownerCheckout,
        publication,
        attachmentGuard: attachment?.guard,
      });
      const builtins = coordinatorExecutionTools({
        controlRoot: input.controlRoot,
        cache: input.caches?.forCwd,
        target: async () => ({
          cwd: workDir,
          scope: request.threadId,
          guard,
          assertWritable: (path) => assertOutsideOwner(path, workDir, owners),
        }),
      }).tools;
      const builtinNames = new Set(builtins.map((tool) => tool.name));
      tools.splice(
        0,
        tools.length,
        ...tools.filter(
          (tool) =>
            !(tool.name.startsWith("projects_workspace_") && /_(?:read|write|read_list|list)$/.test(tool.name)) &&
            !builtinNames.has(tool.name),
        ),
        ...builtins,
      );
      if (input.environment)
        tools.push(
          ...workerEnvironmentTools({
            projectId: input.project.id,
            ...input.environment,
            target: () => ({
              threadId: request.threadId,
              cwd: workDir,
              env: { ...process.env, PI_ARTIFACTS_DIR: artifacts!, ...(cache ? { [CACHE_VARIABLE]: cache } : {}) },
              guard,
            }),
          }),
        );
    }
    const gitPolicy = { prefix: publication?.branchPrefix ?? "pi/", protected: publication ? [publication.baseBranch] : [] };
    // Deliberately uninstalled: ScopedAttempt publishes only after its post-preparation active/binding recheck.
    assertStanding();
    const extension = defineExtension({
      name: `projects.workspace.${scope.id}.${intentId}.${request.conversationId}`,
      tools,
      hooks: [
        hook(ToolTask, {
          beforeTool: (_call, api) => {
            if (Number(api.conversationId) !== request.conversationId) return;
            try {
              assertStanding();
            } catch (error) {
              return { block: error instanceof Error ? error.message : "Selected repository standing resources are unavailable" };
            }
            if (attachment?.beforeTool) return attachment.beforeTool();
          },
        }),
      ],
    });
    // Skills now come from the role profile (instructions + projects_skill_file). The retired grant fingerprint stays in the hash so existing threads keep their binding revision.
    const handover = `${thread.continueBranch ? `\nThis worktree continues the existing branch ${branch} (tip ${thread.continueBranch.sha.slice(0, 12)}) of an existing PR. Commit on top and push to it; never open a second PR.` : ""}`;
    return {
      cwd: workDir,
      tools,
      extension,
      repositoryStanding,
      workerInstructions: `${whole ? `\n\nWorktree ${workDir} (branch ${branch}): run commands and make every edit here. Never cd into, run git against or write to the owner's checkout ${repository.ownerCheckout}; reading it is fine.` : ""}${handover}${whole ? `${attachment ? `\n${attachment.instructions}` : `\nPush to your branch or another project branch (${gitPolicy.prefix}*): git push origin HEAD:<branch>. You may fetch, merge, rebase and cherry-pick; after a rebase use --force-with-lease, only on project branches. Never push to ${[publication?.baseBranch, "main", "master"].filter((value, index, all) => value && all.indexOf(value) === index).join(", ")} or other branches, force-push plainly, delete branches or merge PRs.${publication ? ` Open or update a draft PR (open_draft_pr, against ${publication.baseBranch}) only when your task asks for a PR; pushing to an existing PR branch updates it.` : ""}`}\n${artifactInstructions(artifacts!, request.threadId)}${cache ? workspaceCacheInstructions(cache) : ""}${pluginNotes}` : ""}${setup ? `\n${setup}\n` : ""}`,
      bindingRevision: hash(
        JSON.stringify({
          receipt: receipt.providerFacts,
          scope,
          names: tools.map((tool) => tool.name),
          commands: (input.project.commandProfiles ?? [])
            .filter((profile) => profile.enabled && profile.scopeIds.includes(scope.id))
            .map((profile) => ({ id: profile.id, revision: profile.revision })),
          ...(repositoryStanding?.text.length ? { repositoryStanding: hash(JSON.stringify(repositoryStanding)) } : {}),
        }),
      ),
    };
  };
}
/**
 * The shell policy of a whole-repository worker: its git pushes stay on project branches and its commands stay out of the owner's checkout.
 * Workers, their background commands and their verifiers all run commands through this one function; it is best-effort text matching, not a sandbox.
 */
export function workerShellGuard(input: {
  branch: string;
  workDir: string;
  ownerCheckout: string;
  publication?: { branchPrefix: string; baseBranch: string };
  attachmentGuard?: (command: string) => string;
}): (command: string) => string {
  const gitPolicy = {
    prefix: input.publication?.branchPrefix ?? "pi/",
    protected: input.publication ? [input.publication.baseBranch] : [],
  };
  const owners = ownerRoots(input.ownerCheckout, input.workDir);
  return (command) =>
    guardOwnerCheckout(
      input.attachmentGuard ? input.attachmentGuard(command) : guardWorkerGitCommand(command, input.branch, gitPolicy),
      input.workDir,
      owners,
    );
}
/**
 * The shell policy projects_verify_run commands pass through: the one of the worker whose scope they verify. Plugin workspace providers keep that
 * policy inside the plugin, which these runs cannot reach, so those scopes are refused rather than run under a weaker one.
 */
export function verifierShell(
  project: Project,
  scopeId: string,
  workDir: string,
  branch: string | null,
): { guard: (command: string) => string } | { refusal: string } {
  const authorization = project.workspaceAuthorization,
    scope = authorization?.scopes.find((item) => item.id === scopeId),
    repository = authorization?.repositories.find((item) => item.repositoryId === scope?.repositoryId);
  if (!authorization || !scope || !repository) return { refusal: "The worker's workspace scope is no longer authorized for this project" };
  const unsupported = verificationProviderProblem(project);
  if (unsupported) return { refusal: unsupported };
  if (scope.wholeRepository !== true)
    return {
      refusal:
        "Verification requires the worker's whole-repository shell grant; folder-limited workers cannot gain general shell through a verifier",
    };
  const publication = project.githubAuthorization?.find(
    (item) => item.repositoryId === repository.repositoryId && item.workspaceRevision === authorizationFingerprint(project),
  );
  return { guard: workerShellGuard({ branch: branch ?? "", workDir, ownerCheckout: repository.ownerCheckout, publication }) };
}
/** Pushes may target this worker's branch or any other project branch (the publication prefix); never the base/default branch. */
export function guardWorkerGitCommand(
  command: string,
  branch: string,
  policy: { prefix?: string; protected?: readonly string[] } = {},
): string {
  // This shell-text check is best-effort, not a sandbox. It catches common git/gh forms before spawn; one blocked segment blocks the whole command.
  const prefix = policy.prefix && policy.prefix.length >= 2 ? policy.prefix : undefined;
  const guarded = new Set(["main", "master", "HEAD", ...(policy.protected ?? [])]);
  const project = (ref: string) => {
    const name = ref.replace(/^refs\/heads\//, "");
    return (
      !guarded.has(name) &&
      (name === branch || (prefix !== undefined && name.startsWith(prefix) && name.length > prefix.length && !name.includes("..")))
    );
  };
  // Redirections are not arguments: `2>&1` would otherwise split at `&` and leave `2>` as a push target.
  const chunks = command
    .replace(/(?:^|(?<=\s))(?:\d*|&)(?:>>?|<)(?:&-|&\d+|\s*[^\s;&|<>]+)/g, " ")
    .split(/[;&|\n]+/)
    .map((part) => part.trim());
  const blocked = chunks.find((chunk) => {
    const git = chunk
      .match(/(?:^|\s)git\s+(.*)$/)?.[1]
      ?.trim()
      .replace(/^(?:-[Cc]\s+\S+\s+)+/, "");
    if (git && /^branch\s+(?:-(?:D|d)|--delete)(?:\s|$)/.test(git)) return true;
    if (git && /^push(?:\s|$)/.test(git)) {
      const args = git
        .replace(/^push\s*/, "")
        .split(/\s+/)
        .filter(Boolean);
      if (
        args.some((value) => /^--(?:mirror|all|tags|delete|prune)$/.test(value) || (/^-[a-zA-Z]*d/.test(value) && !value.startsWith("--")))
      )
        return true;
      const positional = args.filter((value) => !value.startsWith("-"));
      const refs =
        positional[0] === "origin" || positional[0] === "upstream" || (positional.length > 1 && !positional[0].includes(":"))
          ? positional.slice(1)
          : positional;
      if (!refs.length) return true;
      for (const ref of refs) {
        if (ref.startsWith(":")) return true;
        // A force push (+ref, -f, --force) is allowed like any push: only project branches are targets.
        const target = (ref.includes(":") ? ref.split(":").at(-1)! : ref).replace(/^\+/, "");
        // A bare HEAD pushes the checked-out branch to its own name; best-effort as before.
        if (!(ref.replace(/^\+/, "") === "HEAD" || project(target))) return true;
      }
      const lease = args.find((value) => value.startsWith("--force-with-lease"));
      if (lease?.includes("=") && !project(lease.slice(lease.indexOf("=") + 1).split(":")[0])) return true;
      return false;
    }
    if (/\bgh\s+pr\s+merge\b/.test(chunk)) return true;
    if (/\bgh\s+api\b[^;&|\n]*\bmerge\b/i.test(chunk)) return true;
    return false;
  });
  if (blocked === undefined) return command;
  const message = `Blocked by worker Git policy at: ${blocked.slice(0, 200)} -- push only to project branches${prefix ? ` (${prefix}*)` : ` (${branch})`}; force pushes are allowed there; deletes, mirror/all/tags, pushes to ${[...guarded].filter((name) => name !== "HEAD").join("/")} and PR merges are not. Nothing in this command ran. This check is best-effort.`;
  return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
}
/** Task helpers return commits to their Coordinator, which publishes: no git push and no gh PR or release writes. Best-effort, not a sandbox. */
export function guardHelperGitCommand(command: string): string {
  const blocked = command
    .split(/[;&|\n]+/)
    .map((part) => part.trim())
    .find(
      (chunk) =>
        /(?:^|\s)git\s+(?:-[Cc]\s+\S+\s+)*push(?:\s|$)/.test(chunk) ||
        /(?:^|\s)gh\s+(?:pr\s+(?!(?:view|list|diff|checks|status)\b)\S|release\s+(?!(?:view|list)\b)\S|api\b.*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE))/i.test(
          chunk,
        ),
    );
  if (blocked === undefined) return command;
  const message = `Blocked by task helper policy at: ${blocked.slice(0, 200)} -- a task helper never pushes or changes PRs. Commit locally and return your commits to the Coordinator; it integrates and publishes. Nothing in this command ran.`;
  return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
}
/** Real and given spellings of the owner checkout; empty when the worktree itself sits inside it (nothing to separate). */
function ownerRoots(checkout: string, workDir: string): string[] {
  const roots = [...new Set([resolve(checkout), realpathSync(checkout)])];
  return roots.some((root) => inside(root, resolve(workDir)) || inside(root, realpathSync(workDir))) ? [] : roots;
}
function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}
/** Best-effort accident guard (not a sandbox): refuses cd/pushd/git -C/redirect/tee targets inside the owner checkout; reads stay allowed. */
export function guardOwnerCheckout(command: string, workDir: string, owners: readonly string[]): string {
  if (!owners.length) return command;
  const hits = (path: string) => {
    const target = path.replace(/^["']|["']$/g, "");
    return target !== "" && owners.some((root) => inside(root, resolve(workDir, target)));
  };
  const blocked = command
    .split(/[;&|\n]+/)
    .map((part) => part.trim())
    .find((chunk) => {
      const words = (chunk.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ""));
      const after = (name: string) =>
        words.flatMap((word, index) => (word === name ? [words.slice(index + 1).find((next) => !next.startsWith("-")) ?? ""] : []));
      const flagged = words.flatMap((word, index) =>
        word === "-C" || word === "--git-dir" || word === "--work-tree"
          ? [words[index + 1] ?? ""]
          : /^--(?:git-dir|work-tree)=/.test(word)
            ? [word.slice(word.indexOf("=") + 1)]
            : [],
      );
      const redirected = [...chunk.matchAll(/(?:^|[^<>&\d])\d*>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)].map((match) => match[1]);
      return [
        ...after("cd"),
        ...after("pushd"),
        ...(words.includes("git") ? flagged : []),
        ...redirected,
        ...words.flatMap((word, index) => (word === "tee" ? words.slice(index + 1).filter((next) => !next.startsWith("-")) : [])),
      ].some(hits);
    });
  if (blocked === undefined) return command;
  const message = `Blocked: "${blocked.slice(0, 200)}" works in the owner's checkout (${owners[0]}), not in your worktree (${workDir}). Nothing in this command ran. Reading the owner checkout is fine; run commands and write files in your worktree. This check is best-effort.`;
  return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
}
function assertOutsideOwner(path: string, workDir: string, owners: readonly string[]): void {
  if (!owners.length || !path) return;
  let target = resolve(workDir, path);
  const tail: string[] = [];
  while (!existsSync(target) && dirname(target) !== target) {
    tail.unshift(target.slice(dirname(target).length + 1));
    target = dirname(target);
  }
  const real = resolve(realpathSync(target), ...tail);
  if (owners.some((root) => inside(root, real)))
    throw new Error(
      `${path} is inside the owner's checkout (${owners[0]}); write files in your worktree (${workDir}) instead. Reading the owner checkout is fine.`,
    );
}
function ownerHead(checkout: string): string {
  return execFileSync("/usr/bin/git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableUuid(value: string): string {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
