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
export type LimitProvider = "claude" | "codex" | "cursor";
/** "mo" is Cursor's monthly billing cycle. */
export type LimitWindow = "5h" | "7d" | "mo";
export type LimitSample = { provider: LimitProvider; window: LimitWindow; usedPercent: number; resetsAt: number | null; observedAt: number };
export type LimitSource = "headers" | "endpoint";
export type ProviderLimits = { provider: LimitProvider; label: string; samples: Array<LimitSample & { source: LimitSource }>; status: "ok" | "no-data" | "unavailable"; reason: string | null; lastAttemptAt: number | null; nextAttemptAt: number | null; /** Cursor only: the in-page sign-in flow. */ connect?: CursorConnect };
export type CursorConnect = { state: "idle" | "waiting" | "failed"; loginUrl: string | null; error: string | null };

const LABELS: Record<LimitProvider, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
/** The endpoints are undocumented; never poll them more often than this, and back off on failure. */
export const MIN_POLL_MS = 60_000, MAX_BACKOFF_MS = 15 * 60_000, REQUEST_TIMEOUT_MS = 10_000;
/** A passive header sample keeps the poll away while it is this fresh. */
const PASSIVE_FRESH_MS = 60_000;
const WINDOW_SECONDS = { "5h": 5 * 3600, "7d": 7 * 86400 };

type Polled = Array<Omit<LimitSample, "provider" | "observedAt">>;
type Stored = LimitSample & { source: LimitSource };
type OwnState = { samples: Map<LimitWindow, Stored>; reason: string | null; unavailable: boolean; lastAttemptAt: number | null; nextAttemptAt: number; failures: number; inflight?: Promise<void> };
const state = new Map<LimitProvider, OwnState>();
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

/** Browser e2e only: PI_PROJECTS_LIMITS_FIXTURE=<file> with { claude: [{ window, usedPercent, resetsAt }], codex: [...] } replaces the Claude and Codex endpoints (Cursor always uses its real poller). */
const fixture = (provider: LimitProvider): (() => Promise<Polled>) | undefined => process.env.PI_PROJECTS_LIMITS_FIXTURE && provider !== "cursor" ? async () => (await readJson(process.env.PI_PROJECTS_LIMITS_FIXTURE!))?.[provider] ?? [] : undefined;
const pollerOf = (provider: LimitProvider): (() => Promise<Polled>) => fixture(provider) ?? (provider === "claude" ? pollClaude : provider === "codex" ? pollCodex : pollCursor);

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

/** Normalized state for the browser. Triggers at most one poll per provider per minute (plus backoff after failures). */
export async function limitsSnapshot(now = Date.now()): Promise<{ providers: ProviderLimits[]; observedAt: number }> {
  await Promise.all((Object.keys(LABELS) as LimitProvider[]).map(provider => refreshProvider(provider, now)));
  const providers = (Object.keys(LABELS) as LimitProvider[]).map((provider): ProviderLimits => {
    const own = entry(provider), samples = [...own.samples.values()].sort((a, b) => a.window.localeCompare(b.window));
    return { provider, label: LABELS[provider], samples, status: samples.length ? "ok" : own.unavailable ? "unavailable" : "no-data", reason: own.reason, lastAttemptAt: own.lastAttemptAt, nextAttemptAt: own.nextAttemptAt || null, ...(provider === "cursor" ? { connect: { state: connect.state, loginUrl: connect.loginUrl, error: connect.error } } : {}) };
  });
  return { providers, observedAt: Date.now() };
}

/** Test seam: forget everything observed. */
export function resetLimitsForTest(): void { state.clear(); connect = { state: "idle", loginUrl: null, error: null, startedAt: 0 }; }
