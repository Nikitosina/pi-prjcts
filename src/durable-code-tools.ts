import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codeDiff } from "./code-diff.ts";
import { clipLines, RESPONSE_LIMIT } from "./response-limit.ts";

export const READ_ONLY_CODE_TOOL_NAMES = ["code_read", "code_grep", "code_find", "code_ls", "code_diff"] as const;
type Built = ReturnType<typeof createReadOnlyTools>;

/** Without an explicit limit a text answer is clipped to RESPONSE_LIMIT bytes, with a note that says how to continue. Images and other blocks pass through. */
const CLIP_NOTES: Record<string, (args: { offset?: number }) => (shown: number, total: number) => string> = {
  read: ({ offset }) => (shown, total) => shown ? `[Clipped at 8 KiB after line ${(offset ?? 1) + shown - 1}. Continue with offset=${(offset ?? 1) + shown}, or pass limit for more lines per call.]` : `[Line ${offset ?? 1} is longer than 8 KiB and was cut. Continue with offset=${(offset ?? 1) + 1}; code_grep shows matching lines.]`,
  grep: () => (shown, total) => `[Clipped at 8 KiB after ${shown} of ${total} result lines. Narrow with path or glob, refine the pattern, or pass limit for a larger result.]`,
  find: () => (shown, total) => `[Clipped at 8 KiB after ${shown} of ${total} entries. Narrow with path or pattern, or pass limit for a larger result.]`,
  ls: () => (shown, total) => `[Clipped at 8 KiB after ${shown} of ${total} entries. List a subdirectory, or pass limit for a larger result.]`,
};
function clipped<Result extends { content: { type: string; text?: string }[] }>(name: string, args: { limit?: unknown; offset?: unknown }, result: Result): Result {
  const note = CLIP_NOTES[name];
  if (!note || args.limit !== undefined || result.content.some(block => block.type !== "text")) return result;
  const text = result.content.map(block => block.text ?? "").join("");
  // Pi's own footer ("[... Use offset=N to continue]") describes its 50 KB page; the clip note replaces it.
  const body = text.replace(/\n\n\[[^\]\n]*\]\s*$/, ""), out = clipLines(body, note({ offset: typeof args.offset === "number" ? args.offset : undefined }));
  return out === body ? result : { ...result, content: [{ type: "text", text: out }] };
}

/** Read/grep/find/ls for scout and reviewer threads. No write, edit or shell. The root is per thread: a host-chosen PR-head snapshot or parent worktree (resolveRoot), else the project checkout. */
export function readOnlyCodeTools(cwd: string, resolveRoot?: (api: ToolExecutionApi, context: Context) => Promise<string | undefined>): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  const fallback = realpathSync(cwd);
  const byRoot = new Map<string, Built>();
  const built = (root: string) => { let tools = byRoot.get(root); if (!tools) byRoot.set(root, tools = createReadOnlyTools(root)); return tools; };
  const rootOf = async (api: ToolExecutionApi, context: Context) => { const chosen = await resolveRoot?.(api, context); return chosen ? realpathSync(chosen) : fallback; };
  const tools: ToolRegistration[] = built(fallback).map(template => defineTool({
    name: `code_${template.name}`,
    description: `${template.description} Read-only and limited to this thread's code root: the PR head or worker worktree it was given, otherwise the project checkout ${fallback}. Without limit the answer is at most ${RESPONSE_LIMIT / 1024} KiB and ends with a note on how to continue.`,
    parameters: template.parameters,
    replay: "safe",
    async execute(args, api, context) {
      const root = await rootOf(api, context);
      const tool = built(root).find(item => item.name === template.name)!;
      const path = (args as { path?: unknown }).path;
      if (typeof path === "string") assertInside(root, path);
      return clipped(template.name, args as { limit?: unknown; offset?: unknown }, await tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join(""))));
    },
  }));
  tools.push(defineTool({
    name: "code_diff",
    description: `Read-only list of changed files and unified diff of this thread's code root (a PR head or worker worktree, including uncommitted work) against its merge-base with the default branch or the given base. A call returns at most ${RESPONSE_LIMIT / 1024} KiB: the first page lists the changed files. Continue with offset (the note names the next one), or pass path to read one file or directory.`,
    parameters: Type.Object({ base: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Branch, tag or commit to diff against; default: the checkout's default branch." })), path: Type.Optional(Type.String({ minLength: 1, maxLength: 400, description: "Only this file or directory, relative to the checkout root (git checkouts)." })), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the diff text from the previous page's note." })) }),
    replay: "safe",
    async execute(args, api, context) {
      return { content: [{ type: "text", text: await codeDiff(await rootOf(api, context), args.base, { path: args.path, offset: args.offset }) }], details: undefined };
    },
  }));
  return { tools, extension: defineExtension({ name: "projects.readonly-code", tools }) };
}

function assertInside(root: string, path: string): void {
  const denied = new Error(`Path ${path} is outside this thread's code root ${root}; read-only code tools cannot escape it.`);
  if (path.startsWith("~")) throw denied;
  const target = resolve(root, path);
  let real = target;
  try { real = realpathSync(target); } catch { /* missing paths fail in the tool itself; the lexical check still applies */ }
  for (const candidate of [target, real]) {
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw denied;
  }
}
