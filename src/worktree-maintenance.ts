import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { DurablePlanning, type PlanningState } from "./durable-planning.ts";
import { githubRead } from "./github-authorization.ts";
import { retireWorkspaceReceipt, workspaceReceipts } from "./workspace-isolation.ts";
import type { Project } from "./state.ts";
import { arcLeaseOwner, arcReadHeadName, arcReadHeads, arcWorkerFacts, removeArcWorktree } from "./arc-worktrees.ts";
import { findVcsRoot } from "./vcs.ts";

/* Worktree lifecycle around the frozen isolation receipts: a per-project setup command after allocation (C4),
 * read-only PR-head snapshots for scouts/reviewers (C3), and safe cleanup of settled worktrees (C9).
 * Cleanup never forces, never deletes a branch, and keeps anything dirty, unpushed, active or with an open PR. */

type Run = { code: number; stdout: string; stderr: string };
const PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
function run(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise(done => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? { PATH, HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: options.timeoutMs !== undefined });
    let stdout = "", stderr = "";
    const cap = (value: string, part: Buffer) => (value + part.toString()).slice(-65536);
    child.stdout.on("data", part => { stdout = cap(stdout, part); }); child.stderr.on("data", part => { stderr = cap(stderr, part); });
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { stderr += `\nTimed out after ${options.timeoutMs} ms`; try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, options.timeoutMs);
    child.on("error", error => { if (timer) clearTimeout(timer); done({ code: -1, stdout, stderr: String(error) }); });
    child.on("close", code => { if (timer) clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }); });
  });
}
const git = (cwd: string, ...args: string[]) => run("/usr/bin/git", ["-C", cwd, ...args]);

// ---- C4: setup command ----
export type SetupRecord = { command: string; workspacePath: string; exitCode: number; ok: boolean; output: string; startedAt: number; endedAt: number };
const setupFile = (controlRoot: string, intentId: string) => join(controlRoot, "worktree-setup", `${intentId}.json`);
export function setupRecord(controlRoot: string, intentId: string): SetupRecord | null { try { return JSON.parse(readFileSync(setupFile(controlRoot, intentId), "utf8")) as SetupRecord; } catch { return null; } }
/** Runs the project's setup command once per allocated worktree; the result is recorded and returned as worker instruction text. */
/** `cwd` (default: the worktree root) is where the command runs; PI_WORKTREE is always the root. */
export async function worktreeSetup(input: { command: string | undefined; controlRoot: string; intentId: string; workspacePath: string; cwd?: string }): Promise<string> {
  const command = input.command?.trim();
  let record = setupRecord(input.controlRoot, input.intentId);
  if (!record && command) {
    const startedAt = Date.now();
    const result = await run("/bin/sh", ["-c", command], { cwd: input.cwd ?? input.workspacePath, env: { ...process.env, PI_WORKTREE: input.workspacePath }, timeoutMs: Number(process.env.PI_PROJECTS_SETUP_TIMEOUT_MS) || 900_000 });
    record = { command, workspacePath: input.workspacePath, exitCode: result.code, ok: result.code === 0, output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim().slice(-4000), startedAt, endedAt: Date.now() };
    mkdirSync(join(input.controlRoot, "worktree-setup"), { recursive: true, mode: 0o700 });
    writeFileSync(setupFile(input.controlRoot, input.intentId), JSON.stringify(record, null, 2), { mode: 0o600 });
  }
  if (!record) return "";
  return record.ok ? `Worktree setup ran when this worktree was created: \`${record.command}\` (exit 0).` : `Worktree setup FAILED when this worktree was created: \`${record.command}\` exited ${record.exitCode}. Output tail:\n${record.output.slice(-1500)}\nFix or rerun it before relying on installed dependencies, and say so in your result.`;
}

// ---- C3: PR-head snapshots ----
const REF = /^(?:pull\/[1-9][0-9]{0,8}|[0-9a-f]{7,40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;
/** Fetches a branch, pull/<n> or SHA from origin into <controlRoot>/read-heads/<sha> (detached, deduplicated by commit). */
export function readHeads(checkout: string, controlRoot: string, arc?: { projectId: string; project: () => Project }) {
  // An Arc project reads PR heads from leased arc-wt worktrees instead of git fetch.
  if (arc && existsSync(checkout) && findVcsRoot(checkout)?.kind === "arc") return arcReadHeads({ checkout, controlRoot, projectId: arc.projectId, project: arc.project });
  let queue: Promise<unknown> = Promise.resolve();
  async function ensure(ref: string): Promise<{ root: string; sha: string }> {
    if (!REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock") || ref.includes("@{")) throw new Error(`Invalid ref ${JSON.stringify(ref)}: use a branch name, pull/<number> or a commit SHA`);
    const operation = queue.then(async () => {
      const local = `refs/pi-read/${createHash("sha256").update(ref).digest("hex").slice(0, 16)}`;
      const source = ref.startsWith("pull/") ? `refs/${ref}/head` : /^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`;
      const fetched = await git(checkout, "fetch", "--no-tags", "--quiet", "origin", `+${source}:${local}`);
      let sha = fetched.code === 0 ? (await git(checkout, "rev-parse", "--verify", `${local}^{commit}`)).stdout.trim() : "";
      if (!/^[0-9a-f]{40}$/.test(sha)) sha = (await git(checkout, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Ref ${ref} was not found on origin or locally${fetched.stderr ? `: ${fetched.stderr.trim().slice(-300)}` : ""}`);
      return { root: await snapshot(sha), sha };
    });
    queue = operation.catch(() => {});
    return operation;
  }
  async function snapshot(sha: string): Promise<string> {
    const dir = join(controlRoot, "read-heads"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const root = join(realpathSync(dir), sha);
    if (existsSync(join(root, ".git"))) return root;
    const added = await git(checkout, "worktree", "add", "--detach", "--quiet", root, sha);
    if (added.code !== 0) throw new Error(`Could not create a read-only snapshot of ${sha.slice(0, 12)}: ${added.stderr.trim().slice(-300)}`);
    return root;
  }
  /** Recreates a cleaned-up snapshot for a thread that is read again later. */
  async function restore(sha: string): Promise<string> { const operation = queue.then(() => snapshot(sha)); queue = operation.catch(() => {}); return operation; }
  return { ensure, restore };
}

// ---- C9: inventory and cleanup ----
export type WorktreeItem = { kind: "worker" | "read-head"; path: string; threadId: string | null; branch: string | null; sizeKb: number; removable: boolean; reasons: string[]; setup: SetupRecord | null; pullRequests: Array<{ number: number; state: string }>; intentId?: string; checkout: string; /** Arc worktrees are removed with arc-wt, never git. */ provider?: "arc"; leaseOwner?: string; entry?: string };
export type WorktreeInventory = { items: WorktreeItem[]; reclaimableKb: number; totalKb: number };

/** Disk use of a git worktree; -1 when unknown. Arc worktrees are virtual mounts of all of Arcadia: `du` would walk (and fetch) the monorepo, so they are never measured. */
async function sizeKb(path: string, arc = false): Promise<number> {
  if (arc) return -1;
  const result = await run("/usr/bin/du", ["-sk", path], { timeoutMs: 30_000 });
  const kb = /^(\d+)/.exec(result.stdout)?.[1];
  return result.code === 0 && kb ? Number(kb) : -1;
}
async function pullStates(project: Project, branches: string[], signal?: AbortSignal): Promise<Array<{ number: number; state: string }> | null> {
  const grant = project.githubAuthorization?.[0];
  if (!grant) return [];
  try {
    const out: Array<{ number: number; state: string }> = [];
    for (const branch of branches) {
      const rows = (await githubRead(`repos/${grant.repositoryId}/pulls?state=all&head=${encodeURIComponent(`${grant.repositoryId.split("/")[0]}:${branch}`)}&per_page=20`, signal)) as Array<{ number: number; state: string; merged_at?: string | null }>;
      if (!Array.isArray(rows)) throw new Error("Unexpected PR list");
      for (const row of rows) out.push({ number: row.number, state: row.state === "open" ? "open" : row.merged_at ? "merged" : "closed" });
    }
    return out;
  } catch { return null; }
}

export async function worktreeInventory(input: { project: Project; root: Conversation; controlRoot: string; signal?: AbortSignal }): Promise<WorktreeInventory> {
  const plan = await input.root.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(DurablePlanning, input.root.id))) as PlanningState, BACKGROUND_CONTEXT);
  const live = Object.values(plan.work).filter(work => work.status === "queued" || work.status === "running" || work.status === "interrupted");
  const busyThread = (threadId: string) => live.some(work => work.threadId === threadId || work.parentThreadId === threadId) || plan.threads[threadId]?.activeWorkId != null;
  // A worktree allocated by one thread may now belong to threads that took it over: they keep it busy too.
  const busy = (threadId: string) => busyThread(threadId) || Object.entries(plan.threads).some(([id, thread]) => thread.workspaceFrom === threadId && busyThread(id));
  const items: WorktreeItem[] = [];
  for (const receipt of await workspaceReceipts(input.root)) {
    if (receipt.state !== "allocated" || !receipt.workspacePath || !existsSync(receipt.workspacePath)) continue;
    if (receipt.scope.provider === "arc") {
      const facts = await arcWorkerFacts({ project: input.project, root: input.root, receipt, busy });
      items.push({ kind: "worker", path: receipt.workspacePath, threadId: facts.threadId, branch: facts.branch, sizeKb: await sizeKb(receipt.workspacePath, true), removable: facts.removable, reasons: facts.reasons, setup: setupRecord(input.controlRoot, receipt.intentId), pullRequests: facts.pullRequests, intentId: receipt.intentId, checkout: receipt.scope.ownerCheckout, provider: "arc", leaseOwner: receipt.scope.owner, entry: receipt.scope.workspaceName });
      continue;
    }
    if (receipt.scope.provider !== "git") continue;
    const path = receipt.workspacePath, threadId = /^durable workspace (\S+)$/.exec(receipt.scope.leaseReason)?.[1] ?? null, reasons: string[] = [];
    if (!threadId) reasons.push("not a durable worker worktree");
    else if (busy(threadId)) reasons.push("its thread has queued, running or interrupted work");
    const status = await git(path, "status", "--porcelain=v1", "--untracked-files=all");
    if (status.code !== 0) reasons.push("git status failed"); else if (status.stdout.trim()) reasons.push("uncommitted or untracked changes");
    const current = (await git(path, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    const branches = [...new Set([receipt.scope.branch, ...(current && current !== "HEAD" ? [current] : [])])];
    const refs: string[] = [];
    for (const name of branches) if ((await git(path, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)).code === 0) refs.push(`refs/heads/${name}`);
    const unpushed = await git(path, "rev-list", "--count", "HEAD", ...refs, "--not", "--remotes");
    const ahead = unpushed.code === 0 ? Number(unpushed.stdout.trim()) : NaN;
    const prs = await pullStates(input.project, branches.filter(name => name !== "main" && name !== "master"), input.signal);
    if (prs === null) reasons.push("PR state unknown (GitHub read failed)");
    else if (prs.some(pr => pr.state === "open")) reasons.push(`open PR #${prs.filter(pr => pr.state === "open").map(pr => pr.number).join(", #")}`);
    const finished = (prs ?? []).some(pr => pr.state !== "open");
    if (!finished && !(ahead === 0)) reasons.push(Number.isNaN(ahead) ? "unpushed commits unknown" : `${ahead} commit(s) not on any remote`);
    items.push({ kind: "worker", path, threadId, branch: current || receipt.scope.branch, sizeKb: await sizeKb(path), removable: reasons.length === 0, reasons, setup: setupRecord(input.controlRoot, receipt.intentId), pullRequests: prs ?? [], intentId: receipt.intentId, checkout: receipt.scope.ownerCheckout });
  }
  const heads = join(input.controlRoot, "read-heads");
  for (const name of existsSync(heads) ? readdirSync(heads) : []) {
    const path = join(realpathSync(heads), name);
    const users = Object.entries(plan.threads).filter(([, thread]) => thread.readRoot === path).map(([id]) => id);
    const reasons = users.some(busy) ? ["a scout or reviewer reading it has queued or running work"] : [];
    const arcHead = existsSync(join(path, ".arc"));
    items.push({ kind: "read-head", path, threadId: users[0] ?? null, branch: null, sizeKb: await sizeKb(path, Boolean(arcHead)), removable: reasons.length === 0, reasons, setup: null, pullRequests: [], checkout: input.project.cwd, ...(arcHead ? { provider: "arc" as const, leaseOwner: arcLeaseOwner(input.project.id), entry: arcReadHeadName(path) } : {}) });
  }
  return { items, reclaimableKb: items.filter(item => item.removable).reduce((sum, item) => sum + Math.max(0, item.sizeKb), 0), totalKb: items.reduce((sum, item) => sum + Math.max(0, item.sizeKb), 0) };
}

/** Removes every removable worktree after re-checking it; unforced for worker worktrees, branches are kept. */
export async function cleanupWorktrees(input: { project: Project; root: Conversation; controlRoot: string; signal?: AbortSignal; stillAllowed?: () => boolean }): Promise<{ removed: Array<{ path: string; sizeKb: number }>; kept: WorktreeItem[]; failed: Array<{ path: string; error: string }>; reclaimedKb: number }> {
  const before = await worktreeInventory(input);
  const removed: Array<{ path: string; sizeKb: number }> = [], failed: Array<{ path: string; error: string }> = [];
  for (const item of before.items.filter(entry => entry.removable)) {
    if (input.stillAllowed && !input.stillAllowed()) break;
    const again = (await worktreeInventory(input)).items.find(entry => entry.path === item.path);
    if (!again?.removable) continue;
    if (item.provider === "arc") {
      const gone = await removeArcWorktree(item.entry!, item.leaseOwner!);
      if (!gone.ok) { failed.push({ path: item.path, error: gone.error }); continue; }
      if (item.kind === "worker") await retireWorkspaceReceipt(input.root, item.intentId!, { remove: "cleanup-unforced", cleanedAt: new Date().toISOString(), branch: item.branch ?? "" });
    } else if (item.kind === "worker") {
      await git(item.checkout, "worktree", "unlock", item.path);
      const result = await git(item.checkout, "worktree", "remove", item.path);
      if (result.code !== 0) { await git(item.checkout, "worktree", "lock", "--reason", `workspace-intent:${item.intentId}`, item.path); failed.push({ path: item.path, error: result.stderr.trim().slice(-500) }); continue; }
      await retireWorkspaceReceipt(input.root, item.intentId!, { remove: "cleanup-unforced", cleanedAt: new Date().toISOString(), branch: item.branch ?? "" });
    } else {
      const result = await git(item.checkout, "worktree", "remove", "--force", item.path);
      if (result.code !== 0) { failed.push({ path: item.path, error: result.stderr.trim().slice(-500) }); continue; }
    }
    removed.push({ path: item.path, sizeKb: item.sizeKb });
  }
  return { removed, kept: before.items.filter(entry => !entry.removable), failed, reclaimedKb: removed.reduce((sum, item) => sum + Math.max(0, item.sizeKb), 0) };
}
