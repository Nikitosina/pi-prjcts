import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Subscription limits for the bottom bar. Host-side only: tokens and raw provider responses stay here, the browser gets
 * normalized samples. Sources, passive first (see docs/subscription-limits.md):
 *   headers  - rate-limit headers on responses Pi already receives (pi-ai `onResponse`)
 *   endpoint - read-only GET of the provider's own usage endpoint with the login Pi or the Codex CLI already holds
 */
export type LimitProvider = "claude" | "codex" | "cursor" | "eliza";
/** "mo" is Cursor's monthly billing cycle. */
export type LimitWindow = "5h" | "7d" | "mo";
export type LimitSample = { provider: LimitProvider; window: LimitWindow; usedPercent: number; resetsAt: number | null; observedAt: number };
export type LimitSource = "headers" | "endpoint";
export type ElizaUsage = { amountUsd: number; periodStartAt: number; periodEndAt: number; account: string; pool: string | null; observedAt: number };
export type ProviderLimits = { provider: LimitProvider; label: string; samples: Array<LimitSample & { source: LimitSource }>; status: "ok" | "no-data" | "unavailable"; reason: string | null; lastAttemptAt: number | null; nextAttemptAt: number | null; /** Cursor only: the in-page sign-in flow. */ connect?: CursorConnect; /** Eliza only: actual month-to-date cost from its usage endpoint. */ usage?: ElizaUsage | null };
export type CursorConnect = { state: "idle" | "waiting" | "failed"; loginUrl: string | null; error: string | null };

const LABELS: Record<LimitProvider, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", eliza: "Eliza" };
/** Never poll an endpoint more often than this, and back off on failure. */
export const MIN_POLL_MS = 5 * 60_000, MANUAL_COOLDOWN_MS = 15_000, MAX_BACKOFF_MS = 15 * 60_000, REQUEST_TIMEOUT_MS = 10_000;
/** A passive header sample keeps the poll away while it is this fresh. */
const PASSIVE_FRESH_MS = MIN_POLL_MS;
const WINDOW_SECONDS = { "5h": 5 * 3600, "7d": 7 * 86400 };

type Polled = Array<Omit<LimitSample, "provider" | "observedAt">>;
type ElizaReading = Omit<ElizaUsage, "observedAt">;
type PollResult = { samples: Polled; usage?: ElizaReading | null };
type Stored = LimitSample & { source: LimitSource };
type OwnState = { samples: Map<LimitWindow, Stored>; usage: ElizaUsage | null; reason: string | null; unavailable: boolean; lastAttemptAt: number | null; lastManualAt: number; nextAttemptAt: number; failures: number; holdUntil: number; inflight?: Promise<void> };
const state = new Map<LimitProvider, OwnState>();
const entry = (provider: LimitProvider) => {
  let value = state.get(provider);
  if (!value) state.set(provider, value = { samples: new Map(), usage: null, reason: null, unavailable: false, lastAttemptAt: null, lastManualAt: 0, nextAttemptAt: 0, failures: 0, holdUntil: 0 });
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

/**
 * Credentials come from Pi's own resolver when the host provides one (it renews an expiring OAuth login under the auth-store lock, the same
 * path a model request takes, so a token that expired while nobody used the provider is renewed here instead of being sent stale). Without it,
 * or when it knows no login, the stored token is read from disk on every attempt. Nothing is cached between attempts.
 */
export type TokenResolver = (providerId: string) => Promise<string | undefined>;
let resolveToken: TokenResolver | null = null;
export function setLimitsTokenResolver(resolver: TokenResolver | null): void { resolveToken = resolver; }
const RENEW_TIMEOUT_MS = 20_000;
async function currentToken(providerId: string, what: string, fromDisk: () => Promise<string | undefined>): Promise<string | undefined> {
  if (resolveToken) {
    let renewed: string | undefined;
    try {
      renewed = await Promise.race([resolveToken(providerId), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), RENEW_TIMEOUT_MS).unref())]);
    } catch (error) {
      // A rejected refresh token is an auth problem; a failed renewal request (offline, timeout, 5xx) is not, and nothing is stored from it.
      const text = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : "";
      if (/invalid_grant|invalid_client|unauthorized|\b40[013]\b/i.test(text)) throw new Retry(`${what} sign-in was rejected when renewing it. Sign in again`, null, true);
      throw new Retry(`Couldn't renew the ${what} sign-in right now, will retry`);
    }
    if (renewed) return renewed;
  }
  return fromDisk();
}
/** One attempt, and after an auth rejection one more with whatever the credentials now hold if that is a different token. */
async function withToken<T>(providerId: string, what: string, fromDisk: () => Promise<string | undefined>, attempt: (token: string) => Promise<T>): Promise<T> {
  const token = await currentToken(providerId, what, fromDisk);
  if (!token) throw new Retry(`No ${what} sign-in found (log in with /login)`, null, true);
  try { return await attempt(token); }
  catch (error) {
    if (!(error instanceof Retry && error.signedOut)) throw error;
    const again = await currentToken(providerId, what, fromDisk);
    if (!again || again === token) throw error;
    return attempt(again);
  }
}

async function readJson(path: string): Promise<any> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

/** `signedOut` is only for a real 401/403 (or no credential at all); everything else, network included, is transient and keeps the normal backoff. */
class Retry extends Error {
  afterMs: number | null; signedOut: boolean;
  constructor(message: string, afterMs: number | null = null, signedOut = false) { super(message); this.afterMs = afterMs; this.signedOut = signedOut; }
}
const unreachable = (what: string) => new Retry(`Couldn't reach ${what}, will retry`);
const retryAfter = (response: Response, now = Date.now()) => {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : null;
};
async function getJson(url: string, headers: Record<string, string>, what: string, authHint = "Pi renews it before it expires; if this stays, sign in again"): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => { throw unreachable(what); });
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new Retry(`${what} rejected the sign-in (HTTP ${response.status}). ${authHint}`, null, true); }
  if (response.status === 429) { await response.body?.cancel(); throw new Retry(`${what} rate limited the usage request, will retry`, retryAfter(response)); }
  if (response.status >= 500) { await response.body?.cancel(); throw new Retry(`${what} is having trouble (HTTP ${response.status}), will retry`, retryAfter(response)); }
  if (!response.ok) { await response.body?.cancel(); throw new Retry(`${what} usage request failed (HTTP ${response.status})`); }
  // The timeout also covers the body; a connection that dies mid-body is the network, not a bad response.
  const text = await response.text().catch(() => { throw unreachable(what); });
  try { return JSON.parse(text); } catch { throw new Retry(`${what} returned an unreadable usage response`); }
}

const claudeUsageUrl = () => process.env.PI_PROJECTS_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";
const codexUsageUrl = () => process.env.PI_PROJECTS_CODEX_USAGE_URL ?? "https://chatgpt.com/backend-api/wham/usage";
const storedAccess = async (key: string) => { const token = (await readJson(join(getAgentDir(), "auth.json")))?.[key]?.access; return typeof token === "string" && token ? token : undefined; };
async function pollClaude(): Promise<Polled> {
  // Read-only GET; undocumented. Same call Claude Code's own usage view makes.
  const data = await withToken("anthropic", "Claude", () => storedAccess("anthropic"), token => getJson(claudeUsageUrl(), { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" }, "Claude"));
  const samples: Polled = [];
  for (const [window, raw] of [["5h", data?.five_hour], ["7d", data?.seven_day]] as const) {
    const used = finite(raw?.utilization);
    // Utilization is already a percent here (the 0..1 fraction is only the header form).
    if (used !== null) samples.push({ window, usedPercent: clamp(used), resetsAt: typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) || null : epochMs(raw.resets_at) });
  }
  return samples;
}

async function pollCodex(): Promise<Polled> {
  const cliTokens = async () => (await readJson(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")))?.tokens;
  const account = async (): Promise<string | null> => { const id = (await readJson(join(getAgentDir(), "auth.json")))?.["openai-codex"]?.accountId ?? (await cliTokens())?.account_id; return typeof id === "string" && id ? id : null; };
  const fromDisk = async () => (await storedAccess("openai-codex")) ?? ((await cliTokens())?.access_token || undefined);
  // Read-only GET; undocumented. Same call the Codex app's usage view makes.
  const data = await withToken("openai-codex", "ChatGPT/Codex", fromDisk, async token => { const id = await account(); return getJson(codexUsageUrl(), { Authorization: `Bearer ${token}`, ...(id ? { "ChatGPT-Account-Id": id } : {}), "User-Agent": "codex-cli", originator: "Codex Desktop" }, "Codex"); });
  const samples: Polled = [];
  for (const raw of [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window]) {
    const used = finite(raw?.used_percent), seconds = finite(raw?.limit_window_seconds);
    const window = seconds === null ? null : windowForSeconds(seconds);
    if (used !== null && window) samples.push({ window, usedPercent: clamp(used), resetsAt: epochMs(raw.reset_at) ?? (finite(raw.reset_after_seconds) === null ? null : Date.now() + finite(raw.reset_after_seconds)! * 1000) });
  }
  return samples;
}

/** Cursor hosts; overridable so the e2e never reaches cursor.com. */
const cursorDashboard = () => process.env.PI_PROJECTS_CURSOR_DASHBOARD ?? "https://cursor.com";
const cursorApi = () => process.env.PI_PROJECTS_CURSOR_API ?? "https://api2.cursor.sh";
/** The session JWT Cursor's own login (the CLI's browser flow, also Pi's `/login cursor`) issues; `sub` builds the dashboard cookie. */
function cursorSession(token: string): { cookie: string; expiresAt: number | null } | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { cookie: `WorkosCursorSessionToken=${encodeURIComponent(payload.sub)}%3A%3A${token}`, expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : null };
  } catch { return null; }
}
/** Read-only: Pi's own Cursor login first, then the cursor-agent file token (`~/.cursor/auth.json`, older CLIs). Keychain and IDE storage are not read. */
async function cursorToken(): Promise<string | null> {
  const pi = (await readJson(join(getAgentDir(), "auth.json")))?.cursor?.access;
  if (typeof pi === "string" && pi) return pi;
  const cli = (await readJson(join(homedir(), ".cursor", "auth.json")))?.accessToken;
  return typeof cli === "string" && cli ? cli : null;
}
async function pollCursor(): Promise<Polled> {
  const token = await cursorToken(), session = token ? cursorSession(token) : null;
  if (!token || !session) throw new Retry("No Cursor sign-in found. Use Connect Cursor", null, true);
  if (session.expiresAt !== null && session.expiresAt <= Date.now()) throw new Retry("Cursor sign-in expired. Use Connect Cursor", null, true);
  // Read-only GET; undocumented dashboard route (the one cursor.com/dashboard and pi-cursor's /cursor.usage call).
  const data = await getJson(`${cursorDashboard()}/api/usage-summary`, { Cookie: session.cookie, Origin: "https://cursor.com", Referer: "https://cursor.com/dashboard" }, "Cursor");
  const plan = data?.individualUsage?.plan, used = finite(plan?.totalPercentUsed);
  if (plan?.enabled === false || used === null) return [];
  return [{ window: "mo", usedPercent: clamp(used), resetsAt: typeof data.billingCycleEnd === "string" ? Date.parse(data.billingCycleEnd) || null : null }];
}

const utcMonth = (at: number) => { const date = new Date(at), year = date.getUTCFullYear(), month = date.getUTCMonth(); return [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)] as const; };
/** EffectiveUsage partitions spending across the returned buckets, so their monthly stats sum to actual spend. */
export function parseElizaUsage(data: unknown, startedAt = Date.now(), finishedAt = startedAt): ElizaReading | null {
  const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
  const root = record(data), account = root?.account, pool = root?.pool, usage = record(root?.usage);
  if (!root || typeof account !== "string" || !account || typeof pool !== "string" || !usage) throw new Retry("Eliza returned an unreadable usage response");
  let amountUsd = 0, buckets = 0;
  for (const bucket of Object.values(usage)) {
    const monthly = record(record(bucket)?.stats)?.monthly, rawCost = record(monthly)?.cost;
    const cost = typeof rawCost === "number" || typeof rawCost === "string" && rawCost.trim() ? finite(rawCost) : null;
    if (cost === null || cost < 0) throw new Retry("Eliza returned an unreadable usage response");
    amountUsd += cost; buckets++;
  }
  const [periodStartAt, periodEndAt] = utcMonth(startedAt);
  if (utcMonth(finishedAt)[0] !== periodStartAt) throw new Retry("Eliza usage crossed the UTC month boundary, will retry");
  if (!buckets) return null;
  if (!Number.isFinite(amountUsd)) throw new Retry("Eliza returned an unreadable usage response");
  return { amountUsd, periodStartAt, periodEndAt, account, pool: pool || null };
}
const elizaUsageUrl = () => process.env.PI_PROJECTS_ELIZA_USAGE_URL ?? "https://api.eliza.yandex.net/v2/usage";
async function pollEliza(): Promise<PollResult> {
  const token = process.env.ELIZA_TOKEN?.trim();
  if (!token) throw new Retry("No Eliza OAuth token found. Set ELIZA_TOKEN on the host", null, true);
  const startedAt = Date.now();
  const data = await getJson(elizaUsageUrl(), { Authorization: `OAuth ${token}` }, "Eliza", "Set a current ELIZA_TOKEN on the host");
  return { samples: [], usage: parseElizaUsage(data, startedAt, Date.now()) };
}

/** Browser e2e only: PI_PROJECTS_LIMITS_FIXTURE=<file> replaces provider endpoints with local data. Cursor always uses its own fake/real poller. */
const fixture = (provider: LimitProvider): (() => Promise<PollResult>) | undefined => process.env.PI_PROJECTS_LIMITS_FIXTURE && provider !== "cursor" ? async (): Promise<PollResult> => {
  const data = await readJson(process.env.PI_PROJECTS_LIMITS_FIXTURE!), fail = data?.[`${provider}Fail`];
  if (fail === "unreachable") throw unreachable(LABELS[provider]);
  if (fail === "auth") throw new Retry(`${LABELS[provider]} rejected the sign-in (HTTP 401). Pi renews it before it expires; if this stays, sign in again`, null, true);
  return { samples: provider === "eliza" ? [] : data?.[provider] ?? [], ...(provider === "eliza" ? { usage: data?.eliza ? parseElizaUsage(data.eliza) : null } : {}) };
} : undefined;
const pollerOf = (provider: LimitProvider): (() => Promise<PollResult>) => fixture(provider) ?? (provider === "eliza" ? pollEliza : async () => ({ samples: await (provider === "claude" ? pollClaude : provider === "codex" ? pollCodex : pollCursor)() }));

/**
 * Every mode waits out the provider's Retry-After. `manual` (the refresh button) otherwise skips the minimum interval, failure backoff
 * and passive-sample shortcut, but is rate-limited per provider. `visit` retries a provider in a failure state before the backoff ends,
 * subject to the per-provider cooldown. Otherwise only the normal schedule applies.
 */
type RefreshMode = "auto" | "manual" | "visit";
function refreshProvider(provider: LimitProvider, now: number, mode: RefreshMode = "auto"): Promise<void> {
  const own = entry(provider);
  if (own.inflight) return own.inflight;
  if (now < own.holdUntil) return Promise.resolve();
  if (mode === "manual") {
    if (now - own.lastManualAt < MANUAL_COOLDOWN_MS) return Promise.resolve();
    own.lastManualAt = now;
  } else if (mode === "visit" && own.failures > 0) {
    if (now - (own.lastAttemptAt ?? 0) < MANUAL_COOLDOWN_MS) return Promise.resolve();
  } else {
    const fresh = [...own.samples.values()].some(sample => sample.source === "headers" && now - sample.observedAt < PASSIVE_FRESH_MS);
    if (now < own.nextAttemptAt || fresh) return Promise.resolve();
  }
  own.lastAttemptAt = now;
  own.nextAttemptAt = now + MIN_POLL_MS;
  const startedAt = Date.now();
  own.inflight = pollerOf(provider)().then(result => {
    record(provider, "endpoint", result.samples);
    if (provider === "eliza") own.usage = result.usage ? { ...result.usage, observedAt: Date.now() } : null;
    const hasData = result.samples.length > 0 || own.usage !== null;
    own.failures = 0; own.holdUntil = 0; own.reason = hasData ? null : provider === "eliza" ? "Eliza returned no usage data" : "The provider returned no usage windows"; own.unavailable = false;
  }, error => {
    own.failures++;
    own.reason = error instanceof Error ? error.message : "Usage request failed";
    own.unavailable = error instanceof Retry && error.signedOut;
    const afterMs = error instanceof Retry ? error.afterMs : null;
    const failedAt = now + Date.now() - startedAt;
    own.holdUntil = afterMs !== null ? failedAt + afterMs : 0;
    own.nextAttemptAt = Math.max(own.holdUntil, failedAt + Math.min(MAX_BACKOFF_MS, MIN_POLL_MS * 2 ** Math.min(own.failures, 5)));
  }).finally(() => { own.inflight = undefined; });
  return own.inflight;
}

/**
 * "Connect Cursor": Cursor's own browser login (PKCE; the flow `cursor-agent login` and Pi's `/login cursor` use), run host-side.
 * The user opens the URL, the host polls Cursor until the login completes, then stores the tokens in Pi's auth store, the
 * same place `/login cursor` keeps them. Nothing is pasted and the browser never sees a token.
 */
/** Merge the `cursor` entry into Pi's auth.json (where `/login cursor` keeps it): one read-modify-write, atomic rename, 0600, every other entry untouched. */
async function storeCursorLogin(credential: { type: "oauth"; access: string; refresh: string; expires: number }): Promise<void> {
  const path = join(getAgentDir(), "auth.json"), temp = `${path}.${process.pid}.tmp`;
  // A missing file starts empty; an unreadable one is never overwritten.
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error; });
  const current = JSON.parse(text);
  await writeFile(temp, JSON.stringify({ ...current, cursor: credential }, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
const LOGIN_WINDOW_MS = 5 * 60_000;
let connect: CursorConnect & { startedAt: number } = { state: "idle", loginUrl: null, error: null, startedAt: 0 };
export function startCursorLogin(now = Date.now()): CursorConnect {
  if (connect.state === "waiting" && now - connect.startedAt < LOGIN_WINDOW_MS) return connect;
  const verifier = randomBytes(96).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url"), uuid = randomUUID();
  const loginUrl = `${cursorDashboard()}/loginDeepControl?${new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" })}`;
  const flow = connect = { state: "waiting", loginUrl, error: null, startedAt: now };
  void (async () => {
    let wait = 1000;
    while (connect === flow && Date.now() - flow.startedAt < LOGIN_WINDOW_MS) {
      await new Promise(resolve => setTimeout(resolve, wait));
      const response = await fetch(`${cursorApi()}/auth/poll?uuid=${uuid}&verifier=${verifier}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
      if (response?.status === 404 || !response) { wait = Math.min(wait * 1.2, 5000); continue; }
      if (!response.ok) throw new Error(`Cursor login failed (HTTP ${response.status})`);
      const done = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
      if (typeof done.accessToken !== "string" || typeof done.refreshToken !== "string") throw new Error("Cursor login returned no tokens");
      const session = cursorSession(done.accessToken);
      if (!session) throw new Error("Cursor login returned an unreadable token");
      await storeCursorLogin({ type: "oauth", access: done.accessToken, refresh: done.refreshToken, expires: (session.expiresAt ?? Date.now() + 3600_000) - 300_000 });
      connect = { state: "idle", loginUrl: null, error: null, startedAt: 0 };
      const own = entry("cursor"); own.nextAttemptAt = 0; own.failures = 0;
      return;
    }
    if (connect === flow) connect = { state: "failed", loginUrl: null, error: "The Cursor sign-in was not completed in time", startedAt: flow.startedAt };
  })().catch(error => { if (connect === flow) connect = { state: "failed", loginUrl: null, error: error instanceof Error ? error.message : "Cursor sign-in failed", startedAt: flow.startedAt }; });
  return connect;
}

/** Normalized state for the browser. Triggers at most one poll per provider per 5 minutes (plus backoff after failures); `refresh` polls now. */
export async function limitsSnapshot(now = Date.now(), refresh: boolean | "visit" = false): Promise<{ providers: ProviderLimits[]; observedAt: number }> {
  await Promise.all((Object.keys(LABELS) as LimitProvider[]).map(provider => refreshProvider(provider, now, refresh === true ? "manual" : refresh === "visit" ? "visit" : "auto")));
  const providers = (Object.keys(LABELS) as LimitProvider[]).map((provider): ProviderLimits => {
    const own = entry(provider), samples = [...own.samples.values()].sort((a, b) => a.window.localeCompare(b.window)), hasData = samples.length > 0 || own.usage !== null;
    return { provider, label: LABELS[provider], samples, status: hasData ? "ok" : own.unavailable ? "unavailable" : "no-data", reason: own.reason, lastAttemptAt: own.lastAttemptAt, nextAttemptAt: own.nextAttemptAt || null, ...(provider === "cursor" ? { connect: { state: connect.state, loginUrl: connect.loginUrl, error: connect.error } } : {}), ...(provider === "eliza" ? { usage: own.usage } : {}) };
  });
  return { providers, observedAt: Date.now() };
}

/** Test seam: forget everything observed. */
export function resetLimitsForTest(): void { state.clear(); connect = { state: "idle", loginUrl: null, error: null, startedAt: 0 }; }
