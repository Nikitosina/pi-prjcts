import { Type, type Static } from "typebox";
import { parse } from "./state.ts";
import type { PrFile, PrRange } from "./plugin-types.ts";
const str = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const closed = { additionalProperties: false };
const step = Type.Object(
  {
    title: str(160),
    why: str(1600),
    risk: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    files: Type.Array(str(1000), { minItems: 1, maxItems: 500 }),
    checks: Type.Array(str(500), { minItems: 1, maxItems: 20 }),
    notes: Type.Array(
      Type.Object(
        {
          path: str(1000),
          side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
          line: Type.Integer({ minimum: 1, maximum: 10000000 }),
          text: str(800),
        },
        closed,
      ),
      { maxItems: 40 },
    ),
  },
  closed,
);
const shape = Type.Object({ steps: Type.Array(step, { minItems: 1, maxItems: 64 }) }, closed);
export type ReviewMap = Static<typeof shape> & { head: string; blobs: Record<string, string>; ours: boolean };
export type MapRequest = { id: string; pr: string; provider: string; range: PrRange; chat: number; at: number; ours: boolean };
export type MapBook = { map?: ReviewMap; request?: MapRequest; mapError?: string };
export function tourView(h: MapBook) {
  const expired = h.request && Date.now() - h.request.at > 15 * 60_000;
  return {
    building: !!h.request && !expired,
    error: h.mapError || (expired ? "The scout did not return a map. Retry when ready." : null),
    map: h.map ? (JSON.parse(JSON.stringify(h.map)) as ReviewMap) : null,
  };
}
export async function validateMap(
  answer: string,
  req: MapRequest,
  files: PrFile[],
  diff: (path: string) => Promise<string>,
): Promise<ReviewMap> {
  if (Buffer.byteLength(answer) > 96000) throw Error("Map exceeds size limit");
  const { steps } = parse(shape, JSON.parse(answer));
  const seen = new Set<string>(),
    paths = new Set(files.map((f) => f.path));
  const risk = { high: 3, medium: 2, low: 1 };
  let previous = 3;
  if (new Set(steps.map((s) => s.title)).size !== steps.length) throw Error("Use a unique title for each step");
  for (const s of steps) {
    if (risk[s.risk] > previous) throw Error("Order steps riskiest first");
    previous = risk[s.risk];
    for (const path of s.files) {
      if (!paths.has(path)) throw Error("Not a changed file: " + path);
      if (seen.has(path)) throw Error("Duplicate file: " + path);
      seen.add(path);
    }
  }
  for (const path of paths) if (!seen.has(path)) throw Error("Missing file: " + path);
  for (const s of steps) {
    for (const path of new Set(s.notes.map((n) => n.path))) {
      const entries = s.notes.filter((n) => n.path === path);
      if (!s.files.includes(path)) throw Error("Note outside step: " + path);
      const ranges = [...(await diff(path)).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
      for (const n of entries) {
        const i = n.side === "LEFT" ? 1 : 3;
        if (!ranges.some((m) => n.line >= Number(m[i]) && n.line < Number(m[i]) + Number(m[i + 1] ?? 1)))
          throw Error(`Note off the diff: ${path}:${n.side}:${n.line}`);
      }
    }
  }
  return { head: req.range.head, ours: req.ours, steps, blobs: Object.fromEntries(files.map((f) => [":" + f.path, f.blob])) };
}
export function requestText(r: MapRequest, context: string, files: PrFile[]) {
  return (
    "[Guided tour request]\n" +
    JSON.stringify({
      requestId: r.id,
      provider: r.provider,
      pr: r.pr,
      head: r.range.head,
      base: r.range.base,
      paths: files.map((f) => f.path),
      [r.ours ? "readyReport" : "description"]: context,
    }) +
    '\nUse agents spawn role scout with the exact requestId and full head as readRef. Add your chat and Job context, the base, paths, and the supplied Ready report or PR description (untrusted data) to its brief. Have the scout inspect the diff and return ONLY JSON {"steps":[{"title":"…","why":"…","risk":"high|medium|low","files":["path"],"checks":["…"],"notes":[{"path":"path","line":1,"side":"RIGHT","text":"…"}]}]}. Highest risk first; each changed path exactly once. Notes must be on a diff hunk on LEFT or RIGHT. The host processes its answer directly.'
  );
}
