import { RateLimitedError, type ListCache, type ListCacheOptions } from "./plugin-types.ts";

const ttlMs = () => Number(process.env.PI_PROJECTS_PR_TTL_MS) || 120_000;
const backoffBaseMs = () => Number(process.env.PI_PROJECTS_PR_BACKOFF_MS) || 60_000;
export const clip = (text: unknown, max: number) => { const value = String(text ?? "").replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

type Entry<T> = { at: number; retryAt: number; items: T[]; error: string | null; flight: Promise<void> | null };

/**
 * Shared, cached, rate-limit-aware list reads for a PR provider: one fetch serves every project and browser.
 * Concurrent callers share one call; a failure keeps the last good rows with the error; a rate limit blocks all fetches with growing, jittered backoff.
 */
export function createListCache<T>(options: ListCacheOptions<T>): ListCache<T> {
  const entries = new Map<string, Entry<T>>();
  let blockedUntil = 0, rateFailures = 0;
  const backoff = (): void => { rateFailures = Math.min(rateFailures + 1, 5); blockedUntil = Date.now() + Math.min(900_000, backoffBaseMs() * 2 ** (rateFailures - 1)) * (1 + Math.random() * 0.25); };
  const limited = `${options.label} rate limit reached; retrying later`;
  const fail = (error: unknown): string => { if (error instanceof RateLimitedError) { backoff(); return limited; } return clip(error instanceof Error ? error.message : String(error), 200); };
  async function refill(key: string, entry: Entry<T>, force: boolean): Promise<void> {
    try {
      entry.items = await options.fetch(key, { force, backoff, blocked: () => Date.now() < blockedUntil });
      entry.error = null; entry.at = Date.now(); entry.retryAt = 0; rateFailures = 0;
    } catch (error) { entry.error = fail(error); entry.retryAt = Date.now() + 15_000; }
  }
  async function list(key: string, listOptions: { force?: boolean } = {}) {
    const entry = entries.get(key) ?? { at: 0, retryAt: 0, items: [], error: null, flight: null };
    entries.set(key, entry);
    const blocked = Date.now() < blockedUntil, fresh = (entry.at > 0 && Date.now() - entry.at < ttlMs()) || Date.now() < entry.retryAt;
    if (!entry.flight && !blocked && (listOptions.force || !fresh)) entry.flight = refill(key, entry, listOptions.force === true).finally(() => { entry.flight = null; });
    await entry.flight;
    const until = Date.now() < blockedUntil ? blockedUntil : null;
    return { items: entry.items, fetchedAtMs: entry.at || null, error: entry.error ?? (until ? limited : null), rateLimitedUntilMs: until };
  }
  return { list };
}
export { RateLimitedError };
