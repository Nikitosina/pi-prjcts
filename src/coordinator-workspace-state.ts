import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import type { WorkspaceIntent } from "./workspace-types.ts";

export type CoordinatorWorkspaceRequest = { chatId: string; conversationId: number };
export type CoordinatorWorkspaceReady = CoordinatorWorkspaceRequest & {
  status: "ready";
  cwd: string;
  provider: string;
  branch: string;
  scope: string;
  threadId: string;
  intentId: string;
};
export type CoordinatorWorkspaceView =
  | CoordinatorWorkspaceReady
  | (CoordinatorWorkspaceRequest & { status: "unallocated" })
  | (CoordinatorWorkspaceRequest & { status: "unavailable"; reason: string });
export type CoordinatorWorkspaceBinding = CoordinatorWorkspaceRequest & {
  threadId: string;
  scope: string;
  grant: string;
  scopeId: string;
  intent: WorkspaceIntent;
  ready: CoordinatorWorkspaceReady | null;
};
export const CoordinatorWorkspaceBindings = defineDoc<{ chats: Record<string, CoordinatorWorkspaceBinding> }>({
  kind: "projects.coordinator-workspaces",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ chats: {} }),
});

/** Cleanup consults ownership before any worker/provider probes, even for archived chats. */
export async function coordinatorWorkspaceOwners(root: Conversation): Promise<Map<string, { chatId: string; threadId: string }>> {
  return root.commit(
    async (tx) =>
      new Map(
        Object.values((await tx.doc(CoordinatorWorkspaceBindings, root.id)).chats).map((binding) => [
          binding.intent.id,
          { chatId: binding.chatId, threadId: binding.threadId },
        ]),
      ),
    BACKGROUND_CONTEXT,
  );
}
