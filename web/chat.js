// Center: the Coordinator chat. Transcript from `show`, older pages from `chat-history`, live frames from `/live`.
// Tool calls are compact rows; a finished turn folds runs of two or more rows into one group; reports link to the worker.
import { HostError, call, stream, uuid } from "./api.js";
import { clip, clock, dur, esc, imagesHtml, markdown, oneLine } from "./format.js";
import { hydrateMedia } from "./media.js";
import { FILE_ONLY_NOTE, PathSource, insertText, pathsFromTransfer } from "./path-drop.js";
import { slashCommand, slashKey } from "./slash.js";
import { chatArgs, emit, fail, on, stale, state, toast } from "./state.js";
import { markMemoryUndone, memoryEntry, memoryKind, memoryReady, memoryTitle, memoryWrite, wantMemoryWrite } from "./memory.js";
import { follower } from "./follow.js";

const feed = document.querySelector("#feed"),
  input = document.querySelector("#composer-input"),
  form = document.querySelector("#composer"),
  follow = follower(feed);
let live = null,
  liveKey = "",
  older = [],
  olderGroups = null,
  olderBefore = null,
  loading = null,
  reads = 0, // transcript reads started so far; a pending send's refusal is only proven by a read that starts after it
  held = null; // live text and thinking of a step the host just committed, shown until a transcript read that includes it renders
const pendingSends = []; // owner messages sent from this page that the transcript does not show yet, oldest first
// The recovery handle of an unsettled send survives a reload: its id, project, chat and exact text, so Retry sends the same message under the same id.
// One storage key per attempt, so tabs never overwrite each other's handles.
const HANDLE_PREFIX = "pi-pending-send:",
  LEGACY_HANDLES = "pi-pending-sends";
const savedHandles = new Map(); // attempt id → the stored text of its handle
function loadHandles() {
  const found = [];
  // The first version kept one list under one key; its handles move to their own keys before the list goes.
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_HANDLES) ?? "[]");
    for (const item of Array.isArray(old) ? old : [])
      if (typeof item?.id === "string" && /^[0-9a-f-]{36}$/.test(item.id) && !localStorage.getItem(HANDLE_PREFIX + item.id))
        localStorage.setItem(HANDLE_PREFIX + item.id, JSON.stringify(item));
    localStorage.removeItem(LEGACY_HANDLES);
  } catch {}
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(HANDLE_PREFIX)) continue;
      const item = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        typeof item?.id === "string" &&
        key === HANDLE_PREFIX + item.id &&
        /^[0-9a-f-]{36}$/.test(item.id) &&
        typeof item.projectId === "string" &&
        typeof item.chatId === "string" &&
        typeof item.text === "string" &&
        item.text &&
        (item.retryOf === undefined || typeof item.retryOf === "string") &&
        (item.attachments === undefined || (Array.isArray(item.attachments) && item.attachments.every((id) => typeof id === "string")))
      ) {
        savedHandles.set(item.id, localStorage.getItem(key));
        found.push({
          id: item.id,
          projectId: item.projectId,
          chatId: item.chatId,
          text: item.text,
          ...(item.retryOf ? { retryOf: item.retryOf } : {}),
          ...(item.attachments ? { attachments: item.attachments } : {}),
          state: "unconfirmed",
          error: "This page was reloaded before the host confirmed the message.",
          restored: false,
          refused: false,
          failedRead: 0,
        });
      }
    }
  } catch {}
  return found;
}
/** Stores the handle before anything is sent; false when the browser cannot keep it, and then nothing may be sent: a reload would lose the message without a trace. */
function rememberSend({ id, projectId, chatId, text, attachments, retryOf }) {
  const stored = JSON.stringify({ id, projectId, chatId, text, ...(retryOf ? { retryOf } : {}), ...(attachments ? { attachments } : {}) });
  try {
    localStorage.setItem(HANDLE_PREFIX + id, stored);
    if (localStorage.getItem(HANDLE_PREFIX + id) !== stored) return false;
  } catch {
    return false;
  }
  savedHandles.set(id, stored);
  return true;
}
// A handle goes once its message is settled: delivered and shown, dismissed, or refused with the text back in the composer.
function saveHandles() {
  const open = new Set(pendingSends.filter((send) => !(send.state === "failed" && send.restored)).map((send) => send.id));
  for (const id of [...savedHandles.keys()])
    if (!open.has(id)) {
      try {
        localStorage.removeItem(HANDLE_PREFIX + id);
      } catch {}
      savedHandles.delete(id);
    }
}
pendingSends.push(...loadHandles());
const expanded = new Set(); // tool callIds and group keys the owner opened
const revealed = new Set(); // long owner messages opened during this chat visit, keyed by transcript scope; they stay open until the owner navigates away
const CHAT_SCOPE = "msg:"; // the coordinator chat's keys have no scope prefix
let renderScope = ""; // the transcript `transcriptHtml` is drawing: "" for the chat, `w:<id>|` for a worker, `host|` for the Host agent

/** Collapses again the messages of one transcript scope (a worker or the Host agent being opened); `root` is its retained DOM, if any. */
export function forgetReveals(scope, root) {
  for (const key of [...revealed]) if (key.startsWith(scope)) revealed.delete(key);
  for (const hint of root?.querySelectorAll('.msg-more[aria-expanded="true"]') ?? []) hint.setAttribute("aria-expanded", "false");
}
function inJobs(snapshot, id) {
  const [jobId, childId] = id.split("/"),
    jobs = snapshot?.jobs ?? [];
  if (childId) return jobs.find((job) => job.id === jobId)?.children?.some((child) => String(child.id) === childId) ?? false;
  return jobs.some((job) => job.id === id) || (snapshot?.agents ?? []).some((agent) => agent.id === id);
}
/** The page's snapshot may not have caught up with a worker that just started, so the host is asked before a link is refused. */
async function knownWorker(id) {
  if (inJobs(state.jobs, id)) return true;
  const gen = state.generation;
  try {
    const snapshot = await call("jobs-snapshot", { id: state.projectId });
    return !stale(gen) && inJobs(snapshot, id);
  } catch {
    return false;
  }
}
/** The request id of a failed turn's Retry comes from the turn, so another tab's click, or this one after a reload, names the same delivery. */
async function retryId(projectId, chatId, failedId) {
  if (!crypto.subtle) return uuid();
  const hex = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`retry:${projectId}:${chatId}:${failedId}`))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const reportPattern = /^\[(worker|scout|reviewer) ([0-9a-f-]{36}) ([\w-]+(?: to start)?): ([^\]\n]*)\]([\s\S]*)$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Re-reads the selected chat. Coalesces: a call while one is in flight runs once more afterwards. */
export async function loadChat() {
  if (loading) {
    loading.again = true;
    return loading.promise;
  }
  const run = { again: false };
  loading = run;
  run.promise = (async () => {
    try {
      do {
        run.again = false;
        const gen = state.generation,
          read = ++reads,
          id = state.projectId,
          entries = state.live?.entries ?? 0;
        if (!id) return;
        try {
          const view = await call("show", { id, ...chatArgs(), messageText: "full" });
          // Another chat or project was selected meanwhile: drop this read, but still run the one that selection queued.
          if (stale(gen)) continue;
          state.view = view;
          reconcilePending(view, read);
          if (held && (entries >= held.entries || committed(view, held))) held = state.liveHeld = null;
          emit("view", view);
          renderFeed();
          renderQuestions();
          ensureLive();
        } catch (error) {
          fail(error);
        }
      } while (run.again);
    } finally {
      loading = null;
    }
  })();
  return run.promise;
}
// A draft restored after a refusal, and whatever the owner makes of it, belongs to the chat it was sent from: the composer gives it up when another
// chat opens and takes it back when its chat returns. An edit makes it a different message than the failed bubble's, so that bubble gets its own Retry.
const drafts = new Map(); // "project/chat" → { text, original, sendId }: restored drafts, and what the owner made of them
const draftKey = (projectId = state.projectId, chatId = state.chatId) => `${projectId}/${chatId}`;
let composerKey = null; // the chat whose draft the composer shows
const forgetRestored = (sendId) => {
  const send = pendingSends.find((item) => item.id === sendId);
  if (send?.restored) send.restored = false;
};
input.addEventListener("input", () => {
  const held = drafts.get(draftKey());
  if (!held) return;
  held.text = input.value;
  if (input.value !== held.original) {
    forgetRestored(held.sendId);
    renderFeed();
  }
});
on("select", () => {
  const now = draftKey(),
    left = composerKey;
  composerKey = now;
  const away = left && left !== now ? drafts.get(left) : undefined;
  if (away) {
    if (input.value === away.text) {
      input.value = "";
      grow();
    }
    // An unedited restored draft goes back to the bubble's own Retry; an edited one waits for its chat.
    if (away.text === away.original) {
      forgetRestored(away.sendId);
      drafts.delete(left);
    }
  }
  const here = drafts.get(now);
  if (here && !input.value) {
    input.value = here.text;
    grow();
  }
  older = [];
  olderGroups = null;
  follow.follow();
  expanded.clear();
  for (const key of revealed) if (key.startsWith(CHAT_SCOPE)) revealed.delete(key);
  feed.replaceChildren();
  document.querySelector("#questions").replaceChildren();
  state.live = null;
  held = state.liveHeld = null;
  live?.stop();
  live = null;
  liveKey = "";
});

on("memory-recent", () => renderFeed());

on("chat-display", (ui) => {
  if (!state.view) return;
  if (ui.toolSummaries.enabled) void loadChat();
  else renderFeed();
});

function ensureLive() {
  const key = `${state.projectId}:${state.chatId}`;
  if (liveKey === key) return;
  live?.stop();
  liveKey = key;
  const gen = state.generation;
  live = stream(`/live?project=${encodeURIComponent(state.projectId)}&chat=${encodeURIComponent(state.chatId)}`, (frame) => {
    if (stale(gen)) return;
    const previous = state.live;
    state.live = frame;
    const compaction =
      previous && (previous.compacting !== frame.compacting || previous.compactionFailure?.error !== frame.compactionFailure?.error);
    const refresh = previous && (previous.entries !== frame.entries || previous.running !== frame.running || compaction);
    // A committed step (or the final answer) leaves the live frame now but reaches the transcript only with the next read:
    // keep showing it until a read that started after this frame renders (live-chain-failures.md 13-14).
    if (refresh && (previous.entries !== frame.entries || (previous.running && !frame.running))) {
      const sameText = !!frame.text && frame.text === previous.text,
        thinkingText = previous.thinking ? previous.thinkingText : "";
      if (!sameText && (previous.text || thinkingText)) held = { entries: frame.entries, text: previous.text, thinkingText };
      else if (held) held.entries = frame.entries;
    }
    state.liveHeld = held ? (held.text ? "writing" : "thinking") : null;
    emit("live", frame);
    // A refresh leaves the live turn as drawn: renderFeed redraws it with the transcript and keeps the reader's place.
    if (refresh) void loadChat();
    else renderLive();
  });
}

// ---------------------------------------------------------------------------------------------------------------- transcript

/** Whether a read that started before the commit frame already holds the held step, so it is not shown twice. */
function committed(view, step) {
  return (view.messages ?? [])
    .slice(-12)
    .some(
      (item) =>
        item.kind === "message" &&
        item.role === "assistant" &&
        (step.text ? item.text?.trim() === step.text.trim() : !!step.thinkingText && item.thinking?.trim() === step.thinkingText.trim()),
    );
}

function messages() {
  return [...older, ...(state.view?.messages ?? [])];
}
/** Turns: an owner (or internal) input followed by everything the coordinator did for it. */
function turns(items) {
  const out = [];
  let current = null;
  for (const item of items) {
    if (item.kind === "reset") continue;
    const opens = item.kind === "message" && item.role === "user";
    if (opens || !current) {
      current = { start: item, items: [] };
      out.push(current);
      if (opens) continue;
    }
    current.items.push(item);
  }
  return out;
}
const STARTERS = [
  "Read this workspace and tell me what it does and how it is built.",
  "Find the riskiest open problem here and propose the smallest fix.",
  "Plan the next small change, then hand it to a worker.",
];
export function renderFeed() {
  saveHandles();
  if (!state.view) {
    // A message sent before the first read of a chat still shows at once.
    follow.render(() => morph(feed, pendingSends.filter(inCurrentChat).map(pendingHtml).join("")));
    return;
  }
  const all = turns(messages()),
    busy = !!state.live?.running || !!currentChat()?.busy;
  const html = [];
  if (older.length ? olderBefore : state.view.before) html.push(`<button type="button" class="earlier" data-earlier>Show earlier</button>`);
  const sends = pendingSends.filter(inCurrentChat);
  if (!all.length && !sends.length)
    html.push(
      `<div class="empty-chat" data-key="empty"><p class="empty-title">${esc(state.view.project?.name ?? "")}</p><p class="muted">Ask the coordinator for something. It plans, delegates to workers and reports back here.</p><div class="starters" role="list" aria-label="Starter prompts">${STARTERS.map((text, index) => `<button type="button" role="listitem" class="starter" data-starter="${index}"><span class="starter-glyph" aria-hidden="true">❯</span>${esc(text)}</button>`).join("")}</div><p class="muted small">A starter fills the composer; <kbd>Enter</kbd> sends it.</p></div>`,
    );
  html.push(transcriptHtml(all, busy, "Coordinator", { groups: mergeGroups(olderGroups, state.view.toolGroups) }));
  html.push(...sends.map(pendingHtml));
  html.push(failureHtml());
  html.push(`<div id="live-turn"></div>`);
  follow.render(() => {
    morph(feed, html.join(""));
    renderLive();
  });
}
const inCurrentChat = (send) => send.projectId === state.projectId && send.chatId === state.chatId;
/** Settles the pending sends of the open chat against transcript read number `read`. Only the host's own records count: a job it admitted is
 * delivered, and the transcript entry the runtime linked to that job is the message. A record the host never admitted, or a text that merely
 * looks alike, proves nothing, and only a read after a refusal without any record proves the refusal. */
function reconcilePending(view, read) {
  const ledger = view.jobs ?? [];
  for (const send of pendingSends.filter(inCurrentChat)) {
    const job = ledger.find((item) => item.id === send.id);
    if (!job) {
      if (send.state === "unconfirmed" && send.refused && read > send.failedRead) failSend(send);
      continue;
    }
    if (!job.admitted) continue;
    send.state = "sent";
    const placed = job.entry !== undefined && (view.messages ?? []).some((item) => item.kind === "message" && item.entryId === job.entry);
    // A settled job whose message never reached the transcript leaves its outcome in the turn card; the bubble must not outlive it.
    if (placed || ["done", "failed", "interrupted"].includes(job.state)) pendingSends.splice(pendingSends.indexOf(send), 1);
  }
}
/** A refusal the host reported and recorded no job for: the message was not sent, and its text goes back to an empty composer of the same chat. */
function failSend(send) {
  send.state = "failed";
  if (inCurrentChat(send) && !input.value) {
    input.value = send.text;
    send.restored = true;
    composerKey = draftKey(send.projectId, send.chatId);
    drafts.set(composerKey, { text: send.text, original: send.text, sendId: send.id });
    grow();
  }
}
const NO_HANDLE = "This browser cannot keep a recovery copy of the message, so it was not sent.";
const NO_HANDLE_AGAIN =
  "This browser cannot keep a recovery copy of the message, so it was not sent again. The first attempt may have reached the host.";
const DELIVERY = { sending: "Sending…", sent: "Sent", failed: "Not sent", unconfirmed: "Delivery not confirmed" };
function pendingHtml(send) {
  const note =
    send.state === "failed"
      ? `${esc(clip(oneLine(send.error), 300))}${send.restored ? " The text is back in the composer." : ""}`
      : send.state === "unconfirmed"
        ? `${esc(clip(oneLine(send.error), 200))} The message may or may not have arrived; it is not sent again on its own.`
        : "";
  const retry = send.state === "unconfirmed" || (send.state === "failed" && !send.restored);
  const actions =
    send.state !== "sending"
      ? `<div class="pending-note" role="status">${note}${retry ? ` <button type="button" class="link-btn" data-pending-retry="${esc(send.id)}">Retry</button>` : ""} <button type="button" class="link-btn" data-pending-dismiss="${esc(send.id)}">Dismiss</button></div>`
      : "";
  const key = `${renderScope}pending:${send.id}`,
    hint = `<button type="button" class="msg-more" data-reveal="${esc(key)}" aria-expanded="${revealed.has(key)}">Show more ▾ · ${send.text.length.toLocaleString("en-US")} chars</button>`;
  const sig = hash(`${send.state}|${send.error}|${send.restored}`);
  return `<section class="turn" data-key="p${esc(send.id)}" data-sig="${sig}"><article class="msg owner pending" data-delivery="${send.state}"><div class="msg-meta"><span class="who">You</span><span class="delivery">${DELIVERY[send.state]}</span></div><div class="bubble"><div class="msg-body" tabindex="-1">${markdown(send.text)}</div></div>${hint}${actions}</article></section>`;
}
/** Sends one pending message under its own request id (the host returns the job it already holds for a repeated id). A failure never sends again on its own. */
async function deliver(send) {
  if (!rememberSend(send)) {
    // Only a first attempt is known not to have been sent; an earlier one may have reached the host, so its status stays as it was.
    const first = send.state === "sending";
    if (first) {
      send.state = "failed";
      send.error = NO_HANDLE;
    }
    send.restored = false;
    toast(first ? NO_HANDLE : NO_HANDLE_AGAIN, { error: true, ms: 8000 });
    renderFeed();
    return;
  }
  send.state = "sending";
  send.error = "";
  renderFeed();
  let job;
  try {
    job = await call("message", {
      id: send.projectId,
      text: send.text,
      requestId: send.id,
      ...(send.attachments ? { attachments: send.attachments } : {}),
      ...(send.chatId === "main" ? {} : { chatId: send.chatId }),
    });
  } catch (error) {
    if (!pendingSends.includes(send)) return; // the transcript already shows it
    send.state = "unconfirmed";
    send.refused = error instanceof HostError && error.refused;
    send.error = error.message;
    send.failedRead = reads;
    const where = inCurrentChat(send) ? "" : "In another chat: ";
    toast(`${where}${send.refused ? error.message : `Delivery not confirmed: ${error.message}`}`, { error: true, ms: 8000 });
    // The next read decides: a recorded job means the host may have the message, none after a refusal means it was not sent.
    if (inCurrentChat(send)) {
      renderFeed();
      await loadChat();
    }
    return;
  }
  // Only an ack that says the host admitted the message is delivery; any other answer waits for the ledger.
  if (pendingSends.includes(send) && send.state === "sending") {
    if (job?.admitted && job.id === send.id) send.state = "sent";
    else {
      send.state = "unconfirmed";
      send.refused = false;
      send.error = "The host did not confirm it took the message.";
      send.failedRead = reads;
    }
  }
  if (!inCurrentChat(send)) return;
  renderFeed();
  await loadChat();
}
/** The chat's newest turn when it failed or was interrupted: the provider error and Retry (coordinator-stability-failures.md S4-S6). */
function failureHtml() {
  const job = (state.view.jobs ?? []).at(-1);
  if (!job || (job.state !== "failed" && job.state !== "interrupted")) return "";
  return `<div class="turn-failure" data-key="f${esc(job.id)}" role="status"><span class="st err" aria-hidden="true">✕</span><span class="tf-text">Turn ${esc(job.state)}: ${esc(clip(oneLine(job.error ?? "no reason recorded"), 300))}</span><button type="button" class="link-btn" data-retry-job="${esc(job.id)}">Retry</button></div>`;
}
/** Where this chat's images come from (see media.js). */
const mediaSource = () => (state.projectId ? { project: state.projectId, chatId: state.chatId } : null);
// An owner message clamps to CLAMP_LINES once it runs past ENGAGE_LINES, so opening it always reveals more than the hint costs (see .msg-body).
const ENGAGE_LINES = 8,
  CLAMP_LINES = 6; // keep in step with `max-height` of .msg-body in styles.css
const messageSizes = new ResizeObserver((entries) => entries.forEach(({ target }) => measureMessage(target)));
/** Marks the message whose text overflows the clamp (`data-overflow`); a hidden transcript keeps the mark it had. */
function measureMessage(body) {
  const article = body.closest(".msg");
  if (!article || !body.getClientRects().length) return;
  const line = parseFloat(getComputedStyle(body).lineHeight) || 21;
  if (body.scrollHeight > line * ENGAGE_LINES) article.dataset.overflow = "1";
  else delete article.dataset.overflow;
}
function watchMessages(parent) {
  for (const body of parent.querySelectorAll(".msg-body:not([data-watched])")) {
    body.dataset.watched = "1";
    measureMessage(body);
    messageSizes.observe(body);
  }
}
/** Replaces children while keeping nodes whose key and html did not change, so rows only animate in when they are new. */
export function morph(parent, html) {
  const next = document.createElement("div");
  next.innerHTML = html;
  const old = new Map([...parent.children].filter((node) => node.dataset.key).map((node) => [node.dataset.key, node]));
  const nodes = [...next.children].map((node) => {
    const keep = node.dataset.key && old.get(node.dataset.key);
    if (keep && keep.dataset.sig === node.dataset.sig) return keep;
    if (keep) node.classList.add("no-enter");
    return node;
  });
  // Kept nodes stay attached unless they are out of order, so a selection or focus inside them survives the render.
  const wanted = new Set(nodes);
  for (const child of [...parent.childNodes]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const at = parent.children[index];
    if (at !== node) parent.insertBefore(node, at ?? null);
  });
  watchMessages(parent);
}

const PROGRESS = { collecting: 0, pending: 1, ready: 2, failed: 2 };
/** The tool groups of two pages; a group on both keeps the state it reached later (a page read earlier may be stale), `newer`'s on a tie. */
export function mergeGroups(older, newer) {
  if (!older || !newer) return newer ?? older ?? null;
  const groups = { ...older.groups, ...newer.groups };
  for (const [id, view] of Object.entries(older.groups)) {
    const other = newer.groups[id];
    if (other && (PROGRESS[view.status] > PROGRESS[other.status] || (view.status === other.status && view.calls > other.calls)))
      groups[id] = view;
  }
  return { groups, calls: { ...older.calls, ...newer.calls } };
}
/** Turn sections for a list of transcript items (also used for worker transcripts in the center). `groups` are the host's tool
 * groups of the loaded calls (`{ groups, calls }`); they show only while the owner has summaries on. */
export function transcriptHtml(items, busy, who = "Coordinator", { fold = true, groups = null, scope = "" } = {}) {
  const all = Array.isArray(items[0]?.items) ? items : turns(items);
  const shown = state.ui?.toolSummaries?.enabled ? groups : null;
  renderScope = scope;
  try {
    return all.map((turn, index) => turnHtml(turn, busy && index === all.length - 1, who, fold, shown)).join("");
  } finally {
    renderScope = "";
  }
}
function turnHtml(turn, liveTurn, who, fold = true, groups = null) {
  const { start } = turn,
    key = `t${start.entryId ?? start.at}`;
  // A turn that does not open with an input (a page starting mid-turn) has its first item in `items` too.
  const head = start.kind === "message" && start.role === "user" ? inputHtml(start, who) : "";
  const body = []; // html, or a host tool group drawn once at its first call
  const blocks = new Map();
  let run = [];
  const runHtml = (entries) =>
    entries.length >= 2 && !liveTurn && fold ? groupHtml(entries) : entries.map((entry) => toolRowHtml(entry, callStatus(entry))).join("");
  const flush = () => {
    if (run.length) body.push(runHtml(run));
    run = [];
  };
  const results = new Map(turn.items.filter((item) => item.kind === "tool-result").map((item) => [item.callId, item]));
  // A call without a result runs only in this transcript's own live turn (a worker's, not the coordinator's).
  const callStatus = (entry) => (entry.result ? undefined : liveTurn ? "running" : "ok");
  for (const item of turn.items) {
    // Memory rows never fold: what the agent remembered or relied on stays visible.
    if (item.kind === "tool-call" && MEMORY.test(item.name)) {
      // A memory row inside a group stays out of its line and does not split it.
      flush();
      const entry = { call: item, result: results.get(item.callId) };
      body.push(toolRowHtml(entry, callStatus(entry)));
    } else if (item.kind === "tool-call" && groups?.groups[groups.calls[`${item.entryId}:${item.callId}`]]) {
      // A message's thinking and text come before its calls, so a later call can follow the item that closed its group.
      const id = groups.calls[`${item.entryId}:${item.callId}`];
      flush();
      if (!blocks.has(id)) {
        blocks.set(id, { id, view: groups.groups[id], entries: [] });
        body.push(blocks.get(id));
      }
      blocks.get(id).entries.push({ call: item, result: results.get(item.callId) });
    } else if (item.kind === "tool-call") {
      run.push({ call: item, result: results.get(item.callId) });
    } else if (item.kind === "tool-result") continue;
    else if (item.kind === "message" && item.role === "assistant" && !item.text?.trim() && !item.thinking?.trim() && !item.images?.length)
      continue;
    else {
      flush();
      body.push(itemHtml(item, who));
    }
  }
  flush();
  const html = head + body.map((part) => (typeof part === "string" ? part : summaryHtml(part, runHtml))).join("");
  // A message opens in place, so its state stays out of the signature: the turn is kept, with its focus and selection.
  const sigHtml = html.replace(/(class="msg-more"[^>]*aria-expanded=)"true"/g, '$1"false"');
  return `<section class="turn${liveTurn ? " live" : ""}" data-key="${esc(key)}" data-sig="${hash(sigHtml + liveTurn)}">${html}</section>`;
}
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
}
const approvalPattern = /^\[approval ([0-9a-f-]{36})\] The owner (approved|denied) "([^"]*)" \(([\w-]+)\)(, and it failed)?/;
/** An owner bubble whose long text clamps (`measureMessage` marks the overflow) and is revealed for the rest of the chat visit by a click or the hint button. */
function ownerMessageHtml(message, className, who, text) {
  const meta = `<div class="msg-meta"><span class="who">${who}</span>${who === "Earlier input" ? "" : `<time>${esc(clock(message.at))}</time>`}</div>`;
  if (message.entryId == null)
    return `<article class="${className}">${meta}<div class="bubble">${chatMarkdown(text)}${imagesHtml(message.images)}</div></article>`;
  const key = `${renderScope}msg:${message.entryId}`,
    open = revealed.has(key);
  const hint = `<button type="button" class="msg-more" data-reveal="${esc(key)}" aria-expanded="${open}">Show more ▾ · ${text.length.toLocaleString("en-US")} chars</button>`;
  return `<article class="${className}">${meta}<div class="bubble"><div class="msg-body" tabindex="-1">${chatMarkdown(text)}</div>${imagesHtml(message.images)}</div>${hint}</article>`;
}
function inputHtml(message, who = "Coordinator") {
  const text = message.text ?? "";
  const approval = message.origin !== "owner" ? approvalPattern.exec(text) : null;
  if (approval) return approvalRowHtml(approval);
  if (who !== "Coordinator" && message.origin !== "owner") return ownerMessageHtml(message, "msg owner brief", "Brief", text);
  if (message.origin === "owner") return ownerMessageHtml(message, "msg owner", "You", text);
  const report = reportPattern.exec(text);
  if (report) return reportRowHtml(message, report);
  const event = /^\[Owner-local event ([\w.-]+)\]\n/.exec(text);
  if (event) return `<div class="sys-row"><span class="sys-icon" aria-hidden="true">⚑</span>Event <code>${esc(event[1])}</code></div>`;
  if (message.origin === "internal")
    return `<div class="sys-row muted"><span class="sys-icon" aria-hidden="true">↻</span>${esc(clip(oneLine(text), 120))}</div>`;
  return ownerMessageHtml(message, "msg owner earlier-input", "Earlier input", text);
}
/** The outcome the host posts back after an owner decision (`[approval <id>] The owner …`), as one row instead of a bubble. */
function approvalRowHtml([, id, decision, summary, action, failed]) {
  const status = decision === "denied" ? "denied" : failed ? "failed" : "done";
  const label = { denied: "Denied", failed: "Approved · failed", done: "Approved · ran" }[status];
  return `<div class="approval-row" data-approval-outcome="${esc(id)}" data-status="${status}"><span class="report-icon" aria-hidden="true">⚖</span><span class="report-text"><span class="badge ap-${status}">${esc(label)}</span> ${esc(clip(summary, 100))} <span class="muted mono small">${esc(action)}</span></span></div>`;
}
function reportRowHtml(message, match) {
  const [, role, id, status, title, body] = match;
  const label =
    {
      ready: "Ready",
      "ready-with-gaps": "Ready with gaps",
      checkpoint: "Checkpoint",
      completed: "Returned",
      failed: "Failed",
      "failed to start": "Did not start",
      stopped: "Stopped",
    }[status] ?? status;
  const summary = /Summary:\s*(.+)/.exec(body)?.[1] ?? "";
  return `<div class="report-row" data-status="${esc(status)}"><span class="report-icon" aria-hidden="true">↩</span><span class="report-text"><b>${esc(role)}</b> <span class="badge s-${esc(status)}">${esc(label)}</span> ${esc(clip(title, 80))}${summary ? `<span class="muted"> · ${esc(clip(summary, 100))}</span>` : ""}</span><button type="button" class="link-btn" data-open-worker="${esc(id)}">Open ${esc(role)} ↗</button></div>`;
}
function itemHtml(item, who = "Coordinator") {
  if (item.kind === "compaction") return `<div class="divider" role="separator"><span>Context compacted</span></div>`;
  if (item.kind === "tool-call") return toolRowHtml({ call: item });
  if (item.kind === "message" && item.role === "user") return inputHtml(item, who);
  if (item.kind !== "message") return "";
  const text = item.text?.trim() ? `<div class="prose">${chatMarkdown(item.text)}</div>` : "";
  return `${item.thinking && showThinking() ? thinkingHtml(item.thinking, `th${item.entryId}`) : ""}${text || item.images?.length ? `<article class="msg agent"><div class="msg-meta"><span class="who">${esc(who)}</span><time>${esc(clock(item.at))}</time></div>${text}${imagesHtml(item.images)}</article>` : ""}`;
}
/** Thinking is display-only: hiding it changes nothing the model gets. */
export const showThinking = () => state.ui?.showThinking !== false;
export function thinkingHtml(text, key, running = false) {
  const open = expanded.has(key);
  return `<div class="thinking${running ? " running" : ""}"><button type="button" class="thinking-head" data-toggle="${esc(key)}" aria-expanded="${open}"><span class="th-mark" aria-hidden="true">∴</span>Thinking<span class="th-preview">${esc(clip(oneLine(text), 90))}</span></button>${open ? `<div class="thinking-body">${esc(text)}</div>` : ""}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------- tool rows

function parseArgs(preview) {
  try {
    return JSON.parse(preview);
  } catch {
    return null;
  }
}
/** Short argument summary per tool; generic tools show their first string argument. */
function summary(name, args, preview) {
  if (!args) return oneLine(preview).slice(0, 100);
  if (name === "agents") return [args.action, args.role, args.title ? `“${args.title}”` : (args.id ?? "")].filter(Boolean).join(" ");
  if (name === "job") return [args.action, args.steps ? `${args.steps.length} steps` : (args.summary ?? "")].filter(Boolean).join(" · ");
  if (name === "bash") return args.command ?? "";
  if (name === "host_call") return [args.action, args.summary ? `“${args.summary}”` : ""].filter(Boolean).join(" ");
  if (name === "ui_focus") return ["→", args.view, args.section ?? ""].filter(Boolean).join(" ");
  if (name === "owner_approval_request") return [args.action, args.summary ? `“${args.summary}”` : ""].filter(Boolean).join(" ");
  if (/^(read|write|edit)$/.test(name)) return args.path ?? args.file_path ?? "";
  const first = Object.values(args).find((value) => typeof value === "string");
  return first ?? "";
}
const MEMORY = /^projects_knowledge_(read|write|history|list)$/;
export function toolRowHtml({ call: item, result }, liveStatus) {
  const status = liveStatus ?? (result ? (result.isError ? "error" : "ok") : state.live?.running ? "running" : "ok");
  const args = parseArgs(item.argsPreview);
  if (MEMORY.test(item.name)) return memoryRowHtml(item, result, args, status);
  const open = expanded.has(item.callId);
  const took = result && Number.isFinite(item.at) && Number.isFinite(result.at) ? dur(result.at - item.at) : "";
  const worker = item.name === "agents" && result ? UUID.exec(result.preview ?? "")?.[0] : null;
  // A coordinator's approval request links to its card in the Host agent drawer.
  const approval =
    item.name === "owner_approval_request" && result && !result.isError ? /Approval (\S+) is/.exec(result.preview ?? "")?.[1] : null;
  const icon =
    status === "running"
      ? `<span class="spin" aria-label="running"></span>`
      : status === "error"
        ? `<span class="st err" aria-label="failed">✕</span>`
        : `<span class="st ok" aria-label="done">✓</span>`;
  return `<div class="tool-row${open ? " open" : ""}" data-tool="${esc(item.name)}" data-status="${status}"><div class="tool-line"><button type="button" class="tool-head" data-toggle="${esc(item.callId)}" aria-expanded="${open}">${icon}<span class="tool-name">${esc(item.name)}</span><span class="tool-args">${esc(clip(oneLine(summary(item.name, args, item.argsPreview)), 140))}</span><span class="tool-dur">${esc(took)}</span></button>${worker ? `<button type="button" class="link-btn" data-open-worker="${esc(worker)}" aria-label="Open worker">worker ↗</button>` : ""}${approval ? `<button type="button" class="link-btn" data-review-approval="${esc(approval)}">Review approval ↗</button>` : ""}</div>${imagesHtml(result?.images)}${open ? toolDetailHtml(item, result, args) : ""}</div>`;
}
function toolDetailHtml(item, result, args) {
  const params = args ? JSON.stringify(args, null, 2) : item.argsPreview;
  return `<div class="tool-detail"><div class="td-label">Parameters</div><pre>${esc(params)}</pre>${result ? `<div class="td-label">${result.isError ? "Error" : "Result"}${result.truncated ? " · preview" : ""}</div><pre class="${result.isError ? "err" : ""}">${esc(clip(result.preview ?? "", 4000))}</pre>` : `<div class="td-label">Result</div><p class="muted small">Running…</p>`}</div>`;
}
function groupHtml(run) {
  const key = `g${run[0].call.callId}`,
    open = expanded.has(key);
  const counts = new Map();
  for (const { call: item } of run) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const first = run[0].call.at,
    last = run.at(-1).result?.at ?? run.at(-1).call.at;
  const failed = run.filter(({ result }) => result?.isError).length;
  const label = [...counts].map(([name, count]) => `${name} ×${count}`).join(", ");
  return `<div class="tool-group${open ? " open" : ""}"><button type="button" class="group-head" data-toggle="${esc(key)}" aria-expanded="${open}"><span class="st ${failed ? "err" : "ok"}" aria-hidden="true">${failed ? "✕" : "✓"}</span><span class="tool-name">${esc(label)}</span><span class="tool-args">${failed ? `${failed} failed` : ""}</span><span class="tool-dur">${esc(dur(last - first))}</span><span class="chev" aria-hidden="true">›</span></button>${open ? `<div class="group-body">${run.map((entry) => toolRowHtml(entry, entry.result ? undefined : "ok")).join("")}</div>` : imagesHtml(run.flatMap(({ result }) => result?.images ?? []))}</div>`;
}
const seenSummaries = new Map(); // toggle key -> last drawn status, so only a summary that just arrived fades in
/** One tool group as one quiet line that opens to its calls; `view` counts the whole group, also calls on pages not loaded yet. */
function summaryHtml({ id, entries, view }, runHtml) {
  const key = `s${id}`,
    open = expanded.has(key),
    previous = seenSummaries.get(key);
  seenSummaries.set(key, view.status);
  const failed = Math.max(view.failed ?? 0, entries.filter(({ result }) => result?.isError).length),
    first = entries[0].call.at,
    last = Math.max(...entries.map(({ call: item, result }) => result?.at ?? item.at));
  const total = Math.max(view.calls ?? 0, entries.length),
    elsewhere = total - entries.length;
  const count = `${total} ${total === 1 ? "call" : "calls"}${elsewhere ? ` · ${elsewhere} on earlier pages` : ""}`,
    took = Number.isFinite(first) && Number.isFinite(last) && !elsewhere ? ` · ${dur(last - first)}` : "";
  const names = new Map();
  for (const { call: item } of entries) names.set(item.name, (names.get(item.name) ?? 0) + 1);
  const label = [...names].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  const by = view.model ? `<p class="ts-by">Summary by ${esc(view.model)}</p>` : "";
  if (view.status === "failed")
    return `<div class="tool-summary" data-status="failed" data-errors="${failed}"><p class="ts-note" title="${esc(clip(oneLine(view.error), 300))}"><span class="ts-glyph" aria-hidden="true">·</span>No summary for ${esc(label)}; showing the calls</p>${runHtml(entries)}</div>`;
  const glyph =
    view.status === "collecting"
      ? `<span class="spin" aria-label="running"></span>`
      : view.status === "pending"
        ? `<span class="ts-pending" aria-label="summary pending"></span>`
        : failed
          ? `<span class="st err" aria-label="a call failed">✕</span>`
          : `<span class="st ok" aria-label="done">✓</span>`;
  const text =
    view.status === "collecting"
      ? `${esc(label)} · running…`
      : view.status === "pending"
        ? `${esc(label)} · writing summary…`
        : esc(view.text);
  const fresh = view.status === "ready" && previous === "pending" ? " fresh" : "";
  return `<div class="tool-summary${open ? " open" : ""}${fresh}" data-status="${view.status}" data-errors="${failed}"><button type="button" class="ts-line" data-toggle="${esc(key)}" aria-expanded="${open}">${glyph}<span class="ts-text">${text}</span><span class="ts-meta">${failed ? `<span class="ts-err">${failed} failed</span>` : ""}<span>${count}${esc(took)}</span><span class="chev" aria-hidden="true">›</span></span></button>${open ? `<div class="ts-body">${entries.map((entry) => toolRowHtml(entry, entry.result ? undefined : view.status === "collecting" ? "running" : "ok")).join("")}${by}</div>` : imagesHtml(entries.flatMap(({ result }) => result?.images ?? []))}</div>`;
}
function memoryRowHtml(item, result, args, status) {
  const path = args?.path ?? "",
    title = path ? (memoryEntry(path)?.title ?? memoryTitle(path)) : "memory index";
  const revision = /"revision":\s*"([^"]+)"/.exec(result?.preview ?? "")?.[1] ?? "";
  if (item.name === "projects_knowledge_write") {
    const write = revision ? memoryWrite(path, revision) : undefined;
    if (status === "ok" && revision && !write) wantMemoryWrite(path, revision);
    // Undo is offered only for a write the host proved current and not undone; an unproven one shows nothing.
    const action = write?.undone
      ? `<span class="muted small">Undone</span>`
      : write && !write.current
        ? `<span class="muted small">Changed since</span>`
        : write
          ? `<button type="button" class="link-btn" data-memory-undo="${esc(path)}" data-revision="${esc(revision)}">Undo</button>`
          : "";
    return `<div class="memory-row" data-tool="${esc(item.name)}" data-status="${status}"><span class="mem-icon" aria-hidden="true">◆</span><span class="mem-text">${status === "error" ? "Could not remember" : "Remembered"}: <button type="button" class="link-btn" data-memory="${esc(path)}">${esc(title)}</button></span>${status === "ok" && revision && memoryReady() ? action : ""}<button type="button" class="link-btn" data-memory="${esc(path)}" data-edit="1">Edit</button></div>`;
  }
  const kind = path ? memoryKindLabel(path) : "";
  return `<div class="memory-row used" data-tool="${esc(item.name)}" data-status="${status}"><span class="mem-icon" aria-hidden="true">◇</span><span class="mem-text">Used memory: ${kind ? `${esc(kind)} · ` : ""}${path ? `<button type="button" class="link-btn" data-memory="${esc(path)}">${esc(title)}</button>` : esc(item.name === "projects_knowledge_list" ? "index" : title)}</span></div>`;
}
function memoryKindLabel(path) {
  const kind = memoryEntry(path)?.kind ?? memoryKind(path);
  return { preference: "Preference", decision: "Decision", procedure: "Procedure", archive: "Archive" }[kind] ?? "";
}

// ---------------------------------------------------------------------------------------------------------------- live

function nestedStatus(nested) {
  if (!nested) return "";
  const parts = [];
  if (nested.running?.length) parts.push(`now ${nested.running.join(", ")}`);
  if (nested.done)
    parts.push(`${nested.done} ${nested.done === 1 ? "call" : "calls"} done${nested.failed ? `, ${nested.failed} failed` : ""}`);
  return parts.join(" · ");
}

function renderLive() {
  const node = document.querySelector("#live-turn");
  if (!node) return;
  const frame = state.live;
  emit("busy", !!frame?.running);
  const retryAt = currentChat()?.networkRetryAt;
  document.querySelector("#stop-btn").hidden = !frame?.running && !retryAt;
  document.querySelector("#send-mode").hidden = !frame?.running;
  document.querySelector("#send-mode").textContent = state.steer ? "steer" : "queue";
  const kept = held
    ? `${held.thinkingText && showThinking() ? thinkingHtml(held.thinkingText, "held-thinking") : ""}${held.text ? `<article class="msg agent"><div class="msg-meta"><span class="who">Coordinator</span></div><div class="prose">${markdown(held.text)}</div></article>` : ""}`
    : "";
  if (!frame?.running) {
    node.innerHTML =
      kept +
      (retryAt
        ? `<div class="live-status">Provider connection failed. Retrying at ${esc(new Date(retryAt).toLocaleTimeString())}.</div>`
        : "");
    hydrateMedia(feed, mediaSource());
    return;
  }
  const nested = nestedStatus(frame.nested);
  const tools = frame.tools
    .filter((tool) => tool.status !== "done")
    .map(
      (tool) =>
        `<div class="tool-row live" data-tool="${esc(tool.name)}" data-status="running"><div class="tool-line"><span class="tool-head static"><span class="spin" aria-label="running"></span><span class="tool-name">${esc(tool.name)}</span><span class="tool-args">${esc(tool.status)}${tool.name === "codemode" && nested ? ` <span data-nested>${esc(nested)}</span>` : ""}</span><span class="tool-dur"></span></span></div></div>`,
    )
    .join("");
  const status = frame.compacting
    ? "Compacting context"
    : frame.retry
      ? `Retrying · ${clip(frame.retry.error, 80)}`
      : frame.text
        ? "Writing"
        : frame.thinking
          ? "Thinking"
          : tools
            ? "Using tools"
            : "Working";
  node.innerHTML = `${kept}${frame.thinking && frame.thinkingText && showThinking() ? thinkingHtml(frame.thinkingText, "live-thinking", true) : ""}${tools}${frame.text ? `<article class="msg agent streaming"><div class="msg-meta"><span class="who">Coordinator</span></div><div class="prose">${markdown(frame.text)}</div></article>` : ""}<div class="live-status"><span class="pulse" aria-hidden="true"></span>${esc(status)}…</div>`;
  hydrateMedia(feed, mediaSource());
  follow.settle();
}

// ---------------------------------------------------------------------------------------------------------------- questions

export function currentChat() {
  return (state.view?.chats ?? []).find((chat) => chat.id === state.chatId) ?? null;
}
function questionChat(item) {
  const chats = state.view?.chats ?? [];
  return (
    chats.find((chat) => item.native && chat.conversationId === item.native.conversationId) ?? chats.find((chat) => chat.id === "main")
  );
}
function renderQuestions() {
  const box = document.querySelector("#questions");
  const waiting = (state.view?.inbox ?? []).filter(
    (item) => item.kind === "question" && !item.result && (questionChat(item)?.id ?? "main") === state.chatId,
  );
  // Keep a half-written answer when the list re-renders.
  const drafts = new Map(
    [...box.querySelectorAll("form[data-entry]")].map((node) => [node.dataset.entry, node.querySelector("textarea").value]),
  );
  box.innerHTML = waiting
    .map(
      (item) =>
        `<form class="question" data-entry="${esc(item.id)}"><div class="q-head"><span class="badge s-needs">Needs you</span><b>${esc(item.title)}</b></div>${item.question && item.question.trim() !== item.title ? `<div class="q-body prose">${markdown(item.question)}</div>` : ""}${item.choices?.length ? `<div class="choices">${item.choices.map((choice, index) => `<button type="button" class="choice" data-choice="${esc(choice)}"><kbd>${index + 1}</kbd>${esc(choice)}</button>`).join("")}</div>` : ""}<div class="q-answer"><textarea rows="1" aria-label="Answer: ${esc(item.title)}" placeholder="Your answer…" maxlength="24000" required>${esc(drafts.get(item.id) ?? "")}</textarea><button type="submit" class="primary small">Answer</button></div></form>`,
    )
    .join("");
}
async function answer(entry, text) {
  const gen = state.generation;
  try {
    await call("answer", { id: state.projectId, entry, text });
    if (stale(gen)) return;
    toast("Answer sent.");
    void loadChat();
  } catch (error) {
    fail(error);
  }
}
document.querySelector("#questions").addEventListener("click", (event) => {
  const choice = event.target.closest("[data-choice]");
  if (choice) void answer(choice.closest("form").dataset.entry, choice.dataset.choice);
});
document.querySelector("#questions").addEventListener("submit", (event) => {
  event.preventDefault();
  const node = event.target.closest("form");
  void answer(node.dataset.entry, node.querySelector("textarea").value.trim());
});

// ---------------------------------------------------------------------------------------------------------------- composer

function grow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}
input.addEventListener("input", grow);
form.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.some((type) => type === "Files" || type === "text/uri-list")) event.preventDefault();
});
form.addEventListener("drop", (event) => takePaths(event, event.dataTransfer, false));
input.addEventListener("paste", (event) => takePaths(event, event.clipboardData, true));
/** A dropped or pasted file URL becomes its plain path in the draft; a bare File gets the Copy as Pathname hint; other content takes the browser's way. */
function takePaths(event, transfer, replaceSelection) {
  const { source, paths } = pathsFromTransfer(transfer);
  if (source === PathSource.None) return;
  event.preventDefault();
  if (source === PathSource.FileOnly) return toast(FILE_ONLY_NOTE, { error: true, ms: 12000 });
  if (!insertText(input, paths.join("\n"), { replaceSelection })) toast("That path would make the message too long.", { error: true });
}
input.addEventListener("keydown", (event) => {
  if (slashKey(event)) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !state.projectId) return;
  const gen = state.generation,
    ownedDraft = drafts.get(draftKey());
  drafts.delete(draftKey());
  input.value = "";
  grow();
  follow.follow();
  const slash = slashCommand(text);
  if (slash) {
    try {
      await slash.command.run(slash.argument);
      if (!stale(gen)) void loadChat();
    } catch (error) {
      if (!stale(gen) && !input.value) input.value = text;
      fail(error);
    }
    return;
  }
  const send = {
    id: uuid(),
    projectId: state.projectId,
    chatId: state.chatId,
    text,
    state: "sending",
    error: "",
    restored: false,
    refused: false,
    failedRead: 0,
  };
  if (!rememberSend(send)) {
    // Nothing is sent without a handle that survives a reload: the text stays where the owner typed it.
    if (!input.value) input.value = text;
    if (ownedDraft) drafts.set(draftKey(), ownedDraft);
    grow();
    toast(NO_HANDLE, { error: true, ms: 8000 });
    return;
  }
  // Sending the restored text again supersedes the bubble it came from.
  for (const old of pendingSends.filter((item) => item.restored && item.state === "failed" && item.text === text && inCurrentChat(item)))
    pendingSends.splice(pendingSends.indexOf(old), 1);
  pendingSends.push(send);
  renderFeed();
  await deliver(send);
});
export async function stopTurn() {
  if (!state.live?.running && !currentChat()?.networkRetryAt) return;
  const gen = state.generation;
  try {
    const result = await call("chat-stop", { projectId: state.projectId, reason: "owner pressed Stop", ...chatArgs() });
    if (stale(gen)) return;
    toast(result.stopped ? "Stopped. History kept." : "Nothing was running.");
    await loadChat();
  } catch (error) {
    fail(error);
  }
}
export function toggleSteer() {
  if (!state.live?.running) return false;
  toast("Steering a running coordinator turn needs a backend request; messages queue for now.");
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- clicks

/** The hint of the collapsed owner message a plain click landed on; null for links, buttons, images, a selection, revealed and unclamped messages. */
function collapsedMessageHint(event) {
  const article = event.target.closest(".msg[data-overflow]");
  if (!article || event.target.closest("a, button, summary, input, textarea, select, img, [data-media]")) return null;
  const selection = getSelection();
  if (selection && !selection.isCollapsed && selection.containsNode(article, true)) return null;
  const hint = article.querySelector(".msg-more");
  return hint?.getAttribute("aria-expanded") === "false" ? hint : null;
}

/** Reveals an owner message in place (`aria-expanded` drives the CSS), so selection and scroll stay where they are. There is no way back until the next chat visit. */
function revealMessage(hint, follow) {
  revealed.add(hint.dataset.reveal);
  follow?.stop();
  hint.setAttribute("aria-expanded", "true");
  // The hint disappears with the reveal, so a keyboard user's focus moves into the text.
  if (hint === document.activeElement) hint.closest(".msg").querySelector(".msg-body").focus({ preventScroll: true });
}
/** Whether a point is on text the clamp shows; a link below it is hidden. */
function insideClamp(article, y) {
  const body = article.querySelector(".msg-body");
  return y < body.getBoundingClientRect().top + parseFloat(getComputedStyle(body).lineHeight) * CLAMP_LINES;
}
/** Keyboard focus reaching a link the clamp hides reveals the message instead of leaving focus on invisible text; `follow` is the transcript's follower. */
export function transcriptFocus({ target }, follow) {
  const body = target.closest?.(".msg[data-overflow] .msg-body"),
    hint = body?.closest(".msg").querySelector(".msg-more");
  if (!hint || hint.getAttribute("aria-expanded") !== "false") return;
  // Focusing scrolls the clipped body to the link, so its position is taken from the unscrolled top.
  if (insideClamp(body.closest(".msg"), target.getBoundingClientRect().top + body.scrollTop)) return;
  revealMessage(hint, follow);
  target.scrollIntoView({ block: "nearest" });
}

/** Clicks inside any transcript (chat feed, a worker in the center, the Host agent); `rerender` repaints that transcript, `follow` is its follower. */
export async function transcriptClick(event, root, rerender, follow) {
  const hint = event.target.closest(".msg-more") ?? collapsedMessageHint(event);
  if (hint) {
    revealMessage(hint, follow);
    return true;
  }
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const key = toggle.dataset.toggle,
      top = toggle.getBoundingClientRect().top;
    expanded.has(key) ? expanded.delete(key) : expanded.add(key);
    // Opening a detail is reading: following stops, and the line stays under the pointer (streaming-follow-intent-failures.md F8).
    follow?.stop();
    rerender();
    const line = root.querySelector(`[data-toggle="${CSS.escape(key)}"]`);
    if (line) follow?.keepAt(line, top);
    line?.focus({ preventScroll: true });
    return true;
  }
  const worker = event.target.closest("[data-open-worker]");
  if (worker) {
    // The id may come from message text, which anyone can write: only this project's own jobs and agents open.
    if (await knownWorker(worker.dataset.openWorker)) emit("open", { kind: "worker", id: worker.dataset.openWorker });
    else toast("That worker is not one of this project's jobs.", { error: true });
    return true;
  }
  const review = event.target.closest("[data-review-approval]");
  if (review) {
    emit("review-approval", review.dataset.reviewApproval);
    return true;
  }
  const reference = event.target.closest("[data-review-ref]");
  if (reference) return emit("review-reference", reference.dataset.reviewRef);
  const undo = event.target.closest("[data-memory-undo]");
  if (undo) {
    const gen = state.generation;
    undo.disabled = true;
    const result = await call("memory-undo", {
      projectId: state.projectId,
      path: undo.dataset.memoryUndo,
      revision: undo.dataset.revision,
    }).catch((error) => {
      undo.disabled = false;
      // A later write makes this revision stale; say so instead of the raw refusal.
      fail(/revision/i.test(error.message) ? new Error("This memory changed after that write; open it to edit instead.") : error);
      return null;
    });
    if (stale(gen) || !result) return true;
    markMemoryUndone(undo.dataset.memoryUndo, undo.dataset.revision);
    toast(result.entry ? "Memory restored to the previous revision." : "Memory entry removed.");
    rerender();
    return true;
  }
  const memory = event.target.closest("[data-memory]");
  if (memory) {
    emit("open", { kind: "memory", path: memory.dataset.memory, edit: !!memory.dataset.edit });
    return true;
  }
  return false;
}
feed.addEventListener("focusin", (event) => transcriptFocus(event, follow));
feed.addEventListener("click", async (event) => {
  const starter = event.target.closest("[data-starter]");
  if (starter) {
    const box = document.querySelector("#composer textarea");
    box.value = STARTERS[Number(starter.dataset.starter)];
    box.dispatchEvent(new Event("input"));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    return;
  }
  if (await transcriptClick(event, feed, renderFeed, follow)) return;
  const pendingRetry = event.target.closest("[data-pending-retry]"),
    pendingDismiss = event.target.closest("[data-pending-dismiss]");
  if (pendingRetry || pendingDismiss) {
    const send = pendingSends.find(
      (item) => item.id === (pendingRetry ?? pendingDismiss).dataset[pendingRetry ? "pendingRetry" : "pendingDismiss"],
    );
    if (!send) return;
    if (pendingDismiss) {
      pendingSends.splice(pendingSends.indexOf(send), 1);
      const held = drafts.get(draftKey(send.projectId, send.chatId));
      // Only a draft the owner has not touched goes with its bubble; an edited one is a new, unsent message.
      if (held?.sendId === send.id && held.text === held.original) {
        if (input.value === held.text) {
          input.value = "";
          grow();
        }
        drafts.delete(draftKey(send.projectId, send.chatId));
      }
    }
    follow.follow();
    if (pendingRetry) send.restored = false;
    renderFeed();
    if (pendingRetry) await deliver(send);
    return;
  }
  const retry = event.target.closest("[data-retry-job]");
  if (retry) {
    const failed = (state.view?.jobs ?? []).find((item) => item.id === retry.dataset.retryJob);
    if (!failed || retry.disabled) return;
    retry.disabled = true; // a second click must not resend
    const { projectId, chatId } = state; // the recipient is the chat the failed turn is in, whatever the owner opens meanwhile
    // One failed turn is one delivery: a click after a lost ack reuses the pending send, and its request id, instead of starting another.
    let send = pendingSends.find((item) => item.retryOf === failed.id && item.projectId === projectId && item.chatId === chatId);
    if (!send) {
      send = {
        id: await retryId(projectId, chatId, failed.id),
        retryOf: failed.id,
        projectId,
        chatId,
        text: failed.text,
        ...(failed.attachments ? { attachments: failed.attachments } : {}),
        state: "sending",
        error: "",
        restored: false,
        refused: false,
        failedRead: 0,
      };
      pendingSends.push(send);
    }
    follow.follow();
    renderFeed();
    try {
      await deliver(send);
    } finally {
      retry.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-earlier]")) {
    const gen = state.generation,
      before = older.length ? olderBefore : state.view.before;
    if (!before) return;
    const page = await call("chat-history", { id: state.projectId, ...chatArgs(), before, limit: 100, messageText: "full" }).catch(fail);
    if (stale(gen) || !page) return;
    older = [...page.items, ...older];
    olderGroups = mergeGroups(page.toolGroups, olderGroups);
    olderBefore = page.before;
    follow.stop();
    renderFeed();
    feed.scrollTop = 0;
  }
});

function chatMarkdown(text) {
  const html = markdown(text);
  if (!/#\d/.test(text)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest("a,code,pre,button")) continue;
    const parts = node.data.split(/(?<![\w/&])(#(?:[1-9]\d{0,8}))(?!\w)/);
    if (parts.length > 1)
      node.replaceWith(
        ...parts.map((part, i) => {
          if (i % 2 === 0) return part;
          const b = document.createElement("button");
          b.className = "link-btn";
          b.dataset.reviewRef = part.slice(1);
          b.textContent = part;
          return b;
        }),
      );
  }
  return template.innerHTML;
}
