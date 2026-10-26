import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/git", ".netrc", ".npmrc", ".pi", ".claude", ".codex", ".docker", "Library/Keychains"];
/**
 * Fast refusal with a clear message for commands that name machine-wide resources. The sandbox profile is what enforces it (no mach
 * services, no sockets, no LaunchServices); this only saves the verifier a confusing failure.
 */
const GLOBAL_RESOURCE = /\b(simctl|xcodebuild|osascript|screencapture|launchctl|remote-debugging-port)\b|\bopen\s+-[a-zA-Z]*a\b|\bsecurity\s+(find|dump|list|add|delete|import|export)/;
export function globalResourceUse(command: string): string | null { return GLOBAL_RESOURCE.exec(command)?.[0] ?? null; }
export const LOG_CAP_BYTES = 8 * 1024 * 1024;
export const TAIL_CHARS = 6000;

/** The OS sandbox that confines verifier commands. Without it the verifier role is refused rather than run unconfined. */
export function sandboxAvailable(): boolean { return process.platform === "darwin" && existsSync(SANDBOX_EXEC); }

export type SandboxPolicy = {
  /** Directories the command may write: the target snapshot, its scratch space and the verifier's own artifacts folder. */
  writable: readonly string[];
  /** Extra directories the command may not read (other projects' data); a readable path inside one is listed in `readable`. */
  unreadable: readonly string[];
  readable: readonly string[];
  /** The only places unix sockets may be created or connected: run-local directories. Every other socket (host control, Docker, mDNSResponder) is refused. */
  sockets: readonly string[];
};

const quote = (path: string) => JSON.stringify(realpathSync(path));

/** Mach services a plain toolchain needs (logging, preferences, notifications). Everything else (LaunchServices, AppleEvents, securityd, DNS, CoreSimulator) is unreachable. */
const MACH_ALLOWED = ["com.apple.system.logger", "com.apple.system.notification_center", "com.apple.cfprefsd.daemon", "com.apple.cfprefsd.agent", "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.SystemConfiguration.configd", "com.apple.trustd", "com.apple.diagnosticd", "com.apple.analyticsd", "com.apple.coreservices.quarantine-resolver"];
const DENIED_PROGRAMS = ["/usr/bin/open", "/usr/bin/osascript", "/usr/bin/security", "/bin/launchctl", "/usr/bin/screencapture", "/usr/bin/sandbox-exec", "/usr/bin/xcodebuild"];
/** Directory trees of the running toolchain that live under a home directory; readable so `node` and friends still start. */
const toolchainRoots = (): string[] => { const bin = realpathSync(process.execPath); return /^\/Users\//.test(bin) ? [dirname(dirname(bin))] : []; };

/**
 * Default-deny where the platform lets us: writes, reads under every home directory, mach services, network and sockets are denied and then
 * opened for named paths and services only. Loopback TCP stays open (tests start their own servers), so services the owner runs on loopback are
 * reachable: not claimed as confined. Reads of system files and toolchains stay open so commands run.
 */
export function sandboxProfile(policy: SandboxPolicy): string {
  const home = realpathSync(homedir());
  const secrets = SECRET_HOME_DIRS.map(path => join(home, path)).filter(path => existsSync(path));
  const present = (paths: readonly string[]) => paths.filter(path => existsSync(path));
  return [
    "(version 1)", "(allow default)",
    "(deny file-write*)", `(allow file-write* (subpath "/dev") ${policy.writable.map(path => `(subpath ${quote(path)})`).join(" ")})`,
    // Content of every home directory is denied (metadata stays, so tools can stat their working directory), then named paths open again.
    '(deny file-read-data (subpath "/Users"))', `(deny file-read-data (subpath ${quote(home)}))`,
    ...[...secrets, ...present(policy.unreadable)].map(path => `(deny file-read-data (subpath ${quote(path)}))`),
    ...present([...toolchainRoots(), ...policy.readable]).map(path => `(allow file-read-data (subpath ${quote(path)}))`),
    "(deny mach-lookup)", `(allow mach-lookup ${MACH_ALLOWED.map(name => `(global-name ${JSON.stringify(name)})`).join(" ")})`,
    "(deny appleevent-send)", "(deny lsopen)", "(deny user-preference-write)",
    `(deny process-exec ${DENIED_PROGRAMS.map(path => `(literal ${JSON.stringify(path)})`).join(" ")} (regex #"/simctl$"))`,
    "(deny signal (target others))",
    "(deny network*)", '(allow network* (local ip "localhost:*") (remote ip "localhost:*"))',
    ...policy.sockets.map(path => `(allow network* (local unix-socket (subpath ${quote(path)})) (remote unix-socket (subpath ${quote(path)})))`),
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
export function runSandboxed(input: { command: string; cwd: string; policy: SandboxPolicy; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; stdoutPath: string; stderrPath: string; /** Directory where the running command's identity is recorded, so a host that dies mid-command can be cleaned up after. */ registry?: string }): Promise<RunResult> {
  if (!sandboxAvailable()) return Promise.reject(new Error("No enforceable sandbox on this platform; verifier commands are refused"));
  const started = Date.now(), out = openSync(input.stdoutPath, "w", 0o600), err = openSync(input.stderrPath, "w", 0o600);
  const hashes = { out: createHash("sha256"), err: createHash("sha256") }, sizes = { out: 0, err: 0 };
  let tail = "", timedOut = false, aborted = false;
  return new Promise(resolve => {
    const child = spawn(SANDBOX_EXEC, ["-p", sandboxProfile(input.policy), "/bin/sh", "-c", input.command], { cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const entry = input.registry && child.pid !== undefined ? join(input.registry, `${child.pid}.json`) : undefined;
    if (entry) { mkdirSync(input.registry!, { recursive: true, mode: 0o700 }); writeFileSync(entry, JSON.stringify({ pid: child.pid, hostPid: process.pid, started: startOf(child.pid!), command: input.command.slice(0, 200) }), { mode: 0o600 }); }
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
      if (entry) rmSync(entry, { force: true });
      closeSync(out); closeSync(err);
      resolve({ exitCode: code, signal, timedOut, aborted, durationMs: Date.now() - started, stdoutBytes: sizes.out, stderrBytes: sizes.err, stdoutSha256: hashes.out.digest("hex"), stderrSha256: hashes.err.digest("hex"), tail });
    });
  });
}

const psField = (pid: number, field: string): string => { try { return execFileSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
const startOf = (pid: number): string => psField(pid, "lstart");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Kills sandboxed commands left behind by a host that died (they run in their own process group, so they outlive it). An entry is only acted on
 * when its recorded process still exists with the same start time and still leads its own process group, so a reused pid is never signalled.
 */
export function reapOrphans(registry: string): number[] {
  if (!existsSync(registry)) return [];
  const reaped: number[] = [];
  for (const name of readdirSync(registry)) {
    const file = join(registry, name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as { pid: number; hostPid: number; started: string };
      if (entry.hostPid === process.pid || (entry.hostPid !== process.pid && alive(entry.hostPid))) continue;
      if (entry.started !== "" && startOf(entry.pid) === entry.started && psField(entry.pid, "pgid") === String(entry.pid)) { try { process.kill(-entry.pid, "SIGKILL"); reaped.push(entry.pid); } catch { /* already gone */ } }
      rmSync(file, { force: true });
    } catch { rmSync(file, { force: true }); }
  }
  return reaped;
}
