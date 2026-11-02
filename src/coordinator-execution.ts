import type { Context } from "@earendil-works/chord";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { ensureArtifactDir } from "./artifacts.ts";
import { binaryResult, decodeBase64, type ResultBlock } from "./binary-results.ts";

/** Trusted local tools. The resolver must authorize the chat's persisted worktree on every call, with no fallback. */
export function coordinatorExecutionTools(input: {
  controlRoot: string;
  name?: string;
  target: (api: ToolExecutionApi, context: Context) => Promise<{ cwd: string; scope: string }>;
}): { tools: ToolRegistration[]; extension: ReturnType<typeof defineExtension> } {
  // These instances supply schemas only; execution always builds tools for the resolved chat.
  const tools: ToolRegistration[] = createCodingTools(input.controlRoot).map((definition) =>
    defineTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      prepareArguments: definition.prepareArguments,
      replay: "unsafe",
      async execute(args, api, context) {
        const target = await input.target(api, context);
        const artifacts = ensureArtifactDir(input.controlRoot, target.scope);
        const tool = createCodingTools(target.cwd, {
          bash: {
            spawnHook: ({ env, ...spawn }) => ({ ...spawn, env: { ...env, PI_ARTIFACTS_DIR: artifacts } }),
          },
        }).find((tool) => tool.name === definition.name);
        if (!tool) throw new Error(`Missing standard tool: ${definition.name}`);
        const result = await tool.execute(api.callId, args, context.abortSignal, (update) =>
          api.output(update.content.map((block) => (block.type === "text" ? block.text : "")).join("")),
        );
        const output: ResultBlock[] = [];
        for (const block of result.content) {
          if (block.type === "image") {
            // The SDK may resize reads before returning them; this retains that returned image, not the original file.
            output.push(
              ...(await binaryResult(
                { controlRoot: input.controlRoot, scope: target.scope },
                { bytes: decodeBase64(block.data), label: `${definition.name} returned image` },
              )),
            );
          } else output.push(block);
        }
        // SDK structuredContent repeats read-image bytes; programs receive the converted output instead.
        return { output, details: result.details, isError: result.isError };
      },
    }),
  );
  return { tools, extension: defineExtension({ name: input.name ?? "projects.coordinator-execution", tools }) };
}
