import { defineExtension, defineTool, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Id } from "./state.ts";
import type { vcsOperations } from "./vcs-operations.ts";

const Target = { scopeId: Id, action: Type.Union([Type.Literal("worktree-remove"), Type.Literal("worktree-remount"), Type.Literal("branch-delete")]), target: Type.String({ minLength: 1, maxLength: 4096 }) };
const Identity = { operationId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) };
export const VCS_OPERATIONS_NOTE = "\n\nVCS preparation and mount recovery use projects_vcs_operation, never a shell-policy bypass. Preview or request a named worktree-remove, worktree-remount or local Git branch-delete with scopeId and target. A request creates an exact approval in the owner's inbox; chat answers and plain consent cannot authorize execution. End the turn while approval is pending. After executable approval, execute using its operationId and fingerprint, or inspect its retained receipt. Changed state needs a new requestId and approval. All project workers must be settled. Host worker worktrees stay host-owned; this tool removes them without lease handoff or force and preserves dirty, local-only or unknown work. For an unmounted Arc worktree, request worktree-remount first. Only after its separate executable approval and successful remount, inspect actual local changes and unpublished commits before requesting worktree-remove. A fetched PR head does not prove an unmounted worktree has no local work. Remount approval never authorizes removal. Hard resets, cleaning, arbitrary shell commands and publication remain unavailable here.";
export function coordinatorVcsTools(input: { runtime: () => ReturnType<typeof vcsOperations> | undefined; projectId: string; isCoordinator(id: Conversation["id"]): boolean }) {
  const authorize = (api: ToolExecutionApi) => {
    const runtime = input.runtime();
    if (!runtime || !input.isCoordinator(api.conversationId)) throw new Error("VCS operations are coordinator-only");
    return runtime;
  };
  const tool = defineTool({
    name: "projects_vcs_operation", description: "Preview/request an exact VCS operation, execute after owner executable approval, or inspect its receipt without replay. worktree-remove and worktree-remount accept one absolute host worktree path; branch-delete accepts a local Git branch. worktree-remount restores a registered provider mount for inspection, not removal. Requires a whole-repository scope and all workers settled. Dirty/local-only/unknown work and default branches stay protected. Requests do not execute. Reuse requestId only for identical intent; changed state needs fresh approval. Never grants arbitrary shell or publication.",
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
