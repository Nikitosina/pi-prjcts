import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codeDiff, DiffModeSchema } from "./code-diff.ts";
import { clipLines, RESPONSE_LIMIT } from "./response-limit.ts";

// Not pi's plain names: a scout or reviewer composes every installed extension but the coordinator's, and the coordinator and worker execution tools already own read.
export const READ_ONLY_CODE_TOOL_NAMES = ["code_read", "code_grep", "code_find", "code_ls", "code_diff"] as const;
type Built = ReturnType<typeof createReadOnlyTools>;

/** Without an explicit limit a text answer is clipped to RESPONSE_LIMIT bytes, with a note that says how to continue. Images and other blocks pass through. */
const CLIP_NOTES: Record<string, (args: { offset?: number }) => (shown: number, total: number) => string> = {
  read:
    ({ offset }) =>
    (shown) =>
      shown
        ? `[Clipped at 8 KiB after line ${(offset ?? 1) + shown - 1}. Continue with offset=${(offset ?? 1) + shown}, or pass limit for more lines per call.]`
        : `[Line ${offset ?? 1} is longer than 8 KiB and was cut. Continue with offset=${(offset ?? 1) + 1}; code_grep shows matching lines.]`,
  grep: () => (shown, total) =>
    `[Clipped at 8 KiB after ${shown} of ${total} result lines. Narrow with path or glob, refine the pattern, or pass limit for a larger result.]`,
  find: () => (shown, total) =>
    `[Clipped at 8 KiB after ${shown} of ${total} entries. Narrow with path or pattern, or pass limit for a larger result.]`,
  ls: () => (shown, total) =>
    `[Clipped at 8 KiB after ${shown} of ${total} entries. List a subdirectory, or pass limit for a larger result.]`,
};
function clipped<Result extends { content: { type: string; text?: string }[] }>(
  name: string,
  args: { limit?: unknown; offset?: unknown },
  result: Result,
): Result {
  const note = CLIP_NOTES[name];
  if (!note || args.limit !== undefined || result.content.some((block) => block.type !== "text")) return result;
  const text = result.content.map((block) => block.text ?? "").join("");
  // Pi's own footer ("[... Use offset=N to continue]") describes its 50 KB page; the clip note replaces it.
  const body = text.replace(/\n\n\[[^\]\n]*\]\s*$/, ""),
    out = clipLines(body, note({ offset: typeof args.offset === "number" ? args.offset : undefined }));
  return out === body ? result : { ...result, content: [{ type: "text", text: out }] };
}

/** Read/grep/find/ls for scout and reviewer threads. No write, edit or shell. The root is per thread: a host-chosen PR-head snapshot or parent worktree (resolveRoot), else the project checkout. */
export function readOnlyCodeTools(
  cwd: string,
  resolveRoot?: (api: ToolExecutionApi, context: Context) => Promise<string | undefined>,
): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  const fallback = realpathSync(cwd);
  const byRoot = new Map<string, Built>();
  const built = (root: string) => {
    let tools = byRoot.get(root);
    if (!tools) byRoot.set(root, (tools = createReadOnlyTools(root)));
    return tools;
  };
  const rootOf = async (api: ToolExecutionApi, context: Context) => {
    const chosen = await resolveRoot?.(api, context);
    return chosen ? realpathSync(chosen) : fallback;
  };
  const tools: ToolRegistration[] = built(fallback).map((template) =>
    defineTool({
      name: `code_${template.name}`,
      description: `${template.description} Read-only and limited to this thread's code root (the PR head or worker worktree it was given, otherwise the project checkout ${fallback}) and /tmp. Without limit the answer is at most ${RESPONSE_LIMIT / 1024} KiB and ends with a note on how to continue.`,
      parameters: template.parameters,
      replay: "safe",
      async execute(args, api, context) {
        const root = await rootOf(api, context);
        const tool = built(root).find((item) => item.name === template.name)!;
        const path = (args as { path?: unknown }).path;
        if (typeof path === "string") assertReadable(root, path);
        const { content, ...result } = clipped(
          template.name,
          args as { limit?: unknown; offset?: unknown },
          await tool.execute(api.callId, args, context.abortSignal, (update) =>
            api.output(update.content.map((item) => (item.type === "text" ? item.text : "")).join("")),
          ),
        );
        return { ...result, output: content };
      },
    }),
  );
  tools.push(
    defineTool({
      name: "code_diff",
      description: `Read-only list of changed files and unified diff of this thread's code root (a PR head or worker worktree, including uncommitted work) against its merge-base with the default branch or the given base. A call returns at most ${RESPONSE_LIMIT / 1024} KiB: the first page lists the changed files. Continue with offset (the note names the next one), pass path for one file or directory, or mode "stat" for every changed file with +/- line counts (offset then counts files).`,
      parameters: Type.Object({
        base: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description: "Branch, tag or commit to diff against; default: the checkout's default branch.",
          }),
        ),
        path: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 400,
            description: "Only this file or directory, relative to the project directory (the root code_read uses).",
          }),
        ),
        mode: Type.Optional(DiffModeSchema),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "From the previous page's note: a character offset into the diff, or with mode stat a file index.",
          }),
        ),
      }),
      replay: "safe",
      async execute(args, api, context) {
        return {
          output: [
            {
              type: "text",
              text: await codeDiff(await rootOf(api, context), args.base, { path: args.path, offset: args.offset, mode: args.mode }),
            },
          ],
          details: undefined,
        };
      },
    }),
  );
  return { tools, extension: defineExtension({ name: "projects.readonly-code", tools }) };
}

// Every reader may read under /tmp (owner decision 2026-11-09); on macOS it is a symlink to /private/tmp.
const SHARED_READ_ROOTS = [...new Set(["/tmp", realOr("/tmp")])];
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Both the path and its real path must be under the code root or /tmp, so a symlink cannot lead out of either. */
function assertReadable(root: string, path: string): void {
  const denied = new Error(`Path ${path} is outside this thread's code root ${root} and /tmp; read-only code tools cannot escape them.`);
  // Pi's read tools strip a leading @ and open file:// URLs as paths, so the guard checks the path they open.
  let opened = path.replace(UNICODE_SPACES, " ");
  if (opened.startsWith("@")) opened = opened.slice(1);
  if (opened.startsWith("~")) throw denied;
  if (opened.startsWith("file://"))
    try {
      opened = fileURLToPath(opened);
    } catch {
      throw denied;
    }
  const target = resolve(root, opened);
  const inside = (dir: string, candidate: string) => {
    const rel = relative(dir, candidate);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  for (const candidate of [target, realOr(target)]) if (![root, ...SHARED_READ_ROOTS].some((dir) => inside(dir, candidate))) throw denied;
}
