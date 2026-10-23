import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Project } from "./state.ts";

const TIMEOUT_MS = 120_000, MAX_BUFFER = 8 * 1024 * 1024;

/** On unless the owner switched it off in Settings. */
export const ghEnabled = (project: Pick<Project, "githubCli">) => project.githubCli !== "none";

export type GhResult = { exitCode: number; stdout: string; stderr: string; problem?: string };

/** Runs gh directly with this argv (no shell) in cwd, using the owner's existing gh login. Never throws. */
export function runGh(input: { args: string[]; cwd: string; input?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<GhResult> {
  return new Promise(resolve => {
    const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1", GH_SPINNER_DISABLED: "1" };
    const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;
    const child = execFile("gh", input.args, { cwd: input.cwd, env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal: input.signal, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ exitCode: 0, stdout, stderr });
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") return resolve({ exitCode: 127, stdout, stderr, problem: "gh not installed: install the GitHub CLI (https://cli.github.com) on the host." });
      if (failure.name === "AbortError") return resolve({ exitCode: 130, stdout, stderr, problem: "gh was cancelled." });
      if (failure.killed) return resolve({ exitCode: 124, stdout, stderr, problem: `gh timed out after ${timeoutMs / 1000} s and was killed.` });
      const exitCode = typeof failure.code === "number" ? failure.code : 1;
      const loggedOut = /gh auth login|not logged in|authentication required|GH_TOKEN/i.test(stderr);
      resolve({ exitCode, stdout, stderr, ...(loggedOut ? { problem: "gh is not logged in: the owner must run `gh auth login` on the host." } : {}) });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input.input ?? "");
  });
}

export function coordinatorGhTools(input: { cwd: string; dir: string; isCoordinator: (id: Conversation["id"]) => boolean }) {
  const tool = defineTool({
    name: "projects_gh",
    description: "Run the GitHub CLI (gh) with exactly this argv, no shell, in the project checkout, signed in as the owner. Full access, any subcommand: when the owner asks you may merge PRs, mark them ready, review, comment, close, create or edit PRs, issues and releases, and call the API. These act on GitHub as the owner and are hard to undo, so do them only on the owner's request or clear approval. Pass each argument as its own array item without shell quoting (['pr','view','12','--json','state']). input is sent on stdin only for things like api --input -. Interactive prompts are off. Times out after 120 s. Output is capped at 400 lines / 8 KB, keeping the end; narrow with --json, --jq and --limit. Failures return the exit code and gh's error.",
    parameters: Type.Object({ args: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }), input: Type.Optional(Type.String({ maxLength: 1_000_000 })) }, { additionalProperties: false }),
    replay: "unsafe", outputLimits: { maxBytes: 8 * 1024, maxLines: 400, retain: "tail" },
    async execute(args, api: ToolExecutionApi, context) {
      if (!input.isCoordinator(api.conversationId)) throw new Error("projects_gh is coordinator-only");
      const started = Date.now();
      const result = await runGh({ args: args.args, cwd: input.cwd, input: args.input, signal: context.abortSignal });
      // Argv, exit code and duration only; never output bodies.
      try { appendFileSync(join(input.dir, "gh-calls.jsonl"), JSON.stringify({ at: new Date(started).toISOString(), args: args.args, exitCode: result.exitCode, durationMs: Date.now() - started }) + "\n", { mode: 0o600 }); } catch {}
      const body = [result.stdout, result.stderr && `[stderr]\n${result.stderr}`].filter(Boolean).join("\n");
      if (result.problem || result.exitCode !== 0) throw new Error(`${result.problem ?? `gh exited with code ${result.exitCode}.`}${body ? `\n${body.slice(-8 * 1024)}` : ""}`);
      return { content: [{ type: "text", text: body || "(no output)" }] };
    },
  });
  const tools = [tool];
  return { tools, extension: defineExtension({ name: "projects.coordinator-gh", tools }) };
}
