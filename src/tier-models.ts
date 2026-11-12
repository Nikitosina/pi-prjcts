import { quotaResetAt } from "./usage-limits.ts";

/** Models whose turn just failed on quota, and until when; host-wide and in memory, so a restart pays one failed turn again. */
const failedUntil = new Map<string, number>();

/** A turn on `model` failed on quota: skip it for new agents and moves until `until`. */
export function noteQuotaFailure(model: string, until: number): void {
  failedUntil.set(model, Math.max(until, failedUntil.get(model) ?? 0));
}

const spent = (model: string, now: number) => (failedUntil.get(model) ?? 0) > now || quotaResetAt(model, now) !== undefined;

/** The model a tier starts an agent on: its first with quota left, else its first. */
export function tierStart(chain: readonly string[], now = Date.now()): string {
  return chain.find((model) => !spent(model, now)) ?? chain[0]!;
}

/** The model after `from` to move to after a quota or rate-limit failure: the next with quota left, else the next; undefined at the tier's end. */
export function tierNext(chain: readonly string[], from: string, now = Date.now()): string | undefined {
  const rest = chain.slice(chain.indexOf(from) + 1);
  return rest.find((model) => !spent(model, now)) ?? rest[0];
}
