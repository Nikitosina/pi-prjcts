import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { Conversation } from "@earendil-works/pi-durable";
import { arcanum } from "./arcanum.ts";
import { arcPublishedPullRequests } from "./arc-worker.ts";
import { arcWtConfig, cli, runCli } from "./vcs.ts";
import type { Project } from "./state.ts";
import type { WorkspaceReceipt } from "./workspace-types.ts";

/* Arc counterparts of the git worktree maintenance: leased read-only PR-head worktrees for scouts and reviewers, and cleanup of settled worker worktrees.
 * Removal is always `arc-wt lease renew` then `remove --lease-owner --lease-renewed` (guarded by arc-wt); never --force; foreign leases are never touched. */
const HEX40 = /^[0-9a-f]{40}$/;
const REF = /^(?:pull\/[1-9][0-9]{0,8}|[1-9][0-9]{0,8}|[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;
export const arcLeaseOwner = (projectId: string) => `pi-projects:${projectId}`;
const clip = (text: string, max = 300) => text.trim().slice(-max);

/** The arc-wt entry `name` as porcelain facts (null when absent or malformed). */
export async function arcEntry(name: string): Promise<Record<string, string> | null> {
  const listed = await runCli(cli.arcWt(), ["list", name, "--porcelain", "--verbose"]);
  if (listed.code) return null;
  const blocks = listed.stdout.trim().split("\n\n").filter(Boolean);
  if (blocks.length !== 1) return null;
  const entry: Record<string, string> = {};
  for (const line of blocks[0].split("\n")) { const at = line.indexOf(" "); if (at > 0) entry[line.slice(0, at)] = line.slice(at + 1); }
  return entry.name === name ? entry : null;
}
/** Fenced, unforced removal; the worktree and branch are kept on any doubt. */
export async function removeArcWorktree(name: string, leaseOwner: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const renewed = await runCli(cli.arcWt(), ["lease", "renew", name, "--owner", leaseOwner]);
  if (renewed.code) return { ok: false, error: `lease renew failed: ${clip(renewed.stderr)}` };
  const entry = await arcEntry(name);
  if (!entry || entry["lease-owner"] !== leaseOwner || !entry["lease-renewed"]) return { ok: false, error: "the lease is not held by this project" };
  const removed = await runCli(cli.arcWt(), ["remove", name, "--lease-owner", leaseOwner, "--lease-renewed", entry["lease-renewed"]]);
  return removed.code ? { ok: false, error: `arc-wt remove refused: ${clip(removed.stderr)}` } : { ok: true };
}

type Item = { threadId: string | null; branch: string | null; removable: boolean; reasons: string[]; pullRequests: Array<{ number: number; state: string }> };
/** Inventory facts of one allocated Arc worker worktree (same rules as git: keep dirty, unpushed, active, or open-PR work). */
export async function arcWorkerFacts(input: { project: Project; root: Conversation; receipt: WorkspaceReceipt; busy: (threadId: string) => boolean }): Promise<Item> {
  const { receipt, project } = input, path = receipt.workspacePath!, scope = receipt.scope, reasons: string[] = [];
  const threadId = /thread (\S+)$/.exec(scope.leaseReason)?.[1] ?? null;
  if (!threadId) reasons.push("not a durable worker worktree"); else if (input.busy(threadId)) reasons.push("its thread has queued, running or interrupted work");
  const entry = await arcEntry(scope.workspaceName);
  if (!entry || entry["lease-owner"] !== scope.owner) reasons.push("the arc-wt lease is not held by this project");
  const status = await runCli(cli.arc(), ["status", "--short"], path);
  if (status.code) reasons.push("arc status failed"); else if (status.stdout.trim()) reasons.push("uncommitted or untracked changes");
  const info = await runCli(cli.arc(), ["info", "--json"], path);
  let head = ""; try { head = (JSON.parse(info.stdout) as { hash?: string }).hash ?? ""; } catch { /* unknown */ }
  const login = project.arcAuthorization?.login;
  let ahead: number | null = null;
  if (head && head === scope.baseRevision) ahead = 0;
  else if (head && login) { const server = await runCli(cli.arc(), ["log", "-n", "1", "--oneline", "--no-decorate", `users/${login}/${scope.branch}`], path); ahead = server.code === 0 && server.stdout.split(/\s+/)[0] === head ? 0 : 1; }
  else if (!login) reasons.push("Arcadia is not connected, so pushed state cannot be verified");
  // Arcanum lists only PRs under review, so state comes from this project's receipts and `pr get`.
  const rows = (await arcPublishedPullRequests(input.root)).filter(row => row.branch === scope.branch);
  let prs: Array<{ number: number; state: string }> | null = [];
  try { prs = await Promise.all(rows.map(async row => { const pr = await arcanum<{ status?: string; merge_commit?: string }>(["pr", "get", "--id", String(row.number)]); return { number: row.number, state: pr.merge_commit || pr.status === "merged" ? "merged" : /discard|closed|abandon/i.test(pr.status ?? "") ? "closed" : "open" }; })); } catch { prs = null; }
  if (prs === null) reasons.push("PR state unknown (Arcanum read failed)");
  else if (prs.some(pr => pr.state === "open")) reasons.push(`open PR #${prs.filter(pr => pr.state === "open").map(pr => pr.number).join(", #")}`);
  const finished = (prs ?? []).some(pr => pr.state !== "open");
  if (!finished && ahead !== 0 && login) reasons.push(ahead === null ? "unpushed commits unknown" : "commits not on the server");
  return { threadId, branch: scope.branch, removable: reasons.length === 0, reasons, pullRequests: prs ?? [] };
}

/** Read-only worktrees of PR heads: `<controlRoot>/read-heads/<sha>` as leased arc-wt entries `pi-read-<sha12>`, deduplicated by commit. */
export function arcReadHeads(input: { checkout: string; controlRoot: string; projectId: string; project: () => Project }) {
  let queue: Promise<unknown> = Promise.resolve();
  const resolveSha = async (ref: string): Promise<string> => {
    if (!REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock") || ref.includes("@{")) throw new Error(`Invalid ref ${JSON.stringify(ref)}: use a PR number, pull/<number>, a branch name or a full commit SHA`);
    const log = async (rev: string) => { const out = await runCli(cli.arc(), ["log", "-n", "1", "--oneline", "--no-decorate", rev], input.checkout); const sha = out.stdout.split(/\s+/)[0] ?? ""; return out.code === 0 && HEX40.test(sha) ? sha : null; };
    const pr = /^(?:pull\/)?([1-9][0-9]{0,8})$/.exec(ref)?.[1];
    if (pr) { const head = (await arcanum<{ commit_ids?: { head?: string } | null }>(["pr", "active-diff", "--id", pr, "--fields", "+commit_ids(head)"])).commit_ids?.head; if (head && HEX40.test(head)) return head; throw new Error(`Arcanum has no head for PR ${pr}`); }
    if (HEX40.test(ref)) { const sha = await log(ref); if (sha === ref) return sha; throw new Error(`Commit ${ref} was not found in Arcadia`); }
    const login = input.project().arcAuthorization?.login;
    for (const rev of [...(login && !ref.startsWith("users/") ? [`users/${login}/${ref}`] : []), ref]) { const sha = await log(rev); if (sha) return sha; }
    throw new Error(`Ref ${ref} was not found in Arcadia: use a PR number, pull/<number>, a branch (users/<login>/<name>) or a commit SHA`);
  };
  async function snapshot(sha: string): Promise<string> {
    const dir = join(input.controlRoot, "read-heads"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const root = join(realpathSync(dir), sha);
    if (existsSync(join(root, ".arc"))) return root;
    const name = `pi-read-${sha.slice(0, 12)}`, config = arcWtConfig(input.checkout);
    const added = await runCli(cli.arcWt(), ["add", name, "--name", name, "--path", root, "--base", sha, "--repo", config.default_repo ?? "arcadia", ...(config.object_store_path ? ["--object-store-path", config.object_store_path.replace(/^~/, process.env.HOME ?? "")] : []), "--lease-owner", arcLeaseOwner(input.projectId), "--lease-reason", `pi project read-only snapshot ${sha.slice(0, 12)}`]);
    if (added.code) throw new Error(`Could not create a read-only snapshot of ${sha.slice(0, 12)}: ${clip(added.stderr)}`);
    return root;
  }
  async function ensure(ref: string): Promise<{ root: string; sha: string }> {
    const operation = queue.then(async () => { const sha = await resolveSha(ref); return { root: await snapshot(sha), sha }; });
    queue = operation.catch(() => {});
    return operation;
  }
  async function restore(sha: string): Promise<string> { const operation = queue.then(() => snapshot(sha)); queue = operation.catch(() => {}); return operation; }
  return { ensure, restore };
}
/** arc-wt entry name of a read-head directory. */
export const arcReadHeadName = (path: string) => `pi-read-${basename(path).slice(0, 12)}`;
