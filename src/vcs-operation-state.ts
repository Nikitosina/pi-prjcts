import { defineDoc, type Conversation, type Tx } from "@earendil-works/pi-durable";

export type VcsExecution = { operationId: string; fingerprint: string } & ({ state: "uncertain" } | { state: "done" | "failed"; result: string });
export const VcsExecutions = defineDoc<{ items: VcsExecution[] }>({
  kind: "projects.vcs-operations", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }),
});
export async function hasUncertainVcsOperations(tx: Tx, root: Conversation["id"]): Promise<boolean> {
  return (await tx.doc(VcsExecutions, root)).items.some(item => item.state === "uncertain");
}
