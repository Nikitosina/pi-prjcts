import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Version-control binaries. The environment variables are test seams: E2Es point them at fakes and never at a real Arcadia. */
export const cli = {
  git: () => "/usr/bin/git",
  arc: () => process.env.PI_PROJECTS_ARC_CLI || "/opt/homebrew/bin/arc",
  arcWt: () => process.env.PI_PROJECTS_ARC_WT_CLI || "/usr/local/bin/arc-wt",
};

/** Nearest directory above `cwd` that is a checkout root. `.arc` wins over `.git` in the same directory; a git repository nested in an Arc mount is git. */
export function findVcsRoot(cwd: string): { kind: "git" | "arc"; root: string } | null {
  for (let at = realpathSync(cwd); ; at = dirname(at)) {
    if (existsSync(join(at, ".arc"))) return { kind: "arc", root: at };
    if (existsSync(join(at, ".git"))) return { kind: "git", root: at };
    if (dirname(at) === at) return null;
  }
}

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
    const config = Object.fromEntries(step("arc-wt config", () => run(cli.arcWt(), ["config"], root)).split("\n").flatMap(line => { const match = /^([a-z_]+):\s*(.+)$/.exec(line); return match ? [[match[1], match[2].trim()]] : []; }));
    if (!config.object_store_path || config.object_store_path === "null") throw new Error("arc-wt config has no object_store_path (shared object store)");
    if (!config.worktrees_base_path || config.worktrees_base_path === "null") throw new Error("arc-wt config has no worktrees_base_path");
    const worktreesBase = home(config.worktrees_base_path), objectStore = home(config.object_store_path);
    if (!isAbsolute(worktreesBase) || inside(root, worktreesBase) || inside(worktreesBase, root)) throw new Error(`The arc-wt worktree folder ${worktreesBase} must be outside the Arc checkout ${root}`);
    if (!existsSync(objectStore)) throw new Error(`The arc-wt object store ${objectStore} does not exist`);
    // Trunk, not the owner's current branch: new workers start from trunk.
    const trunkLine = step("arc log trunk", () => run(cli.arc(), ["log", "-n", "1", "--oneline", "--no-decorate", "trunk"], root)).split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(trunkLine)) throw new Error("Could not read the trunk head with arc log (is trunk reachable?)");
    const dirty = step("arc status", () => run(cli.arc(), ["status", "--short", "."], cwd)).length > 0;
    return { ok: true, facts: { root, subpath: relative(root, realpathSync(cwd)), repository: info.repository, login: typeof info.user_login === "string" && info.user_login ? info.user_login : userInfo().username, branch: typeof info.branch === "string" ? info.branch : "", trunkHead: trunkLine, dirty, worktreesBase: existsSync(worktreesBase) ? realpathSync(worktreesBase) : worktreesBase, objectStore: realpathSync(objectStore) } };
  } catch (error) { return { ok: false, blocker: error instanceof Error ? error.message : String(error) }; }
}
