import { UsageDoc, type Conversation, type ConversationId, type Harness, type UsageState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";

function empty(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function number(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("SDK usage contains an invalid counter");
  return value;
}
function copy(value: Usage): Usage {
  return { input: number(value.input), output: number(value.output), cacheRead: number(value.cacheRead), cacheWrite: number(value.cacheWrite), totalTokens: number(value.totalTokens),
    ...(value.reasoning === undefined ? {} : { reasoning: number(value.reasoning) }), ...(value.cacheWrite1h === undefined ? {} : { cacheWrite1h: number(value.cacheWrite1h) }),
    cost: { input: number(value.cost.input), output: number(value.cost.output), cacheRead: number(value.cost.cacheRead), cacheWrite: number(value.cost.cacheWrite), total: number(value.cost.total) } };
}
function add(total: Usage, value: Usage): void {
  total.input += value.input; total.output += value.output; total.cacheRead += value.cacheRead; total.cacheWrite += value.cacheWrite; total.totalTokens += value.totalTokens;
  if (value.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + value.reasoning;
  if (value.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + value.cacheWrite1h;
  total.cost.input += value.cost.input; total.cost.output += value.cost.output; total.cost.cacheRead += value.cost.cacheRead; total.cost.cacheWrite += value.cost.cacheWrite; total.cost.total += value.cost.total;
}
function buckets(state: Readonly<UsageState> | undefined) {
  const models = Object.fromEntries(Object.entries(state?.models ?? {}).map(([key, value]) => [key, copy(value)]));
  const tools = Object.fromEntries(Object.entries(state?.tools ?? {}).map(([key, value]) => [key, copy(value)]));
  const total = empty();
  for (const value of [...Object.values(models), ...Object.values(tools)]) add(total, value);
  return { models, tools, total: copy(total) };
}
const MAX_USAGE_ENTRIES = 10000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entryUsage(message: unknown): { timestamp: number; usage: Usage } | null {
  if (message === null || typeof message !== "object") return null;
  const value: Record<string, unknown> = Object.fromEntries(Object.entries(message));
  const usageValue = value.usage;
  if (typeof value.timestamp !== "number" || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0 || usageValue === null || typeof usageValue !== "object") return null;
  const fields: Array<keyof Usage> = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  const costs = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(usageValue));
  const costRaw = raw.cost;
  if (costRaw === null || typeof costRaw !== "object") return null;
  const rawCost: Record<string, unknown> = Object.fromEntries(Object.entries(costRaw));
  if (fields.some(field => typeof raw[field] !== "number") || costs.some(field => typeof rawCost[field] !== "number")) return null;
  try {
    const usage: Usage = { input: raw.input as number, output: raw.output as number, cacheRead: raw.cacheRead as number, cacheWrite: raw.cacheWrite as number, totalTokens: raw.totalTokens as number,
      cost: { input: rawCost.input as number, output: rawCost.output as number, cacheRead: rawCost.cacheRead as number, cacheWrite: rawCost.cacheWrite as number, total: rawCost.total as number } };
    return { timestamp: value.timestamp, usage: copy(usage) };
  } catch { return null; }
}

async function usageTimeline(conversation: Conversation, now: number) {
  const hourly = new Map<number, Usage>(), daily = new Map<number, Usage>();
  let scanned = 0, truncated = false;
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"] | undefined;
  while (scanned < MAX_USAGE_ENTRIES) {
    const page = await conversation.entries({}, Math.min(256, MAX_USAGE_ENTRIES - scanned), cursor, BACKGROUND_CONTEXT);
    scanned += page.items.length;
    for (const entry of page.items) for (const message of entry.model ?? []) {
      const sample = entryUsage(message);
      if (!sample || sample.timestamp < now - 30 * DAY || sample.timestamp > now) continue;
      const hour = Math.floor(sample.timestamp / HOUR) * HOUR;
      const day = Math.floor(sample.timestamp / DAY) * DAY;
      add(hourly.get(hour) ?? (hourly.set(hour, empty()), hourly.get(hour)!), sample.usage);
      add(daily.get(day) ?? (daily.set(day, empty()), daily.get(day)!), sample.usage);
    }
    cursor = page.next;
    if (cursor === undefined) break;
  }
  if (cursor !== undefined) truncated = true;
  return { hourly: [...hourly].filter(([at]) => at >= now - 48 * HOUR).sort(([a], [b]) => a - b).map(([at, usage]) => ({ at, ...usage })), daily: [...daily].sort(([a], [b]) => a - b).map(([at, usage]) => ({ at, ...usage })), scannedEntries: scanned, truncated };
}

type WorkerIdentity =
  | { kind: "thread"; threadId: string; conversationId: ConversationId; legacyNames: string[] }
  | { kind: "legacy"; name: string; conversationId: ConversationId; legacyNames: string[] };

export async function durableUsageSnapshot(harness: Harness, root: Conversation, threads: readonly { threadId: string; conversationId: ConversationId }[], options: { offset?: number; limit?: number }, legacy: readonly { name: string; conversationId: ConversationId }[] = [], work: readonly { threadId: string; role: string; text: string }[] = [], chats: readonly { id: string; title: string; archived: boolean; conversationId: number }[] = []) {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid usage page");
  const identities = new Map<ConversationId, WorkerIdentity>();
  const threadIds = new Set<string>();
  for (const thread of threads) {
    if (thread.conversationId === root.id || identities.has(thread.conversationId) || threadIds.has(thread.threadId)) throw new Error("Usage conversations must have unique owned identities");
    threadIds.add(thread.threadId);
    identities.set(thread.conversationId, { kind: "thread", ...thread, legacyNames: [] });
  }
  for (const worker of [...legacy].sort((a, b) => a.name.localeCompare(b.name))) {
    if (worker.conversationId === root.id) throw new Error("Legacy worker cannot identify the coordinator conversation");
    const existing = identities.get(worker.conversationId);
    if (existing) {
      if (!existing.legacyNames.includes(worker.name)) existing.legacyNames.push(worker.name);
    } else identities.set(worker.conversationId, { kind: "legacy", ...worker, legacyNames: [worker.name] });
  }
  const workersByIdentity = [...identities.values()].sort((a, b) => {
    const left = a.kind === "thread" ? `thread:${a.threadId}` : `legacy:${a.name}`;
    const right = b.kind === "thread" ? `thread:${b.threadId}` : `legacy:${b.name}`;
    return left.localeCompare(right);
  });
  const selected = workersByIdentity.slice(offset, offset + limit);
  const now = Date.now();
  const coordinator = { conversationId: Number(root.id), ...buckets(await harness.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT)), timeBuckets: await usageTimeline(root, now) };
  // Chats other than Main are separate coordinator conversations; every one is counted, archived included.
  const chatUsage = await Promise.all(chats.filter(chat => chat.conversationId !== Number(root.id)).map(async chat => {
    const conversation = await harness.conversation(chat.conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("Owned chat conversation is missing");
    return { chatId: chat.id, title: chat.title, archived: chat.archived, conversationId: chat.conversationId, ...buckets(await harness.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT)), timeBuckets: await usageTimeline(conversation, now) };
  }));
  const chatTotal = empty();
  for (const chat of chatUsage) add(chatTotal, chat.total);
  const workers = await Promise.all(selected.map(async thread => {
    const conversation = await harness.conversation(thread.conversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("Owned usage conversation is missing");
    const item = work.find(candidate => thread.kind === "thread" && candidate.threadId === thread.threadId);
    return { ...thread, legacyNames: [...thread.legacyNames], conversationId: Number(thread.conversationId), role: item?.role ?? null, title: item?.text ?? null, ...buckets(await harness.snapshot(UsageDoc, thread.conversationId, BACKGROUND_CONTEXT)), timeBuckets: await usageTimeline(conversation, now) };
  }));
  const workerPageTotal = empty();
  for (const worker of workers) add(workerPageTotal, worker.total);
  return { coordinator, chats: chatUsage, chatTotal: copy(chatTotal), workers, workerPageTotal: copy(workerPageTotal), totalWorkers: workersByIdentity.length, totalThreads: threads.length, legacyOnlyWorkers: workersByIdentity.filter(worker => worker.kind === "legacy").length, offset, nextOffset: offset + workers.length < workersByIdentity.length ? offset + workers.length : null,
    observedAtMs: Date.now(), accounting: "Each registered conversation is counted once: Main (coordinator), every other chat, and workers including retained legacy ones. Worker totals cover this page only. These are live reads, not an atomic accounting snapshot. Reasoning is included in output, and cacheWrite1h in cacheWrite. Costs are SDK estimates, not billing receipts." };
}
