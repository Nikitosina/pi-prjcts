import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/git", ".netrc", ".npmrc", ".pi", ".claude", ".codex", ".docker", "Library/Keychains"];
/** Commands that drive machine-wide resources (simulators, the owner's apps, screen). Verifier runs hold no lease on them, so they are refused up front and reported as blocked. */
const GLOBAL_RESOURCE = /\b(simctl|xcodebuild|osascript|screencapture|remote-debugging-port)\b|\bopen\s+-[a-zA-Z]*a\b/;
export function globalResourceUse(command: string): string | null { return GLOBAL_RESOURCE.exec(command)?.[0] ?? null; }
export const LOG_CAP_BYTES = 8 * 1024 * 1024;
export const TAIL_CHARS = 6000;

/** The OS sandbox that confines verifier commands. Without it the verifier role is refused rather than run unconfined. */
export function sandboxAvailable(): boolean { return process.platform === "darwin" && existsSync(SANDBOX_EXEC); }

export type SandboxPolicy = {
  /** Directories the command may write: the target snapshot, its scratch space and the verifier's own artifacts folder. */
  writable: readonly string[];
  /** Directories the command may not read: other projects' data and credentials. A readable path inside one of them is listed in `readable`. */
  unreadable: readonly string[];
  readable: readonly string[];
};

const quote = (path: string) => JSON.stringify(realpathSync(path));

/** Reads of credentials and project data are denied by content (file-read-data), not metadata, so tools can still stat the path to their working directory. Deny-by-default writes, no remote network, and no reads of credentials or project data. Reads of code and system files stay open so toolchains run. */
export function sandboxProfile(policy: SandboxPolicy): string {
  const home = realpathSync(homedir());
  const secrets = SECRET_HOME_DIRS.map(path => join(home, path)).filter(path => existsSync(path));
  return [
    "(version 1)", "(allow default)",
    "(deny file-write*)", `(allow file-write* (subpath "/dev") ${policy.writable.map(path => `(subpath ${quote(path)})`).join(" ")})`,
    ...[...secrets, ...policy.unreadable.filter(path => existsSync(path))].map(path => `(deny file-read-data (subpath ${quote(path)}))`),
    ...policy.readable.map(path => `(allow file-read-data (subpath ${quote(path)}))`),
    // Global, unleased resources: no simulator service, no signalling processes outside the sandbox (no stopping the owner's browser or simulator).
    '(deny mach-lookup (global-name-prefix "com.apple.CoreSimulator"))', "(deny signal (target others))",
    "(deny network-outbound)", '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
  ].join("\n");
}

export type RunResult = { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; durationMs: number; stdoutBytes: number; stderrBytes: number; stdoutSha256: string; stderrSha256: string; tail: string };

const ENV_PASS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"];
/** Fixed environment: no credentials, no host paths. HOME and TMPDIR point into the writable scratch space. */
export function sandboxEnv(scratch: string, artifacts: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_PASS) if (process.env[name] !== undefined) env[name] = process.env[name];
  const home = join(scratch, "home"), tmp = join(scratch, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { ...env, HOME: home, TMPDIR: tmp, PI_ARTIFACTS_DIR: artifacts, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** Runs one shell command under the sandbox in its own process group; stdout and stderr stream to log files (capped), and the tail comes back. */
export function runSandboxed(input: { command: string; cwd: string; policy: SandboxPolicy; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; stdoutPath: string; stderrPath: string }): Promise<RunResult> {
  if (!sandboxAvailable()) return Promise.reject(new Error("No enforceable sandbox on this platform; verifier commands are refused"));
  const started = Date.now(), out = openSync(input.stdoutPath, "w", 0o600), err = openSync(input.stderrPath, "w", 0o600);
  const hashes = { out: createHash("sha256"), err: createHash("sha256") }, sizes = { out: 0, err: 0 };
  let tail = "", timedOut = false, aborted = false;
  return new Promise(resolve => {
    const child = spawn(SANDBOX_EXEC, ["-p", sandboxProfile(input.policy), "/bin/sh", "-c", input.command], { cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (name: NodeJS.Signals) => { if (child.pid !== undefined) try { process.kill(-child.pid, name); } catch { /* group already gone */ } };
    const stop = () => { killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 1500).unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const collect = (kind: "out" | "err", fd: number) => (chunk: Buffer) => {
      hashes[kind].update(chunk);
      if (sizes[kind] < LOG_CAP_BYTES) writeSync(fd, chunk.subarray(0, LOG_CAP_BYTES - sizes[kind]));
      sizes[kind] += chunk.length;
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
    };
    child.stdout.on("data", collect("out", out)); child.stderr.on("data", collect("err", err));
    child.on("error", error => { tail += `\n[spawn error: ${error.message}]`; });
    child.once("close", (code, signal) => {
      clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort);
      killGroup("SIGKILL");
      closeSync(out); closeSync(err);
      resolve({ exitCode: code, signal, timedOut, aborted, durationMs: Date.now() - started, stdoutBytes: sizes.out, stderrBytes: sizes.err, stdoutSha256: hashes.out.digest("hex"), stderrSha256: hashes.err.digest("hex"), tail });
    });
  });
}
