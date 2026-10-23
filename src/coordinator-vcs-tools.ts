import { defineExtension, defineTool, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Id } from "./state.ts";
import type { vcsOperations } from "./vcs-operations.ts";

const Target = { scopeId: Id, action: Type.Union([Type.Literal("worktree-remove"), Type.Literal("worktree-remount"), Type.Literal("branch-delete")]), target: Type.String({ minLength: 1, maxLength: 4096 }) };
const Identity = { operationId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) };
export function coordinatorVcsTools(input: { runtime: () => ReturnType<typeof vcsOperations> | undefined; projectId: string; isCoordinator(id: Conversation["id"]): boolean }) {
  const authorize = (api: ToolExecutionApi) => {
    const runtime = input.runtime();
    if (!runtime || !input.isCoordinator(api.conversationId)) throw new Error("VCS operations are coordinator-only");
    return runtime;
  };
  const tool = defineTool({
    name: "projects_vcs_operation", description: "Preview/request an exact VCS operation, execute after owner executable approval, or inspect its receipt without replay. worktree-remove and worktree-remount accept one absolute host worktree path; branch-delete accepts a local Git branch. worktree-remount restores a registered provider mount for inspection, not removal. Requires a whole-repository scope and all workers settled. Dirty/local-only/unknown work and default branches stay protected. Requests do not execute: a request creates an exact approval in the owner's inbox that chat answers cannot grant, so end the turn while it is pending, then execute with its operationId and fingerprint. For an unmounted Arc worktree request worktree-remount first, inspect local changes and unpublished commits, then request a separate worktree-remove (remount approval never authorizes removal). Reuse requestId only for identical intent; changed state needs fresh approval. Hard resets, cleaning, arbitrary shell and publication stay unavailable.",
    parameters: Type.Union([
      Type.Object({ method: Type.Literal("preview"), ...Target }, { additionalProperties: false }),
      Type.Object({ method: Type.Literal("request"), requestId: Id, ...Target }, { additionalProperties: false }),
      Type.Object({ method: Type.Literal("execute"), ...Identity }, { additionalProperties: false }),
      Type.Object({ method: Type.Literal("inspect"), ...Identity }, { additionalProperties: false }),
    ]), replay: "unsafe",
    async execute(args, api) {
      const runtime = authorize(api);
      const identity = "operationId" in args ? { id: input.projectId, operationId: args.operationId, fingerprint: args.fingerprint, confirm: input.projectId } : null;
      let value: unknown;
      switch (args.method) {
        case "preview": value = await runtime.preview(args); break;
        case "request": value = await runtime.request(args); break;
        case "execute": if (!identity) throw new Error("Missing operation identity"); value = await runtime.execute(identity); break;
        case "inspect": if (!identity) throw new Error("Missing operation identity"); value = await runtime.inspect(identity); break;
        default: { const exhaustive: never = args; throw new Error(`Unknown VCS method: ${exhaustive}`); }
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  });
  return { tools: [tool], extension: defineExtension({ name: "projects.coordinator-vcs-operations", tools: [tool] }) };
}
