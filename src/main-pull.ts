import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { errorText } from "./state.ts";
import type { MergeProvider } from "./plugin-types.ts";

/** A main-checkout pull: done, or not done with the reason (a skip such as a dirty checkout, or a failure). */
export type MainPull = Awaited<ReturnType<MergeProvider["pullMain"]>>;

export const describeMainPull = (pull: MainPull): string =>
  pull.pulled ? "main checkout pulled" : `main checkout not pulled: ${pull.reason}`;

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
  const work = before.then(async (): Promise<MainPull> => {
    if (signal.aborted) return ended();
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
