import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { ensureArtifactDir } from "./artifacts.ts";
import { binaryResult, decodeBase64, type ResultBlock } from "./binary-results.ts";
import { sourceWriteDiagnostic } from "./source-writes.ts";
import { CACHE_VARIABLE } from "./workspace-cache.ts";

/** Where one call runs: the authorized worktree, the artifacts scope, and for whole-repository workers the shell guard and owner-checkout check. */
export type ExecutionTarget = {
  cwd: string;
  scope: string;
  guard?: (command: string) => string;
  assertWritable?: (path: string) => void;
};

let photon: Promise<ImageProcessor> | undefined;
/** Photon starts on the first image read, not at import. */
const images: ImageProcessor = { prepare: async (...args) => (await (photon ??= createNodePhotonImages())).prepare(...args) };

/**
 * Durable's own read, write, edit and bash. The resolver must authorize the worktree on every call, with no fallback; the native tool then
 * sees only an environment rooted there. Nested calls from code mode run through the same tools, so the same checks apply.
 */
export function coordinatorExecutionTools(input: {
  controlRoot: string;
  name?: string;
  target: (api: ToolExecutionApi, context: Context) => Promise<ExecutionTarget>;
  /** The workspace cache of a working folder, for bash's $PI_WORKSPACE_CACHE (src/workspace-cache.ts). */
  cache?: (cwd: string) => Promise<string | undefined>;
}): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  const native = [createReadTool({ images }), createWriteTool(), createEditTool(), createBashTool()] as ToolRegistration[];
  const tools = native.map((tool) =>
    defineTool({
      ...tool,
      replay: "unsafe",
      async execute(args, api, context) {
        const target = await input.target(api, context);
        if (tool.name === "write" || tool.name === "edit") target.assertWritable?.(String((args as { path?: unknown }).path ?? ""));
        const artifacts = ensureArtifactDir(input.controlRoot, target.scope);
        const cache = tool.name === "bash" ? await input.cache?.(target.cwd) : undefined;
        const run =
          tool.name === "bash"
            ? createBashTool({
                prepare: (execution) => {
                  const warning = sourceWriteDiagnostic(execution.command);
                  if (warning) api.diagnostic(warning);
                  execution.env.PI_ARTIFACTS_DIR = artifacts;
                  if (cache) execution.env[CACHE_VARIABLE] = cache;
                  if (target.guard) execution.command = target.guard(execution.command);
                },
              })
            : tool;
        const scoped: ToolExecutionApi = Object.create(api, { env: { value: new NodeExecutionEnv({ cwd: target.cwd }) } });
        const result = await run.execute(args as never, scoped, context);
        if (!result.output?.some((block) => block.type === "image")) return result;
        const output: ResultBlock[] = [];
        for (const block of result.output) {
          // The processor may have resized the read; this retains the image the model gets, not the original file.
          if (block.type === "image")
            output.push(
              ...(await binaryResult(
                { controlRoot: input.controlRoot, scope: target.scope },
                { bytes: decodeBase64(block.data), label: `${tool.name} returned image` },
              )),
            );
          else if (block.type === "text") output.push(block);
        }
        return { ...result, output };
      },
    }),
  );
  return { tools, extension: defineExtension({ name: input.name ?? "projects.coordinator-execution", tools }) };
}
