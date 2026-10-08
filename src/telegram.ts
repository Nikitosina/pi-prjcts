import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inbox } from "./inbox.ts";
import { errorText, home, listProjects, loadProject, projectDir, saveJson, type Request } from "./state.ts";
import type { Notice, Notifier } from "./notify.ts";
import type { DurableChat } from "./durable-runtime.ts";

type Action =
  | { t: "project"; projectId: string }
  | { t: "chat"; projectId: string; chatId: string }
  | { t: "answer"; projectId: string; entryId: string; text: string }
  | { t: "accept"; projectId: string; entryId: string }
  | { t: "approve" | "reject"; projectId: string; operationId: string; fingerprint: string };
type Target = { projectId: string; chatId: string; entryId?: string };
type State = {
  version: 1; token: string | null; bot: { id: number; username: string } | null;
  owner: { chatId: number; name: string } | null; pairing: { code: string; expiresAt: number; wrong: number } | null;
  offset: number; sentSeq: number; route: { projectId: string; chatId: string } | null;
  /** Inline-button payloads by short key (callback_data is capped at 64 bytes) and sent messages by id, both bounded. */
  keys: Record<string, Action>; messages: Record<string, Target>;
  lastError: string | null; lastPollAt: number | null;
};
type Update = { update_id: number; message?: Message; callback_query?: { id: string; from: { id: number }; message?: Message; data?: string } };
type Message = { message_id: number; chat: { id: number; type: string; first_name?: string; username?: string; title?: string }; from?: { id: number; first_name?: string; username?: string }; text?: string; reply_to_message?: { message_id: number } };
type Button = { text: string; callback_data: string };
class TelegramError extends Error { code: number; retryAfter?: number; constructor(message: string, code: number, retryAfter?: number) { super(message); this.code = code; this.retryAfter = retryAfter; } }

const PAIR_MS = 10 * 60_000, PAIR_TRIES = 5, KEEP = 500, LIMIT = 4000;
const LABEL: Record<Notice["kind"], string> = { question: "Question", approval: "Approval", review: "Review", result: "Finished", error: "Error" };
const clip = (text: string, max = LIMIT) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const bounded = <T>(record: Record<string, T>) => { const keys = Object.keys(record); for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) delete record[key]; };
/** Same update, same admission request ID: a replayed update cannot admit a second turn. */
const updateRequestId = (bot: number, update: number) => { const h = createHash("sha256").update(`telegram:${bot}:${update}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/**
 * One Telegram bot per host. The token lives only in `<home>/telegram.json` (0600) and is redacted from every error.
 * Long-polls getUpdates (no public URL); the offset is persisted after each update and every effect is idempotent, so a replay after a crash changes nothing twice.
 * Only the chat paired with a short-lived code is heard; everyone else is ignored without a reply.
 */
export function startTelegram(options: { dispatch: (input: Request) => Promise<unknown>; chats: (projectId: string) => Promise<DurableChat[]>; notifier: Notifier; report: (detail: string) => void }) {
  const base = (process.env.PI_PROJECTS_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/+$/, "");
  const pollSeconds = Number(process.env.PI_PROJECTS_TELEGRAM_POLL_S ?? 25), backoffMs = Number(process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS ?? 1000);
  const path = join(home(), "telegram.json");
  const state: State = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, token: null, bot: null, owner: null, pairing: null, offset: 0, sentSeq: 0, route: null, keys: {}, messages: {}, lastError: null, lastPollAt: null };
  const persist = () => { bounded(state.keys); bounded(state.messages); saveJson(path, state); };
  const redact = (text: string, token = state.token) => token ? text.split(token).join("[token]") : text;
  let closed = false, rejected = false, polling = false, poll: AbortController | null = null, wake: (() => void) | null = null, flushing: Promise<void> | null = null, flushAgain = false, sendFailures = 0, retry: NodeJS.Timeout | undefined;
  const sleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); if (wake === done) wake = null; resolve(); } wake = done; });

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, token = state.token): Promise<T> {
    if (!token) throw new TelegramError("No Telegram bot is set", 0);
    let response: Response;
    try { response = await fetch(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) }); }
    catch (error) { throw new TelegramError(redact(`Telegram ${method} failed: ${errorText(error)}`, token), 0); }
    const data = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!data?.ok) throw new TelegramError(redact(`Telegram ${method}: ${data?.description ?? `HTTP ${response.status}`}`, token), data?.error_code ?? response.status, data?.parameters?.retry_after);
    return data.result as T;
  }
  const key = (action: Action) => { const id = randomBytes(6).toString("hex"); state.keys[id] = action; return `k:${id}`; };
  async function say(text: string, buttons: Button[][] = [], target?: Target) {
    if (!state.owner) return;
    const sent = await call<{ message_id: number }>("sendMessage", { chat_id: state.owner.chatId, text: clip(text), ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
    if (target) state.messages[String(sent.message_id)] = target;
    persist();
  }

  const active = () => listProjects().filter(project => project.runtime === "durable" && !project.deleted && !project.archived);
  const pick = <T extends { title: string }>(items: T[], query: string): T | undefined => {
    const index = Number(query);
    if (Number.isSafeInteger(index) && index >= 1 && index <= items.length) return items[index - 1];
    const lower = query.toLowerCase();
    return items.find(item => item.title.toLowerCase() === lower) ?? (items.filter(item => item.title.toLowerCase().startsWith(lower)).length === 1 ? items.find(item => item.title.toLowerCase().startsWith(lower)) : undefined);
  };
  async function routeName(route = state.route): Promise<string | null> {
    if (!route) return null;
    try { const project = loadProject(route.projectId), chat = (await options.chats(route.projectId)).find(item => item.id === route.chatId); return `${project.name} · ${chat?.title ?? "Main"}`; } catch { return null; }
  }
  async function select(projectId: string, chatId: string) {
    const project = loadProject(projectId);
    if (project.deleted || project.archived || project.runtime !== "durable") throw new Error(`${project.name} is not active`);
    const chat = (await options.chats(projectId)).find(item => item.id === chatId);
    if (!chat || chat.archived) throw new Error("That chat is archived or gone");
    state.route = { projectId, chatId }; persist();
    await say(`Now talking to ${project.name} · ${chat.title}. Send text to it, or /chats to pick another chat.`);
  }
  const help = "pi Projects. /projects pick a project, /chats pick a chat in it, /chat new <title> start one, /status where your text goes. Plain text goes to the picked chat; reply to a message to send to its chat or answer its question.";

  async function command(text: string) {
    const [, name, rest = ""] = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text) ?? [];
    const query = rest.trim();
    if (name === "projects" || name === "project" && !query) {
      const projects = active();
      return say(projects.length ? `Projects:\n${projects.map((project, i) => `${i + 1}. ${project.name}`).join("\n")}` : "No active projects.", projects.slice(0, 30).map(project => [{ text: project.name, callback_data: key({ t: "project", projectId: project.id }) }]));
    }
    if (name === "project") {
      const project = pick(active().map(item => ({ ...item, title: item.name })), query);
      if (!project) return say(`No project matches "${query}". /projects lists them.`);
      return select(project.id, "main");
    }
    if (name === "chats" || name === "chat") {
      if (!state.route) return say("Pick a project first: /projects");
      const projectId = state.route.projectId, chats = (await options.chats(projectId)).filter(chat => !chat.archived);
      if (name === "chats" || !query) return say(`Chats in ${loadProject(projectId).name}:\n${chats.map((chat, i) => `${i + 1}. ${chat.title}`).join("\n")}`, chats.slice(0, 30).map(chat => [{ text: chat.title, callback_data: key({ t: "chat", projectId, chatId: chat.id }) }]));
      const created = /^new\b\s*(.*)$/i.exec(query);
      if (created) { const chat = await options.dispatch({ action: "chat-create", id: projectId, ...(created[1].trim() ? { title: created[1].trim().slice(0, 120) } : {}) }) as DurableChat; return select(projectId, chat.id); }
      const chat = pick(chats, query);
      if (!chat) return say(`No chat matches "${query}". /chats lists them.`);
      return select(projectId, chat.id);
    }
    if (name === "status") return say(`${(await routeName()) ? `Text goes to ${await routeName()}.` : "No project picked: /projects."}`);
    return say(help);
  }

  async function deliver(target: Target, text: string, updateId: number) {
    try {
      const project = loadProject(target.projectId);
      await options.dispatch({ action: "message", id: target.projectId, text: text.slice(0, 32000), requestId: updateRequestId(state.bot!.id, updateId), ...(target.chatId !== "main" ? { chatId: target.chatId } : {}) });
      await say(`Sent to ${project.name} · ${(await options.chats(target.projectId)).find(chat => chat.id === target.chatId)?.title ?? "Main"}.`);
    } catch (error) { await say(`Not sent: ${errorText(error)}`); }
  }
  async function answer(projectId: string, entryId: string, text: string): Promise<string> {
    const entry = inbox(projectDir(projectId)).find(item => item.id === entryId);
    if (!entry || entry.kind !== "question") return "That question is gone.";
    if (entry.result) return `Already answered: ${entry.result.text}`;
    await options.dispatch({ action: "answer", id: projectId, entry: entryId, text: text.slice(0, 32000) });
    return `Answered: ${text}`;
  }

  async function onMessage(message: Message, updateId: number) {
    const text = message.text?.trim();
    if (!text) return;
    const target = message.reply_to_message ? state.messages[String(message.reply_to_message.message_id)] : undefined;
    if (target?.entryId && !text.startsWith("/")) {
      const entry = inbox(projectDir(target.projectId)).find(item => item.id === target.entryId);
      if (entry?.kind === "question" && !entry.result) return say(await answer(target.projectId, target.entryId, text));
    }
    if (text.startsWith("/")) return command(text);
    if (target) return deliver(target, text, updateId);
    if (!state.route) return say("Pick a project first: /projects");
    return deliver(state.route, text, updateId);
  }
  async function onCallback(callback: NonNullable<Update["callback_query"]>) {
    await call("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
    const action = /^k:([a-f0-9]{12})$/.test(callback.data ?? "") ? state.keys[callback.data!.slice(2)] : undefined;
    if (!action) return say("This button has expired.");
    const clear = () => callback.message ? call("editMessageReplyMarkup", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}) : undefined;
    try {
      if (action.t === "project") return await select(action.projectId, "main");
      if (action.t === "chat") return await select(action.projectId, action.chatId);
      if (action.t === "answer") { const reply = await answer(action.projectId, action.entryId, action.text); await clear(); return await say(reply); }
      if (action.t === "accept") {
        const entry = inbox(projectDir(action.projectId)).find(item => item.id === action.entryId);
        if (!entry || entry.result) { await clear(); return await say("Already reviewed."); }
        await options.dispatch({ action: "review", id: action.projectId, entry: action.entryId, operation: "accept" });
        await clear(); return await say("Accepted.");
      }
      const pending = (await options.dispatch({ action: "operation-snapshot", id: action.projectId, status: "pending", offset: 0, limit: 100 }) as { items: { id: string; fingerprint: string }[] }).items.find(item => item.id === action.operationId);
      if (!pending) { await clear(); return await say("Already decided."); }
      if (pending.fingerprint !== action.fingerprint) return await say("The approval changed; decide it in the browser.");
      await options.dispatch(action.t === "approve" ? { action: "operation-decide", id: action.projectId, operationId: action.operationId, fingerprint: action.fingerprint, decision: "approve", confirm: action.projectId } : { action: "operation-decide", id: action.projectId, operationId: action.operationId, fingerprint: action.fingerprint, decision: "reject" });
      await clear(); return await say(action.t === "approve" ? "Approved (consent recorded; nothing was executed)." : "Rejected.");
    } catch (error) { return say(`Failed: ${errorText(error)}`); }
  }
  async function handle(update: Update) {
    const message = update.message, callback = update.callback_query, chat = message?.chat ?? callback?.message?.chat;
    if (!chat) return;
    const code = message?.text ? /^\/(?:pair|start)(?:@\w+)?\s+(\d{6})$/.exec(message.text.trim())?.[1] : undefined;
    if (code && state.pairing) {
      const pairing = state.pairing;
      if (Date.now() > pairing.expiresAt) { state.pairing = null; persist(); return; }
      // Wrong codes and group chats get no reply; five wrong codes cancel the code.
      if (chat.type !== "private") return;
      if (!timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code))) { pairing.wrong++; if (pairing.wrong >= PAIR_TRIES) state.pairing = null; persist(); return; }
      state.owner = { chatId: chat.id, name: [message?.from?.first_name ?? chat.first_name, message?.from?.username ? `@${message.from.username}` : ""].filter(Boolean).join(" ") || String(chat.id) };
      state.pairing = null; state.sentSeq = options.notifier.seq(); persist();
      await say(`Paired. ${help}`);
      return;
    }
    if (!state.owner || chat.id !== state.owner.chatId || (callback && callback.from.id !== state.owner.chatId)) return;
    if (callback) return onCallback(callback);
    if (message) return onMessage(message, update.update_id);
  }

  async function loop() {
    let failures = 0;
    while (!closed) {
      if (!state.token || rejected) { polling = false; await sleep(3_600_000); continue; }
      polling = true;
      const controller = new AbortController(), token = state.token;
      poll = controller;
      try {
        const updates = await call<Update[]>("getUpdates", { offset: state.offset, timeout: pollSeconds, allowed_updates: ["message", "callback_query"] }, AbortSignal.any([controller.signal, AbortSignal.timeout((pollSeconds + 15) * 1000)]), token);
        if (controller.signal.aborted || token !== state.token) continue;
        failures = 0; state.lastPollAt = Date.now();
        if (state.lastError) { state.lastError = null; persist(); }
        for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
          if (update.update_id < state.offset || closed || token !== state.token) continue;
          try { await handle(update); } catch (error) { options.report(redact(`update ${update.update_id}: ${errorText(error)}`)); }
          state.offset = update.update_id + 1; persist();
        }
      } catch (error) {
        if (controller.signal.aborted || closed || token !== state.token) continue;
        const failure = error instanceof TelegramError ? error : new TelegramError(redact(errorText(error)), 0);
        if (failure.code === 401 || failure.code === 404) { rejected = true; state.lastError = "Telegram rejected the bot token; set it again in Settings"; persist(); continue; }
        failures++;
        state.lastError = failure.code === 409 ? "Another client is reading this bot's updates (409); stop it or use another bot" : failure.message; persist();
        await sleep(failure.retryAfter ? failure.retryAfter * 1000 : Math.min(60_000, backoffMs * 2 ** Math.min(failures - 1, 10)));
      } finally { if (poll === controller) poll = null; }
    }
    polling = false;
  }
  void loop();

  function format(notice: Notice): { text: string; buttons: Button[][] } {
    const head = `${notice.project} · ${notice.chat}\n${LABEL[notice.kind]}${notice.kind === "result" || notice.kind === "question" ? "" : `: ${notice.title}`}\n\n`;
    if (notice.kind === "question") return { text: head + notice.text + "\n\nTap an answer, or reply to this message in your own words.", buttons: (notice.choices ?? []).map(choice => [{ text: choice.slice(0, 60), callback_data: key({ t: "answer", projectId: notice.projectId, entryId: notice.entryId!, text: choice }) }]) };
    if (notice.kind === "approval") return { text: head + notice.text, buttons: [[{ text: "Approve", callback_data: key({ t: "approve", projectId: notice.projectId, operationId: notice.operationId!, fingerprint: notice.fingerprint! }) }, { text: "Reject", callback_data: key({ t: "reject", projectId: notice.projectId, operationId: notice.operationId!, fingerprint: notice.fingerprint! }) }]] };
    if (notice.kind === "review") return { text: head + notice.text, buttons: [[{ text: "Accept", callback_data: key({ t: "accept", projectId: notice.projectId, entryId: notice.entryId! }) }]] };
    return { text: head + notice.text + "\n\nReply to this message to write to this chat.", buttons: [] };
  }
  /** Sends feed notices after `sentSeq` in order; a failure stops the batch and retries with backoff, so nothing is skipped or sent twice. */
  function flush(): Promise<void> {
    if (flushing) { flushAgain = true; return flushing; }
    flushing = (async () => {
      do {
        flushAgain = false;
        while (!closed && state.token && state.owner && !rejected) {
          const next = options.notifier.feed(state.sentSeq).items[0];
          if (!next) break;
          const { text, buttons } = format(next);
          try { await say(clip(text), buttons, { projectId: next.projectId, chatId: next.chatId, ...(next.kind === "question" ? { entryId: next.entryId } : {}) }); sendFailures = 0; }
          catch (error) {
            sendFailures++; state.lastError = redact(errorText(error)); persist();
            clearTimeout(retry); retry = setTimeout(() => void flush(), Math.min(60_000, backoffMs * 2 ** Math.min(sendFailures - 1, 10))); retry.unref();
            return;
          }
          state.sentSeq = next.seq; persist();
        }
      } while (flushAgain && !closed);
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function snapshot() {
    const route = state.route ? { ...state.route, name: await routeName() } : null;
    return { configured: Boolean(state.token), botUsername: state.bot?.username ?? null, paired: Boolean(state.owner), owner: state.owner?.name ?? null, pairing: state.pairing && state.pairing.expiresAt > Date.now() ? { code: state.pairing.code, expiresAt: state.pairing.expiresAt } : null, route, lastError: state.lastError, lastPollAt: state.lastPollAt, polling: polling && !rejected };
  }
  const restart = () => { poll?.abort(); wake?.(); };
  return {
    snapshot,
    flush,
    async setToken(token: string) {
      let bot: { id: number; username: string };
      try { bot = await call<{ id: number; username: string }>("getMe", {}, undefined, token); }
      catch (error) { throw new Error(error instanceof TelegramError && error.code === 401 ? "Telegram rejected this token (401 Unauthorized)" : errorText(error).split(token).join("[token]")); }
      const same = state.bot?.id === bot.id;
      Object.assign(state, { token, bot: { id: bot.id, username: bot.username }, lastError: null }, same ? {} : { owner: null, pairing: null, offset: 0, route: null, keys: {}, messages: {} });
      rejected = false; persist(); restart(); void flush();
      return snapshot();
    },
    pair() {
      if (!state.token) throw new Error("Set a bot token first");
      state.pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: Date.now() + PAIR_MS, wrong: 0 }; persist();
      return snapshot();
    },
    unpair() { state.owner = null; state.pairing = null; persist(); return snapshot(); },
    remove() { Object.assign(state, { token: null, bot: null, owner: null, pairing: null, offset: 0, route: null, keys: {}, messages: {}, lastError: null }); persist(); restart(); return snapshot(); },
    close() { closed = true; clearTimeout(retry); restart(); },
  };
}
export type Telegram = ReturnType<typeof startTelegram>;
