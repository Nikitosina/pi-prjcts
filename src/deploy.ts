import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureHost, health, request } from "./client.ts";
import { errorText, home, listProjects, saveJson } from "./state.ts";
import { sendOwnerMessage } from "./telegram.ts";

const exec = promisify(execFile);

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

type DeployState = {
  lastGood?: string;
  /** When the owner asked to deploy while work was running; the deploy starts at the next idle moment, window or not. */
  queuedAt?: number;
  lastIdleAttemptDay?: string;
  lastResult?: { at: number; ok: boolean; sha: string; message: string };
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

export const queueDeploy = () => writeDeployState({ queuedAt: Date.now() });
export const clearQueuedDeploy = () => writeDeployState({ queuedAt: undefined });

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
  return withLock(async () => {
    const previous = readHostSha();
    if (!previous) throw new Error("The sha the running host started from is unknown; deploy refused (restart the host once to record it)");
    if (await git("status", "--porcelain", "--untracked-files=no"))
      throw new Error("The pi-prjcts checkout has uncommitted changes; deploy refused");
    const sha = await git("rev-parse", "HEAD");
    const lockfileChanged = async (from: string, to: string) =>
      Boolean(await git("diff", "--name-only", from, to, "--", "package-lock.json")) || !existsSync(join(deps.repo, "node_modules"));
    const fail = async (result: DeployResult & { ok: false }) => {
      writeDeployState({ lastResult: { at: Date.now(), ok: false, sha, message: result.reason } });
      await deps.tell(`Deploy of ${sha.slice(0, 8)} failed: ${result.reason}`).catch(() => {});
      return result;
    };
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
    let reason: string | undefined;
    try {
      await deps.stopHost();
      if (changed) await run("npm", ["ci"], deps.repo);
      await deps.startHost();
      reason = await deps.smoke();
    } catch (error) {
      reason = errorText(error);
    }
    if (!reason) {
      writeDeployState({ lastGood: sha, lastResult: { at: Date.now(), ok: true, sha, message: "deployed" } });
      await deps.tell(`Deployed ${sha.slice(0, 8)}; the host passed its smoke test.`).catch(() => {});
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
  });
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

/** One idle-deploy tick: deploys once per day inside the window when new code is waiting and nothing is running. `start` launches the detached deploy. */
export async function idleDeployTick(options: {
  now: Date;
  window?: DeployWindow;
  idle: () => boolean | Promise<boolean>;
  /** True when the checkout is at a sha the host is not running. */
  pending: () => boolean | Promise<boolean>;
  start: () => void;
}): Promise<"started" | "outside-window" | "already-tried" | "busy" | "nothing-to-deploy"> {
  if (!inDeployWindow(options.now, options.window)) return "outside-window";
  const day = options.now.toDateString();
  if (readDeployState().lastIdleAttemptDay === day) return "already-tried";
  if (!(await options.pending())) return "nothing-to-deploy";
  if (!(await Promise.resolve(options.idle()).catch(() => false))) return "busy";
  writeDeployState({ lastIdleAttemptDay: day });
  options.start();
  return "started";
}

/** True when the checkout HEAD differs from the sha the host started from. */
export async function deployPending(repo: string, run: RunCommand = defaultRun): Promise<boolean> {
  const running = readHostSha();
  return !running || running !== (await run("git", ["rev-parse", "HEAD"], repo));
}
