import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { githubCli } from "./github-authorization.ts";
import { errorText, parse, saveJson } from "./state.ts";
import type { MergeAnswer, MergeFacts, MergeProvider, MergeTarget } from "./plugin-types.ts";

/** What Approve needs from a Job record; core's Job carries more. `pr` is the provider's PR id (a number for GitHub). */
export type AcceptJob = { id: string; pr: string; candidateSha: string };

/** `auto-merge-pending`: auto-merge is armed but the wait ended; approve again later, it resumes. */
export type AcceptanceOutcome =
  | { kind: "accepted"; head: string }
  | { kind: "merged-pull-skipped"; head: string; reason: string }
  | { kind: "merge-uncertain"; detail: string }
  | { kind: "auto-merge-pending" };

/** The intent is written before the merge call so a crash leaves a trace; `merging` means the call may or may not have landed. */
export type AcceptanceIntent = { head: string; state: "merging" | "auto-merge" | "merged" };
export type AcceptanceLog = {
  read(jobId: string): AcceptanceIntent | undefined;
  write(jobId: string, intent: AcceptanceIntent): void;
  /** Forget an attempt the provider refused: nothing landed, so it must not block a later Approve. */
  clear(jobId: string): void;
};

const Intent = Type.Object({
  head: Type.String(),
  state: Type.Union([Type.Literal("merging"), Type.Literal("auto-merge"), Type.Literal("merged")]),
});

/** One file per Job under `dir`; an unreadable file throws, which refuses the approval instead of being read as "no attempt". */
export function fileAcceptanceLog(dir: string): AcceptanceLog {
  const file = (id: string) => join(dir, `${id.replace(/[^\w-]/g, "_")}.json`);
  return {
    read(jobId) {
      try {
        return parse(Intent, JSON.parse(readFileSync(file(jobId), "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(`Acceptance record for ${jobId} is unreadable; inspect the PR before approving again`, { cause: error });
      }
    },
    write(jobId, intent) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      saveJson(file(jobId), intent);
    },
    clear(jobId) {
      rmSync(file(jobId), { force: true });
    },
  };
}

/** The owner-facing line for an outcome (web and Telegram). */
export function describeAcceptance(outcome: AcceptanceOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return `Merged ${outcome.head.slice(0, 8)} and updated the main checkout.`;
    case "merged-pull-skipped":
      return `Merged ${outcome.head.slice(0, 8)}. The main checkout was not updated: ${outcome.reason}.`;
    case "merge-uncertain":
      return `The merge outcome is unknown: ${outcome.detail}. Check the PR before approving again.`;
    case "auto-merge-pending":
      return "Auto-merge is armed and waiting for the PR to become mergeable; approve again later to finish.";
  }
}

/**
 * Approve: merge the approved head (now, or when it becomes mergeable), then pull the main checkout when that is safe.
 * Once auto-merge is armed, `approve` answers `auto-merge-pending` at once and the flow finishes in the background, reporting through `finished`.
 */
export function createApprover(options: {
  provider: (job: AcceptJob) => MergeProvider;
  checkout: (job: AcceptJob) => string;
  log: AcceptanceLog;
  pollMs?: number;
  waitMs?: number;
  finished?: (job: AcceptJob, result: AcceptanceOutcome | Error) => void;
}) {
  const inflight = new Map<string, Promise<AcceptanceOutcome>>();
  const pollMs = options.pollMs ?? 30_000,
    waitMs = options.waitMs ?? 6 * 3_600_000;

  async function run(job: AcceptJob, signal: AbortSignal, armed: () => void): Promise<AcceptanceOutcome> {
    const provider = options.provider(job),
      target: MergeTarget = { checkout: options.checkout(job), pr: job.pr, signal },
      head = job.candidateSha;
    const prior = options.log.read(job.id);
    if (prior?.state === "merged" && prior.head !== head) throw new Error("This Job was already merged at a different head");
    // A refusal means nothing landed, so its record must not block a later attempt.
    const refuse = (message: string): never => {
      options.log.clear(job.id);
      throw new Error(message);
    };
    let facts = await provider.inspect(target);
    const exact = (current: MergeFacts) => {
      if (current.head !== head)
        throw new Error(`PR head ${current.head.slice(0, 12)} is not the approved ${head.slice(0, 12)}; nothing merged`);
    };
    exact(facts);
    const uncertain = (detail: string): AcceptanceOutcome => ({ kind: "merge-uncertain", detail });
    if (facts.state === "closed") throw new Error("The PR is closed without a merge");

    if (facts.state === "open") {
      if (facts.draft) {
        if (!provider.markReady) throw new Error("The PR is still a draft");
        const ready = await provider.markReady(target);
        if (!ready.ok) throw new Error(`Could not mark the draft PR ready: ${ready.refused}`);
      }
      if (facts.mergeable === "no") throw new Error("The PR has conflicts and cannot merge");
      const direct = async (): Promise<AcceptanceOutcome | "merged"> => {
        options.log.write(job.id, { head, state: "merging" });
        let answer: MergeAnswer;
        try {
          answer = await provider.merge({ ...target, head });
        } catch (error) {
          // The call may have landed; the PR itself is the only truth.
          const after = await provider.inspect(target).catch(() => undefined);
          if (after?.state === "merged" && after.head === head) return "merged";
          return uncertain(`The merge call failed (${errorText(error)}) and the PR could not be confirmed ${after?.state ?? "unread"}`);
        }
        if (!answer.ok) return refuse(`Merge refused: ${answer.refused}`);
        return "merged";
      };
      if (facts.mergeable === "yes") {
        const done = await direct();
        if (done !== "merged") return done;
      } else {
        const arming = await provider.enableAutoMerge({ ...target, head });
        if (!arming.ok) return refuse(`Auto-merge refused: ${arming.refused}`);
        if (!arming.waiting) {
          const done = await direct();
          if (done !== "merged") return done;
        } else {
          options.log.write(job.id, { head, state: "auto-merge" });
          armed();
          const deadline = Date.now() + waitMs;
          for (;;) {
            await sleep(pollMs, undefined, { signal });
            facts = await provider.inspect(target);
            exact(facts);
            if (facts.state === "merged") break;
            if (facts.state === "closed") throw new Error("The PR was closed while waiting for auto-merge");
            if (Date.now() >= deadline) return { kind: "auto-merge-pending" };
          }
        }
      }
    }
    options.log.write(job.id, { head, state: "merged" });
    const pulled = await provider.pullMain({ checkout: target.checkout, base: facts.base, signal }).catch((error) => ({
      pulled: false as const,
      reason: errorText(error),
    }));
    return pulled.pulled ? { kind: "accepted", head } : { kind: "merged-pull-skipped", head, reason: pulled.reason };
  }

  return {
    /** One flow per Job at a time; a second Approve (double tap) joins the running one. */
    approve(job: AcceptJob, signal: AbortSignal = new AbortController().signal): Promise<AcceptanceOutcome> {
      const running = inflight.get(job.id);
      if (running) return running;
      let early = false;
      let settleFirst!: { resolve(value: AcceptanceOutcome): void; reject(error: unknown): void };
      const first = new Promise<AcceptanceOutcome>((resolve, reject) => (settleFirst = { resolve, reject }));
      const done = () => inflight.delete(job.id);
      void run(job, signal, () => {
        early = true;
        settleFirst.resolve({ kind: "auto-merge-pending" });
      }).then(
        (outcome) => (done(), early ? options.finished?.(job, outcome) : settleFirst.resolve(outcome)),
        (error) => (done(), early ? options.finished?.(job, error as Error) : settleFirst.reject(error)),
      );
      inflight.set(job.id, first);
      return first;
    },
  };
}

const exec = promisify(execFile);
const View = Type.Object({
  state: Type.String(),
  isDraft: Type.Boolean(),
  headRefOid: Type.String(),
  baseRefName: Type.String(),
  mergeStateStatus: Type.String(),
  mergeable: Type.String(),
});

/** Merge capability for GitHub checkouts through the owner's gh; every merge is pinned to the approved head with --match-head-commit. */
export function githubMergeProvider(): MergeProvider {
  const gh = (target: MergeTarget, args: string[]) =>
    exec(githubCli(), args, { cwd: target.checkout, signal: target.signal, timeout: 60_000, maxBuffer: 1048576, encoding: "utf8" });
  // gh exiting non-zero means GitHub answered; a kill or timeout means nobody knows.
  const answer = async (call: Promise<unknown>): Promise<MergeAnswer> => {
    try {
      await call;
      return { ok: true };
    } catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: string };
      if (typeof failure.code !== "number" || failure.killed || failure.signal) throw error;
      return { ok: false, refused: (failure.stderr || errorText(error)).trim().split("\n")[0].slice(0, 300) };
    }
  };
  const git = (checkout: string, signal: AbortSignal, ...args: string[]) =>
    exec("git", ["-C", checkout, ...args], { signal, timeout: 120_000, encoding: "utf8" }).then((out) => out.stdout.trim());
  return {
    kind: "git",
    async inspect(target) {
      const view = parse(
        View,
        JSON.parse(
          (await gh(target, ["pr", "view", target.pr, "--json", "state,isDraft,headRefOid,baseRefName,mergeStateStatus,mergeable"])).stdout,
        ),
      );
      const state = view.state === "MERGED" ? "merged" : view.state === "CLOSED" ? "closed" : "open";
      const mergeable =
        view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY"
          ? "no"
          : ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(view.mergeStateStatus)
            ? "yes"
            : "later";
      return { state, draft: view.isDraft, head: view.headRefOid, base: view.baseRefName, mergeable };
    },
    markReady: (target) => answer(gh(target, ["pr", "ready", target.pr])),
    merge: (input) => answer(gh(input, ["pr", "merge", input.pr, "--squash", "--match-head-commit", input.head])),
    async enableAutoMerge(input) {
      const result = await answer(gh(input, ["pr", "merge", input.pr, "--auto", "--squash", "--match-head-commit", input.head]));
      // GitHub rejects auto-merge on a PR that can merge right now; the caller merges instead.
      if (!result.ok && /clean status/i.test(result.refused)) return { ok: true, waiting: false };
      return result.ok ? { ok: true, waiting: true } : result;
    },
    async pullMain({ checkout, base, signal }) {
      try {
        if (await git(checkout, signal, "status", "--porcelain")) return { pulled: false, reason: "the checkout has uncommitted changes" };
        const branch = await git(checkout, signal, "branch", "--show-current");
        if (branch !== base) return { pulled: false, reason: `the checkout is on ${branch || "a detached head"}, not ${base}` };
        const remoteDefault = await git(checkout, signal, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "");
        if (remoteDefault && remoteDefault !== `origin/${base}`)
          return { pulled: false, reason: `${base} is not the default branch (${remoteDefault})` };
        await git(checkout, signal, "pull", "--ff-only");
        return { pulled: true };
      } catch (error) {
        return { pulled: false, reason: `git pull failed: ${errorText(error).split("\n")[0]}` };
      }
    },
  };
}
