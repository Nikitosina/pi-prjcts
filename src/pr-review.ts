import { randomUUID } from "node:crypto";
import { publishReview, checkedReview } from "./pr-review-publish.ts";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PrFile, PrIteration, PrRange, PrReviewSource } from "./plugin-types.ts";
import type { Project, Request } from "./state.ts";
import { addDraft, changeDraft, draftView, sendDrafts, type DraftBook, type ReviewDelivery } from "./pr-review-drafts.ts";
type Input = Extract<Request, { action: `pr-review-${string}` }>;
type History = DraftBook & {
  iterations: PrIteration[];
  observed?: string[];
  seenAt?: number;
  previous: string | null;
  marks: Record<string, string>;
};
const Review = defineDoc<{ prs: Record<string, History> }>({
  kind: "projects.pr-review",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ prs: {} }),
});
const empty = (): History => ({ iterations: [], previous: null, marks: {} });
const keyOf = (provider: string, id: string, repo: string) => JSON.stringify([provider, id, repo]);
export async function recordReviewHeads(root: Conversation, repo: string, heads: { id: string; head: string }[]) {
  if (!heads.length) return;
  await root.commit(async (tx) => {
    const d = await tx.doc(Review, root.id);
    for (const { id, head } of heads) {
      const key = keyOf("github", id, repo);
      const h = (d.prs[key] ??= empty());
      h.observed = [...new Set([...(h.observed ?? []), head])].slice(-32);
    }
  }, BACKGROUND_CONTEXT);
}
const indexes = new WeakMap<PrFile[], Map<string, PrFile>>();
function cache<T>() {
  const entries = new Map<string, T>();
  return async (key: string, load: () => Promise<T>) => {
    const hit = entries.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    if (JSON.stringify(value).length > 512000) throw Error("Review data exceeds the display limit");
    if (entries.size >= 40) entries.delete(entries.keys().next().value!);
    entries.set(key, value);
    return value;
  };
}
const fileLists = cache<PrFile[]>(),
  diffs = cache<string>(),
  contexts = cache<string[]>();
export async function reviewRead(root: Conversation, p: Project, source: PrReviewSource, i: Input, delivery: ReviewDelivery) {
  const started = performance.timeOrigin + performance.now(),
    docKey = keyOf(i.provider, i.pr, await source.authorize(p));
  const history = <T>(fn: (h: History) => T) =>
    root.commit(async (tx) => {
      const doc = await tx.doc(Review, root.id);
      doc.prs[docKey] ??= empty();
      return fn(doc.prs[docKey]!);
    }, BACKGROUND_CONTEXT);
  if (i.action === "pr-review-publish") return publishReview(history, source, p, i);
  if (i.action === "pr-review-checked") return history((h) => checkedReview(h, i.revision, i.found));
  if (i.action === "pr-review-send") return sendDrafts(history, i, delivery);
  if (i.action === "pr-review-edit" || i.action === "pr-review-delete") return history((h) => changeDraft(h, i, delivery.chat));
  if (i.action === "pr-review-open") {
    let snapshot;
    try {
      snapshot = await source.snapshot(p, i.pr, await history((h) => [...(h.observed ?? [])]));
    } catch (err) {
      const fallback = await history(
        (h) =>
          h.uncertain && {
            ...draftView(h, i.pr, delivery.chat),
            title: `PR #${i.pr}`,
            url: h.uncertain.url,
            head: h.uncertain.head,
            iterations: JSON.parse(JSON.stringify(h.iterations)) as PrIteration[],
            previous: h.previous,
            threads: [],
            capabilities: source.capabilities,
            notice: "Provider unavailable — thread updates could not be loaded.",
          },
      );
      if (fallback) return fallback;
      throw err;
    }
    if (
      !snapshot.iterations.some((it) => it.head === snapshot.head) ||
      !snapshot.iterations.every((it) => [it.head, it.base].every((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)))
    )
      throw Error("Provider returned invalid review iterations");
    if (JSON.stringify(snapshot).length > 512000) throw Error("Review snapshot exceeds the display limit");
    const stored = await history((h) => {
      h.revision ??= randomUUID();
      const byHead = new Map(h.iterations.map((x) => [x.head, x]));
      for (const it of snapshot.iterations) {
        const prior = byHead.get(it.head);
        byHead.set(it.head, { ...prior, ...it, base: prior?.base ?? it.base });
      }
      const iterations = Array.from(byHead.values()).slice(-100);
      const previous = h.previous;
      h.iterations = iterations;
      if (i.seen && started > (h.seenAt ?? 0)) {
        h.previous = snapshot.head;
        h.seenAt = started;
      }
      return { ...draftView(h, i.pr, delivery.chat), previous, iterations: JSON.parse(JSON.stringify(iterations)) as PrIteration[] };
    });
    return { ...snapshot, ...stored, capabilities: source.capabilities };
  }
  const { head, since, marks } = await history((h) => {
    const iteration = (sha: string) => {
      const it = h.iterations.find((x) => x.head === sha);
      if (!it) throw Error("Unknown PR iteration. Open the review first.");
      return { head: it.head, base: it.base };
    };
    return {
      head: iteration(i.head),
      since: i.since ? iteration(i.since) : null,
      marks: i.action === "pr-review-files" ? { ...h.marks } : {},
    };
  });
  const baseMoved = !!since && since.base !== head.base;
  const range = { base: since && !baseMoved ? since.head : head.base, head: head.head };
  const cacheKey = (...parts: unknown[]) => JSON.stringify([p.id, docKey, ...parts]);
  const list = (r: PrRange) => fileLists(cacheKey("files", r.base, r.head), () => source.files(p, i.pr, r));
  const files = await list(range);
  const find = (list: PrFile[], path: string) => {
    let byPath = indexes.get(list);
    if (!byPath) {
      byPath = new Map(list.map((f) => [f.path, f]));
      indexes.set(list, byPath);
    }
    return byPath.get(path);
  };
  const scoped = since && !baseMoved ? await Promise.all([list(head), list(since)]) : null;
  const inScope = (f: PrFile) => !scoped || scoped.some((list) => find(list, f.path));
  if (i.action === "pr-review-files")
    return { baseMoved, files: files.filter(inScope).map((f) => ({ ...f, viewed: marks[`:${f.path}`] === f.blob })) };
  const entry = find(files, i.path),
    file = entry && inScope(entry) ? entry : null;
  if (!file) throw Error("Not a changed PR file");
  if (i.action === "pr-review-viewed") {
    await history((h) => {
      if (i.viewed) h.marks[`:${file.path}`] = file.blob;
      else delete h.marks[`:${file.path}`];
    });
    return { viewed: i.viewed };
  }
  if (baseMoved) throw Error("Base moved; compare the file list instead");
  if (i.action === "pr-review-add") {
    const count = i.to - i.from + 1;
    if (count < 1 || count > 100) throw Error("Choose between 1 and 100 lines");
    const lines = await source.fileLines(p, i.pr, file.path, i.side === "LEFT" ? range.base : range.head, i.from, count);
    if (lines.length !== count) throw Error("Line range no longer exists");
    return history((h) => addDraft(h, i, lines.join("\n"), file.blob, delivery.chat));
  }
  if (i.action === "pr-review-file")
    return { diff: await diffs(cacheKey("diff", range, file.path), () => source.fileDiff(p, i.pr, file.path, range)) };
  return {
    lines: await contexts(cacheKey("lines", i.head, file.path, i.from, i.count), () =>
      source.fileLines(p, i.pr, file.path, i.head, i.from, i.count),
    ),
  };
}
