import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inbox } from "./inbox.ts";
import { errorText, home, listProjects, loadProject, projectDir, saveJson, type Request } from "./state.ts";
import type { Notice, Notifier } from "./notify.ts";
import type { DurableChat } from "./durable-runtime.ts";
import { extractTelegramMedia, inspectTelegramMedia, loadTelegramMedia, telegramMediaForm, telegramAlbumForm, TELEGRAM_FILE_LIMIT, type TelegramPart } from "./telegram-media.ts";
import { escapeHtml, htmlToPlain, markdownToTelegramHtml, splitTelegramHtml, splitTelegramCaption } from "./telegram-html.ts";

type Action =
  | { t: "project"; projectId: string }
  | { t: "chat"; projectId: string; chatId: string }
  | { t: "answer"; projectId: string; entryId: string; text: string }
  | { t: "approve" | "reject"; projectId: string; operationId: string; fingerprint: string };
type Target = { projectId: string; chatId: string; entryId?: string };
type DeliveryError = { at: number; method: string; description: string } & (
  | { kind: "api"; httpStatus: number; code: number; descriptionProvided: boolean }
  | { kind: "network" | "not-sent" | "incomplete-response" }
);
type State = {
  version: 1; token: string | null; bot: { id: number; username: string } | null;
  owner: { chatId: number; name: string } | null; pairing: { code: string; expiresAt: number; wrong: number } | null;
  /** `sentPart`: parts of notice `seq` already sent, so a retry after a mid-way failure does not repeat them. */
  offset: number; sentSeq: number; sentPart?: { seq: number; parts: number; plan?: TelegramPart[]; pendingMedia?: boolean; anchorMessageId?: number }; route: { projectId: string; chatId: string } | null;
  /** Inline-button payloads by short key (callback_data is capped at 64 bytes) and sent messages by id, both bounded. */
  keys: Record<string, Action>; messages: Record<string, Target>;
  lastError: string | null; lastPollAt: number | null; deliveryErrors?: DeliveryError[];
};
type Update = { update_id: number; message?: Message; callback_query?: { id: string; from: { id: number }; message?: Message; data?: string } };
type Message = { message_id: number; chat: { id: number; type: string; first_name?: string; username?: string; title?: string }; from?: { id: number; first_name?: string; username?: string }; text?: string; reply_to_message?: { message_id: number } };
type Button = { text: string; callback_data: string };
/** A trusted transport guard may throw this only before forwarding a request, never after a timeout. */
export class TelegramRequestNotSentError extends Error {}

class TelegramError extends Error { code: number; retryAfter?: number; constructor(message: string, code: number, retryAfter?: number) { super(message); this.code = code; this.retryAfter = retryAfter; } }

const telegramResponse = Compile(Type.Object({
  ok: Type.Boolean(), result: Type.Optional(Type.Unknown()), description: Type.Optional(Type.String()), error_code: Type.Optional(Type.Integer()),
  parameters: Type.Optional(Type.Object({ retry_after: Type.Optional(Type.Number()) }, { additionalProperties: true })),
}, { additionalProperties: true }));

/** Keep the error wording, but never persist credentials or chat identifiers from an API echo. */
export function redactTelegramError(text: string, token: string | null, identifiers: readonly (string | number)[]): string {
  if (token) for (const value of [token, encodeURIComponent(token)]) text = text.split(value).join("[token]");
  text = text.replace(/https?:\/\/api\.telegram\.org\/bot[^/\s"']+/gi, "https://api.telegram.org/bot[token]");
  for (const id of [...new Set(identifiers.map(String))].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![\\w-])${escaped}(?!\\w)`, "g"), "[chat]");
  }
  return text.replace(/(\bchat(?:[_ -]?id)?["']?\s*(?:[:=]\s*)?["']?)-?\d+/gi, "$1[chat]").replace(/-100\d{6,}\b/g, "[chat]");
}

const UNCERTAIN_MEDIA = "Telegram attachment delivery is uncertain. Automatic resend blocked to avoid duplicates; verify in Telegram before resolving the outbox.";
const PAIR_MS = 10 * 60_000, PAIR_TRIES = 5, KEEP = 500, LIMIT = 4000;
const LABEL: Record<Notice["kind"], string> = { question: "Question", approval: "Approval", result: "Finished", error: "Error", pr: "Pull request" };
const clip = (text: string, max = LIMIT) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const bounded = <T>(record: Record<string, T>) => { const keys = Object.keys(record); for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) delete record[key]; };
/** Same update, same admission request ID: a replayed update cannot admit a second turn. */
const updateRequestId = (bot: number, update: number) => { const h = createHash("sha256").update(`telegram:${bot}:${update}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/**
 * One Telegram bot per host. The token lives only in `<home>/telegram.json` (0600) and is redacted from every error.
 * Long-polls getUpdates (no public URL); the offset is persisted after each update and every effect is idempotent, so a replay after a crash changes nothing twice.
 * Only the chat paired with a short-lived code is heard; everyone else is ignored without a reply.
 */
export function startTelegram(options: { dispatch: (input: Request) => Promise<unknown>; chats: (projectId: string) => Promise<DurableChat[]>; notifier: Notifier; receiveUpdates?: boolean; report: (detail: string) => void }) {
  const base = (process.env.PI_PROJECTS_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/+$/, "");
  const pollSeconds = Number(process.env.PI_PROJECTS_TELEGRAM_POLL_S ?? 25), backoffMs = Number(process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS ?? 1000);
  const path = join(home(), "telegram.json");
  const state: State = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, token: null, bot: null, owner: null, pairing: null, offset: 0, sentSeq: 0, route: null, keys: {}, messages: {}, lastError: null, lastPollAt: null };
  const persist = () => { bounded(state.keys); bounded(state.messages); saveJson(path, state); };
  const redact = (text: string, token = state.token, chatId?: unknown) => redactTelegramError(text, token, [state.owner?.chatId, state.bot?.id, chatId].flatMap(id => typeof id === "string" || typeof id === "number" ? [id] : []));
  const recordError = (error: DeliveryError) => { state.deliveryErrors = [...state.deliveryErrors ?? [], error].slice(-20); persist(); };
  let closed = false, rejected = false, polling = false, poll: AbortController | null = null, wake: (() => void) | null = null, flushing: Promise<void> | null = null, flushAgain = false, sendFailures = 0, retry: NodeJS.Timeout | undefined;
  const sleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); if (wake === done) wake = null; resolve(); } wake = done; });

  async function call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal, token = state.token): Promise<T> {
    if (!token) throw new TelegramError("No Telegram bot is set", 0);
    const chatId = body instanceof FormData ? body.get("chat_id") : body.chat_id;
    let response: Response;
    try { response = await fetch(`${base}/bot${token}/${method}`, { method: "POST", ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(body instanceof FormData ? 120_000 : 30_000) }); }
    catch (error) {
      const description = redact(errorText(error), token, chatId);
      recordError({ kind: error instanceof TelegramRequestNotSentError ? "not-sent" : "network", at: Date.now(), method, description });
      if (error instanceof TelegramRequestNotSentError) throw new TelegramRequestNotSentError(description);
      throw new TelegramError(`Telegram ${method} failed: ${description}`, 0);
    }
    const raw: unknown = await response.json().catch(() => null);
    const data = telegramResponse.Check(raw) ? raw : null;
    if (!data?.ok) {
      const description = redact(data?.description ?? `HTTP ${response.status}`, token, chatId), code = data?.error_code ?? response.status;
      recordError({ kind: "api", at: Date.now(), method, httpStatus: response.status, code, description, descriptionProvided: data?.description !== undefined });
      throw new TelegramError(`Telegram ${method}: ${description}`, code, data?.parameters?.retry_after);
    }
    return data.result as T;
  }
  const key = (action: Action) => { const id = randomBytes(6).toString("hex"); state.keys[id] = action; return `k:${id}`; };
  async function say(text: string, buttons: Button[][] = [], target?: Target) {
    if (!state.owner) return;
    const sent = await call<{ message_id: number }>("sendMessage", { chat_id: state.owner.chatId, text: clip(text), ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
    if (target) state.messages[String(sent.message_id)] = target;
    persist();
  }

  const active = () => listProjects().filter(project => !project.deleted && !project.archived);
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
    if (project.deleted || project.archived) throw new Error(`${project.name} is not active`);
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
  if (options.receiveUpdates !== false) void loop();

  /** Notice text is model Markdown, sent as Telegram HTML; the header and footer are ours, escaped. */
  function format(notice: Notice): { text: string; buttons: Button[][] } {
    const head = `<b>${escapeHtml(`${notice.project} · ${notice.chat}`.replace(/[\uE000\uE001]/g, ""))}</b>\n${escapeHtml(`${LABEL[notice.kind]}${notice.kind === "result" || notice.kind === "question" || notice.kind === "pr" ? "" : `: ${notice.title}`}`.replace(/[\uE000\uE001]/g, ""))}\n\n` + markdownToTelegramHtml(notice.text);
    if (notice.kind === "question") return { text: head + "\n\n<i>Tap an answer, or reply to this message in your own words.</i>", buttons: (notice.choices ?? []).map(choice => [{ text: choice.slice(0, 60), callback_data: key({ t: "answer", projectId: notice.projectId, entryId: notice.entryId!, text: choice }) }]) };
    if (notice.kind === "approval") return { text: head, buttons: [[{ text: "Approve record only", callback_data: key({ t: "approve", projectId: notice.projectId, operationId: notice.operationId!, fingerprint: notice.fingerprint! }) }, { text: "Reject", callback_data: key({ t: "reject", projectId: notice.projectId, operationId: notice.operationId!, fingerprint: notice.fingerprint! }) }]] };
    return { text: head + "\n\n<i>Reply to this message to write to this chat.</i>", buttons: [] };
  }
  async function authorizeArtifact(projectId: string, ref: string) {
    const match = /^artifact:([a-f0-9-]{36})\/(.+)$/.exec(ref);
    if (!match) throw new Error("Invalid attachment");
    const project = loadProject(projectId);
    if (project.deleted || project.archived) throw new Error("Project is no longer active");
    await options.dispatch({ action: "thread-history", id: projectId, threadId: match[1], offset: 0, limit: 1, textLimit: 1 });
  }
  /** Caption-first media/album delivery; only text exceeding caption capacity spills over. Every returned message routes replies. */
  async function sendNotice(notice: Notice) {
    if (!state.owner) return;
    const extracted = extractTelegramMedia(notice.text);
    const formatted = format({ ...notice, text: extracted.markdown });
    const buttons = formatted.buttons;
    let text = formatted.text.replace(/\uE000(\d+)\uE001/g, (_, index: string) => escapeHtml(extracted.media[Number(index)].caption));
    if (extracted.media.length && Array.from(htmlToPlain(text)).length > 1024 && notice.kind !== "approval") {
      text = text.replace(/<i>[^<]*<\/i>$/, notice.kind === "question" ? "<i>Reply or choose an answer.</i>" : "<i>Reply to chat.</i>");
    }
    const plan: TelegramPart[] = [];
    if (!extracted.media.length) {
      for (const chunk of splitTelegramHtml(text)) plan.push({ kind: "text", text: chunk });
    } else {
      const [caption = "", ...overflow] = splitTelegramCaption(text);
      let album = extracted.media.length > 1 && !buttons.length;
      let total = 0;
      if (album) for (const media of extracted.media) {
        try {
          await authorizeArtifact(notice.projectId, media.ref);
          const meta = inspectTelegramMedia(projectDir(notice.projectId), media.ref);
          total += meta.size;
          if (meta.method === "sendDocument" || total > TELEGRAM_FILE_LIMIT) album = false;
        } catch { album = false; }
        if (!album) break;
      }
      for (let index = 0; index < extracted.media.length;) {
        const refs = extracted.media.slice(index, index + (album ? 10 : 1)).map(media => media.ref);
        plan.push(refs.length > 1 ? { kind: "album", refs, caption: index === 0 ? caption : "" } : { kind: "media", ref: refs[0], caption: index === 0 ? caption : "" });
        index += refs.length;
      }
      for (const chunk of overflow) plan.push({ kind: "text", text: chunk });
    }
    if (extracted.media.length && state.sentPart?.seq === notice.seq && !state.sentPart.plan && state.sentPart.parts > 0) {
      // A pre-media release checkpointed text chunks, not caption parts. Never guess which content to replay.
      state.sentPart.pendingMedia = true; persist(); throw new Error(UNCERTAIN_MEDIA);
    }
    if (state.sentPart?.seq !== notice.seq) state.sentPart = { seq: notice.seq, parts: 0, plan };
    const parts = state.sentPart.plan ?? plan;
    state.sentPart.plan = parts;
    persist();
    if (state.sentPart.pendingMedia) throw new Error(UNCERTAIN_MEDIA);
    const hasMedia = parts.some(part => part.kind !== "text");
    const target: Target = { projectId: notice.projectId, chatId: notice.chatId, ...(notice.kind === "question" ? { entryId: notice.entryId } : {}) };
    for (let index = state.sentPart?.seq === notice.seq ? state.sentPart.parts : 0; index < parts.length; index++) {
      const markup = index === parts.length - 1 && buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {};
      // Only spillover or ungrouped items reply to the first media message.
      const reply = hasMedia && state.sentPart.anchorMessageId ? { reply_parameters: { message_id: state.sentPart.anchorMessageId, allow_sending_without_reply: true } } : {};
      let sent: { message_id: number }[];
      const part = parts[index];
      if (part.kind !== "text") {
        const refs = part.kind === "album" ? part.refs : [part.ref];
        let media: ReturnType<typeof loadTelegramMedia>[] = [];
        try {
          let total = 0;
          for (const ref of refs) {
            await authorizeArtifact(notice.projectId, ref);
            if (total + inspectTelegramMedia(projectDir(notice.projectId), ref).size > TELEGRAM_FILE_LIMIT) throw new Error("Upload exceeds memory bound");
            const file = loadTelegramMedia(projectDir(notice.projectId), ref);
            total += file.size;
            if (total > TELEGRAM_FILE_LIMIT) throw new Error("Upload exceeds memory bound");
            media.push(file);
          }
        } catch { media = []; }
        if (!media.length && part.kind === "album") {
          // No request started: checkpoint individual fallbacks so one missing file cannot hide valid ones.
          parts.splice(index, 1, ...refs.map((ref, item): TelegramPart => ({ kind: "media", ref, caption: item === 0 ? part.caption : "" })));
          state.sentPart.plan = parts; persist();
          index--; continue;
        }
        if (!media.length) {
          sent = [await call("sendMessage", { chat_id: state.owner.chatId, text: `${htmlToPlain(part.caption)}\n[Attachment unavailable, unauthorized, or exceeds upload limits]`, ...markup, ...reply })];
        } else {
          state.sentPart.pendingMedia = true; persist();
          const upload = async (document = false): Promise<{ message_id: number }[]> => {
            const form = part.kind === "album" ? telegramAlbumForm(media, state.owner!.chatId, part.caption, document || media.some(file => file.method === "sendDocument")) : telegramMediaForm(media[0], state.owner!.chatId, part.caption, document);
            if ("reply_markup" in markup) form.body.set("reply_markup", JSON.stringify(markup.reply_markup));
            if ("reply_parameters" in reply) form.body.set("reply_parameters", JSON.stringify(reply.reply_parameters));
            const result = await call<{ message_id: number } | { message_id: number }[]>(form.method, form.body);
            const messages = Array.isArray(result) ? result : [result];
            if (messages.length !== refs.length || messages.some(message => !message || !Number.isSafeInteger(message.message_id) || message.message_id <= 0) || new Set(messages.map(message => message.message_id)).size !== messages.length) {
              const description = "Telegram upload response is incomplete; delivery uncertain";
              recordError({ kind: "incomplete-response", at: Date.now(), method: form.method, description });
              throw new TelegramError(description, 0);
            }
            return messages;
          };
          try {
            try { sent = await upload(); }
            catch (error) {
              if (!(error instanceof TelegramError && error.code === 400) || media.some(file => file.method === "sendDocument")) throw error;
              sent = await upload(true);
            }
          } catch (error) {
            if (error instanceof TelegramRequestNotSentError) {
              delete state.sentPart.pendingMedia; persist(); throw error;
            }
            // Only explicit rejection proves Telegram did not create a message or album.
            if (error instanceof TelegramError && error.code >= 400 && error.code < 500) {
              delete state.sentPart.pendingMedia; persist();
              if (error.code === 400 || error.code === 413) {
                sent = [await call("sendMessage", { chat_id: state.owner.chatId, text: `${htmlToPlain(part.caption)}\n[Telegram rejected this attachment]`, ...markup, ...reply })];
              } else throw error;
            } else throw error;
          }
          delete state.sentPart.pendingMedia;
        }
      } else {
        try { sent = [await call("sendMessage", { chat_id: state.owner.chatId, text: part.text, parse_mode: "HTML", ...markup, ...reply })]; }
        catch (error) {
          if (!(error instanceof TelegramError && error.code === 400 && /can't parse entities/i.test(error.message))) throw error;
          sent = [await call("sendMessage", { chat_id: state.owner.chatId, text: htmlToPlain(part.text), ...markup, ...reply })];
        }
      }
      for (const message of sent) {
        state.messages[String(message.message_id)] = target;
        state.sentPart.anchorMessageId ??= message.message_id;
      }
      state.sentPart.parts = index + 1; persist();
    }
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
          try { await sendNotice(next); sendFailures = 0; }
          catch (error) {
            sendFailures++; state.lastError = state.sentPart?.pendingMedia ? UNCERTAIN_MEDIA : redact(errorText(error)); persist();
            if (state.sentPart?.pendingMedia || error instanceof TelegramRequestNotSentError) return;
            clearTimeout(retry); retry = setTimeout(() => void flush(), Math.min(60_000, backoffMs * 2 ** Math.min(sendFailures - 1, 10))); retry.unref();
            return;
          }
          state.sentSeq = next.seq; delete state.sentPart; persist();
        }
      } while (flushAgain && !closed);
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function snapshot() {
    const route = state.route ? { ...state.route, name: await routeName() } : null;
    return { configured: Boolean(state.token), botUsername: state.bot?.username ?? null, paired: Boolean(state.owner), owner: state.owner?.name ?? null, pairing: state.pairing && state.pairing.expiresAt > Date.now() ? { code: state.pairing.code, expiresAt: state.pairing.expiresAt } : null, route, lastError: state.lastError, deliveryErrors: state.deliveryErrors ?? [], lastPollAt: state.lastPollAt, polling: polling && !rejected };
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
      Object.assign(state, { token, bot: { id: bot.id, username: bot.username }, lastError: null }, same ? {} : { owner: null, pairing: null, offset: 0, route: null, keys: {}, messages: {}, deliveryErrors: [] });
      rejected = false; persist(); restart(); void flush();
      return snapshot();
    },
    pair() {
      if (!state.token) throw new Error("Set a bot token first");
      state.pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: Date.now() + PAIR_MS, wrong: 0 }; persist();
      return snapshot();
    },
    unpair() { state.owner = null; state.pairing = null; persist(); return snapshot(); },
    remove() { Object.assign(state, { token: null, bot: null, owner: null, pairing: null, offset: 0, route: null, keys: {}, messages: {}, lastError: null, deliveryErrors: [] }); persist(); restart(); return snapshot(); },
    close() { closed = true; clearTimeout(retry); restart(); },
  };
}
export type Telegram = ReturnType<typeof startTelegram>;
