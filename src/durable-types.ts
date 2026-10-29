import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentRole } from "./jobs.ts";
import type { DurableStanding } from "./durable-standing.ts";

export type DurableRole = AgentRole;

/** Actual ModelRuntime stream lifecycle. traceId is locally generated and deliberately has no Durable thread/conversation meaning. */
export type DurableGenerationLifecycle = Readonly<{
  phase: "started" | "ended";
  projectId: string;
  traceId: string;
  model: string;
  at: number;
  outcome?: "completed" | "failed" | "aborted";
}>;
export type DurableGenerationLifecycleObserver = (event: DurableGenerationLifecycle) => void;

/** Host-only result used to configure one allocated scoped worker conversation. */
export type DurablePreparedWorkerEnvironment = Readonly<{
  cwd: string;
  tools: readonly ToolRegistration[];
  extension: Extension;
  bindingRevision: string;
  repositoryStanding?: DurableStanding;
  workerInstructions?: string;
}>;
