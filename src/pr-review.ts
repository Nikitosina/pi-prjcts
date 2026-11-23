import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PrFile, PrIteration, PrRange, PrReviewSource } from "./plugin-types.ts";
import type { Project, Request } from "./state.ts";
type Input = Extract<Request, { action: `pr-review-${string}` }>;
type History = { iterations: PrIteration[]; previous: string | null; marks: Record<string, string> };
const Review = defineDoc<{ prs: Record<string, History> }>({
  kind: "projects.pr-review",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ prs: {} }),
});
const cache = new Map<string, string>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const value = await load(),
    s = JSON.stringify(value);
  if (s.length > 512000) throw Error("Review data exceeds the display limit");
  if (cache.size >= 40) cache.delete(cache.keys().next().value!);
  cache.set(key, s);
  return value;
}
export async function reviewRead(root: Conversation, p: Project, source: PrReviewSource, i: Input) {
  const key = `${i.provider}:${i.pr}`,
    docKey = `${key}:${p.githubAuthorization?.[0]?.repositoryId ?? p.cwd}`;
  const history = <T>(fn: (h: History) => T) =>
    root.commit(async (tx) => {
      const doc = await tx.doc(Review, root.id);
      doc.prs[docKey] ??= { iterations: [], previous: null, marks: {} };
      return fn(doc.prs[docKey]!);
    }, BACKGROUND_CONTEXT);
  if (i.action === "pr-review-open") {
    const snapshot = await source.snapshot(p, i.pr);
    if (JSON.stringify(snapshot).length > 512000) throw Error("Review snapshot exceeds the display limit");
    const stored = await history((h) => {
      const iterations = Array.from(new Map([...h.iterations, ...snapshot.iterations].map((x) => [x.head, x])).values()).slice(-100);
      const previous = h.previous;
      h.iterations = iterations;
      if (i.seen) h.previous = snapshot.head;
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
  const list = (r: PrRange) => cached<PrFile[]>(cacheKey("files", r.base, r.head), () => source.files(p, i.pr, r));
  let files = await list(range);
  if (since && !baseMoved) {
    const paths = new Set(
      (await Promise.all([list({ base: head.base, head: head.head }), list({ base: since.base, head: since.head })]))
        .flat()
        .map((f) => f.path),
    );
    files = files.filter((f) => paths.has(f.path));
  }
  if (i.action === "pr-review-files") return { baseMoved, files: files.map((f) => ({ ...f, viewed: h.marks[`:${f.path}`] === f.blob })) };
  const file = files.find((f) => f.path === i.path);
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
    return { diff: await cached(cacheKey("diff", range, file.path), () => source.fileDiff(p, i.pr, file.path, range)) };
  return {
    lines: await cached(cacheKey("lines", i.head, file.path, i.from, i.count), () =>
      source.fileLines(p, i.pr, file.path, i.head, i.from, i.count),
    ),
  };
}
