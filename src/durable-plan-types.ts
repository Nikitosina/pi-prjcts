import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { DurableStanding } from "./durable-standing.ts";

export type DurableRole = "worker" | "scout" | "reviewer";
export type DurableThreadStatus = "idle" | "running" | "blocked" | "stopped" | "interrupted" | "completed" | "failed";
export type DurablePlanWorkStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "interrupted" | "stopped";

/** A stable public work item. IDs are UUIDs and never Durable numeric IDs. */
export type DurablePlanWork = Readonly<{
  id: string;
  threadId: string;
  role: DurableRole;
  text: string;
  dependsOn?: readonly string[];
  requestId?: string;
  requiredTools?: readonly string[];
  /** Host-persisted workspace scope identifier; model input never carries raw provider/path/owner data. */
  workspaceScopeId?: string;
  /** Parent worker thread of a child (one level of nesting); the child's results go to that thread. */
  parentThreadId?: string;
  /** Scout/reviewer code root chosen by the host (PR-head snapshot or parent worktree); never model-supplied paths. */
  readRoot?: string;
  readSha?: string;
  /** Worker takeover (host-set): the thread whose worktree allocation this new thread inherits. */
  workspaceFrom?: string;
  /** Worker continuing an existing branch (host-resolved and authorized): its worktree starts on this branch at this tip. */
  continueBranch?: Readonly<{ name: string; sha: string }>;
}>;
export type DurablePlan = Readonly<{ id?: string; work: readonly DurablePlanWork[] }>;
/** Usage snapshots are Durable UsageDoc counters flattened by path, attributed to this project/thread/attempt/model. */
export type DurableUsageDelta = Readonly<{ baseline: Readonly<Record<string, number>>; final: Readonly<Record<string, number>>; delta: Readonly<Record<string, number>> }>;
export type DurableResolvedAttempt = Readonly<{
  id: string; projectId: string; threadId: string; role: DurableRole; model: string; thinking: "low" | "medium" | "high";
  instructions: string; cwd: string; toolNames: readonly string[]; bindingRevision: string; standingRevision: string;
  startedAt: number | null; endedAt: number | null; usage: DurableUsageDelta;
}>;
export type DurablePlanWorkSnapshot = Readonly<{
  id: string; threadId: string; role: DurableRole; text: string; dependsOn: readonly string[];
  status: DurablePlanWorkStatus; blocker: string | null; startedAt: number | null; endedAt: number | null; archived: boolean; /** Delegating chat conversation; null means Main. */ chatConversationId: number | null; /** Parent worker thread of a child thread; null for top-level work. */ parentThreadId: string | null; attempt: DurableResolvedAttempt | null; /** This item replaced superseded work through an explicit steer. */ steering?: boolean;
}>;
export type DurablePlanSnapshot = Readonly<{ paused: boolean; pausing: boolean; workerCap: number | null; work: readonly DurablePlanWorkSnapshot[] }>;

/** Actual ModelRuntime stream lifecycle. traceId is locally generated and deliberately has no Durable thread/conversation meaning. */
export type DurableGenerationLifecycle = Readonly<{ phase: "started" | "ended"; projectId: string; traceId: string; model: string; at: number; outcome?: "completed" | "failed" | "aborted" }>;
export type DurableGenerationLifecycleObserver = (event: DurableGenerationLifecycle) => void;

/** Explicit capability seam. Registry visibility never grants a worker a tool. */
/** Host-only result used to configure one allocated scoped worker conversation. */
export type DurablePreparedWorkerEnvironment = Readonly<{
  cwd: string;
  tools: readonly ToolRegistration[];
  extension: Extension;
  bindingRevision: string;
  repositoryStanding?: DurableStanding;
  workerInstructions?: string;
}>;
export type DurableWorkspaceInstructions = (role: DurableRole, standing: DurableStanding) => string;
export type DurablePrepareWorkerEnvironment = (input: Readonly<{ conversationId: number; workId: string; threadId: string; role: DurableRole; workspaceScopeId: string }>) => Promise<DurablePreparedWorkerEnvironment>;
/** Host-only publication of a prepared extension. It is invoked by planning only after its post-preparation authorization recheck. */
export type DurablePublishWorkerEnvironment = (extension: Extension) => void;

export type DurableWorkerToolBindings = Readonly<{ 
  /** Immutable capability-bundle identity supplied by the host/capability seam. */
  revision: string;
  tools: readonly ToolRegistration[];
}>;
