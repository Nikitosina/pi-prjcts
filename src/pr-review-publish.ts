import { randomUUID } from "node:crypto";
import type { PrPublish, PrReviewSource, PrIteration } from "./plugin-types.ts";
import type { Project, Request } from "./state.ts";
import type { DraftBook } from "./pr-review-drafts.ts";

const inFlight = new Set<string>();
export function checkedReview(h: DraftBook, revision: string) {
  if (inFlight.has(revision) || !h.uncertain || h.revision !== revision) throw Error("Review is still in progress or changed. Reopen it.");
  delete h.uncertain;
  h.revision = randomUUID();
  return { checked: true };
}
export async function publishReview(
  history: <T>(fn: (h: DraftBook & { iterations: PrIteration[] }) => T) => Promise<T>,
  source: PrReviewSource,
  p: Project,
  i: Extract<Request, { action: "pr-review-publish" }>,
) {
  const op = i.operation;
  if (!source.publish || !source.capabilities[op.kind === "review" ? "publish" : op.kind === "reply" ? "reply" : "resolve"])
    throw Error("Provider does not support this review action");
  const snapshot = await source.snapshot(p, i.pr, []);
  if (snapshot.head !== i.head) throw Error("PR head changed. Reopen the review.");
  if (op.kind !== "review" && !snapshot.threads.some((t) => t.id === op.threadId)) throw Error("Thread not found on this PR");
  if (
    (op.kind === "reply" && !op.body.trim()) ||
    (op.kind === "review" && !op.summary.trim() && (op.verdict === "REQUEST_CHANGES" || (op.verdict === "COMMENT" && !op.draftIds.length)))
  )
    throw Error("Enter a review message");
  const revision = randomUUID();
  inFlight.add(revision);
  try {
    const intent = await history((h): PrPublish => {
      if (h.uncertain) throw Error("Uncertain provider write. Check the PR first.");
      if (h.revision !== i.revision || h.sendingTo) throw Error("Drafts changed. Reopen the review.");
      const intent =
        op.kind === "review"
          ? {
              kind: op.kind,
              verdict: op.verdict,
              summary: op.summary,
              comments: op.draftIds.map((id) => {
                const d = h.drafts?.find((x) => x.id === id);
                if (!d || d.sent || d.published) throw Error("Draft is no longer pending");
                if (
                  d.head !== i.head ||
                  (d.side === "LEFT" &&
                    (d.since ?? h.iterations.find((x) => x.head === d.head)?.base) !==
                      snapshot.iterations.find((x) => x.head === d.head)?.base)
                )
                  throw Error("Outdated anchor. Drop the draft from the review.");
                return { head: d.head, path: d.path, side: d.side, from: d.from, to: d.to, body: d.comment };
              }),
            }
          : op;
      h.revision = revision;
      h.uncertain = {
        description: op.kind === "review" ? `${op.verdict} · ${op.draftIds.length} inline comments` : `${op.kind} · ${op.threadId}`,
        at: new Date().toISOString(),
      };
      return intent;
    });
    let url: string;
    try {
      ({ url } = await source.publish(p, i.pr, snapshot, intent));
      if (!/^https?:\/\//i.test(url)) throw Error("Missing provider receipt");
    } catch {
      return { uncertain: true };
    }
    return await history((h) => {
      if (h.revision !== revision) throw Error("Review changed during publish");
      if (op.kind === "review") for (const d of h.drafts ?? []) if (op.draftIds.includes(d.id)) d.published = url;
      delete h.uncertain;
      h.revision = randomUUID();
      return { url };
    });
  } finally {
    inFlight.delete(revision);
  }
}
