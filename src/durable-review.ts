import { defineDoc, defineExtension, defineTool, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { DurablePlanning } from "./durable-planning.ts";

/** A reviewer thread's verdict on one exact PR head. Auto-merge needs an `approve` for the head it merges. */
export type ReviewVerdict = { repositoryId: string; pullRequest: number; sha: string; verdict: "approve" | "request_changes"; summary: string; threadId: string; at: number };
const Verdicts = defineDoc<{ items: ReviewVerdict[] }>({ kind: "projects.review-verdicts", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });

/** Newest verdict for this PR head, or null. */
export async function reviewVerdict(root: Conversation, repositoryId: string, pullRequest: number, sha: string): Promise<ReviewVerdict | null> {
  return root.commit(async tx => { const found = (await tx.doc(Verdicts, root.id)).items.findLast(item => item.repositoryId === repositoryId && item.pullRequest === pullRequest && item.sha === sha); return found ? { ...found } : null; }, BACKGROUND_CONTEXT);
}

/** `projects_review_verdict`, offered to reviewer threads only; the call is refused from any other thread or a coordinator. */
export function reviewVerdictTools(options: { planRoot: () => ConversationId | undefined; repositories: () => string[]; onVerdict?: () => void }) {
  const tool = defineTool({ name: "projects_review_verdict", description: "Record your review verdict on one exact PR head. Auto-merge (when the owner enabled it) merges a project PR only with an approve for its current head SHA and green CI; a new push needs a new review. Use request_changes when anything is wrong or unverified. repository is optional when the project authorizes exactly one.", parameters: Type.Object({ repository: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), pullRequest: Type.Integer({ minimum: 1 }), headSha: Type.String({ pattern: "^[a-f0-9]{40}$" }), verdict: Type.Union([Type.Literal("approve"), Type.Literal("request_changes")]), summary: Type.String({ minLength: 1, maxLength: 4000 }) }), replay: "unsafe", async execute(args, api, context) {
    const root = options.planRoot(), repos = options.repositories();
    if (root === undefined) throw new Error("Project plan is unavailable");
    const repositoryId = args.repository ?? (repos.length === 1 ? repos[0] : undefined);
    if (!repositoryId || !repos.includes(repositoryId)) throw new Error(`Repository must be one this project authorizes: ${repos.join(", ") || "none"}`);
    const recorded = await api.commit(async tx => {
      const plan = await tx.doc(DurablePlanning, root);
      const threadId = Object.entries(plan.threads).find(([, thread]) => Number(thread.conversationId) === Number(api.conversationId))?.[0];
      const role = threadId ? Object.values(plan.work).findLast(work => work.threadId === threadId)?.role : undefined;
      if (!threadId || role !== "reviewer") throw new Error("Only reviewer threads can record a review verdict");
      const doc = await tx.doc(Verdicts, root), item: ReviewVerdict = { repositoryId, pullRequest: args.pullRequest, sha: args.headSha, verdict: args.verdict, summary: args.summary, threadId, at: Date.now() };
      doc.items.push(item);
      if (doc.items.length > 500) doc.items.splice(0, doc.items.length - 500);
      return item;
    }, context);
    options.onVerdict?.();
    return { content: [{ type: "text", text: JSON.stringify({ recorded: true, ...recorded, note: recorded.verdict === "approve" ? "Approval applies to this head only." : "Auto-merge will not merge this head." }) }] };
  } });
  return { tools: [tool], extension: defineExtension({ name: "projects.review-verdicts", tools: [tool] }) };
}
