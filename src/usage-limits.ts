import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Subscription limits for the bottom bar. Host-side only: tokens and raw provider responses stay here, the browser gets
 * normalized samples. Sources, passive first (see docs/subscription-limits.md):
 *   headers  - rate-limit headers on responses Pi already receives (pi-ai `onResponse`)
 *   endpoint - read-only GET of the provider's own usage endpoint with the login Pi or the Codex CLI already holds
 */
export type LimitProvider = "claude" | "codex";
export type LimitWindow = "5h" | "7d";
export type LimitSample = { provider: LimitProvider; window: LimitWindow; usedPercent: number; resetsAt: number | null; observedAt: number };
export type LimitSource = "headers" | "endpoint";
export type ProviderLimits = { provider: LimitProvider | "cursor"; label: string; samples: Array<LimitSample & { source: LimitSource }>; status: "ok" | "no-data" | "unavailable"; reason: string | null; lastAttemptAt: number | null; nextAttemptAt: number | null };

const LABELS: Record<LimitProvider, string> = { claude: "Claude", codex: "Codex" };
/** The endpoints are undocumented; never poll them more often than this, and back off on failure. */
export const MIN_POLL_MS = 60_000, MAX_BACKOFF_MS = 15 * 60_000, REQUEST_TIMEOUT_MS = 10_000;
/** A passive header sample keeps the poll away while it is this fresh. */
const PASSIVE_FRESH_MS = 60_000;
const WINDOW_SECONDS: Record<LimitWindow, number> = { "5h": 5 * 3600, "7d": 7 * 86400 };

type Polled = Array<Omit<LimitSample, "provider" | "observedAt">>;
type Stored = LimitSample & { source: LimitSource };
const state = new Map<LimitProvider, { samples: Map<LimitWindow, Stored>; reason: string | null; unavailable: boolean; lastAttemptAt: number | null; nextAttemptAt: number; failures: number; inflight?: Promise<void> }>();
const entry = (provider: LimitProvider) => {
  let value = state.get(provider);
  if (!value) state.set(provider, value = { samples: new Map(), reason: null, unavailable: false, lastAttemptAt: null, nextAttemptAt: 0, failures: 0 });
  return value;
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const finite = (value: unknown): number | null => { const number = typeof value === "string" && value.trim() === "" ? NaN : Number(value); return Number.isFinite(number) ? number : null; };
/** Seconds-or-milliseconds epoch to milliseconds (1e10 separates the two units). */
const epochMs = (value: unknown): number | null => { const number = finite(value); return number === null || number <= 0 ? null : number > 1e10 ? number : number * 1000; };
/** Window by length so a weekly-only plan never shows as "5h". */
export function windowForSeconds(seconds: number): LimitWindow | null {
  if (!(seconds > 0)) return null;
  const [five, seven] = [WINDOW_SECONDS["5h"], WINDOW_SECONDS["7d"]];
  return seconds <= five * 1.5 ? "5h" : seconds >= seven * 0.5 ? "7d" : null;
}

function record(provider: LimitProvider, source: LimitSource, samples: Polled, observedAt = Date.now()): void {
  const own = entry(provider);
  for (const sample of samples) {
    const previous = own.samples.get(sample.window);
    if (previous && previous.observedAt > observedAt) continue;
    own.samples.set(sample.window, { provider, ...sample, observedAt, source });
  }
}

/** Passive: called for every provider response with its headers. Unknown providers and unparsable values are ignored. */
export function observeLimitHeaders(modelProvider: string, headers: Record<string, string>, at = Date.now()): void {
  const get = (name: string) => { const key = Object.keys(headers).find(item => item.toLowerCase() === name); return key === undefined ? undefined : headers[key]; };
  if (modelProvider === "anthropic") {
    const samples: Polled = [];
    for (const window of ["5h", "7d"] as const) {
      // Utilization is a 0..1 fraction; reset is epoch seconds.
      const used = finite(get(`anthropic-ratelimit-unified-${window}-utilization`));
      if (used !== null) samples.push({ window, usedPercent: clamp(used * 100), resetsAt: epochMs(get(`anthropic-ratelimit-unified-${window}-reset`)) });
    }
    if (samples.length) record("claude", "headers", samples, at);
  } else if (modelProvider === "openai-codex") {
    const samples: Polled = [];
    for (const slot of ["primary", "secondary"] as const) {
      const used = finite(get(`x-codex-${slot}-used-percent`)), minutes = finite(get(`x-codex-${slot}-window-minutes`));
      const window = minutes === null ? null : windowForSeconds(minutes * 60);
      if (used !== null && window) samples.push({ window, usedPercent: clamp(used), resetsAt: epochMs(get(`x-codex-${slot}-reset-at`)) });
    }
    if (samples.length) record("codex", "headers", samples, at);
  }
}

async function readJson(path: string): Promise<any> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

class Retry extends Error {
  afterMs: number | null; signedOut: boolean;
  constructor(message: string, afterMs: number | null = null, signedOut = false) { super(message); this.afterMs = afterMs; this.signedOut = signedOut; }
}
const retryAfter = (response: Response) => { const seconds = Number(response.headers.get("retry-after")); return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 24 * 3600_000) : null; };
async function getJson(url: string, headers: Record<string, string>, what: string): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => { throw new Retry(`${what} could not be reached`); });
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new Retry(`${what} sign-in expired or not allowed. It refreshes when Pi next uses the provider`, null, true); }
  if (response.status === 429) { await response.body?.cancel(); throw new Retry(`${what} rate limited the usage request`, retryAfter(response)); }
  if (!response.ok) { await response.body?.cancel(); throw new Retry(`${what} usage request failed (HTTP ${response.status})`); }
  return response.json().catch(() => { throw new Retry(`${what} returned an unreadable usage response`); });
}

async function pollClaude(): Promise<Polled> {
  const token = (await readJson(join(getAgentDir(), "auth.json")))?.anthropic?.access;
  if (typeof token !== "string" || !token) throw new Retry("No Anthropic sign-in in Pi (log in with /login)", null, true);
  // Read-only GET; undocumented. Same call Claude Code's own usage view makes.
  const data = await getJson("https://api.anthropic.com/api/oauth/usage", { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, "Claude");
  const samples: Polled = [];
  for (const [window, raw] of [["5h", data?.five_hour], ["7d", data?.seven_day]] as const) {
    const used = finite(raw?.utilization);
    // Utilization is already a percent here (the 0..1 fraction is only the header form).
    if (used !== null) samples.push({ window, usedPercent: clamp(used), resetsAt: typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) || null : epochMs(raw.resets_at) });
  }
  return samples;
}

async function pollCodex(): Promise<Polled> {
  const pi = (await readJson(join(getAgentDir(), "auth.json")))?.["openai-codex"];
  const cli = (await readJson(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")))?.tokens;
  const token = pi?.access ?? cli?.access_token, account = pi?.accountId ?? cli?.account_id;
  if (typeof token !== "string" || !token) throw new Retry("No ChatGPT/Codex sign-in found in Pi or the Codex CLI", null, true);
  // Read-only GET; undocumented. Same call the Codex app's usage view makes.
  const data = await getJson("https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${token}`, ...(typeof account === "string" && account ? { "ChatGPT-Account-Id": account } : {}), "User-Agent": "codex-cli", originator: "Codex Desktop" }, "Codex");
  const samples: Polled = [];
  for (const raw of [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window]) {
    const used = finite(raw?.used_percent), seconds = finite(raw?.limit_window_seconds);
    const window = seconds === null ? null : windowForSeconds(seconds);
    if (used !== null && window) samples.push({ window, usedPercent: clamp(used), resetsAt: epochMs(raw.reset_at) ?? (finite(raw.reset_after_seconds) === null ? null : Date.now() + finite(raw.reset_after_seconds)! * 1000) });
  }
  return samples;
}

/** Browser e2e only: PI_PROJECTS_LIMITS_FIXTURE=<file> with { claude: [{ window, usedPercent, resetsAt }], codex: [...] } replaces both endpoints. */
const fixture = (provider: LimitProvider): (() => Promise<Polled>) | undefined => process.env.PI_PROJECTS_LIMITS_FIXTURE ? async () => (await readJson(process.env.PI_PROJECTS_LIMITS_FIXTURE!))?.[provider] ?? [] : undefined;
const pollerOf = (provider: LimitProvider): (() => Promise<Polled>) => fixture(provider) ?? (provider === "claude" ? pollClaude : pollCodex);

function refreshProvider(provider: LimitProvider, now: number): Promise<void> {
  const own = entry(provider);
  if (own.inflight) return own.inflight;
  const fresh = [...own.samples.values()].some(sample => sample.source === "headers" && now - sample.observedAt < PASSIVE_FRESH_MS);
  if (now < own.nextAttemptAt || fresh) return Promise.resolve();
  own.lastAttemptAt = now;
  own.nextAttemptAt = now + MIN_POLL_MS;
  own.inflight = pollerOf(provider)().then(samples => {
    record(provider, "endpoint", samples);
    own.failures = 0; own.reason = samples.length ? null : "The provider returned no usage windows"; own.unavailable = false;
  }, error => {
    own.failures++;
    own.reason = error instanceof Error ? error.message : "Usage request failed";
    own.unavailable = error instanceof Retry && error.signedOut;
    own.nextAttemptAt = Date.now() + Math.min(MAX_BACKOFF_MS, Math.max((error instanceof Retry ? error.afterMs : null) ?? 0, MIN_POLL_MS * 2 ** Math.min(own.failures, 5)));
  }).finally(() => { own.inflight = undefined; });
  return own.inflight;
}

/** Normalized state for the browser. Triggers at most one poll per provider per minute (plus backoff after failures). */
export async function limitsSnapshot(now = Date.now()): Promise<{ providers: ProviderLimits[]; observedAt: number }> {
  await Promise.all((Object.keys(LABELS) as LimitProvider[]).map(provider => refreshProvider(provider, now)));
  const providers = (Object.keys(LABELS) as LimitProvider[]).map((provider): ProviderLimits => {
    const own = entry(provider), samples = [...own.samples.values()].sort((a, b) => a.window.localeCompare(b.window));
    return { provider, label: LABELS[provider], samples, status: samples.length ? "ok" : own.unavailable ? "unavailable" : "no-data", reason: own.reason, lastAttemptAt: own.lastAttemptAt, nextAttemptAt: own.nextAttemptAt || null };
  });
  // Cursor's usage lives behind a cursor.com dashboard session cookie, which neither Pi nor this host holds: shown as unavailable, never polled.
  providers.push({ provider: "cursor", label: "Cursor", samples: [], status: "unavailable", reason: "Needs a cursor.com dashboard session that Pi does not hold", lastAttemptAt: null, nextAttemptAt: null });
  return { providers, observedAt: Date.now() };
}

/** Test seam: forget everything observed. */
export function resetLimitsForTest(): void { state.clear(); }
