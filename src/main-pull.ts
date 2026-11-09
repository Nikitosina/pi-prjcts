import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { errorText } from "./state.ts";
import type { MergeProvider } from "./plugin-types.ts";

/** What a pull that moved the host's own checkout did about the running host: deployed it, queued it behind a running deploy, or why not. */
export type SelfDeploy =
  { kind: "started"; sha: string } | { kind: "waiting"; sha: string } | { kind: "not-started"; sha: string; reason: string };
/** A main-checkout pull: done, or not done with the reason (a skip such as a dirty checkout, or a failure). `deploy` only for the host's own checkout. */
export type MainPull = Awaited<ReturnType<MergeProvider["pullMain"]>> & { deploy?: SelfDeploy };

export function describeSelfDeploy(deploy: SelfDeploy): string {
  const what = `host deploy of ${deploy.sha.slice(0, 8)}`;
  switch (deploy.kind) {
    case "started":
      return `${what} started`;
    case "waiting":
      return `${what} waits for the running deploy`;
    case "not-started":
      return `${what} not started: ${deploy.reason}`;
  }
}
export const describeMainPull = (pull: MainPull): string =>
  (pull.pulled ? "main checkout pulled" : `main checkout not pulled: ${pull.reason}`) +
  (pull.deploy ? `; ${describeSelfDeploy(pull.deploy)}` : "");

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Tail of the pulls queued per real checkout path; host-wide, so Approve and Follow PRs never pull one checkout at once. */
const queues = new Map<string, Promise<void>>();
const keyOf = (checkout: string) => {
  try {
    return realpathSync(checkout);
  } catch {
    return resolve(checkout);
  }
};

type SelfCheckout = { key: string; head(): Promise<string>; running(): string | undefined; deploy(sha: string): SelfDeploy };
let self: SelfCheckout | undefined;
/**
 * The host names the checkout it runs from. A pull of it that moves HEAD to a commit the host is not running asks `deploy`, which must only
 * start the detached deploy, never wait for it. Returns the undo.
 */
export function watchSelfCheckout(input: Omit<SelfCheckout, "key"> & { root: string }): () => void {
  const watched: SelfCheckout = { key: keyOf(input.root), head: input.head, running: input.running, deploy: input.deploy };
  self = watched;
  return () => {
    if (self === watched) self = undefined;
  };
}

/**
 * Fast-forwards a project's main checkout through its merge provider, one pull per checkout at a time. Without `base` the PR's base comes from
 * `inspect` (`pr` is needed then). Bounded by `timeoutMs` and `signal`; never throws, so callers can report the outcome and go on.
 */
export async function pullMainCheckout(input: {
  provider: Pick<MergeProvider, "pullMain"> & Partial<Pick<MergeProvider, "inspect">>;
  checkout: string;
  base?: string;
  pr?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<MainPull> {
  const ms = input.timeoutMs ?? (Number(process.env.PI_PROJECTS_MAIN_PULL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    timeout = AbortSignal.timeout(ms),
    signal = AbortSignal.any([input.signal, timeout]);
  const ended = (): MainPull => ({
    pulled: false,
    reason: timeout.aborted ? `timed out after ${ms / 1000} s` : "the host is shutting down",
  });
  const key = keyOf(input.checkout),
    before = queues.get(key) ?? Promise.resolve();
  const pull = async (): Promise<MainPull> => {
    let base = input.base;
    if (!base) {
      if (!input.provider.inspect || !input.pr) return { pulled: false, reason: "the PR's base branch is unknown" };
      try {
        base = (await input.provider.inspect({ checkout: input.checkout, pr: input.pr, signal })).base;
      } catch (error) {
        return signal.aborted ? ended() : { pulled: false, reason: `could not read the PR's base branch: ${errorText(error)}` };
      }
    }
    try {
      return await input.provider.pullMain({ checkout: input.checkout, base, signal });
    } catch (error) {
      return signal.aborted ? ended() : { pulled: false, reason: `pull failed: ${errorText(error).split("\n")[0]}` };
    }
  };
  const work = before.then(async (): Promise<MainPull> => {
    if (signal.aborted) return ended();
    const watched = self?.key === key ? self : undefined;
    if (!watched) return pull();
    // Read inside the queue, so the comparison sees only this pull's move.
    const from = await watched.head().catch(() => undefined);
    const pulled = await pull();
    if (!pulled.pulled) return pulled;
    const to = await watched.head().catch(() => undefined);
    if (!from || !to) return { ...pulled, deploy: { kind: "not-started", sha: to ?? "", reason: "the checkout's HEAD could not be read" } };
    if (from === to || to === watched.running()) return pulled;
    try {
      return { ...pulled, deploy: watched.deploy(to) };
    } catch (error) {
      return { ...pulled, deploy: { kind: "not-started", sha: to, reason: errorText(error) } };
    }
  });
  // The next pull waits for this one to settle, even past this caller's timeout: a provider that ignores the signal must not overlap.
  const tail = work.then(
    () => {},
    () => {},
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  const stopped = new Promise<MainPull>((done) => {
    if (signal.aborted) done(ended());
    else signal.addEventListener("abort", () => done(ended()), { once: true });
  });
  return Promise.race([work, stopped]);
}
