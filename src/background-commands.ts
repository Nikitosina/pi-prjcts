import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensureArtifactDir } from "./artifacts.ts";

/** Long-running worker commands: detached process group in the worker's worktree, output to a log under the thread's artifacts, polled by id. */
export type BackgroundInfo = { id: string; label: string; command: string; state: "running" | "exited" | "killed" | "lost"; code: number | null; signal: string | null; reason?: string; pid: number; startedAt: number; endedAt: number | null; log: string; lstart: string };
export type BackgroundStatus = BackgroundInfo & { tail: string; tailTruncated: boolean; logBytes: number };
const ID = /^bg-[a-f0-9]{8}$/;
const TAIL_BYTES = 65536, TAIL_CHARS = 20000;
const lstartOf = (pid: number): string | undefined => { try { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined; } catch { return undefined; } };
const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const bgDir = (controlRoot: string, threadId: string) => join(ensureArtifactDir(controlRoot, threadId), "bg");

export function createBackgroundCommands(options: { controlRoot: string; maxPerThread?: number; maxLogBytes?: number; graceMs?: number }) {
  const maxPerThread = options.maxPerThread ?? 3, maxLogBytes = options.maxLogBytes ?? (Number(process.env.PI_PROJECTS_BG_LOG_MAX_BYTES) || 64 * 1024 * 1024), graceMs = options.graceMs ?? 2000;
  type Live = { info: BackgroundInfo; threadId: string; exited: Promise<void>; stop: (reason: string) => Promise<void> };
  const live = new Map<string, Live>();
  const persist = (threadId: string, info: BackgroundInfo) => writeFileSync(join(bgDir(options.controlRoot, threadId), `${info.id}.json`), JSON.stringify(info));
  const load = (threadId: string, id: string): BackgroundInfo | undefined => { try { return JSON.parse(readFileSync(join(bgDir(options.controlRoot, threadId), `${id}.json`), "utf8")) as BackgroundInfo; } catch { return undefined; } };
  const running = (threadId: string) => [...live.values()].filter(item => item.threadId === threadId && item.info.state === "running");

  function start(threadId: string, input: { command: string; label: string; cwd: string; env: NodeJS.ProcessEnv }): BackgroundInfo {
    if (running(threadId).length >= maxPerThread) throw new Error(`At most ${maxPerThread} background commands may run per thread; stop one with projects_bg_stop or wait for it to finish`);
    const id = `bg-${randomBytes(4).toString("hex")}`, dir = bgDir(options.controlRoot, threadId), logPath = join(dir, `${id}.log`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const child = spawn("/bin/bash", ["-c", input.command], { cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid === undefined) throw new Error("Background command failed to start");
    const info: BackgroundInfo = { id, label: input.label, command: input.command, state: "running", code: null, signal: null, pid, startedAt: Date.now(), endedAt: null, log: `artifact:${threadId}/bg/${id}.log`, lstart: lstartOf(pid) ?? "" };
    persist(threadId, info);
    const fd = openSync(logPath, "a", 0o600);
    let stopping: string | undefined, settled!: () => void, written = 0;
    const exited = new Promise<void>(resolve => { settled = resolve; });
    const signalGroup = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { /* group already gone */ } };
    const entry: Live = { info, threadId, exited,
      stop: async reason => {
        if (info.state !== "running") return;
        stopping ??= reason;
        signalGroup("SIGTERM");
        const killer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
        await exited; clearTimeout(killer);
      } };
    // Output is appended to the log here, so a runaway command is cut off at the cap instead of filling the disk.
    const collect = (chunk: Buffer) => {
      if (written >= maxLogBytes) return;
      const take = chunk.subarray(0, maxLogBytes - written);
      writeSync(fd, take); written += take.length;
      if (written >= maxLogBytes) { writeSync(fd, `\n[log limit of ${maxLogBytes} bytes reached; command stopped]\n`); void entry.stop("log-limit"); }
    };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    let finished = false;
    const finish = () => { if (finished) return; finished = true; closeSync(fd); persist(threadId, info); settled(); };
    child.once("error", () => { info.state = "lost"; info.reason = "spawn-error"; info.endedAt = Date.now(); finish(); });
    child.once("exit", (code, signal) => {
      if (alive(pid)) signalGroup("SIGKILL");
      info.code = code; info.signal = signal; info.endedAt = Date.now();
      info.state = stopping ? "killed" : "exited";
      if (stopping) info.reason = stopping;
    });
    // Close follows the exit once the pipes drained, so the log is complete before the state is final.
    child.once("close", finish);
    live.set(id, entry);
    return { ...info };
  }
  function owned(threadId: string, id: string): { info: BackgroundInfo; entry?: Live } {
    if (!ID.test(id)) throw new Error("Unknown background command");
    const entry = live.get(id);
    if (entry && entry.threadId !== threadId) throw new Error("Unknown background command");
    const info = entry?.info ?? load(threadId, id);
    if (!info) throw new Error("Unknown background command");
    return { info, entry };
  }
  function status(threadId: string, id: string, tailLines: number): BackgroundStatus {
    const { info } = owned(threadId, id), path = join(bgDir(options.controlRoot, threadId), `${id}.log`);
    let tail = "", tailTruncated = false, logBytes = 0;
    if (existsSync(path)) {
      logBytes = statSync(path).size;
      const length = Math.min(logBytes, TAIL_BYTES), buffer = Buffer.alloc(length), fd = openSync(path, "r");
      try { readSync(fd, buffer, 0, length, logBytes - length); } finally { closeSync(fd); }
      const lines = buffer.toString("utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      let picked = lines.slice(-tailLines).join("\n");
      tailTruncated = logBytes > length || lines.length > tailLines;
      if (picked.length > TAIL_CHARS) { picked = picked.slice(-TAIL_CHARS); tailTruncated = true; }
      tail = picked;
    }
    return { ...info, tail, tailTruncated, logBytes };
  }
  async function stop(threadId: string, id: string): Promise<BackgroundInfo> {
    const { info, entry } = owned(threadId, id);
    await entry?.stop("stopped");
    return { ...info };
  }
  const list = (threadId: string): BackgroundInfo[] => [...live.values()].filter(item => item.threadId === threadId).map(item => ({ ...item.info }));
  async function killThread(threadId: string) { await Promise.all(running(threadId).map(item => item.stop("thread-ended"))); }
  async function killAll() { await Promise.all([...live.values()].map(item => item.stop("host-shutdown"))); }
  /** After a host crash: records still "running" whose process group is alive with the recorded start time are killed; a reused pid is left alone. */
  function reap(): string[] {
    const reaped: string[] = [], root = join(options.controlRoot, "artifacts");
    if (!existsSync(root)) return reaped;
    for (const threadId of readdirSync(root)) {
      const dir = join(root, threadId, "bg");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter(file => file.endsWith(".json"))) {
        const id = name.slice(0, -5);
        if (live.has(id)) continue;
        const info = load(threadId, id);
        if (info?.state !== "running") continue;
        if (info.lstart && lstartOf(info.pid) === info.lstart) { try { process.kill(-info.pid, "SIGKILL"); reaped.push(id); } catch { /* gone */ } }
        info.state = "lost"; info.reason = "host-restart"; info.endedAt = Date.now();
        persist(threadId, info);
      }
    }
    return reaped;
  }
  return { start, status, stop, list, killThread, killAll, reap };
}
export type BackgroundCommands = ReturnType<typeof createBackgroundCommands>;
