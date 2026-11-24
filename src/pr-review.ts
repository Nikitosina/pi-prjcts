import { randomUUID } from "node:crypto";
import { publishReview, checkedReview } from "./pr-review-publish.ts";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PrFile, PrIteration, PrRange, PrReviewSnapshot, PrReviewSource } from "./plugin-types.ts";
import type { Project, Request } from "./state.ts";
import { addDraft, changeDraft, draftView, sendDrafts, type DraftBook, type ReviewDelivery } from "./pr-review-drafts.ts";
import { requestText, tourView, validateMap, type MapBook, type MapRequest } from "./review-map.ts";
import type { Agent } from "./jobs.ts";
type Input = Extract<Request, { action: `pr-review-${string}` }>;
type History = DraftBook &
  MapBook & {
    iterations: PrIteration[];
    observed?: string[];
    liveRange?: PrRange;
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
export async function finishReviewMap(
  root: Conversation,
  p: Project,
  agent: Agent,
  report: string,
  sourceFor: (key: string) => PrReviewSource | undefined,
) {
  const pending = await root.commit(async (tx) => {
    const doc = await tx.doc(Review, root.id);
    for (const [key, h] of Object.entries(doc.prs)) {
      if (h.request && h.request.id === agent.mapRequestId && h.request.chat === Number(agent.chat))
        return { key, req: { ...h.request, range: { ...h.request.range } } };
    }
    return null;
  }, BACKGROUND_CONTEXT);
  if (!pending) return "No pending tour request for this scout.";
  const { key, req } = pending;
  let map, error: string | undefined;
  try {
    const source = sourceFor(req.provider);
    if (!source || keyOf(req.provider, req.pr, await source.authorize(p)) !== key) throw Error("Review source changed");
    if (
      !agent.prepared ||
      agent.readRef !== req.range.head ||
      agent.reads?.[0]?.state !== "read" ||
      !report.startsWith(`[scout ${agent.id} answered:`)
    )
      throw Error("Scout did not answer at the requested head: " + report.split("\n")[0]?.slice(0, 200));
    map = await validateMap(report.slice(report.indexOf("\n") + 1), req, await source.files(p, req.pr, req.range), (path) =>
      source.fileDiff(p, req.pr, path, req.range),
    );
  } catch (e) {
    error = String(e).slice(0, 1000);
  }
  const result = map;
  await root.commit(async (tx) => {
    const h = (await tx.doc(Review, root.id)).prs[key];
    if (h?.request?.id !== req.id) return;
    if (result) h.map = result;
    if (error) h.mapError = error;
    delete h.request;
  }, BACKGROUND_CONTEXT);
  return `[scout ${agent.id} ${error ? "failed" : "answered"}: Guided tour]\n${error ?? "Stored review map at " + req.range.head}`;
}
export async function reviewRead(root: Conversation, p: Project, source: PrReviewSource, i: Input, delivery: ReviewDelivery) {
  const started = performance.timeOrigin + performance.now(),
    docKey = keyOf(i.provider, i.pr, await source.authorize(p));
  const history = <T>(fn: (h: History) => T) =>
    root.commit(async (tx) => {
      const doc = await tx.doc(Review, root.id);
      doc.prs[docKey] ??= empty();
      return fn(doc.prs[docKey]!);
    }, BACKGROUND_CONTEXT);
  if (i.action === "pr-review-tour-status") return history(tourView);
  if (i.action === "pr-review-tour") {
    const route = delivery.route;
    if (!route) throw Error("No tour destination");
    const snap = await source.snapshot(p, i.pr, []),
      range = snap.iterations.find((it) => it.head === i.head);
    if (snap.head !== i.head || !range || (i.base && range.base !== i.base)) throw Error("PR range changed. Reopen the room.");
    const files = await source.files(p, i.pr, range);
    if (!files.length || files.length > 500) throw Error("Tour requires 1–500 changed files");
    const req: MapRequest = {
      id: "tour:" + randomUUID(),
      pr: i.pr,
      provider: i.provider,
      range: { base: range.base, head: range.head },
      chat: route.chat,
      at: Date.now(),
      ours: route.ready !== null,
    };
    const text = requestText(req, (route.ready ?? snap.description ?? "").slice(0, 16000), files);
    if (text.length > 64000) throw Error("Tour brief exceeds size limit");
    const send = await history((h) => {
      if (tourView(h).building || (h.map?.head === i.head && h.map.base === range.base && !h.mapError)) return false;
      h.request = req;
      delete h.mapError;
      return true;
    });
    if (send)
      try {
        await route.send(text, req.id);
      } catch (e) {
        await history((h) => {
          if (h.request?.id === req.id) {
            delete h.request;
            h.mapError = String(e).slice(0, 1000);
          }
        });
        throw e;
      }
    return history(tourView);
  }
  if (i.action === "pr-review-publish") return publishReview(history, source, p, i);
  if (i.action === "pr-review-checked") return history((h) => checkedReview(h, i.revision, i.found));
  if (i.action === "pr-review-send") return sendDrafts(history, i, delivery);
  if (i.action === "pr-review-edit" || i.action === "pr-review-delete") return history((h) => changeDraft(h, i, delivery.chat));
  if (i.action === "pr-review-open") {
    let snapshot: PrReviewSnapshot;
    try {
      snapshot = await source.snapshot(p, i.pr, await history((h) => [...(h.observed ?? [])]));
      if (
        !snapshot.iterations.some((it) => it.head === snapshot.head) ||
        !snapshot.iterations.every((it) => [it.head, it.base].every((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)))
      )
        throw Error("Provider returned invalid review iterations");
      if (JSON.stringify(snapshot).length > 512000) throw Error("Review snapshot exceeds the display limit");
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
    const stored = await history((h) => {
      h.revision ??= randomUUID();
      const byHead = new Map(h.iterations.map((x) => [x.head, x]));
      for (const it of snapshot.iterations) {
        const prior = byHead.get(it.head);
        byHead.set(it.head, { ...prior, ...it, base: prior?.base ?? it.base });
      }
      const iterations = Array.from(byHead.values()).slice(-100);
      const base = snapshot.iterations.find((it) => it.head === snapshot.head)!.base;
      h.liveRange = { head: snapshot.head, base };
      const previous = h.previous;
      h.iterations = iterations;
      if (i.seen && started > (h.seenAt ?? 0)) {
        h.previous = snapshot.head;
        h.seenAt = started;
      }
      return { ...draftView(h, i.pr, delivery.chat), base, previous, iterations: JSON.parse(JSON.stringify(iterations)) as PrIteration[] };
    });
    return { ...snapshot, ...stored, tour: await history(tourView), capabilities: source.capabilities };
  }
  const { head, since, marks } = await history((h) => {
    const iteration = (sha: string) => {
      const it = h.iterations.find((x) => x.head === sha);
      if (!it) throw Error("Unknown PR iteration. Open the review first.");
      if (i.base && sha === i.head && i.base !== it.base) {
        if (h.liveRange?.head !== sha || h.liveRange.base !== i.base) throw Error("Review base changed. Reopen the room.");
        return { head: sha, base: i.base };
      }
      return { head: it.head, base: it.base };
    };
    return {
      head: iteration(i.head),
      since: "since" in i && i.since ? iteration(i.since) : null,
      marks: i.action === "pr-review-files" ? { ...h.marks } : {},
    };
  });
  const baseMoved = !!since && since.base !== head.base;
  const range = { base: since && !baseMoved ? since.head : head.base, head: head.head };
  const cacheKey = (...parts: unknown[]) => JSON.stringify([p.id, docKey, ...parts]);
  const list = (r: PrRange) => fileLists(cacheKey("files", r.base, r.head), () => source.files(p, i.pr, r));
  const files = await list(range);
  if (i.action === "pr-review-approve-step")
    return history((h) => {
      if (h.map?.head !== i.mapHead || h.map.base !== i.mapBase) throw Error("Map changed. Reopen the tour.");
      const step = h.map.steps.find((s) => s.title === i.title);
      if (!step) throw Error("Unknown map step");
      const paths = new Set(step.files);
      for (const f of files) if (paths.has(f.path)) h.marks[":" + f.path] = f.blob;
      return { viewed: true };
    });
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
