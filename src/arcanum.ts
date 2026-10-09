import { execFile } from "node:child_process";
import { cli } from "./vcs.ts";

/** Failure of the Arcanum client: its closed error code, and whether the caller may retry later (exit 75, rate limited). */
export class ArcanumError extends Error {
  readonly code: string;
  readonly rateLimited: boolean;
  constructor(message: string, code: string, rateLimited = false) { super(message); this.code = code; this.rateLimited = rateLimited; }
}

/** `ya tool arcanum <args> --json`: the typed payload, or an ArcanumError carrying the envelope's code. Reads and writes alike; callers decide. */
export function arcanum<T>(args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const [file, ...prefix] = cli.arcanum();
  return new Promise((accept, reject) => {
    execFile(file, [...prefix, ...args, "--json"], { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, signal: options.signal }, (error, stdout, stderr) => {
      let payload: unknown;
      try { payload = stdout.trim() ? JSON.parse(stdout) : undefined; } catch { payload = undefined; }
      const envelope = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
      if (envelope || error) {
        const code = envelope?.code ?? "REMOTE_ERROR", exit = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : 0;
        reject(new ArcanumError(`arcanum ${args.slice(0, 2).join(" ")} failed: ${envelope?.message ?? (stderr.trim().slice(-200) || String(error?.message ?? "unknown error"))}`, code, exit === 75 || code === "RATE_LIMITED"));
        return;
      }
      accept(payload as T);
    });
  });
}
