import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { Jobs, liveAgentIds } from "./jobs.ts";
import { githubRead } from "./github-authorization.ts";
import { retireWorkspaceReceipt, workspaceReceipts } from "./workspace-isolation.ts";
import type { Project } from "./state.ts";
import { findVcsRoot } from "./vcs.ts";
import { plugins } from "./plugins.ts";
import { coordinatorWorkspaceOwners } from "./coordinator-workspace-state.ts";

/* Worktree lifecycle around the frozen isolation receipts: a per-project setup command after allocation (C4)
 * and safe cleanup of settled worktrees (C9). Cleanup never deletes a branch and keeps anything dirty, unpushed, active
 * or with an open PR; a settled reader's worktree only has to be clean at the commit it was read at (C3). */

type Run = { code: number; stdout: string; stderr: string };
const PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Run> {
  options.signal?.throwIfAborted();
  return new Promise((done) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? { PATH, HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.timeoutMs !== undefined || options.signal !== undefined,
    });
    let stdout = "",
      stderr = "";
    const cap = (value: string, part: Buffer) => (value + part.toString()).slice(-65536);
    child.stdout.on("data", (part) => {
      stdout = cap(stdout, part);
    });
    child.stderr.on("data", (part) => {
      stderr = cap(stderr, part);
    });
    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stderr += `\nTimed out after ${options.timeoutMs} ms`;
            stop();
          }, options.timeoutMs);
    const clear = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    // A cancellable setup owns its descendants even if its shell exits first.
    if (options.signal) child.once("exit", stop);
    child.on("error", (error) => {
      clear();
      done({ code: -1, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clear();
      done({ code: code ?? -1, stdout, stderr });
    });
  });
}
const git = (cwd: string, ...args: string[]) => run("/usr/bin/git", ["-C", cwd, ...args]);

// ---- C4: setup command ----
export type SetupRecord = {
  command: string;
  workspacePath: string;
  exitCode: number;
  ok: boolean;
  output: string;
  startedAt: number;
  endedAt: number;
};
const setupFile = (controlRoot: string, intentId: string) => join(controlRoot, "worktree-setup", `${intentId}.json`);
export function setupRecord(controlRoot: string, intentId: string): SetupRecord | null {
  try {
    return JSON.parse(readFileSync(setupFile(controlRoot, intentId), "utf8")) as SetupRecord;
  } catch {
    return null;
  }
}
/** Runs the project's setup command once per allocated worktree; the result is recorded and returned as worker instruction text. */
/** `cwd` (default: the worktree root) is where the command runs; PI_WORKTREE is always the root. */
export async function worktreeSetup(input: {
  command: string | undefined;
  controlRoot: string;
  intentId: string;
  workspacePath: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const command = input.command?.trim();
  let record = setupRecord(input.controlRoot, input.intentId);
  if (!record && command) {
    const startedAt = Date.now();
    const result = await run("/bin/sh", ["-c", command], {
      cwd: input.cwd ?? input.workspacePath,
      env: { ...process.env, PI_WORKTREE: input.workspacePath },
      timeoutMs: Number(process.env.PI_PROJECTS_SETUP_TIMEOUT_MS) || 900_000,
      signal: input.signal,
    });
    // An interrupted setup has no completion record, so an explicit retry can finish it.
    input.signal?.throwIfAborted();
    record = {
      command,
      workspacePath: input.workspacePath,
      exitCode: result.code,
      ok: result.code === 0,
      output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim().slice(-4000),
      startedAt,
      endedAt: Date.now(),
    };
    mkdirSync(join(input.controlRoot, "worktree-setup"), { recursive: true, mode: 0o700 });
    writeFileSync(setupFile(input.controlRoot, input.intentId), JSON.stringify(record, null, 2), { mode: 0o600 });
  }
  if (!record) return "";
  return record.ok
    ? `Worktree setup ran when this worktree was created: \`${record.command}\` (exit 0).`
    : `Worktree setup FAILED when this worktree was created: \`${record.command}\` exited ${record.exitCode}. Output tail:\n${record.output.slice(-1500)}\nFix or rerun it before relying on installed dependencies, and say so in your result.`;
}

// ---- C9: inventory and cleanup ----
export type WorktreeItem = {
  kind: "worker" | "read-head" | "coordinator";
  path: string;
  threadId: string | null;
  branch: string | null;
  sizeKb: number;
  removable: boolean;
  reasons: string[];
  setup: SetupRecord | null;
  pullRequests: Array<{ number: number; state: string }>;
  intentId?: string;
  checkout: string;
  /** Worktrees of a workspace plugin provider are removed through that provider, never git. */ provider?: string;
  leaseOwner?: string;
  entry?: string;
  mountLabel?: string;
  /** A settled reader's worktree the provider may remove past its unpublished base commit. */ atBase?: true;
};
export type WorktreeInventory = { items: WorktreeItem[]; reclaimableKb: number; totalKb: number };

/** Disk use of a git worktree; -1 when unknown. Virtual mounts of a plugin provider can be huge remote trees: `du` would walk (and fetch) them, so they are never measured. */
async function sizeKb(path: string, virtualMount = false): Promise<number> {
  if (virtualMount) return -1;
  const result = await run("/usr/bin/du", ["-sk", path], { timeoutMs: 30_000 });
  const kb = /^(\d+)/.exec(result.stdout)?.[1];
  return result.code === 0 && kb ? Number(kb) : -1;
}
async function pullStates(
  project: Project,
  branches: string[],
  signal?: AbortSignal,
): Promise<Array<{ number: number; state: string }> | null> {
  const grant = project.githubAuthorization?.[0];
  if (!grant) return [];
  try {
    const out: Array<{ number: number; state: string }> = [];
    for (const branch of branches) {
      const rows = (await githubRead(
        `repos/${grant.repositoryId}/pulls?state=all&head=${encodeURIComponent(`${grant.repositoryId.split("/")[0]}:${branch}`)}&per_page=20`,
        signal,
      )) as Array<{ number: number; state: string; merged_at?: string | null }>;
      if (!Array.isArray(rows)) throw new Error("Unexpected PR list");
      for (const row of rows) out.push({ number: row.number, state: row.state === "open" ? "open" : row.merged_at ? "merged" : "closed" });
    }
    return out;
  } catch {
    return null;
  }
}

export async function worktreeInventory(input: {
  project: Project;
  root: Conversation;
  controlRoot: string;
  signal?: AbortSignal;
  /** A stopped thread that never produced an assistant turn. Its checkout at the base commit is not kept just because the branch has an open PR. */ untouched?: (
    threadId: string,
  ) => Promise<boolean>;
}): Promise<WorktreeInventory> {
  const { live, readers } = await input.root.commit(async (tx) => {
    const doc = await tx.doc(Jobs, input.root.id);
    return {
      live: new Set(liveAgentIds(doc)),
      readers: new Set(
        Object.values(doc.agents)
          .filter((agent) => agent.role !== "worker")
          .map((agent) => agent.id),
      ),
    };
  }, BACKGROUND_CONTEXT);
  const busy = (threadId: string) => live.has(threadId);
  // A reader's worktree holds no work of its own: once the reader ended, clean and at its commit is enough (R3).
  const settledReader = (threadId: string | null) => threadId !== null && readers.has(threadId) && !busy(threadId);
  const items: WorktreeItem[] = [];
  const coordinators = await coordinatorWorkspaceOwners(input.root);
  for (const receipt of await workspaceReceipts(input.root)) {
    const coordinator = coordinators.get(receipt.intentId);
    if (coordinator) {
      items.push({
        kind: "coordinator",
        path: receipt.workspacePath ?? receipt.scope.workspacePath,
        threadId: coordinator.threadId,
        branch: receipt.scope.branch,
        sizeKb: -1,
        removable: false,
        reasons: [`persistent coordinator workspace for chat ${coordinator.chatId}; retained even when idle or archived`],
        setup: setupRecord(input.controlRoot, receipt.intentId),
        pullRequests: [],
        intentId: receipt.intentId,
        checkout: receipt.scope.ownerCheckout,
        ...(receipt.scope.provider === "git" ? {} : { provider: receipt.scope.provider }),
      });
      continue;
    }
    if (receipt.state !== "allocated" || !receipt.workspacePath || !existsSync(receipt.workspacePath)) continue;
    if (receipt.scope.provider !== "git") {
      // A plugin provider's worktree; without the plugin it is kept untouched and not listed.
      const provider = plugins.workspaceProvider(receipt.scope.provider);
      if (!provider) continue;
      const facts = await provider.workerFacts({ project: input.project, root: input.root, receipt, busy });
      const reader = settledReader(facts.threadId) && facts.atBase === true;
      const reasons = reader
        ? []
        : facts.atBase && facts.threadId && input.untouched && (await input.untouched(facts.threadId))
          ? facts.reasons.filter((reason) => !reason.startsWith("open PR"))
          : facts.reasons;
      items.push({
        kind: "worker",
        path: receipt.workspacePath,
        threadId: facts.threadId,
        branch: facts.branch,
        sizeKb: await sizeKb(receipt.workspacePath, provider.virtualMount),
        removable: reasons.length === 0,
        reasons,
        setup: setupRecord(input.controlRoot, receipt.intentId),
        pullRequests: facts.pullRequests,
        intentId: receipt.intentId,
        checkout: receipt.scope.ownerCheckout,
        provider: provider.id,
        leaseOwner: receipt.scope.owner,
        entry: receipt.scope.workspaceName,
        ...(provider.mountLabel ? { mountLabel: provider.mountLabel } : {}),
        ...(reader ? { atBase: true } : {}),
      });
      continue;
    }
    const path = receipt.workspacePath,
      threadId = /^durable workspace (\S+)$/.exec(receipt.scope.leaseReason)?.[1] ?? null,
      reasons: string[] = [];
    if (!threadId) reasons.push("not a durable worker worktree");
    else if (busy(threadId)) reasons.push("its thread has queued, running or interrupted work");
    const status = await git(path, "status", "--porcelain=v1", "--untracked-files=all");
    if (status.code !== 0) reasons.push("git status failed");
    else if (status.stdout.trim()) reasons.push("uncommitted or untracked changes");
    if (settledReader(threadId)) {
      if ((await git(path, "rev-parse", "HEAD")).stdout.trim() !== receipt.scope.baseRevision)
        reasons.push("moved off the commit it was read at");
      items.push({
        kind: "worker",
        path,
        threadId,
        branch: receipt.scope.branch,
        sizeKb: await sizeKb(path),
        removable: reasons.length === 0,
        reasons,
        setup: null,
        pullRequests: [],
        intentId: receipt.intentId,
        checkout: receipt.scope.ownerCheckout,
      });
      continue;
    }
    const current = (await git(path, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    const branches = [...new Set([receipt.scope.branch, ...(current && current !== "HEAD" ? [current] : [])])];
    const refs: string[] = [];
    for (const name of branches)
      if ((await git(path, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)).code === 0) refs.push(`refs/heads/${name}`);
    const unpushed = await git(path, "rev-list", "--count", "HEAD", ...refs, "--not", "--remotes");
    const ahead = unpushed.code === 0 ? Number(unpushed.stdout.trim()) : NaN;
    const prs = await pullStates(
      input.project,
      branches.filter((name) => name !== "main" && name !== "master"),
      input.signal,
    );
    if (prs === null) reasons.push("PR state unknown (GitHub read failed)");
    else if (prs.some((pr) => pr.state === "open"))
      reasons.push(
        `open PR #${prs
          .filter((pr) => pr.state === "open")
          .map((pr) => pr.number)
          .join(", #")}`,
      );
    const head = (await git(path, "rev-parse", "HEAD")).stdout.trim();
    if (
      status.code === 0 &&
      !status.stdout.trim() &&
      head === receipt.scope.baseRevision &&
      threadId &&
      input.untouched &&
      (await input.untouched(threadId))
    ) {
      const inherited = reasons.findIndex((reason) => reason.startsWith("open PR"));
      if (inherited >= 0) reasons.splice(inherited, 1);
    }
    const finished = (prs ?? []).some((pr) => pr.state !== "open");
    if (!finished && !(ahead === 0))
      reasons.push(Number.isNaN(ahead) ? "unpushed commits unknown" : `${ahead} commit(s) not on any remote`);
    items.push({
      kind: "worker",
      path,
      threadId,
      branch: current || receipt.scope.branch,
      sizeKb: await sizeKb(path),
      removable: reasons.length === 0,
      reasons,
      setup: setupRecord(input.controlRoot, receipt.intentId),
      pullRequests: prs ?? [],
      intentId: receipt.intentId,
      checkout: receipt.scope.ownerCheckout,
    });
  }
  // Snapshots from before readers got their own worktrees (K10); a plugin's own snapshots are its cleanup step's to remove.
  const heads = join(input.controlRoot, "read-heads");
  for (const name of existsSync(heads) ? readdirSync(heads) : []) {
    const path = join(realpathSync(heads), name);
    if (!existsSync(join(path, ".git")) || findVcsRoot(path)?.kind !== "git") continue;
    items.push({
      kind: "read-head",
      path,
      threadId: null,
      branch: null,
      sizeKb: await sizeKb(path),
      removable: true,
      reasons: [],
      setup: null,
      pullRequests: [],
      checkout: input.project.cwd,
    });
  }
  return {
    items,
    reclaimableKb: items.filter((item) => item.removable).reduce((sum, item) => sum + Math.max(0, item.sizeKb), 0),
    totalKb: items.reduce((sum, item) => sum + Math.max(0, item.sizeKb), 0),
  };
}

/** Removes every removable worktree after re-checking it; unforced for worker worktrees, branches are kept. */
export async function cleanupWorktrees(input: {
  project: Project;
  root: Conversation;
  controlRoot: string;
  signal?: AbortSignal;
  stillAllowed?: () => boolean;
  untouched?: (threadId: string) => Promise<boolean>;
  /** Called before each removable worktree and once at the end. */
  onProgress?: (done: number, total: number) => void;
}): Promise<{
  removed: Array<{ path: string; sizeKb: number }>;
  kept: WorktreeItem[];
  failed: Array<{ path: string; error: string }>;
  reclaimedKb: number;
}> {
  const before = await worktreeInventory(input);
  const removed: Array<{ path: string; sizeKb: number }> = [],
    failed: Array<{ path: string; error: string }> = [];
  const removable = before.items.filter((entry) => entry.removable);
  for (const [index, item] of removable.entries()) {
    input.onProgress?.(index, removable.length);
    if (input.stillAllowed && !input.stillAllowed()) break;
    const again = (await worktreeInventory(input)).items.find((entry) => entry.path === item.path);
    if (!again?.removable) continue;
    if (item.provider) {
      const provider = plugins.workspaceProvider(item.provider);
      const gone = provider
        ? await provider.remove({ entry: item.entry!, leaseOwner: item.leaseOwner!, ...(item.atBase ? { atBase: true as const } : {}) })
        : { ok: false as const, error: `workspace provider plugin "${item.provider}" is not loaded` };
      if (!gone.ok) {
        failed.push({ path: item.path, error: gone.error });
        continue;
      }
      if (item.kind === "worker")
        await retireWorkspaceReceipt(input.root, item.intentId!, {
          remove: "cleanup-unforced",
          cleanedAt: new Date().toISOString(),
          branch: item.branch ?? "",
        });
    } else if (item.kind === "worker") {
      await git(item.checkout, "worktree", "unlock", item.path);
      const result = await git(item.checkout, "worktree", "remove", item.path);
      if (result.code !== 0) {
        await git(item.checkout, "worktree", "lock", "--reason", `workspace-intent:${item.intentId}`, item.path);
        failed.push({ path: item.path, error: result.stderr.trim().slice(-500) });
        continue;
      }
      await retireWorkspaceReceipt(input.root, item.intentId!, {
        remove: "cleanup-unforced",
        cleanedAt: new Date().toISOString(),
        branch: item.branch ?? "",
      });
    } else {
      const result = await git(item.checkout, "worktree", "remove", "--force", item.path);
      if (result.code !== 0) {
        failed.push({ path: item.path, error: result.stderr.trim().slice(-500) });
        continue;
      }
    }
    removed.push({ path: item.path, sizeKb: item.sizeKb });
  }
  input.onProgress?.(removable.length, removable.length);
  return {
    removed,
    kept: before.items.filter((entry) => !entry.removable),
    failed,
    reclaimedKb: removed.reduce((sum, item) => sum + Math.max(0, item.sizeKb), 0),
  };
}
