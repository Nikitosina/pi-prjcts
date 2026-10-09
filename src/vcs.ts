import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Version-control binaries. The environment variables are test seams: E2Es point them at fakes and never at a real Arcadia. */
export const cli = {
  git: () => "/usr/bin/git",
  arc: () => process.env.PI_PROJECTS_ARC_CLI || "/opt/homebrew/bin/arc",
  arcWt: () => process.env.PI_PROJECTS_ARC_WT_CLI || "/usr/local/bin/arc-wt",
  /** Argv prefix of the Arcanum client (`ya tool arcanum`); the test seam is a single fake executable. */
  /** `ya` itself (only `ya whoami` is run through it); the test seam is a single fake executable. */
  ya: () => process.env.PI_PROJECTS_YA_CLI || "/usr/local/bin/ya",
  arcanum: (): string[] => process.env.PI_PROJECTS_ARCANUM_CLI ? [process.env.PI_PROJECTS_ARCANUM_CLI] : ["/usr/local/bin/ya", "tool", "arcanum"],
};

/** Nearest directory above `cwd` that is a checkout root. `.arc` wins over `.git` in the same directory; a git repository nested in an Arc mount is git. */
export function findVcsRoot(cwd: string): { kind: "git" | "arc"; root: string } | null {
  for (let at = realpathSync(cwd); ; at = dirname(at)) {
    if (existsSync(join(at, ".arc"))) return { kind: "arc", root: at };
    if (existsSync(join(at, ".git"))) return { kind: "git", root: at };
    if (dirname(at) === at) return null;
  }
}

/** `arc-wt config` as key/value pairs (worktrees_base_path, object_store_path, default_repo, ...). */
export const arcWtConfig = (cwd?: string): Record<string, string> => Object.fromEntries(run(cli.arcWt(), ["config"], cwd ?? process.cwd()).split("\n").flatMap(line => { const match = /^([a-z_]+):\s*(.+)$/.exec(line); return match ? [[match[1], match[2].trim()]] : []; }));
export type ArcFacts = { root: string; subpath: string; repository: string; login: string; branch: string; trunkHead: string; dirty: boolean; worktreesBase: string; objectStore: string };
const run = (file: string, args: string[], cwd: string) => execFileSync(file, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const home = (path: string) => resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };

/** Reads everything a grant needs from `arc`/`arc-wt` (read-only commands); a failure is a blocker message for the owner, never a throw. */
export function arcFacts(cwd: string, walkedRoot: string): { ok: true; facts: ArcFacts } | { ok: false; blocker: string } {
  const step = <T>(what: string, fn: () => T): T => { try { return fn(); } catch (error) { throw new Error(`${what} failed: ${error instanceof Error ? (error as { stderr?: string }).stderr?.trim() || error.message : String(error)}`); } };
  try {
    const root = step("arc root", () => realpathSync(run(cli.arc(), ["root"], cwd)));
    if (root !== walkedRoot) throw new Error(`arc reports root ${root}, not ${walkedRoot}`);
    const info = step("arc info", () => JSON.parse(run(cli.arc(), ["info", "--json"], root)) as { repository?: unknown; user_login?: unknown; branch?: unknown });
    if (typeof info.repository !== "string" || !info.repository) throw new Error("arc info did not name the repository");
    const config = step("arc-wt config", () => arcWtConfig(root));
    if (!config.object_store_path || config.object_store_path === "null") throw new Error("arc-wt config has no object_store_path (shared object store)");
    if (!config.worktrees_base_path || config.worktrees_base_path === "null") throw new Error("arc-wt config has no worktrees_base_path");
    const worktreesBase = home(config.worktrees_base_path), objectStore = home(config.object_store_path);
    if (!isAbsolute(worktreesBase) || inside(root, worktreesBase) || inside(worktreesBase, root)) throw new Error(`The arc-wt worktree folder ${worktreesBase} must be outside the Arc checkout ${root}`);
    if (!existsSync(objectStore)) throw new Error(`The arc-wt object store ${objectStore} does not exist`);
    // Trunk, not the owner's current branch: new workers start from trunk.
    const trunkLine = step("arc log trunk", () => arcTrunkHead(root));
    const dirty = step("arc status", () => run(cli.arc(), ["status", "--short", "."], cwd)).length > 0;
    return { ok: true, facts: { root, subpath: relative(root, realpathSync(cwd)), repository: info.repository, login: typeof info.user_login === "string" && info.user_login ? info.user_login : userInfo().username, branch: typeof info.branch === "string" ? info.branch : "", trunkHead: trunkLine, dirty, worktreesBase: existsSync(worktreesBase) ? realpathSync(worktreesBase) : worktreesBase, objectStore: realpathSync(objectStore) } };
  } catch (error) { return { ok: false, blocker: error instanceof Error ? error.message : String(error) }; }
}

export type CliResult = { code: number; stdout: string; stderr: string };
/** Runs a VCS binary without throwing; the exit code is data. */
export function runCli(file: string, args: string[], cwd?: string): Promise<CliResult> {
  return new Promise(done => execFile(file, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr })));
}
/** Trunk head of an Arc checkout. */
export const arcTrunkHead = (root: string): string => { const head = run(cli.arc(), ["log", "-n", "1", "--oneline", "--no-decorate", "trunk"], root).split(/\s+/)[0] ?? ""; if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("Could not read the trunk head with arc log"); return head; };
const FETCH_TTL_MS = 60_000, FETCH_TIMEOUT_MS = 90_000, fetched = new Map<string, { at: number; head: Promise<string> }>();
/** Trunk head after `arc fetch trunk`. One fetch per checkout per minute (parallel workers share it). A failed or timed-out fetch fails visibly (never a silent stale base) and is retried on the next allocation. */
export function arcFetchedTrunkHead(root: string): Promise<string> {
  const cached = fetched.get(root);
  if (cached && Date.now() - cached.at < FETCH_TTL_MS) return cached.head;
  const head = (async () => {
    const out = await new Promise<CliResult>(done => execFile(cli.arc(), ["fetch", "trunk"], { cwd: root, encoding: "utf8", timeout: FETCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, ...(error?.killed ? { timedOut: true } : {}) } as CliResult)));
    if (out.code) throw new Error(`arc fetch trunk ${(out as CliResult & { timedOut?: boolean }).timedOut ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : "failed"}, so a new worker cannot be based on the current trunk: ${out.stderr.trim().slice(0, 300) || `exit ${out.code}`}`);
    return arcTrunkHead(root);
  })();
  fetched.set(root, { at: Date.now(), head });
  head.catch(() => { if (fetched.get(root)?.head === head) fetched.delete(root); });
  return head;
}
/** Uncommitted paths of a worktree (git or Arc, by what is found above it); null when the status cannot be read. */
export async function changedFiles(cwd: string): Promise<string[] | null> {
  const found = findVcsRoot(cwd);
  const result = found?.kind === "arc" ? await runCli(cli.arc(), ["status", "--short"], cwd) : await runCli(cli.git(), ["-C", cwd, "status", "--porcelain", "--untracked-files=normal"]);
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : null;
}

/** Names already used by arc-wt entries and arc branches (local and fetched server branches, with and without users/<login>/). Throws when either listing fails: a clash must not be guessed around. */
export async function arcTakenNames(root: string): Promise<Set<string>> {
  const [worktrees, branches] = await Promise.all([runCli(cli.arcWt(), ["list", "--porcelain"]), runCli(cli.arc(), ["branch", "--list", "--all"], root)]);
  if (worktrees.code || branches.code) throw new Error(`Could not list existing Arc worktrees and branches: ${(worktrees.stderr || branches.stderr).trim().slice(-300)}`);
  const taken = new Set<string>();
  for (const line of worktrees.stdout.split("\n")) { const match = /^(?:name|branch) (.+)$/.exec(line); if (match) taken.add(match[1]); }
  for (const line of branches.stdout.split("\n")) { const name = line.replace(/^[*\s]+/, "").split(/\s+/)[0]; if (name) { taken.add(name); taken.add(name.replace(/^users\/[^/]+\//, "")); } }
  return taken;
}
