import { createHash } from "node:crypto";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurablePlanning } from "./durable-planning.ts";
import { changedFiles } from "./vcs.ts";
import type { DurablePlanSnapshot, DurablePlanWorkSnapshot } from "./durable-plan-types.ts";
import { loadAutomations } from "./project-automations.ts";
import type { scheduleRuntime } from "./durable-schedule.ts";

/**
 * Durable watchdog clock on the root conversation. `armedAtMs` is set when workers start running (and cleared when none run), so an idle
 * project never ticks; a check is due at max(armedAtMs, lastTickAtMs) + everyMs, which survives restarts. `seq` makes each check's event ID
 * unique; it advances in the same transaction that records the event, so two timers cannot admit the same interval twice.
 */
type WatchdogState = { armedAtMs: number | null; lastTickAtMs: number | null; seq: number; ticks: number; lastWorkers: number; lastError: string | null };
const Watchdog = defineDoc<WatchdogState>({ kind: "projects.watchdog", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ armedAtMs: null, lastTickAtMs: null, seq: 0, ticks: 0, lastWorkers: 0, lastError: null }) });

type Entry = { id: number; model?: readonly { role: string; content: unknown; timestamp?: number; toolCallId?: string; isError?: boolean; usage?: unknown }[] };
type Sources = {
  plan(): Promise<DurablePlanSnapshot>;
  /** Model entries of a worker thread's conversation, or null when it is gone. */
  entries(threadId: string): Promise<readonly Entry[] | null>;
  target(): Promise<Conversation>;
};
const clip = (text: string, max: number) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const minutes = (ms: number) => ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
/** Interval for this project: Settings, or PI_PROJECTS_WATCHDOG_MS (tests) which may go below the 1-minute Settings minimum. */
export function watchdogConfig(projectId: string): { enabled: boolean; everyMs: number } {
  const config = loadAutomations(projectId).watchdog, override = Number(process.env.PI_PROJECTS_WATCHDOG_MS);
  return { enabled: config.enabled, everyMs: Number.isSafeInteger(override) && override >= 1000 ? override : config.everyMs };
}

function usageTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const value = usage as Record<string, unknown>, num = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : 0;
  return num("totalTokens") || num("input") + num("output") + num("cacheRead") + num("cacheWrite");
}

/** Bounded per-worker digest: runtime, steering, last tool calls, repeats and errors since the last check, tokens since the last check, changed files. */
export async function workerDigest(work: DurablePlanWorkSnapshot, entries: readonly Entry[] | null, since: number, now: number, parent: string | null): Promise<string> {
  const calls: Array<{ name: string; args: string; at: number; error: boolean; result: string }> = [];
  let tokens = 0, total = 0;
  const results = new Map<string, { error: boolean; text: string }>();
  for (const entry of entries ?? []) for (const message of entry.model ?? []) if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, { error: message.isError === true, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") });
  for (const entry of entries ?? []) for (const message of entry.model ?? []) {
    if (message.role !== "assistant") continue;
    const used = usageTokens(message.usage), at = message.timestamp ?? 0;
    total += used; if (at > since) tokens += used;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== "object" || part === null || part.type !== "toolCall" || typeof part.name !== "string") continue;
      let args = ""; try { args = JSON.stringify(part.arguments ?? {}); } catch { args = "?"; }
      const result = typeof part.id === "string" ? results.get(part.id) : undefined;
      calls.push({ name: part.name, args, at, error: result?.error === true, result: result?.text ?? "" });
    }
  }
  const recent = calls.filter(call => call.at > since);
  const repeats = new Map<string, { label: string; count: number }>();
  for (const call of recent) { const key = createHash("sha256").update(`${call.name}\0${call.args}`).digest("hex"); const item = repeats.get(key) ?? { label: `${call.name} ${clip(call.args, 80)}`, count: 0 }; item.count++; repeats.set(key, item); }
  const repeated = [...repeats.values()].filter(item => item.count >= 3).sort((a, b) => b.count - a.count).slice(0, 3);
  const errors = recent.filter(call => call.error);
  // Label: tool name plus its first string argument (command, path, query), clipped.
  const label = (call: { name: string; args: string }) => { let hint = ""; try { const value = Object.values(JSON.parse(call.args) as Record<string, unknown>).find(item => typeof item === "string"); hint = typeof value === "string" ? ` ${clip(value, 40)}` : ""; } catch {} return `${call.name}${hint}`; };
  const last = calls.slice(-6).map(call => `${label(call)}${call.error ? " (error)" : ""}`);
  let files = "unknown (no worktree)";
  const cwd = work.attempt?.cwd;
  if (cwd && work.role === "worker") {
    try {
      const status = await changedFiles(cwd);
      if (!status) throw new Error("status unreadable");
      files = status.length ? `${status.length} (${status.slice(0, 6).map(line => clip(line, 80)).join(", ")}${status.length > 6 ? ", …" : ""})` : "none uncommitted";
    } catch { files = "unknown (worktree unreadable)"; }
  } else if (work.role !== "worker") files = "n/a (read-only role)";
  const started = work.startedAt ?? now;
  return [
    `- ${work.role} thread ${work.threadId}${parent ? ` (sub-agent of ${parent})` : ""}, work ${work.id}: "${clip(work.text, 160)}"`,
    `  running ${minutes(now - started)}${work.steering ? `; this run is a STEER you sent ${minutes(now - started)} ago (steered since an earlier check)` : "; not steered"}`,
    `  last tool calls (oldest first): ${last.length ? last.join(" | ") : "none"}; ${recent.length} call(s) since the last check`,
    `  repeated identical calls since the last check: ${repeated.length ? repeated.map(item => `${item.label} ×${item.count}`).join("; ") : "none"}`,
    `  errors since the last check: ${errors.length}${errors.length ? ` (latest: ${errors.at(-1)!.name}: ${clip(errors.at(-1)!.result, 160)})` : ""}`,
    `  tokens since the last check: ${tokens.toLocaleString("en-US")} (thread total ${total.toLocaleString("en-US")})`,
    `  files changed in its worktree: ${files}`,
  ].join("\n");
}

export function watchdogText(everyMs: number, digests: string[]): string {
  return `Worker watchdog check (automatic, every ${minutes(everyMs)}; not from the owner). Do not write to the owner about this check.
For each running worker below:
- Healthy (new calls, files changing, no loop): leave it alone.
- Unproductive (repeated identical calls, repeated errors, no file changes, tokens without progress) and "not steered": steer it once with a concrete nudge (projects_worker_control action steer: name the exact next step or the wrong assumption; read it with projects_worker_read first if unsure).
- Unproductive and its run is already a STEER from an earlier check: stop it (projects_worker_control action stop) and redispatch a rescoped task (projects_delegate, or follow_up on the thread when its context is still useful).
Tell the owner only in your final report or through a needs-you question. End this turn with no text.

${digests.join("\n")}`;
}

export function watchdogRuntime(root: Conversation, projectId: string, schedules: ReturnType<typeof scheduleRuntime>, sources: Sources, isClosed: () => boolean, onError: (error: unknown) => void) {
  let current: Promise<unknown> | null = null;
  const read = () => root.commit(async tx => ({ ...(await tx.doc(Watchdog, root.id)) }), BACKGROUND_CONTEXT);
  async function check(): Promise<unknown> {
    const config = watchdogConfig(projectId);
    if (!config.enabled || isClosed()) return { skipped: "off" };
    const plan = await sources.plan();
    if (plan.paused || plan.pausing) return { skipped: "paused" };
    const running = plan.work.filter(work => work.status === "running");
    const now = Date.now();
    if (!running.length) {
      // Disarm: the next worker starts a fresh interval instead of firing at once.
      await root.commit(async tx => { const doc = await tx.doc(Watchdog, root.id); if (doc.armedAtMs !== null) doc.armedAtMs = null; }, BACKGROUND_CONTEXT);
      return { skipped: "idle" };
    }
    const doc = await read();
    if (doc.armedAtMs === null) { await root.commit(async tx => { const value = await tx.doc(Watchdog, root.id); value.armedAtMs ??= now; }, BACKGROUND_CONTEXT); return { armed: true }; }
    const since = Math.max(doc.armedAtMs, doc.lastTickAtMs ?? 0);
    if (now < since + config.everyMs) return { skipped: "not-due" };
    const digests: string[] = [];
    for (const work of running.slice(0, 12)) digests.push(await workerDigest(work, await sources.entries(work.threadId).catch(() => null), since, now, work.parentThreadId));
    if (running.length > 12) digests.push(`- …and ${running.length - 12} more running workers (inspect with projects_workers)`);
    const seq = doc.seq + 1, payload = watchdogText(config.everyMs, digests).slice(0, 32000);
    await schedules.ingest({ eventId: `watchdog:${projectId.slice(0, 8)}:${seq}`, kind: "worker.watchdog", payload }, async tx => {
      const planning = await tx.doc(DurablePlanning, root.id), value = await tx.doc(Watchdog, root.id);
      return !isClosed() && !planning.paused && !planning.pausing && value.seq === seq - 1 && watchdogConfig(projectId).enabled;
    }, async tx => { const value = await tx.doc(Watchdog, root.id); if (value.seq === seq - 1) { value.seq = seq; value.ticks++; value.lastTickAtMs = now; value.lastWorkers = running.length; value.lastError = null; } }, { target: await sources.target(), automation: true });
    return { ticked: seq, workers: running.length };
  }
  const tick = () => {
    if (current || isClosed()) return;
    current = check().catch(async error => {
      onError(error);
      await root.commit(async tx => { (await tx.doc(Watchdog, root.id)).lastError = clip(error instanceof Error ? error.message : String(error), 300); }, BACKGROUND_CONTEXT).catch(() => {});
    }).finally(() => { current = null; });
  };
  async function snapshot() {
    const doc = await read(), config = watchdogConfig(projectId);
    return { enabled: config.enabled, everyMs: loadAutomations(projectId).watchdog.everyMs, effectiveEveryMs: config.everyMs, armedAtMs: doc.armedAtMs, lastTickAtMs: doc.lastTickAtMs, nextAtMs: config.enabled && doc.armedAtMs !== null ? Math.max(doc.armedAtMs, doc.lastTickAtMs ?? 0) + config.everyMs : null, ticks: doc.ticks, lastWorkers: doc.lastWorkers, lastError: doc.lastError };
  }
  return { tick, snapshot, idle: () => current ?? Promise.resolve() };
}
