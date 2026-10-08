import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";

export const READ_ONLY_CODE_TOOL_NAMES = ["code_read", "code_grep", "code_find", "code_ls"] as const;
type Built = ReturnType<typeof createReadOnlyTools>;

/** Read/grep/find/ls for scout and reviewer threads. No write, edit or shell. The root is per thread: a host-chosen PR-head snapshot or parent worktree (resolveRoot), else the project checkout. */
export function readOnlyCodeTools(cwd: string, resolveRoot?: (api: ToolExecutionApi, context: Context) => Promise<string | undefined>): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  const fallback = realpathSync(cwd);
  const byRoot = new Map<string, Built>();
  const built = (root: string) => { let tools = byRoot.get(root); if (!tools) byRoot.set(root, tools = createReadOnlyTools(root)); return tools; };
  const tools = built(fallback).map(template => defineTool({
    name: `code_${template.name}`,
    description: `${template.description} Read-only and limited to this thread's code root: the PR head or worker worktree it was given, otherwise the project checkout ${fallback}.`,
    parameters: template.parameters,
    replay: "safe",
    async execute(args, api, context) {
      const chosen = await resolveRoot?.(api, context);
      const root = chosen ? realpathSync(chosen) : fallback;
      const tool = built(root).find(item => item.name === template.name)!;
      const path = (args as { path?: unknown }).path;
      if (typeof path === "string") assertInside(root, path);
      return tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
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
