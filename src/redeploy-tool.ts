import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { awaitDeploy, DEPLOY_WINDOW_MS, readDeployState } from "./deploy.ts";

export const REDEPLOY_TOOL = "projects_redeploy";

/**
 * Redeploy the host and wait for the outcome. The stop cuts this call off too; it is replay-safe, so after the start it runs
 * again under the same task, finds its request and returns the result instead of starting a second deploy.
 */
export function redeployTool(input: {
  /** Distinguishes callers whose task ids come from different storages (a project, the Host agent). */
  scope: string;
  start(requestId: string, taskId: string): void;
}): ToolRegistration {
  return defineTool({
    name: REDEPLOY_TOOL,
    description: `Deploy the pi-prjcts host from the commit its checkout is at, and wait for the outcome. The owner allowed this without approval. Merge and pull the change into the host's checkout first: a dirty checkout or a failed npm run check refuses before anything stops. The host then stops: running tool calls get ${DEPLOY_WINDOW_MS / 1000} s to finish, later ones are cut off, and every agent continues after the start. This call returns after the restart with the deployed commit, or the failure and whether it rolled back.`,
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const requestId = `${input.scope}:${api.conversationId}:${api.taskId}`,
        state = readDeployState();
      if (state.current?.requestId !== requestId && state.lastResult?.requestId !== requestId) input.start(requestId, String(api.taskId));
      return { output: [{ type: "text" as const, text: await awaitDeploy(requestId, context.abortSignal) }] };
    },
  }) as ToolRegistration;
}
