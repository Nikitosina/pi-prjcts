// Center: the Coordinator chat. Transcript from `show`, older pages from `chat-history`, live frames from `/live`.
// Tool calls are compact rows; a finished turn folds runs of two or more rows into one group; reports link to the worker.
import { call, stream, uuid } from "./api.js";
import { clip, clock, dur, esc, imagesHtml, markdown, oneLine } from "./format.js";
import { hydrateMedia } from "./media.js";
import { slashCommand, slashKey } from "./slash.js";
import { chatArgs, emit, fail, on, stale, state, toast } from "./state.js";
import { loadRecentMemory, markMemoryUndone, memoryEntry, memoryKind, memoryTitle, memoryWrite } from "./memory.js";

const feed = document.querySelector("#feed"),
  input = document.querySelector("#composer-input"),
  form = document.querySelector("#composer");
let live = null,
  liveKey = "",
  older = [],
  olderBefore = null,
  loading = null,
  held = null, // live text and thinking of a step the host just committed, shown until a transcript read that includes it renders
  stick = true;
const expanded = new Set(); // tool callIds and group keys the owner opened
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
          id = state.projectId,
          entries = state.live?.entries ?? 0;
        if (!id) return;
        const [view] = await Promise.all([call("show", { id, ...chatArgs() }), loadRecentMemory().catch(fail)]);
        // Another chat or project was selected meanwhile: drop this read, but still run the one that selection queued.
        if (stale(gen)) continue;
        state.view = view;
        if (held && (entries >= held.entries || committed(view, held))) held = state.liveHeld = null;
        emit("view", view);
        renderFeed();
        renderQuestions();
        ensureLive();
      } while (run.again);
    } catch (error) {
      fail(error);
    } finally {
      loading = null;
    }
  })();
  return run.promise;
}
on("select", () => {
  older = [];
  stick = true;
  expanded.clear();
  feed.replaceChildren();
  document.querySelector("#questions").replaceChildren();
  state.live = null;
  held = state.liveHeld = null;
  live?.stop();
  live = null;
  liveKey = "";
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
  if (!state.view) return;
  const all = turns(messages()),
    busy = !!state.live?.running || !!currentChat()?.busy;
  const html = [];
  if (older.length ? olderBefore : state.view.before) html.push(`<button type="button" class="earlier" data-earlier>Show earlier</button>`);
  if (!all.length)
    html.push(
      `<div class="empty-chat" data-key="empty"><p class="empty-title">${esc(state.view.project?.name ?? "")}</p><p class="muted">Ask the coordinator for something. It plans, delegates to workers and reports back here.</p><div class="starters" role="list" aria-label="Starter prompts">${STARTERS.map((text, index) => `<button type="button" role="listitem" class="starter" data-starter="${index}"><span class="starter-glyph" aria-hidden="true">❯</span>${esc(text)}</button>`).join("")}</div><p class="muted small">A starter fills the composer; <kbd>Enter</kbd> sends it.</p></div>`,
    );
  html.push(transcriptHtml(all, busy));
  html.push(failureHtml());
  html.push(`<div id="live-turn"></div>`);
  const anchor = stick ? null : readingAnchor();
  morph(feed, html.join(""));
  renderLive();
  if (stick) feed.scrollTop = feed.scrollHeight;
  else if (anchor) keepAnchor(anchor);
}
/** The chat's newest turn when it failed or was interrupted: the provider error and Retry (coordinator-stability-failures.md S4-S6). */
function failureHtml() {
  const job = (state.view.jobs ?? []).at(-1);
  if (!job || (job.state !== "failed" && job.state !== "interrupted")) return "";
  return `<div class="turn-failure" data-key="f${esc(job.id)}" role="status"><span class="st err" aria-hidden="true">✕</span><span class="tf-text">Turn ${esc(job.state)}: ${esc(clip(oneLine(job.error ?? "no reason recorded"), 300))}</span><button type="button" class="link-btn" data-retry-job="${esc(job.id)}">Retry</button></div>`;
}
// A reader who scrolled up keeps the turn they are reading in place, even when new messages push older ones out of the window
// `show` returns (streaming-scroll-viewport-failures.md R1).
function readingAnchor() {
  const top = feed.getBoundingClientRect().top;
  return [...feed.querySelectorAll(":scope > .turn[data-key]")]
    .filter((node) => node.getBoundingClientRect().bottom > top)
    .slice(0, 8)
    .map((node) => ({ key: node.dataset.key, offset: node.getBoundingClientRect().top - top }));
}
function keepAnchor(anchor) {
  const top = feed.getBoundingClientRect().top;
  for (const { key, offset } of anchor) {
    const node = feed.querySelector(`:scope > .turn[data-key="${CSS.escape(key)}"]`);
    if (!node) continue;
    feed.scrollTop += node.getBoundingClientRect().top - top - offset;
    return;
  }
}
/** Where this chat's images come from (see media.js). */
const mediaSource = () => (state.projectId ? { project: state.projectId, chatId: state.chatId } : null);
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
}

/** Turn sections for a list of transcript items (also used for worker transcripts in the center). */
export function transcriptHtml(items, busy, who = "Coordinator", { fold = true } = {}) {
  const all = Array.isArray(items[0]?.items) ? items : turns(items);
  return all.map((turn, index) => turnHtml(turn, busy && index === all.length - 1, who, fold)).join("");
}
function turnHtml(turn, liveTurn, who, fold = true) {
  const { start } = turn,
    key = `t${start.entryId ?? start.at}`;
  // A turn that does not open with an input (a page starting mid-turn) has its first item in `items` too.
  const head = start.kind === "message" && start.role === "user" ? inputHtml(start, who) : "";
  const body = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    body.push(run.length >= 2 && !liveTurn && fold ? groupHtml(run) : run.map((entry) => toolRowHtml(entry, callStatus(entry))).join(""));
    run = [];
  };
  const results = new Map(turn.items.filter((item) => item.kind === "tool-result").map((item) => [item.callId, item]));
  // A call without a result runs only in this transcript's own live turn (a worker's, not the coordinator's).
  const callStatus = (entry) => (entry.result ? undefined : liveTurn ? "running" : "ok");
  for (const item of turn.items) {
    // Memory rows never fold: what the agent remembered or relied on stays visible.
    if (item.kind === "tool-call" && MEMORY.test(item.name)) {
      flush();
      const entry = { call: item, result: results.get(item.callId) };
      body.push(toolRowHtml(entry, callStatus(entry)));
    } else if (item.kind === "tool-call") run.push({ call: item, result: results.get(item.callId) });
    else if (item.kind === "tool-result") continue;
    else if (item.kind === "message" && item.role === "assistant" && !item.text?.trim() && !item.thinking && !item.images?.length) continue;
    else {
      flush();
      body.push(itemHtml(item, who));
    }
  }
  flush();
  const html = head + body.join("");
  return `<section class="turn${liveTurn ? " live" : ""}" data-key="${esc(key)}" data-sig="${hash(html + liveTurn)}">${html}</section>`;
}
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
}
const approvalPattern = /^\[approval ([0-9a-f-]{36})\] The owner (approved|denied) "([^"]*)" \(([\w-]+)\)(, and it failed)?/;
function inputHtml(message, who = "Coordinator") {
  const text = message.text ?? "";
  const approval = message.origin !== "owner" ? approvalPattern.exec(text) : null;
  if (approval) return approvalRowHtml(approval);
  if (who !== "Coordinator" && message.origin !== "owner")
    return `<article class="msg owner brief"><div class="msg-meta"><span class="who">Brief</span><time>${esc(clock(message.at))}</time></div><div class="bubble">${markdown(text)}${imagesHtml(message.images)}</div></article>`;
  if (message.origin === "owner")
    return `<article class="msg owner"><div class="msg-meta"><span class="who">You</span><time>${esc(clock(message.at))}</time></div><div class="bubble">${markdown(text)}${imagesHtml(message.images)}</div></article>`;
  const report = reportPattern.exec(text);
  if (report) return reportRowHtml(message, report);
  const event = /^\[Owner-local event ([\w.-]+)\]\n/.exec(text);
  if (event) return `<div class="sys-row"><span class="sys-icon" aria-hidden="true">⚑</span>Event <code>${esc(event[1])}</code></div>`;
  if (message.origin === "internal")
    return `<div class="sys-row muted"><span class="sys-icon" aria-hidden="true">↻</span>${esc(clip(oneLine(text), 120))}</div>`;
  return `<article class="msg owner earlier-input"><div class="msg-meta"><span class="who">Earlier input</span></div><div class="bubble">${markdown(text)}${imagesHtml(message.images)}</div></article>`;
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
  const text = item.text?.trim() ? `<div class="prose">${markdown(item.text)}</div>` : "";
  return `${item.thinking ? thinkingHtml(item.thinking, `th${item.entryId}`) : ""}${text || item.images?.length ? `<article class="msg agent"><div class="msg-meta"><span class="who">${esc(who)}</span><time>${esc(clock(item.at))}</time></div>${text}${imagesHtml(item.images)}${item.truncated ? `<p class="muted small">Message shortened in this view.</p>` : ""}</article>` : ""}`;
}
function thinkingHtml(text, key, running = false) {
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
function memoryRowHtml(item, result, args, status) {
  const path = args?.path ?? "",
    title = path ? (memoryEntry(path)?.title ?? memoryTitle(path)) : "memory index";
  const revision = /"revision":\s*"([^"]+)"/.exec(result?.preview ?? "")?.[1] ?? "";
  if (item.name === "projects_knowledge_write") {
    const write = revision ? memoryWrite(path, revision) : null;
    const action = write?.undone
      ? `<span class="muted small">Undone</span>`
      : write && !write.current
        ? `<span class="muted small">Changed since</span>`
        : `<button type="button" class="link-btn" data-memory-undo="${esc(path)}" data-revision="${esc(revision)}">Undo</button>`;
    return `<div class="memory-row" data-tool="${esc(item.name)}" data-status="${status}"><span class="mem-icon" aria-hidden="true">◆</span><span class="mem-text">${status === "error" ? "Could not remember" : "Remembered"}: <button type="button" class="link-btn" data-memory="${esc(path)}">${esc(title)}</button></span>${status === "ok" && revision ? action : ""}<button type="button" class="link-btn" data-memory="${esc(path)}" data-edit="1">Edit</button></div>`;
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
  document.querySelector("#stop-btn").hidden = !frame?.running;
  document.querySelector("#send-mode").hidden = !frame?.running;
  document.querySelector("#send-mode").textContent = state.steer ? "steer" : "queue";
  const kept = held
    ? `${held.thinkingText ? thinkingHtml(held.thinkingText, "held-thinking") : ""}${held.text ? `<article class="msg agent"><div class="msg-meta"><span class="who">Coordinator</span></div><div class="prose">${markdown(held.text)}</div></article>` : ""}`
    : "";
  if (!frame?.running) {
    node.innerHTML = kept;
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
  node.innerHTML = `${kept}${frame.thinking && frame.thinkingText ? thinkingHtml(frame.thinkingText, "live-thinking", true) : ""}${tools}${frame.text ? `<article class="msg agent streaming"><div class="msg-meta"><span class="who">Coordinator</span></div><div class="prose">${markdown(frame.text)}</div></article>` : ""}<div class="live-status"><span class="pulse" aria-hidden="true"></span>${esc(status)}…</div>`;
  hydrateMedia(feed, mediaSource());
  if (stick) feed.scrollTop = feed.scrollHeight;
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
  const gen = state.generation;
  input.value = "";
  grow();
  stick = true;
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
  try {
    await call("message", { id: state.projectId, text, requestId: uuid(), ...chatArgs() });
    if (stale(gen)) return;
    await loadChat();
  } catch (error) {
    if (!stale(gen) && !input.value) input.value = text;
    fail(error);
  }
});
export async function stopTurn() {
  if (!state.live?.running) return;
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

// Following stops on the owner's own upward scroll (wheel, keys, touch), however small, and resumes once they are back at the
// bottom. A scroll the page makes itself only stops it when it leaves the bottom band (streaming-follow-intent-failures.md).
let touchY = null;
feed.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY < 0) stick = false;
  },
  { passive: true },
);
feed.addEventListener("touchstart", (event) => void (touchY = event.touches[0]?.clientY ?? null), { passive: true });
feed.addEventListener(
  "touchmove",
  (event) => {
    const y = event.touches[0]?.clientY ?? null;
    if (touchY !== null && y !== null && y > touchY) stick = false;
    touchY = y;
  },
  { passive: true },
);
feed.addEventListener("keydown", (event) => {
  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stick = false;
});
feed.addEventListener("scroll", () => {
  const gap = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
  if (gap < 2) stick = true;
  else if (gap >= 40) stick = false;
});
/** Clicks inside any transcript (chat feed or a worker in the center); `rerender` repaints that transcript. */
export async function transcriptClick(event, root, rerender) {
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const key = toggle.dataset.toggle;
    expanded.has(key) ? expanded.delete(key) : expanded.add(key);
    stick = false;
    rerender();
    root.querySelector(`[data-toggle="${CSS.escape(key)}"]`)?.focus();
    return true;
  }
  const worker = event.target.closest("[data-open-worker]");
  if (worker) {
    emit("open", { kind: "worker", id: worker.dataset.openWorker });
    return true;
  }
  const review = event.target.closest("[data-review-approval]");
  if (review) {
    emit("review-approval", review.dataset.reviewApproval);
    return true;
  }
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
  if (await transcriptClick(event, feed, renderFeed)) return;
  const retry = event.target.closest("[data-retry-job]");
  if (retry) {
    const job = (state.view?.jobs ?? []).find((item) => item.id === retry.dataset.retryJob);
    if (!job || retry.disabled) return;
    retry.disabled = true; // a second click must not resend
    try {
      await call("message", { id: state.projectId, text: job.text, requestId: uuid(), ...chatArgs() });
      stick = true;
    } catch (error) {
      retry.disabled = false;
      fail(error);
    }
    return;
  }
  if (event.target.closest("[data-earlier]")) {
    const gen = state.generation,
      before = older.length ? olderBefore : state.view.before;
    if (!before) return;
    const page = await call("chat-history", { id: state.projectId, ...chatArgs(), before, limit: 100 }).catch(fail);
    if (stale(gen) || !page) return;
    older = [...page.items, ...older];
    olderBefore = page.before;
    stick = false;
    renderFeed();
    feed.scrollTop = 0;
  }
});
