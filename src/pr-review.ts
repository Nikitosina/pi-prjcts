import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PrFile, PrIteration, PrRange, PrReviewSource } from "./plugin-types.ts";
import type { Project, Request } from "./state.ts";
type Input = Extract<Request, { action: `pr-review-${string}` }>;
type History = { iterations: PrIteration[]; observed?: string[]; seenAt?: number; previous: string | null; marks: Record<string, string> };
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
export async function reviewRead(root: Conversation, p: Project, source: PrReviewSource, i: Input) {
  const started = performance.timeOrigin + performance.now(),
    docKey = keyOf(i.provider, i.pr, await source.authorize(p));
  const history = <T>(fn: (h: History) => T) =>
    root.commit(async (tx) => {
      const doc = await tx.doc(Review, root.id);
      doc.prs[docKey] ??= empty();
      return fn(doc.prs[docKey]!);
    }, BACKGROUND_CONTEXT);
  if (i.action === "pr-review-open") {
    const snapshot = await source.snapshot(p, i.pr, await history((h) => [...(h.observed ?? [])]));
    if (JSON.stringify(snapshot).length > 512000) throw Error("Review snapshot exceeds the display limit");
    const stored = await history((h) => {
      const byHead = new Map(h.iterations.map((x) => [x.head, x]));
      for (const it of snapshot.iterations) {
        const prior = byHead.get(it.head);
        byHead.set(it.head, { ...prior, ...it });
      }
      const iterations = Array.from(byHead.values()).slice(-100);
      const previous = h.previous;
      h.iterations = iterations;
      if (i.seen && started > (h.seenAt ?? 0)) {
        h.previous = snapshot.head;
        h.seenAt = started;
      }
      return { previous, iterations: JSON.parse(JSON.stringify(iterations)) as PrIteration[] };
    });
    return { ...snapshot, ...stored, capabilities: source.capabilities };
  }
  const h = await history((h) => JSON.parse(JSON.stringify(h)) as History);
  const iteration = (head: string) => {
    const it = h.iterations.find((x) => x.head === head);
    if (!it) throw Error("Unknown PR iteration. Open the review first.");
    return it;
  };
  const head = iteration(i.head),
    since = i.since ? iteration(i.since) : null,
    baseMoved = !!since && since.base !== head.base;
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
    return { baseMoved, files: files.filter(inScope).map((f) => ({ ...f, viewed: h.marks[`:${f.path}`] === f.blob })) };
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
  if (i.action === "pr-review-file")
    return { diff: await diffs(cacheKey("diff", range, file.path), () => source.fileDiff(p, i.pr, file.path, range)) };
  return {
    lines: await contexts(cacheKey("lines", i.head, file.path, i.from, i.count), () =>
      source.fileLines(p, i.pr, file.path, i.head, i.from, i.count),
    ),
  };
}
