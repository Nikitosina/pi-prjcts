import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Project } from "./state.ts";
import type { AllocationPlan, CoordinatorAttachment, CoordinatorBindContext } from "./plugin-types.ts";
import { plugins } from "./plugins.ts";
import { currentWorktreeRoot } from "./durable-workspace-binding.ts";
import { command, workspaceIsolation, workspaceReceipts } from "./workspace-isolation.ts";
import { isolationProvider, type WorkspaceIntent } from "./workspace-types.ts";
import { worktreeSetup } from "./worktree-maintenance.ts";
import { cli } from "./vcs.ts";

export type { CoordinatorWorkspaceRequest, CoordinatorWorkspaceReady, CoordinatorWorkspaceView } from "./coordinator-workspace-state.ts";
import {
  CoordinatorWorkspaceBindings,
  type CoordinatorWorkspaceBinding,
  type CoordinatorWorkspaceRequest,
  type CoordinatorWorkspaceReady,
  type CoordinatorWorkspaceView,
} from "./coordinator-workspace-state.ts";

/** Persistent chat ownership is separate from runtime attachment lifetime. */
export function coordinatorWorkspaces(input: {
  project: () => Project;
  root: () => Conversation;
  controlRoot: string;
  isClosed: () => boolean;
}) {
  let closed = false;
  let closing: Promise<void> | undefined;
  const shutdown = new AbortController();
  const queues = new Map<string, Promise<unknown>>();
  const attachments = new Map<string, CoordinatorAttachment>();
  const blockers = new Map<string, string>();
  const assertOpen = () => {
    if (closed || input.isClosed()) throw new Error("Coordinator workspaces are closed");
  };
  const read = (chatId: string) =>
    input.root().commit(async (tx) => {
      const binding = (await tx.doc(CoordinatorWorkspaceBindings, input.root().id)).chats[chatId];
      return binding ? copy(binding) : undefined;
    }, BACKGROUND_CONTEXT);
  function current(request: CoordinatorWorkspaceRequest, binding?: CoordinatorWorkspaceBinding) {
    assertOpen();
    if (!request.chatId || !Number.isSafeInteger(request.conversationId) || request.conversationId < 1)
      throw new Error("Invalid coordinator chat identity");
    if (binding && binding.conversationId !== request.conversationId) throw new Error("Chat conversation identity differs");
    const project = input.project();
    const authorization = project.workspaceAuthorization;
    if (!authorization) throw new Error("Coordinator workspace requires an existing whole-repository grant");
    if (
      new Set(authorization.scopes.map((scope) => scope.id)).size !== authorization.scopes.length ||
      new Set(authorization.repositories.map((repository) => repository.repositoryId)).size !== authorization.repositories.length
    )
      throw new Error("Ambiguous workspace grant IDs");
    const scopes = authorization.scopes.filter((scope) => scope.wholeRepository === true);
    if (scopes.length !== 1)
      throw new Error("Coordinator workspace requires exactly one whole-repository scope; grant is missing or ambiguous");
    const scope = scopes[0]!;
    const repository = authorization.repositories.find((item) => item.repositoryId === scope.repositoryId);
    if (!repository || repository.provider !== authorization.provider || repository.fileOwnershipPrefix !== "." || scope.files.length)
      throw new Error("Whole-repository scope is not authorized by its repository grant");
    const grant = JSON.stringify({
      projectId: project.id,
      owner: authorization.owner,
      provider: authorization.provider,
      repository,
      scope,
    });
    if (binding && (binding.grant !== grant || binding.scopeId !== scope.id))
      throw new Error("Coordinator workspace grant changed or was revoked; retaining the original allocation");
    const provider = isolationProvider(authorization.provider);
    const plug = provider === "git" ? undefined : plugins.workspaceProvider(provider);
    if (provider !== "git" && !plug) throw new Error(`Workspace provider "${provider}" is not loaded`);
    if (plug && !plug.coordinator) throw new Error(`Unsupported coordinator adapter for workspace provider "${provider}"`);
    return { project, authorization, scope, repository, grant, provider, plug };
  }
  async function prepare(request: CoordinatorWorkspaceRequest, signal: AbortSignal): Promise<CoordinatorWorkspaceReady> {
    const check = (binding?: CoordinatorWorkspaceBinding) => {
      signal.throwIfAborted();
      return current(request, binding);
    };
    check();
    let binding = await read(request.chatId);
    const selected = check(binding);
    const { project, authorization, scope, repository, grant, provider, plug } = selected;
    const threadId = `coordinator:${request.chatId}`;
    const intentId = uuid(`${project.id}:${threadId}:workspace`);
    const approvedRoot = binding?.intent.scope.approvedRoot ?? currentWorktreeRoot(project.id, repository.approvedRoot);
    const context: CoordinatorBindContext = {
      project,
      repository: { ...repository, approvedRoot },
      scopeId: scope.id,
      whole: true,
      scopeBaseRevision: scope.baseRevision,
      threadId,
      conversationId: request.conversationId,
      allocationThread: threadId,
      allocated: binding?.intent.scope,
      root: input.root(),
      controlRoot: input.controlRoot,
      isClosed: () => closed || input.isClosed(),
      chatId: request.chatId,
    };
    if (!binding) {
      const plan = plug ? await plug.coordinator!.plan(context) : undefined;
      if (check().grant !== grant) throw new Error("Coordinator workspace grant changed during preparation");
      const name = plan?.name ?? `coordinator-${intentId.slice(0, 12)}`;
      const head = plan?.baseRevision ?? (await ownerHead(repository.ownerCheckout));
      if (check().grant !== grant) throw new Error("Coordinator workspace grant changed during preparation");
      const intent: WorkspaceIntent = {
        id: intentId,
        attemptId: uuid(`${intentId}:allocation`),
        action: "allocate",
        scope: {
          projectId: project.id,
          repositoryId: repository.repositoryId,
          provider,
          ownerCheckout: repository.ownerCheckout,
          approvedRoot,
          workspacePath: join(approvedRoot, name),
          workspaceName: name,
          branch: plan?.branch ?? `pi/${name}`,
          baseRevision: head,
          headRevision: plan?.headRevision ?? head,
          owner: plug ? plug.leaseOwner(project) : authorization.owner,
          leaseReason: plan?.leaseReason ?? `persistent chat ${threadId}`,
          sharedObjectStore: plan?.sharedObjectStore ?? null,
          fileOwnership: [],
          capabilityProfileRevision: createHash("sha256").update(grant).digest("hex"),
          allowDirtyOwner: true,
          ...(plan?.continueBranch ? { continueBranch: true } : {}),
        },
      };
      const proposed: CoordinatorWorkspaceBinding = {
        ...request,
        threadId,
        scope: uuid(`${project.id}:${threadId}:artifacts`),
        grant,
        scopeId: scope.id,
        intent,
        ready: null,
      };
      binding = await input.root().commit(async (tx) => {
        const doc = await tx.doc(CoordinatorWorkspaceBindings, input.root().id);
        return copy((doc.chats[request.chatId] ??= proposed));
      }, BACKGROUND_CONTEXT);
    }
    check(binding);
    const intent = binding.intent;
    const isolation = workspaceIsolation({
      conversation: input.root(),
      authority: { projectId: project.id, owner: intent.scope.owner },
      authorizedRepositories: [
        {
          repositoryId: repository.repositoryId,
          provider,
          ownerCheckout: repository.ownerCheckout,
          approvedRoot: intent.scope.approvedRoot,
          fileOwnershipPrefix: repository.fileOwnershipPrefix,
        },
      ],
    });
    let receipt = (await isolation.snapshot()).receipts.find((item) => item.intentId === intent.id);
    if (!binding.ready) {
      check(binding);
      receipt = await isolation.allocate(intent);
      check(binding);
      if (receipt.state !== "allocated") receipt = await isolation.reconcile(intent);
      if (receipt.state !== "allocated") throw new Error(`Coordinator workspace allocation is ${receipt.state}: ${receipt.reason}`);
    }
    if (!receipt || receipt.workspacePath !== intent.scope.workspacePath || JSON.stringify(receipt.scope) !== JSON.stringify(intent.scope))
      throw new Error("Frozen coordinator workspace receipt differs or is missing");
    if (receipt.state === "released" || receipt.state === "blocked" || receipt.state === "prepared")
      throw new Error(`Coordinator workspace receipt is ${receipt.state}; refusing reuse`);
    check(binding);
    let attachment = attachments.get(request.chatId);
    let fresh: CoordinatorAttachment | undefined;
    try {
      if (plug) {
        if (!attachment) {
          const plan: AllocationPlan = {
            name: intent.scope.workspaceName,
            branch: intent.scope.branch,
            baseRevision: intent.scope.baseRevision,
            headRevision: intent.scope.headRevision,
            leaseReason: intent.scope.leaseReason,
            sharedObjectStore: intent.scope.sharedObjectStore,
            ...(intent.scope.continueBranch ? { continueBranch: true } : {}),
          };
          const receipts = (await isolation.snapshot()).receipts;
          check(binding);
          fresh = await plug.coordinator!.attach({
            ...context,
            allocated: intent.scope,
            receipt,
            receipts,
            plan,
          });
          attachment = fresh;
          check(binding);
          await attachment.checkOwned();
          check(binding);
          await attachment.start();
          check(binding);
        }
        await attachment.checkOwned();
      } else await isolation.checkOwned(intent);
      check(binding);
      const cwd = attachment ? realpathSync(attachment.workDir) : intent.scope.workspacePath;
      await worktreeSetup({
        command: binding.ready ? undefined : input.project().worktreeSetup,
        controlRoot: input.controlRoot,
        intentId: intent.id,
        workspacePath: intent.scope.workspacePath,
        cwd,
        signal,
      });
      check(binding);
      if (attachment) await attachment.checkOwned();
      else await isolation.checkOwned(intent);
      check(binding);
      const ready: CoordinatorWorkspaceReady = {
        ...request,
        status: "ready",
        cwd,
        provider,
        branch: intent.scope.branch,
        scope: binding.scope,
        threadId: binding.threadId,
        intentId: intent.id,
      };
      await input.root().commit(async (tx) => {
        (await tx.doc(CoordinatorWorkspaceBindings, input.root().id)).chats[request.chatId]!.ready = ready;
      }, BACKGROUND_CONTEXT);
      check(binding);
      if (fresh) attachments.set(request.chatId, fresh);
      return ready;
    } catch (error) {
      if (attachment) {
        attachments.delete(request.chatId);
        try {
          await attachment.detach();
        } catch (detachError) {
          throw new AggregateError([error, detachError], "Coordinator workspace preparation and detach failed");
        }
      }
      throw error;
    }
  }
  function ensure(request: CoordinatorWorkspaceRequest, signal?: AbortSignal): Promise<CoordinatorWorkspaceReady> {
    if (closed || input.isClosed()) return Promise.reject(new Error("Coordinator workspaces are closed"));
    const preparationSignal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
    const previous = queues.get(request.chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => prepare(request, preparationSignal))
      .then(
        (ready) => {
          blockers.delete(request.chatId);
          return ready;
        },
        (error: unknown) => {
          blockers.set(request.chatId, error instanceof Error ? error.message : String(error));
          throw error;
        },
      );
    queues.set(request.chatId, operation);
    void operation
      .finally(() => {
        if (queues.get(request.chatId) === operation) queues.delete(request.chatId);
      })
      .catch(() => {});
    return operation;
  }
  async function inspect(request: CoordinatorWorkspaceRequest): Promise<CoordinatorWorkspaceView> {
    const binding = await read(request.chatId);
    try {
      current(request, binding);
      const blocker = blockers.get(request.chatId);
      if (blocker) throw new Error(blocker);
      if (!binding) return { ...request, status: "unallocated" };
      if (binding.ready) return binding.ready;
      const receipt = (await workspaceReceipts(input.root())).find((item) => item.intentId === binding.intent.id);
      return {
        ...request,
        status: "unavailable",
        reason: receipt?.reason ?? `Coordinator workspace ${receipt?.state ?? "preparation"} requires owned validation before execution`,
      };
    } catch (error) {
      return { ...request, status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  function close(): Promise<void> {
    closed = true;
    shutdown.abort(new Error("Coordinator workspaces are closed"));
    return (closing ??= (async () => {
      await Promise.allSettled([...queues.values()]);
      const results = await Promise.allSettled([...attachments.values()].map((attachment) => attachment.detach()));
      attachments.clear();
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length) throw new AggregateError(errors, "Coordinator workspace detach failed");
    })());
  }
  return { ensure, inspect, close };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function uuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function ownerHead(checkout: string): Promise<string> {
  const result = await command(cli.git(), ["rev-parse", "HEAD"], checkout);
  if (result.code || !/^[a-f0-9]{40,64}$/.test(result.stdout.trim())) throw new Error("Git owner HEAD is unreadable");
  return result.stdout.trim();
}
