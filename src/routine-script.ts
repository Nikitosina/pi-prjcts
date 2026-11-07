import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Script routines (scripts/routine-script-failures.md): one owner-approved shell command, stored exactly, run in its own process group. */
export const OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 600_000;
export const KEEP_RUNS = 50;

export function scriptError(input: { command: string; timeoutMs: number }): string | null {
  if (!input.command.trim() || input.command.length > 32_000) return "A script needs a command of at most 32000 characters";
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 60_000 || input.timeoutMs > 7_200_000)
    return "A script timeout must be between one minute and two hours";
  return null;
}

export type ScriptRun = {
  /** null when the script could not start or was killed by a signal. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The last OUTPUT_BYTES of stdout and stderr together. */
  output: string;
  truncated: boolean;
};

/** Runs `/bin/zsh -lc <command>`; a timeout or abort kills the whole process group, and so does the script's own exit. */
export function runScript(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ScriptRun> {
  const started = Date.now();
  const chunks: Buffer[] = [];
  let size = 0,
    truncated = false,
    timedOut = false;
  const keep = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    while (size > OUTPUT_BYTES) {
      const over = size - OUTPUT_BYTES,
        first = chunks[0];
      if (first.length <= over) chunks.shift();
      else chunks[0] = first.subarray(over);
      size -= Math.min(first.length, over);
      truncated = true;
    }
  };
  const text = () => {
    const bytes = Buffer.concat(chunks);
    let start = 0;
    // A cut tail may begin inside a UTF-8 character.
    while (truncated && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, input.timeoutMs);
    input.signal.addEventListener("abort", killGroup, { once: true });
    if (input.signal.aborted) killGroup();
    let done = false;
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", killGroup);
      resolve({ exitCode, timedOut, durationMs: Date.now() - started, output: text(), truncated });
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      keep(Buffer.from(`${error.message}\n`));
      finish(null);
    });
    // Background children would hold the pipes open; the run ends with the script.
    child.on("exit", killGroup);
    child.on("close", (code) => finish(code));
  });
}

/** Keeps the newest `keep` run records (`<start ms>.json`) in a routine's folder. */
export function pruneRunLogs(dir: string, keep = KEEP_RUNS): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return;
  }
  names.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  for (const name of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(dir, name), { force: true });
}
