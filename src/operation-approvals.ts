import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { loadProject, type OperationSpec, type Project, type Request } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";

type Proposal = Extract<Request, { action: "operation-request" }>;
type Decision = Extract<Request, { action: "operation-decide" }>;
type Inspection = Extract<Request, { action: "operation-snapshot" }>;
type OperationIdentity = {
  id: string; projectId: string; operation: OperationSpec;
  bindingRevision: string; fingerprint: string; createdAt: number;
};
export type OperationRecord = OperationIdentity & (
  { status: "pending" } |
  { status: "approved" | "rejected"; decidedAt: number; owner: string; executionApproved?: true }
);
const Records = defineDoc<{ items: OperationRecord[] }>({
  kind: "projects.operation-approvals", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ items: [] }),
});
const context = BACKGROUND_CONTEXT;

// Native document values can be proxies. Detach both object levels before leaving a commit.
function copy(record: OperationRecord): OperationRecord { return { ...record, operation: { ...record.operation } }; }

export function operationApprovals({ root, harness, project }: { root: Conversation; harness: Harness; project: Project }) {
  function owned(id: string): void {
    if (id !== project.id) throw new Error("Operation is not owned by this project");
  }
  function bind(operation: OperationSpec, target: Project = project): string {
    const grant = target.workspaceAuthorization;
    const repository = grant?.repositories.find(item => item.repositoryId === operation.repositoryId);
    const scope = grant?.scopes.find(item => item.id === operation.scopeId);
    if (!grant || grant.owner !== trustedOwner() || grant.provider !== operation.provider || repository?.provider !== operation.provider || !scope || scope.repositoryId !== operation.repositoryId) throw new Error("Operation requires the exact authorized provider, repository and workspace scope");
    if (operation.kind === "command") {
      const profile = target.commandProfiles?.find(item => item.id === operation.profileId);
      if (!profile?.enabled || profile.owner !== trustedOwner() || profile.revision !== operation.profileRevision || profile.provider !== operation.provider || profile.effect !== operation.effect || profile.repositoryId !== operation.repositoryId || !profile.scopeIds.includes(operation.scopeId) || profile.workspaceRevision !== authorizationFingerprint(target)) throw new Error("Command approval requires the exact enabled profile and scope revision");
      return createHash("sha256").update(JSON.stringify({ workspace: authorizationFingerprint(target), profile: profile.revision, thread: operation.threadId, receipt: operation.receiptId, allocation: operation.allocationAttemptId, request: operation.requestId })).digest("hex");
    }
    return authorizationFingerprint(target);
  }
  async function request(input: Proposal): Promise<OperationRecord> {
    owned(input.id);
    const bindingRevision = bind(input.operation);
    const source = input.operation;
    const operation: OperationSpec = source.kind === "command" ? {
      provider: source.provider, kind: source.kind, repositoryId: source.repositoryId, scopeId: source.scopeId, threadId: source.threadId,
      profileId: source.profileId, profileRevision: source.profileRevision, effect: source.effect, receiptId: source.receiptId, allocationAttemptId: source.allocationAttemptId, requestId: source.requestId,
    } : { provider: source.provider, kind: source.kind, repositoryId: source.repositoryId, scopeId: source.scopeId, pullRequest: source.pullRequest, expectedHead: source.expectedHead };
    const fingerprint = createHash("sha256").update(JSON.stringify({ id: input.requestId, projectId: project.id, bindingRevision, operation })).digest("hex");
    return root.commit(async tx => {
      const state = await tx.doc(Records, root.id);
      const prior = state.items.find(item => item.id === input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Operation request conflicts with prior intent");
        return copy(prior);
      }
      if (state.items.length >= 4096) throw new Error("Operation record limit reached; history is retained");
      const record: OperationRecord = { id: input.requestId, projectId: project.id, operation, bindingRevision, fingerprint, createdAt: Date.now(), status: "pending" };
      state.items.push(record);
      return copy(record);
    }, context);
  }
  async function decide(input: Decision): Promise<OperationRecord> {
    owned(input.id);
    if (input.decision === "approve" && input.confirm !== project.id) throw new Error("Operation approval requires confirmation matching project id");
    return root.commit(async tx => {
      const state = await tx.doc(Records, root.id);
      const index = state.items.findIndex(item => item.id === input.operationId && item.projectId === project.id);
      const record = state.items[index];
      if (!record) throw new Error("Operation is not owned by this project");
      if (record.fingerprint !== input.fingerprint) throw new Error("Operation fingerprint does not match");
      if (record.bindingRevision !== bind(record.operation)) throw new Error("Operation authorization changed; request a new intent");
      const status = input.decision === "approve" ? "approved" : "rejected";
      const executionApproved = input.decision === "approve" && input.execution === true;
      if (record.status !== "pending") {
        if (record.status !== status || (record.executionApproved === true) !== executionApproved) throw new Error("Operation decision already recorded");
        return copy(record);
      }
      const decided: OperationRecord = { ...record, status, decidedAt: Date.now(), owner: trustedOwner(), ...(executionApproved ? { executionApproved: true as const } : {}) };
      state.items[index] = decided;
      return copy(decided);
    }, context);
  }
  async function snapshot(input: Inspection) {
    owned(input.id);
    const state = await harness.snapshot(Records, root.id, context);
    const all = (state?.items ?? []).filter(item => input.status === undefined || item.status === input.status);
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    const end = Math.min(all.length, offset + limit);
    const current = loadProject(project.id);
    function scopeCurrent(item: OperationRecord) {
      try { return item.bindingRevision === bind(item.operation, current); }
      catch { return false; }
    }
    return { items: all.slice(offset, end).map(item => ({ ...copy(item), scopeCurrent: scopeCurrent(item) })), offset, nextOffset: end < all.length ? end : null, total: all.length };
  }
  async function approved(input: { id: string; operationId: string; fingerprint: string; confirm: string }) {
    owned(input.id);
    if (input.confirm !== project.id) throw new Error("Operation execution requires confirmation matching project id");
    const current = loadProject(project.id);
    if (current.deleted || current.archived) throw new Error("Inactive project cannot execute operations");
    return root.commit(async tx => {
      const record = (await tx.doc(Records, root.id)).items.find(item => item.id === input.operationId && item.projectId === project.id);
      if (!record || record.status !== "approved" || record.executionApproved !== true || record.owner !== trustedOwner() || record.fingerprint !== input.fingerprint) throw new Error("Operation requires the exact recorded owner approval");
      if (record.bindingRevision !== bind(record.operation, current)) throw new Error("Operation authorization changed; request a new intent");
      return copy(record);
    }, context);
  }
  return { request, decide, snapshot, approved };
}
export type OperationApprovals = ReturnType<typeof operationApprovals>;
