import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, type Conversation } from "@earendil-works/pi-durable";
import type { Project } from "./state.ts";
import type { TaskWorkspace } from "./jobs.ts";
import type { DurablePreparedWorkerEnvironment } from "./durable-types.ts";
import type { AllocationPlan, TaskAttachment, TaskPlanContext } from "./plugin-types.ts";
import { CoordinatorWorkspaceBindings, type CoordinatorWorkspaceRequest } from "./coordinator-workspace-state.ts";
import type { coordinatorWorkspaces } from "./coordinator-workspace.ts";
import { coordinatorExecutionTools } from "./coordinator-execution.ts";
import { currentWorktreeRoot, guardHelperGitCommand } from "./durable-workspace-binding.ts";
import { command, workspaceIsolation } from "./workspace-isolation.ts";
import { isolationProvider, type WorkspaceIntent } from "./workspace-types.ts";
import { plugins } from "./plugins.ts";
import { cli } from "./vcs.ts";
import { artifactInstructions, ensureArtifactDir } from "./artifacts.ts";
import { CACHE_VARIABLE, workspaceCacheInstructions, type WorkspaceCaches } from "./workspace-cache.ts";
import { workerEnvironmentTools } from "./worker-environment-tools.ts";
import type { BackgroundCommands } from "./background-commands.ts";
import type { ResourceLeases } from "./resource-leases.ts";
import { worktreeSetup } from "./worktree-maintenance.ts";

type Source = CoordinatorWorkspaceRequest & { intentId: string };
type Binding = { kind: "shared"; source: Source } | { kind: "isolated"; grant: string; scopeId: string; intent: WorkspaceIntent };
const TaskWorkspaceBindings = defineDoc<{ threads: Record<string, Binding> }>({
  kind: "projects.task-workspaces",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ threads: {} }),
});
type Request = { threadId: string; conversationId: number; workId: string; taskText: string };

/** Task allocations and borrowed attachments never own the source chat's runtime handles. */
export function taskWorkerWorkspaces(input: {
  project(): Project;
  root(): Conversation;
  coordinator: ReturnType<typeof coordinatorWorkspaces>;
  source(conversationId: number): Promise<CoordinatorWorkspaceRequest>;
  active(request: Request): Promise<void>;
  controlRoot: string;
  environment: { background: BackgroundCommands; leases: ResourceLeases };
  isClosed(): boolean;
  caches?: WorkspaceCaches;
}) {
  let closed = false;
  const attachments = new Map<string, TaskAttachment>();
  const controllers = new Map<string, Set<AbortController>>();
  const operations = new Set<Promise<unknown>>();
  const queues = new Map<string, Promise<unknown>>();
  const assertOpen = () => {
    if (closed || input.isClosed()) throw new Error("Task workspaces are closed");
  };
  async function active(request: Request) {
    assertOpen();
    await input.active(request);
    assertOpen();
  }
  async function read(threadId: string) {
    return input.root().commit(async (tx) => {
      const binding = (await tx.doc(TaskWorkspaceBindings, input.root().id)).threads[threadId];
      return binding ? copy(binding) : undefined;
    }, BACKGROUND_CONTEXT);
  }
  function grant(binding?: Extract<Binding, { kind: "isolated" }>) {
    const project = input.project(),
      authorization = project.workspaceAuthorization;
    if (!authorization) throw new Error("Task workspace grant is missing");
    const scopes = authorization.scopes.filter((scope) => scope.wholeRepository === true);
    if (scopes.length !== 1) throw new Error("Task workspace requires exactly one whole-repository scope");
    const scope = scopes[0]!;
    const repository = authorization.repositories.find((repo) => repo.repositoryId === scope.repositoryId);
    if (!repository || repository.provider !== authorization.provider || repository.fileOwnershipPrefix !== "." || scope.files.length)
      throw new Error("Task repository grant is invalid");
    const revision = JSON.stringify({
      projectId: project.id,
      owner: authorization.owner,
      provider: authorization.provider,
      repository,
      scope,
    });
    if (binding && (binding.grant !== revision || binding.scopeId !== scope.id))
      throw new Error("Task workspace grant changed or was revoked");
    const provider = isolationProvider(authorization.provider);
    const plug = provider === "git" ? undefined : plugins.workspaceProvider(provider);
    if (provider !== "git" && !plug?.task) throw new Error(`Isolated task workspace unsupported by provider "${provider}"`);
    return { project, authorization, scope, repository, revision, provider, plug };
  }
  /** Helpers never publish: the workspace plugin's helper policy, else core's Git one. */
  function helperGuard(): (command: string) => string {
    const provider = input.project().workspaceAuthorization?.provider;
    const kind = provider ? isolationProvider(provider) : "git";
    const plug = kind === "git" ? undefined : plugins.workspaceProvider(kind);
    return plug?.helperGuard ? (command) => plug.helperGuard!(command) : guardHelperGitCommand;
  }
  function isolation(binding: Extract<Binding, { kind: "isolated" }>) {
    const selected = grant(binding);
    return workspaceIsolation({
      conversation: input.root(),
      authority: { projectId: selected.project.id, owner: binding.intent.scope.owner },
      authorizedRepositories: [
        {
          repositoryId: selected.repository.repositoryId,
          ownerCheckout: selected.repository.ownerCheckout,
          fileOwnershipPrefix: selected.repository.fileOwnershipPrefix,
          provider: selected.provider,
          approvedRoot: binding.intent.scope.approvedRoot,
        },
      ],
    });
  }
  function context(request: Request, binding: Extract<Binding, { kind: "isolated" }>) {
    const selected = grant(binding);
    return {
      project: selected.project,
      repository: { ...selected.repository, approvedRoot: binding.intent.scope.approvedRoot },
      scopeId: selected.scope.id,
      whole: true,
      scopeBaseRevision: selected.scope.baseRevision,
      ...request,
      allocationThread: request.threadId,
      allocated: binding.intent.scope,
      root: input.root(),
      controlRoot: input.controlRoot,
      isClosed: () => closed || input.isClosed(),
      taskText: () => Promise.resolve(request.taskText),
    };
  }
  async function freeze(request: Request, chat: number, choice: TaskWorkspace, reader = false): Promise<Binding> {
    const stored = await read(request.threadId);
    if (stored) return stored;
    await active(request);
    const source = await input.source(chat);
    // A reader may be the chat's first use of its workspace; a helper only borrows one the chat already prepared.
    const ready = reader ? await input.coordinator.ensure(source) : await input.coordinator.ready(source);

    let proposed: Binding;
    if (choice.kind === "shared") proposed = { kind: "shared", source: { ...source, intentId: ready.intentId } };
    else {
      const selected = grant();
      const sourceBinding = await input.root().commit(async (tx) => {
        const binding = (await tx.doc(CoordinatorWorkspaceBindings, input.root().id)).chats[source.chatId];
        return binding ? copy(binding) : undefined;
      }, BACKGROUND_CONTEXT);
      if (!sourceBinding || sourceBinding.intent.id !== ready.intentId || sourceBinding.grant !== selected.revision)
        throw new Error("Source chat repository or grant differs");
      const id = uuid(`${selected.project.id}:${request.threadId}:task-workspace`);
      const approvedRoot = currentWorktreeRoot(selected.project.id, selected.repository.approvedRoot);
      let plan: AllocationPlan;
      if (selected.plug) {
        const planning: TaskPlanContext = {
          ...context(request, { kind: "isolated", grant: selected.revision, scopeId: selected.scope.id, intent: sourceBinding.intent }),
          allocated: undefined,
          source: ready,
          baseCommit: choice.baseCommit,
        };
        plan = await selected.plug.task!.plan(planning);
      } else {
        const owner = selected.repository.ownerCheckout;
        const common = async (cwd: string) => realpathSync(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
        if ((await common(owner)) !== (await common(ready.cwd))) throw new Error("Task source belongs to another Git repository");
        const commit = await git(ready.cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${choice.baseCommit}^{commit}`,
        ]).catch(() => {
          throw new Error(
            `Commit ${choice.baseCommit} is not in the local repository; fetch it first (git fetch origin <branch or pull/N/head>)`,
          );
        });
        if (commit !== choice.baseCommit) throw new Error("Task base must be an existing full commit in the source repository");
        const name = `task-${id.slice(0, 12)}`;
        plan = {
          name,
          branch: `pi/${name}`,
          baseRevision: commit,
          headRevision: await git(owner, ["rev-parse", "HEAD"]),
          leaseReason: `durable workspace ${request.threadId}`,
          sharedObjectStore: null,
        };
      }
      if (!/^[a-f0-9]{40,64}$/.test(choice.baseCommit) || plan.baseRevision !== choice.baseCommit || plan.continueBranch)
        throw new Error("Task provider did not honor the chosen commit and fresh branch");
      proposed = {
        kind: "isolated",
        grant: selected.revision,
        scopeId: selected.scope.id,
        intent: {
          id,
          attemptId: uuid(`${id}:allocation`),
          action: "allocate",
          scope: {
            projectId: selected.project.id,
            repositoryId: selected.repository.repositoryId,
            provider: selected.provider,
            ownerCheckout: selected.repository.ownerCheckout,
            approvedRoot,
            workspacePath: join(approvedRoot, plan.name),
            workspaceName: plan.name,
            branch: plan.branch,
            baseRevision: plan.baseRevision,
            headRevision: plan.headRevision,
            owner: selected.plug ? selected.plug.leaseOwner(selected.project) : selected.authorization.owner,
            leaseReason: plan.leaseReason,
            sharedObjectStore: plan.sharedObjectStore,
            fileOwnership: [],
            capabilityProfileRevision: hash(selected.revision),
            allowDirtyOwner: true,
          },
        },
      };
    }
    await active(request);
    return input.root().commit(async (tx) => {
      const doc = await tx.doc(TaskWorkspaceBindings, input.root().id);
      return copy((doc.threads[request.threadId] ??= proposed));
    }, BACKGROUND_CONTEXT);
  }
  async function target(request: Request, binding: Binding) {
    await active(request);
    if (binding.kind === "shared") {
      const source = await input.source(binding.source.conversationId);
      if (source.chatId !== binding.source.chatId) throw new Error("Source chat identity changed");
      const ready = await input.coordinator.borrow(binding.source);
      await active(request);
      return { cwd: ready.cwd, branch: ready.branch, scope: request.threadId, guard: helperGuard() };
    }
    const owned = isolation(binding),
      attachment = attachments.get(request.threadId);
    if (grant(binding).plug) {
      if (!attachment) throw new Error("Task provider attachment is unavailable");
      await attachment.checkOwned();
    } else await owned.checkOwned(binding.intent);
    await active(request);
    return {
      cwd: attachment ? realpathSync(attachment.workDir) : binding.intent.scope.workspacePath,
      branch: binding.intent.scope.branch,
      scope: request.threadId,
      guard: helperGuard(),
    };
  }
  /** Serialized per thread and aborted by closeThread. */
  async function queued<T>(threadId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const controller = new AbortController();
    const pending = controllers.get(threadId) ?? new Set<AbortController>();
    pending.add(controller);
    controllers.set(threadId, pending);
    const operation = previous
      .catch(() => {})
      .then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      });
    queues.set(threadId, operation);
    operations.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(controller);
      if (!pending.size) controllers.delete(threadId);
      operations.delete(operation);
      if (queues.get(threadId) === operation) queues.delete(threadId);
    }
  }
  async function allocate(request: Request, binding: Extract<Binding, { kind: "isolated" }>) {
    const owned = isolation(binding),
      selected = grant(binding),
      intent = binding.intent;
    let receipt = (await owned.snapshot()).receipts.find((item) => item.intentId === intent.id);
    if (!receipt || receipt.state === "prepared") {
      receipt = await owned.allocate(intent);
      await active(request);
      if (receipt.state !== "allocated") receipt = await owned.reconcile(intent);
    }
    if (!receipt || receipt.state !== "allocated" || JSON.stringify(receipt.scope) !== JSON.stringify(intent.scope))
      throw new Error(`Task allocation unavailable: ${receipt?.state ?? "missing"}; retaining frozen binding`);
    if (selected.plug && !attachments.has(request.threadId)) {
      const plan: AllocationPlan = {
        name: intent.scope.workspaceName,
        branch: intent.scope.branch,
        baseRevision: intent.scope.baseRevision,
        headRevision: intent.scope.headRevision,
        leaseReason: intent.scope.leaseReason,
        sharedObjectStore: intent.scope.sharedObjectStore,
      };
      const attachment = await selected.plug.task!.attach({
        ...context(request, binding),
        receipt,
        receipts: (await owned.snapshot()).receipts,
        plan,
      });
      attachments.set(request.threadId, attachment);
      await active(request);
      await attachment.checkOwned();
      await attachment.start();
    }
  }
  /** A scout's or reviewer's own worktree at a full commit: the task allocation without setup command or execution tools. */
  function prepareReader(request: Request & { chat: number; baseCommit: string }): Promise<{ cwd: string }> {
    return queued(request.threadId, async () => {
      const binding = await freeze(request, request.chat, { kind: "isolated", baseCommit: request.baseCommit }, true);
      if (binding.kind !== "isolated") throw new Error("Reader workspace must be isolated");
      await allocate(request, binding);
      return { cwd: (await target(request, binding)).cwd };
    });
  }
  function prepare(
    request: Request & { chat: number; choice: TaskWorkspace },
  ): Promise<DurablePreparedWorkerEnvironment & { branch: string }> {
    return queued(request.threadId, async (signal) => {
      const binding = await freeze(request, request.chat, request.choice);
      let notes = "";
      if (binding.kind === "isolated") {
        await allocate(request, binding);
        const resolved = await target(request, binding);
        notes = await worktreeSetup({
          command: grant(binding).project.worktreeSetup,
          controlRoot: input.controlRoot,
          intentId: binding.intent.id,
          workspacePath: binding.intent.scope.workspacePath,
          cwd: resolved.cwd,
          signal,
        });
        notes += attachments.get(request.threadId)?.instructions ?? "";
      }
      const resolved = await target(request, binding);
      const execution = coordinatorExecutionTools({
        controlRoot: input.controlRoot,
        cache: input.caches?.forCwd,
        name: `projects.task-execution.${request.conversationId}`,
        target: async (api, context) => {
          context.abortSignal?.throwIfAborted();
          if (Number(api.conversationId) !== request.conversationId) throw new Error("Wrong task conversation");
          return target(request, binding);
        },
      });
      const artifacts = ensureArtifactDir(input.controlRoot, request.threadId);
      const cache = input.caches?.forIntent(binding.kind === "shared" ? binding.source.intentId : binding.intent.id);
      const environment = workerEnvironmentTools({
        projectId: input.project().id,
        ...input.environment,
        owner: async (api) => {
          if (Number(api.conversationId) !== request.conversationId) throw new Error("Wrong task conversation");
          await active(request);
          return request.threadId;
        },
        target: async (api, context) => {
          context.abortSignal?.throwIfAborted();
          if (Number(api.conversationId) !== request.conversationId) throw new Error("Wrong task conversation");
          const cwd = (await target(request, binding)).cwd,
            cache = await input.caches?.forCwd(cwd);
          return {
            threadId: request.threadId,
            cwd,
            env: { ...process.env, PI_ARTIFACTS_DIR: artifacts, ...(cache ? { [CACHE_VARIABLE]: cache } : {}) },
            guard: helperGuard(),
          };
        },
      });
      const tools = [...execution.tools, ...environment];
      const extension = defineExtension({ name: `projects.task-workspace.${request.conversationId}`, tools });
      await active(request);
      return {
        cwd: resolved.cwd,
        branch: resolved.branch,
        tools,
        extension,
        bindingRevision: hash(JSON.stringify(binding)),
        workerInstructions: `\nTask workspace (${binding.kind}): ${resolved.cwd}, branch ${resolved.branch}. Make edits and run commands here. Keep this branch. Return your changes, checks and remaining risks to the Coordinator, which integrates and publishes. Never push or update a PR, and send no Ready report. Final PR merge, deployment and destructive operations still need owner approval.\n${artifactInstructions(artifacts, request.threadId)}${cache ? workspaceCacheInstructions(cache) : ""}\n${notes}`,
      };
    });
  }
  async function validate(request: Request) {
    const binding = await read(request.threadId);
    if (!binding) throw new Error("Task workspace binding is missing");
    return target(request, binding);
  }
  async function closeThread(threadId: string) {
    for (const controller of controllers.get(threadId) ?? []) controller.abort(new Error("Task worker stopped"));
    await queues.get(threadId)?.catch(() => {});
    const attachment = attachments.get(threadId);
    if (attachment) {
      await attachment.detach();
      attachments.delete(threadId);
    }
  }
  async function close() {
    closed = true;
    for (const pending of controllers.values()) for (const controller of pending) controller.abort(new Error("Task workspaces closed"));
    await Promise.allSettled([...operations]);
    const results = await Promise.allSettled([...attachments.keys()].map(closeThread));
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Task workspace detach failed");
  }
  return { prepare, prepareReader, validate, closeThread, close };
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function uuid(value: string) {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function git(cwd: string, args: string[]) {
  const result = await command(cli.git(), args, cwd);
  if (result.code) throw new Error(`Git task validation failed: ${result.stderr}`);
  return result.stdout.trim();
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
