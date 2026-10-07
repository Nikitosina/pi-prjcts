import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";

export const READ_ONLY_CODE_TOOL_NAMES = ["code_read", "code_grep", "code_find", "code_ls"] as const;

/** Read/grep/find/ls over the project checkout for scout and reviewer threads. No write, edit or shell. */
export function readOnlyCodeTools(cwd: string): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  const root = realpathSync(cwd);
  const tools = createReadOnlyTools(root).map(tool => defineTool({
    name: `code_${tool.name}`,
    description: `${tool.description} Read-only and limited to the project checkout ${root}.`,
    parameters: tool.parameters,
    replay: "safe",
    async execute(args, api, context) {
      const path = (args as { path?: unknown }).path;
      if (typeof path === "string") assertInside(root, path);
      return tool.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
    },
  }));
  return { tools, extension: defineExtension({ name: "projects.readonly-code", tools }) };
}

function assertInside(root: string, path: string): void {
  const denied = new Error(`Path ${path} is outside the project checkout ${root}; read-only code tools cannot escape it.`);
  if (path.startsWith("~")) throw denied;
  const target = resolve(root, path);
  let real = target;
  try { real = realpathSync(target); } catch { /* missing paths fail in the tool itself; the lexical check still applies */ }
  for (const candidate of [target, real]) {
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw denied;
  }
}
