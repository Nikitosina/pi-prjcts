import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codeDiff } from "./code-diff.ts";

export const READ_ONLY_CODE_TOOL_NAMES = ["code_read", "code_grep", "code_find", "code_ls", "code_diff"] as const;
type Built = ReturnType<typeof createReadOnlyTools>;

/** Read/grep/find/ls for scout and reviewer threads. No write, edit or shell. The root is per thread: a host-chosen PR-head snapshot or parent worktree (resolveRoot), else the project checkout. */
export function readOnlyCodeTools(cwd: string, resolveRoot?: (api: ToolExecutionApi, context: Context) => Promise<string | undefined>): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  const fallback = realpathSync(cwd);
  const byRoot = new Map<string, Built>();
  const built = (root: string) => { let tools = byRoot.get(root); if (!tools) byRoot.set(root, tools = createReadOnlyTools(root)); return tools; };
  const rootOf = async (api: ToolExecutionApi, context: Context) => { const chosen = await resolveRoot?.(api, context); return chosen ? realpathSync(chosen) : fallback; };
  const tools: ToolRegistration[] = built(fallback).map(template => defineTool({
    name: `code_${template.name}`,
    description: `${template.description} Read-only and limited to this thread's code root: the PR head or worker worktree it was given, otherwise the project checkout ${fallback}.`,
    parameters: template.parameters,
    replay: "safe",
    async execute(args, api, context) {
      const root = await rootOf(api, context);
      const tool = built(root).find(item => item.name === template.name)!;
      const path = (args as { path?: unknown }).path;
      if (typeof path === "string") assertInside(root, path);
      return tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
    },
  }));
  tools.push(defineTool({
    name: "code_diff",
    description: `Read-only list of changed files and unified diff of this thread's code root (a PR head or worker worktree, including uncommitted work) against its merge-base with the default branch or the given base. Capped at 46 KB.`,
    parameters: Type.Object({ base: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Branch, tag or commit to diff against; default: origin default branch (git) or trunk (Arc)." })) }),
    replay: "safe",
    async execute(args, api, context) {
      return { content: [{ type: "text", text: await codeDiff(await rootOf(api, context), args.base) }], details: undefined };
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
