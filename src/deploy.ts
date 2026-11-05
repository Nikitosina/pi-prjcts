import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { ensureHost, health, request } from "./client.ts";
import { errorText, home, listProjects, parse, saveJson } from "./state.ts";
import { sendOwnerMessage } from "./telegram.ts";

const exec = promisify(execFile);
/** Host-level messages belong to no project; the label says so. */
const HOST_LABEL = "Pi Projects host · Deploy";
const DurableLock = Type.Object({
  packages: Type.Object({
    "node_modules/@earendil-works/pi-durable": Type.Object({ version: Type.String({ pattern: "^1\\.\\d+\\.\\d+$" }) }),
  }),
});

/** Hours of the local day, end exclusive; a window that ends before it starts wraps midnight, equal hours mean always. */
export type DeployWindow = { startHour: number; endHour: number };
export const DEFAULT_DEPLOY_WINDOW: DeployWindow = { startHour: 2, endHour: 7 };

export function inDeployWindow(now: Date, window: DeployWindow = DEFAULT_DEPLOY_WINDOW): boolean {
  const hour = now.getHours();
  if (window.startHour === window.endHour) return true;
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

/** Running tool calls get this long to finish before the stop cuts them off; Pi Durable continues the work after the start. */
export const DEPLOY_WINDOW_MS = 10_000;

/** Who asked for the running deploy: an agent's `projects_redeploy` call waits for the result under its `requestId`. */
export type DeployRequest = { requestId: string; at: number; projectId?: string; taskId?: string };
/** How the stop went: how long running tool calls held it and how many it cut off. */
export type DeployStop = { heldMs: number; cutOff: number };
type DeployState = {
  lastGood?: string;
  lastIdleAttemptDay?: string;
  current?: DeployRequest & { stop?: DeployStop };
  lastResult?: { at: number; ok: boolean; sha: string; message: string; requestId?: string; stop?: DeployStop };
};
const statePath = () => join(home(), "deploy.json");
const lockPath = () => join(home(), "deploy.lock");
export function readDeployState(): DeployState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}
const writeDeployState = (patch: Partial<DeployState>) => saveJson(statePath(), { ...readDeployState(), ...patch });

export const recordDeployRequest = (current: DeployRequest) => writeDeployState({ current });
export function recordDeployStop(stop: DeployStop): void {
  const current = readDeployState().current;
  if (current) writeDeployState({ current: { ...current, stop } });
}
/** The result names the request it answers, so a caller that restarted with the host finds its own. */
function settle(result: { ok: boolean; sha: string; message: string }): void {
  const current = readDeployState().current;
  writeDeployState({ lastResult: { at: Date.now(), ...result, requestId: current?.requestId, stop: current?.stop }, current: undefined });
}

export function deployRunning(): boolean {
  try {
    const pid = Number(readFileSync(lockPath(), "utf8"));
    process.kill(pid, 0);
    return Number.isSafeInteger(pid) && pid > 0;
  } catch {
    return false;
  }
}

/** The outcome of the deploy started for `requestId`, once its result is written; a deploy child that died says so after a grace period. */
export async function awaitDeploy(requestId: string, signal?: AbortSignal): Promise<string> {
  for (;;) {
    const state = readDeployState(),
      result = state.lastResult;
    if (result?.requestId === requestId)
      return result.ok
        ? `Deployed ${result.sha.slice(0, 8)}; the host passed its smoke test.`
        : `Deploy${result.sha ? ` of ${result.sha.slice(0, 8)}` : ""} failed: ${result.message}`;
    if (state.current?.requestId !== requestId) return "No deploy is running for this call; see deploy-snapshot.";
    // The child takes the lock a moment after the host records the request.
    if (!deployRunning() && Date.now() - state.current.at > 30_000)
      return "The deploy ended without a result; see deploy.log in the host home.";
    await sleep(500, undefined, { signal });
  }
}

/** Waits until no tool call runs, at most `windowMs`; answers how many still ran when it stopped waiting. */
export async function quietWindow(running: () => Promise<number>, windowMs = DEPLOY_WINDOW_MS): Promise<number> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const count = await running();
    if (count === 0 || Date.now() >= deadline) return count;
    await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
}

const hostShaPath = () => join(home(), "host-sha");
/** The host records the sha it started from; that is the only trustworthy rollback target. */
export const recordHostSha = (sha: string): void => writeFileSync(hostShaPath(), `${sha}\n`, { mode: 0o600 });
export const forgetHostSha = (): void => rmSync(hostShaPath(), { force: true });
export function readHostSha(): string | undefined {
  try {
    const sha = readFileSync(hostShaPath(), "utf8").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export type RunCommand = (command: string, args: string[], cwd: string) => Promise<string>;
const defaultRun: RunCommand = async (command, args, cwd) =>
  (await exec(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 })).stdout.trim();

/** Everything a deploy does to the outside world, so a test can drive it against a temporary checkout and home. */
export type DeployDeps = {
  repo: string;
  run?: RunCommand;
  stopHost(): Promise<void>;
  /** Drain admitted requests, give running tool calls the window, then stop only if still clean at sha; false fails the deploy. */
  stopForDeploy?(sha: string): Promise<boolean>;
  startHost(): Promise<void>;
  /** Undefined when the new host is healthy, else the first failed check. */
  smoke(): Promise<string | undefined>;
  tell(text: string): Promise<void>;
};
export type DeployResult = { ok: true; sha: string } | { ok: false; sha: string; rolledBack: boolean; reason: string };

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = lockPath();
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = Number.isSafeInteger(pid) && pid > 0;
    } catch {}
    if (alive) throw new Error(`A deploy is already running (pid ${pid})`);
    unlinkSync(path);
  }
  closeSync(openSync(path, "wx", 0o600));
  writeFileSync(path, String(process.pid));
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

/**
 * Restart the host from its main checkout: install and check the new sha in a separate worktree, then stop, npm ci when the lockfile changed, start, smoke.
 * A failure after the stop checks out the sha the host started from, restarts and tells the owner; the checkout stays detached there until the owner switches back.
 */
export async function deploy(deps: DeployDeps): Promise<DeployResult> {
  const run = deps.run ?? defaultRun,
    git = (...args: string[]) => run("git", args, deps.repo);
  return withLock(() =>
    // A refusal before any result still answers the request, so a waiting caller does not wait for nothing.
    unsettledThrows(async () => {
      const previous = readHostSha();
      if (!previous)
        throw new Error("The sha the running host started from is unknown; deploy refused (restart the host once to record it)");
      if (await git("status", "--porcelain", "--untracked-files=no"))
        throw new Error("The pi-prjcts checkout has uncommitted changes; deploy refused");
      const sha = await git("rev-parse", "HEAD");
      const lockfileChanged = async (from: string, to: string) =>
        Boolean(await git("diff", "--name-only", from, to, "--", "package-lock.json")) || !existsSync(join(deps.repo, "node_modules"));
      const fail = async (result: DeployResult & { ok: false }) => {
        settle({ ok: false, sha, message: result.reason });
        await deps.tell(`${HOST_LABEL}\nDeploy of ${sha.slice(0, 8)} failed: ${result.reason}`).catch(() => {});
        return result;
      };
      const schemaAt = async (revision: string) => {
        const lock = parse(DurableLock, JSON.parse(await git("show", `${revision}:package-lock.json`)));
        const version = lock.packages["node_modules/@earendil-works/pi-durable"].version;
        return Number(version.split(".")[1]) >= 4 ? 2 : 1;
      };
      if ((await schemaAt(previous)) !== (await schemaAt(sha)))
        return fail({
          ok: false,
          sha,
          rolledBack: false,
          reason:
            "Pi Durable SQLite schema changes cannot use code-only rollback. Take a consistent project-home backup and perform a manual upgrade; restore that backup before downgrading.",
        });
      const changed = await lockfileChanged(previous, sha);
      const checkDir = join(home(), "deploy-check");
      try {
        // The running host keeps its node_modules and files until the check has passed.
        rmSync(checkDir, { recursive: true, force: true });
        await git("worktree", "prune");
        await git("worktree", "add", "--detach", checkDir, sha);
        if (changed) await run("npm", ["ci"], checkDir);
        else symlinkSync(join(deps.repo, "node_modules"), join(checkDir, "node_modules"));
        await run("npm", ["run", "check"], checkDir);
      } catch (error) {
        // Nothing was stopped, so the running host is untouched.
        return fail({ ok: false, sha, rolledBack: false, reason: `preparation failed: ${errorText(error).slice(0, 600)}` });
      } finally {
        await git("worktree", "remove", "--force", checkDir).catch(() => rmSync(checkDir, { recursive: true, force: true }));
      }
      const changedDuringPreparation = () =>
        fail({ ok: false, sha, rolledBack: false, reason: "the checkout changed during preparation; nothing was stopped, deploy again" });
      try {
        if ((await git("rev-parse", "HEAD")) !== sha || (await git("status", "--porcelain", "--untracked-files=no")))
          return changedDuringPreparation();
      } catch (error) {
        return fail({ ok: false, sha, rolledBack: false, reason: `preparation failed: ${errorText(error).slice(0, 600)}` });
      }
      let reason: string | undefined;
      try {
        if (deps.stopForDeploy && !(await deps.stopForDeploy(sha))) return changedDuringPreparation();
        await deps.stopHost();
        if (changed) await run("npm", ["ci"], deps.repo);
        await deps.startHost();
        reason = await deps.smoke();
      } catch (error) {
        reason = errorText(error);
      }
      if (!reason) {
        writeDeployState({ lastGood: sha });
        settle({ ok: true, sha, message: "deployed" });
        const subject = await git("log", "-1", "--format=%s", sha).catch(() => "");
        await deps
          .tell(
            `${HOST_LABEL}\nDeployed ${sha.slice(0, 8)}${subject ? ` (${subject.slice(0, 120)})` : ""}; the host passed its smoke test.`,
          )
          .catch(() => {});
        return { ok: true, sha };
      }
      try {
        await deps.stopHost().catch(() => {});
        await git("checkout", "--detach", previous);
        if (await lockfileChanged(sha, previous)) await run("npm", ["ci"], deps.repo);
        await deps.startHost();
        const again = await deps.smoke();
        if (again) throw new Error(`the previous version also fails: ${again}`);
      } catch (error) {
        return fail({
          ok: false,
          sha,
          rolledBack: false,
          reason: `${reason}; rollback to ${previous.slice(0, 8)} failed: ${errorText(error).slice(0, 400)}. The host may be down.`,
        });
      }
      return fail({
        ok: false,
        sha,
        rolledBack: true,
        reason: `${reason}. Rolled back to ${previous.slice(0, 8)} and restarted; the checkout is detached there (git switch main to return).`,
      });
    }),
  );
}

async function unsettledThrows(attempt: () => Promise<DeployResult>): Promise<DeployResult> {
  try {
    return await attempt();
  } catch (error) {
    settle({ ok: false, sha: "", message: errorText(error) });
    throw error;
  }
}

async function waitFor(check: () => Promise<string | undefined>, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let problem: string | undefined;
  do {
    problem = await check().catch(errorText);
    if (!problem) return undefined;
    await sleep(250);
  } while (Date.now() < deadline);
  return problem;
}

/** Host control and smoke test against the host on the current PI_PROJECTS_HOME, started from `repo`. */
export function hostDeps(repo: string, options: { startAttempts?: number; smokeMs?: number } = {}): DeployDeps {
  const smokeMs = options.smokeMs ?? 30_000;
  return {
    repo,
    async stopForDeploy(sha) {
      try {
        const pid = Number(readFileSync(join(home(), "host.lock"), "utf8").trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) return true;
        process.kill(pid, 0);
      } catch {
        return true;
      }
      return ((await request({ action: "deploy-shutdown", sha }, false)) as { stopping: boolean }).stopping;
    },
    async stopHost() {
      // The host lock holds the pid; a failing health read alone does not prove the host is down.
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      let pid = 0;
      try {
        pid = Number(readFileSync(join(home(), "host.lock"), "utf8").trim());
      } catch {}
      if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return;
      const deadline = Date.now() + 120_000;
      let asked = false;
      while (alive(pid) && Date.now() < deadline) {
        if (!asked)
          asked = await request({ action: "shutdown" }, false).then(
            () => true,
            () => false,
          );
        await sleep(100);
      }
      if (alive(pid)) throw new Error("The host did not stop within 120 s");
    },
    startHost: () => ensureHost({ repo, attempts: options.startAttempts }),
    async smoke() {
      const failed = await waitFor(async () => (await health(), undefined), smokeMs);
      if (failed) return `health check failed: ${failed}`;
      for (const project of listProjects().filter((item) => !item.deleted && !item.archived)) {
        const problem = await waitFor(async () => (await request({ action: "show", id: project.id }, false), undefined), smokeMs);
        if (problem) return `project ${project.name} did not open: ${problem}`;
      }
      const telegram = (await request({ action: "telegram-snapshot" }, false)) as {
        configured: boolean;
        paired: boolean;
        polling: boolean;
      };
      if (telegram.configured && telegram.paired) {
        const problem = await waitFor(
          async () => (((await request({ action: "telegram-snapshot" }, false)) as typeof telegram).polling ? undefined : "not polling"),
          smokeMs,
        );
        if (problem) return `Telegram is not polling: ${problem}`;
      }
      const web = (await request({ action: "web" }, false)) as { url: string };
      const page = await fetch(new URL("/", web.url), { signal: AbortSignal.timeout(10_000) }).catch((error) => error as Error);
      if (page instanceof Error) return `web UI did not load: ${page.message}`;
      if (!page.ok || !(await page.text()).includes("<html")) return `web UI did not load: HTTP ${page.status}`;
      return undefined;
    },
    tell: sendOwnerMessage,
  };
}

/** One nightly tick: deploys once per day inside the window when new code is waiting; like every deploy it does not wait for idle projects. `start` launches the detached deploy. */
export async function idleDeployTick(options: {
  now: Date;
  window?: DeployWindow;
  /** True when the checkout is at a sha the host is not running. */
  pending: () => boolean | Promise<boolean>;
  start: () => void;
}): Promise<"started" | "outside-window" | "already-tried" | "nothing-to-deploy"> {
  if (!inDeployWindow(options.now, options.window)) return "outside-window";
  const day = options.now.toDateString();
  if (readDeployState().lastIdleAttemptDay === day) return "already-tried";
  if (!(await options.pending())) return "nothing-to-deploy";
  writeDeployState({ lastIdleAttemptDay: day });
  options.start();
  return "started";
}

/** True when the checkout HEAD differs from the sha the host started from. */
export async function deployPending(repo: string, run: RunCommand = defaultRun): Promise<boolean> {
  const running = readHostSha();
  return !running || running !== (await run("git", ["rev-parse", "HEAD"], repo));
}
