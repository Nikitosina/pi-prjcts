import { Type, type Static } from "typebox";
import { Id, OperationSpec, Role } from "./state.ts";

export const NativePlan = Type.Object({
  paused: Type.Boolean(), pausing: Type.Boolean(), workerCap: Type.Union([Type.Integer(), Type.Null()]),
  work: Type.Array(Type.Object({
    id: Id, threadId: Id, role: Role, text: Type.String(), dependsOn: Type.Array(Id),
    status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("blocked"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("interrupted"), Type.Literal("stopped")]),
    blocker: Type.Union([Type.String(), Type.Null()]),
    attempt: Type.Union([Type.Null(), Type.Object({ id: Id, model: Type.String(), cwd: Type.String(), toolNames: Type.Array(Type.String()) })]),
  })),
});
export type NativePlan = Static<typeof NativePlan>;
export type NativeWork = NativePlan["work"][number];

export const NativeHistory = Type.Object({
  kind: Type.Literal("thread"), threadId: Id, conversationId: Type.Integer(),
  items: Type.Array(Type.Object({
    id: Type.Integer(), role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), at: Type.Number(), text: Type.String(),
    textOffset: Type.Integer(), nextTextOffset: Type.Union([Type.Integer(), Type.Null()]), totalTextCharacters: Type.Integer(),
  })),
  offset: Type.Integer(), total: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), observedAtMs: Type.Number(),
});
export type NativeHistory = Static<typeof NativeHistory>;

const operationIdentity = {
  id: Id, projectId: Id, operation: OperationSpec, bindingRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), createdAt: Type.Number(), scopeCurrent: Type.Boolean(),
};
export const NativeOperations = Type.Object({
  items: Type.Array(Type.Union([
    Type.Object({ ...operationIdentity, status: Type.Literal("pending") }),
    Type.Object({ ...operationIdentity, status: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]), decidedAt: Type.Number(), owner: Type.String(), executionApproved: Type.Optional(Type.Literal(true)) }),
  ])),
  offset: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), total: Type.Integer(),
});
export type NativeOperations = Static<typeof NativeOperations>;
export type NativeOperation = NativeOperations["items"][number];

const counter = Type.Number({ minimum: 0 });
const NativeUsageCounters = Type.Object({
  input: counter, output: counter, cacheRead: counter, cacheWrite: counter, totalTokens: counter,
  reasoning: Type.Optional(counter), cacheWrite1h: Type.Optional(counter),
  cost: Type.Object({ input: counter, output: counter, cacheRead: counter, cacheWrite: counter, total: counter }),
});
const usageBuckets = { conversationId: Type.Integer({ minimum: 1 }), models: Type.Record(Type.String(), NativeUsageCounters), tools: Type.Record(Type.String(), NativeUsageCounters), total: NativeUsageCounters };
export const NativeUsage = Type.Object({
  coordinator: Type.Object(usageBuckets),
  chats: Type.Optional(Type.Array(Type.Object({ ...usageBuckets, chatId: Type.String(), title: Type.String(), archived: Type.Boolean() }))), chatTotal: Type.Optional(NativeUsageCounters),
  workers: Type.Array(Type.Union([
    Type.Object({ ...usageBuckets, kind: Type.Literal("thread"), threadId: Id, legacyNames: Type.Array(Type.String()) }),
    Type.Object({ ...usageBuckets, kind: Type.Literal("legacy"), name: Type.String(), legacyNames: Type.Array(Type.String()) }),
  ])),
  workerPageTotal: NativeUsageCounters, totalWorkers: Type.Integer({ minimum: 0 }), totalThreads: Type.Integer({ minimum: 0 }), legacyOnlyWorkers: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), observedAtMs: Type.Number(), accounting: Type.String(),
});
export type NativeUsage = Static<typeof NativeUsage>;

