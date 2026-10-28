const initial = new URL(location.href);
const key = `pi-projects-token:${location.origin}`;
const supplied = new URLSearchParams(initial.hash.slice(1)).get("token");
// localStorage, not sessionStorage: some browsers re-create tabs without the stripped #token fragment.
// Each host start uses a new port, so tokens stored for other origins are dead; drop them.
if (supplied) {
  for (const stored of Object.keys(localStorage)) if (stored.startsWith("pi-projects-token:") && stored !== key) localStorage.removeItem(stored);
  localStorage.setItem(key, supplied);
}
initial.hash = "";
history.replaceState(null, "", initial);
const token = localStorage.getItem(key) || "";
// iOS Safari's layout viewport does not always follow its visible viewport when the toolbar or keyboard moves.
// Size the whole shell from VisualViewport so neither the composer nor the separate limits bar is stranded mid-screen.
function syncVisualViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty("--visual-viewport-height", `${viewport?.height ?? innerHeight}px`);
  document.documentElement.style.setProperty("--visual-viewport-top", `${viewport?.offsetTop ?? 0}px`);
}
window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
addEventListener("resize", syncVisualViewport);
syncVisualViewport();
const scrollBehavior = () => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
const signIn = document.querySelector("#sign-in");
signIn.addEventListener("cancel", event => event.preventDefault());
signIn.querySelector("form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.querySelector("#sign-in-link"), error = document.querySelector("#sign-in-error");
  const button = signIn.querySelector("button");
  error.textContent = "";
  let link;
  try { link = new URL(input.value.trim()); } catch {
    error.textContent = "Paste the full inbox link, including #token=."; return;
  }
  if (link.origin !== location.origin) {
    error.textContent = "This link belongs to another host address. Use the link for this app's address."; return;
  }
  const next = new URLSearchParams(link.hash.slice(1)).get("token");
  if (!/^[a-f0-9]{64}$/.test(next ?? "")) {
    error.textContent = "This link is missing a valid #token=. Copy the original inbox link."; return;
  }
  button.disabled = true;
  try {
    const response = await fetch("/api", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${next}` }, body: JSON.stringify({ action: "list" }), signal: AbortSignal.timeout(15000) });
    const reply = await response.json();
    if (!response.ok || reply?.ok !== true) {
      error.textContent = "This link was not accepted. Get the current link with npm run projects -- ui-url."; return;
    }
    localStorage.setItem(key, next);
    input.value = "";
    location.reload();
  } catch {
    error.textContent = "Could not sign in. Check that the host is running and browser storage is allowed.";
  } finally { button.disabled = false; }
});
function showSignIn() { if (!signIn.open) signIn.showModal(); }
// The host keeps its port across restarts, so opening its new address in this tab is only a fragment change: take the new token and reload.
addEventListener("hashchange", () => {
  const next = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!next) return;
  localStorage.setItem(key, next);
  const url = new URL(location.href); url.hash = ""; history.replaceState(null, "", url); location.reload();
});
const dialog = document.querySelector("#dialog");
const html = new Map();
const drafts = new Map();
const answers = new Map();
let answerAdoption = null;
let routineCache = null, routineConfirmation = null;
function answerKey(project, entry) { return `${project}:${entry}`; }
const formDrafts = new Map();
const creationDrafts = new Map();
let plan = null;
let workerChat = null;
// Full-text search: the dialog's latest query/results, and the message a jump must render, highlight and scroll to.
let searchState = { seq: 0, project: null, query: "", terms: [], results: [], active: 0 }, searchTimer = null, searchFocus = null, workerFocus = null;
let approvalPage = null;
const operationCache = new Map();
const knowledgeCache = new Map();
const knowledgeDrafts = new Map();
const knowledgePaths = new Map();
const libraryCache = new Map();
let libraryPayload = null;
const uploadDrafts = new Map();
const uploadConfirmations = new Map();
const settingsDrafts = new Map();
const modelCache = new Map();
let settingsCache = null;
let settingsConfirmation = null;
const providerCache = new Map();
let providerInspection = null;
let lastDraftError = null;
let projects = [];
let projectId = initial.searchParams.get("project");
// Selected coordinator chat; "main" is the project's original coordinator. Drafts are kept per chat.
let chatId = /^(main|[a-f0-9-]{36})$/.test(initial.searchParams.get("chat") ?? "") ? initial.searchParams.get("chat") : "main";
function draftKey(id = projectId, chat = chatId) { return chat === "main" ? id : `${id}:${chat}`; }
let view = null;
let knowledgeDocs = [];
// One SSE reader for the selected project; frames from other projects are dropped.
let liveStream = null;
// Explicit chat switches clear the frame; reconnects keep the last received preview readable.
let liveFrame = null;
let liveRetryMs = 1000;
// Follow new chat content only while the reader is at the bottom; scrolling up pauses it until they return.
let stickToBottom = true;
let transcriptAnchor = null;
function captureTranscriptAnchor() {
  const transcript = document.querySelector("#transcript"), box = transcript.getBoundingClientRect();
  const row = [...transcript.querySelectorAll("[data-index]")].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
  return row ? { index: row.dataset.index, offset: row.getBoundingClientRect().top - box.top } : null;
}
function restoreTranscriptAnchor(anchor = transcriptAnchor) {
  if (!anchor || stickToBottom) return;
  const transcript = document.querySelector("#transcript"), row = transcript.querySelector(`[data-index="${anchor.index}"]`);
  if (!row) return;
  const delta = row.getBoundingClientRect().top - transcript.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) > 0.5) transcript.scrollTop += delta;
  transcriptAnchor = captureTranscriptAnchor();
}
let showArchived = false, allWork = false;
// The worker view: a main-area page for one worker (?worker=<threadId>) that replaces the coordinator chat until Back or Escape.
const threadPane = document.querySelector("#inline-thread");
let pendingWorker = /^[a-f0-9-]{36}$/.test(initial.searchParams.get("worker") ?? "") ? initial.searchParams.get("worker") : null;
function setWorkerUrl(threadId) {
  const url = new URL(location.href), had = url.searchParams.has("worker");
  if (threadId) url.searchParams.set("worker", threadId); else url.searchParams.delete("worker");
  if (url.href !== location.href) { if (threadId && !had) history.pushState({ worker: true }, "", url); else history.replaceState(threadId ? history.state : null, "", url); }
}
function closeWorkerDetail() {
  workerChat = null; threadPane.hidden = true; threadPane.replaceChildren(); setWorkerUrl(null);
  document.querySelector('[data-panel="coordinator"]').hidden = tab !== "coordinator";
}
window.addEventListener("popstate", () => {
  const wanted = new URL(location.href).searchParams.get("worker");
  if (!wanted && workerChat) { closeWorkerDetail(); ensureChanges(); dialogVersion++; renderArtifactBrowser(); render(); }
  else if (wanted && workerChat?.threadId !== wanted && plan?.work.some(work => work.threadId === wanted)) void inspectThread(wanted).catch(report);
});
function followTranscript() {
  if (!stickToBottom) return;
  const node = document.querySelector("#transcript"), top = node.scrollHeight - node.clientHeight;
  if (Math.abs(node.scrollTop - top) > 0.5) node.scrollTop = top;
  transcriptAnchor = null;
}
let selected = null;
let generation = 0;
let polling = null;
let busy = false;
let dialogVersion = 0;
let blobUrl = null;
let toastTimer;
// Dismissed notices: an ✕ hides a warning or error until its text changes; remembered for this tab session.
const dismissKey = "pi-projects-dismissed";
const dismissed = new Set((() => { try { return JSON.parse(sessionStorage.getItem(dismissKey) ?? "[]"); } catch { return []; } })());
const tabs = ["coordinator", "knowledge", "observability", "settings"];
let tab = tabs.includes(initial.searchParams.get("tab")) ? initial.searchParams.get("tab") : "coordinator";
// Observability usage is pinned to the project/generation that requested it.
let usageObs = null, usageLoading = false;
let observability = null, observabilityLoading = false, eventOffset = 0;

// Browser plugins: /plugins/<name>/ui.js calls piProjects.register({ name, mount(slot), projectChanged, render, tick, hide, action(name, node) }).
// Their data-action names start with "<name>-". A failing plugin is logged and skipped; the app keeps working.
const uiPlugins = [], uiPluginSources = new Set();
function uiPluginCall(hook) {
  for (const plugin of uiPlugins) { try { plugin[hook]?.(); } catch (error) { console.error(`Plugin ${plugin.name} ${hook} failed`, error); } }
}
function loadUiPlugins(list) {
  for (const item of list) {
    if (item.style && !uiPluginSources.has(item.style)) { uiPluginSources.add(item.style); document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: item.style })); }
    if (item.script && !uiPluginSources.has(item.script)) { uiPluginSources.add(item.script); document.body.append(Object.assign(document.createElement("script"), { src: item.script })); }
  }
}
window.piProjects = Object.freeze({
  register(plugin) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(plugin?.name ?? "") || uiPlugins.some(item => item.name === plugin.name) || typeof plugin.action !== "function") throw new Error("Invalid or duplicate browser plugin");
    const slot = document.createElement("div"); slot.dataset.plugin = plugin.name;
    document.querySelector("#plugin-cards").append(slot);
    plugin.mount?.(slot);
    uiPlugins.push(plugin);
    try { plugin.projectChanged?.(); plugin.render?.(); } catch (error) { console.error(`Plugin ${plugin.name} start failed`, error); }
  },
  state: () => ({ projectId, view, tab, generation, dialogVersion }),
  rpc: (plugin, method, id, params) => api({ action: "plugin", plugin, method, id, params }),
  /** Authenticated GET of a plugin route, /plugins/<name>/<route>?... */
  fetch: (path, init = {}) => fetch(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
  dialog, showDialog, closeDialog, esc, setHtml, ago, toast, requireProject,
  // Defined further down as consts.
  dlgActions: (...parts) => dlgActions(...parts), dlgBtn: (...args) => dlgBtn(...args),
});


let refusal = null;
async function start() {
  document.querySelector("#compose button").disabled = true;
  const current = generation;
  try {
    const loaded = await api({ action: "list" });
    if (current !== generation) return;
    projects = loaded;
    for (const project of loaded) if (seenAt(project.id, PROJECT_SEEN) === null) markSeen(project.id, PROJECT_SEEN);
    renderProjects();
    if (!projects.some(p => p.id === projectId)) {
      // A legacy (pre-Durable) project is not listed; say why instead of silently opening another one.
      const wanted = projectId;
      projectId = projects[0]?.id ?? null;
      if (wanted) await api({ action: "show", id: wanted }).catch(error => { if (current === generation && /removed legacy runtime/.test(error.message)) refusal = error.message; });
      if (current !== generation) return;
    }
    changeProject(projectId, chatId);
    if (refusal) { setError(refusal, "action"); refusal = null; }
    else await loadPluginStatus();
  } catch (error) { if (current === generation) showError(error); }
}

// Show earlier messages: per chat, the transcript index the window reaches back to (the host adds everything from there on, so new messages never push it out).
const historyFrom = new Map();
async function showEarlier() {
  const first = view.messages.reduce((least, message) => Number.isInteger(message.index) ? Math.min(least, message.index) : least, Infinity);
  if (!Number.isFinite(first)) return;
  const key = `${projectId}/${chatId}`, node = document.querySelector("#transcript");
  const before = { height: node.scrollHeight, top: node.scrollTop };
  historyFrom.set(key, Math.max(0, first - 200));
  stickToBottom = false;
  await settledRefresh();
  // The older messages land above the reading position: keep what the owner was looking at where it was.
  if (`${projectId}/${chatId}` === key) node.scrollTop = before.top + node.scrollHeight - before.height;
}
async function refresh() {
  if (!projectId) return;
  if (polling === generation) { refreshQueued = true; return; }
  const current = generation;
  const id = projectId, chat = chatId;
  polling = current;
  try {
    let next;
    const focus = searchFocus?.project === id && searchFocus.chat === chat ? { focus: searchFocus.index } : {};
    const from = historyFrom.get(`${id}/${chat}`);
    try { next = await api({ action: "show", id, ...(chat === "main" ? {} : { chatId: chat }), ...focus, ...(from === undefined ? {} : { from }) }); }
    catch (error) { if (chat !== "main" && /Unknown chat/.test(error.message) && current === generation) { polling = null; changeChat("main"); return; } throw error; }
    if (current !== generation) return;
    const [nextPlan, nextApprovals, nextDocs] = await Promise.all([api({ action: "plan-snapshot", id }), api({ action: "operation-snapshot", id, status: "pending", offset: 0, limit: 100 }), api({ action: "knowledge-list", id })]);
    if (current !== generation) return;
    if (nextPlan && (!Array.isArray(nextPlan.work) || nextPlan.work.some(work => !uuid(work.id) || !uuid(work.threadId)))) throw new Error("Invalid owned Durable work projection");
    if (nextApprovals) {
      validateOperations(nextApprovals, id, 0);
      if (nextApprovals.items.some(record => record.status !== "pending")) throw new Error("Pending approval snapshot includes non-pending history");
    }
    view = next; plan = nextPlan; approvalPage = nextApprovals;
    knowledgeDocs = Array.isArray(nextDocs) ? nextDocs.filter(doc => knowledgePath(doc.path)) : [];
    for (const record of nextApprovals?.items ?? []) operationCache.set(record.id, record);
    if (document.querySelector("#error").dataset.source === "connection") document.querySelector("#error").hidden = true;
    const connection = document.querySelector("#connection"); connection.textContent = next.busy ? "Coordinating" : "Connected"; connection.dataset.state = "up"; connection.title = `Updated ${new Date().toLocaleTimeString()}`;
    render();
    // Leaving a project re-reads the list at once, so the row of the one you left shows its live state, not the list from before.
    if (Date.now() - projectListAt > 10000 || listedFor !== projectId) void reloadProjects();
    ensureLive();
    ensureChanges();
    if (pendingWorker && plan) {
      const wanted = pendingWorker; pendingWorker = null;
      if (plan.work.some(work => work.threadId === wanted)) await inspectThread(wanted);
    }
    if (workerChat && tab === "coordinator") await refreshWorkerChat(workerChat);
    void loadWorkerContexts(current);
  } catch (error) { if (current === generation) showError(error); }
  finally {
    if (polling === current) polling = null;
    if (refreshQueued && current === generation) { refreshQueued = false; void refresh(); }
  }
}

let refreshQueued = false;

function ensureLive() {
  if (liveStream?.id === projectId && liveStream.chat === chatId) return;
  liveStream?.controller.abort();
  const stream = { id: projectId, chat: chatId, controller: new AbortController() };
  liveStream = stream;
  void readLive(stream).finally(() => {
    if (liveStream !== stream) return;
    renderLive(true);
    liveStream = null;
    if (stream.controller.signal.aborted) return;
    // Runtime closed or the network dropped: back off, then reconnect through the next refresh.
    setTimeout(() => { if (projectId === stream.id && chatId === stream.chat && !liveStream) void refresh(); }, liveRetryMs);
    liveRetryMs = Math.min(liveRetryMs * 2, 15000);
  });
}

async function readLive(stream) {
  try {
    const response = await fetch(`/live?project=${encodeURIComponent(stream.id)}&chat=${encodeURIComponent(stream.chat)}`, { headers: { authorization: `Bearer ${token}` }, signal: stream.controller.signal });
    if (!response.ok || !response.body) return;
    liveRetryMs = 1000;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += value;
      let end;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        const data = event.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (data && liveStream === stream && projectId === stream.id) await applyLive(JSON.parse(data));
      }
    }
  } catch (error) { if (error?.name !== "AbortError") console.warn("Live stream ended", error); }
}

async function applyLive(frame) {
  const previous = liveFrame;
  liveFrame = frame;
  if (frame.text !== previous?.text) {
    const now = performance.now();
    liveRevealDeadline = now + 120;
    if (liveRenderedText === previous?.text) liveRevealTime = now;
  }
  // A committed entry or a finished run means the transcript changed: refresh before hiding the bubble so the final text never blinks out.
  const settled = previous && (previous.entries !== frame.entries || previous.running !== frame.running);
  const selection = settled ? captureLiveSelection() : null;
  if (settled) await settledRefresh();
  if (settled) { renderLive(true); restoreLiveSelection(selection); } else if (document.hidden) renderLive(true); else scheduleLiveRender();
}
let liveRenderFrame = null;
function scheduleLiveRender() {
  if (liveRenderFrame !== null) return;
  liveRenderFrame = requestAnimationFrame(() => { liveRenderFrame = null; renderLive(); });
}

// A refresh that starts after this call and finishes. A plain refresh() only queues while a poll is in flight, which used to hide the bubble before the transcript caught up.
async function settledRefresh() {
  while (polling === generation) await new Promise(resolve => setTimeout(resolve, 30));
  await refresh();
}

// Host-pushed changes (/changes): refresh when the open project, chat or worker conversation changes, read the notice feed when it advances.
// A hidden tab closes the stream so the host stops watching for it; showing the tab refreshes and reopens it. While the stream is down, the 30 s poll below keeps the view current.
let changeStream = null, changeRetryMs = 1000;
const POLL_MS = 30000;
const watchedThread = () => tab === "coordinator" && workerChat?.id === projectId ? workerChat.threadId : "";
function ensureChanges() {
  if (changeStream?.id === projectId && changeStream.chat === chatId && changeStream.thread === watchedThread()) return;
  changeStream?.controller.abort();
  changeStream = null;
  if (!projectId || document.hidden) return;
  const stream = { id: projectId, chat: chatId, thread: watchedThread(), controller: new AbortController(), up: false };
  changeStream = stream;
  void readChanges(stream).finally(() => {
    stream.up = false;
    if (changeStream !== stream || stream.controller.signal.aborted) return;
    changeStream = null;
    setTimeout(() => { if (!changeStream) { ensureChanges(); void refresh(); } }, changeRetryMs);
    changeRetryMs = Math.min(changeRetryMs * 2, POLL_MS);
  });
}
async function readChanges(stream) {
  try {
    const response = await fetch(`/changes?project=${encodeURIComponent(stream.id)}&chat=${encodeURIComponent(stream.chat)}${stream.thread ? `&thread=${encodeURIComponent(stream.thread)}` : ""}`, { headers: { authorization: `Bearer ${token}` }, signal: stream.controller.signal });
    if (!response.ok || !response.body) return;
    stream.up = true; changeRetryMs = 1000;
    scheduleNotify();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += value;
      let end;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        const data = event.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (!data || changeStream !== stream) continue;
        const change = JSON.parse(data);
        if (change.t === "project") void refresh();
        else if (change.t === "notices" && notifyEnabled() && change.seq !== notifyCursor) { clearTimeout(notifyTimer); notifyTimer = setTimeout(() => void pollNotify(), 0); }
      }
    }
  } catch (error) { if (error?.name !== "AbortError") console.warn("Change stream ended", error); }
  finally { stream.up = false; }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) { changeStream?.controller.abort(); changeStream = null; scheduleNotify(); } });

function thoughtText(text) { return text.replace(/\*\*/g, "").split(/\n\s*\n/).map(line => line.trim()).filter(Boolean).join(" · "); }
function liveStatus(frame) {
  const tools = frame.tools.filter(tool => tool.status !== "done");
  if (frame.retry) return `Model error: ${frame.retry.error}. Retrying (attempt ${frame.attempt ?? 1}) at ${new Date(frame.retry.at).toLocaleTimeString()}…`;
  if (frame.compacting) return "Compacting context…";
  if (tools.length) return `${tools.map(tool => toolLabel({ name: tool.name })).join(", ")}…`;
  if (frame.text) return "Writing…";
  const thought = frame.thinkingText ? thoughtText(frame.thinkingText) : "";
  return thought ? `Thinking · ${thought}` : "Thinking…";
}
function renderWorkingPill() {
  const pill = document.querySelector("#working-pill"), frame = liveFrame;
  const status = frame?.running ? liveStatus(frame) : "";
  pill.hidden = !status || stickToBottom;
  pill.querySelector(".pill-text").textContent = status;
}

const streamMotion = matchMedia("(prefers-reduced-motion: reduce)");
let liveRenderedText = null, liveRevealDeadline = 0, liveRevealTime = 0;

function newLiveText(value, animate) {
  if (!animate || !value) return document.createTextNode(value);
  const span = document.createElement("span");
  span.className = "stream-fragment"; span.textContent = value;
  return span;
}

function patchLiveText(target, source, animate) {
  let current = target.firstChild;
  for (const next of source.childNodes) {
    if (next.nodeType === Node.TEXT_NODE) {
      const run = [], value = next.data;
      while (current && (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.ELEMENT_NODE && current.matches(".stream-fragment"))) {
        run.push(current); current = current.nextSibling;
      }
      const before = run.map(node => node.textContent).join("");
      let kept = before.length;
      if (!value.startsWith(before)) {
        // Closing inline markdown can shorten a text run. Keep its prefix instead of re-fading the paragraph.
        kept = 0;
        while (kept < before.length && kept < value.length && before[kept] === value[kept]) kept++;
        if (/[\uD800-\uDBFF]/.test(before[kept - 1])) kept--;
        let remaining = kept;
        for (const node of run) {
          const length = node.textContent.length;
          if (!remaining) node.remove();
          else if (remaining < length) {
            const text = node.nodeType === Node.TEXT_NODE ? node : node.firstChild;
            text.deleteData(remaining, text.length - remaining);
          }
          remaining = Math.max(0, remaining - length);
        }
        animate = false;
      }
      const added = value.slice(kept);
      if (added) target.insertBefore(newLiveText(added, animate && !current), current);
    } else if (current?.nodeType === Node.ELEMENT_NODE && current.tagName === next.tagName && current.getAttributeNames().length === next.getAttributeNames().length && next.getAttributeNames().every(name => current.getAttribute(name) === next.getAttribute(name))) {
      if (!current.isEqualNode(next)) patchLiveText(current, next, animate);
      current = current.nextSibling;
    } else {
      const node = next.cloneNode(true), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = [];
      for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text);
      for (const text of texts) text.replaceWith(newLiveText(text.data, animate && !current));
      target.insertBefore(node, current);
    }
  }
  while (current) { const next = current.nextSibling; current.remove(); current = next; }
}

function clearLiveFades() {
  const root = document.querySelector("#live-reply"), selection = document.getSelection();
  if (selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return;
  for (const span of root.querySelectorAll(".stream-fragment")) span.replaceWith(document.createTextNode(span.textContent));
  root.normalize();
}
document.querySelector("#live-reply").addEventListener("animationend", event => {
  if (event.animationName !== "stream-in") return;
  const span = event.target, selection = document.getSelection(), root = document.querySelector("#live-reply");
  if (selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return;
  const parent = span.parentNode;
  span.replaceWith(document.createTextNode(span.textContent)); parent?.normalize();
});
document.addEventListener("visibilitychange", () => { clearLiveFades(); renderLive(true); });
streamMotion.addEventListener("change", () => { clearLiveFades(); renderLive(true); });

function renderLive(immediate = false) {
  if (liveRenderFrame !== null) { cancelAnimationFrame(liveRenderFrame); liveRenderFrame = null; }
  const node = document.querySelector("#live-reply");
  const frame = liveFrame;
  if (!frame?.running) { node.hidden = true; node.innerHTML = ""; liveRenderedText = null; liveRevealTime = 0; renderWorkingPill(); return; }
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) return;
  if (!node.querySelector(".text")) {
    node.innerHTML = '<div class="who">Coordinator <small class="inline">live</small></div><p class="thought live" hidden><span class="thought-mark">Thinking</span><span class="thought-text"></span></p><div class="text"></div><p class="note live-limit" hidden>Live preview limit reached. The full reply will appear when it finishes.</p><p class="live-status"><span class="live-dot"></span><span></span></p>';
    liveRenderedText = null;
  }
  const thought = node.querySelector(".thought"), summary = frame.text && frame.thinkingText ? thoughtText(frame.thinkingText) : "";
  thought.hidden = !summary;
  const thoughtTextNode = thought.querySelector(".thought-text");
  if (thoughtTextNode.textContent !== summary) thoughtTextNode.textContent = summary;
  const now = performance.now(), animate = !immediate && !document.hidden && !streamMotion.matches;
  let shown = frame.text;
  if (animate && now < liveRevealDeadline) {
    const start = liveRenderedText && frame.text.startsWith(liveRenderedText) ? liveRenderedText.length : 0;
    // Spread provider bursts over a short catch-up window, not a fixed typing speed that can fall behind.
    const elapsed = Math.min(50, now - liveRevealTime || 16);
    let end = Math.min(frame.text.length, start + Math.max(1, Math.ceil((frame.text.length - start) * elapsed / Math.max(16, liveRevealDeadline - now))));
    if (end < frame.text.length && /[\uD800-\uDBFF]/.test(frame.text[end - 1])) end++;
    shown = frame.text.slice(0, end);
  }
  liveRevealTime = now;
  if (liveRenderedText !== shown) {
    const text = node.querySelector(".text"), next = document.createElement("template");
    // Close the preview fence without adding text to the code block.
    const markdown = shown + (shown.split("```").length % 2 === 0 ? "```" : "");
    next.innerHTML = renderMarkdown(markdown, { refs: {} });
    text.normalize(); patchLiveText(text, next.content, animate);
    liveRenderedText = shown;
  }
  if (shown !== frame.text) scheduleLiveRender();
  node.querySelector(".text").hidden = !frame.text;
  node.querySelector(".live-limit").hidden = !frame.textTruncated || shown !== frame.text;
  const status = node.querySelector(".live-status span:last-child"), label = liveStatus(frame);
  if (status.textContent !== label) status.textContent = label;
  node.hidden = false;
  followTranscript();
  renderWorkingPill();
}

function selectionOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}
function selectionPoint(root, offset, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (offset < node.length || end && offset === node.length) return { node, offset };
    offset -= node.length;
  }
  return null;
}
function captureLiveSelection() {
  const root = document.querySelector("#live-reply .text"), selection = document.getSelection();
  if (!root || !selection?.rangeCount || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  return { projectId, chatId, text: root.textContent, anchor: selectionOffset(root, selection.anchorNode, selection.anchorOffset), focus: selectionOffset(root, selection.focusNode, selection.focusOffset) };
}
function restoreLiveSelection(saved) {
  if (!saved || saved.projectId !== projectId || saved.chatId !== chatId) return;
  const root = [...document.querySelectorAll("#messages .msg.them .text")].reverse().find(node => node.textContent.startsWith(saved.text));
  // At block boundaries, start inside the next text node rather than selecting a rendered line break.
  const anchor = root && selectionPoint(root, saved.anchor, saved.anchor > saved.focus), focus = root && selectionPoint(root, saved.focus, saved.focus > saved.anchor);
  if (!anchor || !focus) return;
  document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

function clearTranscriptSelection() {
  const selection = document.getSelection(), transcript = document.querySelector("#transcript");
  if (selection && transcript && (transcript.contains(selection.anchorNode) || transcript.contains(selection.focusNode))) selection.removeAllRanges();
}

function changeProject(id, chat = "main") {
  clearTranscriptSelection();
  generation++;
  workerChat = null; searchFocus = null; workerFocus = null;
  projectId = id; chatId = chat; linksReady = false;
  uiPluginCall("projectChanged");
  captureDialogDraft();
  liveStream?.controller.abort(); liveStream = null; liveFrame = null; renderLive(); knowledgeDocs = []; stickToBottom = true;
  view = null; plan = null; observability = null; observabilityLoading = false; eventOffset = 0; approvalPage = null; operationCache.clear(); knowledgeCache.clear(); libraryCache.clear(); libraryPayload = null; settingsCache = null; modelCache.clear(); providerCache.clear(); routineCache = null; selected = null;
  closeDialog();
  const url = new URL(location.href);
  if (id) url.searchParams.set("project", id); else url.searchParams.delete("project");
  if (chat === "main") url.searchParams.delete("chat"); else url.searchParams.set("chat", chat);
  history.replaceState(null, "", url);
  document.querySelector("#projects").value = id ?? "";
  document.querySelector("#compose textarea").value = drafts.get(draftKey()) ?? ""; autosize(document.querySelector("#compose textarea")); renderAttachments();
  document.querySelector("#compose button").disabled = !id || busy;
  html.clear(); usageObs = null;
  closeWorkerDetail();
  renderArtifactBrowser();
  const p = projects.find(p => p.id === id);
  document.querySelector("#title").textContent = id ? p?.name ?? "Opening project…" : "Create your first project.";
  document.querySelector("#avatar").textContent = initials(p?.name);
  for (const selector of ["#chat-bar", "#queue", "#letter", "#needs-questions", "#questions", "#activity", "#outcomes", "#notes", "#messages", "#reply-summary", "#workspace", "#evidence-inline", "#obs-kpis", "#obs-usage", "#obs-health", "#obs-trace", "#obs-timeline", "#obs-event-log", "#obs-usage-time", "#owner-steps", "#settings-summary"]) document.querySelector(selector).replaceChildren();
  document.querySelector("#chat-bar").dataset.html = "";
  renderProjects();
  document.querySelector("#warning").hidden = true;
  disableActions();
  void refresh();
}

// Switching chats keeps the project, plan and rail; only the transcript, live stream and draft change.
function changeChat(chat) {
  if (chat === chatId && view?.chatId === chat) return;
  clearTranscriptSelection();
  generation++;
  chatId = chat;
  if (searchFocus?.chat !== chat) searchFocus = null;
  const url = new URL(location.href);
  if (chat === "main") url.searchParams.delete("chat"); else url.searchParams.set("chat", chat);
  history.replaceState(null, "", url);
  liveStream?.controller.abort(); liveStream = null; liveFrame = null; renderLive(); stickToBottom = true;
  closeSkillMenu();
  const textarea = document.querySelector("#compose textarea");
  textarea.value = drafts.get(draftKey()) ?? ""; autosize(textarea);
  if (view) { view = { ...view, chatId: chat, messages: [], jobs: [] }; render(); }
  void refresh();
}
function currentChat() { return view?.chats?.find(chat => chat.id === chatId) ?? null; }
function renderChats() {
  const node = document.querySelector("#chat-bar"), chats = view?.chats ?? [];
  const current = currentChat(), archived = chats.filter(chat => chat.archived && chat.id !== chatId);
  const button = chat => { const { state, label } = chatState(chat); return `<button class="chat ${chat.id === chatId ? "on" : ""} ${chat.archived ? "archived" : ""}" data-action="chat-select" data-chat="${esc(chat.id)}" title="${esc(chat.title)} · ${esc(label)}">${stateDot(state, label, "chat-dot")}<span class="chat-title">${esc(chat.title)}</span></button>`; };
  const next = !view?.chats ? "" : `<nav id="chat-list" class="chat-list" aria-label="Chats">${chats.filter(chat => !chat.archived || chat.id === chatId).map(button).join("")}</nav><button type="button" class="ghost small" data-action="chat-new" title="Start a chat that shares this project's workers and knowledge">＋ New chat</button><span class="chat-tools">${current ? `<button type="button" class="ghost small" data-action="chat-rename">Rename</button>` : ""}${current && current.id !== "main" ? current.archived ? `<button type="button" class="ghost small" data-action="chat-restore" data-chat="${esc(current.id)}">Restore</button>` : `<button type="button" class="ghost small" data-action="chat-archive">Archive</button>` : ""}${archived.length ? `<details id="chat-archived" class="chat-archived"><summary>Archived (${archived.length})</summary><div class="archived-list">${archived.map(chat => `<div class="archived-row"><span>${esc(chat.title)}</span><span><button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(chat.id)}">Open</button> <button type="button" class="ghost small" data-action="chat-restore" data-chat="${esc(chat.id)}">Restore</button></span></div>`).join("")}</div></details>` : ""}</span>`;
  if (node.dataset.html !== next) { const open = node.querySelector("#chat-archived")?.open; node.innerHTML = next; node.dataset.html = next; if (open && node.querySelector("#chat-archived")) node.querySelector("#chat-archived").open = true; }
}

// One status dot per chat and per project row, highest priority first: needs you (red) > working (pulsing) > done and not yet checked (green) > idle.
// Needs you: an unanswered question, a blocked worker admitted by the chat, or a failed coordinator turn (pending approvals count on the project row only).
// Done: the coordinator finished, or a worker from the chat completed, after the last time this browser had the chat open.
const seenKey = (project, chat) => `pi-projects-seen:${project}:${chat}`;
function seenAt(project, chat) { try { const value = Number(localStorage.getItem(seenKey(project, chat))); return value > 0 ? value : null; } catch { return null; } }
function markSeen(project, chat) { try { localStorage.setItem(seenKey(project, chat), String(Date.now())); } catch {} }
function chatWork(chat) { return plan ? plan.work.filter(work => !work.archived && workChatId(work) === chat.id) : []; }
const latestFinish = chat => Math.max(chat.finishedAt ?? 0, ...chatWork(chat).filter(work => work.status === "completed").map(work => work.endedAt ?? 0));
// First sight of a chat starts its clock; the open chat is always up to date, so opening a chat clears its dot.
function syncSeen() {
  if (!view?.chats || !plan) return;
  markSeen(projectId, PROJECT_SEEN);
  for (const chat of view.chats) {
    const seen = seenAt(projectId, chat.id);
    if (seen === null || chat.id === chatId && latestFinish(chat) > seen) markSeen(projectId, chat.id);
  }
}
const STATE_PRIORITY = ["needs", "working", "done", "idle"];
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
function chatState(chat) {
  const questions = view.inbox.filter(item => item.kind === "question" && !item.result && (questionChat(item)?.id ?? "main") === chat.id).length;
  const work = chatWork(chat), blocked = work.filter(item => item.status === "blocked").length, seen = seenAt(projectId, chat.id);
  const reasons = [questions && `${plural(questions, "unanswered question")}`, blocked && `${plural(blocked, "blocked worker")}`, chat.attention && "last coordinator turn failed"].filter(Boolean);
  if (reasons.length) return { state: "needs", label: `Needs you: ${reasons.join(", ")}` };
  const active = work.filter(item => item.status === "running" || item.status === "queued").length;
  if (chat.busy || active) return { state: "working", label: `Working: ${[chat.busy && "coordinator", active && plural(active, "worker")].filter(Boolean).join(" and ")}` };
  if (chat.id !== chatId && seen !== null && latestFinish(chat) > seen) return { state: "done", label: "Done, not yet checked" };
  return { state: "idle", label: "Idle" };
}
const stateDot = (state, label, className) => `<span class="${className}" data-state="${state}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></span>`;
// The open project folds its chats and pending approvals. Every other project comes from the host's list: unanswered questions and its live activity
// (turn or workers running, failure or blocked worker, last finish), so a project keeps showing its own state after you leave it.
const PROJECT_SEEN = "__project";
function projectState(project) {
  if (project.id !== projectId || !view?.chats) {
    const questions = project.notice?.questions ?? 0, activity = project.activity;
    if (questions || project.phase === "attention" || activity?.needs) return { state: "needs", label: questions ? `Needs you: ${plural(questions, "unanswered question")}` : activity?.needs ? "Needs you: a chat failed or a worker is blocked" : "Needs you: a chat failed" };
    if (activity ? activity.working : project.phase === "busy") return { state: "working", label: "Working" };
    const seen = seenAt(project.id, PROJECT_SEEN);
    if (activity && seen !== null && activity.finishedAt > seen) return { state: "done", label: "Done, not yet checked" };
    return { state: "idle", label: "Idle" };
  }
  const states = view.chats.filter(chat => !chat.archived).map(chat => chatState(chat));
  const approvals = approvalPage?.total ?? 0;
  if (approvals) return { state: "needs", label: `Needs you: ${plural(approvals, "pending approval")}${states.some(item => item.state === "needs") ? " and chats" : ""}` };
  return states.toSorted((a, b) => STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state))[0] ?? { state: "idle", label: "Idle" };
}
let projectListAt = 0, listedFor = null;
async function reloadProjects() {
  projectListAt = Date.now(); listedFor = projectId;
  const loaded = await api({ action: "list" }).catch(() => null);
  if (Array.isArray(loaded)) {
    projects = loaded;
    // First sight of a project starts its clock, like chats: older finishes never light up.
    for (const project of loaded) if (seenAt(project.id, PROJECT_SEEN) === null) markSeen(project.id, PROJECT_SEEN);
    renderProjects();
  }
}
// Rows of other projects only change on the host's list, so while one of them is working the list is re-read every 5 s (else every 15 s); only while the tab is visible.
setInterval(() => {
  if (document.hidden) return;
  const otherWorking = projects.some(project => project.id !== projectId && project.activity?.working);
  if (Date.now() - projectListAt > (otherWorking ? 4500 : 14500)) void reloadProjects();
}, 5000);
function renderProjects() {
  const node = document.querySelector("#projects");
  node.innerHTML = projects.length ? projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("") : '<option value="">No projects yet</option>';
  node.value = projectId ?? "";
  const list = document.querySelector("#project-list");
  const next = projects.map(p => `<button class="proj ${p.id === projectId ? "on" : ""}" data-select-project="${esc(p.id)}" title="${esc(p.name)}"><span class="avatar sm">${esc(initials(p.name))}</span><span class="grow side-text">${esc(p.name)}</span>${(({ state, label }) => state === "idle" ? "" : stateDot(state, label, "state-dot"))(projectState(p))}</button>`).join("") || '<p class="note">No projects yet.</p>';
  if (list.dataset.html !== next) { list.innerHTML = next; list.dataset.html = next; }
}
function initials(name) { return String(name ?? "π").trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? "").join("").toUpperCase() || "π"; }
function pendingCount() { return view ? view.inbox.filter(item => !item.result).length + (approvalPage?.total ?? 0) : 0; }
function setTab(next) {
  if (!tabs.includes(next)) return;
  if (next !== "coordinator" && workerChat) closeWorkerDetail();
  tab = next;
  const url = new URL(location.href); url.searchParams.set("tab", next); history.replaceState(null, "", url);
  document.querySelectorAll("[data-panel]").forEach(node => { node.hidden = node.dataset.panel !== next || node.dataset.panel === "coordinator" && !threadPane.hidden; });
  document.querySelectorAll(".tabs [data-tab]").forEach(node => node.classList.toggle("on", node.dataset.tab === next));
  // A hidden transcript loses its scroll position; coming back to the chat means reading the newest message.
  if (next === "coordinator") { stickToBottom = true; requestAnimationFrame(followTranscript); }
  uiPluginCall("tick");
  if (next === "observability") { void loadUsage(); void loadObservability(); }
  ensureChanges();
  if (next === "settings") { void loadAutomationStrip(); void loadEventsIn(); void loadTelegram(); void loadRemote(); void loadSkillsPicker(); void loadMcpPicker(); void loadPrompts(true, true); void loadWorktrees(); renderNotify(); }
}

function render() {
  if (!view) return;
  const pending = [...view.inbox.filter(item => !item.result), ...(approvalPage?.items ?? []).filter(record => record.status === "pending").map(record => ({ kind: "approval", id: `operation:${record.id}`, title: `${record.operation.provider} ${record.operation.kind} · ${record.operation.repositoryId}`, record }))].sort((a, b) => (a.kind === "question" ? 0 : 1) - (b.kind === "question" ? 0 : 1));
  const pendingTotal = view.inbox.filter(item => !item.result).length + (approvalPage?.total ?? 0);
  // Questions live in the chat transcript; the sidebar card keeps operation approvals only.
  const approvals = pending.filter(item => item.kind === "approval");
  const entry = approvals.find(item => item.id === selected) ?? approvals[0];
  selected = entry?.id ?? null;
  document.title = `${view.project.name} · Pi Projects`;
  document.querySelector("#title").textContent = view.project.name;
  document.querySelector("#avatar").textContent = initials(view.project.name);
  for (const selector of ["#needs-count"]) { const node = document.querySelector(selector); node.textContent = String(pendingTotal); node.hidden = !pendingTotal; }
  syncSeen();
  renderProjects();
  renderChats();
  uiPluginCall("render");
  setHtml("#queue", approvals.length < 2 ? "" : approvals.map((item, i) => `<button class="inbox-item ${entry.id === item.id ? "active" : ""}" data-action="select" data-entry="${item.id}"><span class="index">${String(i + 1).padStart(2, "0")}</span><span class="item-body"><strong>${esc(item.title)}</strong><small>${item.kind === "question" ? "A decision for the coordinator" : "Exact bound operation, not an execution"}</small></span><span class="arrow">↗</span></button>`).join(""));
  setHtml("#letter", entry ? letter(entry) : "");
  const waiting = questionPlacement();
  setHtml("#needs-questions", waiting.here.length || waiting.elsewhere.length ? `${waiting.here.length ? `<button type="button" class="ghost small" data-action="questions-jump">${waiting.here.length} ${waiting.here.length === 1 ? "question" : "questions"} in chat ↓</button>` : ""}${waiting.elsewhere.length ? `<button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(waiting.elsewhere[0].chat.id)}">${waiting.elsewhere.length} ${waiting.elsewhere.length === 1 ? "question" : "questions"} in other chats →</button>` : ""}` : "");
  document.querySelector("#needs-card").hidden = !entry && !waiting.here.length && !waiting.elsewhere.length;
  document.querySelector("#question-hint").hidden = !waiting.here.length;
  renderWorkers();
  setHtml("#outcomes", plan ? durableResults() : "");
  renderPrs(); void loadPrs();
  // The rail shows topic documents; the starter files and raw legacy answers live in the Knowledge tab.
  const topics = knowledgeDocs.filter(doc => doc.path !== "MEMORY.md" && doc.path !== "preferences.md" && !doc.path.startsWith("research/legacy/"));
  setHtml("#notes", topics.length ? knowledgeTree(topics, true) : `<p class="note">${knowledgeDocs.length ? "Only the starter MEMORY.md and preferences.md so far." : "No knowledge documents yet."}</p>`);
  setHtml("#knowledge-inline", knowledgeDocs.length ? knowledgeTree(knowledgeDocs, false) : '<p class="note">No knowledge documents yet.</p>');
  setHtml("#uploads-inline", uploadsHtml()); renderAttachments();
  const readingAnchor = stickToBottom ? null : captureTranscriptAnchor();
  setHtml("#messages", transcriptHtml(waiting.answered) || `<div class="empty-chat"><h2>How can the coordinator help with ${esc(view.project.name)}?</h2><p>Describe an outcome. The coordinator plans the work, spawns workers and brings decisions back here.</p></div>`);
  if (!stickToBottom) restoreTranscriptAnchor(readingAnchor);
  setHtml("#questions", waiting.here.map(questionCard).join("") + waiting.elsewhere.map(({ item, chat }) => `<p class="question-away"><span>Question waiting in chat <b>${esc(chat.title)}</b>: ${esc(clip(item.title, 90))}</span><button type="button" class="small" data-action="chat-select" data-chat="${esc(chat.id)}">Open</button></p>`).join(""));
  const reply = view.messages.findLast(message => message.role === "assistant" && message.text.trim());
  setHtml("#reply-summary", reply ? `<div class="reply-text">${renderMarkdown(reply.text.slice(0, 500))}</div><button type="button" class="ghost small" data-action="conversation">Read conversation ↗</button>` : "");
  document.querySelector("#approvals-button").hidden = !plan;
  document.querySelector("#settings-button").hidden = !plan;
  document.querySelector("#owner-setup-button").hidden = !view;
  document.querySelector("#usage-button").hidden = !plan;
  document.querySelector("#provider-button").hidden = !plan;
  document.querySelector("#routines-button").hidden = !plan;
  const historyButton = document.querySelector('[data-action="routine-history"]');
  if (historyButton) { historyButton.dataset.project = projectId ?? ""; historyButton.hidden = !plan; }
  document.querySelector("#approval-page-note").textContent = approvalPage ? `Inbox includes pending approvals ${approvalPage.items.length ? 1 : 0}-${approvalPage.items.length}/${approvalPage.total}. Completed history is excluded; open all approvals for later pending/history records.` : "";
  renderModelCycle();
  renderPanels();
  document.querySelector("#workspace").textContent = view.project.cwd;
  document.querySelector("#workspace-policy").textContent = "Workers run on this Mac and edit only folders you allow in Settings. Keep the Mac awake while work runs.";
  // Failures older than the newest settled turn are history, not current problems.
  const lastDone = view.jobs.findLastIndex(job => job.state === "done");
  const failures = view.jobs.slice(lastDone + 1).filter(job => ["failed", "interrupted"].includes(job.state)).slice(-2);
  // Each warning row: [dismiss key, html]; the key is the project, the source (job/work/latest job) and the text, so a new failure shows again.
  const row = (source, text, extra = "") => [`${view.project.id}:${source}:${text}`, `<span>${esc(text)}${extra}</span>`];
  const warnings = failures.map(job => row(job.id, `${job.state}: ${job.error ?? job.text}`, ` <button class="ghost small" data-action="retry-message" data-project="${esc(view.project.id)}" data-job="${esc(job.id)}">Retry</button>`));
  if (plan) warnings.push(...plan.work.filter(work => work.blocker && !work.archived).slice(-3).map(work => row(work.id, `${work.role} ${work.threadId}: ${work.blocker}`)));
  const shownProblem = failures.some(job => job.error === view.project.problem);
  // The problem may come from another chat; offer to open it.
  const problemChat = (view.chats ?? []).find(chat => chat.attention && chat.id !== chatId && view.project.problem?.startsWith(`Chat "${chat.title}": `));
  if (view.project.problem && !shownProblem && !pending.some(item => item.kind === "question" && item.question === view.project.problem)) warnings.unshift(row(view.jobs.at(-1)?.id ?? "", view.project.problem, problemChat ? ` <button class="ghost small" data-action="chat-select" data-chat="${esc(problemChat.id)}">Open chat</button>` : ""));
  const shown = warnings.filter(([key]) => !dismissed.has(key)), warning = document.querySelector("#warning");
  setHtml("#warning", shown.map(([key, body]) => `<div class="notice-row">${body}${closeButton(key)}</div>`).join("")); warning.hidden = !shown.length;
  renderContextMeter(view.context);
  disableActions();
  applySearchFocus();
}

function renderModelCycle() {
  const button = document.querySelector("#model-cycle"), reference = view?.project?.model;
  button.hidden = !reference;
  if (!reference) return;
  const name = modelCache.get(reference)?.name ?? reference.split("/").at(-1);
  button.textContent = name; button.title = `${reference}. Next scoped model (Ctrl+P); previous with Shift+Ctrl+P.`;
  button.setAttribute("aria-label", `Coordinator model: ${name}. Switch to the next scoped model.`);
}
async function cycleModel(step) {
  if (!projectId || !view) return;
  await loadModelPicker();
  if (modelScopeSet && !modelScoped.length) throw new Error("None of your scoped models is usable (not installed or no credentials). Fix the scope in Settings; the model button never switches outside it.");
  const configured = [...modelCache.values()].filter(model => model.configured).map(model => model.reference), list = modelScopeSet ? modelScoped : configured;
  const at = list.indexOf(view.project.model), next = list[(at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length)];
  if (!next || next === view.project.model) { toast("There is no other scoped model to switch to. Edit the scope in Settings."); return; }
  const settings = await api({ action: "settings-snapshot", id: projectId });
  const focused = document.activeElement, id = projectId, chat = chatId;
  try {
    await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { model: next } }, `Coordinator model: ${modelCache.get(next)?.name ?? next}. Next requests and new threads use it.`);
    settingsCache = null;
  } finally {
    // Disabling the composer during the update drops focus; do not steal it from another field or dialog.
    if (projectId === id && chatId === chat && !dialog.open && document.activeElement === document.body && focused?.isConnected && !focused.disabled) focused.focus({ preventScroll: true });
  }
}
function renderContextMeter(context) {
  const meter = document.querySelector("#compose .context-meter");
  const known = context && context.window;
  const percent = known ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : 0;
  const label = known ? `Context ${percent}% used · ${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens` : "Context use unknown";
  const circumference = 2 * Math.PI * 8;
  meter.querySelector(".fill").setAttribute("stroke-dasharray", `${(circumference * percent / 100).toFixed(2)} ${circumference.toFixed(2)}`);
  meter.dataset.level = percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
  meter.setAttribute("aria-label", label);
  const popup = meter.querySelector(".context-popup"), compacting = !!context?.compacting;
  const popupHtml = `<span class="context-label">${esc(compacting ? `${label} · compacting…` : label)}</span><button type="button" class="ghost small" data-action="compact-now" ${compacting ? "disabled" : ""}>${compacting ? "Compacting…" : "Compact now"}</button>`;
  if (popup.dataset.html !== popupHtml) { popup.innerHTML = popupHtml; popup.dataset.html = popupHtml; }
  meter.querySelector(".context-pct").textContent = known ? `${percent}%` : "";
}

function renderPanels() {
  const p = view.project, work = plan?.work ?? [];
  const count = status => work.filter(item => item.status === status).length;
  const transcript = document.querySelector("#transcript");
  transcript.dataset.count = String(view.messages.length);
  followTranscript();
  setHtml("#evidence-inline", view.evidence.slice(-6).reverse().map(artifactButton).join("") || '<p class="note">No evidence captured yet.</p>');
  const kpi = (label, value, tone = "") => `<div class="card kpi ${tone}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
  setHtml("#obs-kpis", [kpi("Needs you", pendingCount(), pendingCount() ? "warn" : ""), kpi("Running", count("running")), kpi("Queued", count("queued")), kpi("Blocked", count("blocked"), count("blocked") ? "err" : ""), kpi("Work items", work.length), kpi("Worker cap", plan?.workerCap ?? "—")].join(""));
  renderHealth(p);
  if (tab === "observability" && plan && !observability && !observabilityLoading) void loadObservability();
  const threads = new Map();
  for (const item of work) threads.set(item.threadId, [...threads.get(item.threadId) ?? [], item]);
  // One node per chat; each worker thread sits under the chat that delegated its latest work (null means Main).
  const chats = view.chats ?? [{ id: "main", title: "Coordinator", conversationId: null, busy: view.busy, archived: false }];
  const mainConversation = chats.find(chat => chat.id === "main")?.conversationId ?? null;
  const childThreads = threadId => [...threads].filter(([id, items]) => id !== threadId && items.at(-1).parentThreadId === threadId);
  const owner = items => chats.find(chat => chat.conversationId === (items.at(-1).chatConversationId ?? mainConversation)) ?? chats[0];
  const threadHtml = ([threadId, items], nested = false) => `<li${nested ? ` class="trace-child" data-parent="${esc(items.at(-1).parentThreadId)}"` : ""} data-thread="${esc(threadId)}"><details ${items.some(item => ["running", "queued", "blocked"].includes(item.status)) ? "open" : ""}><summary>${badge(items.at(-1).status)} <b>${nested ? "sub-agent · " : ""}${esc(items[0].role)} thread</b> <small class="inline mono">${esc(threadId.slice(0, 8))} · ${items.length} work item(s)</small> <button class="ghost small" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(threadId)}">history ↗</button></summary><ul>${items.map(item => `<li>${badge(item.status)} ${esc(item.text.slice(0, 160))} <small class="inline">${esc(item.attempt?.model ?? "")}</small></li>`).join("")}${(observability?.tools ?? []).filter(call => call.threadId === threadId).map(call => `<li>${toolCallHtml(call)}</li>`).join("")}${childThreads(threadId).map(entry => threadHtml(entry, true)).join("")}</ul></details></li>`;
  setHtml("#obs-trace", `<ul class="trace">${chats.map(chat => { const owned = [...threads].filter(([, items]) => owner(items) === chat && !(items.at(-1).parentThreadId && threads.has(items.at(-1).parentThreadId))); return `<li class="trace-chat" data-chat="${esc(chat.id)}"><details ${chat.busy || owned.length || chat.id === "main" ? "open" : ""}><summary><b>${esc(chat.title)}</b> <small class="inline">chat · ${esc(p.model)} · ${chat.busy ? "busy" : "idle"}${chat.archived ? " · archived" : ""}${chat.attention ? " · needs attention" : ""}</small></summary><ul>${owned.map(threadHtml).join("") || '<li class="note">No threads from this chat.</li>'}</ul></details></li>`; }).join("")}</ul>`);
  setHtml("#obs-usage", usageHtml());
  renderUsageBuckets();
  const now = Date.now(), starts = work.map(item => item.startedAt).filter(Number.isFinite), ends = work.map(item => item.endedAt).filter(Number.isFinite);
  const rangeStart = Math.min(...starts, now), rangeEnd = Math.max(now, ...ends), span = Math.max(1, rangeEnd - rangeStart);
  setHtml("#obs-timeline", work.length ? work.toReversed().map(item => {
    const start = Number.isFinite(item.startedAt) ? item.startedAt : null, end = Number.isFinite(item.endedAt) ? item.endedAt : (start !== null && item.status === "running" ? now : null);
    const x = start === null ? 0 : Math.max(0, Math.min(100, (start - rangeStart) / span * 100)), width = start === null ? 0 : Math.max(1, Math.min(100 - x, ((end ?? start + 1) - start) / span * 100));
    return `<div class="timeline-row"><small>${esc(item.role)} · ${esc(item.text.slice(0, 90))}</small><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${esc(item.status)}"><rect x="${x}" y="1" width="${width}" height="6" rx="3" class="timeline-bar"></rect></svg><small>${start === null ? "Not started" : `${esc(new Date(start).toLocaleTimeString())}${end === null ? " · ongoing" : ` – ${esc(new Date(end).toLocaleTimeString())}`}`}</small></div>`;
  }).join("") : '<p class="note">No worker timestamps recorded.</p>');
  const scopes = p.workspaceAuthorization?.scopes?.length ?? 0, grants = p.githubAuthorization?.length ?? 0, pluginProvider = p.workspaceAuthorization && p.workspaceAuthorization.provider !== "github" ? p.workspaceAuthorization.provider : null, providerCard = (view.providerCards ?? [])[0];
  const step = (done, title, detail) => `<li class="${done ? "done" : ""}"><span class="n">${done ? "✓" : "•"}</span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></li>`;
  const wholeRepository = p.workspaceAuthorization?.scopes?.some(scope => scope.wholeRepository);
  setHtml("#owner-steps", [...(scopes ? [] : [step(false, "Repository", "No Git repository found in the project folder, so workers cannot edit code.")]), (pluginProvider ? (providerCard ? step(providerCard.state === "connected", `1. ${providerCard.title}`, providerCard.state === "connected" || wholeRepository ? providerCard.body : "Not connected.") + (wholeRepository && providerCard.state === "available" && providerCard.connect ? `<li class="step-action"><button class="primary" data-action="provider-connect" data-card="${esc(providerCard.id)}">${esc(providerCard.connect.label)}</button></li>` : "") : step(false, `1. ${pluginProvider}`, view.unloadedProvider ? "The provider plugin is not loaded; its records are kept." : "Not connected.")) : step(grants > 0, "1. GitHub", grants ? `Draft PRs on ${p.githubAuthorization.map(grant => grant.repositoryId).join(", ")}` : wholeRepository ? "Workers cannot open draft PRs yet." : "Not connected.") + (wholeRepository && !grants ? '<li class="step-action"><button class="primary" data-action="github-quick">Connect GitHub</button></li>' : "")), ...(wholeRepository ? [] : [step(false, "2. Fixed command profile", "Optional, owner-defined executable and arguments.")]), step(true, wholeRepository ? "2. Skills" : "3. Skills", "Chosen per role in Skills below; repository skills by default.")].join(""));
  if (tab === "settings" && plan) { void loadAutomationStrip(); void loadEventsIn(); void loadSkillsPicker(); void loadMcpPicker(); void loadPrompts(); void loadWorktrees(); void loadContextSettings(); }
  if (tab === "settings" && !telegramView) void loadTelegram();
  setHtml("#settings-summary", `<div class="kv"><span>Coordinator model</span><b>${esc(p.model)}</b>${Object.entries(p.models ?? {}).map(([role, model]) => `<span>${esc(role[0].toUpperCase() + role.slice(1))} model</span><b>${esc(model)}</b>`).join("")}${Object.entries(p.fallbackModels ?? {}).map(([role, model]) => `<span>${esc(role[0].toUpperCase() + role.slice(1))} quota fallback</span><b>${esc(model)}</b>`).join("")}<span>Workspace</span><b class="mono">${esc(p.cwd)}</b></div>`);
  if (tab === "observability" && plan && (!usageObs || Date.now() - usageObs.at > 15000)) void loadUsage();
}

// Skills (Settings): "All profiles" plus per-role additions. Prompts carry only names and descriptions; bodies are read on demand.
const skillProfileTabs = [["all", "All profiles"], ["coordinator", "Coordinator"], ["worker", "Worker"], ["scout", "Scout"], ["reviewer", "Reviewer"]];
const skillSourceLabels = { repo: "Repository", global: "Global", package: "Packages" };
let skillsPicker = null;
async function loadSkillsPicker(force = false) {
  const id = projectId, current = generation, node = document.querySelector("#skills-picker");
  if (!id || !plan) return;
  // Opening Settings rebuilds the list from disk. Unsaved choices are kept: only the catalog is refreshed, so a skill installed meanwhile still shows up.
  if (!force && skillsPicker?.projectId === id && JSON.stringify(skillsPicker.draft) !== skillsPicker.saved) {
    try { const { skills } = await api({ action: "coordinator-skills", id }); if (id === projectId && current === generation && skillsPicker?.projectId === id) { skillsPicker.skills = skills; renderSkillsPicker(); } } catch {}
    return;
  }
  try {
    const [settings, { skills }] = await Promise.all([api({ action: "settings-snapshot", id }), api({ action: "coordinator-skills", id })]);
    if (id !== projectId || current !== generation) return;
    const saved = settings.values.skills;
    const profiles = { ...{ all: [], coordinator: [], worker: [], scout: [], reviewer: [] }, ...(saved?.off ?? {}) };
    skillsPicker = { projectId: id, skills, isDefault: !saved?.off || !Object.values(saved.off).some(list => list.length), draft: sortedLists(profiles), saved: JSON.stringify(sortedLists(profiles)), tab: skillsPicker?.projectId === id ? skillsPicker.tab : "all", query: skillsPicker?.projectId === id ? skillsPicker.query : "", note: "" };
    renderSkillsPicker();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">Skills unavailable: ${esc(error.message)}</p>`; }
}
// Pickers render in three parts so a toggle never moves anything: "all" = shell (tabs, search, list), "list" = rows only (search, bulk), "chrome" = counts and buttons only (a checkbox toggle).
const sortedLists = value => Object.fromEntries(Object.entries(value).map(([key, list]) => [key, [...list].sort()])); // toggling re-sorts a list; a saved list in another order must not look dirty
// One shared selection is the normal case. Per-role lists stay reachable, and open by themselves when a role already has its own.
const rolesShown = state => state.roles || state.tab !== "all" || ["coordinator", "worker", "scout", "reviewer"].some(role => state.draft[role].length);
const profileTabsHtml = (action, tab, count, expanded) => `<div class="skill-tabs" role="tablist">${skillProfileTabs.map(([role, label]) => `<button type="button" role="tab"${role !== "all" && !expanded ? " hidden" : ""} class="ghost small${role === tab ? " on" : ""}" aria-selected="${role === tab}" data-action="${action}" data-role="${role}">${label} <span class="count">${count(role)}</span></button>`).join("")}${expanded ? "" : `<button type="button" class="ghost small" data-action="profile-roles" data-picker="${action.split("-")[0]}">Different per role…</button>`}</div>`;
const patchPickerChrome = (node, count, dirty) => {
  for (const button of node.querySelectorAll(".skill-tabs [data-role]")) button.querySelector(".count").textContent = count(button.dataset.role);
  const save = node.querySelector('[data-action$="-save"]'); if (save) { save.disabled = !dirty; save.toggleAttribute("data-off", !dirty); }
  const bar = node.querySelector(".pick-state"); if (bar) bar.hidden = !dirty;
};
const bulkButtons = (action, source = "") => `<span class="pick-bulk"><button type="button" class="ghost small" data-action="${action}" data-source="${source}" data-mode="all">Select all</button><button type="button" class="ghost small" data-action="${action}" data-source="${source}" data-mode="none">Clear</button></span>`;
function skillsShown(state) {
  const q = state.query.trim().toLowerCase();
  return state.skills.filter(skill => !q || skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
}
function skillsListHtml(state) {
  const all = new Set(state.draft.all), picked = new Set(state.draft[state.tab]), shown = skillsShown(state);
  const groups = Object.keys(skillSourceLabels).map(source => [source, shown.filter(skill => skill.source === source)]).filter(([, list]) => list.length);
  const row = skill => { const inherited = state.tab !== "all" && all.has(skill.name); return `<label class="skill-pick${inherited ? " inherited" : ""}"><input type="checkbox" data-skill-pick="${esc(skill.name)}" ${!inherited && !picked.has(skill.name) ? "checked" : ""} ${inherited ? "disabled" : ""}><span><b>${esc(skill.name)}</b>${inherited ? ' <small class="skill-tag">off for all profiles</small>' : ""}${skill.manual ? ' <small class="skill-tag">manual only</small>' : ""}<small>${esc(skill.description)}</small></span></label>`; };
  return groups.map(([source, list]) => `<fieldset class="events-group skill-group" data-source="${source}" aria-label="${skillSourceLabels[source]}"><div class="group-head"><b>${skillSourceLabels[source]} <span class="count">${list.length}</span></b>${bulkButtons("skills-select", source)}</div>${list.map(row).join("")}</fieldset>`).join("") || '<p class="note">No skill matches.</p>';
}
function renderSkillsPicker(part = "all") {
  const state = skillsPicker, node = document.querySelector("#skills-picker");
  if (!state || state.projectId !== projectId) return;
  const known = new Set(state.skills.map(skill => skill.name)), count = role => state.skills.length - new Set([...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter(name => known.has(name))).size;
  document.querySelector("#skills-summary").textContent = `${state.skills.length} loaded · ${count("all")} on for every profile`;
  const dirty = JSON.stringify(state.draft) !== state.saved;
  if (part === "chrome" && node.querySelector(".skill-groups")) return patchPickerChrome(node, count, dirty);
  if (part === "list" && node.querySelector(".skill-groups")) { node.querySelector(".skill-groups").innerHTML = skillsListHtml(state); node.querySelector(".pick-note").innerHTML = skillsNote(state); return patchPickerChrome(node, count, dirty); }
  node.innerHTML = `${profileTabsHtml("skills-tab", state.tab, count, rolesShown(state))}
    <p class="note pick-note">${skillsNote(state)}</p>
    <div class="pick-tools"><input type="search" id="skills-search" placeholder="Search ${state.skills.length} skills" value="${esc(state.query)}" aria-label="Search skills">${bulkButtons("skills-select")}</div>
    <div class="skill-groups">${skillsListHtml(state)}</div>
    ${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row pick-actions"><button class="primary" data-action="skills-save" ${dirty ? "" : "disabled data-off"}>Save skills</button><button class="ghost" data-action="skills-reset" ${state.isDefault ? "disabled data-off" : ""}>Turn all on</button><small class="pick-state" ${dirty ? "" : "hidden"}>Unsaved changes</small></div>`;
}
const skillsNote = state => (state.tab === "all" ? "All installed skills are on, including ones installed later. Uncheck to switch one off for every profile." : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} uses every skill that is on. Uncheck to switch one off for this profile only.`) + (state.query.trim() ? ` Select all and Clear apply to the ${skillsShown(state).length} shown.` : "");
/** Bulk select or clear the skills currently shown (respecting search), optionally for one source. Inherited rows stay as they are. */
function bulkSkills(source, mode) {
  const state = skillsPicker, list = new Set(state.draft[state.tab]), inherited = new Set(state.tab === "all" ? [] : state.draft.all);
  for (const skill of skillsShown(state)) if ((!source || skill.source === source) && !inherited.has(skill.name)) { if (mode === "all") list.delete(skill.name); else list.add(skill.name); }
  state.draft[state.tab] = [...list].sort(); state.note = ""; renderSkillsPicker("list");
}
async function saveSkillsPicker(reset) {
  const state = skillsPicker, id = projectId;
  if (!state || state.projectId !== id) throw new Error("Reload Settings before saving skills");
  const settings = await api({ action: "settings-snapshot", id });
  try { await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { skills: reset ? null : { off: state.draft } } }, reset ? "All skills are on again." : "Skills saved. New threads use them; running threads keep theirs."); }
  catch (error) { state.note = error.message; renderSkillsPicker(); throw error; }
  await loadSkillsPicker(true);
}
document.addEventListener("change", event => {
  const box = event.target.closest("[data-skill-pick]");
  if (!box || !skillsPicker) return;
  const list = new Set(skillsPicker.draft[skillsPicker.tab]);
  if (box.checked) list.delete(box.dataset.skillPick); else list.add(box.dataset.skillPick);
  skillsPicker.draft[skillsPicker.tab] = [...list].sort();
  skillsPicker.note = ""; renderSkillsPicker("chrome");
});
document.addEventListener("input", event => {
  if (event.target.id !== "skills-search" || !skillsPicker) return;
  skillsPicker.query = event.target.value; renderSkillsPicker("list");
});

// MCP servers (Settings): same profile model as skills, plus a per-server "Allow writes". Servers come from the owner's mcp.json; env and arguments never reach the browser.
const mcpStatusText = { ready: "", disabled: "disabled in mcp.json", "needs-sign-in": "needs sign-in (not supported)", invalid: "invalid config" };
let mcpPicker = null;
async function loadMcpPicker(force = false) {
  const id = projectId, current = generation, node = document.querySelector("#mcp-picker");
  if (!id || !plan || !force && mcpPicker?.projectId === id) return;
  try {
    const [settings, catalog] = await Promise.all([api({ action: "settings-snapshot", id }), api({ action: "mcp-catalog", id })]);
    if (id !== projectId || current !== generation) return;
    const saved = { ...{ all: [], coordinator: [], worker: [], scout: [], reviewer: [] }, ...(settings.values.mcp?.off ?? {}), writes: settings.values.mcp?.writes ?? [] };
    mcpPicker = { projectId: id, catalog, isDefault: !settings.values.mcp, draft: sortedLists(saved), saved: JSON.stringify(sortedLists(saved)), tab: mcpPicker?.projectId === id ? mcpPicker.tab : "all", note: "", probes: {}, query: mcpPicker?.projectId === id ? mcpPicker.query : "" };
    renderMcpPicker();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">MCP unavailable: ${esc(error.message)}</p>`; }
}
const mcpShown = state => { const q = state.query.trim().toLowerCase(); return state.catalog.servers.filter(item => !q || item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)); };
function mcpListHtml(state) {
  const all = new Set(state.draft.all), picked = new Set(state.draft[state.tab]);
  const row = server => {
    const usable = server.status === "ready", inherited = state.tab !== "all" && all.has(server.name), probe = state.probes[server.name];
    return `<div class="skill-pick${inherited || !usable ? " inherited" : ""}"><input type="checkbox" data-mcp-pick="${esc(server.name)}" aria-label="Enable ${esc(server.name)}" ${usable && !inherited && !picked.has(server.name) ? "checked" : ""} ${inherited || !usable ? "disabled" : ""}><span><b>${esc(server.name)}</b>${inherited ? ' <small class="skill-tag">off for all profiles</small>' : ""}${usable ? "" : ` <small class="skill-tag">${esc(mcpStatusText[server.status] ?? server.status)}</small>`}<small>${esc(server.description)}</small>${usable ? `<span class="mcp-actions"><label class="check"><input type="checkbox" data-mcp-writes="${esc(server.name)}" ${state.draft.writes.includes(server.name) ? "checked" : ""}> Allow writes <small>(tools that change things; off = read-only)</small></label><span class="row"><button type="button" class="ghost small" data-action="mcp-test" data-server="${esc(server.name)}">Test</button>${probe ? `<small class="${probe.ok ? "" : "bad"}">${esc(probe.ok ? `${probe.tools} tools` : probe.error)}</small>` : ""}</span></span>` : ""}</span></div>`;
  };
  const shown = mcpShown(state);
  return shown.map(row).join("") || `<p class="note">${state.catalog.servers.length ? "No server matches." : `No servers in ${esc(state.catalog.path)}.`}</p>`;
}
const mcpNote = state => (state.tab === "all" ? "All servers in mcp.json are on, including ones added later. Uncheck to switch one off for every profile. Write tools stay blocked unless “Allow writes” is checked." : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} uses every server that is on. Uncheck to switch one off for this profile only.`) + (state.query.trim() ? ` Select all and Clear apply to the ${mcpShown(state).length} shown.` : "");
function renderMcpPicker(part = "all") {
  const state = mcpPicker, node = document.querySelector("#mcp-picker");
  if (!state || state.projectId !== projectId) return;
  const servers = state.catalog.servers, known = new Set(servers.map(item => item.name));
  const ready = servers.filter(item => item.status === "ready").length, count = role => ready - new Set([...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter(name => known.has(name) && servers.find(item => item.name === name).status === "ready")).size;
  document.querySelector("#mcp-summary").textContent = `${servers.length} in mcp.json · ${count("all")} on for every profile`;
  const dirty = JSON.stringify(state.draft) !== state.saved;
  if (part === "chrome" && node.querySelector(".skill-groups")) return patchPickerChrome(node, count, dirty);
  if (part === "list" && node.querySelector(".skill-groups")) { node.querySelector(".skill-groups").innerHTML = mcpListHtml(state); node.querySelector(".pick-note").innerHTML = mcpNote(state); return patchPickerChrome(node, count, dirty); }
  node.innerHTML = `${profileTabsHtml("mcp-tab", state.tab, count, rolesShown(state))}
    <p class="note pick-note">${mcpNote(state)}</p>
    ${servers.length ? `<div class="pick-tools"><input type="search" id="mcp-search" placeholder="Search ${servers.length} servers" value="${esc(state.query)}" aria-label="Search MCP servers">${bulkButtons("mcp-select")}</div>` : ""}
    <div class="skill-groups">${mcpListHtml(state)}</div>
    ${state.catalog.error ? `<p class="note bad">${esc(state.catalog.error)}</p>` : ""}${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row pick-actions"><button class="primary" data-action="mcp-save" ${dirty ? "" : "disabled data-off"}>Save MCP</button><button class="ghost" data-action="mcp-reset" ${state.isDefault ? "disabled data-off" : ""}>Turn all on</button><small class="pick-state" ${dirty ? "" : "hidden"}>Unsaved changes</small></div>`;
}
/** Bulk enable or clear the usable servers currently shown (respecting search). Inherited rows stay as they are. */
function bulkMcp(mode) {
  const state = mcpPicker, list = new Set(state.draft[state.tab]), inherited = new Set(state.tab === "all" ? [] : state.draft.all);
  for (const server of mcpShown(state)) if (server.status === "ready" && !inherited.has(server.name)) { if (mode === "all") list.delete(server.name); else list.add(server.name); }
  state.draft[state.tab] = [...list].sort(); state.note = ""; renderMcpPicker("list");
}
async function saveMcpPicker(reset) {
  const state = mcpPicker, id = projectId;
  if (!state || state.projectId !== id) throw new Error("Reload Settings before saving MCP");
  const settings = await api({ action: "settings-snapshot", id });
  try { await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { mcp: reset ? null : { off: { all: state.draft.all, coordinator: state.draft.coordinator, worker: state.draft.worker, scout: state.draft.scout, reviewer: state.draft.reviewer }, writes: state.draft.writes } } }, reset ? "MCP servers are on again, writes off." : "MCP saved. Applies to the next tool call."); }
  catch (error) { state.note = error.message; renderMcpPicker(); throw error; }
  await loadMcpPicker(true);
}
async function testMcpServer(server) {
  const state = mcpPicker; state.probes[server] = { ok: false, error: "Testing…" }; renderMcpPicker("list");
  state.probes[server] = await api({ action: "mcp-probe", id: projectId, server }); renderMcpPicker("list");
}
document.addEventListener("change", event => {
  const box = event.target.closest("[data-mcp-pick], [data-mcp-writes]");
  if (!box || !mcpPicker) return;
  const isPick = box.dataset.mcpPick !== undefined, key = isPick ? mcpPicker.tab : "writes", name = box.dataset.mcpPick ?? box.dataset.mcpWrites, list = new Set(mcpPicker.draft[key]);
  if (box.checked === !isPick) list.add(name); else list.delete(name);
  mcpPicker.draft[key] = [...list].sort();
  mcpPicker.note = ""; renderMcpPicker("chrome");
});
document.addEventListener("input", event => {
  if (event.target.id !== "mcp-search" || !mcpPicker) return;
  mcpPicker.query = event.target.value; renderMcpPicker("list");
});

// Advanced: per-project system prompt overrides. The textarea shows the effective prompt (the override, else the built-in text); Save stores an override, Reset returns to the built-in text.
const promptTitles = { coordinator: "Coordinator", worker: "Worker", scout: "Scout", reviewer: "Reviewer", verifier: "Verifier" };
let promptsState = null;
// Only the newest snapshot request may render, and none while a save is in flight: a snapshot read before Save or Reset must not bring back the old text.
let promptsSeq = 0, promptsSaving = 0;
// Opening Settings refetches (keepEdits): a tab left open across a host restart would otherwise keep showing the built-in text of the previous host. Unsaved edits stay in their editors.
async function loadPrompts(force = false, keepEdits = false) {
  const id = projectId, current = generation, node = document.querySelector("#prompts");
  if (!id || !plan || !force && promptsState?.projectId === id) return;
  const seq = ++promptsSeq, fresh = () => id === projectId && current === generation && seq === promptsSeq && !promptsSaving;
  try {
    const data = await api({ action: "prompts-snapshot", id });
    if (!fresh()) return;
    const edits = keepEdits && promptsState?.projectId === id ? promptsState.roles.flatMap(item => { const text = document.querySelector(`[data-prompt="${item.role}"]`)?.value; return text === undefined || text === item.effective ? [] : [[item.role, text]]; }) : [];
    promptsState = { projectId: id, roles: data.roles };
    renderPrompts();
    for (const [role, text] of edits) document.querySelector(`[data-prompt="${role}"]`).value = text;
  } catch (error) {
    if (!fresh()) return;
    // A failed refresh keeps the editors and their unsaved edits; the next opening of Settings retries.
    if (promptsState?.projectId === id && node.querySelector("[data-prompt]")) showPromptsError(`Prompts not refreshed: ${error.message}`);
    else node.innerHTML = `<p class="note">Prompts unavailable: ${esc(error.message)}</p>`;
  }
}
// Errors go below the editors without rebuilding them, so unsaved edits survive a failed refresh, Save or Reset; the next successful load clears them.
function showPromptsError(text) {
  const node = document.querySelector("#prompts");
  node.querySelector(".prompt-error")?.remove();
  node.insertAdjacentHTML("beforeend", `<p class="note bad prompt-error">${esc(text)}</p>`);
}
function renderPrompts() {
  const node = document.querySelector("#prompts");
  if (!promptsState || promptsState.projectId !== projectId) return;
  node.innerHTML = promptsState.roles.map(item => `<fieldset class="events-group prompt-role" data-role="${item.role}"><legend>${promptTitles[item.role]} ${item.override ? '<span class="skill-tag prompt-custom">Customized</span>' : '<small class="note">Default</small>'}</legend>
    <label class="field"><span class="sr-only">${promptTitles[item.role]} system prompt</span><textarea class="mono prompt-text" rows="8" maxlength="24000" data-prompt="${item.role}" aria-label="${promptTitles[item.role]} system prompt">${esc(item.effective)}</textarea></label>
    <div class="row pick-actions"><button class="primary" data-action="prompt-save" data-role="${item.role}">Save</button><button class="ghost" data-action="prompt-reset" data-role="${item.role}" ${item.override ? "" : "disabled data-off"}>Reset to default</button></div></fieldset>`).join("");
}
async function savePrompt(role, reset) {
  const id = projectId, item = promptsState?.roles.find(entry => entry.role === role);
  if (!item || promptsState.projectId !== id) throw new Error("Reload Settings before saving prompts");
  const text = document.querySelector(`[data-prompt="${role}"]`).value;
  promptsSaving++; promptsSeq++;
  try {
    const settings = await api({ action: "settings-snapshot", id });
    await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { prompts: { [role]: reset || !text.trim() || text === item.default ? null : text } } }, reset ? `${promptTitles[role]} prompt reset to default.` : `${promptTitles[role]} prompt saved. New turns and new worker threads use it.`);
  } catch (error) { if (id === projectId) showPromptsError(error.message); throw error; }
  finally { promptsSaving--; }
  await loadPrompts(true);
}
// Worktrees: the per-project setup command (run once in each new coding worktree) and safe cleanup with reclaimable size.
let worktrees = null;
const sizeText = kb => kb < 0 ? "size unknown" : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
async function loadWorktrees(force = false) {
  const id = projectId, current = generation, node = document.querySelector("#worktrees");
  if (!id || !plan || !force && worktrees?.projectId === id && worktrees.data) return;
  worktrees = { projectId: id, data: null, setup: "", revision: "" };
  try {
    const [data, settings] = await Promise.all([api({ action: "worktrees-snapshot", id }), api({ action: "settings-snapshot", id })]);
    if (id !== projectId || current !== generation) return;
    Object.assign(worktrees, { data, setup: settings.values.worktreeSetup ?? "", revision: settings.revision }); renderWorktrees();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">Worktrees unavailable: ${esc(error.message)}</p>`; }
}
function renderWorktrees() {
  const data = worktrees?.data, node = document.querySelector("#worktrees");
  if (!data) return;
  const removable = data.items.filter(item => item.removable);
  document.querySelector("#worktrees-summary").textContent = `${data.items.length} · ${sizeText(data.totalKb)} · ${sizeText(data.reclaimableKb)} reclaimable`;
  const setup = item => !item.setup ? "" : item.setup.ok ? `<span class="wt-setup ok">setup ok</span>` : `<details class="wt-setup bad"><summary>setup failed (exit ${esc(item.setup.exitCode)})</summary><pre>${esc(item.setup.output)}</pre></details>`;
  const row = item => `<li class="wt-row${item.removable ? " removable" : ""}"><b class="mono">${esc(item.path.split("/").at(-1))}</b> <span class="note">${esc(item.kind === "read-head" ? "PR-head snapshot" : item.branch ?? "")}</span> <span>${esc(item.provider && item.sizeKb < 0 ? item.mountLabel ?? "virtual mount" : sizeText(item.sizeKb))}</span> ${item.pullRequests.map(pr => `<span class="wt-pr ${esc(pr.state)}">#${esc(pr.number)} ${esc(pr.state)}</span>`).join(" ")} ${setup(item)} <span class="${item.removable ? "good" : "note"}">${item.removable ? "can be removed" : esc(item.reasons.join("; "))}</span></li>`;
  node.innerHTML = `<label class="field">Setup command <input id="worktree-setup" class="mono" maxlength="4000" placeholder="e.g. bun run worktree:setup" value="${esc(worktrees.setup)}"></label>
    <p class="note">Runs once with sh in each new coding worktree before the worker starts (15 min limit). The worker is told whether it failed.</p>
    <div class="row"><button data-action="worktree-setup-save">Save setup command</button></div>
    ${data.items.length ? `<ul id="worktree-list" class="fix-list">${data.items.map(row).join("")}</ul>` : '<p class="note">No worktrees.</p>'}
    <div class="row"><button class="primary" data-action="worktrees-cleanup" ${removable.length ? "" : "disabled"}>Clean up worktrees (${esc(sizeText(data.reclaimableKb))})</button><button class="ghost small" data-action="worktrees-refresh">Refresh</button></div>`;
}
async function saveWorktreeSetup() {
  const id = projectId, value = document.querySelector("#worktree-setup").value.trim();
  const settings = await api({ action: "settings-snapshot", id });
  await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { worktreeSetup: value } }, value ? "Setup command saved. New worktrees run it." : "Setup command removed.");
  await loadWorktrees(true);
}
async function cleanupWorktreesNow() {
  const id = projectId, result = await mutate({ action: "worktrees-cleanup", id, confirm: id }, "Cleaning up worktrees…");
  toast(`Removed ${result.removed.length} worktree(s), reclaimed ${sizeText(result.reclaimedKb)}${result.failed.length ? `; ${result.failed.length} could not be removed` : ""}.`);
  await loadWorktrees(true);
}

// Context and compaction (Settings): window override, auto-compact, threshold, keep-recent; applied live. "Compact now" also sits in the context ring.
let contextCard = null;
async function loadContextSettings(force = false) {
  const id = projectId, current = generation, node = document.querySelector("#context-settings");
  if (!id || !plan || !force && contextCard?.projectId === id) return;
  try {
    const settings = await api({ action: "settings-snapshot", id });
    if (id !== projectId || current !== generation) return;
    contextCard = { projectId: id, values: settings.values.context, revision: settings.revision }; renderContextSettings();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">Context settings unavailable: ${esc(error.message)}</p>`; }
}
function renderContextSettings() {
  const state = contextCard, node = document.querySelector("#context-settings");
  if (!state || state.projectId !== projectId) return;
  const v = state.values, catalog = view?.context?.catalogWindow ?? null, window = v?.contextWindow ?? catalog;
  const defaultPct = catalog ? Math.round((catalog - 16384 - 32768) / catalog * 100) : null;
  document.querySelector("#context-summary").textContent = `${window ? `${window.toLocaleString()} tokens` : "window unknown"} · ${v && !v.autoCompact ? "auto-compact off" : `compacts at ${v?.thresholdPercent ?? defaultPct ?? "?"}%`}`;
  node.innerHTML = `<div class="context-form">
    <label class="field">Context window (tokens) <input type="number" id="context-window" min="4096" max="10000000" step="1000" placeholder="${catalog ? `${catalog} (model default)` : "model default"}" value="${esc(v?.contextWindow ?? "")}"></label>
    <label class="check"><input type="checkbox" id="context-auto" ${!v || v.autoCompact ? "checked" : ""}> Compact automatically</label>
    <label class="field context-threshold">Compact at <output id="context-threshold-value"></output><input type="range" id="context-threshold" min="10" max="95" step="1" value="${esc(v?.thresholdPercent ?? defaultPct ?? 80)}" ${v?.thresholdPercent === undefined ? "data-default" : ""}></label>
    <label class="field">Keep recent (tokens) <input type="number" id="context-keep" min="1000" max="1000000" step="1000" placeholder="20000 (default)" value="${esc(v?.keepRecentTokens ?? "")}"></label>
  </div>
  <div class="row"><button class="primary" data-action="context-save">Save</button><button class="ghost" data-action="context-reset" ${v ? "" : "disabled"}>Reset to defaults</button><button class="ghost" data-action="compact-now">Compact this chat now</button></div>`;
  renderContextThreshold();
}
// Slider label: share and token count of the effective window; untouched it stays on the pi-durable default and is not saved.
function renderContextThreshold() {
  const slider = document.querySelector("#context-threshold"), output = document.querySelector("#context-threshold-value");
  if (!slider || !output) return;
  const typed = Number(document.querySelector("#context-window").value.trim()), window = typed > 0 ? typed : view?.context?.catalogWindow ?? null;
  slider.disabled = !document.querySelector("#context-auto").checked;
  output.textContent = `${slider.value}%${window ? ` · ${Math.floor(window * slider.value / 100).toLocaleString()} tokens` : ""}${slider.hasAttribute("data-default") ? " (default)" : ""}`;
}
document.addEventListener("input", event => {
  if (event.target.id === "context-threshold") event.target.removeAttribute("data-default");
  if (["context-threshold", "context-window", "context-auto"].includes(event.target.id)) renderContextThreshold();
});
async function saveContextSettings(reset) {
  const id = projectId, number = selector => { const raw = document.querySelector(selector).value.trim(); if (!raw) return undefined; const value = Number(raw); if (!Number.isSafeInteger(value)) throw new Error("Context settings must be whole numbers"); return value; };
  const slider = document.querySelector("#context-threshold"), threshold = slider.hasAttribute("data-default") ? undefined : Number(slider.value);
  const context = reset ? null : { autoCompact: document.querySelector("#context-auto").checked, ...Object.fromEntries([["contextWindow", number("#context-window")], ["thresholdPercent", threshold], ["keepRecentTokens", number("#context-keep")]].filter(([, value]) => value !== undefined)) };
  const settings = await api({ action: "settings-snapshot", id });
  await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { context } }, reset ? "Context settings reset to defaults." : "Context settings saved; they apply from the next step.");
  await loadContextSettings(true);
}
async function compactNow() {
  await mutate({ action: "compact", id: projectId, ...(chatId && chatId !== "main" ? { chatId } : {}) }, "Compacting this chat…");
}

// Events in: Follow PRs and the generic webhook (one card in Settings, rendered from automation-snapshot).
let eventsIn = null;
async function loadEventsIn(force = false) {
  const id = projectId, current = generation, node = document.querySelector("#events-in");
  if (!id || !plan || !force && eventsIn?.projectId === id) return;
  if (eventsIn?.projectId !== id) eventsIn = { projectId: id, data: null, reveal: false, rotateArmed: false };
  try { const data = await api({ action: "automation-snapshot", id }); if (id === projectId && current === generation) { eventsIn.data = data; renderEventsIn(); } }
  catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">Events unavailable: ${esc(error.message)}</p>`; }
}
const everyChoices = [[60000, "1 min"], [300000, "5 min"], [900000, "15 min"], [3600000, "1 hour"]];
function renderEventsIn() {
  const data = eventsIn?.data, node = document.querySelector("#events-in");
  if (!data) return;
  const f = data.follow, chats = (view?.chats ?? [{ id: "main", title: "Main" }]).filter(chat => !chat.archived || chat.id === data.eventChat);
  const ago = at => at ? when(at) : "never";
  const fixes = (f?.fixes ?? []).map(fix => `<li><b>${esc(fix.pr)}</b> ${fix.attempts.map((item, index) => `<span class="fix-attempt ${esc(item.status ?? (item.error ? "failed" : "none"))}" title="${esc(item.error ?? item.mode)}">${index + 1}: ${esc(item.sha.slice(0, 7))} · ${esc(item.mode === "none" ? "no scope" : item.status ?? (item.error ? "dispatch failed" : "pending"))}</span>`).join(" ")}</li>`).join("");
  const merges = (f?.merges ?? []).map(item => `<li class="merge-row"><b>${esc(item.pr)}</b> ${item.receipts.map(r => `<span class="merge-receipt ${esc(r.state)}" title="${esc(r.error ?? r.marker)}">${esc(r.sha.slice(0, 7))} · ${esc(r.state)}${r.mergeCommit ? ` → ${esc(r.mergeCommit.slice(0, 7))}` : ""}</span>`).join(" ")}${item.note ? `<span class="merge-note">${esc(mergeNoteText(item.note))}</span>` : ""}</li>`).join("");
  node.innerHTML = `<div class="events-in">
    <label class="field">Send events to <select id="event-chat">${chats.map(chat => `<option value="${esc(chat.id)}" ${chat.id === data.eventChat ? "selected" : ""}>${esc(chat.title)}${chat.archived ? " (archived, using Main)" : ""}</option>`).join("")}</select></label>
    <fieldset class="events-group"><legend>Follow PRs</legend>
      <p class="note">${data.githubRepositories.length ? `Repositories: ${esc(data.githubRepositories.join(", "))}. Opened, merged and closed PRs, CI results, reviews and comments (bots too). The first check records what exists without sending it.` : "Connect GitHub in Owner setup first."}</p>
      <label class="check"><input type="checkbox" id="follow-enabled" ${f?.enabled ? "checked" : ""}> Follow all PRs</label>
      <label class="field">Check every <select id="follow-every">${everyChoices.map(([ms, label]) => `<option value="${ms}" ${f?.everyMs === ms ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="follow-autofix" ${f?.autoFix ? "checked" : ""}> When CI fails on a PR this project opened, send a worker to fix it</label>
      <label class="field">Fix attempts per PR <input type="number" id="follow-cap" min="0" max="10" value="${esc(f?.fixCap ?? 3)}"></label>
      <div class="kv follow-status"><span>Last check</span><b id="follow-last">${esc(ago(f?.lastPollAtMs))}${f?.polling ? " · checking…" : ""}</b><span>Changes sent</span><b id="follow-events">${esc(f?.events ?? 0)}</b>${f?.lastError ? `<span>Problem</span><b id="follow-error" class="bad">${esc(f.lastError)}</b>` : ""}</div>
      ${fixes ? `<ul id="follow-fixes" class="fix-list">${fixes}</ul>` : ""}
      <div class="row"><button data-action="follow-poll" ${f?.enabled ? "" : "disabled"}>Check now</button></div>
    </fieldset>
    <fieldset class="events-group" id="auto-merge"><legend>Auto-merge</legend>
      <label class="check"><input type="checkbox" id="merge-enabled" ${f?.autoMerge ? "checked" : ""}> Merge PRs this project opened once CI and every required check pass and a reviewer worker approved that exact head</label>
      <p class="note">${f?.autoMerge && !f?.enabled ? "Turn on Follow PRs: auto-merge runs on its checks." : "Off by default. A reviewer is sent when CI turns green; a new push needs a new review. The merge pins the reviewed head (squash). Otherwise merges wait for your approval."}</p>
      ${merges ? `<ul id="merge-receipts" class="fix-list">${merges}</ul>` : ""}
    </fieldset>
    <fieldset class="events-group" id="watchdog"><legend>Worker watchdog</legend>
      <label class="check"><input type="checkbox" id="watchdog-enabled" ${data.watchdog?.enabled !== false ? "checked" : ""}> While workers run, each chat checks only the workers it started</label>
      <label class="field">Check every <select id="watchdog-every">${[[300000, "5 min"], [600000, "10 min"], [900000, "15 min"], [1800000, "30 min"], [3600000, "1 hour"]].concat([[data.watchdog?.everyMs, `${Math.round((data.watchdog?.everyMs ?? 0) / 60000)} min`]]).filter(([ms], index, all) => ms && all.findIndex(([other]) => other === ms) === index).map(([ms, label]) => `<option value="${ms}" ${data.watchdog?.everyMs === ms ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <p class="note">Each check sends the coordinator a short digest per running worker (runtime, recent tool calls, repeats, errors, tokens, changed files). It steers a looping worker once, then stops and redispatches it if it is still stuck. You hear about it only in the final report or when it needs you.</p>
      <div class="kv watchdog-status"><span>Last check</span><b id="watchdog-last">${esc(ago(data.watchdog?.lastTickAtMs))}</b><span>Checks</span><b id="watchdog-ticks">${esc(data.watchdog?.ticks ?? 0)}</b><span>Next</span><b id="watchdog-next">${data.watchdog?.nextAtMs ? esc(new Date(data.watchdog.nextAtMs).toLocaleTimeString()) : "when a worker runs"}</b>${data.watchdog?.lastError ? `<span>Problem</span><b class="bad">${esc(data.watchdog.lastError)}</b>` : ""}</div>
    </fieldset>
    <fieldset class="events-group"><legend>Webhook</legend>
      <label class="check"><input type="checkbox" id="webhook-enabled" ${data.webhook.enabled ? "checked" : ""}> Accept webhook deliveries</label>
      <div class="kv"><span>URL</span><code id="webhook-url" class="mono">${esc(data.webhook.url)}</code><span>Secret</span><code id="webhook-secret" class="mono">${eventsIn.reveal ? esc(data.webhook.secret) : "•".repeat(16)}</code></div>
      <div class="row"><button class="ghost small" data-action="webhook-reveal">${eventsIn.reveal ? "Hide" : "Reveal"} secret</button><button class="ghost small" data-action="webhook-copy" data-what="url">Copy URL</button><button class="ghost small" data-action="webhook-copy" data-what="secret">Copy secret</button><button class="small ${eventsIn.rotateArmed ? "danger" : "ghost"}" data-action="webhook-rotate">${eventsIn.rotateArmed ? "Confirm: rotate secret" : "Rotate secret"}</button></div>
      <p class="note">POST any body. Authenticate with <code>Authorization: Bearer &lt;secret&gt;</code> or <code>X-Hub-Signature-256: sha256=&lt;HMAC-SHA256 of the body&gt;</code>. <code>X-Event-Id</code> (or <code>X-GitHub-Delivery</code>) deduplicates retries; <code>X-Event-Type</code> names the event. Up to 1 MiB, 20 a minute.</p>
    </fieldset>
    <div class="row"><button class="primary" data-action="automation-save">Save</button></div>
  </div>`;
}
function mergeNoteText(note) { const [kind, , ...rest] = note.split(":"); return { merged: "merged", review: "waiting for review", changes: "reviewer requested changes", required: `required check missing: ${rest.join(":")}`, ci: "CI not green", refused: "refused by GitHub", uncertain: "outcome unknown, checking", grant: "authorization changed", target: "outside authorized base", ready: "draft could not be marked ready", "review-none": "reviewer gave no verdict" }[kind] ?? kind.replace(/^review-/, "reviewer "); }
async function saveEventsIn() {
  const value = selector => document.querySelector(selector);
  const cap = Number(value("#follow-cap").value);
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > 10) throw new Error("Fix attempts must be 0-10");
  const data = await mutate({ action: "automation-update", id: projectId, change: { eventChat: value("#event-chat").value, follow: { enabled: value("#follow-enabled").checked, everyMs: Number(value("#follow-every").value), autoFix: value("#follow-autofix").checked, fixCap: cap }, webhook: { enabled: value("#webhook-enabled").checked }, autoMerge: { enabled: value("#merge-enabled").checked }, watchdog: { enabled: value("#watchdog-enabled").checked, ...(Number(value("#watchdog-every").value) >= 60000 ? { everyMs: Number(value("#watchdog-every").value) } : {}) } } }, "Events settings saved.");
  eventsIn.data = data; renderEventsIn();
}

// Notifications (host-wide): browser notifications from the host notice feed while the owner is away from this tab, and the Telegram bot.
// Away = tab hidden or window not focused (another app in front keeps `visibilityState` "visible"). `notifyAway` also remembers that the
// owner was away since the last poll, so a backlog collected after a throttled/frozen or failing poll still notifies on return.
const notifyKey = "pi-projects-notify";
let notifyCursor, notifyTimer = null, notifyPolling = false, notifyAway = false, notifyProblem = "", notifyNote = "";
const notifyAwayNow = () => document.visibilityState === "hidden" || !document.hasFocus();
const noticeLabels = { question: "Question", approval: "Approval", review: "Review", result: "Finished", error: "Error", pr: "Pull request" };
function notifyEnabled() { return localStorage.getItem(notifyKey) === "1" && "Notification" in window && Notification.permission === "granted"; }
function renderNotify() {
  const box = document.querySelector("#notify-browser"), state = document.querySelector("#notify-browser-state");
  box.checked = notifyEnabled();
  state.textContent = !("Notification" in window) ? "This browser has no notifications." : Notification.permission === "denied" ? "Blocked by the browser. Allow notifications for this site, then turn this on." : !notifyEnabled() ? notifyNote || "Off." : notifyProblem ? `On, but not receiving notices: ${notifyProblem}` : "On. Shown while this tab is in the background or another app is in front; click one to open its chat. No notification? Send a test: if it does not appear, allow this browser in the system notification settings and check Focus.";
  state.classList.toggle("bad", Boolean(notifyEnabled() && notifyProblem));
  document.querySelector("#notify-test").disabled = !("Notification" in window) || Notification.permission !== "granted";
}
async function toggleNotify(on) {
  if (on && "Notification" in window) {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission === "granted") localStorage.setItem(notifyKey, "1"); else localStorage.removeItem(notifyKey);
    notifyNote = permission === "default" ? "Off. The permission prompt was dismissed or blocked quietly; allow notifications for this site (address bar, site settings), then turn this on." : "";
  } else { localStorage.removeItem(notifyKey); notifyNote = ""; }
  notifyCursor = undefined; window.__notifyCursor = undefined; notifyProblem = "";
  renderNotify(); scheduleNotify();
}
function scheduleNotify() { clearTimeout(notifyTimer); notifyTimer = notifyEnabled() ? setTimeout(() => void pollNotify(), notifyCursor === undefined ? 0 : changeStream?.up ? POLL_MS : 3000) : null; }
async function pollNotify() {
  if (!notifyEnabled() || notifyPolling) return;
  notifyPolling = true;
  try {
    // The first read only takes the cursor, so a reload never replays old notices.
    const feed = await api({ action: "notify-feed", ...(notifyCursor === undefined ? {} : { after: notifyCursor }) });
    if (!notifyEnabled()) return;
    const away = notifyAwayNow();
    if (notifyCursor !== undefined && (away || notifyAway)) for (const item of feed.items) showNotice(item);
    if (!away) notifyAway = false;
    notifyCursor = feed.seq; window.__notifyCursor = notifyCursor;
    if (notifyProblem) { notifyProblem = ""; renderNotify(); }
  } catch (error) {
    const message = error?.message ?? String(error);
    const next = /authenticate|401/.test(message) ? "this tab's session ended; reopen the inbox link (projects ui)" : message;
    if (next !== notifyProblem) { notifyProblem = next; renderNotify(); }
  } finally { notifyPolling = false; }
  scheduleNotify();
}
function testNotice() {
  const notice = new Notification("pi Projects · test", { body: "Test notification. Real ones look like this while this tab is in the background or another app is in front.", tag: "pi-projects-test" });
  notice.onclick = () => { window.focus(); notice.close(); };
}
function showNotice(item) {
  const body = `${noticeLabels[item.kind] ?? item.kind}: ${item.kind === "approval" ? item.title : item.text}`;
  const notice = new Notification(`${item.project} · ${item.chat}`, { body: body.length > 300 ? `${body.slice(0, 299)}…` : body, tag: `pi-projects-${item.seq}` });
  notice.onclick = () => {
    window.focus(); notice.close();
    setTab("coordinator");
    if (item.projectId !== projectId) changeProject(item.projectId, item.chatId); else changeChat(item.chatId);
  };
}
let telegramView = null, telegramError = "", telegramRemoveArmed = false, telegramTimer = null;
async function loadTelegram() {
  try { telegramView = await api({ action: "telegram-snapshot" }); } catch (error) { telegramError = error.message; }
  renderTelegram();
  clearTimeout(telegramTimer);
  if (tab === "settings") telegramTimer = setTimeout(() => void loadTelegram(), 2000);
}
function renderTelegram() {
  const node = document.querySelector("#telegram"), t = telegramView;
  if (!t) return;
  const typed = document.querySelector("#telegram-token")?.value ?? "", focused = document.activeElement?.id === "telegram-token";
  const bot = t.botUsername ? `@${t.botUsername}` : "the bot";
  const next = `<div class="telegram">
    <div class="row telegram-token"><input type="password" id="telegram-token" autocomplete="off" spellcheck="false" placeholder="${t.configured ? "Saved. Paste a new token to replace it" : "Bot token from @BotFather"}" aria-label="Telegram bot token"><button data-action="telegram-save">${t.configured ? "Replace token" : "Save token"}</button></div>
    <div class="kv"><span>Bot</span><b>${t.configured ? esc(bot) : "Not set"}</b><span>Owner chat</span><b>${t.paired ? `Paired with ${esc(t.owner)}` : "Not paired"}</b><span>Text goes to</span><b>${t.route?.name ? esc(t.route.name) : "Nothing picked (use /projects in Telegram)"}</b><span>Polling</span><b>${t.polling ? `on${t.lastPollAt ? ` · ${esc(when(t.lastPollAt))}` : ""}` : "off"}</b>${t.lastError ? `<span>Problem</span><b class="bad">${esc(t.lastError)}</b>` : ""}${telegramError ? `<span>Not saved</span><b class="bad">${esc(telegramError)}</b>` : ""}</div>
    ${t.pairing ? `<p class="pair-code">Send <code>/pair ${esc(t.pairing.code)}</code> to ${esc(bot)} in a private chat before ${esc(new Date(t.pairing.expiresAt).toLocaleTimeString())}. Only that chat will be heard.</p>` : ""}
    <div class="row">${t.configured ? `<button data-action="telegram-pair">${t.pairing ? "New code" : t.paired ? "Pair another chat" : "Pair my chat"}</button>` : ""}${t.paired ? `<button class="ghost small" data-action="telegram-unpair">Unpair</button>` : ""}${t.configured ? `<button class="small ${telegramRemoveArmed ? "danger" : "ghost"}" data-action="telegram-remove">${telegramRemoveArmed ? "Confirm: remove bot" : "Remove bot"}</button>` : ""}</div>
    <p class="note">One bot for this host. The token is kept in a private file on this machine and never shown again. Telegram gets questions (with answer buttons), approvals, results and errors; your text goes to the chat picked with /projects and /chats.</p>
  </div>`;
  if (node.dataset.html === next) return;
  node.innerHTML = next; node.dataset.html = next;
  const input = document.querySelector("#telegram-token"); input.value = typed; if (focused) input.focus();
}
async function telegramAction(input, done) {
  try { telegramView = await api(input); telegramError = ""; if (done) toast(done); }
  catch (error) { telegramError = error.message; }
  renderTelegram();
}

// Remote access (host-wide): relay state, device pairing by QR, paired devices with rename and revoke.
let remoteView = null, remoteDevices = [], remotePairing = null, remoteError = "", remoteRevokeArmed = null, remoteRenaming = null, remoteTimer = null;
async function loadRemote() {
  try {
    remoteView = await api({ action: "remote-status" });
    remoteDevices = remoteView.enabled ? await api({ action: "remote-devices" }) : [];
    remoteError = "";
  } catch (error) { remoteError = error.message; }
  if (remotePairing && remotePairing.expiresAt <= Date.now()) remotePairing = null;
  renderRemote();
  clearTimeout(remoteTimer);
  if (tab === "settings") remoteTimer = setTimeout(() => void loadRemote(), remotePairing ? 2000 : 10000);
}
const remoteConnection = { off: "Off", connecting: "Connecting to the relay…", connected: "Connected to the relay", error: "Relay unreachable" };
function renderRemote() {
  const node = document.querySelector("#remote"), r = remoteView;
  if (!r) { if (remoteError) node.innerHTML = `<p class="note bad">${esc(remoteError)}</p>`; return; }
  const typed = document.querySelector("#remote-rename")?.value, focused = document.activeElement?.id === "remote-rename";
  let next;
  if (!r.enabled) next = `<p class="note">Off for this host. To turn it on, deploy the relay (<code>relay/deploy/README.md</code>), then run <code>npm run projects -- remote enable https://relay.&lt;your-domain&gt;</code> on this Mac.</p>`;
  else {
    const qr = remotePairing && /^<svg[\s>]/.test(remotePairing.qrSvg) && !/<script|\bon\w+=/i.test(remotePairing.qrSvg) ? remotePairing.qrSvg : "";
    const devices = remoteDevices.filter(device => !device.revokedAt);
    // Pairing and device management stay on the host itself (web.ts LOCAL_ONLY); a paired device only sees the list.
    const local = document.documentElement.dataset.remoteHost === undefined;
    next = `<div class="remote">
      <div class="kv"><span>Relay</span><b>${esc(r.relay)}</b><span>Connection</span><b class="remote-state" data-state="${esc(r.connection)}">${esc(remoteConnection[r.connection] ?? r.connection)}${r.connection === "error" && r.lastError ? ` · ${esc(r.lastError)}` : ""}</b><span>Host</span><b>${esc(r.hostName)} <code class="remote-id">${esc(r.hostId)}</code></b><span>App fingerprint</span><b><code class="remote-id">${esc(r.fingerprint ?? "unknown")}</code></b></div>
      ${remotePairing ? `<div class="remote-pair">${qr ? `<div class="remote-qr" aria-label="Pairing QR code">${qr}</div>` : ""}<div><p>Scan with the device's camera, or open the link on it. It works once, until ${esc(new Date(remotePairing.expiresAt).toLocaleTimeString())}.</p><p class="pair-code"><code>${esc(remotePairing.link)}</code></p><div class="row"><button class="small" data-action="remote-copy-link">Copy link</button><button class="ghost small" data-action="remote-pair-cancel">Cancel</button></div></div></div>` : local ? `<div class="row"><button data-action="remote-pair">Pair a device</button></div>` : `<p class="note">Pair, rename and revoke devices in the inbox on this host.</p>`}
      <h3 class="card-title">Devices</h3>
      ${devices.length ? `<div class="remote-devices">${devices.map(device => `<div class="remote-device">
        <span class="remote-dot" data-online="${device.online ? "1" : "0"}" title="${device.online ? "Connected now" : "Not connected"}"></span>
        ${remoteRenaming === device.id ? `<span class="row remote-name"><input id="remote-rename" maxlength="80" value="${esc(device.name)}" aria-label="Device name"><button class="small" data-action="remote-rename-save" data-device="${esc(device.id)}">Save</button><button class="ghost small" data-action="remote-rename-cancel">Cancel</button></span>` : `<b class="remote-name">${esc(device.name)}</b>`}
        <span class="note">Paired ${esc(ago(device.pairedAt))} · seen ${device.lastSeenAt ? esc(ago(device.lastSeenAt)) : "never"}${device.push ? " · notifications on" : ""}</span>
        ${local ? `<span class="row remote-actions">${remoteRenaming === device.id ? "" : `<button class="ghost small" data-action="remote-rename" data-device="${esc(device.id)}">Rename</button>`}<button class="${remoteRevokeArmed === device.id ? "danger" : "ghost"} small" data-action="remote-revoke" data-device="${esc(device.id)}">${remoteRevokeArmed === device.id ? "Revoke now" : "Revoke"}</button></span>` : ""}</div>`).join("")}</div>` : `<p class="note">No paired devices.</p>`}
      ${remoteError ? `<p class="note bad">${esc(remoteError)}</p>` : ""}
      <p class="note">A revoked device is cut off at once. Compare the app fingerprint with the one shown on your phone when the app warns that it changed.</p>
    </div>`;
  }
  if (node.dataset.html === next) return;
  node.innerHTML = next; node.dataset.html = next;
  const input = document.querySelector("#remote-rename");
  if (input) { if (typed !== undefined) input.value = typed; if (focused || typed === undefined) input.focus(); }
}
async function remoteAction(input, done) {
  try { const result = await api(input); remoteError = ""; if (done) toast(done); return result; }
  catch (error) { remoteError = error.message; renderRemote(); return null; }
}
// Inside the remote app, name the host this inbox belongs to and link back to the host list.
function renderRemoteHost() {
  const name = document.documentElement.dataset.remoteHost;
  if (name === undefined) return;
  document.querySelector(".brand .local").textContent = name || "REMOTE";
  document.querySelector("#remote-hosts").hidden = false;
}
document.addEventListener("pi-remote-host", renderRemoteHost); renderRemoteHost();
document.querySelector("#notify-browser").addEventListener("change", event => void toggleNotify(event.target.checked));
// Appearance (per browser). /theme.js applies it before first paint and tracks the OS setting for System.
const renderTheme = () => { for (const radio of document.querySelectorAll("#appearance-card input[name=theme]")) radio.checked = radio.value === window.piTheme.get(); };
document.querySelector("#appearance-card").addEventListener("change", event => { window.piTheme.set(event.target.value); renderTheme(); });
window.addEventListener("storage", renderTheme); renderTheme();
document.querySelector("#notify-test").addEventListener("click", testNotice);
// Leaving marks the owner away; coming back polls at once, so the backlog notifies before `notifyAway` is cleared.
const markAway = () => { notifyAway = true; };
const backAgain = () => { if (!notifyAwayNow() && notifyEnabled()) { clearTimeout(notifyTimer); notifyTimer = setTimeout(() => void pollNotify(), 0); } };
addEventListener("blur", markAway); document.addEventListener("freeze", markAway); addEventListener("pagehide", markAway);
addEventListener("focus", backAgain);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") markAway(); else backAgain(); });
renderNotify(); scheduleNotify();

async function loadAutomationStrip() {
  const id = projectId, current = generation, node = document.querySelector("#automation-history");
  if (!id || !plan || node.dataset.project === id && node.dataset.loaded === "true") return;
  node.dataset.project = id; node.dataset.loaded = "loading";
  try {
    const page = await api({ action: "schedule-history", id, kind: "intents", offset: 0, limit: 5, textOffset: 0, textLimit: 500 });
    if (id !== projectId || current !== generation || tab !== "settings") return;
    if (!Array.isArray(page.items) || !Array.isArray(page.routines)) throw new Error("Invalid automation history page");
    node.innerHTML = page.routines.length ? page.routines.map(routine => `<article class="automation-run"><b>${esc(routine.routineId)}</b><div class="run-dots" aria-label="Recent routine outcomes">${routine.recentRuns.map(run => `<span class="run-dot ${esc(run.outcome)}" title="${esc(run.outcome)} · ${esc(new Date(run.at).toLocaleString())}" aria-label="${esc(run.outcome)}"></span>`).join("")}</div></article>`).join("") : '<p class="note">No automation runs recorded.</p>';
    node.dataset.loaded = "true";
  } catch (error) { if (id === projectId && current === generation) { node.innerHTML = `<p class="note">History unavailable: ${esc(error.message)}</p>`; node.dataset.loaded = "false"; } }
}

async function loadUsage() {
  if (!plan || usageLoading) return;
  const id = projectId, current = generation;
  usageLoading = true;
  try {
    const page = await api({ action: "usage-snapshot", id, offset: 0, limit: 100 });
    if (id !== projectId || current !== generation) return;
    if (!page?.coordinator?.total || !Array.isArray(page.workers) || page.offset !== 0) throw new Error("Usage projection differs from its owned conversation/page");
    usageObs = { at: Date.now(), page };
    setHtml("#obs-usage", usageHtml());
    renderUsageBuckets();
  } catch (error) { if (id === projectId && current === generation) { usageObs = { at: Date.now(), error: error.message }; setHtml("#obs-usage", usageHtml()); } }
  finally { usageLoading = false; }
}
function usageHtml() {
  if (!plan) return '<p class="note">Usage counters require a Durable project.</p>';
  if (!usageObs) return '<p class="note">Reading SDK conversation counters…</p>';
  if (usageObs.error) return `<p class="note">Usage unavailable: ${esc(usageObs.error)}</p>`;
  const { page } = usageObs, money = value => `$${Number(value).toFixed(2)}`, tokens = value => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  const rows = [...usageChatRows(page).map(row => ({ label: row.label, total: row.value.total })), ...page.workers.map(worker => {
    if (worker.kind !== "thread") return { label: `Legacy ${worker.name}`, total: worker.total };
    const matching = plan?.work.filter(item => item.threadId === worker.threadId) ?? [];
    const latest = matching.at(-1);
    return { label: latest ? `${latest.role}: ${latest.text.slice(0, 72)}` : `Thread ${worker.threadId.slice(0, 8)}`, total: worker.total };
  })];
  const max = Math.max(...rows.map(row => row.total.totalTokens), 1);
  const cost = rows.reduce((sum, row) => sum + row.total.cost.total, 0), all = rows.reduce((sum, row) => sum + row.total.totalTokens, 0);
  return `<div class="usage-head"><div><b>${tokens(all)}</b><small>tokens</small></div><div><b>${money(cost)}</b><small>SDK estimate</small></div><div><b>${1 + (page.chats?.length ?? 0)}</b><small>chats</small></div><div><b>${page.totalWorkers}</b><small>worker conversations</small></div></div>${rows.map(row => `<div class="hbar"><span title="${esc(row.label)}">${esc(row.label)}</span><progress max="${max}" value="${row.total.totalTokens}"></progress><small class="mono">${tokens(row.total.totalTokens)} · ${money(row.total.cost.total)}</small></div>`).join("")}<p class="note">${page.nextOffset !== null ? "First 100 workers only. " : ""}Estimates are not billing. Observed ${esc(new Date(page.observedAtMs ?? usageObs.at).toLocaleTimeString())}.</p>`;
}

// Main is the root coordinator conversation; every other chat is counted too.
function usageChatRows(page) {
  const main = view?.chats?.find(chat => chat.id === "main")?.title ?? "Main";
  return [{ label: `Chat · ${main}`, value: page.coordinator }, ...(page.chats ?? []).map(chat => ({ label: `Chat · ${chat.title}${chat.archived ? " (archived)" : ""}`, value: chat }))];
}
async function loadObservability() {
  if (!plan || observabilityLoading) return;
  const id = projectId, current = generation;
  observabilityLoading = true;
  try {
    const [events, health, histories] = await Promise.all([
      api({ action: "event-log", id, offset: eventOffset, limit: 20 }),
      api({ action: "host-health", id }),
      Promise.all([...new Set(plan.work.map(item => item.threadId))].map(threadId => api({ action: "thread-history", id, threadId, offset: 0, limit: 100, textOffset: 0, textLimit: 1 })))
    ]);
    if (id !== projectId || current !== generation || tab !== "observability") return;
    if (!Array.isArray(events.events) || !Number.isSafeInteger(events.total) || typeof health.uptimeMs !== "number") throw new Error("Invalid observability response");
    observability = { events, health, tools: histories.flatMap(page => page.items.filter(item => item.kind === "tool").map(item => ({ ...item, threadId: page.threadId }))) };
    renderHealth(view.project);
    renderEventLog();
    renderUsageBuckets();
    renderPanels();
  } catch (error) {
    if (id === projectId && current === generation) {
      setHtml("#obs-event-log", `<p class="note">Event log unavailable: ${esc(error.message)}</p>`);
      setHtml("#obs-usage-time", `<p class="note">Usage history unavailable: ${esc(error.message)}</p>`);
    }
  } finally { observabilityLoading = false; }
}
function renderHealth(project) {
  const h = observability?.health;
  const values = [["Host", document.querySelector("#connection").textContent.split(" · ")[0]], ["Runtime", project.runtime], ["Coordinator", (view.chats ?? []).some(chat => chat.busy) || view.busy ? `busy${(view.chats?.length ?? 0) > 1 ? ` · ${view.chats.filter(chat => chat.busy).length}/${view.chats.length} chats` : ""}` : "idle"], ["Project", project.deleted ? "deleted" : project.archived ? "archived" : plan?.pausing ? "pausing" : view.paused ? "paused" : project.phase === "attention" ? "needs attention" : "ready"], ["Uptime", h ? duration(h.uptimeMs) : "Reading…"], ["Queue depth", h ? (h.queue?.queued ?? 0) + (h.queue?.running ?? 0) : "Reading…"], ["Leases", h?.activeLeases ?? "—"], ["Project locks", h?.activeLocks ?? "—"], ["Mac awake", h?.macAwake === null ? "Unknown" : h?.macAwake ?? "Reading…"], ["Failed jobs", view.failedJobs ?? view.jobs.filter(job => ["failed", "interrupted"].includes(job.state)).length], ["Evidence", view.evidence.length]];
  setHtml("#obs-health", `<div class="health">${values.map(([label, value]) => `<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join("")}</div>`);
}
function renderEventLog() {
  const events = observability?.events;
  if (!events) return;
  setHtml("#obs-event-log", `<p class="note">Newest first · ${events.total} events</p><div class="row">${eventOffset ? '<button data-action="event-page" data-offset="0">Newest</button><button data-action="event-page" data-offset="-20">Newer</button>' : ""}${eventOffset + events.events.length < events.total ? '<button data-action="event-page" data-offset="20">Older</button>' : ""}</div>${events.events.length ? events.events.map(event => `<article class="event-row"><b>${esc(event.kind ?? event.type ?? "Event")}</b><small>${esc(event.source ?? "")}${event.at ? ` · ${esc(new Date(event.at).toLocaleString())}` : ""}</small>${event.detail ? `<span class="mono">${esc(String(event.detail).replace(/:[0-9a-f-]{36}$/i, ""))}</span>` : ""}</article>`).join("") : '<p class="note">No events recorded.</p>'}`);
}
function renderUsageBuckets() {
  const target = document.querySelector("#obs-usage-time");
  const rows = [...(usageObs?.page ? usageChatRows(usageObs.page) : []), ...(usageObs?.page?.workers ?? []).map(worker => ({ label: worker.title ?? worker.role ?? worker.name ?? "Worker", value: worker }))];
  if (!rows.length || usageObs?.error) { if (usageObs?.error) setHtml("#obs-usage-time", `<p class="note">Usage over time unavailable: ${esc(usageObs.error)}</p>`); return; }
  const buckets = rows.flatMap(row => ["hourly", "daily"].flatMap(period => (row.value?.timeBuckets?.[period] ?? []).map(bucket => ({ ...bucket, period, label: row.label }))));
  const max = Math.max(1, ...buckets.map(bucket => bucket.totalTokens ?? 0));
  target.innerHTML = buckets.length ? `<div class="usage-bars">${buckets.slice(-60).map(bucket => `<div class="usage-bar-row"><small>${esc(bucket.label)} · ${esc(bucket.period)} ${esc(new Date(bucket.at).toLocaleString())}</small><progress max="${max}" value="${Number(bucket.totalTokens) || 0}"></progress><b>${Number(bucket.totalTokens) || 0} tokens</b></div>`).join("")}</div>` : '<p class="note">No time-bucketed usage recorded.</p>';
}

function toolArgs(call) { try { const args = JSON.parse(call.argsPreview ?? ""); return args && typeof args === "object" ? args : {}; } catch { return {}; } }
function toolLabel(call) {
  const a = toolArgs(call), path = a.path ?? a.file ?? a.filePath ?? "";
  const labels = {
    projects_delegate: () => `Delegated to ${a.role ?? "a worker"}${a.task ? `: ${a.task}` : ""}`,
    projects_worker_archive: () => "Archived finished work",
    projects_worker_control: () => `${a.operation ? a.operation[0].toUpperCase() + a.operation.slice(1) : "Controlled"} worker`,
    projects_control: () => `${a.operation ? a.operation[0].toUpperCase() + a.operation.slice(1) : "Controlled"} worker`,
    projects_workers: () => "Checked workers", projects_worker_plan: () => "Checked the plan", projects_worker_read: () => "Read a worker result",
    projects_question: () => `Asked you${a.question ? `: ${a.question.split("\n")[0]}` : ""}`,
    projects_knowledge_write: () => `Updated knowledge ${path}`, projects_knowledge_read: () => `Read knowledge ${path}`,
    projects_knowledge_list: () => "Listed knowledge", projects_knowledge_history: () => `Read history of ${path}`,
    projects_note: () => "Added a note", projects_notes: () => "Read notes", projects_evidence: () => `Attached evidence${a.title ? `: ${a.title}` : ""}`,
    projects_library_list: () => "Listed the library", projects_library_read: () => "Read from the library",
    projects_search: () => `Searched knowledge${a.query ? ` for “${a.query}”` : ""}`, projects_upload_list: () => "Listed uploads", projects_upload_read: () => `Read upload ${view?.uploads?.find(item => item.id === a.uploadId)?.filename ?? ""}`.trim(),
    projects_workspace_catalog: () => "Checked workspaces", projects_skill_read: () => `Read skill ${a.name ?? ""}`,
    projects_skill_file: () => `Read skill file ${a.skill ?? ""}/${a.path ?? "SKILL.md"}`,
    projects_github_issue_read: () => `Read GitHub #${a.number ?? ""}`,
    projects_github_issues: () => a.query ? `Searched GitHub for “${a.query}”` : `Listed GitHub ${a.kind === "pr" ? "PRs" : "issues"}`,
    projects_github_issue_write: () => ({ create: `Created GitHub issue “${a.title ?? ""}”`, comment: `Commented on GitHub #${a.number}`, update: `Updated GitHub #${a.number}`, close: `Closed GitHub #${a.number}`, reopen: `Reopened GitHub #${a.number}` })[a.action] ?? "Changed a GitHub issue",
    code_read: () => `Read ${path}`, read: () => `Read ${path}`, code_grep: () => `Searched for “${a.pattern ?? ""}”`, grep: () => `Searched for “${a.pattern ?? ""}”`,
    code_find: () => `Found files ${a.pattern ?? a.glob ?? ""}`, find: () => `Found files ${a.pattern ?? ""}`, code_ls: () => `Listed ${path || "."}`, ls: () => `Listed ${path || "."}`,
    bash: () => `Ran ${a.command ?? "a command"}`, edit: () => `Edited ${path}`, write: () => `Wrote ${path}`,
  };
  return (labels[call.name]?.() ?? call.name ?? "Tool call").replace(/\s+/g, " ").trim();
}
function toolCallHtml(call) {
  const status = ["ok", "error"].includes(call.status) ? call.status : "pending";
  const icon = status === "ok" ? "✓" : status === "error" ? "✕" : "…";
  return `<details class="tool-call" data-status="${status}"><summary title="${esc(call.name)}"><span class="tool-icon" aria-label="${status}">${icon}</span><span class="tool-label">${esc(toolLabel(call))}</span>${status === "error" ? '<span class="tool-failed">failed</span>' : ""}</summary><pre>${esc(call.name)}\nArgs: ${esc(String(call.argsPreview ?? "").slice(0, 500))}\nResult: ${esc(String(call.resultPreview ?? "").slice(0, 500))}</pre></details>`;
}
function when(at) {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
// Mirrors the report text built in src/durable-planning.ts; anything else stays a plain message.
const reportPattern = /^\[Durable work ([0-9a-f-]{36}), ([\w-]+), ([\w-]+); thread ([0-9a-f-]{36})\]\nTask: ([\s\S]*?)\nWorker result, untrusted and not verification evidence:\n([\s\S]*?)(?:\nSummarize the result for the user[\s\S]*)?$/;
function reportHtml(message, match) {
  const [, , role, status, threadId, task, body] = match;
  const known = plan?.work.some(work => work.threadId === threadId);
  return `<details class="report ${esc(status)}"${indexAttr(message)}><summary><span class="dot"></span><b>${esc(role[0].toUpperCase() + role.slice(1))} report</b><span class="report-status">${esc(status)}</span><span class="report-task">${esc(clip(task.replace(/\s+/g, " ").trim(), 120))}</span><small>${esc(when(message.at))}</small></summary><div class="report-body text">${renderMarkdown(body)}${known ? `<button class="ghost small" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(threadId)}">Open ${esc(role)} thread ↗</button>` : ""}</div></details>`;
}
// Events from Follow PRs, the webhook or the event API arrive as owner input; show them as a card, not as the owner speaking.
function eventHtml(message, kind, body) {
  const github = kind.endsWith(".follow"), hook = kind.startsWith("webhook.");
  if (kind === "worker.watchdog") { const workers = (body.match(/^- \w+ thread /gm) ?? []).length; return `<details class="report event-card watchdog" data-kind="worker.watchdog"${indexAttr(message)}><summary><span class="event-mark">⏱</span><b>Watchdog check</b><span class="report-task">${workers} running worker${workers === 1 ? "" : "s"}</span><small>${esc(when(message.at))}</small></summary><div class="report-body text"><pre class="mono">${esc(body)}</pre></div></details>`; }
  const changes = github ? (body.match(/^- /gm) ?? []).length : 0;
  const title = github ? (kind === "github.follow" ? "GitHub activity" : `${providerLabels[kind.slice(0, -7)] ?? kind.slice(0, -7)} activity`) : hook ? `Webhook · ${kind.slice(8)}` : `Event · ${kind}`;
  // Webhook bodies follow a fixed preamble line; summarize the body itself.
  const summary = github ? `${changes} change${changes === 1 ? "" : "s"}${/auto-fix (dispatched|sent)/.test(body) ? " · auto-fix sent" : ""}` : clip((hook ? body.slice(body.indexOf("\n\n") + 2) : body).replace(/\s+/g, " ").trim(), 120);
  return `<details class="report event-card ${github ? "github" : hook ? "webhook" : "event"}" data-kind="${esc(kind)}"${indexAttr(message)}><summary><span class="event-mark">${github ? "PR" : hook ? "↯" : "•"}</span><b>${esc(title)}</b><span class="report-task">${esc(summary)}</span><small>${esc(when(message.at))}</small></summary><div class="report-body text">${renderMarkdown(body)}</div></details>`;
}
function indexAttr(message) { return Number.isInteger(message.index) ? ` data-index="${message.index}"` : ""; }
function chatMessageHtml(message, assistant) {
  if (message.kind === "compaction") return `<div class="compaction-divider" role="separator" aria-label="Context compacted"${indexAttr(message)} title="${esc(when(message.at))}"><span>Context compacted</span></div>`;
  if (message.kind === "tool" || message.role === "tool") return toolCallHtml(message);
  const thought = message.thinking ? `<p class="thought" title="${esc(thoughtText(message.thinking))}"><span class="thought-mark">Thought</span>${esc(thoughtText(message.thinking))}</p>` : "";
  if (!message.text?.trim()) return thought;
  const report = message.role === "user" && reportPattern.exec(message.text);
  if (report) return reportHtml(message, report);
  const event = message.role === "user" && /^\[Owner-local event ([\w.-]+)\]\n([\s\S]*)$/.exec(message.text);
  if (event) return eventHtml(message, event[1], event[2]);
  const label = message.role === "user" ? "You" : message.role === "assistant" ? assistant : message.role;
  // Owner references (/skill:, @…, #PR) render inline as clickable chips; the host's appended blocks are stripped from the bubble.
  const user = message.role === "user";
  const attached = user ? attachmentChips(message.text) : { text: message.text, chips: "" };
  const prs = user ? prChips(attached.text) : { text: attached.text, chips: "", urls: new Map() };
  const refs = user ? refsSplit(prs.text) : { text: prs.text, gone: new Map() };
  const body = renderMarkdown(refs.text, { refs: { prs: prs.urls, gone: refs.gone } }) + prs.chips + attached.chips;
  return `${thought}<article class="msg ${message.role === "user" ? "you" : "them"}"${indexAttr(message)}><div class="who">${esc(label)} <small class="inline">${esc(when(message.at))}</small></div><div class="text">${body}</div>${message.nextTextOffset != null ? `<p class="note">Text continues at character ${message.nextTextOffset}; use the next text slice.</p>` : ""}</article>`;
}
const skillIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>';
// Pi-style commands: a whole composer message "/name [argument]" runs here instead of reaching the coordinator.
const chatArgs = () => chatId === "main" ? {} : { chatId };
const slashCommands = [
  { name: "new", description: "Clear this chat's context; earlier messages stay stored", run: () => mutate({ action: "chat-reset", id: projectId, ...chatArgs() }, "New context started.") },
  { name: "reload", description: "Reload skills, instructions and tools for this chat", run: () => mutate({ action: "chat-reload", id: projectId, ...chatArgs() }, result => result.changed ? `Reloaded: ${result.skills} skill${result.skills === 1 ? "" : "s"} for this chat; prompt and tools updated.` : `Already up to date (${result.skills} skill${result.skills === 1 ? "" : "s"}).`) },
  { name: "compact", description: "Compact this chat's context now", run: compactNow },
  { name: "name", description: "Rename this chat", argument: "<title>", run: async title => {
    if (!title) return document.querySelector('#chat-bar [data-action="chat-rename"]')?.click();
    await mutate({ action: "chat-update", id: projectId, chatId, title: title.slice(0, 120) }, "Chat renamed.");
  } },
  { name: "resume", description: "Switch to another chat", run: chatPickerDialog },
  { name: "session", description: "Show this chat's model, context and usage", run: sessionDialog },
  { name: "copy", description: "Copy the last reply to the clipboard", run: async () => {
    const reply = view?.messages.findLast(message => message.role === "assistant" && message.text?.trim());
    if (!reply) throw new Error("No reply to copy yet");
    await navigator.clipboard.writeText(reply.text); toast("Last reply copied.");
  } },
  { name: "settings", description: "Open project settings", run: () => settingsList() },
];
function slashCommand(text) {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = match && slashCommands.find(item => item.name === match[1]);
  return command ? { command, argument: match[2]?.trim() ?? "" } : null;
}
function chatPickerDialog() {
  const chats = view?.chats ?? [];
  showDialog("Resume a chat", chats.map(chat => `<button type="button" class="ghost" data-action="chat-select" data-chat="${esc(chat.id)}" ${chat.id === chatId ? "disabled" : ""}>${esc(chat.title)}${chat.archived ? " (archived)" : ""}${chat.busy ? " · working" : ""}</button>`).join("") || '<p class="note">No chats yet.</p>');
}
async function sessionDialog() {
  const id = projectId, chat = currentChat(), context = view?.context;
  const version = showDialog("Session", '<p class="note">Reading usage…</p>', chat?.title ?? "Main");
  const page = await api({ action: "usage-snapshot", id, offset: 0, limit: 1 });
  if (!dialog.open || version !== dialogVersion || id !== projectId) return;
  const usage = chatId === "main" ? page.coordinator : page.chats?.find(item => item.chatId === chatId);
  const rows = [["Chat", chat?.title ?? "Main"], ["Chat ID", chatId], ["Conversation", chat?.conversationId ?? "—"], ["Model", view.project.model], ["Context", context?.window ? `${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens` : "unknown"], ["Messages shown", view.messages.length], ["Tokens used", usage ? usage.total.totalTokens.toLocaleString() : "—"], ["Cost (SDK estimate)", usage ? `$${usage.total.cost.total.toFixed(2)}` : "—"]];
  setDialogBody(`<div class="kv">${rows.map(([key, value]) => `<span>${esc(key)}</span><b>${esc(value)}</b>`).join("")}</div>`);
}
// "/" picker in the coordinator composer: commands (at the start of the message), then skills.
let skillCatalog = null, skillMenu = null, prMenu = null, refMenu = null;
async function loadSkills() {
  const id = projectId;
  // The host rebuilds the catalog from disk on every request, so a skill installed a moment ago shows up; keystrokes within a couple of seconds share one answer.
  if (skillCatalog?.projectId === id && Date.now() - skillCatalog.at < 2000) return skillCatalog.skills;
  const { skills } = await api({ action: "coordinator-skills", id });
  if (id === projectId) skillCatalog = { projectId: id, skills, at: Date.now() };
  return skills;
}
// Inline triggers anywhere in the text: "/" skills, "@" issues/docs/uploads/files, "#" PRs. A trigger counts at the start or after whitespace or an opening bracket.
const triggerBefore = (textarea, pattern) => textarea.selectionStart === textarea.selectionEnd ? pattern.exec(textarea.value.slice(0, textarea.selectionStart)) : null;
function skillQuery(textarea) {
  const match = triggerBefore(textarea, /(^|[\s(\[])\/(?:skill:)?([\w.-]*)$/);
  return match ? { query: match[2], atStart: match.index + match[1].length === 0 } : null;
}
function rankSkills(skills, query) {
  const q = query.toLowerCase();
  if (!q) return skills;
  return skills.map(skill => [Math.max(fuzzyScore(q, skill.name) * 1.5 + (skill.name.toLowerCase().startsWith(q) ? 40 : 0), fuzzyScore(q, skill.description) * 0.4), skill]).filter(([score]) => score > 0).sort((a, b) => b[0] - a[0]).map(([, skill]) => skill);
}
/** Cursor-style fuzzy match: query characters in order; consecutive runs and word/path-segment starts score high, late and long targets lower. -1 when not a subsequence. */
function fuzzyScore(query, target) {
  const text = String(target ?? ""), lower = text.toLowerCase();
  let from = 0, score = 0, previous = -2, first = -1;
  for (const char of query) {
    const at = lower.indexOf(char, from);
    if (at < 0) return -1;
    if (first < 0) first = at;
    const boundary = at === 0 || /[\s/\\._:#-]/.test(lower[at - 1]) || (text[at] !== lower[at] && text[at - 1] === lower[at - 1]);
    score += 1 + (at === previous + 1 ? 6 : 0) + (boundary ? 8 : 0);
    previous = at; from = at + 1;
  }
  return score + 10 - Math.min(first, 40) * 0.25 - Math.min(lower.length, 200) * 0.02;
}
function closeSkillMenu() { skillMenu = null; prMenu = null; refMenu = null; const node = document.querySelector("#skill-menu"); if (node) { node.hidden = true; node.innerHTML = ""; } document.querySelector("#compose textarea")?.removeAttribute("aria-activedescendant"); }
async function updateSkillMenu(textarea) {
  renderBackdrop(textarea);
  const found = skillQuery(textarea);
  if (!found) { if (!(await updateRefMenu(textarea))) updatePrMenu(textarea); return; }
  const skills = await loadSkills();
  if (skillQuery(textarea)?.query !== found.query) return;
  const commands = found.atStart ? rankSkills(slashCommands.map(command => ({ ...command, source: "command" })), found.query) : [];
  const items = [...commands, ...rankSkills(skills, found.query)].slice(0, 60);
  // Mid-text, a "/" that matches no skill is just a slash.
  if (!items.length && !found.atStart) { closeSkillMenu(); return; }
  prMenu = null; refMenu = null;
  skillMenu = { items, index: Math.min(skillMenu?.query === found.query ? skillMenu.index : 0, Math.max(0, items.length - 1)), query: found.query };
  renderSkillMenu();
}
function renderSkillMenu() {
  const node = document.querySelector("#skill-menu");
  if (!node || !skillMenu) return;
  const source = { repo: "Repository", global: "Yours", package: "Package", command: "Command" };
  node.innerHTML = skillMenu.items.length
    ? skillMenu.items.map((skill, index) => `<button type="button" role="option" id="skill-option-${index}" class="skill-option${index === skillMenu.index ? " active" : ""}" aria-selected="${index === skillMenu.index}" data-action="skill-pick" data-name="${esc(skill.name)}" data-source="${esc(skill.source)}"><span class="skill-name">/${esc(skill.name)}${skill.argument ? ` <small>${esc(skill.argument)}</small>` : ""}</span><span class="skill-desc">${esc(skill.description)}</span><span class="skill-source">${esc(source[skill.source] ?? skill.source)}</span></button>`).join("")
    : `<p class="skill-empty">No command or skill matches “${esc(skillMenu.query)}”</p>`;
  showMenu(node);
  document.querySelector("#compose textarea").setAttribute("aria-activedescendant", skillMenu.items.length ? `skill-option-${skillMenu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
/** Opens the shared menu next to the caret (clamped to the composer). */
function showMenu(node) {
  node.hidden = false;
  const composer = document.querySelector("#compose"), marker = composer.querySelector(".compose-backdrop .caret-mark"), field = composer.querySelector(".compose-field");
  if (!marker || !field) return;
  const left = field.offsetLeft + marker.offsetLeft - 12, room = composer.clientWidth - node.offsetWidth - 8;
  node.style.left = `${Math.max(8, Math.min(left, room))}px`;
}
/** Replaces the trigger text before the caret (and the rest of that word) with `insert`; keeps undo history where the browser allows it. */
function replaceBeforeCaret(pattern, insert) {
  const textarea = document.querySelector("#compose textarea"), caret = textarea.selectionStart, before = textarea.value.slice(0, caret);
  const match = pattern.exec(before);
  if (!match) return;
  const start = match.index + (match[1]?.length ?? 0), wordEnd = caret + (/^\S*/.exec(textarea.value.slice(caret))?.[0].length ?? 0);
  const end = insert.endsWith(" ") && textarea.value[wordEnd] === " " ? wordEnd + 1 : wordEnd;
  textarea.focus(); textarea.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, insert)) { textarea.setRangeText(insert, start, end, "end"); }
  const at = start + insert.length;
  textarea.setSelectionRange(at, at);
  drafts.set(draftKey(), textarea.value); autosize(textarea); persistDraftsSafely();
  closeSkillMenu(); textarea.focus();
}
function pickSkill(name) { rememberPick(`/skill:${name}`); replaceBeforeCaret(/(^|[\s(\[])\/(?:skill:)?[\w.-]*$/, `/skill:${name} `); }
// Enter on a command without an argument runs it; Tab, or a command taking an argument, only fills the composer.
function pickMenuItem(item, run = true) {
  if (item.source !== "command") return pickSkill(item.name);
  replaceBeforeCaret(/(^|[\s(\[])\/(?:skill:)?[\w.-]*$/, `/${item.name} `);
  if (run && !item.argument) document.querySelector("#compose").requestSubmit();
}

// "@" references: GitHub issues, knowledge documents, uploads and project files. Candidates load per project (host caches them) and refresh after 30 s.
let refCatalog = null, refLoading = null;
async function loadRefCatalog() {
  const id = projectId;
  if (refCatalog?.projectId === id && Date.now() - refCatalog.at < 30000) return refCatalog;
  refLoading ??= api({ action: "ref-candidates", id }).then(data => {
    if (id === projectId) refCatalog = { projectId: id, at: Date.now(), data, items: refItems(data) };
    return refCatalog;
  }).finally(() => { refLoading = null; });
  return refLoading;
}
const quoteRef = value => /\s/.test(value) ? `"${value}"` : value;
const refKinds = { recent: "Recent", issue: "Issues", doc: "Knowledge", upload: "Uploads", file: "Files" };
function refItems(data) {
  const base = path => { const parts = path.split("/"); return { name: parts.at(-1), folder: parts.slice(0, -1).join("/") }; };
  const ok = value => !/["\n]/.test(value);
  return [
    ...data.issues.map(issue => ({ kind: "issue", token: `@issue:${issue.number}`, label: `#${issue.number}`, detail: issue.title, search: `${issue.number} ${issue.title}`, meta: issue.state, at: issue.updatedAt })),
    ...data.docs.map(doc => ({ kind: "doc", token: `@doc:${doc.path}`, label: base(doc.path).name, detail: base(doc.path).folder || "knowledge", search: doc.path, meta: ago(doc.updatedAt), at: doc.updatedAt })),
    ...data.uploads.filter(item => ok(item.filename)).map(item => ({ kind: "upload", token: `@upload:${quoteRef(item.filename)}`, label: item.filename, detail: `${item.kind} · ${size(item.size)}`, search: item.filename, meta: ago(item.at), at: item.at })),
    ...data.files.filter(ok).map(path => ({ kind: "file", token: `@file:${quoteRef(path)}`, label: base(path).name, detail: base(path).folder, search: path, recent: data.recentFiles.indexOf(path) })),
  ];
}
const pickedKey = () => `pi-projects:picked:${projectId}`;
function recentPicks() { try { return JSON.parse(localStorage.getItem(pickedKey()) ?? "[]"); } catch { return []; } }
function rememberPick(token) { try { localStorage.setItem(pickedKey(), JSON.stringify([token, ...recentPicks().filter(item => item !== token)].slice(0, 20))); } catch { /* storage full or blocked */ } }
function refQuery(textarea) {
  const match = triggerBefore(textarea, /(^|[\s(\[])@(?:(issue|doc|upload|file):)?([^\s@"]*)$/);
  return match ? { kind: match[2] ?? null, query: match[3] } : null;
}
function rankRefs(items, kind, query) {
  const q = query.toLowerCase(), picks = recentPicks(), pool = kind ? items.filter(item => item.kind === kind) : items;
  if (!q) {
    // Nothing typed yet: recent picks, then the newest of each kind (recently changed files first).
    const picked = picks.map(token => pool.find(item => item.token === token)).filter(Boolean).slice(0, 5);
    const newest = (list, count) => list.filter(item => !picked.includes(item)).sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))).slice(0, count);
    const files = pool.filter(item => item.kind === "file" && !picked.includes(item)), recent = files.filter(item => item.recent >= 0).sort((a, b) => a.recent - b.recent);
    const each = kind ? 30 : 4;
    return [...picked.map(item => ({ ...item, section: "recent" })), ...newest(pool.filter(item => item.kind === "issue"), each), ...newest(pool.filter(item => item.kind === "doc"), each), ...newest(pool.filter(item => item.kind === "upload"), kind ? each : 3), ...[...recent, ...files.filter(item => item.recent < 0)].slice(0, kind ? each : 5)];
  }
  const scored = [];
  for (const item of pool) {
    const label = fuzzyScore(q, item.label), path = fuzzyScore(q, item.search), detail = item.kind === "issue" ? fuzzyScore(q, item.detail) : -1;
    let score = Math.max(label > 0 ? label * 1.6 + (item.label.toLowerCase().startsWith(q) ? 30 : 0) + (item.label.toLowerCase() === q ? 40 : 0) : -1, path, detail);
    if (score <= 0) continue;
    if (picks.includes(item.token)) score += 15;
    if (item.recent >= 0) score += 6 - item.recent * 0.3;
    scored.push([score, item]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 40).map(([, item]) => item);
}
/** Returns true when an "@" query is active (the menu is shown or loading). */
async function updateRefMenu(textarea) {
  const found = refQuery(textarea);
  if (!found) { refMenu = null; return false; }
  const catalog = await loadRefCatalog();
  const now = refQuery(textarea);
  if (!catalog || now?.query !== found.query || now?.kind !== found.kind) return true;
  const ranked = rankRefs(catalog.items, found.kind, found.query);
  // Group by kind, groups ordered by their best match (Cursor-style sections).
  const groups = [];
  for (const item of ranked) { const section = item.section ?? item.kind; let group = groups.find(entry => entry.kind === section); if (!group) groups.push(group = { kind: section, items: [] }); if (group.items.length < (found.kind ? 40 : 12)) group.items.push(item); }
  const items = groups.flatMap(group => group.items), key = `${found.kind}:${found.query}`;
  skillMenu = null; prMenu = null;
  refMenu = { items, groups, index: Math.min(refMenu?.key === key ? refMenu.index : 0, Math.max(0, items.length - 1)), key, query: found.query, kind: found.kind, data: catalog.data };
  renderRefMenu();
  return true;
}
const refIcons = {
  issue: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  doc: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3 M5.5 8.5h5 M5.5 11h5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  upload: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.25L12.5 5v9.25H4z M9.25 1.75V5h3.25" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  pr: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8 M11.5 10.9V6.5c0-1.4-1-2.5-2.5-2.5H7.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
};
function highlightMatch(text, query) {
  // Bold the characters the fuzzy match used.
  const q = query.toLowerCase(), lower = String(text).toLowerCase();
  if (!q) return esc(text);
  let at = 0, out = "";
  for (const [index, char] of [...String(text)].entries()) { if (at < q.length && lower[index] === q[at]) { out += `<b>${esc(char)}</b>`; at++; } else out += esc(char); }
  return at === q.length ? out : esc(text);
}
function renderRefMenu() {
  const node = document.querySelector("#skill-menu"), menu = refMenu;
  if (!node || !menu) return;
  let index = -1;
  const rows = menu.groups.map(group => `<div class="ref-group" role="presentation">${esc(refKinds[group.kind])}</div>${group.items.map(item => { index++; return `<button type="button" role="option" id="skill-option-${index}" class="skill-option ref-opt ref-${item.kind}${index === menu.index ? " active" : ""}" aria-selected="${index === menu.index}" data-action="ref-pick" data-index="${index}"><span class="ref-icon">${refIcons[item.kind]}</span><span class="skill-name">${highlightMatch(item.label, menu.query)}</span><span class="skill-desc">${esc(item.detail ?? "")}</span><span class="skill-source">${esc(item.meta ?? "")}</span></button>`; }).join("")}`).join("");
  const notes = [menu.data.issuesError && (!menu.kind || menu.kind === "issue") ? `GitHub issues unavailable: ${menu.data.issuesError}` : "", menu.data.filesError && (!menu.kind || menu.kind === "file") ? `Project files unavailable: ${menu.data.filesError}` : "", menu.data.filesTruncated && (!menu.kind || menu.kind === "file") ? `Only the first ${menu.data.files.length.toLocaleString()} project files are searchable.` : "", !menu.data.repository && menu.kind === "issue" ? "Connect GitHub in Settings to reference issues." : ""].filter(Boolean);
  node.innerHTML = (rows || `<p class="skill-empty">Nothing matches “${esc(menu.query)}”</p>`) + notes.map(text => `<p class="skill-empty ref-note">${esc(text)}</p>`).join("") + `<p class="ref-hint">↑↓ move · Enter or Tab insert · Esc close${menu.kind ? "" : " · @file: @doc: @issue: @upload: narrow"}</p>`;
  showMenu(node);
  document.querySelector("#compose textarea").setAttribute("aria-activedescendant", menu.items.length ? `skill-option-${menu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
function pickRef(item) { rememberPick(item.token); replaceBeforeCaret(/(^|[\s(\[])@(?:(?:issue|doc|upload|file):)?[^\s@"]*$/, `${item.token} `); }

// Composer highlighting: a mirror layer behind the transparent textarea paints each reference token; the caret marker positions the menu.
// Same grammar as the host (src/coordinator-skills.ts SKILL_TOKEN, src/inline-refs.ts REF_TOKEN, PR refs in src/github-prs.ts).
const refTokenPattern = () => /(?<![^\s([])(?:\/skill:([A-Za-z0-9](?:[\w.-]*[\w-])?)|@(issue|doc|upload|file):(?:"([^"\n]{1,1024})"|([^\s"]+?))|(?:PR\s+)?#(\d{1,9}))(?=[.,;:!?)\]]*(?:\s|$))/g;
function refTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(refTokenPattern())) tokens.push({ start: match.index, end: match.index + match[0].length, kind: match[1] ? "skill" : match[2] ?? "pr", value: match[1] ?? match[3] ?? match[4] ?? match[5] });
  return tokens;
}
function renderBackdrop(textarea) {
  const backdrop = textarea?.closest?.("#compose")?.querySelector(".compose-backdrop");
  if (!backdrop) return;
  const text = textarea.value, caret = textarea.selectionEnd, prs = prMenuItems().length > 0;
  let html = "", at = 0;
  const plain = (from, to) => { if (caret >= from && caret <= to && !html.includes("caret-mark")) return esc(text.slice(from, caret)) + '<span class="caret-mark"></span>' + esc(text.slice(caret, to)); return esc(text.slice(from, to)); };
  for (const token of refTokens(text)) {
    if (token.kind === "pr" && !prs) continue;
    html += plain(at, token.start) + `<mark class="ref ref-${token.kind}">${plain(token.start, token.end)}</mark>`;
    at = token.end;
  }
  html += plain(at, text.length);
  backdrop.innerHTML = `${html}\u200b`;
  backdrop.scrollTop = textarea.scrollTop;
}
/** Backspace right after a reference removes the whole token. */
function deleteTokenBefore(textarea) {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  const caret = textarea.selectionStart, token = refTokens(textarea.value).find(item => item.end === caret && (item.kind !== "pr" || prMenuItems().length));
  if (!token) return false;
  textarea.setSelectionRange(token.start, token.end);
  if (!document.execCommand("delete")) { textarea.setRangeText("", token.start, token.end, "end"); textarea.dispatchEvent(new Event("input", { bubbles: true })); }
  return true;
}
// PR card (one group per PR provider serving the project) and the "#" PR menu. Rows come from the host's shared provider caches; the browser asks at most every 20 s.
let prsState = { projectId: null, data: null, at: 0, error: "" }, linksReady = false, prsLoading = false, prsShowHidden = false, providerLabels = {};
// Show/hide the hidden-PR list: local view state, not an action, so it works while busy.
document.addEventListener("click", event => { if (!event.target.closest("[data-pr-show-hidden]")) return; prsShowHidden = !prsShowHidden; renderPrs(); });
const prNow = () => (prsState.projectId === projectId ? prsState.data : null);
// Any #<id> or ticket key links through the project's PR provider (one provider: an ambiguous mix stays plain text).
const prTemplateUrl = id => { const groups = prNow()?.providers ?? []; return groups.length === 1 && groups[0].urlTemplate?.includes("{id}") ? groups[0].urlTemplate.replace("{id}", id) : undefined; };
const ticketTemplate = () => { const templates = (prNow()?.providers ?? []).map(group => group.ticketTemplate).filter(Boolean); return templates.length === 1 ? templates[0] : null; };
// Standards and encodings that look like ticket keys.
const NOT_TICKETS = new Set(["UTF", "SHA", "ISO", "RFC", "CVE", "AES", "RSA", "IPV", "TLS", "HTTP", "GPT", "MD", "EC", "ES", "UTC", "GMT"]);
const prMenuItems = () => (prNow()?.providers ?? []).flatMap(group => group.prs.map(pr => ({ ...pr, provider: group.provider })));
// Provider labels for event titles; a plugin that failed to load is shown once as a banner (the host keeps running without it).
async function loadPluginStatus() {
  try {
    const status = await api({ action: "plugins" });
    providerLabels = status.labels ?? {};
    loadUiPlugins(status.web ?? []);
    const failed = (status.plugins ?? []).filter(item => item.state === "failed");
    if (failed.length) setError(`Plugin not loaded: ${failed.map(item => `${item.name ?? item.source} (${item.error})`).join("; ")}`, "action");
  } catch { /* cosmetic */ }
}
async function loadPrs(force = false) {
  const id = projectId;
  if (!id || prsLoading || (!force && prsState.projectId === id && Date.now() - prsState.at < 20000)) return;
  prsLoading = true;
  try { const data = await api({ action: "prs", id, ...(force ? { refresh: true } : {}) }); if (id === projectId) prsState = { projectId: id, data, at: Date.now(), error: "" }; }
  catch (error) { if (id === projectId) prsState = { projectId: id, data: prsState.projectId === id ? prsState.data : null, at: Date.now(), error: error.message }; }
  finally { prsLoading = false; }
  if (id !== projectId) return;
  renderPrs();
  // The first listing brings the link templates for #<id> and ticket keys in the transcript.
  if (!linksReady && prsState.data) { linksReady = true; if (view) render(); }
}
const prGlyph = { failing: ["✕", "bad", "Failing: a required check failed or there are conflicts"], running: ["●", "warn", "Required checks are running"], green: ["✓", "good", "Required checks passed"], none: ["○", "muted", "No checks yet"] };
// Composer help: the shortcut list lives in a small popover behind an ⓘ button instead of a permanent hint line. A tap/click toggles it, so touch works; Escape or a click outside closes it.
const helpRows = worker => [["Enter", "Send"], ["Shift+Enter", "New line"], ...(worker ? [] : [["/", "Commands and skills"], ["@", "Files, docs, issues"], ["#", "Pull requests"], ["Drop files", "Attach"]])];
function closeComposerHelp(except = null) {
  for (const wrap of document.querySelectorAll(".help-wrap")) if (wrap !== except) { wrap.querySelector(".help-pop").hidden = true; wrap.querySelector(".help-btn").setAttribute("aria-expanded", "false"); }
}
function toggleComposerHelp(button) {
  const wrap = button.closest(".help-wrap"), pop = wrap.querySelector(".help-pop"), open = pop.hidden;
  closeComposerHelp(wrap);
  if (open) pop.innerHTML = `<dl>${helpRows(!!button.closest("[data-inline-thread-send]")).map(([key, text]) => `<dt><kbd>${esc(key)}</kbd></dt><dd>${esc(text)}</dd>`).join("")}</dl>`;
  pop.hidden = !open; button.setAttribute("aria-expanded", String(open));
}
document.addEventListener("click", event => { if (!event.target.closest(".help-wrap")) closeComposerHelp(); });
document.addEventListener("keydown", event => {
  const open = document.querySelector(".help-pop:not([hidden])");
  if (event.key !== "Escape" || !open) return;
  event.preventDefault(); event.stopPropagation(); open.closest(".help-wrap").querySelector(".help-btn").focus(); closeComposerHelp();
}, true);
const byNewest = (a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
function renderPrs() {
  const card = document.querySelector("#prs-card"), data = prNow();
  const groups = data?.providers ?? [], unloaded = data?.unloaded ?? [];
  card.hidden = !groups.length && !unloaded.length;
  if (card.hidden) return;
  const glyphs = prGlyph;
  const group = data => {
    // Hidden PRs leave the card and monitoring; "Show hidden" lists them dimmed with Unhide.
    const hidden = new Set(data.hidden ?? []), all = [...data.prs], hiddenPrs = all.filter(pr => hidden.has(pr.id));
    const order = { failing: 0, running: 1, green: 2, none: 3 }, prs = all.filter(pr => !hidden.has(pr.id)).sort((a, b) => order[a.state] - order[b.state] || byNewest(a, b)), shown = [...prs.slice(0, 12), ...(prsShowHidden ? hiddenPrs : [])], watched = new Set(data.watched ?? []);
    const rows = shown.map(pr => {
      const isHidden = hidden.has(pr.id), target = `data-provider="${esc(data.provider)}" data-pr="${esc(pr.id)}"`, hideButton = `<button type="button" class="ghost small pr-hide" data-action="pr-hide" ${target} data-hide="${!isHidden}" title="${isHidden ? "Show this PR on the card and monitor it again" : "Hide this PR from the card and stop monitoring it"}" aria-label="${isHidden ? `Unhide PR ${esc(pr.ref)}` : `Hide PR ${esc(pr.ref)}`}">${isHidden ? "Unhide" : "Hide"}</button>`;
      const [glyph, tone, title] = glyphs[pr.state] ?? glyphs.none, counts = [["good", "✓", pr.counts.ok], ["bad", "✕", pr.counts.failed], ["warn", "●", pr.counts.running]].filter(([, , n]) => n).map(([cls, mark, n]) => `<span class="${cls}">${mark}${n}</span>`).join(" ");
      const detail = [counts, pr.draft ? '<span class="muted">draft</span>' : "", pr.review === "changes" ? '<span class="bad">changes requested</span>' : pr.review === "approved" ? '<span class="good">approved</span>' : "", pr.unresolved ? `<span class="warn">${pr.unresolved} unresolved</span>` : "", pr.conflicts ? '<span class="bad">conflicts</span>' : "", pr.mergeFailed ? '<span class="bad">merge failed</span>' : pr.autoMerge ? '<span class="good">auto-merge</span>' : "", pr.failedChecks.length ? `<span class="pr-fails">${esc(pr.failedChecks.slice(0, 2).join(", "))}${pr.failedChecks.length > 2 ? ` +${pr.failedChecks.length - 2}` : ""}</span>` : `<span class="pr-branch">${esc(pr.branch)}</span>`].filter(Boolean).join(" ");
      return `<div class="pr-row ${esc(pr.state)}${isHidden ? " hidden-pr" : ""}"><span class="pr-icon ${tone}" title="${esc(title)}" role="img" aria-label="${esc(title)}">${glyph}</span><div class="pr-main"><a class="pr-title" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" title="${esc(pr.title)}"><span class="pr-id">${esc(pr.ref)}</span> ${esc(pr.title)}</a><small class="pr-sub">${detail}</small></div><span class="pr-actions">${isHidden ? "" : `<button type="button" class="ghost small pr-watch${watched.has(pr.id) ? " on" : ""}" data-action="pr-watch" ${target} aria-pressed="${watched.has(pr.id)}" title="${watched.has(pr.id) ? "Watching: the coordinator is told when a check or merge fails. Click to stop." : "Watch: tell the coordinator when a check or merge fails"}">${watched.has(pr.id) ? "Watching" : "Watch"}</button>`}${hideButton}</span></div>`;
    }).join("");
    const problem = (prsState.error && !prsState.data ? prsState.error : "") || data.error;
    return `<div class="pr-group" data-provider="${esc(data.provider)}">${groups.length + unloaded.length > 1 ? `<small class="note pr-group-title">${esc(data.label)}</small>` : ""}${problem ? `<p class="note pr-error">${esc(problem)}${prs.length ? " (showing the last list)" : ""}</p>` : ""}${rows || (problem ? "" : '<p class="note">No open PRs.</p>')}${prs.length > 12 ? `<p class="note">+${prs.length - 12} more in ${esc(data.label)}</p>` : ""}${hiddenPrs.length ? `<button type="button" class="ghost small pr-show-hidden" data-pr-show-hidden aria-expanded="${prsShowHidden}">${prsShowHidden ? "Hide" : "Show"} ${hiddenPrs.length} hidden</button>` : ""}<form class="pr-add" data-pr-add data-provider="${esc(data.provider)}"><input name="pr" maxlength="200" autocomplete="off" placeholder="Watch a PR: number or URL" aria-label="Watch a pull request by number or URL"><button type="submit" class="ghost small">Watch</button></form>${data.monitoring ? "" : '<p class="note pr-off">Monitoring is off. Turn on Follow PRs in Settings to hear about failing checks.</p>'}</div>`;
  };
  setHtml("#prs", `${prsState.error && !prsState.data ? `<p class="note pr-error">${esc(prsState.error)}</p>` : ""}${groups.map(group).join("")}${unloaded.map(id => `<p class="note pr-error">${esc(id)} pull requests are unavailable: the provider plugin is not loaded (its watch and hide records are kept).</p>`).join("")}`);
  const fetched = groups.map(item => item.rateLimitedUntilMs ? "rate limited" : item.fetchedAtMs ? ago(new Date(item.fetchedAtMs).toISOString()) : "").find(Boolean);
  document.querySelector("#prs-meta").textContent = fetched ?? "";
}
const prRefs = /(?:^|[\s(\[])#([^\s#]*)$/;
function updatePrMenu(textarea) {
  const query = textarea.selectionStart === textarea.selectionEnd ? prRefs.exec(textarea.value.slice(0, textarea.selectionStart))?.[1] ?? null : null, all = prMenuItems();
  if (query === null || !all.length) { closeSkillMenu(); return; }
  const q = query.toLowerCase(), items = all.sort(byNewest).filter(pr => !q || pr.ref.slice(1).toLowerCase().startsWith(q) || pr.title.toLowerCase().includes(q)).slice(0, 30);
  skillMenu = null; refMenu = null; prMenu = { items, index: Math.min(prMenu?.query === query ? prMenu.index : 0, Math.max(0, items.length - 1)), query };
  renderPrMenu();
}
function renderPrMenu() {
  const node = document.querySelector("#skill-menu");
  node.innerHTML = prMenu.items.length
    ? prMenu.items.map((pr, index) => `<button type="button" role="option" id="skill-option-${index}" class="skill-option pr-opt${index === prMenu.index ? " active" : ""}" aria-selected="${index === prMenu.index}" data-action="pr-pick" data-provider="${esc(pr.provider)}" data-pr="${esc(pr.id)}"><span class="skill-name">${esc(pr.ref)}</span><span class="skill-desc">${esc(pr.title)}</span><span class="skill-source pr-icon ${prGlyph[pr.state]?.[1] ?? "muted"}">${prGlyph[pr.state]?.[0] ?? "○"}</span></button>`).join("")
    : `<p class="skill-empty">No open PR matches “${esc(prMenu.query)}”</p>`;
  showMenu(node);
  document.querySelector("#compose textarea").setAttribute("aria-activedescendant", prMenu.items.length ? `skill-option-${prMenu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
function pickPr(ref) { replaceBeforeCaret(/()(?:PR\s+)?#[^\s#]*$/, `PR ${ref} `); }
// The host appends a "[Referenced PRs (<provider>) …]" block to the coordinator message (older: "[Referenced <provider> PRs …]"); show it as chips linking to the PR URL at the end of each line.
const prBlock = /\n\n\[Referenced [^\]\n]*PRs[^\]\n]*\]\n((?:- [^\n]*(?:\n|$))+)$/;
function prChips(text) {
  const match = prBlock.exec(text);
  if (!match) return { text, chips: "", urls: new Map() };
  const urls = new Map();
  const chips = match[1].trim().split("\n").map(line => {
    const known = /^- (\S+?)(?: “(.*?)”)? \((.*?)\) (https?:\/\/\S+)$/.exec(line), gone = /^- (\S+?): could not be read/.exec(line);
    if (known) urls.set(known[1], known[4]);
    return known ? `<a class="attach-chip pr-chip" href="${esc(known[4])}" target="_blank" rel="noopener noreferrer" title="${esc(`${known[2] ?? ""} (${known[3]})`)}"><span class="pr-id">${esc(known[1])}</span><span class="attach-name">${esc(known[2] ?? "")}</span></a>` : gone ? `<span class="attach-chip gone">${esc(gone[1])} unreadable</span>` : "";
  }).join("");
  return { text: text.slice(0, match.index), chips: `<div class="attach-row">${chips}</div>`, urls };
}
// The host appends a "[Referenced items …]" block after the owner's words (src/inline-refs.ts); the bubble shows only the words, with the tokens as chips. Unreadable items are marked.
const refsBlock = /\n\n\[Referenced items: [^\]\n]*\]\n[\s\S]*$/;
function refsSplit(text) {
  const match = refsBlock.exec(text);
  if (!match) return { text, gone: new Map() };
  const gone = new Map([...match[0].matchAll(/^- (@\w+:(?:"[^"\n]*"|\S+?)): could not be read \((.*)\)$/gm)].map(found => [found[1], found[2]]));
  return { text: text.slice(0, match.index), gone };
}
const unesc = value => value.replace(/&(amp|quot|#39|lt|gt);/g, (_, name) => ({ amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" })[name]);
// Same grammar as refTokenPattern, on already-escaped text.
const refHtmlPattern = /(?<![^\s([])(?:\/skill:([A-Za-z0-9](?:[\w.-]*[\w-])?)|@(issue|doc|upload|file):(?:&quot;((?:(?!&quot;)[^\n]){1,1024}?)&quot;|((?:(?!&quot;)\S)+?))|(?:PR\s+)?#(\d{1,9}))(?=(?:[.,;:!?)\]]|&#39;)*(?:\s|$))/g;
function refChipHtml(all, skill, kind, quoted, bare, pr, refs) {
  const value = unesc(skill ?? quoted ?? bare ?? pr), type = skill ? "skill" : kind ?? "pr", token = unesc(all);
  if (type === "pr") {
    const ref = `#${pr}`, url = refs.prs?.get(ref) ?? prMenuItems().find(item => item.ref === ref)?.url ?? (pr.length >= 3 ? prTemplateUrl(pr) : undefined);
    return /^https?:\/\//.test(url ?? "") ? `<a class="ref-chip ref-pr" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(`Open ${ref}`)}">${refIcons.pr}<span>${all}</span></a>` : all;
  }
  const label = type === "issue" ? `#${value}` : ["doc", "file"].includes(type) ? value.split("/").at(-1) : value, problem = refs.gone?.get(token);
  return `<button type="button" class="ref-chip ref-${type}${problem ? " gone" : ""}" data-action="ref-open" data-kind="${type}" data-value="${esc(value)}" title="${esc(problem ? `${token}: could not be read (${problem})` : `${token} · click to preview`)}">${type === "skill" ? skillIcon : refIcons[type]}<span>${esc(label)}</span></button>`;
}
async function refOpen(kind, value) {
  const id = projectId;
  if (kind === "doc") { await knowledgeRead(value); return; }
  if (kind === "upload") {
    const record = (view?.uploads ?? []).find(item => item.filename === value);
    if (!record) throw new Error(`No upload named ${value} in this project`);
    await uploadOpen(record.id); return;
  }
  if (!["file", "issue", "skill"].includes(kind)) return;
  const version = showDialog(kind === "issue" ? `Issue #${value}` : value, '<p class="note">Reading…</p>');
  const found = await api({ action: "ref-preview", id, kind, value });
  if (version !== dialogVersion || id !== projectId) return;
  if (found.kind === "issue") {
    dialog.querySelector("#dialog-title").textContent = `#${found.number} ${found.title}`;
    const link = /^https:\/\//.test(found.url) ? `<a class="button-link" href="${esc(found.url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>` : "";
    setDialogBody(`<p class="note">${esc(found.repository)} · ${esc(found.state)}${found.author ? ` · by ${esc(found.author)}` : ""}${found.comments ? ` · ${found.comments} comment${found.comments === 1 ? "" : "s"}` : ""}${found.labels.length ? ` · ${found.labels.map(esc).join(", ")}` : ""}</p><div class="doc-view text">${found.body ? renderMarkdown(found.body) : '<p class="note">No description.</p>'}</div>${dlgActions(link)}`);
  } else if (found.kind === "skill") {
    dialog.querySelector("#dialog-title").textContent = `/skill:${found.name}`;
    setDialogBody(`<p class="note">${esc(found.description)}</p><p class="note mono">${esc(found.path)}</p><div class="doc-view text">${renderMarkdown(found.text)}</div>${found.truncated ? '<p class="note">Showing the first 64,000 characters.</p>' : ""}`);
  } else {
    setDialogBody(`<p class="note">Project folder · ${esc(size(found.size))}${found.truncated ? " · showing the first 64 KB" : ""}</p>${found.binary ? '<p class="note">Binary file; not shown.</p>' : `<pre class="upload-text ref-file">${esc(found.text)}</pre>`}`);
  }
}
// Folders the owner collapsed, shared by the rail and the Knowledge tab; raw legacy answers start collapsed.
const closedFolders = new Set(["research/legacy"]);
const folderIcon = '<svg class="tree-icon folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.6h5.6c.55 0 1 .45 1 1v6.4c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z"/></svg>';
const fileIcon = '<svg class="tree-icon file" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9.25 1.75V5h3.25"/></svg>';
function knowledgeTree(docs, compact) {
  const root = { path: "", folders: new Map(), files: [] };
  for (const doc of docs) {
    const parts = doc.path.split("/");
    let node = root;
    for (const [index, name] of parts.slice(0, -1).entries()) {
      if (!node.folders.has(name)) node.folders.set(name, { path: parts.slice(0, index + 1).join("/"), folders: new Map(), files: [] });
      node = node.folders.get(name);
    }
    node.files.push(doc);
  }
  const count = node => node.files.length + [...node.folders.values()].reduce((sum, folder) => sum + count(folder), 0);
  const rank = doc => doc.path === "MEMORY.md" ? 0 : doc.path === "preferences.md" ? 1 : 2;
  const file = doc => {
    const name = doc.path.split("/").at(-1);
    return `<button class="tree-file${doc.path === "MEMORY.md" ? " memory" : ""}" data-action="knowledge-read" data-project="${esc(view.project.id)}" data-path="${esc(doc.path)}" title="${esc(doc.path)}">${fileIcon}<span class="tree-name">${esc(name)}</span><small class="tree-meta">${esc(compact ? ago(doc.updatedAt) : `${doc.author} · updated ${ago(doc.updatedAt)} · ${size(doc.size)}`)}</small></button>`;
  };
  const branch = node => [...node.folders.values()].sort((a, b) => a.path.localeCompare(b.path)).map(folder => `<details class="tree-folder" data-folder="${esc(folder.path)}"${closedFolders.has(folder.path) ? "" : " open"}><summary><span class="tree-chevron" aria-hidden="true"></span>${folderIcon}<span class="tree-name">${esc(folder.path.split("/").at(-1))}</span><span class="tree-count">${count(folder)}</span></summary><div class="tree-children">${branch(folder)}</div></details>`).join("")
    + node.files.toSorted((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)).map(file).join("");
  return `<div class="tree${compact ? " compact" : ""}" role="tree">${branch(root)}</div>`;
}
document.addEventListener("toggle", event => {
  const folder = event.target;
  if (!(folder instanceof HTMLDetailsElement) || !folder.classList.contains("tree-folder")) return;
  if (folder.open) closedFolders.delete(folder.dataset.folder); else closedFolders.add(folder.dataset.folder);
}, true);
function clip(value, size) { return value.length > size ? `${value.slice(0, size - 1)}…` : value; }

function letter(entry) {
  if (entry.kind === "approval") return operationLetter(entry.record);
  return "";
}

// A question belongs to the chat whose conversation asked it; legacy entries without a native identity belong to Main.
function questionChat(item) { return (view.chats ?? []).find(chat => item.native && chat.conversationId === item.native.conversationId) ?? (view.chats ?? []).find(chat => chat.id === "main"); }
function questionPlacement() {
  const here = [], elsewhere = [], answered = [];
  for (const item of view.inbox.filter(entry => entry.kind === "question")) {
    const chat = questionChat(item);
    if (item.result) { if (!chat || chat.id === chatId) answered.push(item); }
    else if (!chat || chat.id === chatId) here.push(item);
    else elsewhere.push({ item, chat });
  }
  return { here, elsewhere, answered };
}
function questionCard(item) {
  const rest = item.question.trim() !== item.title ? item.question.startsWith(item.title) ? item.question.slice(item.title.length).trim() : item.question : "";
  const oldDraft = answers.has(item.id) && !answers.has(answerKey(projectId, item.id));
  return `<article class="question-card" data-question="${esc(item.id)}" tabindex="-1" aria-label="Question from the coordinator"><div class="q-who">Coordinator asks <small class="inline">${esc(ago(item.at))}</small></div><h3 class="q-title">${esc(item.title)}</h3>${rest ? `<div class="q-body">${renderMarkdown(rest)}</div>` : ""}${item.choices.length ? `<div class="choices" role="group" aria-label="Choices">${item.choices.map((choice, index) => `<button type="button" data-action="answer" data-project="${esc(projectId)}" data-entry="${item.id}" data-choice="${index}" data-choice-text="${esc(choice)}"><kbd>${index + 1}</kbd><span>${esc(choice)}</span></button>`).join("")}</div>` : ""}${answerForm(item)}${oldDraft ? `<p class="notice">An old UUID-only draft is retained without project ownership. It has not been filled into this question.</p><button type="button" data-action="answer-adopt" data-project="${esc(projectId)}" data-entry="${esc(item.id)}">Inspect and explicitly adopt old draft</button>` : ""}</article>`;
}
function answeredCard(item) {
  return `<article class="question-done" data-question="${esc(item.id)}"><span class="q-check" aria-hidden="true">✓</span><span class="q-done-body"><b>${esc(item.title)}</b><span>Answered: ${esc(clip(item.result.text, 300))}</span></span><small class="inline">${esc(when(Date.parse(item.result.at)))}</small></article>`;
}
// Answered questions stay where they were asked: before the first message sent after the question.
function transcriptHtml(answered) {
  const out = [], rest = answered.toSorted((a, b) => a.at.localeCompare(b.at));
  for (const message of view.messages) {
    while (rest.length && Number.isFinite(message.at) && message.at > Date.parse(rest[0].at)) out.push(answeredCard(rest.shift()));
    out.push(chatMessageHtml(message, "Coordinator"));
  }
  const earlier = view.earlier > 0 ? [`<button type="button" class="ghost small earlier-messages" data-action="history-earlier">Show earlier messages (${view.earlier})</button>`] : [];
  return [...earlier, ...out, ...rest.map(answeredCard)].join("");
}
function answerForm(entry) {
  return `<form data-answer data-project="${esc(projectId)}" data-entry="${entry.id}" class="q-answer"><textarea name="answer" rows="1" aria-label="Answer the coordinator's question" placeholder="${entry.choices.length ? "Or write your own answer…" : "Your answer…"}" title="Enter to send, Shift+Enter for a new line" maxlength="24000" required>${esc(answers.get(answerKey(projectId, entry.id)) ?? "")}</textarea><button class="primary" type="submit">Send answer</button></form>`;
}
function artifactButton(file) { return `<button class="artifact" data-action="artifact" data-file="${file.id}"><strong>${esc(file.title)}</strong><small>${esc(file.filename)} · ${Math.ceil(file.size / 1024)} KiB · SHA-256 ${esc(file.sha256.slice(0, 12))}</small></button>`; }
function duration(ms) { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`; }
function ago(at) { const ms = Date.now() - new Date(at).getTime(); return ms < 60000 ? "just now" : `${duration(ms)} ago`; }
function size(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
// Uploads: owner files stored as project knowledge (Knowledge tab) or attached to a composer message. The host extracts PDF text; agents search with projects_search.
const UPLOAD_LIMIT = 20 * 1024 * 1024;
const attachmentDrafts = new Map();
function fileKind(kind) { return `<span class="file-kind ${esc(kind ?? "")}">${kind === "image" ? "IMG" : kind === "pdf" ? "PDF" : kind ? "TXT" : "…"}</span>`; }
async function uploadFile(file, id) {
  if (!file.size) throw new Error(`${file.name} is empty`);
  if (file.size > UPLOAD_LIMIT) throw new Error(`${file.name} is larger than 20 MB`);
  const response = await fetch(`/upload?project=${encodeURIComponent(id)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-filename": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file, signal: AbortSignal.timeout(300000) });
  const reply = await response.json().catch(() => null);
  if (!response.ok || reply?.ok !== true) throw new Error(`${file.name}: ${typeof reply?.error === "string" ? reply.error : `upload failed (${response.status})`}`);
  return reply.data;
}
async function uploadToKnowledge(files) {
  const id = projectId;
  if (!id || !view) throw new Error("Select a project first");
  const results = await Promise.allSettled(files.map(file => uploadFile(file, id)));
  if (id === projectId) await refresh();
  const failed = results.filter(result => result.status === "rejected").map(result => result.reason.message), done = results.length - failed.length;
  if (done) toast(`${done} file${done === 1 ? "" : "s"} added to knowledge.`);
  if (failed.length) throw new Error(failed.join("; "));
}
async function attachFiles(files) {
  if (!view || admissionBlocked()) throw new Error("This project cannot accept a request now.");
  const key = draftKey(), id = projectId, list = attachmentDrafts.get(key) ?? [];
  if (list.length + files.length > 10) throw new Error("At most 10 attachments per message");
  attachmentDrafts.set(key, list);
  const errors = [];
  await Promise.all(files.map(async file => {
    const item = { filename: file.name, pending: true };
    list.push(item); renderAttachments();
    try { Object.assign(item, await uploadFile(file, id), { pending: false }); }
    catch (error) { list.splice(list.indexOf(item), 1); errors.push(error.message); }
    renderAttachments();
  }));
  if (errors.length) throw new Error(errors.join("; "));
}
function renderAttachments() {
  const node = document.querySelector("#attachments"), list = attachmentDrafts.get(draftKey()) ?? [];
  node.hidden = !list.length;
  node.innerHTML = list.map((item, i) => `<span class="attach-chip ${item.pending ? "pending" : ""}" title="${esc(item.filename)}">${fileKind(item.kind)}<span class="attach-name">${esc(item.filename)}</span>${item.pending ? "<small>uploading…</small>" : `<small>${size(item.size)}</small><button type="button" class="ghost small" data-action="attach-remove" data-index="${i}" aria-label="Remove ${esc(item.filename)}">×</button>`}</span>`).join("");
}
function uploadsHtml() {
  const list = view?.uploads ?? [];
  return list.length ? `<div class="upload-list">${list.map(item => `<button class="upload-row" data-action="upload-open" data-upload="${esc(item.id)}">${fileKind(item.kind)}<span class="upload-name">${esc(item.filename)}</span><small>${size(item.size)} · ${esc(ago(item.at))}${item.extractError ? " · no text extracted" : ""}</small></button>`).join("")}</div>` : '<p class="note">Drop files here or use Upload files: text, code, Markdown, PDF and PNG/JPEG/WebP images up to 20 MB. The coordinator and workers can search them.</p>';
}
// The host appends an attachment block to the coordinator message; show it as chips.
const attachmentBlock = /\n\n\[Attached files: [^\]\n]*\]\n((?:- [^\n]*(?:\n|$))+)$/;
function attachmentChips(text) {
  const match = attachmentBlock.exec(text);
  if (!match) return { text, chips: "" };
  const chips = match[1].trim().split("\n").map(line => {
    const known = /^- (.+) · (text|pdf|image) · (\d+) bytes · upload ([a-f0-9-]{36})/.exec(line), gone = /^- deleted upload ([a-f0-9-]{36})/.exec(line);
    return known ? `<button type="button" class="attach-chip" data-action="upload-open" data-upload="${esc(known[4])}" title="${esc(known[1])}">${fileKind(known[2])}<span class="attach-name">${esc(known[1])}</span><small>${size(Number(known[3]))}</small></button>` : gone ? `<span class="attach-chip gone">Deleted upload</span>` : "";
  }).join("");
  return { text: text.slice(0, match.index), chips: `<div class="attach-row">${chips}</div>` };
}
async function uploadOpen(uploadId, focus = null) {
  const id = projectId, record = (view?.uploads ?? []).find(item => item.id === uploadId);
  const version = showDialog(record?.filename ?? "Upload", '<p class="note">Reading…</p>');
  let body, meta = record;
  if (record?.kind === "image") {
    const response = await fetch(`/uploads/${encodeURIComponent(id)}/${encodeURIComponent(uploadId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Image unavailable (${response.status})`);
    const blob = await response.blob();
    if (version !== dialogVersion || id !== projectId) return;
    blobUrl = URL.createObjectURL(blob);
    body = `<img class="upload-image" src="${blobUrl}" alt="${esc(record.filename)}">`;
  } else {
    // A search hit opens the text a little before the matched place.
    const start = focus ? Math.max(0, focus.offset - 2000) : 0;
    const page = await api({ action: "upload-read", id, uploadId, offset: start, limit: 20000 });
    meta = page.record;
    const end = page.nextOffset ?? page.record.textChars;
    body = page.record.extractError ? `<p class="note">${esc(page.record.extractError)}</p>` : `${start ? `<p class="note">Showing characters ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${page.record.textChars.toLocaleString()}.</p>` : ""}<pre class="upload-text">${esc(page.text)}</pre>${page.nextOffset !== null && !start ? `<p class="note">Showing the first ${page.nextOffset.toLocaleString()} of ${page.record.textChars.toLocaleString()} characters. Agents read the rest with projects_upload_read.</p>` : ""}`;
    if (focus) focus = { ...focus, text: page.text, at: focus.offset - start };
  }
  if (version !== dialogVersion || id !== projectId) return;
  dialog.querySelector("#dialog-title").textContent = meta.filename;
  dialog.querySelector(".dialog-body").innerHTML = `<p class="note">${esc(meta.kind.toUpperCase())} · ${size(meta.size)} · uploaded ${esc(ago(meta.at))}${meta.kind === "pdf" && !meta.extractError ? ` · ${meta.textChars.toLocaleString()} characters of text` : ""}</p>${body}<div class="row"><button class="small danger" data-action="upload-delete" data-project="${esc(id)}" data-upload="${esc(uploadId)}">Delete upload</button></div>`;
  if (focus?.text !== undefined) markAt(dialog.querySelector(".upload-text"), focus.terms, focus.text, focus.at);
}
// Search UI (Cmd/Ctrl+K): one project's chats (archived too), worker threads, knowledge and uploads. Results jump to the place and highlight it.
function termPattern(terms) { return terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|"), "giu") : null; }
function highlight(text, terms) {
  const pattern = termPattern(terms);
  if (!pattern) return esc(text);
  let out = "", last = 0;
  for (const match of text.matchAll(pattern)) { out += `${esc(text.slice(last, match.index))}<mark>${esc(match[0])}</mark>`; last = match.index + match[0].length; }
  return out + esc(text.slice(last));
}
// Wraps every term match in rendered text nodes; returns the marks in document order.
function markTerms(root, terms) {
  const pattern = termPattern(terms), marks = [];
  if (!root || !pattern) return marks;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest("mark, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, matches = [...text.matchAll(pattern)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment(); let last = 0;
    for (const match of matches) {
      fragment.append(text.slice(last, match.index));
      const mark = document.createElement("mark"); mark.className = "search-mark"; mark.textContent = match[0]; fragment.append(mark); marks.push(mark);
      last = match.index + match[0].length;
    }
    fragment.append(text.slice(last)); node.replaceWith(fragment);
  }
  return marks;
}
// Marks the terms and scrolls to the match at or after `offset` of the source text (counted by matches before it).
function markAt(root, terms, text, offset) {
  const marks = markTerms(root, terms), pattern = termPattern(terms);
  if (!marks.length) return;
  const before = [...[...text].slice(0, Math.max(0, offset)).join("").matchAll(pattern)].length;
  const mark = marks[Math.min(before, marks.length - 1)];
  mark.classList.add("current"); mark.scrollIntoView({ block: "center" });
}
function focusNode(node, focus) {
  if (!node) return false;
  if (!node.classList.contains("search-focus")) { node.classList.add("search-focus"); if (node.matches("details")) node.open = true; markTerms(node.querySelector(".text, .report-body") ?? node, focus.terms); }
  if (!focus.scrolled) { focus.scrolled = true; node.scrollIntoView({ block: "center" }); requestAnimationFrame(() => node.isConnected && node.scrollIntoView({ block: "center" })); }
  return true;
}
function applySearchFocus() {
  if (!searchFocus || searchFocus.project !== projectId || searchFocus.chat !== chatId || view?.chatId !== chatId || tab !== "coordinator") return;
  const first = !searchFocus.scrolled;
  if (focusNode(document.querySelector(`#messages [data-index="${searchFocus.index}"]`), searchFocus) && first) { stickToBottom = false; renderWorkingPill(); }
}
function openSearch() {
  if (!projectId) return;
  const query = searchState.project === projectId ? searchState.query : "";
  showDialog("Search", `<div class="search-box"><input id="search-input" type="search" placeholder="Search chats, workers, knowledge and files…" aria-label="Search this project" aria-controls="search-results" autocomplete="off" spellcheck="false" value="${esc(query)}"><p class="note search-scope">${esc(view?.project.name ?? "This project")}: every chat (archived too), worker threads, knowledge and uploaded files. ↑↓ to move, Enter to open.</p><div id="search-results" role="listbox" aria-label="Search results"></div></div>`);
  const input = dialog.querySelector("#search-input"); input.focus(); input.select();
  if (query) renderSearchResults(); else dialog.querySelector("#search-results").innerHTML = '<p class="note">Type a word to search.</p>';
}
function scheduleSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(() => void runSearch(), 180); }
async function runSearch() {
  const input = dialog.querySelector("#search-input");
  if (!input || !dialog.open) return;
  const query = input.value.trim(), id = projectId, seq = ++searchState.seq, version = dialogVersion, box = dialog.querySelector("#search-results");
  if (!query) { searchState = { ...searchState, project: id, query: "", terms: [], results: [], active: 0 }; box.innerHTML = '<p class="note">Type a word to search.</p>'; return; }
  box.setAttribute("aria-busy", "true");
  let reply = null, failure = null;
  try { reply = await api({ action: "search", id, query, limit: 30 }); } catch (error) { failure = error; }
  // A slower earlier query, a closed dialog or another project never overwrites the newest list.
  if (seq !== searchState.seq || version !== dialogVersion || id !== projectId || !box.isConnected) return;
  box.removeAttribute("aria-busy");
  if (failure) { searchState = { ...searchState, project: id, query, terms: [], results: [], active: 0 }; box.innerHTML = `<p class="note">${esc(failure.message.replace(/^Search query needs/, "Search needs"))}</p>`; return; }
  searchState = { ...searchState, project: id, query, terms: reply.terms, results: reply.results, active: 0 };
  renderSearchResults();
}
function searchWhere(hit) {
  switch (hit.source) {
    case "chat": return ["Chat", `${hit.chat}${hit.archived ? " (archived)" : ""} · ${hit.role === "user" ? (/^\[(Durable work|Child work|Owner-local event)/.test(hit.snippet) ? "Report" : "You") : "Coordinator"}`];
    case "worker": return [hit.child ? "Sub-agent" : "Worker", `${hit.label} · ${hit.role === "user" ? "Task" : "Worker"}`];
    case "knowledge": return ["Knowledge", hit.path];
    default: return ["File", hit.filename];
  }
}
function renderSearchResults() {
  const box = dialog.querySelector("#search-results");
  if (!box) return;
  const { results, terms, active } = searchState;
  box.innerHTML = results.length ? results.map((hit, i) => { const [kind, where] = searchWhere(hit); return `<button type="button" class="search-row${i === active ? " active" : ""}" role="option" aria-selected="${i === active}" data-action="search-open" data-i="${i}" data-source="${esc(hit.source)}"><span class="search-kind">${esc(kind)}</span><span class="search-where" title="${esc(where)}">${esc(where)}</span><small>${hit.at ? esc(when(hit.at)) : ""}</small><span class="search-snippet">${highlight(hit.snippet, terms)}</span></button>`; }).join("") : `<p class="note">No matches for “${esc(searchState.query)}”.</p>`;
  box.querySelector(".search-row.active")?.scrollIntoView({ block: "nearest" });
}
async function openSearchHit(i) {
  const hit = searchState.results[i], id = projectId;
  if (!hit || searchState.project !== id) return;
  const focus = { project: id, index: hit.index, terms: searchState.terms, offset: hit.offset, scrolled: false };
  // The dialog's close event lands a task later and bumps dialogVersion; let it pass before opening the target.
  if (dialog.open) { const closed = new Promise(resolve => dialog.addEventListener("close", resolve, { once: true })); closeDialog(); await closed; }
  if (id !== projectId) return;
  if (hit.source === "chat") {
    searchFocus = { ...focus, chat: hit.chatId };
    if (tab !== "coordinator") setTab("coordinator");
    if (hit.chatId === chatId && view?.chatId === chatId) { html.delete("#messages"); await refresh(); } else changeChat(hit.chatId);
  } else if (hit.source === "worker") {
    workerFocus = { ...focus, threadId: hit.threadId };
    await inspectThread(hit.threadId, Math.max(0, hit.index - 5));
  } else if (hit.source === "knowledge") await knowledgeRead(hit.path, focus);
  else await uploadOpen(hit.uploadId, focus);
}
function badge(value) { return `<span class="badge ${esc(value)}"><span class="dot"></span>${esc(value)}</span>`; }
function setHtml(selector, text) {
  const node = document.querySelector(selector), selection = document.getSelection();
  if (html.get(selector) === text || node.contains(document.activeElement) || selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) return;
  node.innerHTML = text; html.set(selector, text);
}
function admissionBlocked() { return !view || view.paused || view.project.archived || view.project.deleted || Boolean(currentChat()?.archived); }
function disableActions() {
  document.querySelectorAll('#letter button, #letter textarea, #questions textarea, .panel button').forEach(node => { node.disabled = busy || !view || node.hasAttribute('data-off'); }); // data-off: a picker button that is idle-disabled (nothing to save), not just busy
  document.querySelectorAll('#compose button, #compose textarea').forEach(node => { node.disabled = busy || admissionBlocked(); });
  document.querySelectorAll('#dialog button[type="submit"], #dialog [data-action="confirm-pause"], #dialog [data-action="confirm-resume"], #create').forEach(node => { node.disabled = busy || node.hasAttribute('data-off'); });
  document.querySelectorAll('[data-action="operation-decision"], [data-action="operation-execute"], [data-action="operation-inspect"]').forEach(node => {
    const record = operationCache.get(node.dataset.operation);
    node.disabled = busy || !view || view.project.archived || view.project.deleted || !record?.scopeCurrent;
  });
  // Stop stays available while paused (the host allows it); steer/send need an admitting project.
  document.querySelectorAll('#dialog [data-thread-mutation], #inline-thread [data-thread-mutation], [data-inline-thread-send] button, [data-inline-thread-send] textarea').forEach(node => { node.disabled = busy || (node.dataset.action === "thread-stop" ? !view || view.project.archived || view.project.deleted : admissionBlocked()); });
  document.querySelector('#lifecycle').hidden = !view;
  document.querySelector('#lifecycle-state').textContent = !view ? '' : view.project.deleted ? 'Deleted' : view.project.archived ? 'Archived' : view.paused ? 'Paused' : view.busy || plan?.work.some(work => work.status === 'running') ? 'Working' : 'Idle';
  document.querySelector('#lifecycle-state').dataset.state = document.querySelector('#lifecycle-state').textContent.toLowerCase();
  const pause = document.querySelector('#project-pause'), resume = document.querySelector('#project-resume');
  pause.hidden = !view || view.paused || view.project.archived || view.project.deleted; pause.disabled = busy || admissionBlocked();
  resume.hidden = !view?.paused || view.project.archived || view.project.deleted; resume.disabled = busy;
  document.querySelector('#paused-hint').hidden = !view?.paused || view.project.archived || view.project.deleted;
}

function uiFrame() { return { projectId, generation, dialogVersion }; }
class UiRequestError extends Error {
  constructor(error, frame, rejected = false) { super(error instanceof Error ? error.message : String(error)); this.frame = frame; this.rejected = rejected; }
}
async function api(input) {
  const frame = uiFrame();
  let rejected = false;
  try {
    if (!token) { showSignIn(); throw new Error("Paste your inbox link to sign in."); }
    const response = await fetch("/api", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) });
    if (response.status === 401) showSignIn();
    const reply = await response.json();
    rejected = reply?.ok === false;
    if (!response.ok || reply?.ok !== true) throw new Error(typeof reply?.error === "string" ? reply.error : `Host returned ${response.status}`);
    return reply.data;
  } catch (error) { throw new UiRequestError(error, frame, rejected); }
}
async function uiAction(action) {
  const frame = uiFrame();
  try { await action(); } catch (error) { report(error, error instanceof UiRequestError ? error.frame : frame); }
}

async function mutate(input, success) {
  if (busy) throw new Error("Another action is still pending. Your draft was kept.");
  busy = true; disableActions();
  try { const result = await api(input); toast(typeof success === "function" ? success(result) : success); if (input.id === projectId) { if (document.querySelector("#letter").contains(document.activeElement) || document.querySelector("#questions").contains(document.activeElement)) document.activeElement.blur(); await refresh(); } return result; }
  finally { busy = false; disableActions(); }
}

function showError(error) {
  const text = error instanceof Error ? error.message : String(error);
  document.querySelector("#connection").textContent = "Disconnected"; document.querySelector("#connection").dataset.state = "down";
  setError(`${text}. If the host restarted, run /projects-ui to reopen its current address.`, "connection");
}
function closeButton(key) { return `<button type="button" class="notice-close" data-dismiss="${esc(key)}" title="Dismiss" aria-label="Dismiss">✕</button>`; }
function setError(text, source) {
  const node = document.querySelector("#error"), key = `error:${text}`;
  node.dataset.source = source;
  node.innerHTML = `<div class="notice-row"><span>${esc(text)}</span>${closeButton(key)}</div>`; node.hidden = dismissed.has(key);
}
// ✕ on a notice: remember it, drop its row, and hide the box once empty. Not a data-action, so it works while busy.
document.addEventListener("click", event => {
  const button = event.target.closest("[data-dismiss]"); if (!button) return;
  dismissed.add(button.dataset.dismiss);
  try { sessionStorage.setItem(dismissKey, JSON.stringify([...dismissed].slice(-200))); } catch {}
  const box = button.closest("#error, #warning"); button.closest(".notice-row").remove();
  if (box && !box.querySelector(".notice-row")) box.hidden = true;
});
function toast(text) { clearTimeout(toastTimer); const node = document.querySelector("#toast"); node.textContent = text; node.classList.add("visible"); toastTimer = setTimeout(() => node.classList.remove("visible"), 4500); }
function esc(value) { return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function renderMarkdown(value, options = {}) {
  const inlineMarkdown = text => inlineRefsMarkdown(text, options.refs);
  const blocks = String(value ?? "").split(/```([^\n]*)\n([\s\S]*?)```/g);
  return blocks.map((part, index) => {
    if (index % 3 === 1) return "";
    if (index % 3 === 2 && /^(mermaid|flowchart)$/.test(blocks[index - 1].trim())) return `<pre class="mermaid-src" data-mermaid="${esc(blocks[index - 1].trim() === "flowchart" && !/^\s*(flowchart|graph)\b/.test(part) ? `flowchart TD\n${part}` : part)}"><code>${esc(part)}</code></pre>`;
    if (index % 3 === 2) return blocks[index - 1].trim() === "diff" ? `<pre class="diff"><code>${part.split("\n").map(line => `<span class="${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}">${esc(line)}</span>`).join("\n")}</code></pre>` : `<pre><code>${esc(part)}</code></pre>`;
    const lines = part.split("\n"), out = [];
    let list = null, quote = [];
    const flushList = () => { if (list) { out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.tag}>`); list = null; } };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`); quote = []; } };
    const cells = row => row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll("\\|", "|"));
    const separator = row => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(row ?? "");
    for (let at = 0; at < lines.length; at++) {
      const line = lines[at];
      // GFM table: a header row with pipes, then a --- separator row; body rows run until a line without a pipe.
      if (line.includes("|") && separator(lines[at + 1])) {
        flushList(); flushQuote();
        const head = cells(line), align = cells(lines[at + 1]).map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "");
        const cell = (tag, text, index) => `<${tag}${align[index] ? ` class="align-${align[index]}"` : ""}>${inlineMarkdown(text ?? "")}</${tag}>`;
        const body = [];
        for (at += 2; at < lines.length && lines[at].includes("|") && lines[at].trim(); at++) body.push(cells(lines[at]));
        at--;
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((text, index) => cell("th", text, index)).join("")}</tr></thead><tbody>${body.map(row => `<tr>${head.map((_, index) => cell("td", row[index], index)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line), unordered = /^\s*[-*]\s+(.+)$/.exec(line);
      if (ordered || unordered) { flushQuote(); const tag = ordered ? "ol" : "ul"; if (list?.tag !== tag) flushList(); if (!list) list = { tag, items: [], start: ordered ? Number(ordered[1]) : 1 }; list.items.push(ordered ? ordered[2] : unordered[1]); continue; }
      // Blank lines between items keep one list; indented lines continue the last item.
      if (list && !line.trim()) continue;
      if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
      flushList();
      const quoted = /^>\s?(.*)$/.exec(line);
      if (quoted) { quote.push(quoted[1]); continue; }
      flushQuote();
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) out.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      else if (line.trim()) out.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    flushList(); flushQuote(); return out.join("");
  }).join("");
}
if (initial.searchParams.get("e2e") === "1") window.__projectsRenderMarkdown = renderMarkdown;
// Mermaid fences first render as plain code blocks. The same-origin build loads on first use and swaps in the diagram; any failure leaves the code block.
const mermaidSvgs = new Map();
let mermaidLoad = null;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/mermaid.min.js";
    script.onload = () => { const api = globalThis.__esbuild_esm_mermaid_nm?.mermaid; resolve(api?.default ?? api); };
    script.onerror = () => { mermaidLoad = null; reject(new Error("Mermaid failed to load")); };
    document.head.append(script);
  });
  return mermaidLoad;
}
let mermaidSeq = 0, mermaidQueue = Promise.resolve();
function hydrateMermaid(root = document) {
  for (const node of root.querySelectorAll("pre[data-mermaid]:not([data-state])")) {
    const source = node.dataset.mermaid, dark = document.documentElement.dataset.theme === "dark", key = `${dark ? "d" : "l"}:${source}`;
    const show = svg => { if (!node.isConnected) return; const box = document.createElement("div"); box.className = "mermaid-diagram"; box.innerHTML = svg; node.replaceWith(box); };
    node.dataset.state = "pending";
    if (mermaidSvgs.has(key)) { const cached = mermaidSvgs.get(key); if (cached) show(cached); else node.dataset.state = "failed"; continue; }
    // Renders run one at a time: mermaid keeps global state while it lays out.
    mermaidQueue = mermaidQueue.then(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", suppressErrorRendering: true });
        const id = `mermaid-${++mermaidSeq}`;
        // Mermaid parks its work in <div id="d…"> (and the svg itself on a parse error); clear both before the diagram takes the svg's id.
        let svg = null;
        try { ({ svg } = await mermaid.render(id, source)); }
        finally { document.getElementById(`d${id}`)?.remove(); document.getElementById(id)?.remove(); }
        mermaidSvgs.set(key, svg); show(svg);
      } catch { mermaidSvgs.set(key, null); node.dataset.state = "failed"; }
    });
  }
}
new MutationObserver(() => hydrateMermaid()).observe(document.body, { childList: true, subtree: true });
// Artifact references become <img>/<video>/download links. Bytes are fetched once per page (token header, so no plain URLs) and cached as blob URLs.
const artifactBlobs = new Map();
const artifactKindOf = path => /\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : /\.(webm|mp4)$/i.test(path) ? "video" : "other";
const artifactUrl = (project, thread, path) => `/artifacts/${project}/${thread}/${path.split("/").map(encodeURIComponent).join("/")}`;
function artifactBlob(project, thread, path) {
  const key = `${project}/${thread}/${path}`;
  if (!artifactBlobs.has(key)) {
    if (artifactBlobs.size >= 300) { const [oldest, value] = artifactBlobs.entries().next().value; artifactBlobs.delete(oldest); void value.then(url => URL.revokeObjectURL(url), () => {}); }
    artifactBlobs.set(key, fetch(artifactUrl(project, thread, path), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) }).then(async response => { if (!response.ok) throw new Error(response.status === 404 ? "missing" : `unavailable (${response.status})`); return URL.createObjectURL(await response.blob()); }));
    artifactBlobs.get(key).catch(() => artifactBlobs.delete(key)); // a missing file may appear later
  }
  return artifactBlobs.get(key);
}
function hydrateArtifacts(root = document) {
  for (const node of root.querySelectorAll(".artifact-ref:not([data-state])")) {
    if (node.closest("details:not([open])")) continue;
    const thread = node.dataset.artifactThread, path = node.dataset.artifactPath, label = node.textContent, kind = artifactKindOf(path), project = projectId;
    if (!project) continue;
    // Other files (logs, archives, possibly huge) are fetched only when the owner clicks.
    if (!node.dataset.inline || kind === "other") { node.dataset.state = "link"; node.innerHTML = `<a href="#" class="artifact-link" title="${esc(path)}">${esc(label)}</a>`; continue; }
    node.dataset.state = "loading";
    artifactBlob(project, thread, path).then(url => {
      node.dataset.state = "ready";
      if (node.dataset.inline && kind === "image") node.innerHTML = `<img class="artifact-media" src="${url}" alt="${esc(label)}" title="${esc(path)}">`;
      else if (node.dataset.inline && kind === "video") node.innerHTML = `<video class="artifact-media" src="${url}" controls preload="metadata" title="${esc(path)}"></video>`;
      else node.innerHTML = `<a href="${url}" download="${esc(path.split("/").at(-1))}">${esc(label)}</a>`;
    }, error => { node.dataset.state = "missing"; node.innerHTML = `<span class="artifact-missing">${esc(label)} (${esc(error.message === "missing" ? "missing artifact" : error.message)})</span>`; });
  }
}
new MutationObserver(() => hydrateArtifacts()).observe(document.body, { childList: true, subtree: true });
// Images inside chat messages open larger in #lightbox; chrome images (status icons, logos, avatars) are not under .msg.
const lightbox = document.querySelector("#lightbox"), lightboxImg = lightbox.querySelector("img"), lightboxCaption = lightbox.querySelector("figcaption");
let lightboxOpener = null;
document.addEventListener("click", event => {
  const img = event.target.closest?.(".msg .text img");
  if (!img || !img.currentSrc) return;
  event.preventDefault();
  lightboxOpener = img; img.tabIndex = -1;
  lightboxImg.src = img.currentSrc; lightboxImg.alt = img.alt;
  lightboxCaption.textContent = img.alt; lightboxCaption.hidden = !img.alt;
  lightbox.showModal(); fitLightbox(); lightbox.querySelector(".lightbox-x").focus();
});
// Scale to the stage (90% of the viewport minus the caption) in both directions: CSS max-* alone would never enlarge a small image.
function fitLightbox() {
  const { naturalWidth: w, naturalHeight: h } = lightboxImg.naturalWidth ? lightboxImg : lightboxOpener ?? lightboxImg;
  if (!lightbox.open || !w || !h) return;
  const caption = lightboxCaption.hidden ? 0 : lightboxCaption.offsetHeight + 10;
  const scale = Math.min(innerWidth * 0.9 / w, (innerHeight * 0.9 - caption) / h);
  lightboxImg.style.width = `${Math.floor(w * scale)}px`; lightboxImg.style.height = `${Math.floor(h * scale)}px`;
}
addEventListener("resize", fitLightbox); lightboxImg.addEventListener("load", fitLightbox);
lightbox.addEventListener("click", event => { if (event.target === lightbox || event.target.closest(".lightbox-x") || event.target.tagName === "FIGURE") lightbox.close(); });
lightbox.addEventListener("close", () => { if (lightbox.open) return; /* stale event from a close that was followed by a reopen */ lightboxImg.removeAttribute("src"); lightboxImg.removeAttribute("style"); const back = lightboxOpener?.isConnected ? lightboxOpener : lightboxOpener && [...document.querySelectorAll(".msg .text img")].find(img => img.src === lightboxOpener.src); if (back) { back.tabIndex = -1; back.focus(); } lightboxOpener = null; });
document.addEventListener("click", event => {
  // In a worker chat, artifact links and images reveal the file in the browser column instead of downloading.
  const ref = event.target.closest?.("#worker-messages .artifact-ref:not([data-state=missing])");
  if (ref && workerChat?.threadId === ref.dataset.artifactThread && !event.target.closest("video, img")) { event.preventDefault(); void selectArtifact(ref.dataset.artifactPath); return; }
  const link = event.target.closest?.(".artifact-ref[data-state=link] .artifact-link");
  if (!link) return;
  event.preventDefault();
  const node = link.closest(".artifact-ref"), path = node.dataset.artifactPath;
  artifactBlob(projectId, node.dataset.artifactThread, path).then(url => { const a = document.createElement("a"); a.href = url; a.download = path.split("/").at(-1); a.click(); }, error => { node.dataset.state = "missing"; node.innerHTML = `<span class="artifact-missing">${esc(node.textContent)} (${esc(error.message === "missing" ? "missing artifact" : error.message)})</span>`; });
});
document.addEventListener("toggle", event => { if (event.target.open) hydrateArtifacts(event.target); }, true);
// Activity artifact browser (right column): folder tree of the selected worker's artifacts folder plus a preview. File content is untrusted: text is escaped or goes through renderMarkdown, never injected as HTML.
const ARTIFACT_TEXT_CAP = 512 * 1024, ARTIFACT_MEDIA_CAP = 100 * 1048576;
let artifactBrowser = null, artifactSort = "new";
const fmtBytes = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const agoCoarse = ms => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const artifactPreviewKind = file => file.kind === "image" || file.kind === "video" ? file.kind : /\.(md|markdown)$/i.test(file.path) ? "markdown" : /\.jsonl?$/i.test(file.path) ? "json" : file.kind === "text" ? "text" : "other";
const artifactCurrent = () => workerChat && artifactBrowser?.project === workerChat.id && artifactBrowser.thread === workerChat.threadId ? artifactBrowser : null;
function artifactState(chat) {
  if (!artifactBrowser || artifactBrowser.project !== chat.id || artifactBrowser.thread !== chat.threadId) {
    artifactBrowser = { project: chat.id, thread: chat.threadId, files: null, listing: null, error: null, selected: null, filter: "", collapsed: new Set(), fresh: new Map() };
    document.querySelector("#artifact-filter").value = "";
  }
  return artifactBrowser;
}
async function artifactText(project, thread, path) {
  const response = await fetch(artifactUrl(project, thread, path), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(response.status === 404 ? "missing" : `unavailable (${response.status})`);
  const reader = response.body.getReader(), chunks = []; let total = 0, truncated = false;
  while (total < ARTIFACT_TEXT_CAP) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  if (total >= ARTIFACT_TEXT_CAP) truncated = true;
  reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(total, ARTIFACT_TEXT_CAP)); let at = 0;
  for (const part of chunks) { const piece = part.subarray(0, bytes.length - at); bytes.set(piece, at); at += piece.length; }
  return { text: new TextDecoder().decode(bytes), truncated };
}
function artifactTreeHtml(b) {
  const query = b.filter.trim().toLowerCase(), root = { dirs: new Map(), files: [], newest: 0 };
  for (const file of b.files) {
    if (query && !file.path.toLowerCase().includes(query)) continue;
    let node = root; root.newest = Math.max(root.newest, file.mtimeMs);
    const parts = file.path.split("/");
    for (const dir of parts.slice(0, -1)) { if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [], newest: 0 }); node = node.dirs.get(dir); node.newest = Math.max(node.newest, file.mtimeMs); }
    node.files.push(file);
  }
  const byName = (x, y) => x.localeCompare(y, undefined, { numeric: true });
  const rows = (node, prefix) => {
    const dirs = [...node.dirs].toSorted(([a, x], [c, y]) => artifactSort === "name" ? byName(a, c) : y.newest - x.newest || byName(a, c));
    const files = node.files.toSorted((x, y) => artifactSort === "name" ? byName(x.path, y.path) : y.mtimeMs - x.mtimeMs || byName(x.path, y.path));
    return dirs.map(([name, child]) => {
      const path = `${prefix}${name}`, open = Boolean(query) || !b.collapsed.has(path);
      return `<div class="artifact-dir"><button data-action="artifact-dir" data-dir="${esc(path)}" aria-expanded="${open}" title="${esc(path)}"><span class="af-caret">${open ? "▾" : "▸"}</span><b>${esc(name)}/</b></button>${open ? `<div class="artifact-children">${rows(child, `${path}/`)}</div>` : ""}</div>`;
    }).join("") + files.map(file => `<button class="artifact-file${file.path === b.selected ? " on" : ""}${Date.now() - (b.fresh.get(file.path) ?? 0) < 4000 ? " fresh" : ""}" data-action="artifact-select" data-path="${esc(file.path)}" title="${esc(file.path)}"><span class="af-kind">${esc(file.kind)}</span><span class="af-name">${esc(file.path.split("/").at(-1))}</span><small>${esc(fmtBytes(file.size))} · ${esc(agoCoarse(file.mtimeMs))}</small></button>`).join("");
  };
  return rows(root, "") || '<p class="note">No files match the filter.</p>';
}
function renderArtifactBrowser() {
  const pane = document.querySelector("#artifact-pane"), b = artifactCurrent(), tree = document.querySelector("#artifact-tree"), summary = document.querySelector("#artifact-summary"), filter = document.querySelector("#artifact-filter");
  if (!pane) return;
  const set = (node, html) => { if (node.dataset.content !== html) { node.innerHTML = html; node.dataset.content = html; } };
  document.querySelector("#artifact-sort").textContent = artifactSort === "name" ? "Name" : "Newest";
  const count = document.querySelector("#artifact-count"); if (count) count.textContent = b?.files?.length ? `(${b.files.length})` : "";
  filter.hidden = !b?.files?.length;
  if (!b) { summary.textContent = ""; set(tree, '<p class="note artifact-empty">Loading artifacts…</p>'); renderArtifactPreview(null); return; }
  const listing = b.listing;
  summary.textContent = b.files?.length ? `${b.files.length} file(s) · ${fmtBytes(listing.totalBytes)}${listing.overCap ? ` · over the ${fmtBytes(listing.capBytes)} cap` : ""}${listing.truncated ? " · list truncated" : ""}${listing.skipped?.length ? ` · ${listing.skipped.length} skipped (symlinks)` : ""}` : "";
  set(tree, b.error ? `<p class="note">Artifacts unavailable: ${esc(b.error)}</p>` : !b.files ? '<p class="note">Loading artifacts…</p>' : !b.files.length ? '<p class="note artifact-empty">No artifacts yet. Files this worker saves to its artifacts folder appear here.</p>' : artifactTreeHtml(b));
  renderArtifactPreview(b);
}
function renderArtifactPreview(b) {
  const node = document.querySelector("#artifact-preview"), file = b?.files?.find(item => item.path === b.selected);
  if (!file) { node.hidden = true; if (node.dataset.key) { node.dataset.key = ""; node.replaceChildren(); } return; }
  const key = `${b.thread}/${file.path}:${file.mtimeMs}:${file.size}`;
  if (node.dataset.key === key) return;
  node.dataset.key = key; node.hidden = false;
  const kind = artifactPreviewKind(file), project = b.project, thread = b.thread;
  node.innerHTML = `<div class="row between artifact-meta"><b class="mono" title="${esc(file.path)}">${esc(file.path)}</b><button class="ghost small" data-action="artifact-deselect" aria-label="Close preview">✕</button></div><small class="note">${esc(fmtBytes(file.size))} · ${esc(new Date(file.mtimeMs).toLocaleString())} · ${esc(file.mime)}</small><div class="row artifact-actions"><button class="small" data-action="artifact-download">Download</button><button class="small" data-action="artifact-open">Open in new tab</button></div><div class="artifact-body" id="artifact-body"><p class="note">Loading…</p></div>`;
  const body = node.querySelector("#artifact-body"), live = () => node.dataset.key === key && body.isConnected;
  const show = html => { if (live()) body.innerHTML = html; };
  const failed = error => show(`<p class="artifact-missing">${esc(error.message === "missing" ? "This file no longer exists." : error.message)}</p>`);
  if (kind === "other") return show('<p class="note">No preview for this file type. Download it to inspect.</p>');
  if ((kind === "image" || kind === "video") && file.size > ARTIFACT_MEDIA_CAP) return show(`<p class="note">Too large to preview inline (${esc(fmtBytes(file.size))}). Download it instead.</p>`);
  if (kind === "image" || kind === "video") return void artifactBlob(project, thread, file.path).then(url => show(kind === "image" ? `<img class="artifact-media" src="${url}" alt="${esc(file.path)}">` : `<video class="artifact-media" src="${url}" controls preload="metadata"></video>`), failed);
  artifactText(project, thread, file.path).then(({ text, truncated }) => {
    let shown = text;
    if (kind === "json" && !truncated) { try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* JSON lines or invalid: keep the raw text */ } }
    show(`${truncated ? `<p class="note">Showing the first ${esc(fmtBytes(ARTIFACT_TEXT_CAP))} of ${esc(fmtBytes(file.size))}. Use Download for the full file.</p>` : ""}${kind === "markdown" ? `<div class="doc-view artifact-md">${renderMarkdown(text)}</div>` : `<pre class="artifact-text">${esc(shown)}</pre>`}`);
  }, failed);
}
async function loadWorkerArtifacts(chat, force = false) {
  if (!force && Date.now() - (chat.artifactsAt ?? 0) < 4000) return;
  chat.artifactsAt = Date.now();
  const b = artifactState(chat);
  const listing = await api({ action: "artifacts-list", id: chat.id, threadId: chat.threadId }).catch(error => ({ error: error.message }));
  if (workerChat !== chat || artifactBrowser !== b) return;
  if (listing.error) b.error = listing.error;
  else {
    b.error = null;
    if (b.files) { const known = new Map(b.files.map(file => [file.path, file.mtimeMs])); for (const file of listing.files) if (known.get(file.path) !== file.mtimeMs) b.fresh.set(file.path, Date.now()); }
    b.files = listing.files; b.listing = listing;
    if (b.selected && !b.files.some(file => file.path === b.selected)) b.selected = null;
  }
  renderArtifactBrowser();
}
// Chat links and the file list both land here: reveal the file in the tree and preview it.
async function selectArtifact(path) {
  const chat = workerChat; if (!chat) return;
  const b = artifactState(chat);
  if (matchMedia("(max-width: 1199px)").matches) document.querySelector("#artifact-pane").classList.add("open");
  if (!b.files?.some(file => file.path === path)) await loadWorkerArtifacts(chat, true);
  if (workerChat !== chat || !b.files?.some(file => file.path === path)) return;
  const parts = path.split("/"); for (let i = 1; i < parts.length; i++) b.collapsed.delete(parts.slice(0, i).join("/"));
  b.selected = path; b.filter = ""; document.querySelector("#artifact-filter").value = "";
  renderArtifactBrowser();
  document.querySelector("#artifact-tree .artifact-file.on")?.scrollIntoView({ block: "nearest" });
}
document.addEventListener("input", event => { if (event.target.id === "artifact-filter") { const b = artifactCurrent(); if (b) { b.filter = event.target.value; renderArtifactBrowser(); } } });
function artifactAction(action, node) {
  const b = artifactCurrent(); if (!b) return;
  if (action === "artifact-dir") { const dir = node.dataset.dir; b.collapsed.has(dir) ? b.collapsed.delete(dir) : b.collapsed.add(dir); }
  else if (action === "artifact-select") return void selectArtifact(node.dataset.path);
  else if (action === "artifact-deselect") b.selected = null;
  else if (action === "artifacts-sort") artifactSort = artifactSort === "new" ? "name" : "new";
  else if (action === "artifact-download" || action === "artifact-open") {
    const path = b.selected;
    return void artifactBlob(b.project, b.thread, path).then(url => { const a = document.createElement("a"); a.href = url; if (action === "artifact-open") { a.target = "_blank"; a.rel = "noopener"; } else a.download = path.split("/").at(-1); a.click(); }, error => toast(error.message));
  }
  renderArtifactBrowser();
}
function inlineRefsMarkdown(value, refs) {
  const code = [];
  let text = esc(value).replace(/`([^`]+)`/g, (_, body) => { const key = `\u0000${code.length}\u0000`; code.push(`<code>${body}</code>`); return key; });
  // Worker artifacts: ![caption](artifact:<thread>/<path>) inline (images, videos), [name](artifact:…) as a download; hydrated by hydrateArtifacts().
  text = text.replace(/(!?)\[([^\]]*)\]\(artifact:([a-f0-9-]{36})\/([^)\s]+)\)/g, (all, bang, label, thread, escapedPath) => {
    const path = escapedPath.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (path.split("/").some(part => !part || part === "." || part === "..")) return all;
    const key = `\u0000${code.length}\u0000`;
    code.push(`<span class="artifact-ref" data-artifact-thread="${thread}" data-artifact-path="${esc(path)}" data-inline="${bang ? "1" : ""}">${label || esc(path)}</span>`);
    return key;
  });
  const hold = html => { const key = `\u0000${code.length}\u0000`; code.push(html); return key; };
  // External images are links, never loaded: a prompt-injected image URL must not leak data by being fetched.
  text = text.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (all, label, escapedHref) => {
    try { const url = new URL(unesc(escapedHref)); return ["http:", "https:", "mailto:"].includes(url.protocol) ? hold(`<a href="${esc(url.href)}" rel="noopener noreferrer" target="_blank">${label}</a>`) : label; } catch { return label; }
  });
  text = text.replace(/https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s\u0000])+/g, all => {
    const href = all.replace(/[.,;:!?)\]]+$/, ""), tail = all.slice(href.length);
    try { const url = new URL(unesc(href)); return hold(`<a href="${esc(url.href)}" rel="noopener noreferrer" target="_blank">${href}</a>`) + tail; } catch { return all; }
  });
  if (refs) text = text.replace(refHtmlPattern, (all, skill, kind, quoted, bare, pr) => hold(refChipHtml(all, skill, kind, quoted, bare, pr, refs)));
  const ticket = ticketTemplate();
  if (ticket) text = text.replace(/(?<![\w/.-])([A-Z][A-Z0-9]{1,15})-([1-9]\d{0,7})(?![\w-])/g, (all, queue) => NOT_TICKETS.has(queue) ? all : hold(`<a class="ref-chip ref-ticket" href="${esc(ticket.replace("{key}", all))}" target="_blank" rel="noopener noreferrer" title="Open ${all}">${refIcons.issue}<span>${all}</span></a>`));
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}
function closeDialog() { captureDialogDraft(); answerAdoption = null; routineConfirmation = null; uploadConfirmations.clear(); settingsConfirmation = null; providerInspection = null; dialogVersion++; if (dialog.open) dialog.close(); if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; }
function showDialog(title, content, subtitle = "") { closeDialog(); dialog.innerHTML = `<header class="dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${subtitle ? `<p class="dialog-sub">${esc(subtitle)}</p>` : ""}</div><button type="button" data-action="close-dialog" class="ghost small dialog-x" aria-label="Close" title="Close (Esc)">✕</button></header><div class="dialog-body">${content}</div>`; dialog.showModal(); return dialogVersion; }
// Shared pieces of the Settings dialogs: sticky footer, buttons, pager, tabs, plain record summaries with raw JSON only inside a collapsed Details.
const setDialogBody = html => { dialog.querySelector(".dialog-body").innerHTML = html; disableActions(); };
const dlgBtn = (label, data = {}, cls = "") => `<button type="button"${cls ? ` class="${cls}"` : ""}${Object.entries(data).map(([key, value]) => ` data-${key}="${esc(value)}"`).join("")}>${label}</button>`;
const dlgActions = (...parts) => `<div class="dialog-actions">${parts.join("")}</div>`;
const rawDetails = (value, label = "Technical details") => `<details class="raw"><summary>${esc(label)}</summary><pre>${esc(JSON.stringify(value, null, 2) ?? "")}</pre></details>`;
const humanKey = key => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/^./, char => char.toUpperCase());
const idLike = text => /^[a-f0-9-]{36,64}$/.test(text);
function recordSummary(record, skip = []) {
  const rows = Object.entries(record).filter(([key, value]) => !skip.includes(key) && value !== null && value !== undefined && typeof value !== "object").map(([key, value]) => {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    return `<span>${esc(humanKey(key))}</span><b${idLike(text) ? ` class="mono" title="${esc(text)}"` : ""}>${esc(idLike(text) && text.length > 40 ? `${text.slice(0, 12)}…` : text)}</b>`;
  }).join("");
  return `${rows ? `<div class="kv tight">${rows}</div>` : ""}${rawDetails(record)}`;
}
const compactTokens = count => !Number.isFinite(count) || count <= 0 ? "" : count >= 1e6 ? `${+(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${Math.round(count / 1e3)}k` : String(count);
const stateChip = (text, tone = "") => `<span class="state-chip ${tone}">${esc(text)}</span>`;
function pager({ offset, count, total, size, data }) {
  const prev = offset > 0 ? Math.max(0, offset - size) : null, next = offset + count < total ? offset + count : null;
  if (prev === null && next === null) return total > 0 ? `<span class="pager">${total} in total</span>` : "";
  return `<span class="pager">${prev === null ? "" : dlgBtn("‹ Previous", { ...data, offset: prev }, "small")}<span>${offset + (count ? 1 : 0)}–${offset + count} of ${total}</span>${next === null ? "" : dlgBtn("Next ›", { ...data, offset: next }, "small")}</span>`;
}
const segTabs = items => `<div class="skill-tabs" role="group">${items.map(([label, data, on]) => `<button type="button"${on ? ' class="on"' : ""} aria-pressed="${on ? "true" : "false"}"${Object.entries(data).map(([key, value]) => ` data-${key}="${esc(value)}"`).join("")}>${label}</button>`).join("")}</div>`;

async function inspectArtifact(id) {
  const file = view?.evidence.find(file => file.id === id);
  if (!file) throw new Error("Evidence no longer belongs to the selected project");
  validateLibraryRecord(file, projectId); libraryCache.set(file.id, file);
  await libraryOpen(file.id, file.sha256);
}

function createDialog() {
  if (!creationDrafts.size) { newCreationDraft(); return; }
  showDialog("Retained creation drafts", `<p>Unknown outcomes cannot be resubmitted. Inspect the project list before explicitly starting a separate new draft. Draft UUIDs are client identities, not backend idempotency receipts.</p><button data-action="creation-new">Start a separate new draft</button>${[...creationDrafts].map(([id, draft]) => `<article class="task"><strong>${esc(draft.name || "Unnamed draft")}</strong><p>${esc(draft.outcome)} ${draft.createdId ? `· created project ${esc(draft.createdId)}` : ""}</p><button data-action="creation-edit" data-draft="${esc(id)}">Inspect ${draft.outcome === "draft" ? "/ edit" : "retained outcome"}</button>${draft.outcome === "created" ? `<button data-action="creation-dismiss" data-draft="${esc(id)}">Dismiss known-success client entry</button>` : ""}</article>`).join("")}`);
}
function newCreationDraft() {
  captureDialogDraft();
  const id = crypto.randomUUID();
  creationDrafts.set(id, { name: "", cwd: "", objective: "", outcome: "draft", createdId: null, requestBound: true });
  persistBrowserDrafts(); creationEdit(id);
}
function creationEdit(id) {
  const draft = creationDrafts.get(id);
  if (!draft) throw new Error("Unknown retained creation draft");
  if (draft.outcome !== "draft") {
    showDialog("Retained creation outcome", `<p>${draft.outcome === "created" ? `Project ${esc(draft.createdId)} was created. Open its known UUID; do not recreate it.` : draft.requestBound === true ? `Creation outcome is unknown. An explicitly confirmed exact retry uses bound request/project UUID ${esc(id)}, without restoring or resuming it.` : "Old creation outcome is unbound. This draft cannot be resubmitted. Inspect the owned project list before starting any separate creation."}</p><pre>${esc(JSON.stringify({ name: draft.name, cwd: draft.cwd, objective: draft.objective }, null, 2))}</pre>${draft.outcome === "unknown" && draft.requestBound === true ? `<form data-create data-draft="${esc(id)}" data-retry="true"><label class="checkbox"><input name="trusted" type="checkbox" required><span>Retry exactly this stored creation request using the same UUID and inputs. Do not restore, resume or replace any existing project.</span></label><button type="submit">Retry the exact bound request</button></form>` : ""}<button data-action="creation-list">Back to retained drafts</button>`);
    return;
  }
  showDialog("New project", `<form data-create data-draft="${esc(id)}"><label><span>Project name</span><input name="name" maxlength="120" value="${esc(draft.name)}" required></label><label><span>Folder</span><input name="cwd" maxlength="32000" value="${esc(draft.cwd)}" placeholder="/Users/you/Projects/my-app" required></label><label><span>Objective <small>(optional)</small></span><textarea name="objective" maxlength="32000" rows="3" placeholder="What should the coordinator help you achieve?">${esc(draft.objective)}</textarea></label><label class="checkbox"><input name="trusted" type="checkbox" required><span>I trust this folder. Workers still need separate permission to edit code or publish.</span></label><button class="primary" type="submit">Create project</button></form>`);
  dialog.querySelector("input").focus();
}
function captureCreationDraft() {
  const form = dialog.querySelector("[data-create]"), draft = form && creationDrafts.get(form.dataset.draft);
  if (!draft || draft.outcome !== "draft") return;
  for (const field of ["name", "cwd", "objective"]) draft[field] = form.elements.namedItem(field).value;
}

async function resumeDialog() {
  const id = projectId;
  const version = showDialog("Resume this project?", '<p class="note">Reading the saved plan…</p>');
  const plan = await api({ action: "plan-snapshot", id });
  if (!dialog.open || version !== dialogVersion || id !== projectId) return;
  dialog.querySelector(".dialog-body").innerHTML = `<details><summary>Saved plan</summary><pre>${esc(JSON.stringify(plan, null, 2))}</pre></details><p>Resume restarts work the pause interrupted, on the same threads and worktrees. Stopped and failed work stays as it is.</p><form data-resume-project data-project="${esc(id)}"><input type="hidden" name="confirm" value="${esc(id)}"><button type="submit" class="primary">Resume and continue work</button></form><hr><p class="note">A project with no prior work can resume without confirmation.</p><button data-action="confirm-resume" data-project="${esc(id)}">Resume idle project</button>`;
  disableActions();
}

function textDialog(mode, id) {
  captureDialogDraft();
  const project = projectId, draftKey = `${project}:${mode}:${id}`;
  const draft = formDrafts.get(draftKey) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
  formDrafts.set(draftKey, draft);
  const title = mode === "thread-send" ? "Follow up on this thread" : "Steer this thread";
  showDialog(title, `<form data-task-message data-project="${esc(project)}" data-draft-key="${esc(draftKey)}" data-mode="${esc(mode)}" data-id="${esc(id)}"><textarea name="message" aria-label="${title}" placeholder="Describe the instruction…" maxlength="32000" required>${esc(draft.text)}</textarea><div class="row signoff"><button class="primary" type="submit">Send</button></div><p class="notice signoff">${mode.startsWith("thread-") ? `This reuses the owned thread with frozen scope/model/tools. Request UUID ${esc(draft.requestId)}. Unresolved retries must keep the same text.` : ""}</p></form>`);
  dialog.querySelector("textarea").focus();
}

async function action(node) {
  if (["answer", "answer-adopt"].includes(node.dataset.action)) requireProject(node.dataset.project);
  const entry = view?.inbox.find(item => item.id === node.dataset.entry);
  const owner = uiPlugins.find(plugin => node.dataset.action?.startsWith(`${plugin.name}-`));
  if (owner) { await owner.action(node.dataset.action, node); return; }
  switch (node.dataset.action) {
    case "select": selected = node.dataset.entry; document.activeElement.blur(); render(); break;
    case "event-page": {
      const delta = Number(node.dataset.offset), id = projectId, current = generation;
      eventOffset = node.dataset.offset === "0" ? 0 : Math.max(0, eventOffset + delta);
      observability = null;
      await loadObservability();
      if (id !== projectId || current !== generation) return;
      break;
    }
    case "creation-list": createDialog(); break;
    case "creation-new": newCreationDraft(); break;
    case "creation-edit": creationEdit(node.dataset.draft); break;
    case "creation-dismiss": {
      const draft = creationDrafts.get(node.dataset.draft);
      if (!draft || draft.outcome !== "created" || !uuid(draft.createdId)) throw new Error("Only known-success creation entries may be dismissed");
      creationDrafts.delete(node.dataset.draft); persistBrowserDrafts(); createDialog(); break;
    }
    case "answer-adopt": {
      if (entry?.kind !== "question" || entry.result || !answers.has(entry.id)) throw new Error("No retained unbound draft for this pending question");
      const key = answerKey(projectId, entry.id), text = answers.get(entry.id);
      if (answers.has(key)) throw new Error("A project-bound draft already exists; it will not be overwritten");
      const version = showDialog("Adopt this old answer draft?", `<p>Target project ${esc(projectId)}, question ${esc(entry.id)}: ${esc(entry.title)}.</p><pre>${esc(text)}</pre><form data-answer-adopt data-project="${esc(projectId)}" data-entry="${esc(entry.id)}"><input type="hidden" name="confirm" value="${esc(projectId)}"><button type="submit">Copy draft only, do not send</button></form>`);
      answerAdoption = { projectId, entryId: entry.id, text, version }; break;
    }
    case "questions-jump": document.querySelector("#questions").scrollIntoView({ block: "center", behavior: scrollBehavior() }); document.querySelector("#questions .question-card textarea")?.focus({ preventScroll: true }); break;
    case "answer": {
      const index = Number(node.dataset.choice);
      if (entry?.kind !== "question" || entry.result || !Number.isSafeInteger(index) || index < 0 || index >= entry.choices.length || entry.choices[index] !== node.dataset.choiceText) throw new Error("Displayed choice changed or question is resolved; refresh and choose again");
      await mutate({ action: "answer", id: node.dataset.project, entry: entry.id, text: node.dataset.choiceText }, "Answer sent to the coordinator."); break;
    }
    case "work-archive": {
      const work = plan?.work.find(item => item.id === node.dataset.work);
      if (node.dataset.project !== projectId || !work || work.archived) throw new Error("Displayed work changed; refresh before archiving");
      await mutate({ action: "work-archive", id: projectId, workIds: [work.id] }, "Work archived. Record and thread kept."); break;
    }
    case "retry-message": {
      const job = view.jobs.find(item => item.id === node.dataset.job);
      if (node.dataset.project !== projectId || !job || !["failed", "interrupted"].includes(job.state)) throw new Error("Displayed failed message changed; refresh before retrying");
      node.disabled = true; // a second click must not resend
      await mutate({ action: "message", id: projectId, text: job.text, ...(chatId === "main" ? {} : { chatId }) }, "Message resent to the coordinator."); break;
    }
    case "chat-select": if (dialog.contains(node)) closeDialog(); changeChat(node.dataset.chat); break;
    case "chat-new": {
      const id = projectId, created = await mutate({ action: "chat-create", id }, "New chat opened. It shares this project's workers and knowledge.");
      if (id === projectId) changeChat(created.id);
      break;
    }
    case "chat-rename": {
      const chat = currentChat(); if (!chat) throw new Error("Chat list is still loading");
      showDialog("Rename chat", `<form data-chat-rename data-project="${esc(projectId)}" data-chat="${esc(chat.id)}"><label>Title<input name="title" maxlength="120" required value="${esc(chat.title)}"></label><div class="row"><button type="submit" class="primary">Rename</button></div></form>`);
      document.querySelector("#dialog form[data-chat-rename] input").select();
      break;
    }
    case "chat-archive": {
      const chat = currentChat(); if (!chat || chat.id === "main") throw new Error("Main cannot be archived");
      await mutate({ action: "chat-update", id: projectId, chatId: chat.id, archived: true }, "Chat archived. Its history is kept.");
      changeChat("main"); break;
    }
    case "chat-restore": {
      const target = node.dataset.chat;
      await mutate({ action: "chat-update", id: projectId, chatId: target, archived: false }, "Chat restored.");
      changeChat(target); break;
    }
    case "thread-list": threadList(); break;
    case "all-work": {
      allWork = !allWork;
      node.blur();
      render();
      document.querySelector("#activity [data-action=all-work]")?.focus({ preventScroll: true });
      break;
    }
    case "history-earlier": node.blur(); await showEarlier(); break;
    case "jump-latest": searchFocus = null; stickToBottom = true; followTranscript(); renderWorkingPill(); break;
    case "skill-pick": pickMenuItem(skillMenu?.items.find(item => item.name === node.dataset.name && item.source === node.dataset.source) ?? { name: node.dataset.name }); break;
    case "ref-pick": { const item = refMenu?.items[Number(node.dataset.index)]; if (item) pickRef(item); break; }
    case "ref-open": await refOpen(node.dataset.kind, node.dataset.value); break;
    case "pr-pick": pickPr(prMenu.items.find(item => item.provider === node.dataset.provider && String(item.id) === node.dataset.pr)?.ref ?? `#${node.dataset.pr}`); break;
    case "prs-refresh": await loadPrs(true); break;
    case "pr-hide": { await api({ action: "pr-hide", id: projectId, provider: node.dataset.provider, pr: node.dataset.pr, hide: node.dataset.hide === "true" }); prsState.at = 0; await loadPrs(); break; }
    case "pr-watch": { const on = node.getAttribute("aria-pressed") !== "true"; await api({ action: "pr-watch", id: projectId, provider: node.dataset.provider, pr: node.dataset.pr, watch: on }); prsState.at = 0; await loadPrs(); break; }
    case "artifact-dir": case "artifact-select": case "artifact-deselect": case "artifacts-sort": case "artifact-download": case "artifact-open": artifactAction(node.dataset.action, node); break;
    case "limits-refresh": {
      if (limitsRefreshing) break;
      limitsRefreshing = true; renderLimits();
      try { const loaded = await api({ action: "limits-refresh" }); if (loaded?.providers) limits = loaded; } catch (error) { report(error); } finally { limitsRefreshing = false; renderLimits(); }
      break;
    }
    case "cursor-connect": {
      const started = await api({ action: "cursor-connect" });
      const cursor = limits?.providers.find(item => item.provider === "cursor");
      if (cursor) { cursor.connect = started; renderLimits(); }
      if (started.loginUrl) window.open(started.loginUrl, "_blank", "noopener,noreferrer");
      scheduleLimitsWatch();
      break;
    }
    case "thread-close": if (history.state?.worker) history.back(); else { closeWorkerDetail(); ensureChanges(); dialogVersion++; renderArtifactBrowser(); render(); } break;
    case "toggle-clamp": node.classList.toggle("clamp"); break;
    case "provider-list": await providerList(node.dataset.kind ?? "reads", Number(node.dataset.offset ?? 0)); break;
    case "provider-record": requireProject(node.dataset.project); providerRecord(node.dataset.record); break;
    case "provider-fresh": requireProject(node.dataset.project); await providerFresh(node.dataset.record); break;
    case "provider-inspect": requireProject(node.dataset.project); providerInspect(node.dataset.record); break;
    case "provider-known": providerKnown(); break;
    case "routine-list": if (node.dataset.project) requireProject(node.dataset.project); await routineList(node.dataset.lens ?? "schedules", Number(node.dataset.offset ?? 0)); break;
    case "routine-history": requireProject(node.dataset.project); await routineHistory(node.dataset.kind, Number(node.dataset.offset ?? 0), Number(node.dataset.textOffset ?? 0)); break;
    case "routine-confirm": requireProject(node.dataset.project); routineConfirm(node.dataset.kind, node.dataset.record, node.dataset.enabled); break;
    case "usage-list": await usageList(Number(node.dataset.offset ?? 0)); break;
    case "lifecycle-more": lifecycleMore(); break;
    case "lifecycle-confirm": lifecycleConfirm(node.dataset.project, node.dataset.operation); break;
    case "open-retained": showDialog("Open known retained project", '<p>Enter an owned project UUID to inspect retained state, including projects removed from the ordinary list. This does not restore/resume it.</p><form data-open-retained><label>Known project UUID<input name="id" required maxlength="36" autocomplete="off"></label><button type="submit">Open retained metadata</button></form>'); break;
    case "settings-list": await settingsList(); break;
    case "automation-refresh": await loadEventsIn(true); break;
    case "telegram-save": { const input = document.querySelector("#telegram-token"), token = input.value.trim(); input.value = ""; if (!token) throw new Error("Paste the bot token first"); await telegramAction({ action: "telegram-token", token }, "Telegram bot saved."); break; }
    case "telegram-pair": await telegramAction({ action: "telegram-pair" }); break;
    case "telegram-unpair": await telegramAction({ action: "telegram-unpair" }, "Telegram chat unpaired."); break;
    case "telegram-remove": {
      if (!telegramRemoveArmed) { telegramRemoveArmed = true; renderTelegram(); setTimeout(() => { if (telegramRemoveArmed) { telegramRemoveArmed = false; renderTelegram(); } }, 6000); break; }
      telegramRemoveArmed = false; await telegramAction({ action: "telegram-remove", confirm: "remove" }, "Telegram bot removed."); break;
    }
    case "remote-pair": { const pairing = await remoteAction({ action: "remote-pair-start" }); if (pairing) remotePairing = pairing; await loadRemote(); break; }
    case "remote-pair-cancel": await remoteAction({ action: "remote-pair-cancel" }); remotePairing = null; await loadRemote(); break;
    case "remote-copy-link": if (remotePairing) { await navigator.clipboard.writeText(remotePairing.link); toast("Pairing link copied. It works once."); } break;
    case "remote-rename": remoteRenaming = node.dataset.device; renderRemote(); break;
    case "remote-rename-cancel": remoteRenaming = null; renderRemote(); break;
    case "remote-rename-save": { const name = document.querySelector("#remote-rename").value.trim(); if (!name) throw new Error("Name the device first"); remoteRenaming = null; await remoteAction({ action: "remote-rename", deviceId: node.dataset.device, name }); await loadRemote(); break; }
    case "remote-revoke": {
      const id = node.dataset.device;
      if (remoteRevokeArmed !== id) { remoteRevokeArmed = id; renderRemote(); setTimeout(() => { if (remoteRevokeArmed === id) { remoteRevokeArmed = null; renderRemote(); } }, 6000); break; }
      remoteRevokeArmed = null; await remoteAction({ action: "remote-revoke", deviceId: id, confirm: id }, "Device revoked."); await loadRemote(); break;
    }
    case "automation-save": await saveEventsIn(); break;
    case "worktree-setup-save": await saveWorktreeSetup(); break;
    case "worktrees-cleanup": await cleanupWorktreesNow(); break;
    case "worktrees-refresh": await loadWorktrees(true); break;
    case "context-save": await saveContextSettings(false); break;
    case "context-reset": await saveContextSettings(true); break;
    case "compact-now": await compactNow(); break;
    case "prompt-save": await savePrompt(node.dataset.role, false); break;
    case "prompt-reset": await savePrompt(node.dataset.role, true); break;
    case "composer-help": toggleComposerHelp(node); break;
    case "skills-tab": skillsPicker.tab = node.dataset.role; renderSkillsPicker(); break;
    case "skills-select": bulkSkills(node.dataset.source, node.dataset.mode); break;
    case "mcp-select": bulkMcp(node.dataset.mode); break;
    case "skills-save": await saveSkillsPicker(false); break;
    case "skills-reset": await saveSkillsPicker(true); break;
    case "mcp-tab": mcpPicker.tab = node.dataset.role; renderMcpPicker(); break;
    case "mcp-save": await saveMcpPicker(false); break;
    case "mcp-reset": await saveMcpPicker(true); break;
    case "mcp-test": await testMcpServer(node.dataset.server); break;
    case "follow-poll": { const data = await mutate({ action: "follow-poll", id: projectId }, "Checked GitHub."); eventsIn.data = data; renderEventsIn(); break; }
    case "webhook-reveal": eventsIn.reveal = !eventsIn.reveal; renderEventsIn(); break;
    case "webhook-copy": await navigator.clipboard.writeText(node.dataset.what === "url" ? eventsIn.data.webhook.url : eventsIn.data.webhook.secret); toast(node.dataset.what === "url" ? "Webhook URL copied." : "Webhook secret copied."); break;
    case "webhook-rotate": {
      if (!eventsIn.rotateArmed) { eventsIn.rotateArmed = true; renderEventsIn(); setTimeout(() => { if (eventsIn?.rotateArmed) { eventsIn.rotateArmed = false; renderEventsIn(); } }, 6000); break; }
      eventsIn.rotateArmed = false;
      const data = await mutate({ action: "webhook-rotate", id: projectId, confirm: projectId }, "Webhook secret rotated. The old secret no longer works.");
      eventsIn.data = data; eventsIn.reveal = true; renderEventsIn(); break;
    }
    case "owner-setup": await ownerSetupDialog(); break;
    case "workspace-quick": await workspaceQuickDialog(); break;
    case "workspace-quick-confirm": await workspaceQuickConfirm(node.dataset.project, node.dataset.revision); break;
    case "provider-connect": await providerConnectDialog(node.dataset.card); break;
    case "provider-connect-confirm": await providerConnectConfirm(node.dataset.project, node.dataset.card, node.dataset.revision); break;
    case "github-quick": await githubQuickDialog(); break;
    case "github-quick-confirm": await githubQuickConfirm(node.dataset.project, node.dataset.revision); break;
    case "owner-setup-edit": await ownerSetupEdit(node.dataset.kind, node.dataset.payload || "{}"); break;
    case "owner-profile-read": await ownerProfileRead(node.dataset.project, node.dataset.profile); break;
    case "settings-back": await settingsList(true); break;
    case "mp-toggle": { const mp = node.closest(".mp"); if (mp.classList.contains("open")) mpClose(mp, true); else mpOpen(mp); break; }
    case "mp-pick": mpPick(node.closest(".mp"), node.dataset.ref); break;
    case "model-cycle": await cycleModel(1); break;
    case "scope-clear": for (const box of dialog.querySelectorAll("[data-scope-ref]")) box.checked = false; settingsSync(); break;
    case "profile-roles": { const skills = node.dataset.picker === "skills"; (skills ? skillsPicker : mcpPicker).roles = true; (skills ? renderSkillsPicker : renderMcpPicker)(); break; }
    case "settings-discard": settingsDiscard(node.dataset.project, node.dataset.field); break;
    case "settings-confirm-discard": {
      requireProject(node.dataset.project);
      if (!["name", "objective"].includes(node.dataset.field)) throw new Error("Unknown settings draft field");
      settingsDrafts.delete(`${projectId}:${node.dataset.field}`); if (settingsPending?.projectId === projectId) delete settingsPending.flat[node.dataset.field];
      persistBrowserDrafts(); await settingsList(true); break;
    }
    case "upload-list": uploadList(); break;
    case "upload-pick": document.querySelector("#upload-input").click(); break;
    case "attach-pick": document.querySelector("#attach-input").click(); break;
    case "attach-remove": { const list = attachmentDrafts.get(draftKey()) ?? []; list.splice(Number(node.dataset.index), 1); renderAttachments(); break; }
    case "upload-open": await uploadOpen(node.dataset.upload); break;
    case "upload-delete": requireProject(node.dataset.project); await mutate({ action: "upload-delete", id: node.dataset.project, uploadId: node.dataset.upload }, "Upload deleted."); closeDialog(); break;
    case "upload-new": {
      if (!view) throw new Error("Select a loaded project first");
      const draft = { projectId, importId: crypto.randomUUID(), filename: "reference.md", title: "Project reference", encoding: "utf8", text: "", submittedFingerprint: null };
      uploadDrafts.set(draft.importId, draft); persistBrowserDrafts(); uploadEdit(draft.importId); break;
    }
    case "upload-edit": requireProject(node.dataset.project); uploadEdit(node.dataset.import); break;
    case "library-list": await libraryList(Number(node.dataset.offset ?? 0)); break;
    case "library-open": requireProject(node.dataset.project); await libraryOpen(node.dataset.file, node.dataset.sha); break;
    case "library-bytes": requireProject(node.dataset.project); libraryBytes(node.dataset.file, node.dataset.sha, Number(node.dataset.offset)); break;
    case "knowledge-list": await knowledgeList(); break;
    case "knowledge-read": requireProject(node.dataset.project); await knowledgeRead(node.dataset.path); break;
    case "knowledge-edit": knowledgeEdit(node.dataset.project, node.dataset.path); break;
    case "knowledge-new": knowledgeNew(); break;
    case "knowledge-history": requireProject(node.dataset.project); await knowledgeHistory(node.dataset.path, Number(node.dataset.offset ?? 0)); break;
    case "knowledge-discard": knowledgeDiscard(node.dataset.project, node.dataset.path); break;
    case "knowledge-confirm-discard": {
      requireProject(node.dataset.project); const key = `${projectId}:${node.dataset.path}`;
      if (!knowledgeCache.has(key)) throw new Error("Reread the current document before discarding its draft");
      knowledgeDrafts.delete(key); persistBrowserDrafts(); knowledgeEdit(projectId, node.dataset.path); break;
    }
    case "operation-list": await operationsDialog(Number(node.dataset.offset ?? 0)); break;
    case "operation-view": operationView(node.dataset.operation, node.dataset.fingerprint); break;
    case "operation-decision": operationDecision(node.dataset.operation, node.dataset.fingerprint, node.dataset.decision); break;
    case "operation-execute": operationExecution(node.dataset.operation, node.dataset.fingerprint); break;
    case "operation-inspect": operationExecution(node.dataset.operation, node.dataset.fingerprint, true); break;
    case "thread": requireProject(node.dataset.project); if (dialog.contains(node)) closeDialog(); await inspectThread(node.dataset.thread); break;
    case "thread-history-page": requireProject(node.dataset.project); await inspectThread(node.dataset.thread, Number(node.dataset.offset), Number(node.dataset.textOffset)); break;
    case "thread-send": requireProject(node.dataset.project); requireThread(node.dataset.thread); textDialog("thread-send", node.dataset.thread); break;
    case "thread-steer":
      requireProject(node.dataset.project); requireThread(node.dataset.thread);
      showDialog("Steer this reusable thread?", `<p>Project ${esc(projectId)}. Thread ${esc(node.dataset.thread)}. The replacement is recorded before interruption; scope/model/tools stay frozen.</p><button data-action="confirm-thread-steer" data-project="${esc(projectId)}" data-thread="${esc(node.dataset.thread)}">Compose replacement</button>`);
      break;
    case "confirm-thread-steer": requireProject(node.dataset.project); textDialog("thread-steer", node.dataset.thread); break;
    case "thread-stop":
      requireProject(node.dataset.project); requireThread(node.dataset.thread);
      showDialog("Stop this reusable thread?", `<p>Conversation, receipts and partial files remain.</p><button class="danger" data-action="confirm-thread-stop" data-project="${esc(projectId)}" data-thread="${esc(node.dataset.thread)}">Stop thread ${esc(node.dataset.thread)}</button>`);
      break;
    case "confirm-thread-stop": {
      const id = node.dataset.project, version = dialogVersion; requireProject(id);
      await mutate({ action: "thread-stop", id, threadId: node.dataset.thread }, "Thread stop recorded. History and work retained.");
      closeCurrentDialog(id, version); break;
    }
    case "resume-project": await resumeDialog(); break;
    case "confirm-resume": {
      const version = dialogVersion;
      if (node.dataset.project !== projectId) throw new Error("The selected project changed. Reopen the resume dialog.");
      await mutate({ action: "resume", id: node.dataset.project }, "Idle project resumed.");
      closeCurrentDialog(node.dataset.project, version);
      break;
    }
    case "pause-project":
      showDialog("Pause this project?", `<p>This interrupts the coordinator and workers, and blocks scheduled work. State and partial workspace changes stay intact.</p><p>Resume is a separate action.</p><button class="danger" data-action="confirm-pause" data-project="${esc(projectId)}">Pause project</button>`);
      break;
    case "confirm-pause": {
      const version = dialogVersion;
      if (node.dataset.project !== projectId) throw new Error("The selected project changed. Reopen the pause confirmation.");
      await mutate({ action: "pause", id: node.dataset.project }, "Project paused. State retained.");
      closeCurrentDialog(node.dataset.project, version);
      break;
    }
    case "artifact": await inspectArtifact(node.dataset.file); break;
    case "notes": showDialog("Shared project notes", view.notes.map(note => `<article class="message"><div class="eyebrow">${esc(note.author)} · ${esc(new Date(note.at).toLocaleString())}</div><p>${esc(note.text)}</p></article>`).join("") || '<p class="note">No notes yet.</p>'); break;
    case "evidence-list": showDialog("Project evidence", view.evidence.map(artifactButton).join("") || '<p class="note">No evidence captured yet.</p>'); break;
    case "conversation": document.querySelector(".conversation").open = true; document.querySelector(".conversation").scrollIntoView({ block: "start", behavior: scrollBehavior() }); document.querySelector(".conversation summary").focus(); break;
    case "close-dialog": closeDialog(); break;
    case "search": openSearch(); break;
    case "search-open": await openSearchHit(Number(node.dataset.i)); break;
  }
}

async function submit(form) {
  const slash = form.id === "compose" ? slashCommand(new FormData(form).get("message").trim()) : null;
  if (slash) {
    closeSkillMenu();
    const textarea = form.querySelector("textarea"), key = draftKey(projectId, chatId), typed = textarea.value;
    await slash.command.run(slash.argument);
    if (textarea.value === typed) { drafts.delete(key); persistBrowserDrafts(); form.reset(); autosize(textarea); }
    return;
  }
  if (form.id === "compose" && (busy || admissionBlocked())) throw new Error("This project cannot accept a request now. Your draft was kept.");
  const data = new FormData(form);
  const id = projectId, version = dialogVersion;
  if (form.matches("[data-pr-add]")) {
    const input = form.querySelector("input");
    await api({ action: "pr-watch", id, provider: form.dataset.provider, pr: String(data.get("pr") ?? "").trim(), watch: true });
    input.value = ""; input.blur(); prsState.at = 0; await loadPrs();
    return;
  }
  if (form.matches("[data-inline-thread-send]")) {
    if (busy || admissionBlocked()) throw new Error("This project cannot accept a request now. Your draft was kept.");
    const target = form.dataset.project, threadId = form.dataset.thread; requireProject(target); requireThread(threadId);
    const text = data.get("message"); if (!text.trim()) return;
    const draftKey = `${target}:thread-send:${threadId}`;
    const draft = formDrafts.get(draftKey) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
    if (draft.submittedText !== null && draft.submittedText !== text) throw new Error("Prior thread submission is unresolved. Resend its exact text or inspect history before a different request");
    draft.text = text; draft.submittedText = text; formDrafts.set(draftKey, draft); persistBrowserDrafts();
    await mutate({ action: "thread-send", id: target, threadId, requestId: draft.requestId, text }, "Instruction recorded on the existing thread.");
    if (formDrafts.get(draftKey) === draft) {
      formDrafts.delete(draftKey); persistBrowserDrafts();
      if (projectId === target && workerChat?.threadId === threadId) await inspectThread(threadId);
    }
  } else if (form.matches("[data-chat-rename]")) {
    requireProject(form.dataset.project);
    const title = data.get("title").trim(); if (!title) return;
    await mutate({ action: "chat-update", id: form.dataset.project, chatId: form.dataset.chat, title }, "Chat renamed.");
    closeCurrentDialog(id, version);
  } else if (form.id === "compose") {
    closeSkillMenu(); searchFocus = null;
    // Only an explicit send (or Jump to latest) may take a reader back to the bottom. A trailing user message during polling is not a new send.
    stickToBottom = true; followTranscript();
    const submitted = data.get("message"), chat = chatId, key = draftKey(id, chat);
    const text = submitted.trim(); if (!text) return;
    const list = attachmentDrafts.get(key) ?? [];
    if (list.some(item => item.pending)) throw new Error("Attachments are still uploading. Your draft was kept.");
    persistBrowserDrafts();
    await mutate({ action: "message", id, text, ...(chat === "main" ? {} : { chatId: chat }), ...(list.length ? { attachments: list.map(item => item.id) } : {}) }, "Request sent to the coordinator.");
    if (drafts.get(key) === submitted) drafts.delete(key);
    if (attachmentDrafts.get(key) === list) { attachmentDrafts.delete(key); renderAttachments(); }
    if (projectId === id && chatId === chat && form.querySelector("textarea").value === submitted) { form.reset(); autosize(form.querySelector("textarea")); }
  } else if (form.matches("[data-answer-adopt]")) {
    const proposal = answerAdoption; requireProject(form.dataset.project);
    if (!proposal || proposal.projectId !== projectId || proposal.entryId !== form.dataset.entry || proposal.version !== version || data.get("confirm") !== projectId || answers.get(proposal.entryId) !== proposal.text) throw new Error("Draft adoption binding changed; inspect and confirm it again");
    const entry = view?.inbox.find(entry => entry.id === proposal.entryId && entry.kind === "question" && !entry.result);
    const key = answerKey(projectId, proposal.entryId);
    if (!entry || answers.has(key)) throw new Error("Target is resolved or has a newer draft; nothing overwritten");
    answers.set(key, proposal.text); persistBrowserDrafts();
    closeCurrentDialog(projectId, version); render(); toast("Old draft copied. No answer sent; original unbound draft retained.");
  } else if (form.matches("[data-answer]")) {
    requireProject(form.dataset.project);
    const text = data.get("answer").trim(); if (!text) return;
    const entry = view?.inbox.find(entry => entry.id === form.dataset.entry && !entry.result);
    if (!entry) throw new Error("Answer target is no longer pending in this project");
    await mutate({ action: "answer", id, entry: form.dataset.entry, text }, "Answer sent to the coordinator.");
  } else if (form.matches("[data-task-message]")) {
    const target = form.dataset.project; requireProject(target);
    const text = data.get("message"); if (!text.trim()) return;
    const draft = formDrafts.get(form.dataset.draftKey);
    if (!draft) throw new Error("Form draft is missing; reopen the intended target");
    draft.text = data.get("message");
    if (form.dataset.mode !== "thread-send" && form.dataset.mode !== "thread-steer") throw new Error("Unknown message form");
    if (draft.submittedText !== null && draft.submittedText !== text) throw new Error("Prior thread submission is unresolved. Resend its exact text or inspect history before a different request");
    draft.submittedText = text; persistBrowserDrafts();
    await mutate({ action: form.dataset.mode, id: target, threadId: form.dataset.id, requestId: draft.requestId, text }, "Instruction recorded on the existing thread.");
    if (formDrafts.get(form.dataset.draftKey) === draft) {
      if (draft.text === data.get("message")) { formDrafts.delete(form.dataset.draftKey); closeCurrentDialog(target, version); }
      else {
        formDrafts.set(form.dataset.draftKey, { text: draft.text, requestId: crypto.randomUUID(), submittedText: null });
        if (projectId === target && dialogVersion === version) textDialog(form.dataset.mode, form.dataset.id);
      }
    }
    persistBrowserDrafts();
  } else if (form.matches("[data-routine-change]")) {
    const target = form.dataset.project; requireProject(target);
    const proposal = routineConfirmation;
    if (!proposal || proposal.project !== target || proposal.version !== version || data.get("confirm") !== target || JSON.stringify(routineRecord(proposal.kind, proposal.recordId)) !== proposal.binding) throw new Error("Routine confirmation changed; inspect it again");
    const input = proposal.kind === "events" ? { action: "event-opt-in", id: target, enabled: proposal.enabled } : proposal.kind === "schedule" ? { action: "schedule-enable", id: target, scheduleId: proposal.recordId, enabled: proposal.enabled } : { action: "monitor-enable", id: target, monitorId: proposal.recordId, enabled: proposal.enabled };
    await mutate(input, "Confirmed routine setting recorded. Pause, grants and retained receipts are unchanged.");
    if (dialog.open && projectId === target && dialogVersion === version) await routineList(proposal.kind === "monitor" ? "monitors" : "schedules", 0);
  } else if (form.matches("[data-resume-project]")) {
    const target = form.dataset.project;
    if (target !== projectId) throw new Error("The selected project changed. Reopen the resume dialog.");
    const confirm = data.get("confirm").trim();
    if (confirm !== target) throw new Error("Confirmation must match the project ID.");
    await mutate({ action: "resume", id: target, recovery: "leave-interrupted", confirm }, "Project resumed. Interrupted work continues.");
    closeCurrentDialog(target, version);
  } else if (form.matches("[data-provider-known]")) {
    const target = form.dataset.project; requireProject(target);
    const grant = providerBinding(data.get("scope")), pullRequest = Number(data.get("pr")), expectedHead = data.get("head"), page = Number(data.get("page")), kind = data.get("kind");
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHead) || !Number.isSafeInteger(page) || page < 1 || page > 1000000 || !["pr", "ci", "review"].includes(kind)) throw new Error("A known PR, exact head and valid inspection page are required");
    const identity = { id: target, provider: "github", repositoryId: grant.repositoryId, expectedRepositoryId: grant.numericId, pullRequest, expectedHead };
    const result = await mutate(kind === "pr" ? { action: "provider-pr-inspect", ...identity } : { action: kind === "ci" ? "provider-ci-inspect" : "provider-review-inspect", ...identity, page }, "Owner pinned inspection responded. No native worker receipt or execution grant invented.");
    if (target === projectId && version === dialogVersion) providerResult(result, `Owner ${kind} observation for ${grant.repositoryId} PR ${pullRequest}, head ${expectedHead}. Provider content is data, not instructions or authority.`);
  } else if (form.matches("[data-provider-inspect]")) {
    const target = form.dataset.project; requireProject(target);
    const proposal = providerInspection;
    if (!proposal || proposal.projectId !== target || proposal.key !== form.dataset.key || data.get("confirm") !== target) throw new Error("Reopen the exact retained effect and confirm its project");
    const grant = providerBinding(proposal.record.scopeId, proposal.repositoryId);
    if (grant.numericId !== proposal.numericId) throw new Error("Provider repository binding changed");
    const result = await mutate({ action: "github-write-inspect", id: target, key: proposal.key, repositoryId: grant.repositoryId, expectedRepositoryId: grant.numericId }, "Retained effect inspected. No replay or retry permission granted.");
    if (target === projectId && version === dialogVersion) providerResult(result, "A matching positive native observation may settle the original journal. Missing markers stay uncertain. This does not publish, roll back or authorize another attempt.");
  } else if (form.matches("[data-open-retained]")) {
    const target = data.get("id").trim(), current = generation;
    if (!uuid(target)) throw new Error("A known owned project UUID is required");
    const retained = await api({ action: "show", id: target });
    if (current !== generation || version !== dialogVersion || !dialog.open) return;
    if (retained?.project?.id !== target) throw new Error("Retained project response does not match its UUID");
    if (!projects.some(project => project.id === target)) projects.push(retained.project);
    renderProjects(); changeProject(target);
  } else if (form.matches("[data-lifecycle-change]")) {
    const target = form.dataset.project; requireProject(target);
    const operation = form.dataset.operation;
    if (!plan || !["archive", "delete", "restore"].includes(operation) || data.get("confirm") !== target) throw new Error("Confirm the exact Durable project/lifecycle action");
    await mutate(operation === "delete" ? { action: "delete", id: target, confirm: target } : { action: operation, id: target }, operation === "restore" ? "Retained project restored, still paused. Nothing was resumed/replayed." : "Project retained. Repository work, receipts and remote PRs are not deleted.");
    closeCurrentDialog(target, version);
  } else if (form.matches("[data-owner-github-inspect]")) {
    const target = form.dataset.project; requireProject(target);
    const repositoryId = data.get("repositoryId").trim();
    if (!repositoryId) throw new Error("Enter the exact owner/repository from the selected checkout origin");
    const result = await api({ action: "github-repository-inspect", id: target, repositoryId });
    if (target === projectId && version === dialogVersion && dialog.open) setDialogBody(`<p class="note">Read-only lookup. Use the numeric ID and default branch below when you authorize this repository.</p>${recordSummary(result)}${dlgActions(dlgBtn("Back to owner setup", { action: "owner-setup" }, "primary"))}`);
  } else if (form.matches("[data-owner-write]")) {
    const target = form.dataset.project; requireProject(target);
    if (form.dataset.kind.endsWith("-revoke") && data.get("confirm") !== target) throw new Error("Type the exact project ID for fresh owner consent");
    const fields = ownerFieldsValue(form);
    const kind = form.dataset.kind, actionByKind = { "workspace-grant": "workspace-grant", "workspace-revoke": "workspace-revoke", "github-authorize": "github-authorize", "github-revoke": "github-revoke", "command-profile-set": "command-profile-set" };
    if (!Object.hasOwn(actionByKind, kind)) throw new Error("Unknown owner setup action");
    const result = await mutate({ ...fields, action: actionByKind[kind], id: target, confirm: target }, "Owner API recorded this explicit revision-checked change. No command was executed.");
    if (projectId === target && version === dialogVersion && dialog.open) await ownerSetupDialog(result);
  } else if (form.matches("[data-settings-form]")) {
    requireProject(form.dataset.project); captureSettingsDraft(); persistBrowserDrafts();
    if (!settingsCache || settingsCache.projectId !== projectId) throw new Error("Reopen the project settings first");
    const changes = settingsChanges(settingsFormValues(form), settingsCache.values);
    if (!Object.keys(changes).length) throw new Error("There are no changes to review yet.");
    validateSettingsChanges(changes);
    settingsReview(settingsRevisionFor(changes), changes);
  } else if (form.matches("[data-settings-confirm]")) {
    const target = form.dataset.project; requireProject(target);
    const proposal = settingsConfirmation;
    if (!proposal || proposal.projectId !== target || proposal.revision !== form.dataset.revision || data.get("confirm") !== target) throw new Error("Reopen the exact settings proposal and confirm its project ID");
    persistBrowserDrafts();
    const result = await mutate({ action: "settings-update", id: target, confirm: target, expectedRevision: proposal.revision, changes: proposal.changes }, "Settings saved. New threads use them; running threads keep what they started with.");
    validateSettings(result);
    for (const [field, changed] of Object.entries(proposal.changes)) {
      if (field === "verification" ? JSON.stringify(result.values.verification) !== JSON.stringify(changed) : field === "models" || field === "fallbackModels" ? Object.entries(changed).some(([role, reference]) => (result.values[field][role] ?? null) !== reference) : field === "scopedModels" ? JSON.stringify(result.values.scopedModels) !== JSON.stringify(changed) : result.values[field] !== changed) throw new Error("Settings receipt differs from the proposed change; retain drafts and inspect");
    }
    for (const key of proposal.draftKeys) {
      const draft = settingsDrafts.get(key), field = key.slice(key.indexOf(":") + 1);
      if (draft?.expectedRevision === proposal.revision && draft.text === proposal.changes[field]) settingsDrafts.delete(key);
    }
    persistBrowserDrafts(); settingsPending = null;
    if (target === projectId) { settingsCache = { ...result, projectId: target }; projects = projects.map(project => project.id === target ? { ...project, name: result.values.name } : project); renderProjects(); closeCurrentDialog(target, version); }
  } else if (form.matches("[data-upload-edit]")) {
    requireProject(form.dataset.project); captureUploadDraft(); persistBrowserDrafts();
    await uploadReview(form.dataset.import);
  } else if (form.matches("[data-upload-confirm]")) {
    const target = form.dataset.project; requireProject(target);
    const draft = uploadDrafts.get(form.dataset.import), payload = uploadConfirmations.get(form.dataset.import);
    if (!draft || !payload || payload.projectId !== target || form.dataset.fingerprint !== payload.fingerprint || data.get("confirm") !== target) throw new Error("Reopen the exact upload review and confirm its project ID");
    const current = await prepareUpload(draft);
    if (target !== projectId || version !== dialogVersion || !dialog.open) return;
    if (draft.filename !== current.filename || draft.title !== current.title || draft.encoding !== current.encoding || draft.text !== current.text) throw new Error("Upload draft changed during preparation; review it again");
    if (current.fingerprint !== payload.fingerprint || draft.submittedFingerprint !== null && draft.submittedFingerprint !== payload.fingerprint) throw new Error("Upload bytes/binding changed. Unresolved UUID cannot be reused for a changed payload");
    draft.submittedFingerprint = payload.fingerprint; persistBrowserDrafts();
    const record = await mutate({ action: "library-import", id: target, confirm: target, importId: payload.importId, filename: payload.filename, title: payload.title, encoding: "base64", data: payload.data, expectedSha256: payload.sha256 }, "Owner reference import acknowledged. No agent grant or native worker evidence inferred.");
    validateLibraryRecord(record, target);
    if (record.id !== payload.importId || record.filename !== payload.filename || record.title !== payload.title || record.sha256 !== payload.sha256 || record.size !== payload.size || record.native !== undefined || record.sessionFile !== null) throw new Error("Upload receipt differs from the confirmed owner reference. UUID/fingerprint retained");
    if (uploadDrafts.get(draft.importId) === draft && draft.filename === payload.filename && draft.title === payload.title && draft.encoding === payload.encoding && draft.text === payload.text) uploadDrafts.delete(draft.importId);
    persistBrowserDrafts();
    if (target === projectId && version === dialogVersion) showDialog("Owner reference receipt", `<p>Stored immutable owner reference, not worker-generated evidence. Import does not grant agent access or execution authority.</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><button data-action="library-list">Open project library</button>`);
  } else if (form.matches("[data-knowledge-path]")) {
    const target = form.dataset.project; requireProject(target);
    const path = data.get("path").trim();
    if (!knowledgePath(path) || !path.includes("/")) throw new Error("Choose a managed topic path, such as research/topic.md");
    knowledgePaths.set(target, data.get("path"));
    const key = `${target}:${path}`;
    if (!knowledgeDrafts.has(key)) knowledgeDrafts.set(key, { text: "", expectedRevision: null });
    persistBrowserDrafts(); knowledgeEdit(target, path, true);
  } else if (form.matches("[data-knowledge-write]")) {
    const target = form.dataset.project; requireProject(target);
    const path = form.dataset.path, key = `${target}:${path}`, draft = knowledgeDrafts.get(key);
    if (!knowledgePath(path) || !draft) throw new Error("Knowledge draft is missing; reopen the document");
    const text = data.get("text"); draft.text = text;
    if (!editableKnowledge(text)) throw new Error("Unsafe control text cannot be edited; the draft was retained");
    if (path === "MEMORY.md" && [...text].length > 3000) throw new Error("MEMORY.md exceeds 3,000 Unicode code points; the draft was retained");
    if (data.get("confirm") !== target) throw new Error("Confirmation must match the project ID");
    const expectedRevision = draft.expectedRevision;
    persistBrowserDrafts();
    const result = await mutate({ action: "knowledge-write", id: target, path, text, expectedRevision }, "Knowledge write acknowledged. Index and execution authority were not changed automatically.");
    validateKnowledgeDocument(result, path);
    if (result.text !== text) throw new Error("Knowledge write receipt differs from the submitted text; retain the draft and inspect");
    if (knowledgeDrafts.get(key) === draft && draft.text === text && draft.expectedRevision === expectedRevision) knowledgeDrafts.delete(key);
    persistBrowserDrafts();
    if (target === projectId && dialogVersion === version) await knowledgeRead(path);
  } else if (form.matches("[data-operation-decision]")) {
    const target = form.dataset.project; requireProject(target);
    const record = ownedOperation(form.dataset.operation, form.dataset.fingerprint);
    if (record.status !== "pending") throw new Error("Operation decision is immutable");
    const mode = form.dataset.decision;
    if (!["plain", "execution", "reject"].includes(mode)) throw new Error("Unknown operation decision");
    if (mode !== "reject" && data.get("confirm") !== target) throw new Error("Confirmation must match the project ID");
    if (mode === "execution" && !executionConsentAvailable(record)) throw new Error("Executable consent is unavailable for this operation");
    await mutate(mode === "reject" ? { action: "operation-decide", id: target, operationId: record.id, fingerprint: record.fingerprint, decision: "reject" } : { action: "operation-decide", id: target, operationId: record.id, fingerprint: record.fingerprint, decision: "approve", confirm: target, ...(mode === "execution" ? { execution: true } : {}) }, "Operation decision recorded. No operation was executed.");
    closeCurrentDialog(target, version);
  } else if (form.matches("[data-operation-execute]")) {
    const target = form.dataset.project; requireProject(target);
    const record = ownedOperation(form.dataset.operation, form.dataset.fingerprint);
    if (!operationExecutionAvailable(record) || data.get("confirm") !== target) throw new Error("Exact executable approval and project confirmation are required");
    if (!["execute", "inspect"].includes(form.dataset.mode)) throw new Error("Unknown bound operation control");
    const result = await mutate({ action: form.dataset.mode === "inspect" ? "operation-inspect" : "operation-execute", id: target, operationId: record.id, fingerprint: record.fingerprint, confirm: target }, form.dataset.mode === "inspect" ? "Bound outcome inspected. No replay/retry permission inferred." : "Executor responded. Inspect its receipt; no new retry permission inferred.");
    if (target === projectId && dialogVersion === version) showDialog("Bound executor response", `<p>Approval is not effect verification. Uncertain effects must be inspected, never replayed automatically.</p><pre>${esc(JSON.stringify(result, null, 2) ?? "No readable receipt returned; outcome remains unproven.")}</pre>`);
  } else if (form.matches("[data-create]")) {
    if (busy) return;
    if (!data.has("trusted")) throw new Error("Approve the trusted workspace before creating it");
    captureCreationDraft();
    const creation = creationDrafts.get(form.dataset.draft);
    const retry = form.dataset.retry === "true";
    if (!creation || (retry ? creation.outcome !== "unknown" || creation.requestBound !== true : creation.outcome !== "draft")) throw new Error("Only a fresh draft or explicitly confirmed exact bound retry may be submitted");
    const payload = { action: "create", requestId: form.dataset.draft, name: creation.name.trim(), cwd: creation.cwd.trim(), objective: creation.objective.trim() };
    if (!payload.name || !payload.cwd) throw new Error("Project name and workspace path are required");
    const previousOutcome = creation.outcome, previousBinding = creation.requestBound;
    creation.outcome = "unknown"; creation.requestBound = true;
    try { persistBrowserDrafts(); }
    catch (error) { creation.outcome = previousOutcome; creation.requestBound = previousBinding; throw error; }
    for (const field of ["name", "cwd", "objective"]) {
      const control = form.elements.namedItem(field);
      if (control && "readOnly" in control) control.readOnly = true;
    }
    const frame = uiFrame();
    busy = true; disableActions();
    try {
      const p = await api(payload);
      if (!p || p.id !== payload.requestId || !uuid(p.id)) throw new Error("Creation response differs from its bound project UUID; inspect the original request before any new creation");
      creation.outcome = "created"; creation.createdId = p.id; persistDraftsSafely();
      if (!projects.some(project => project.id === p.id)) projects.push(p);
      toast(`Project created: ${p.id}. Do not recreate it if list refresh fails.`);
      if (frame.projectId !== projectId || frame.generation !== generation || frame.dialogVersion !== dialogVersion || !dialog.open) return;
      let loaded;
      try { loaded = await api({ action: "list" }); }
      catch (error) { throw new UiRequestError(`Project ${p.id} was created, but listing failed: ${error instanceof Error ? error.message : String(error)}. Open its known UUID or refresh the list; do not recreate it.`, frame); }
      if (frame.projectId !== projectId || frame.generation !== generation || frame.dialogVersion !== dialogVersion || !dialog.open) return;
      if (!loaded.some(project => project.id === p.id)) loaded.push(p);
      projects = loaded; changeProject(p.id);
    } finally { busy = false; disableActions(); }
  }
}

function report(error, frame = error instanceof UiRequestError ? error.frame : uiFrame()) {
  if (frame.projectId !== projectId || frame.generation !== generation) return;
  const text = error instanceof Error ? error.message : String(error);
  if (dialog.open && frame.dialogVersion === dialogVersion) { let node = dialog.querySelector(".dialog-error"); if (!node) { node = document.createElement("p"); node.className = "dialog-error"; dialog.append(node); } node.textContent = text; }
  else setError(text, "action");
}
document.addEventListener("click", event => { const node = event.target.closest("[data-action]"); if (node && !node.disabled) void uiAction(() => action(node)); });
document.addEventListener("submit", event => { if (!event.target.matches("#compose, [data-chat-rename], [data-answer], [data-answer-adopt], [data-task-message], [data-resume-project], [data-operation-decision], [data-operation-execute], [data-inline-thread-send], [data-knowledge-path], [data-knowledge-write], [data-upload-edit], [data-upload-confirm], [data-settings-form], [data-settings-confirm], [data-routine-change], [data-lifecycle-change], [data-open-retained], [data-provider-known], [data-provider-inspect], [data-create], [data-pr-add]")) return; event.preventDefault(); void uiAction(() => submit(event.target)); });
function autosize(textarea) { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 220)}px`; if (textarea.closest("#compose")) renderBackdrop(textarea); }
document.addEventListener("change", event => { if (event.target.closest("[data-settings-form]")) settingsSync(); });
document.addEventListener("input", event => {
  const filter = event.target.closest?.("[data-scope-filter]"); if (!filter) return;
  const terms = modelNorm(filter.value).split(/\s+/).filter(Boolean);
  for (const row of filter.closest(".scope-editor").querySelectorAll(".scope-row")) row.hidden = !terms.every(term => modelNorm(row.textContent).includes(term));
});
document.addEventListener("input", event => {
  if (event.target.matches(".mp-search")) { renderModelList(event.target.closest(".mp")); return; }
  if (event.target.id === "search-input") { scheduleSearch(); return; }
  if (event.target.closest("#compose")) { drafts.set(draftKey(), event.target.value); autosize(event.target); void updateSkillMenu(event.target).catch(error => { closeSkillMenu(); report(error); }); }
  const answerForm = event.target.closest("[data-answer]");
  if (answerForm?.dataset.project === projectId) answers.set(answerKey(projectId, answerForm.dataset.entry), answerForm.querySelector("textarea").value);
  const form = event.target.closest("[data-task-message], [data-inline-thread-send]");
  if (form?.matches("[data-inline-thread-send]")) {
    const key = `${form.dataset.project}:thread-send:${form.dataset.thread}`;
    const draft = formDrafts.get(key) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
    draft.text = form.querySelector("textarea").value; formDrafts.set(key, draft);
  } else {
    const draft = form && formDrafts.get(form.dataset.draftKey);
    if (draft) draft.text = form.querySelector("textarea").value;
  }
  captureKnowledgeDraft(); captureUploadDraft(); captureSettingsDraft(); captureCreationDraft(); persistDraftsSafely();
  if (event.target.closest("[data-settings-form]")) settingsSync();
});
// Clicking elsewhere closes the skill picker; moving the caret re-evaluates it.
document.addEventListener("mousedown", event => { if (event.target.closest(".skill-option")) event.preventDefault(); else if ((skillMenu || prMenu || refMenu) && !event.target.closest("#compose")) closeSkillMenu(); });
document.addEventListener("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && event.target.closest("#compose textarea")) void updateSkillMenu(event.target).catch(() => closeSkillMenu()); });
{
  const composeText = document.querySelector("#compose textarea");
  composeText.addEventListener("scroll", () => { const backdrop = document.querySelector("#compose .compose-backdrop"); if (backdrop) backdrop.scrollTop = composeText.scrollTop; }, { passive: true });
  composeText.addEventListener("mouseup", () => void updateSkillMenu(composeText).catch(() => closeSkillMenu()));
}
// Collapsible project sidebar (wide layouts): collapses to an icon rail; toggle button and ⌘B / Ctrl+B; remembered per browser.
function setSidebar(collapsed, persist = true) {
  document.querySelector(".app").classList.toggle("side-collapsed", collapsed);
  const toggle = document.querySelector("#side-toggle"), label = `${collapsed ? "Expand" : "Collapse"} sidebar`;
  toggle.setAttribute("aria-expanded", String(!collapsed)); toggle.setAttribute("aria-label", label); toggle.title = `${label} (⌘B / Ctrl+B)`;
  if (persist) { try { localStorage.setItem("pi-projects:side-collapsed", collapsed ? "1" : "0"); } catch { /* storage blocked */ } }
}
try { setSidebar(localStorage.getItem("pi-projects:side-collapsed") === "1", false); } catch { setSidebar(false, false); }
// The width animates only for toggles, not for the restored state on load.
requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(".app").classList.add("side-animate")));
document.addEventListener("click", event => { if (!event.target.closest("[data-side-toggle]")) return; setSidebar(!document.querySelector(".app").classList.contains("side-collapsed")); });
document.querySelector("#projects").addEventListener("change", event => changeProject(event.target.value));
document.querySelector("#transcript").addEventListener("scroll", event => {
  const node = event.currentTarget;
  stickToBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  transcriptAnchor = stickToBottom ? null : captureTranscriptAnchor();
  renderWorkingPill();
}, { passive: true });
// Images, diagrams and markdown can settle after the DOM render. Keep a reading anchor still; keep following only if it was already requested.
const transcriptResize = new ResizeObserver(() => {
  if (stickToBottom) followTranscript(); else restoreTranscriptAnchor();
});
for (const selector of ["#transcript", "#messages", "#live-reply", "#questions"]) transcriptResize.observe(document.querySelector(selector));
document.addEventListener("selectionchange", () => {
  const selection = document.getSelection(), live = document.querySelector("#live-reply");
  if (selection?.isCollapsed && (live.contains(selection.anchorNode) || liveFrame?.running && liveRenderedText !== liveFrame.text)) scheduleLiveRender();
});
for (const id of ["attach-input", "upload-input"]) document.querySelector(`#${id}`).addEventListener("change", event => {
  const files = [...event.target.files]; event.target.value = "";
  if (files.length) void uiAction(() => id === "attach-input" ? attachFiles(files) : uploadToKnowledge(files));
});
// Files dropped on the composer or transcript attach to the next message; on the Knowledge tab they become knowledge.
const dropZone = event => event.dataTransfer?.types.includes("Files") ? event.target.closest?.("#compose, #transcript, [data-panel='knowledge']") ?? null : null;
document.addEventListener("dragover", event => { if (!event.dataTransfer?.types.includes("Files")) return; event.preventDefault(); const zone = dropZone(event); event.dataTransfer.dropEffect = zone ? "copy" : "none"; document.querySelectorAll(".dragging").forEach(node => { if (node !== zone) node.classList.remove("dragging"); }); zone?.classList.add("dragging"); });
document.addEventListener("dragleave", event => { if (!event.relatedTarget) document.querySelectorAll(".dragging").forEach(node => node.classList.remove("dragging")); });
document.addEventListener("drop", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  const zone = dropZone(event), files = [...event.dataTransfer.files];
  document.querySelectorAll(".dragging").forEach(node => node.classList.remove("dragging"));
  if (zone && files.length) void uiAction(() => zone.matches("[data-panel='knowledge']") ? uploadToKnowledge(files) : attachFiles(files));
});
document.querySelector("#show-archived").addEventListener("change", event => { showArchived = event.target.checked; if (view) render(); });
document.addEventListener("click", event => {
  const pick = event.target.closest("[data-select-project]");
  if (pick && pick.dataset.selectProject !== projectId) changeProject(pick.dataset.selectProject);
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) setTab(tabButton.dataset.tab);
});
setTab(tab);
document.querySelector(".search-kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
document.querySelector("#create").addEventListener("click", createDialog);
document.querySelector("#refresh").addEventListener("click", () => { void uiAction(async () => {
  const current = generation, id = projectId, loaded = await api({ action: "list" });
  if (current !== generation || id !== projectId) return;
  if (view?.project.id === id && !loaded.some(project => project.id === id)) loaded.push(view.project);
  projects = loaded; renderProjects(); await refresh();
}); });
dialog.addEventListener("close", () => {
  // A delayed close event must not cancel a dialog that has since reopened.
  if (dialog.open) return;
  captureDialogDraft();
  answerAdoption = null; routineConfirmation = null; uploadConfirmations.clear(); settingsConfirmation = null; providerInspection = null;
  dialogVersion++; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null;
});
// Esc inside an open model list closes only the list.
dialog.addEventListener("cancel", event => { const open = dialog.querySelector(".mp.open"); if (open) { event.preventDefault(); mpClose(open, true); } });
dialog.addEventListener("mousedown", event => { if (event.target.closest(".mp-row")) event.preventDefault(); });
document.addEventListener("click", event => { for (const mp of dialog.querySelectorAll(".mp.open")) if (!mp.contains(event.target)) mpClose(mp); });
document.addEventListener("keydown", event => {
  const picker = event.target.closest?.(".mp");
  if (picker && !event.isComposing && mpKey(event, picker)) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "k" && !event.isComposing) { event.preventDefault(); openSearch(); return; }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key?.toLowerCase() === "p" && !event.isComposing && !dialog.open && projectId && view) { event.preventDefault(); if (!busy) void uiAction(() => cycleModel(event.shiftKey ? -1 : 1)); return; }
  if (event.target.id === "search-input" && !event.isComposing) {
    const count = searchState.results.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) { event.preventDefault(); searchState.active = (searchState.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderSearchResults(); }
    else if (event.key === "Enter") { event.preventDefault(); clearTimeout(searchTimer); if (searchState.query === event.target.value.trim() && count) void uiAction(() => openSearchHit(searchState.active)); else void runSearch(); }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "b" && !event.isComposing && !dialog.open) { event.preventDefault(); setSidebar(!document.querySelector(".app").classList.contains("side-collapsed")); return; }
  if (event.key === "Escape" && workerChat && !dialog.open && !lightbox.open && !refMenu && !document.querySelector(".mp.open") && !event.isComposing) { event.preventDefault(); document.querySelector('#inline-thread [data-action="thread-close"]')?.click(); return; }
  if (refMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = refMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) { refMenu.index = (refMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderRefMenu(); } return; }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab") && count) { event.preventDefault(); pickRef(refMenu.items[refMenu.index]); return; }
    if (event.key === "Escape") { event.preventDefault(); closeSkillMenu(); return; }
  }
  if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing && event.target.closest?.("#compose textarea") && deleteTokenBefore(event.target)) { event.preventDefault(); return; }
  if (prMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = prMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) { prMenu.index = (prMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderPrMenu(); } return; }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab") && count) { event.preventDefault(); pickPr(prMenu.items[prMenu.index].ref); return; }
    if (event.key === "Escape") { event.preventDefault(); closeSkillMenu(); return; }
  }
  if (skillMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = skillMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) { skillMenu.index = (skillMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderSkillMenu(); } return; }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab") && count) { event.preventDefault(); pickMenuItem(skillMenu.items[skillMenu.index], event.key === "Enter"); return; }
    if (event.key === "Escape") { event.preventDefault(); closeSkillMenu(); return; }
  }
  const textarea = event.target.closest("#compose textarea, [data-answer] textarea, [data-task-message] textarea, [data-inline-thread-send] textarea");
  if (textarea && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    const form = textarea.form;
    const submit = form?.querySelector('button[type="submit"]');
    if (form && !submit?.disabled && !busy) { event.preventDefault(); form.requestSubmit(); }
    return;
  }
  const card = /^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !dialog.open && !event.target.closest("input, textarea, select, [contenteditable]") ? event.target.closest?.(".question-card") : null;
  if (card) { const choice = card.querySelectorAll(".choices button")[Number(event.key) - 1]; if (choice && !choice.disabled) { event.preventDefault(); choice.click(); } return; }
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || dialog.open || event.target.closest("input, textarea, select, [contenteditable]")) return;
  event.preventDefault(); setTab("coordinator"); document.querySelector("#compose textarea").focus();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
setInterval(() => uiPluginCall("tick"), 500);
document.addEventListener("visibilitychange", () => uiPluginCall("tick"));
window.addEventListener("pagehide", () => uiPluginCall("hide"));
function providerBinding(scopeId, repositoryId) {
  if (!view || view.project.archived || view.project.deleted) throw new Error("Restore the retained project before provider inspection");
  const p = view.project, scope = p.workspaceAuthorization?.scopes.find(scope => scope.id === scopeId), grant = p.githubAuthorization?.find(grant => grant.repositoryId === scope?.repositoryId);
  if (p.workspaceAuthorization?.provider !== "github" || !scope || !grant || repositoryId !== undefined && grant.repositoryId !== repositoryId || !Number.isSafeInteger(grant.numericId)) throw new Error("Receipt has no matching current GitHub scope/repository grant. Other workspace providers remain deferred; retained metadata stays readable");
  return grant;
}
async function providerList(kind = "reads", offset = 0) {
  if (!plan || !["reads", "writes"].includes(kind) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("A loaded Durable project and valid receipt page are required");
  const id = projectId, current = generation, version = showDialog("GitHub receipts", '<p class="note">Reading what workers recorded…</p>', "What workers read from GitHub and sent to it, as recorded at the time. Not live status.");
  const page = await api({ action: kind === "reads" ? "github-read-snapshot" : "github-write-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextOffset !== null && (!page.items.length || page.nextOffset !== offset + page.items.length)) throw new Error("Invalid retained provider receipt page");
  providerCache.clear();
  const rows = page.items.map(record => {
    if (!uuid(record.scopeId) || !Number.isSafeInteger(record.conversationId) || record.conversationId < 1 || !Number.isSafeInteger(record.taskId) || record.taskId < 1 || typeof record.callId !== "string" || typeof record.operation !== "string" || kind === "reads" && (typeof record.repositoryId !== "string" || !Number.isSafeInteger(record.pullRequest) || record.pullRequest < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)) || kind === "writes" && (!/^[a-f0-9]{64}$/.test(record.key) || !["uncertain", "done"].includes(record.state))) throw new Error("Invalid native provider receipt identity");
    const cacheKey = crypto.randomUUID(); providerCache.set(cacheKey, { projectId: id, kind, record });
    const title = kind === "reads" ? `${esc(record.repositoryId)} · PR #${record.pullRequest} · ${esc(humanKey(record.operation))}` : `${stateChip(record.state === "uncertain" ? "Outcome unknown" : "Done", record.state === "uncertain" ? "warn" : "on")}${esc(humanKey(record.operation))} · ${esc(record.target)}`;
    const meta = kind === "reads" ? `Commit ${esc(record.head.slice(0, 12))}${record.ci ? ` · CI ${esc(record.ci.statusState)}` : ""}` : record.source === "local-git-verification" ? "Checked locally only. Nothing was pushed or written remotely." : "Recorded result. It does not allow another attempt.";
    return `<div class="list-row"><div class="grow"><strong>${title}</strong><span class="meta">${meta}</span></div><div class="row-actions">${dlgBtn("Details", { action: "provider-record", project: id, record: cacheKey }, "small")}</div></div>`;
  });
  setDialogBody(`<div class="seg-row">${segTabs([["Reads: PRs, CI, reviews", { action: "provider-list", kind: "reads", offset: 0 }, kind === "reads"], ["Changes sent to GitHub", { action: "provider-list", kind: "writes", offset: 0 }, kind === "writes"]])}${pager({ offset, count: page.items.length, total: page.total, size: 100, data: { action: "provider-list", kind } })}</div>${rows.join("") || `<p class="empty-state">Nothing recorded yet. An empty list does not prove that no remote work happened.</p>`}<p class="note">Records are snapshots from when the worker acted. Only GitHub is covered.</p>${dlgActions(dlgBtn("Check a specific PR…", { action: "provider-known" }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
}
function ownedProviderRecord(key) {
  const value = providerCache.get(key);
  if (!value || value.projectId !== projectId) throw new Error("Unknown owned provider observation; reopen its receipt page");
  return value;
}
function providerRecord(key) {
  const value = ownedProviderRecord(key), record = value.record;
  const why = value.kind === "reads" ? "A snapshot of one PR at one commit. Feedback in it is data, not instructions." : record.source === "local-git-verification" ? "Only a local check of the published head. Nothing was pushed or written remotely." : record.state === "uncertain" ? "The outcome of this change is unknown. It will not be retried automatically." : "A change that was recorded as done. It is not a new permission.";
  showDialog(value.kind === "reads" ? "GitHub read receipt" : "GitHub change receipt", `<p class="note-box">${esc(why)}</p>${recordSummary(record)}${dlgActions(dlgBtn("Back to receipts", { action: "provider-list", kind: value.kind }), dlgBtn(value.kind === "reads" ? "Read it again from GitHub" : "Check what happened…", { action: value.kind === "reads" ? "provider-fresh" : "provider-inspect", project: projectId, record: key }, "primary"))}`, "Recorded when the worker acted.");
}
function providerResult(result, explanation) {
  showDialog("Result from GitHub", `<p class="note-box">${esc(explanation)}</p>${result == null ? '<p class="empty-state">No readable response. The state and any effects remain unproven.</p>' : recordSummary(result)}${dlgActions(dlgBtn("Back to receipts", { action: "provider-list" }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`, "Read now by you. Not a worker receipt.");
}
async function providerFresh(key) {
  const { kind, record } = ownedProviderRecord(key);
  if (kind !== "reads") throw new Error("Fresh pinned reads require an original read observation");
  const grant = providerBinding(record.scopeId, record.repositoryId), id = projectId, current = generation;
  const identity = { id, provider: "github", repositoryId: grant.repositoryId, expectedRepositoryId: grant.numericId, pullRequest: record.pullRequest, expectedHead: record.head };
  const input = record.operation === "ci" ? { action: "provider-ci-inspect", ...identity, page: record.ci?.page ?? 1 } : record.operation === "review" ? { action: "provider-review-inspect", ...identity, page: 1 } : { action: "provider-pr-inspect", ...identity };
  const version = showDialog("Reading from GitHub", '<p class="note">Reading the same PR at the same commit…</p>', `${record.repositoryId} · PR #${record.pullRequest}`), result = await api(input);
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  providerResult(result, `Read of ${record.repositoryId} PR #${record.pullRequest} at commit ${record.head.slice(0, 12)}. No worker call is invented. Review reads start at page 1; more pages are listed in the result.`);
}
function providerInspect(key) {
  const { kind, record } = ownedProviderRecord(key);
  if (kind !== "writes") throw new Error("Effect inspection requires an original native write intent");
  const grant = providerBinding(record.scopeId), proposal = { projectId, key: record.key, record, repositoryId: grant.repositoryId, numericId: grant.numericId };
  showDialog("Check what happened?", `<div class="kv tight"><span>Repository</span><b>${esc(grant.repositoryId)}</b><span>Change</span><b>${esc(humanKey(record.operation))} · ${esc(record.target)}</b></div><p class="note-box">Only matching evidence on GitHub can settle this record; if none is found it stays unknown. This does not publish, roll back or retry anything.</p>${rawDetails(record)}<form data-provider-inspect data-project="${esc(projectId)}" data-key="${esc(record.key)}"><input type="hidden" name="confirm" value="${esc(projectId)}">${dlgActions(dlgBtn("Back", { action: "provider-record", project: projectId, record: key }), '<button type="submit" class="primary">Check on GitHub</button>')}</form>`, "Read-only check against GitHub.");
  providerInspection = proposal; disableActions();
}
function providerKnown() {
  if (!plan || view.project.workspaceAuthorization?.provider !== "github" || view.project.archived || view.project.deleted) throw new Error("A current active GitHub scope is required. Other workspace providers remain deferred");
  const scopes = view.project.workspaceAuthorization.scopes.filter(scope => view.project.githubAuthorization?.some(grant => grant.repositoryId === scope.repositoryId));
  if (!scopes.length) throw new Error("No explicit GitHub repository/scope grant is available");
  showDialog("Check a specific pull request", `<form data-provider-known data-project="${esc(projectId)}"><div class="field-grid"><div class="field"><label><span class="flabel">Repository</span><select name="scope">${scopes.map(scope => `<option value="${esc(scope.id)}">${esc(scope.repositoryId)}</option>`).join("")}</select></label></div><div class="field"><label><span class="flabel">What to read</span><select name="kind"><option value="pr">The PR itself</option><option value="ci">CI results</option><option value="review">Reviews and comments</option></select></label></div><div class="field"><label><span class="flabel">PR number</span><input name="pr" type="number" min="1" required autofocus></label></div><div class="field"><label><span class="flabel">Page</span><input name="page" type="number" min="1" max="1000000" value="1" required></label><span class="fhelp">Only used for CI and reviews.</span></div></div><div class="field"><label><span class="flabel">Commit (full SHA of the PR head)</span><input name="head" class="mono" minlength="40" maxlength="64" pattern="(?:[a-f0-9]{40}|[a-f0-9]{64})" required autocomplete="off" placeholder="40 hexadecimal characters"></label><span class="fhelp">The host checks repository, PR and commit together before reading.</span></div>${dlgActions(dlgBtn("Back", { action: "provider-list" }), '<button type="submit" class="primary">Read from GitHub</button>')}</form>`, "Read-only. It reads exactly what you name and grants nothing.");
  disableActions();
}
function lifecycleMore() {
  if (!plan) throw new Error("Lifecycle controls require a loaded Durable project");
  const p = view.project, inactive = p.archived || p.deleted, state = p.deleted ? "removed from the list" : p.archived ? "archived" : view.paused ? "paused" : "active";
  const choices = inactive ? [["restore", "Restore", "Brings the project back. It stays paused until you resume it."]] : [["archive", "Archive", "Pauses the project and keeps everything. You can restore it later."], ["delete", "Remove from list", "Pauses it and hides it from the project list. Files and work are kept; open it by its ID to restore."]];
  showDialog("Archive, delete or restore", `<div class="choice-list">${choices.map(([operation, label, help]) => `<div class="choice-card"><div><b>${label}</b><p>${help}</p></div>${dlgBtn(`${label}…`, { action: "lifecycle-confirm", project: projectId, operation }, operation === "restore" ? "" : "danger")}</div>`).join("")}</div><p class="note">Nothing in the repository, worker folders or remote PRs is deleted. Pause and resume keep their own controls.</p>${dlgActions(dlgBtn("Close", { action: "close-dialog" }))}`, `${p.name} is ${state}.`);
}
function lifecycleConfirm(id, operation) {
  requireProject(id);
  if (!plan || !["archive", "delete", "restore"].includes(operation)) throw new Error("Unknown Durable lifecycle action");
  const inactive = view.project.archived || view.project.deleted;
  if (operation === "restore" ? !inactive : inactive) throw new Error("Project lifecycle state changed; reopen its controls");
  const copy = { restore: ["Restore this project?", "Restore project", "Brings the saved project back. It stays paused; no work is resumed or replayed."], archive: ["Archive this project?", "Archive project", "Pauses and archives the project. Conversations, receipts, repository changes, worker folders and remote PRs all remain."], delete: ["Remove this project from the list?", "Remove from list", "Pauses the project and hides it from the list. All data, repository changes, worker folders and remote PRs remain. Open it by its ID to restore it later."] }[operation];
  showDialog(copy[0], `<p class="note-box${operation === "restore" ? "" : " warn"}">${esc(copy[2])}</p><div class="kv tight"><span>Project</span><b>${esc(view.project.name)}</b><span>ID</span><b class="mono">${esc(id)}</b></div><p class="note">No files or provider data are cleaned up.</p><form data-lifecycle-change data-project="${esc(id)}" data-operation="${operation}"><input type="hidden" name="confirm" value="${esc(id)}">${dlgActions(dlgBtn("Back", { action: "lifecycle-more" }), `<button type="submit" class="primary${operation === "restore" ? "" : " danger"}">${copy[1]}</button>`)}</form>`, view.project.name); disableActions();
}
async function routineList(lens = "schedules", offset = 0) {
  if (lens === "history") return routineHistory("intents", 0, 0);
  if (!plan || !["schedules", "monitors"].includes(lens) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Routine view requires a loaded Durable project and valid cached page");
  const id = projectId, current = generation, version = showDialog("Schedules and monitors", '<p class="note">Reading your automations…</p>', "Turn automations on or off. Every change asks you to confirm first.");
  const [schedules, monitors, policy] = await Promise.all([api({ action: "schedule-snapshot", id, includeHistory: false }), api({ action: "monitor-snapshot", id }), api({ action: "plan-snapshot", id })]);
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!schedules || typeof schedules.eventOptIn !== "boolean" || ![null, "uncertain-provider-write", "uncertain-command"].includes(schedules.automaticAdmissionBlocker) || !Array.isArray(schedules.schedules) || !Array.isArray(schedules.events) || !Array.isArray(schedules.intents) || schedules.events.length || schedules.intents.length || schedules.historyIncluded !== false || !Number.isSafeInteger(schedules.historyCounts?.events) || schedules.historyCounts.events < 0 || !Number.isSafeInteger(schedules.historyCounts?.intents) || schedules.historyCounts.intents < 0 || schedules.schedules.some(record => record.projectId !== id || typeof record.id !== "string" || !record.id || typeof record.enabled !== "boolean" || !["once", "interval", "calendar"].includes(record.kind) || typeof record.text !== "string") || !monitors || !Array.isArray(monitors.items) || monitors.items.some(record => !uuid(record.id) || typeof record.enabled !== "boolean" || !["pr", "ci", "review"].includes(record.kind) || typeof record.repositoryId !== "string" || !Number.isSafeInteger(record.expectedRepositoryId) || record.expectedRepositoryId < 1 || !Number.isSafeInteger(record.pullRequest) || record.pullRequest < 1) || !policy || typeof policy.paused !== "boolean" || typeof policy.pausing !== "boolean") throw new Error("Invalid owned routine projection");
  routineCache = { project: id, schedules, monitors, policy };
  const records = lens === "schedules" ? schedules.schedules : monitors.items, page = records.slice(offset, offset + 100), kind = lens === "schedules" ? "schedule" : "monitor";
  const tabs = segTabs([[`Schedules (${schedules.schedules.length})`, { action: "routine-list", project: id, lens: "schedules", offset: 0 }, lens === "schedules"], [`GitHub monitors (${monitors.items.length})`, { action: "routine-list", project: id, lens: "monitors", offset: 0 }, lens === "monitors"], [`History (${schedules.historyCounts.events + schedules.historyCounts.intents})`, { action: "routine-list", project: id, lens: "history" }, false]]);
  const toggle = (label, enabled, recordId = "", recordKind = kind) => dlgBtn(label, { action: "routine-confirm", project: id, kind: recordKind, record: recordId, enabled: !enabled }, "small");
  const rows = page.map(record => `<div class="list-row"><div class="grow"><strong>${lens === "schedules" ? esc(clip(record.text, 140)) : `${esc(record.repositoryId)} · PR #${record.pullRequest}`}</strong><span class="meta">${stateChip(record.enabled ? "On" : "Off", record.enabled ? "on" : "")}${esc(humanKey(record.kind))}${lens === "monitors" ? " monitor" : " schedule"}</span></div><div class="row-actions">${toggle(record.enabled ? "Turn off…" : "Turn on…", record.enabled, record.id)}</div>${rawDetails(record)}</div>`).join("") || `<p class="empty-state">No ${lens === "schedules" ? "schedules" : "monitors"} yet. They are created from the command line and start turned off.</p>`;
  setDialogBody(`${policy.paused || policy.pausing || schedules.automaticAdmissionBlocker ? `<p class="note-box warn">${policy.paused || policy.pausing ? "The project is paused, so nothing starts automatically. " : ""}${schedules.automaticAdmissionBlocker ? `Automatic runs are blocked until you check an earlier uncertain ${schedules.automaticAdmissionBlocker === "uncertain-command" ? "command" : "GitHub change"}.` : ""}</p>` : ""}<div class="choice-card"><div><b>Outside events ${stateChip(schedules.eventOptIn ? "On" : "Off", schedules.eventOptIn ? "on" : "")}</b><p>Lets events from GitHub or webhooks start work in this project.</p></div>${toggle(schedules.eventOptIn ? "Turn off…" : "Turn on…", schedules.eventOptIn, "", "events")}</div><div class="seg-row mt">${tabs}${pager({ offset, count: page.length, total: records.length, size: 100, data: { action: "routine-list", project: id, lens } })}</div>${rows}<p class="note">Routines run only while your Mac is awake, and only if they are on. This list is a sample read, not an atomic snapshot.</p>${dlgActions(dlgBtn("Refresh", { action: "routine-list", project: id, lens, offset }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
}
function validateRoutineRange(text, range, requested) {
  if (typeof text !== "string" || !range || ![range.offset, range.end, range.total].every(value => Number.isSafeInteger(value) && value >= 0) || !/^[a-f0-9]{64}$/.test(range.sha256) || range.offset !== Math.min(requested, range.total) || range.end < range.offset || range.end > range.total || range.end - range.offset !== Array.from(text).length || range.end - range.offset > 4000 || range.nextOffset !== (range.end < range.total ? range.end : null)) throw new Error("Routine history text range differs from its excerpt");
  return range.nextOffset;
}
async function routineHistory(kind = "intents", offset = 0, textOffset = 0) {
  if (!plan || !["events", "intents"].includes(kind) || ![offset, textOffset].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error("Routine history requires a loaded owned project and valid page");
  const id = projectId, current = generation, version = showDialog("Automation history", '<p class="note">Reading recent runs…</p>', "Recent runs and events. Read-only; nothing is replayed.");
  const page = await api({ action: "schedule-history", id, kind, offset, limit: 30, textOffset, textLimit: 4000 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || page.kind !== kind || page.offset !== offset || page.limit !== 30 || !Array.isArray(page.items) || page.items.length > 30 || !Number.isSafeInteger(page.total) || page.total < 0 || page.items.length > Math.max(0, page.total - offset) || page.nextOffset !== (offset + page.items.length < page.total ? offset + page.items.length : null) || page.nextOffset !== null && !page.items.length || !Number.isFinite(page.observedAtMs)) throw new Error("Routine history differs from the requested owned page");
  const continuations = [];
  for (const item of page.items) {
    if (!item || typeof item.requestId !== "string") throw new Error("Routine history is missing its recorded request identity");
    if (kind === "events") {
      if (item.projectId !== id || typeof item.eventId !== "string" || typeof item.kind !== "string") throw new Error("Event history is not bound to this project");
      const next = validateRoutineRange(item.payload, item.payloadRange, textOffset); if (next !== null) continuations.push(next);
    } else {
      if (typeof item.stableId !== "string" || !["schedule", "event"].includes(item.kind) || !["recorded", "submitted", "interrupted", "uncertain", "failed"].includes(item.status) || item.submissionId !== null && (!Number.isSafeInteger(item.submissionId) || item.submissionId < 1)) throw new Error("Invalid native intent identity/status");
      const next = validateRoutineRange(item.text, item.textRange, textOffset); if (next !== null) continuations.push(next);
      if (item.outcome === null ? item.outcomeRange !== null : !item.outcomeRange) throw new Error("Intent outcome/range mismatch");
      if (item.outcome !== null) { const nextOutcome = validateRoutineRange(item.outcome, item.outcomeRange, textOffset); if (nextOutcome !== null) continuations.push(nextOutcome); }
    }
  }
  const nextText = continuations.length ? Math.min(...continuations) : null, at = (nextOffset, nextTextOffset) => ({ action: "routine-history", project: id, kind, offset: nextOffset, "text-offset": nextTextOffset });
  const row = item => kind === "events"
    ? `<div class="list-row"><div class="grow"><strong>${esc(humanKey(item.kind))}</strong><span class="meta">Event ${esc(item.eventId.slice(0, 12))}</span><pre class="excerpt">${esc(item.payload)}</pre></div>${rawDetails(item)}</div>`
    : `<div class="list-row"><div class="grow"><strong>${stateChip(humanKey(item.status), item.status === "submitted" ? "on" : ["uncertain", "failed", "interrupted"].includes(item.status) ? "warn" : "")}${esc(humanKey(item.kind))} run</strong><span class="meta">Request ${esc(item.requestId.slice(0, 12))}</span><pre class="excerpt">${esc(item.text)}</pre>${item.outcome !== null ? `<pre class="excerpt">${esc(item.outcome)}</pre>` : ""}</div>${rawDetails(item)}</div>`;
  setDialogBody(`<div class="seg-row">${segTabs([["Runs", { action: "routine-history", project: id, kind: "intents", offset: 0, "text-offset": 0 }, kind === "intents"], ["Events", { action: "routine-history", project: id, kind: "events", offset: 0, "text-offset": 0 }, kind === "events"]])}${pager({ offset, count: page.items.length, total: page.total, size: 30, data: { action: "routine-history", project: id, kind, "text-offset": 0 } })}</div><p class="note">Sampled ${esc(new Date(page.observedAtMs).toLocaleString())}. Long text is shown in parts; excerpts cannot prove the full text or any outside effect.</p>${page.items.map(row).join("") || '<p class="empty-state">Nothing recorded in this page.</p>'}${textOffset || nextText !== null ? `<div class="row">${textOffset ? dlgBtn("‹ Earlier text", at(offset, Math.max(0, textOffset - 4000)), "small") : ""}${nextText !== null ? dlgBtn("Later text ›", at(offset, nextText), "small") : ""}</div>` : ""}${dlgActions(dlgBtn("Back to schedules", { action: "routine-list", project: id }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
}
function routineRecord(kind, recordId) {
  if (!routineCache || routineCache.project !== projectId || !["schedule", "monitor", "events"].includes(kind)) throw new Error("Owned routine snapshot unavailable; reread");
  if (kind === "events") return { eventOptIn: routineCache.schedules.eventOptIn };
  const record = (kind === "schedule" ? routineCache.schedules.schedules : routineCache.monitors.items).find(record => record.id === recordId);
  if (!record) throw new Error("Routine not present in the displayed owned snapshot");
  return record;
}
function routineConfirm(kind, recordId, value) {
  if (value !== "true" && value !== "false") throw new Error("Routine desired state must be explicit");
  const record = routineRecord(kind, recordId), enabled = value === "true", id = projectId;
  if (view.project.archived || view.project.deleted) throw new Error("Restore this retained project before changing routines");
  if ((kind === "events" ? record.eventOptIn : record.enabled) === enabled) throw new Error("Displayed routine setting changed; reread before confirming");
  const binding = JSON.stringify(record), noun = kind === "events" ? "outside events" : `this ${kind}`, state = on => (on ? "On" : "Off");
  const version = showDialog(`Turn ${enabled ? "on" : "off"} ${noun}?`, `<div class="diff-list">${diffItem(["Status", state(!enabled), state(enabled)])}</div>${kind === "events" ? "" : recordSummary(record)}<p class="note">${enabled ? "Turning on lets it run while your Mac is awake. It does not resume the project, grant tools or publishing, clear an uncertain outcome or replay anything. Monitors also need outside events on and current repository access." : "Turning off keeps its schedule, history and cursors. It just stops running."}</p><form data-routine-change data-project="${esc(id)}"><input type="hidden" name="confirm" value="${esc(id)}">${dlgActions(dlgBtn("Back", { action: "routine-list", project: id, lens: kind === "monitor" ? "monitors" : "schedules" }), `<button type="submit" class="primary">Turn ${enabled ? "on" : "off"}</button>`)}</form>`, view.project.name);
  routineConfirmation = { project: id, kind, recordId, enabled, binding, version };
}
async function usageList(offset = 0) {
  if (!plan || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("Usage requires a loaded Durable project/valid page");
  const id = projectId, current = generation, coordinatorId = view.durableInspection?.identity.coordinatorConversationId, version = showDialog("Usage", '<p class="note">Reading token counts…</p>', "Token counts recorded by the SDK. Estimates, not billing.");
  const page = await api({ action: "usage-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || page.offset !== offset || !Array.isArray(page.workers) || page.workers.length > 100 || !Number.isSafeInteger(page.totalWorkers) || page.totalWorkers < 0 || !page.coordinator || coordinatorId !== undefined && page.coordinator.conversationId !== coordinatorId || page.nextOffset !== null && (!page.workers.length || page.nextOffset !== offset + page.workers.length) || page.workers.some(worker => !["thread", "legacy"].includes(worker.kind) || worker.kind === "thread" && !uuid(worker.threadId) || !Number.isSafeInteger(worker.conversationId))) throw new Error("Usage projection differs from its owned conversation/page");
  const number = value => Number(value).toLocaleString(), stat = (label, value) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const counters = value => {
    if (!value || [value.totalTokens, value.input, value.output, value.cacheRead, value.cacheWrite, value.cost?.total].some(count => typeof count !== "number" || !Number.isFinite(count) || count < 0)) throw new Error("Invalid SDK usage counters");
    return `<div class="stats">${stat("Total tokens", number(value.totalTokens))}${stat("Input", number(value.input))}${stat("Output", number(value.output))}${stat("Cache read", number(value.cacheRead))}${stat("Cache written", number(value.cacheWrite))}${stat("Estimated cost", `$${value.cost.total.toFixed(2)}`)}</div>`;
  };
  const detail = value => `${counters(value.total)}${rawDetails({ models: value.models, tools: value.tools }, "By model and tool")}`;
  setDialogBody(`<h3>Coordinator</h3>${detail(page.coordinator)}<h3>Workers</h3><p class="note">${esc(page.totalThreads)} reusable threads and ${esc(page.legacyOnlyWorkers)} older workers. The totals below cover this page only, not the whole project.</p>${counters(page.workerPageTotal)}${page.workers.length ? `<div class="seg-row mt"><span class="note">Workers on this page</span>${pager({ offset, count: page.workers.length, total: page.totalWorkers, size: 100, data: { action: "usage-list" } })}</div>` : ""}${page.workers.map(worker => `<div class="list-row"><div class="grow"><strong>${worker.kind === "thread" ? `Thread ${esc(worker.threadId.slice(0, 8))}` : `Earlier worker ${esc(worker.name)}`}</strong><span class="meta">${number(worker.total.totalTokens)} tokens · $${worker.total.cost.total.toFixed(2)} estimated${(worker.legacyNames ?? []).length ? ` · also known as ${esc(worker.legacyNames.join(", "))}` : ""}</span></div>${detail(worker)}</div>`).join("") || '<p class="empty-state">No workers have run yet.</p>'}<p class="note">Observed ${esc(new Date(page.observedAtMs).toLocaleString())}. ${esc(String(page.accounting).replace(/\.$/, ""))}. SDK estimates are not billing or verified spend.</p>${dlgActions(dlgBtn("Refresh", { action: "usage-list", offset }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
}
function validateSettings(value) {
  const v = value?.values;
  if (!value || !/^[a-f0-9]{64}$/.test(value.revision) || !v || [v.name, v.objective, v.model].some(text => typeof text !== "string") || [v.models?.worker, v.models?.scout, v.models?.reviewer, v.models?.verifier, v.fallbackModels?.worker, v.fallbackModels?.scout, v.fallbackModels?.reviewer].some(text => text !== undefined && typeof text !== "string") || v.scopedModels !== null && !Array.isArray(v.scopedModels) || !["read-only", "maintain"].includes(v.knowledgeAccess) || !["none", "coordinator"].includes(v.libraryAccess) || !["none", "coordinator"].includes(v.decisionAccess) || v.verification !== null && (typeof v.verification?.enabled !== "boolean" || typeof v.verification.skill !== "string") || !Number.isSafeInteger(v.workerCap) || v.workerCap < 1 || v.workerCap > 32 || value.verificationProblem !== null && typeof value.verificationProblem !== "string") throw new Error("Invalid settings snapshot/receipt");
}
function captureSettingsDraft() {
  const form = dialog.querySelector("[data-settings-form]");
  if (!form || !settingsCache || form.dataset.project !== settingsCache.projectId) return;
  const flat = settingsFormValues(form), was = flatSettings(settingsCache.values);
  settingsPending = { projectId: form.dataset.project, flat: Object.fromEntries(Object.entries(flat).filter(([field, value]) => value !== was[field])) };
  for (const field of ["name", "objective"]) {
    const key = `${form.dataset.project}:${field}`, draft = settingsDrafts.get(key);
    if (flat[field] === settingsCache.values[field]) settingsDrafts.delete(key);
    else if (draft) draft.text = flat[field];
    else settingsDrafts.set(key, { text: flat[field], expectedRevision: settingsCache.revision });
  }
}
async function ownerSetupDialog(result = null) {
  const id = projectId, generationAtOpen = generation, version = showDialog("Owner setup", '<p class="note">Reading current owner bindings…</p>', "What workers on this project are allowed to touch.");
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const row = (title, meta, button) => `<div class="list-row"><div class="grow"><strong>${title}</strong><span class="meta">${meta}</span></div><div class="row-actions">${button}</div></div>`;
  const workspaces = (snapshot.workspace?.scopes || []).map(scope => row(`${esc(scope.repositoryId)}${scope.wholeRepository ? " · whole repository" : ""}`, `${scope.fileCount} files · base ${esc(String(scope.baseRevision).slice(0, 12))} · scope ${esc(String(scope.id).slice(0, 8))}`, dlgBtn("Revoke…", { action: "owner-setup-edit", kind: "workspace-revoke", payload: JSON.stringify({ scopeId: scope.id, expectedRevision: snapshot.workspaceRevision }) }, "danger small"))).join("") || '<p class="empty-state">No folder scopes.</p>';
  const github = (snapshot.github || []).map(auth => row(esc(auth.repositoryId), `Branches ${esc(auth.branchPrefix)}… · draft PRs against ${esc(auth.baseBranch)}`, dlgBtn("Revoke…", { action: "owner-setup-edit", kind: "github-revoke", payload: JSON.stringify({ repositoryId: auth.repositoryId, expectedRevision: snapshot.githubRevision }) }, "danger small"))).join("") || '<p class="empty-state">No GitHub authorizations.</p>';
  const profiles = (snapshot.profiles || []).map(profile => row(`${esc(profile.label)}`, `${esc(profile.repositoryId)} · ${profile.enabled ? "enabled" : "disabled"} · ${esc(profile.blocker || "no blocker")}`, dlgBtn("View command", { action: "owner-profile-read", project: id, profile: profile.id }, "small"))).join("") || '<p class="empty-state">No command profiles.</p>';
  const seeds = {
    "workspace-grant": { expectedRevision: snapshot.workspaceRevision, provider: "github", repositoryId: "", ownerCheckout: view.project.cwd, approvedRoot: "", fileOwnershipPrefix: "", files: [], baseRevision: "" },
    "github-authorize": { expectedRevision: snapshot.githubRevision, repositoryId: "", expectedRepositoryId: 0, branchPrefix: "" },
    "command-profile-set": { expectedRevision: snapshot.profilesRevision, profile: { id: crypto.randomUUID(), label: "", repositoryId: "", scopeIds: [], executable: "", arguments: [], effect: "workspace", timeoutMs: 300000, maxOutputBytes: 65536, enabled: false } },
  };
  const actions = [["workspace-grant", "Add a folder scope"], ["github-authorize", "Authorize a GitHub repository"], ["command-profile-set", "Register a command profile"]].map(([kind, label]) => dlgBtn(label, { action: "owner-setup-edit", kind, payload: JSON.stringify(seeds[kind]) }, "small")).join("");
  const hist = `<p class="note">${esc((snapshot.configuredCatalog?.reason || "Configured skills unavailable").replace(/\.$/, ""))}. Registering a command profile does not run it or approve deployments or destructive actions.</p>${rawDetails({ workspaceRevision: snapshot.workspaceRevision, githubRevision: snapshot.githubRevision, profilesRevision: snapshot.profilesRevision }, "Revisions")}`;
  const whole = (snapshot.workspace?.scopes || []).find(scope => scope.wholeRepository);
  const connected = whole && (snapshot.github || []).find(auth => auth.repositoryId === whole.repositoryId);
  const providerCardHtml = card => `<div class="card"><b>${card.state === "connected" ? "✓ " : ""}${esc(card.title)}</b><p class="note">${esc(card.body)}</p>${card.state === "available" && card.connect ? `<button class="primary" data-action="provider-connect" data-card="${esc(card.id)}">${esc(card.connect.label)}</button>` : ""}</div>`;
  const pluginCards = !whole ? "" : snapshot.unloadedProvider ? `<div class="card"><b>${esc(snapshot.unloadedProvider)}</b><p class="note">The provider plugin is not loaded, so workers cannot start here. Load it (see the plugin documentation) or remove the grant; its records are kept.</p></div>` : (snapshot.providerCards ?? []).map(providerCardHtml).join("");
  const githubCard = !whole ? "" : snapshot.workspace?.provider && snapshot.workspace.provider !== "github" ? pluginCards : connected ? `<div class="card"><b>✓ GitHub connected</b><p class="note">Workers push ${esc(connected.branchPrefix)} branches to ${esc(connected.repositoryId)} and open draft PRs against ${esc(connected.baseBranch)}. You approve merges.</p></div>` : snapshot.githubQuick?.available ? `<div class="card"><b>GitHub</b><p class="note">Workers cannot open draft PRs yet.</p><button class="primary" data-action="github-quick">Connect GitHub</button></div>` : `<div class="card"><b>GitHub</b><p class="note">${esc(snapshot.githubQuick?.blocker || "One-click GitHub is unavailable")}</p></div>`;
  const quick = whole ? githubCard : snapshot.quickGrant?.available ? `<div class="card"><b>Workspace</b><p class="note">Workers cannot edit code yet.</p><button class="primary" data-action="workspace-quick">Let workers edit this repo</button></div>` : `<div class="card"><b>Workspace</b><p class="note">${esc(snapshot.quickGrant?.blocker || "One-click access is unavailable")}</p></div>`;
  setDialogBody(`${result ? `<p class="note-box ok">Change recorded. No command was run.</p>${rawDetails(result, "Host response")}` : ""}<div class="choice-list">${quick}</div><details class="advanced"><summary>Advanced: folder scopes, GitHub targets, command profiles</summary>${hist}<h3>Look up a GitHub repository</h3><form data-owner-github-inspect data-project="${esc(id)}" class="row"><label class="grow"><span class="sr-only">Repository, owner/name</span><input name="repositoryId" placeholder="owner/repository" aria-label="Repository, owner/name" required></label><button type="submit" class="small">Look up</button></form><p class="note">Reads its numeric ID and default branch. It must match the checkout's GitHub origin.</p><h3>Add or change</h3><div class="row">${actions}</div><h3>Folder scopes</h3>${workspaces}<h3>GitHub authorizations</h3>${github}<h3>Command profiles</h3>${profiles}</details>${dlgActions(dlgBtn("Refresh", { action: "owner-setup" }), dlgBtn("Done", { action: "close-dialog" }, "primary"))}`);
}

async function workspaceQuickDialog() {
  const id = projectId, generationAtOpen = generation, version = showDialog("Let workers edit this repo", '<p class="note">Reading the project checkout…</p>', "Workers get their own copy of your checkout. Your files are never written.");
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const quick = snapshot.quickGrant;
  if (!quick?.available) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(quick?.blocker || "One-click access is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`; return; }
  const other = quick.provider !== "github", extra = quick.dialog;
  dialog.querySelector(".dialog-body").innerHTML = `<div class="kv"><span>Repository</span><b>${esc(quick.repositoryId)}</b><span>${other ? esc(extra?.checkoutLabel ?? "Checkout") : "Checkout"}</span><b class="mono">${esc(quick.ownerCheckout)}</b>${(extra?.rows ?? []).map(([label, value]) => `<span>${esc(label)}</span><b class="mono">${esc(value)}</b>`).join("")}<span>Worker copies</span><b class="mono">${esc(quick.approvedRoot)}</b><span>${other ? "Base head" : "Current HEAD"}</span><b class="mono">${esc(quick.head.slice(0, 12))}</b></div>
${other ? `<ul>${(extra?.bullets ?? []).map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : `<ul><li>Each worker gets its own git worktree, starting from HEAD at the time it starts.</li><li>Workers may read, edit and create any file except VCS metadata (.git). Your checkout is never written.</li><li>Workers may run repository commands in their isolated worktree. Draft PRs need GitHub (step 1); merges always need your approval.</li></ul>`}${quick.dirty ? `<p class="notice">Your checkout has uncommitted changes. Workers ${other ? "start from the provider's base and" : "will"} not see them.</p>` : ""}
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Allow workers to edit", { action: "workspace-quick-confirm", project: id, revision: snapshot.workspaceRevision }, "primary"))}`;
}

async function workspaceQuickConfirm(target, revision) {
  requireProject(target);
  await mutate({ action: "workspace-quick-grant", id: target, confirm: target, expectedRevision: revision }, "Workers can now edit this repository.");
  if (projectId === target && dialog.open) await ownerSetupDialog();
}
// One-click connection of a workspace provider plugin: the plugin's setup card describes the dialog; the confirm calls its RPC with the card's revision.
let connectDraft = null;
async function providerConnectDialog(cardId) {
  const id = projectId, generationAtOpen = generation, version = showDialog("Connect", '<p class="note">Reading the project…</p>', "");
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const card = (snapshot.providerCards ?? []).find(item => item.id === cardId);
  if (!card?.connect) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(card?.body || "This connection is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`; return; }
  const connect = card.connect;
  dialog.querySelector("#dialog-title").textContent = connect.dialog.title; connectDraft = card;
  dialog.querySelector(".dialog-body").innerHTML = `${connect.dialog.intro ? `<p>${esc(connect.dialog.intro)}</p>` : ""}<ul>${connect.dialog.bullets.map(item => `<li>${esc(item)}</li>`).join("")}</ul>
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn(connect.dialog.confirmLabel, { action: "provider-connect-confirm", project: id, card: card.id, revision: card.revision }, "primary"))}`;
}
async function providerConnectConfirm(target, cardId, revision) {
  requireProject(target);
  const connect = connectDraft?.id === cardId ? connectDraft.connect : null;
  if (!connect) throw new Error("This connection is no longer available; refresh");
  await mutate({ action: "plugin", plugin: connect.rpc.plugin, method: connect.rpc.method, id: target, params: { confirm: target, expectedRevision: revision } }, connect.success);
  if (projectId === target && dialog.open) await ownerSetupDialog();
}
async function githubQuickDialog() {
  const id = projectId, generationAtOpen = generation, version = showDialog("Connect GitHub", '<p class="note">Reading the repository from GitHub…</p>', "Let workers push branches and open draft pull requests.");
  const stale = () => !dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen;
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (stale()) return;
  const quick = snapshot.githubQuick;
  if (!quick?.available) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(quick?.blocker || "One-click GitHub is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`; return; }
  let remote;
  try { remote = await api({ action: "github-repository-inspect", id, repositoryId: quick.repositoryId }); }
  catch (error) { if (!stale()) dialog.querySelector(".dialog-body").innerHTML = `<p>gh could not read ${esc(quick.repositoryId)}: ${esc(error.message)}</p><p class="note">Run <code>gh auth login</code>, then try again.</p>${dlgActions(dlgBtn("Close", { action: "close-dialog" }))}`; return; }
  if (stale()) return;
  dialog.querySelector(".dialog-body").innerHTML = `<div class="kv"><span>Repository</span><b>${esc(remote.repositoryId)}</b><span>Repository ID</span><b class="mono">${esc(remote.numericId)}</b><span>Draft PRs target</span><b class="mono">${esc(remote.defaultBranch)}</b><span>Worker branches</span><b class="mono">${esc(quick.branchPrefix)}…</b></div>
<ul><li>Each worker commits and pushes only its own ${esc(quick.branchPrefix)} branch.</li><li>The host checks that the pushed branch matches the worker's HEAD, then opens or updates a draft PR against ${esc(remote.defaultBranch)}.</li><li>Workers can read PRs, CI results and reviews, and reply to review comments.</li><li>Merges always need your approval.</li></ul>
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Connect GitHub", { action: "github-quick-confirm", project: id, revision: snapshot.githubRevision }, "primary"))}`;
}

async function githubQuickConfirm(target, revision) {
  requireProject(target);
  await mutate({ action: "github-quick-authorize", id: target, confirm: target, expectedRevision: revision }, "GitHub connected. Workers can open draft PRs.");
  if (projectId === target && dialog.open) await ownerSetupDialog();
}
const ownerEditCopy = {
  "workspace-grant": ["Add a folder scope", "Let workers read and edit files under one approved folder.", "Create scope"],
  "github-authorize": ["Authorize a GitHub repository", "Let workers push branches and open draft pull requests on one repository.", "Authorize"],
  "command-profile-set": ["Register a command profile", "A fixed executable and arguments that workers may run. It is not run now.", "Save profile"],
  "workspace-revoke": ["Revoke this folder scope?", "Workers lose access to it for future work. Receipts and history stay.", "Revoke access"],
  "github-revoke": ["Revoke GitHub access?", "Workers can no longer push or open pull requests there. Receipts and history stay.", "Revoke access"],
};
// Owner-setup writes keep their exact API fields; the form shows them as labelled controls and rebuilds the same JSON object.
function ownerFieldInputs(value, path = [], hidden = false) {
  return Object.entries(value).map(([key, item]) => {
    const name = [...path, key].join("."), label = humanKey(key), data = `data-path="${esc(name)}" data-type="${typeof item}"`;
    if (item && typeof item === "object" && !Array.isArray(item)) return `${hidden ? "" : `<h3>${esc(label)}</h3>`}${ownerFieldInputs(item, [...path, key], hidden)}`;
    if (hidden || key === "expectedRevision" || key === "id") return `<input type="hidden" ${data} value="${esc(item)}">`;
    if (Array.isArray(item)) return `<div class="field"><label><span class="flabel">${esc(label)}</span><span class="fhelp">One per line.</span><textarea rows="3" data-path="${esc(name)}" data-type="lines" spellcheck="false">${esc(item.join("\n"))}</textarea></label></div>`;
    if (typeof item === "boolean") return `<div class="field"><label class="checkbox"><input type="checkbox" data-path="${esc(name)}" data-type="boolean"${item ? " checked" : ""}><span>${esc(label)}</span></label></div>`;
    return `<div class="field"><label><span class="flabel">${esc(label)}</span><input ${data} ${typeof item === "number" ? 'type="number"' : ""} value="${esc(item)}"></label></div>`;
  }).join("");
}
function ownerFieldsValue(form) {
  const fields = {};
  for (const input of form.querySelectorAll("[data-path]")) {
    const keys = input.dataset.path.split("."), type = input.dataset.type;
    const value = type === "lines" ? input.value.split("\n").map(line => line.trim()).filter(Boolean) : type === "boolean" ? input.checked : type === "number" ? Number(input.value) : input.value;
    let target = fields;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  return fields;
}
async function ownerSetupEdit(kind, payload) {
  if (!view) throw new Error("Select a project before owner setup");
  const target = projectId, currentGeneration = generation;
  let initial;
  try { initial = JSON.parse(payload); } catch { throw new Error("Owner setup seed is invalid"); }
  if (projectId !== target || generation !== currentGeneration || !Object.hasOwn(ownerEditCopy, kind)) return;
  const [title, subtitle, submit] = ownerEditCopy[kind], revoke = kind.endsWith("-revoke");
  const summary = revoke ? `<div class="kv tight">${Object.entries(initial).filter(([key]) => key !== "expectedRevision").map(([key, value]) => `<span>${esc(humanKey(key))}</span><b class="mono">${esc(value)}</b>`).join("")}</div><input type="hidden" name="confirm" value="${esc(target)}">` : "";
  showDialog(title, `<form data-owner-write data-kind="${esc(kind)}" data-project="${esc(target)}">${summary}${ownerFieldInputs(initial, [], revoke)}<p class="note">${revoke ? "Revoking only stops future work. Nothing already recorded is deleted." : "The host checks the revision you are looking at and the repository identity before it saves. Nothing runs."}</p>${dlgActions(dlgBtn("Cancel", { action: "owner-setup" }), `<button type="submit" class="primary${revoke ? " danger" : ""}">${submit}</button>`)}</form>`, subtitle);
}

async function ownerProfileRead(target, profileId) {
  requireProject(target);
  const generationAtOpen = generation, version = showDialog("Command profile", '<p class="note">Reading the exact command…</p>', "Fixed by you. The model cannot change it.");
  const profile = await api({ action: "command-profile-read", id: target, profileId });
  if (projectId !== target || generation !== generationAtOpen || !dialog.open || dialogVersion !== version) return;
  setDialogBody(`<h3>Command</h3><pre>${esc([profile.executable, ...(profile.arguments ?? [])].filter(part => part !== undefined).join(" "))}</pre><p class="note">Workers cannot supply the executable, arguments, folder or environment. A profile does not approve deployments or destructive actions.</p><h3>Details</h3>${recordSummary(profile, ["executable"])}${dlgActions(dlgBtn("Back to owner setup", { action: "owner-setup" }, "primary"))}`);
}

// Project settings: one form (name, objective, models, access, worker limit), then one confirmation that shows every before → after.
const settingsRoles = [["coordinator", "Coordinator", "Plans the work and talks to you."], ["worker", "Worker", "Writes code in its own worktree."], ["scout", "Scout", "Reads the repository and reports back."], ["reviewer", "Reviewer", "Checks changes and pull requests."], ["verifier", "Verifier", "Runs the verification skill against finished work. Needed when verification is on."]];
const settingsAccess = {
  knowledgeAccess: ["Workers and project knowledge", "The coordinator always keeps the knowledge notes up to date.", [["read-only", "Workers can read it"], ["maintain", "Workers can read and update it"]]],
  libraryAccess: ["Uploaded files and evidence", "Whether the coordinator may open the project library.", [["none", "Coordinator cannot open them"], ["coordinator", "Coordinator can open them"]]],
  decisionAccess: ["Questions for you", "Whether the coordinator may ask you to decide something.", [["none", "Coordinator cannot ask"], ["coordinator", "Coordinator can ask"]]],
  githubCli: ["Coordinator GitHub CLI (gh): full access", "Lets the coordinator run any gh command as you (merge, close, delete, settings). Off removes the tool.", [["full", "Full access (merge, close, delete, settings)"], ["none", "Off"]]],
};
let settingsPending = null, modelScoped = [], modelUnavailableScoped = [], modelScopeSet = false, modelExtensionErrors = [];
const scopeKey = refs => [...refs].sort().join("\n");
const flatSettings = values => ({ name: values.name, objective: values.objective, coordinator: values.model, worker: values.models.worker ?? "", scout: values.models.scout ?? "", reviewer: values.models.reviewer ?? "", verifier: values.models.verifier ?? "", verifyEnabled: values.verification?.enabled ? "on" : "off", verifySkill: values.verification?.skill ?? "", workerFallback: values.fallbackModels?.worker ?? "", scoutFallback: values.fallbackModels?.scout ?? "", reviewerFallback: values.fallbackModels?.reviewer ?? "", scoped: scopeKey(values.scopedModels ?? []), knowledgeAccess: values.knowledgeAccess, libraryAccess: values.libraryAccess, decisionAccess: values.decisionAccess, githubCli: values.githubCli ?? "full", workerCap: String(values.workerCap) });
function settingsFormValues(form) {
  const flat = { name: form.elements.name.value, objective: form.elements.objective.value, workerCap: form.elements.workerCap.value, verifyEnabled: form.elements.verifyEnabled.checked ? "on" : "off", verifySkill: form.elements.verifySkill.value.trim() };
  for (const field of Object.keys(settingsAccess)) flat[field] = form.elements[field].value;
  for (const [role] of settingsRoles) {
    flat[role] = form.querySelector(`.mp[data-role="${role}"]`).dataset.value;
    if (role !== "coordinator" && role !== "verifier") flat[`${role}Fallback`] = form.querySelector(`.mp[data-role="${role}-fallback"]`).dataset.value;
  }
  flat.scoped = scopeKey([...form.querySelectorAll("[data-scope-ref]:checked")].map(box => box.dataset.scopeRef));
  return flat;
}
function settingsChanges(flat, values) {
  const was = flatSettings(values), changes = {};
  for (const field of ["name", "objective", "knowledgeAccess", "libraryAccess", "decisionAccess", "githubCli"]) if (flat[field] !== was[field]) changes[field] = flat[field];
  if (flat.workerCap !== was.workerCap) changes.workerCap = Number(flat.workerCap);
  if (flat.coordinator !== was.coordinator) changes.model = flat.coordinator;
  for (const role of ["worker", "scout", "reviewer"]) {
    if (flat[role] !== was[role]) (changes.models ??= {})[role] = flat[role] === "" ? null : flat[role];
    if (flat[`${role}Fallback`] !== was[`${role}Fallback`]) (changes.fallbackModels ??= {})[role] = flat[`${role}Fallback`] === "" ? null : flat[`${role}Fallback`];
  }
  if (flat.verifier !== was.verifier) (changes.models ??= {}).verifier = flat.verifier === "" ? null : flat.verifier;
  if (flat.verifyEnabled !== was.verifyEnabled || flat.verifyEnabled === "on" && flat.verifySkill !== was.verifySkill) changes.verification = flat.verifyEnabled === "on" ? { enabled: true, skill: flat.verifySkill } : null;
  if (flat.scoped !== was.scoped) changes.scopedModels = flat.scoped === "" ? null : flat.scoped.split("\n");
  return changes;
}
function validateSettingsChanges(changes) {
  if ("name" in changes && (!changes.name.trim() || !editableKnowledge(changes.name)) || "objective" in changes && !editableKnowledge(changes.objective)) throw new Error("The name cannot be empty, and name and objective cannot contain control characters. Your edits are kept.");
  if (changes.verification?.enabled && !changes.verification.skill) throw new Error("Name the verification skill to run, or turn verification off. Your edits are kept.");
  if ("workerCap" in changes && (!Number.isSafeInteger(changes.workerCap) || changes.workerCap < 1 || changes.workerCap > 32)) throw new Error("Workers at once must be a whole number from 1 to 32.");
}
// The request must use the revision each retained text edit started from, so a stale edit is rejected by the host instead of being rebased.
function settingsRevisionFor(changes) {
  const revisions = new Set();
  for (const field of ["name", "objective"]) { const draft = field in changes && settingsDrafts.get(`${projectId}:${field}`); if (draft) revisions.add(draft.expectedRevision); }
  if (revisions.size > 1) throw new Error("The name and objective edits started on different versions of the settings. Discard one of them or save them separately.");
  return [...revisions][0] ?? settingsCache.revision;
}
function settingsSync() {
  const form = dialog.querySelector("[data-settings-form]");
  if (!form || !settingsCache) return;
  const flat = settingsFormValues(form), was = flatSettings(settingsCache.values);
  let count = 0;
  for (const field of form.querySelectorAll(".field[data-field]")) { const changed = flat[field.dataset.field] !== was[field.dataset.field]; field.classList.toggle("changed", changed); if (changed) count++; }
  const submit = form.querySelector('[type="submit"]'), hint = form.querySelector(".hint");
  submit.toggleAttribute("data-off", !count); submit.disabled = busy || !count;
  hint.textContent = count ? `${count} unsaved ${count === 1 ? "change" : "changes"}` : "No changes yet"; hint.classList.toggle("dirty", count > 0);
}
async function settingsList(keep = false) {
  if (!plan) throw new Error("Settings require a loaded Durable project");
  const id = projectId, current = generation, version = showDialog("Project settings", '<p class="note">Loading settings…</p>', "Name, objective, models and what workers may use.");
  if (!keep) settingsPending = null;
  const [value, pickerError] = await Promise.all([api({ action: "settings-snapshot", id }), loadModelPicker().then(() => "", error => error.message)]);
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  validateSettings(value); settingsCache = { ...value, projectId: id };
  const draftOf = field => settingsDrafts.get(`${id}:${field}`), pending = settingsPending?.projectId === id ? settingsPending.flat : {};
  const shown = { ...flatSettings(value.values), ...Object.fromEntries(["name", "objective"].filter(field => draftOf(field)).map(field => [field, draftOf(field).text])), ...pending };
  const draftNote = field => { const draft = draftOf(field); return draft && draft.text !== value.values[field] ? `<span class="field-draft">Unsent edit kept${draft.expectedRevision !== value.revision ? " from an older version of these settings. Saving it is checked and may be rejected" : ""}. ${dlgBtn("Discard edit…", { action: "settings-discard", project: id, field }, "ghost small")}</span>` : ""; };
  const roleField = ([role, label, help]) => `<div class="field" data-field="${role}"><span class="flabel">${label} model</span><span class="fhelp">${help}${role === "coordinator" ? "" : role === "verifier" ? " No default: pick one to turn verification on." : " Follows the coordinator unless you pick a model."}</span>${modelPickerHtml(role, shown[role], pickerError)}</div>`;
  const fallbackField = ([role, label]) => `<div class="field" data-field="${role}Fallback"><span class="flabel">${label} quota fallback</span><span class="fhelp">Only this model is used after quota exhaustion. Leave empty to wait for quota reset. Other frozen permissions stay unchanged.</span>${modelPickerHtml(`${role}-fallback`, shown[`${role}Fallback`], pickerError, "Wait for quota reset")}</div>`;
  const chosenScope = shown.scoped ? shown.scoped.split("\n") : [], scopeRows = [...modelCache.values()].filter(model => model.configured || chosenScope.includes(model.reference));
  const scopeField = `<div class="field" data-field="scoped"><span class="flabel">Scoped models</span><span class="fhelp">The models the model button and Ctrl+P cycle through, in list order. Leave all unchecked to use your Pi scope.</span><details class="scope-editor"${chosenScope.length ? " open" : ""}><summary>${chosenScope.length ? `${chosenScope.length} chosen for this project` : "Your Pi scope"}</summary><input type="search" class="scope-filter" data-scope-filter placeholder="Filter ${scopeRows.length} models…" aria-label="Filter scoped models" autocomplete="off"><div class="scope-list">${scopeRows.map(model => `<label class="scope-row"><input type="checkbox" data-scope-ref="${esc(model.reference)}"${chosenScope.includes(model.reference) ? " checked" : ""}${model.configured ? "" : " disabled"}><span>${esc(model.name)}</span><small class="mono">${esc(model.reference)}</small></label>`).join("") || '<p class="note">No models are available.</p>'}</div>${dlgBtn("Use my Pi scope", { action: "scope-clear" }, "ghost small")}</details></div>`;
  const accessField = ([field, [label, help, options]]) => `<div class="field" data-field="${field}"><label><span class="flabel">${label}</span><select name="${field}">${options.map(([option, text]) => `<option value="${option}"${shown[field] === option ? " selected" : ""}>${text}</option>`).join("")}</select></label><span class="fhelp">${help}</span></div>`;
  setDialogBody(`<form data-settings-form data-project="${esc(id)}" novalidate>
<div class="field" data-field="name"><label><span class="flabel">Project name</span><input name="name" maxlength="120" autocomplete="off" value="${esc(shown.name)}"></label>${draftNote("name")}</div>
<div class="field" data-field="objective"><label><span class="flabel">Objective</span><span class="fhelp">What this project is for. The coordinator reads it in every new conversation.</span><textarea name="objective" rows="5" maxlength="32000">${esc(shown.objective)}</textarea></label>${draftNote("objective")}</div>
<h3>Models</h3><p class="note">New threads use these. Threads that are already running keep the model they started with. The coordinator can be switched from the model button in the chat.${pickerError ? ` The model list is unavailable (${esc(pickerError)}).` : " Scoped models come from your Pi settings; search finds every configured model."}</p>
<div class="field-grid">${settingsRoles.map(roleField).join("")}</div>${scopeField}
<h3>Quota recovery</h3><p class="note">New threads freeze these fallback choices. After a recognized quota error, work continues on the same thread with its fallback. Without one, it waits for a known reset or retries with bounded exponential backoff. Paused or stopped workers never restart automatically.</p><div class="field-grid">${settingsRoles.filter(([role]) => role !== "coordinator" && role !== "verifier").map(fallbackField).join("")}</div>
<h3>Workers</h3>
<div class="field-grid"><div class="field" data-field="workerCap"><label><span class="flabel">Workers at once</span><input name="workerCap" type="number" min="1" max="32" step="1" value="${esc(shown.workerCap)}"></label><span class="fhelp">How many workers may run in parallel (1–32). New projects start with 5.</span></div></div>
<h3>Verification</h3>${value.verificationProblem ? `<p class="note-box warn" data-verify-problem>Verification is on, but no worker of this project can pass it. ${esc(value.verificationProblem)}. Turn it off, or every finished worker ends as not verified.</p>` : ""}
<div class="field-grid"><div class="field" data-field="verifyEnabled"><label><span class="flabel">Verify finished workers</span><span class="fhelp">Off by default. When on, a fresh verifier (the Verifier model above, never a fallback) runs the skill against the worker's exact result, uncommitted files included. A failure goes back to the same worker, up to 3 verifier attempts; then it comes to you.</span><span class="fhelp" data-verify-trust><b>The verifier is trusted like the worker, not sandboxed.</b> It runs shell commands in the worker's worktree as you, with the worker's shell policy and the host's resource leases. It can do what a worker's shell can do. Checking the revision and the files it changed keeps the evidence honest; it is not a security boundary. Only workers in a git workspace scope are verified; any other worker ends as not verified.</span><input name="verifyEnabled" type="checkbox"${shown.verifyEnabled === "on" ? " checked" : ""}></label></div><div class="field" data-field="verifySkill"><label><span class="flabel">Verification skill</span><span class="fhelp">Name of an installed project skill, for example verify-pi-prjcts.</span><input name="verifySkill" maxlength="128" autocomplete="off" value="${esc(shown.verifySkill)}"></label></div></div>
<details class="advanced"><summary>Access to project functions</summary><div class="field-grid">${Object.entries(settingsAccess).map(accessField).join("")}</div></details>
<p class="note">Model changes apply to the next request without interrupting current work. New threads use the current role selections. The worker limit applies at once and never stops running work. Other changes need an idle project. You review every change before it is saved.</p>
${dlgActions('<span class="hint" role="status"></span>', dlgBtn("Cancel", { action: "close-dialog" }), '<button type="submit" class="primary" data-off disabled>Review changes</button>')}</form>`);
  settingsSync();
}
const accessText = (field, value) => settingsAccess[field][2].find(([option]) => option === value)?.[1] ?? value;
const scopeText = refs => refs?.length ? refs.map(ref => esc(modelCache.get(ref)?.name ?? ref)).join(", ") : "<small>Your Pi scope</small>";
const modelText = (ref, role = "") => { if (ref === "") return emptyModelName(role); const model = modelCache.get(ref); return model ? `${esc(model.name)}<small class="mono">${esc(ref)}</small>` : esc(ref); };
const verifyText = value => value?.enabled ? `On: skill <b>${esc(value.skill)}</b>, verifier model above` : "Off";
const verificationNote = cycle => cycle ? `<p class="note" data-verification>Verification ${cycle.open ? "in progress" : esc(cycle.outcome ?? "ended")} (skill ${esc(cycle.skill)}, model ${esc(cycle.model)}): ${cycle.attempts.map(item => `attempt ${item.n} ${esc(item.state)}`).join(", ") || "no attempt yet"}${cycle.reason ? `. ${esc(cycle.reason)}` : ""}</p>` : "";
const emptyText = text => text ? esc(text) : "<small>empty</small>";
function settingsDiffRows(changes, values) {
  const rows = [];
  if ("name" in changes) rows.push(["Project name", emptyText(values.name), emptyText(changes.name)]);
  if ("objective" in changes) rows.push(["Objective", emptyText(values.objective), emptyText(changes.objective)]);
  if ("model" in changes) rows.push(["Coordinator model", modelText(values.model), modelText(changes.model)]);
  for (const [role, label] of settingsRoles.slice(1)) {
    if (changes.models && role in changes.models) rows.push([`${label} model`, modelText(values.models[role] ?? "", role), modelText(changes.models[role] ?? "", role)]);
    if (changes.fallbackModels && role in changes.fallbackModels) rows.push([`${label} quota fallback`, modelText(values.fallbackModels?.[role] ?? ""), modelText(changes.fallbackModels[role] ?? "")]);
  }
  if ("scopedModels" in changes) rows.push(["Scoped models", scopeText(values.scopedModels), scopeText(changes.scopedModels)]);
  for (const field of Object.keys(settingsAccess)) if (field in changes) rows.push([settingsAccess[field][0], esc(accessText(field, values[field])), esc(accessText(field, changes[field]))]);
  if ("verification" in changes) rows.push(["Verification", verifyText(values.verification), verifyText(changes.verification)]);
  if ("workerCap" in changes) rows.push(["Workers at once", String(values.workerCap), String(changes.workerCap)]);
  return rows;
}
const diffItem = ([label, before, after]) => `<div class="diff-item"><b>${esc(label)}</b><div class="diff-pair"><div class="diff-side before"><small>Now</small>${before}</div><span class="arrow" aria-hidden="true">→</span><div class="diff-side after"><small>After saving</small>${after}</div></div></div>`;
function settingsDiscard(id, field) {
  requireProject(id);
  if (!["name", "objective"].includes(field) || !settingsCache || settingsCache.projectId !== id) throw new Error("Reopen the project settings before discarding an edit");
  const draft = settingsDrafts.get(`${id}:${field}`);
  if (!draft) throw new Error("There is no unsent edit to discard");
  showDialog("Discard your unsent edit?", `<div class="diff-item"><b>Your edit of the ${field}</b><div class="diff-side before">${emptyText(draft.text)}</div></div><p class="note">The saved ${field} stays as it is. Nothing is sent to the server.</p>${dlgActions(dlgBtn("Keep editing", { action: "settings-back" }), dlgBtn("Discard edit", { action: "settings-confirm-discard", project: id, field }, "danger"))}`, "This only deletes the text you typed.");
}
function settingsReview(revision, changes) {
  if (!settingsCache || settingsCache.projectId !== projectId || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("Reopen the project settings");
  const stale = revision !== settingsCache.revision, rows = settingsDiffRows(changes, settingsCache.values);
  const proposal = { projectId, revision, changes, draftKeys: ["name", "objective"].filter(field => field in changes).map(field => `${projectId}:${field}`) };
  showDialog("Save these changes?", `<div class="diff-list">${rows.map(diffItem).join("")}</div>${stale ? '<p class="note-box warn">One edit was started on an older version of these settings. If they changed since, the host rejects the save and your edit is kept.</p>' : ""}<p class="note">Role models apply to new threads. New threads freeze their quota fallback choice. Quota fallback is the only automatic model change and keeps the thread, tools and instructions. The project must be idle for non-model changes. No model request, command, publication or merge happens here.</p><form data-settings-confirm data-project="${esc(projectId)}" data-revision="${esc(revision)}"><input type="hidden" name="confirm" value="${esc(projectId)}">${dlgActions(dlgBtn("Back to editing", { action: "settings-back" }), '<button type="submit" class="primary">Save changes</button>')}</form>`, `Project ${view.project.name}. Nothing is saved until you confirm.`);
  settingsConfirmation = proposal; disableActions();
}

// Model picker: the current model, then an in-flow list with Pi's scoped models first and a search over every configured model.
const modelNorm = text => text.toLowerCase().replace(/[-_/.:@]+/g, " ");
async function loadModelPicker() {
  const data = await api({ action: "model-picker-snapshot", ...(projectId ? { id: projectId } : {}) });
  if (!data || data.networkChecked !== false || !Array.isArray(data.items) || !Array.isArray(data.scoped)) throw new Error("Invalid model list");
  modelCache.clear();
  for (const model of data.items) {
    if (typeof model?.reference !== "string" || typeof model.name !== "string" || typeof model.configured !== "boolean") throw new Error("Invalid model list entry");
    modelCache.set(model.reference, { ...model, hay: modelNorm(`${model.reference} ${model.name}`) });
  }
  modelScoped = data.scoped.filter(reference => modelCache.get(reference)?.configured);
  modelUnavailableScoped = (data.unavailableScoped ?? []).filter(reference => modelCache.has(reference) && !modelCache.get(reference).configured);
  modelScopeSet = data.scopeSet === true;
  modelExtensionErrors = Array.isArray(data.extensionErrors) ? data.extensionErrors : [];
}
const emptyModelName = role => role === "verifier" ? "No verifier model" : "Inherit coordinator";
function modelButton(reference, disabled = false, emptyLabel = "Inherit coordinator") {
  const model = modelCache.get(reference), context = compactTokens(model?.contextWindow);
  return `<button type="button" class="mp-current" data-action="mp-toggle" aria-haspopup="listbox" aria-expanded="false"${disabled ? " disabled" : ""}><span class="mp-main"><span class="mp-name">${esc(reference === "" ? emptyLabel : model?.name ?? reference)}</span>${model ? `<span class="mp-ref mono">${esc(reference)}</span>` : ""}</span>${context ? `<span class="mp-ctx" title="Context window">${context}</span>` : "<span></span>"}<span class="mp-caret" aria-hidden="true">▾</span></button>`;
}
function modelPickerHtml(role, reference, unavailable, emptyLabel = emptyModelName(role)) {
  const configured = [...modelCache.values()].filter(model => model.configured).length;
  return `<div class="mp" data-role="${role}" data-empty-label="${esc(emptyLabel)}" data-value="${esc(reference)}">${modelButton(reference, Boolean(unavailable), emptyLabel)}${unavailable ? "" : `<div class="mp-pop" hidden><input class="mp-search" type="search" role="combobox" aria-expanded="true" aria-controls="mp-list-${role}" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search ${configured} configured models…" aria-label="Search models for ${role}"><div class="mp-list" id="mp-list-${role}" role="listbox" aria-label="${role} models"></div></div>`}</div>`;
}
const MODEL_ROWS = 40, MODEL_UNCONFIGURED_ROWS = 5;
const INHERIT_MODEL = { reference: "", name: "Inherit coordinator", contextWindow: null, reasoning: false, configured: true };
const NO_VERIFIER_MODEL = { ...INHERIT_MODEL, name: "No verifier model (verification off)" };
// Worker, scout and reviewer pickers start with "Inherit coordinator" (stored as no model); the coordinator picker does not.
function modelGroups(query, value, role) {
  const groups = modelGroupsBase(query, value);
  const fallback = role?.endsWith("-fallback"), emptyName = fallback ? "Wait for quota reset" : role === "verifier" ? NO_VERIFIER_MODEL.name : "Inherit coordinator";
  if (!role || role === "coordinator" || query.trim() && !modelNorm(emptyName).includes(modelNorm(query.trim()))) return groups;
  return [{ label: "", models: [{ ...INHERIT_MODEL, name: emptyName }], more: 0 }, ...groups];
}
function modelGroupsBase(query, value) {
  const terms = modelNorm(query).split(/\s+/).filter(Boolean), hit = model => terms.every(term => model.hay.includes(term));
  const configured = [...modelCache.values()].filter(model => model.configured), scoped = new Set(modelScoped), cap = (models, limit, label, extra = {}) => ({ label, models: models.slice(0, limit), more: Math.max(0, models.length - limit), ...extra });
  if (!terms.length) {
    const current = modelCache.get(value), groups = current && !scoped.has(value) && !modelUnavailableScoped.includes(value) ? [{ label: "Current", models: [current], more: 0 }] : [];
    if (scoped.size) groups.push({ label: "Scoped models", models: modelScoped.map(reference => modelCache.get(reference)), more: 0 });
    if (modelUnavailableScoped.length) groups.push({ label: "Scoped models without credentials", models: modelUnavailableScoped.map(reference => modelCache.get(reference)), more: 0, hint: "Installed, but credentials are unavailable to this host. Check the host's environment and Pi provider configuration. On macOS, restart the host after changing exported zsh startup variables." });
    if (!scoped.size && !modelScopeSet) groups.push(cap(configured, MODEL_ROWS, "Configured models"));
    else groups.push({ label: "", models: [], more: 0, hint: `Type to search all ${configured.length} configured models.` });
    return groups;
  }
  const groups = [], inScope = modelScoped.map(reference => modelCache.get(reference)).filter(hit);
  if (inScope.length) groups.push({ label: "Scoped models", models: inScope, more: 0 });
  const others = configured.filter(model => !scoped.has(model.reference) && hit(model));
  if (others.length) groups.push(cap(others, MODEL_ROWS, scoped.size ? "Other configured models" : "Configured models"));
  const missing = [...modelCache.values()].filter(model => !model.configured && hit(model));
  if (missing.length) groups.push(cap(missing, MODEL_UNCONFIGURED_ROWS, "No credentials configured", { disabled: true }));
  return groups.length ? groups : [{ label: "", models: [], more: 0, hint: `No model matches “${query.trim()}”.` }];
}
function renderModelList(mp) {
  const search = mp.querySelector(".mp-search"), value = mp.dataset.value;
  let index = 0;
  mp.querySelector(".mp-list").innerHTML = [...modelGroups(search.value, value, mp.dataset.role), ...modelExtensionErrors.map(item => ({ label: "", models: [], more: 0, hint: `${item.extension} failed to load: ${item.error}` }))].map(group => `${group.label ? `<div class="mp-group" role="presentation">${esc(group.label)}</div>` : ""}${group.models.map(model => {
    const context = compactTokens(model.contextWindow);
    return `<div class="mp-row" role="option" id="mp-${mp.dataset.role}-${index++}" data-ref="${esc(model.reference)}" aria-selected="${model.reference === value}"${group.disabled || !model.configured ? ' aria-disabled="true" title="Credentials unavailable to this host. Check its environment and Pi provider configuration."' : ' data-action="mp-pick"'}><span class="mp-main"><span class="mp-name">${esc(model.name)}</span><span class="mp-ref mono">${esc(model.reference)}</span></span><span class="mp-tags">${model.reasoning ? '<span class="mp-ctx" title="Supports reasoning">reasoning</span>' : ""}${context ? `<span class="mp-ctx" title="Context window">${context}</span>` : ""}</span></div>`;
  }).join("")}${group.more ? `<div class="mp-more">+${group.more} more. Keep typing to narrow the list.</div>` : ""}${group.hint ? `<div class="mp-more">${esc(group.hint)}</div>` : ""}`).join("");
  const rows = [...mp.querySelectorAll(".mp-row:not([aria-disabled])")], selected = rows.findIndex(row => row.dataset.ref === value);
  mpSetActive(mp, search.value.trim() || selected < 0 ? 0 : selected);
}
function mpSetActive(mp, index) {
  const rows = [...mp.querySelectorAll(".mp-row:not([aria-disabled])")], search = mp.querySelector(".mp-search");
  mp.dataset.active = rows.length ? String(Math.min(Math.max(index, 0), rows.length - 1)) : "";
  rows.forEach((row, at) => row.classList.toggle("active", String(at) === mp.dataset.active));
  const row = rows[Number(mp.dataset.active)];
  if (row) { search.setAttribute("aria-activedescendant", row.id); row.scrollIntoView({ block: "nearest" }); } else search.removeAttribute("aria-activedescendant");
}
function mpClose(mp, refocus = false) {
  mp.classList.remove("open"); mp.querySelector(".mp-pop").hidden = true;
  const button = mp.querySelector(".mp-current"); button.setAttribute("aria-expanded", "false");
  if (refocus) button.focus();
}
function mpOpen(mp) {
  dialog.querySelectorAll(".mp.open").forEach(other => other !== mp && mpClose(other));
  mp.classList.add("open"); mp.querySelector(".mp-pop").hidden = false; mp.querySelector(".mp-current").setAttribute("aria-expanded", "true");
  const search = mp.querySelector(".mp-search"); search.value = ""; renderModelList(mp); search.focus();
  mp.querySelector(".mp-pop").scrollIntoView({ block: "nearest" });
}
function mpPick(mp, reference) {
  if (reference !== "" && !modelCache.get(reference)?.configured) throw new Error("That model has no credentials configured");
  mp.dataset.value = reference; mp.querySelector(".mp-current").outerHTML = modelButton(reference, false, mp.dataset.emptyLabel);
  mpClose(mp, true); settingsSync();
}
function mpKey(event, mp) {
  const search = mp.querySelector(".mp-search");
  if (event.target === search) {
    const count = mp.querySelectorAll(".mp-row:not([aria-disabled])").length, active = Number(mp.dataset.active || 0);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) mpSetActive(mp, (active + (event.key === "ArrowDown" ? 1 : count - 1)) % count); return true; }
    if (event.key === "Enter") { event.preventDefault(); const row = mp.querySelectorAll(".mp-row:not([aria-disabled])")[active]; if (row) mpPick(mp, row.dataset.ref); return true; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); mpClose(mp, true); return true; }
  } else if (event.target.matches(".mp-current") && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); mpOpen(mp); return true; }
  return false;
}
function captureUploadDraft() {
  const form = dialog.querySelector("[data-upload-edit]");
  const draft = form && uploadDrafts.get(form.dataset.import);
  if (!draft || draft.projectId !== form.dataset.project) return;
  for (const field of ["filename", "title", "encoding", "text"]) draft[field] = form.querySelector(`[name="${field}"]`).value;
}
function uploadList() {
  if (!view) throw new Error("Select a loaded project first");
  const own = [...uploadDrafts.values()].filter(draft => draft.projectId === projectId);
  showDialog("Owner reference uploads", `<p>Pasted UTF-8 or canonical base64 only, at most 32 KiB. No local file reads, commands or agent grant. A new UUID is created only by the explicit button below; old unresolved drafts remain.</p><button data-action="upload-new">Create separate new draft/UUID</button>${own.map(draft => `<article class="task"><strong>${esc(draft.filename || "Unnamed")}</strong><p>UUID ${esc(draft.importId)} · ${draft.submittedFingerprint ? "Submission retained, do not infer failure/retry authority" : "Not submitted"}</p><button data-action="upload-edit" data-project="${esc(projectId)}" data-import="${esc(draft.importId)}">Open retained draft</button></article>`).join("")}`);
}
function uploadEdit(importId) {
  const draft = uploadDrafts.get(importId);
  if (!draft || draft.projectId !== projectId) throw new Error("Unknown owned upload draft");
  showDialog("Edit owner reference draft", `<p>Project ${esc(projectId)}<br>Import UUID ${esc(importId)}<br>Retained submission fingerprint ${esc(draft.submittedFingerprint ?? "none")}. A changed unresolved payload needs a separately created draft/UUID.</p><form data-upload-edit data-project="${esc(projectId)}" data-import="${esc(importId)}"><label>Display filename, not a path<input name="filename" maxlength="240" required value="${esc(draft.filename)}"></label><label>Title<input name="title" maxlength="1000" required value="${esc(draft.title)}"></label><label>Input encoding<select name="encoding"><option value="utf8" ${draft.encoding === "utf8" ? "selected" : ""}>UTF-8</option><option value="base64" ${draft.encoding === "base64" ? "selected" : ""}>Canonical base64</option></select></label><label>Pasted content<textarea name="text" rows="12" maxlength="43692">${esc(draft.text)}</textarea></label><button type="submit">Review exact bytes/hash</button></form>`); disableActions();
}
function encodeBase64(bytes) {
  const parts = []; for (let position = 0; position < bytes.length; position += 4096) parts.push(String.fromCharCode(...bytes.subarray(position, position + 4096)));
  return btoa(parts.join(""));
}
async function prepareUpload(draft) {
  const snapshot = { ...draft };
  if (!snapshot.filename || snapshot.filename.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(snapshot.filename) || [".", ".."].includes(snapshot.filename)) throw new Error("Filename must be a display name, not a path");
  if (!snapshot.title.trim() || snapshot.title.length > 1000 || snapshot.text.length > 43692) throw new Error("Title/content exceeds upload bounds");
  if (!["utf8", "base64"].includes(snapshot.encoding)) throw new Error("Unknown upload encoding");
  const bytes = snapshot.encoding === "base64" ? decodeBase64(snapshot.text) : new TextEncoder().encode(snapshot.text);
  if (bytes.length > 32768 || snapshot.encoding === "utf8" && new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== snapshot.text) throw new Error("Upload exceeds 32 KiB or UTF-8 conversion loses bytes; use canonical base64");
  const data = encodeBase64(bytes), sha256 = await byteHash(bytes);
  const fingerprint = await byteHash(new TextEncoder().encode(JSON.stringify({ projectId: snapshot.projectId, importId: snapshot.importId, filename: snapshot.filename, title: snapshot.title, data, sha256 })));
  return { ...snapshot, data, sha256, fingerprint, size: bytes.length };
}
async function uploadReview(importId) {
  const draft = uploadDrafts.get(importId);
  if (!draft || draft.projectId !== projectId) throw new Error("Unknown owned upload draft");
  const id = projectId, version = dialogVersion, current = generation, payload = await prepareUpload(draft);
  if (id !== projectId || current !== generation || version !== dialogVersion || !dialog.open) return;
  const latest = await prepareUpload(draft);
  if (latest.fingerprint !== payload.fingerprint || draft.submittedFingerprint !== null && draft.submittedFingerprint !== payload.fingerprint) throw new Error("Unresolved UUID cannot accept changed bytes/metadata; restore the exact payload or explicitly create a separate draft");
  if (id !== projectId || current !== generation || version !== dialogVersion || !dialog.open) return;
  showDialog("Confirm exact owner reference import", `<p>Stores an owner reference, not native worker evidence. Grants no agent access or execution authority.</p><pre>${esc(JSON.stringify({ projectId: payload.projectId, importId: payload.importId, filename: payload.filename, title: payload.title, bytes: payload.size, sha256: payload.sha256, fingerprint: payload.fingerprint }, null, 2))}</pre><details><summary>Exact canonical base64 bytes</summary><pre>${esc(payload.data)}</pre></details><form data-upload-confirm data-project="${esc(id)}" data-import="${esc(importId)}" data-fingerprint="${esc(payload.fingerprint)}"><input type="hidden" name="confirm" value="${esc(id)}"><button type="submit">Import these exact bytes</button></form>`);
  uploadConfirmations.set(importId, payload); disableActions();
}
function validateLibraryRecord(record, id) {
  if (!record || !uuid(record.id) || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > 10485760 || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.filename !== "string" || typeof record.title !== "string" || typeof record.at !== "string" || record.native && record.native.projectId !== id) throw new Error("Invalid owned library metadata");
}
function libraryIdentity(record) {
  return JSON.stringify([record.id, record.at, record.filename, record.title, record.size, record.sha256, record.sessionFile, record.native ? JSON.stringify(record.native, Object.keys(record.native).sort()) : null]);
}
async function byteHash(bytes) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function decodeBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid canonical byte encoding");
  const decoded = atob(value); if (btoa(decoded) !== value) throw new Error("Noncanonical byte encoding");
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
async function libraryList(offset = 0) {
  if (!view || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("Select a loaded project and valid library page");
  const id = projectId, current = generation, version = showDialog("Project library", '<p>Reading owned artifact metadata…</p>');
  const page = await api({ action: "library-list", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || !page.items.length || page.nextOffset !== offset + page.items.length)) throw new Error("Invalid owned library page");
  for (const record of page.items) { validateLibraryRecord(record, id); libraryCache.set(record.id, record); }
  const button = (label, next) => `<button data-action="library-list" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML = `<p>Records ${offset + (page.items.length ? 1 : 0)}-${offset + page.items.length}/${page.total}. Files are owned snapshots, not proof that a task passed. Viewing them grants no execution authority.</p><div class="row">${offset ? button("Previous records", Math.max(0, offset - 100)) : ""}${page.nextOffset !== null ? button("Next records", page.nextOffset) : ""}</div>${page.items.map(record => `<article class="task"><strong>${esc(record.title)}</strong><p>${esc(record.filename)} · ${record.size} bytes<br>SHA-256 ${esc(record.sha256)}<br>${record.native ? "Native provenance retained" : "No native worker provenance"}</p><button data-action="library-open" data-project="${esc(id)}" data-file="${esc(record.id)}" data-sha="${esc(record.sha256)}">Read hash-pinned bytes</button></article>`).join("")}`;
  disableActions();
}
async function boundedEvidence(response, size) {
  if (!response.body) throw new Error("Evidence response has no readable byte stream");
  const reader = response.body.getReader(), chunks = []; let received = 0, complete = false;
  try {
    for (;;) { const part = await reader.read(); if (part.done) { complete = true; break; } received += part.value.length; if (received > size || received > 10485760) throw new Error("Evidence response exceeds pinned byte size"); chunks.push(part.value); }
    if (received !== size) throw new Error("Evidence byte size changed");
    const bytes = new Uint8Array(received); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); } }
}
async function libraryOpen(evidenceId, expectedSha256) {
  const record = libraryCache.get(evidenceId);
  if (!record || record.sha256 !== expectedSha256) throw new Error("Reopen the owned library metadata before reading bytes");
  const id = projectId, current = generation, version = showDialog(record.filename, '<p>Checking pinned metadata, native chunk and complete artifact bytes…</p>');
  const live = () => dialog.open && version === dialogVersion && id === projectId && current === generation;
  const chunk = await api({ action: "library-read", id, evidenceId, expectedSha256, offset: 0, limit: 131072 });
  if (!live()) return;
  validateLibraryRecord(chunk.record, id);
  if (libraryIdentity(record) !== libraryIdentity(chunk.record) || chunk.encoding !== "base64" || chunk.offset !== 0 || typeof chunk.mime !== "string" || typeof chunk.data !== "string" || chunk.data.length > 174764) throw new Error("Pinned library metadata/chunk changed");
  const prefix = decodeBase64(chunk.data);
  if (prefix.length !== Math.min(record.size, 131072) || chunk.nextOffset !== (prefix.length < record.size ? prefix.length : null) || await byteHash(prefix) !== chunk.chunkSha256) throw new Error("Library prefix receipt hash/bounds mismatch");
  if (!live()) return;
  let bytes = prefix;
  if (prefix.length < record.size) {
    const response = await fetch(`/evidence/${id}/${record.id}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Evidence read refused: ${response.status}`);
    bytes = await boundedEvidence(response, record.size);
  }
  if (await byteHash(bytes) !== expectedSha256) throw new Error("Complete evidence SHA-256 differs from the pinned record");
  if (!live()) return;
  libraryPayload = { projectId: id, record, bytes, mime: chunk.mime };
  libraryBytes(record.id, expectedSha256, 0);
}
function libraryBytes(evidenceId, sha, offset) {
  const payload = libraryPayload;
  if (!payload || payload.projectId !== projectId || payload.record.id !== evidenceId || payload.record.sha256 !== sha || !Number.isSafeInteger(offset) || offset < 0 || offset > payload.bytes.length) throw new Error("Unknown verified artifact/byte range");
  const { record, bytes, mime } = payload, end = Math.min(bytes.length, offset + 65536);
  showDialog(record.filename, `<p>Verified copied bytes, ${record.size} total. SHA-256 ${esc(sha)}. Verification covers identity/bytes, not task correctness or remote effects.</p><details><summary>Captured metadata and provenance</summary><pre>${esc(JSON.stringify(record, null, 2))}</pre></details><div class="library-content"></div>`);
  const body = dialog.querySelector(".library-content"), image = ["image/png", "image/jpeg", "image/webp"].includes(mime);
  blobUrl = URL.createObjectURL(new Blob([bytes], { type: image ? mime : "application/octet-stream" }));
  const download = document.createElement("a"); download.href = blobUrl; download.download = record.filename; download.textContent = "Download full verified bytes"; body.append(download);
  if (image) { const img = document.createElement("img"); img.src = blobUrl; img.alt = record.title; body.append(img); return; }
  const range = document.createElement("p"); range.textContent = `Byte range [${offset}, ${end})/${bytes.length}.`; body.append(range);
  const slice = bytes.subarray(offset, end), pre = document.createElement("pre");
  try { pre.textContent = new TextDecoder("utf-8", { fatal: true }).decode(slice); }
  catch {
    const note = document.createElement("p"); note.textContent = "This range is not complete UTF-8, possibly because its boundary splits a character. Base64 preserves every byte."; body.append(note);
    pre.textContent = encodeBase64(slice);
  }
  body.append(pre);
  const navigation = document.createElement("div"); navigation.className = "row";
  for (const [label, next] of [["Previous byte range", offset ? Math.max(0, offset - 65536) : null], ["Next byte range", end < bytes.length ? end : null]]) {
    if (next === null) continue; const button = document.createElement("button"); button.dataset.action = "library-bytes"; button.dataset.project = projectId; button.dataset.file = evidenceId; button.dataset.sha = sha; button.dataset.offset = String(next); button.textContent = label; navigation.append(button);
  }
  body.append(navigation);
}
function knowledgePath(value) {
  return typeof value === "string" && value.length <= 240 && /^(?:MEMORY\.md|preferences\.md|(?:architecture|research|decisions|runbooks|plans)\/(?:legacy\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md)$/.test(value);
}
function editableKnowledge(text) {
  return typeof text === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text) && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text)) === text;
}
function validateKnowledgeDocument(doc, path) {
  if (!doc || doc.path !== path || !knowledgePath(path) || typeof doc.text !== "string" || !/^[a-f0-9]{64}$/.test(doc.revision) || !Number.isSafeInteger(doc.size) || doc.size < 0 || typeof doc.author !== "string" || typeof doc.updatedAt !== "string") throw new Error("Knowledge response differs from its selected document");
}
function captureKnowledgeDraft() {
  const form = dialog.querySelector("[data-knowledge-write]");
  const draft = form && knowledgeDrafts.get(`${form.dataset.project}:${form.dataset.path}`);
  if (draft) draft.text = form.querySelector('[name="text"]').value;
  const pathForm = dialog.querySelector("[data-knowledge-path]");
  if (pathForm) knowledgePaths.set(pathForm.dataset.project, pathForm.querySelector('[name="path"]').value);
}
async function knowledgeList() {
  if (!view) throw new Error("Select a loaded project first");
  const id = projectId, current = generation, version = showDialog("Managed project knowledge", '<p>Reading managed knowledge metadata…</p>');
  const docs = await api({ action: "knowledge-list", id });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!Array.isArray(docs) || docs.some(doc => !knowledgePath(doc.path) || !/^[a-f0-9]{64}$/.test(doc.revision))) throw new Error("Invalid managed knowledge listing");
  dialog.querySelector(".dialog-body").innerHTML = `<p>MEMORY.md is an index capped at 3,000 Unicode code points. Other files load on demand. Learned knowledge is separate from standing execution instructions.</p><button data-action="knowledge-new">Create a topic</button>${docs.map(doc => `<article class="task"><strong>${esc(doc.path)}</strong><p>${esc(doc.author)} · ${esc(doc.updatedAt)}<br>Revision ${esc(doc.revision)}</p><button data-action="knowledge-read" data-project="${esc(id)}" data-path="${esc(doc.path)}">Read/edit document</button></article>`).join("")}`;
  disableActions();
}
async function knowledgeRead(path, focus = null) {
  if (!knowledgePath(path)) throw new Error("Invalid managed knowledge path");
  const id = projectId, current = generation, version = showDialog(path, '<p>Reading current document and revision…</p>');
  const doc = await api({ action: "knowledge-read", id, path });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  validateKnowledgeDocument(doc, path); knowledgeCache.set(`${id}:${path}`, doc);
  const draft = knowledgeDrafts.get(`${id}:${path}`);
  dialog.querySelector(".dialog-body").innerHTML = `<p class="note" title="Revision ${esc(doc.revision)}">${esc(doc.author)} · updated ${esc(ago(doc.updatedAt))} · ${esc(size(doc.size))}${path === "MEMORY.md" ? ` · ${[...doc.text].length.toLocaleString()} / 3,000 code points` : ""}</p>${draft ? `<p class="notice">Retained draft uses revision ${esc(draft.expectedRevision ?? "null, create only")}. ${draft.expectedRevision !== doc.revision ? "It conflicts with this current document. Rereading does not rebase it." : "It remains unsent."}</p>` : ""}<div class="row"><button class="primary small" data-action="knowledge-edit" data-project="${esc(id)}" data-path="${esc(path)}">${draft ? "Continue draft" : "Edit"}</button><button class="small" data-action="knowledge-history" data-project="${esc(id)}" data-path="${esc(path)}">History</button>${draft ? `<button class="small" data-action="knowledge-discard" data-project="${esc(id)}" data-path="${esc(path)}">Discard draft…</button>` : ""}</div><div class="doc-view text">${renderMarkdown(doc.text)}</div>`;
  disableActions();
  if (focus) markAt(dialog.querySelector(".doc-view"), focus.terms, doc.text, focus.offset);
}
function knowledgeEdit(id, path, create = false) {
  requireProject(id);
  if (!knowledgePath(path)) throw new Error("Invalid knowledge path");
  const key = `${id}:${path}`, doc = knowledgeCache.get(key);
  let draft = knowledgeDrafts.get(key);
  if (!draft) {
    if (!doc || create) throw new Error("Read the owned document before editing");
    draft = { text: doc.text, expectedRevision: doc.revision }; knowledgeDrafts.set(key, draft);
  }
  if (!editableKnowledge(draft.text)) throw new Error("Unsafe control/invalid Unicode text cannot enter the editor; inspect the read-only document");
  persistBrowserDrafts();
  showDialog(`Edit ${path}`, `<form data-knowledge-write data-project="${esc(id)}" data-path="${esc(path)}"><label><span class="sr-only">Document text</span><textarea name="text" rows="18" maxlength="32000" class="doc-editor">${esc(draft.text)}</textarea></label><p class="note">If someone else changed this document since you opened it, saving fails and your draft is kept.</p><input type="hidden" name="confirm" value="${esc(id)}"><div class="row"><button class="primary" type="submit">Save</button><button type="button" data-action="knowledge-read" data-project="${esc(id)}" data-path="${esc(path)}">Cancel</button></div></form>`);
  disableActions();
}
function knowledgeNew() {
  if (!view) throw new Error("Select a loaded project first");
  showDialog("New knowledge document", `<form data-knowledge-path data-project="${esc(projectId)}"><label><span>Path</span><input name="path" maxlength="240" required value="${esc(knowledgePaths.get(projectId) ?? "")}" placeholder="research/topic.md"></label><p class="note">Use a folder: architecture/, research/, decisions/, runbooks/ or plans/. Add it to MEMORY.md yourself if the coordinator should find it.</p><button class="primary" type="submit">Continue</button></form>`);
}
function knowledgeDiscard(id, path) {
  requireProject(id);
  const key = `${id}:${path}`, draft = knowledgeDrafts.get(key);
  if (!draft || !knowledgeCache.has(key)) throw new Error("Reread the document before choosing a new editing base");
  showDialog("Discard retained knowledge draft?", `<p>This deletes the unsent draft below. The next editor uses the last explicitly read document, whose revision the server still checks. No write happens here.</p><pre>${esc(draft.text)}</pre><button class="danger" data-action="knowledge-confirm-discard" data-project="${esc(id)}" data-path="${esc(path)}">Discard draft and start from last read document</button>`);
}
async function knowledgeHistory(path, offset = 0) {
  if (!knowledgePath(path) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid managed history selection");
  const id = projectId, current = generation, version = showDialog(`${path} history`, '<p>Reading retained revisions…</p>');
  const records = await api({ action: "knowledge-history", id, path });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!Array.isArray(records)) throw new Error("Invalid knowledge history response");
  for (const record of records) { validateKnowledgeDocument(record, path); if (!uuid(record.id) || record.priorText !== null && typeof record.priorText !== "string") throw new Error("Invalid retained revision identity/preimage"); }
  const page = records.toReversed().slice(offset, offset + 20);
  const button = (label, next) => `<button data-action="knowledge-history" data-project="${esc(id)}" data-path="${esc(path)}" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML = `<p>Showing ${offset + (page.length ? 1 : 0)}-${offset + page.length}/${records.length}, newest first. The host returns complete history; this view pages 20 revisions. History is read-only, not an automatic rollback.</p><div class="row">${offset ? button("Previous revisions", Math.max(0, offset - 20)) : ""}${offset + page.length < records.length ? button("Next revisions", offset + 20) : ""}</div>${page.map(record => `<details><summary>${esc(record.updatedAt)} · ${esc(record.author)} · ${esc(record.revision)}</summary><p>Revision ID ${esc(record.id)}<br>Prior revision ${esc(record.priorRevision)}</p><h3>Saved text</h3><pre>${esc(record.text)}</pre><h3>Retained preimage</h3><pre>${esc(record.priorText ?? "No prior document")}</pre></details>`).join("")}`;
}
function validateOperations(page, id, offset) {
  if (!page || page.offset !== offset || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== offset + page.items.length || !page.items.length) || page.items.some(record => !uuid(record.id) || record.projectId !== id || !/^[a-f0-9]{64}$/.test(record.fingerprint) || typeof record.scopeCurrent !== "boolean" || !["pending", "approved", "rejected"].includes(record.status) || !record.operation || !["merge", "auto-merge", "command", "vcs"].includes(record.operation.kind))) throw new Error("Invalid owned operation page");
}
function ownedOperation(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== projectId || record.fingerprint !== fingerprint) throw new Error("Operation binding changed; reopen its owned record");
  if (view.project.archived || view.project.deleted || !record.scopeCurrent) throw new Error("Restore the project/use a current scope before changing this operation");
  return record;
}
function executionConsentAvailable(record) { return record.status === "pending" && record.scopeCurrent && (record.operation.kind === "vcs" || record.operation.provider === "github" && ["merge", "command"].includes(record.operation.kind)); }
function mergeExecutionAvailable(record) { return record.status === "approved" && record.executionApproved === true && record.scopeCurrent && record.operation.provider === "github" && record.operation.kind === "merge"; }
function operationExecutionAvailable(record) { return mergeExecutionAvailable(record) || record.status === "approved" && record.executionApproved === true && record.scopeCurrent && record.operation.kind === "vcs"; }
function operationLetter(record) {
  const attrs = `data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"`;
  return `<article class="letter"><h2>${esc(record.operation.provider)} ${esc(record.operation.kind)}</h2>${badge(record.status)}<p>Project ${esc(record.projectId)}<br>ID ${esc(record.id)}<br>Fingerprint ${esc(record.fingerprint)}<br>Current scope: ${esc(record.scopeCurrent)}</p><pre>${esc(JSON.stringify(record.operation, null, 2))}</pre><p>Plain approval does not authorize execution. VCS execution is limited to the exact recorded action and state. Auto-merge is unavailable; commands execute only through bound worker profiles.</p><div class="row">${record.status === "pending" ? `<button data-action="operation-decision" ${attrs} data-decision="plain">Approve record only</button>${executionConsentAvailable(record) ? `<button class="danger" data-action="operation-decision" ${attrs} data-decision="execution">Permit exact executor</button>` : ""}<button data-action="operation-decision" ${attrs} data-decision="reject">Reject</button>` : `<p>Decision is immutable. Executable approval: ${esc(record.executionApproved === true)}</p>${operationExecutionAvailable(record) ? `<button class="danger" data-action="operation-execute" ${attrs}>${record.operation.kind === "vcs" ? "Execute exact VCS operation" : "Execute exact-head merge"}, separate confirmation</button><button data-action="operation-inspect" ${attrs}>Inspect original outcome, never replay</button>` : ""}`}</div></article>`;
}
async function operationsDialog(offset = 0) {
  if (!plan || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("A loaded Durable plan and valid approval page are required");
  const id = projectId, current = generation, version = showDialog("Approvals", '<p class="note">Reading approval requests…</p>', "Every approval request recorded for this project. Decisions are final.");
  const page = await api({ action: "operation-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || current !== generation || id !== projectId) return;
  validateOperations(page, id, offset);
  for (const record of page.items) operationCache.set(record.id, record);
  setDialogBody(`${page.total ? `<div class="seg-row"><span class="note">${page.total} ${page.total === 1 ? "request" : "requests"}</span>${pager({ offset, count: page.items.length, total: page.total, size: 100, data: { action: "operation-list" } })}</div>` : ""}${page.items.map(record => `<div class="list-row"><div class="grow"><strong>${badge(record.status)} ${esc(humanKey(record.operation.kind))} · ${esc(record.operation.repositoryId)}</strong><span class="meta">${esc(record.operation.provider)} · ${record.scopeCurrent ? "scope still current" : "scope has changed"}</span></div><div class="row-actions">${dlgBtn("Details", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }, "small")}</div></div>`).join("") || '<p class="empty-state">No approval requests yet.</p>'}${dlgActions(dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
}
const operationFacts = record => `<div class="kv tight"><span>Action</span><b>${esc(record.operation.provider)} · ${esc(humanKey(record.operation.kind === "vcs" ? record.operation.action : record.operation.kind))}</b>${record.operation.repositoryId ? `<span>Repository</span><b>${esc(record.operation.repositoryId)}</b>` : ""}<span>Status</span><b>${badge(record.status)}</b><span>Scope</span><b>${record.scopeCurrent ? "Still current" : "Changed since"}</b>${record.operation.kind === "vcs" ? `<span>Checkout</span><b class="mono">${esc(record.operation.checkout)}</b><span>Target</span><b class="mono">${esc(record.operation.target)}</b><span>Expected state</span><b class="mono">${esc(record.operation.expectedState)}</b>` : ""}</div>${record.operation.kind === "vcs" ? `<p class="note-box warn">Approval applies once, to this target and state only. Changed state requires a new request. Active-worker protections remain in force.</p><ul>${record.operation.risks.map(risk => `<li>${esc(risk)}</li>`).join("")}</ul><h3>State reviewed for approval</h3><pre>${esc(typeof record.operation.state === "string" ? record.operation.state : JSON.stringify(record.operation.state, null, 2))}</pre>` : ""}`;
const operationBinding = record => `<details class="raw"><summary>Exact binding</summary><div class="kv tight mt"><span>Project</span><b class="mono">${esc(record.projectId)}</b><span>Request</span><b class="mono">${esc(record.id)}</b><span>Fingerprint</span><b class="mono">${esc(record.fingerprint)}</b></div><pre>${esc(JSON.stringify(record.operation, null, 2))}</pre></details>`;
function operationView(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== projectId || record.fingerprint !== fingerprint) throw new Error("Unknown owned operation record");
  const attrs = { operation: record.id, fingerprint: record.fingerprint };
  const buttons = record.status === "pending"
    ? `${dlgBtn("Reject", { action: "operation-decision", ...attrs, decision: "reject" })}${dlgBtn("Approve, record only", { action: "operation-decision", ...attrs, decision: "plain" })}${executionConsentAvailable(record) ? dlgBtn("Allow exact executor…", { action: "operation-decision", ...attrs, decision: "execution" }, "primary") : ""}`
    : `${operationExecutionAvailable(record) ? `${dlgBtn("Inspect original outcome…", { action: "operation-inspect", ...attrs })}${dlgBtn(record.operation.kind === "vcs" ? "Execute this exact VCS operation…" : "Merge this exact commit…", { action: "operation-execute", ...attrs }, "danger")}` : ""}`;
  showDialog("Approval request", `${operationFacts(record)}<p class="note-box">${record.status === "pending" ? "Approving only records your decision. Letting the executor act is a separate choice. Auto-merge is not available here." : `Your decision is final. Executable approval: ${record.executionApproved === true ? "yes" : "no"}.`}</p>${operationBinding(record)}${dlgActions(dlgBtn("Back to approvals", { action: "operation-list" }), buttons)}`, `${record.operation.provider} · ${humanKey(record.operation.kind)}`); disableActions();
}
function operationDecision(id, fingerprint, mode) {
  const record = ownedOperation(id, fingerprint);
  if (record.status !== "pending" || !["plain", "execution", "reject"].includes(mode) || mode === "execution" && !executionConsentAvailable(record)) throw new Error("This immutable/deferred operation cannot accept that decision");
  const copy = { execution: ["Allow this exact executor?", "Allow executor", "Lets the recorded executor act, including its bound effect. Nothing runs from this dialog."], plain: ["Approve, record only?", "Approve", "Records your decision. It does not allow execution or any remote effect."], reject: ["Reject this request?", "Reject request", "Records a rejection. This cannot be undone."] }[mode];
  showDialog(copy[0], `${operationFacts(record)}<p class="note-box${mode === "execution" ? " warn" : ""}">${esc(copy[2])}</p>${operationBinding(record)}<form data-operation-decision data-project="${esc(projectId)}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}" data-decision="${esc(mode)}">${mode !== "reject" ? `<input type="hidden" name="confirm" value="${esc(projectId)}">` : ""}${dlgActions(dlgBtn("Back", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }), `<button type="submit" class="primary${mode === "plain" ? "" : " danger"}">${copy[1]}</button>`)}</form>`, `${record.operation.provider} · ${humanKey(record.operation.kind)}`); disableActions();
}
function operationExecution(id, fingerprint, inspect = false) {
  const record = ownedOperation(id, fingerprint);
  if (!operationExecutionAvailable(record)) throw new Error("Exact executable approval with a current scope is required");
  const vcs = record.operation.kind === "vcs";
  showDialog(inspect ? "Inspect original outcome?" : vcs ? "Execute this exact VCS operation?" : "Merge this exact commit?", `${operationFacts(record)}<p class="note-box${inspect ? "" : " warn"}">${inspect ? "Reads the original execution receipt. This does not execute, retry, or grant permission to replay an uncertain outcome." : vcs ? "The host rechecks the target and expected state before running this operation once. Changed state requires fresh approval. An uncertain outcome is never retried automatically." : "This changes the remote repository. The executor rechecks repository, scope and commit first, and an unknown outcome is never retried automatically."}</p><p class="note">No deployment or auto-merge runs from here.</p>${operationBinding(record)}<form data-operation-execute data-mode="${inspect ? "inspect" : "execute"}" data-project="${esc(projectId)}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"><input type="hidden" name="confirm" value="${esc(projectId)}">${dlgActions(dlgBtn("Back", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }), `<button type="submit" class="primary${inspect ? "" : " danger"}">${inspect ? "Check outcome" : vcs ? "Execute once" : "Merge now"}</button>`)}</form>`, `${record.operation.provider} · ${humanKey(record.operation.kind)}`); disableActions();
}
function uuid(value) { return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value); }
function requireProject(id) { if (id !== projectId) throw new Error("Selected project changed. Reopen the intended control."); }
function closeCurrentDialog(id, version) { if (projectId === id && dialogVersion === version) closeDialog(); }
function requireThread(id) { if (!uuid(id) || !plan?.work.some(work => work.threadId === id)) throw new Error("Unknown owned reusable thread in the current plan"); }
function workLine(work, detail) {
  return `<button class="worker-line ${esc(work.status)}" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}" title="${esc(work.text)}"><span class="dot"></span><span class="worker-title">${work.parentThreadId ? '<span class="sub-label">sub-agent</span> ' : ""}${esc(clip(work.text.replace(/\s+/g, " ").trim(), 60))}</span><small class="worker-meta"><span class="worker-role">${esc(work.role)}</span> · <span class="worker-status">${esc(work.status)}</span>${detail ? ` · <span class="worker-detail">${esc(detail)}</span>` : ""}${holdsBadge(work.holds)}</small>${contextRing(workerContexts.get(work.threadId))}</button>`;
}
// Shared resources a running worker holds: leases by resource name, and its running background commands.
function holdsBadge(holds) {
  if (!holds) return "";
  const parts = [...holds.leases.map(lease => `lease ${lease.resource}`), ...(holds.background.length ? [`${holds.background.length} bg`] : [])];
  const title = [...holds.leases.map(lease => `${lease.resource} until ${new Date(lease.until).toLocaleTimeString()}`), ...holds.background.map(item => `background: ${item.label}`)].join("\n");
  return ` · <span class="worker-holds" title="${esc(title)}">${esc(parts.join(", "))}</span>`;
}
const finished = work => ["completed", "failed", "stopped"].includes(work.status);
// The chat that admitted a work item (null chatConversationId means Main). Child work keeps the admitting chat, so parentThreadId plays no part.
function workChatId(work) {
  const chats = view?.chats ?? [];
  const main = chats.find(chat => chat.id === "main")?.conversationId ?? null;
  return (chats.find(chat => chat.conversationId === (work.chatConversationId ?? main)) ?? chats[0])?.id ?? "main";
}
const inSelectedChat = work => !view?.chats || workChatId(work) === chatId;
const archivable = work => ["completed", "failed", "stopped", "blocked"].includes(work.status) && !work.archived;
// Disclosure state belongs to a project and thread, not to a particular snapshot.
const workerHistoryOpen = new Set();
document.querySelector("#activity").addEventListener("toggle", event => {
  const details = event.target;
  if (!details.matches("details[data-worker-history]")) return;
  const key = `${projectId}:${details.dataset.workerHistory}`;
  if (details.open) workerHistoryOpen.add(key); else workerHistoryOpen.delete(key);
}, true);
function durableActivity() {
  const available = plan.work.filter(work => inSelectedChat(work) && (showArchived || !work.archived));
  const groups = new Map();
  for (const work of available) {
    if (!groups.has(work.threadId)) groups.set(work.threadId, []);
    groups.get(work.threadId).push(work);
  }
  // Retain parents of visible children even when their last turn has completed.
  const visible = new Set([...groups].filter(([, items]) => allWork || items.some(work => !finished(work) && !work.archived)).map(([id]) => id));
  for (const id of [...visible]) {
    const seen = new Set(); let current = id;
    while (groups.has(current) && !seen.has(current)) {
      seen.add(current);
      const parent = groups.get(current)[0].parentThreadId;
      if (!parent || !groups.has(parent)) break;
      visible.add(parent); current = parent;
    }
  }
  const children = new Map();
  for (const id of visible) {
    const parent = groups.get(id)[0].parentThreadId;
    if (parent && visible.has(parent) && parent !== id) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
  }
  const row = work => `<div class="conversation-work ${work.archived ? "archived" : ""}"><button class="conversation-task" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}" data-work="${esc(work.id)}" title="${esc(work.text)}"><span>${badge(work.status)} ${esc(clip(work.text, 200))}</span>${work.blocker ? `<small>${esc(work.blocker)}</small>` : ""}${work.archived ? '<small>Archived</small>' : ""}${holdsBadge(work.holds)}</button>${allWork && archivable(work) ? `<button class="ghost small archive" data-action="work-archive" data-project="${esc(projectId)}" data-work="${esc(work.id)}">Archive</button>` : ""}</div>`;
  const placed = new Set();
  const tree = id => {
    if (placed.has(id)) return "";
    placed.add(id);
    const items = groups.get(id), first = items[0];
    const running = items.find(work => work.status === "running");
    const queued = items.filter(work => work.status === "queued").toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const current = running ?? items.findLast(work => ["blocked", "interrupted"].includes(work.status));
    const history = items.filter(work => work !== current && work.status !== "queued");
    const parent = first.parentThreadId;
    const nested = (children.get(id) ?? []).map(tree).join("");
    return `<section class="worker-conversation" data-conversation="${esc(id)}"><div class="conversation-header">${workLine({ ...first, holds: current?.holds, status: current?.status ?? (queued.length ? "queued" : "idle") }, `thread ${id.slice(0, 8)}${items.every(work => work.archived) ? " · archived" : ""}${current?.status === "running" && current.startedAt ? ` · ${duration(Date.now() - current.startedAt)}` : current?.blocker ? ` · ${clip(current.blocker, 80)}` : ""}`)}</div>${parent && !visible.has(parent) ? `<p class="note">Parent conversation ${esc(parent)} is not shown.</p>` : ""}<div class="conversation-section"><b>Now</b>${current ? row(current) : '<p class="note">Idle or waiting</p>'}</div>${queued.length ? `<div class="conversation-section"><b>Up next</b>${queued.map(row).join("")}</div>` : ""}<details data-worker-history="${esc(id)}"${workerHistoryOpen.has(`${projectId}:${id}`) ? " open" : ""}><summary>History (${history.length})</summary>${history.length ? history.toReversed().map(row).join("") : '<p class="note">No history yet.</p>'}</details>${verificationNote(plan.verification?.[id])}${nested ? `<div class="work-children" data-parent="${esc(id)}">${nested}</div>` : ""}</section>`;
  };
  const roots = [...visible].filter(id => { const parent = groups.get(id)[0].parentThreadId; return !parent || !visible.has(parent) || parent === id; });
  // A malformed cycle has no root. Render remaining conversations once, without recursion loops.
  let content = roots.map(tree).join("");
  for (const id of visible) if (!placed.has(id)) content += tree(id);
  const elsewhere = plan.work.filter(work => !inSelectedChat(work) && !work.archived).length;
  return (content || `<p class="note">${allWork ? "No work from this chat." : "No active workers from this chat."}</p>`) + (elsewhere ? `<p class="note other-chats">${elsewhere} in other chats</p>` : "") + (plan.work.length ? `<button class="ghost small all-work" data-action="all-work">${allWork ? "Show active only" : `View all work (${plan.work.length}) →`}</button>` : "");
}
function renderWorkers() {
  const activity = document.querySelector("#activity"), focused = document.activeElement;
  let focusSelector = null;
  if (activity.contains(focused)) {
    const history = focused.closest("details[data-worker-history]");
    if (focused.matches("summary") && history) focusSelector = `details[data-worker-history="${CSS.escape(history.dataset.workerHistory)}"] > summary`;
    else if (focused.dataset.action) {
      const { action, thread, work } = focused.dataset;
      focusSelector = `[data-action="${CSS.escape(action)}"]${thread ? `[data-thread="${CSS.escape(thread)}"]` : ""}${work ? `[data-work="${CSS.escape(work)}"]` : ""}`;
    }
  }
  const selection = document.getSelection();
  const selecting = selection && !selection.isCollapsed && (activity.contains(selection.anchorNode) || activity.contains(selection.focusNode));
  if (focusSelector && !selecting) focused.blur();
  setHtml("#activity", plan ? durableActivity() : '<p class="note">No workers are running.</p>');
  if (focusSelector && !selecting) activity.querySelector(focusSelector)?.focus({ preventScroll: true });
  document.querySelector("#archive-toggle").hidden = !allWork;
}
// Context use of the workers listed in the card, read host-side; rows show nothing until a reading exists.
const workerContexts = new Map();
async function loadWorkerContexts(current) {
  const ids = [...new Set([...document.querySelectorAll("#activity .worker-line[data-thread]")].map(node => node.dataset.thread))].slice(0, 40);
  if (!ids.length) return;
  const read = await api({ action: "worker-contexts", id: projectId, threadIds: ids }).catch(() => null);
  if (!read || current !== generation) return;
  let changed = false;
  for (const [id, value] of Object.entries(read)) if (value && JSON.stringify(workerContexts.get(id)) !== JSON.stringify(value)) { workerContexts.set(id, value); changed = true; }
  if (changed) renderWorkers();
}
// Small ring plus percent; a missing window is said so, never guessed.
function contextRing(context) {
  if (!context || context.tokens == null) return "";
  const percent = context.window ? Math.min(100, Math.round(context.tokens / context.window * 100)) : null;
  const level = percent === null ? "low" : percent >= 90 ? "high" : percent >= 70 ? "mid" : "low", c = 2 * Math.PI * 6;
  return `<span class="ctx-ring" data-level="${level}" title="${esc(contextLine(context))}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" class="track"/><circle cx="8" cy="8" r="6" class="fill" stroke-dasharray="${(c * (percent ?? 0) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>${percent === null ? "window unknown" : `${percent}%`}</span>`;
}
function durableResults() {
  const done = plan.work.filter(work => finished(work) && !work.archived).toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 5);
  return done.map(work => workLine(work, work.endedAt ? `${duration(Date.now() - work.endedAt)} ago` : "")).join("") || '<p class="note">Finished work appears here.</p>';
}
function threadList() {
  if (!plan) throw new Error("Durable plan is not loaded");
  showDialog("Durable work and reusable threads", `<p>Work items sharing a thread UUID reuse its conversation. Status is not verification evidence.</p>${plan.work.toReversed().map(work => `<article class="task">${badge(work.status)}<strong>${esc(work.text)}</strong><p>Role ${esc(work.role)} · Work ${esc(work.id)}<br>Thread ${esc(work.threadId)}<br>${esc(work.blocker ?? "")}</p>${verificationNote(plan.verification?.[work.threadId])}<button data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}">Read owned history</button></article>`).join("") || '<p>No retained work items.</p>'}`);
}
function workerDetailHtml(chat, page, work) {
  const threadId = chat.threadId, draft = formDrafts.get(`${chat.id}:thread-send:${threadId}`), role = work?.role ?? "worker";
  const data = `data-project="${esc(chat.id)}" data-thread="${esc(threadId)}"`;
  return `<div class="worker-head"><button type="button" class="ghost small" data-action="thread-close" aria-label="Back to the coordinator chat">← Back</button><div class="row thread-title">${badge(work?.status ?? "unknown")}<b>${esc(role[0].toUpperCase() + role.slice(1))}</b><small>${esc(work?.attempt?.model ?? "")}</small></div><span id="worker-context" class="worker-context"></span><span class="row worker-actions"><button data-thread-mutation data-action="thread-steer" ${data}>Steer…</button><button data-thread-mutation class="danger" data-action="thread-stop" ${data}>Stop…</button></span></div><p class="thread-task clamp" data-action="toggle-clamp" title="Show the full task">${esc(work?.text ?? "")}</p><p class="worker-latest" id="worker-latest"></p><details class="worker-convo" open><summary>Conversation</summary><div id="worker-messages" class="transcript" aria-live="polite"></div><div id="worker-history-pages" class="row"></div></details><form class="composer" data-inline-thread-send ${data}><textarea name="message" aria-label="Message worker" required maxlength="32000" rows="2" placeholder="Follow up with this ${esc(role)}…">${esc(draft?.text ?? "")}</textarea><div class="row between"><span class="row help-line"><small>Reuses this ${esc(role)}'s conversation</small><span class="help-wrap"><button type="button" class="ghost small help-btn" data-action="composer-help" aria-label="Composer help" aria-haspopup="dialog" aria-expanded="false">ⓘ</button><div class="help-pop" role="dialog" aria-label="Composer shortcuts" hidden></div></span></span><button class="primary" type="submit">Send</button></div></form><section class="artifact-pane" id="artifact-pane" aria-label="Worker artifacts"><div class="row between"><b>Artifacts <span id="artifact-count"></span></b><button class="ghost small" data-action="artifacts-sort" id="artifact-sort" title="Sort files">Newest</button></div><small id="artifact-summary" class="note"></small><input id="artifact-filter" type="search" placeholder="Filter by name…" aria-label="Filter artifacts" autocomplete="off"><div id="artifact-tree" class="artifact-tree"></div><div id="artifact-preview" class="artifact-preview" hidden></div></section><details class="worker-controls"><summary>Evidence and changes</summary><div id="worker-evidence"></div><p class="note">Thread ${esc(threadId)} · Conversation ${esc(page.conversationId)}. Scope, model and tools stay frozen; history, partial files and receipts are kept.</p></details>`;
}
async function inspectThread(threadId, offset = null, textOffset = 0) {
  requireThread(threadId);
  if (workerFocus?.threadId !== threadId) workerFocus = null;
  if (![offset ?? 0, textOffset].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error("Invalid thread history page");
  const chat = { id: projectId, generation, threadId, offset, textOffset };
  workerChat = chat;
  const target = threadPane;
  target.hidden = false; target.innerHTML = '<p class="note">Reading worker conversation…</p>';
  setTab("coordinator");
  setWorkerUrl(threadId);
  document.querySelector(".body").scrollTop = 0;
  render();
  const version = ++dialogVersion;
  const page = await workerChatPage(chat);
  if (workerChat !== chat || version !== dialogVersion || chat.generation !== generation || target.hidden) return;
  const work = plan.work.findLast(item => item.threadId === threadId);
  target.innerHTML = workerDetailHtml(chat, page, work);
  renderWorkerChat(chat, page, true);
  render();
}
async function workerChatPage(chat) {
  const read = offset => api({ action: "thread-history", id: chat.id, threadId: chat.threadId, offset, limit: 30, textOffset: chat.textOffset, textLimit: 4000, context: true });
  let page = await read(chat.offset ?? 0);
  if (chat.offset === null && page.total > 30) page = await read(Math.max(0, page.total - 30));
  if (page.threadId !== chat.threadId || !Array.isArray(page.items) || chat.offset !== null && page.offset !== chat.offset) throw new Error("History does not match its owned thread/page");
  return page;
}
function contextLine({ tokens, window }) {
  const k = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
  return tokens == null ? "" : window ? `Context ${k(tokens)} / ${k(window)} · ${Math.round(tokens / window * 100)}%` : `Context ${k(tokens)} · window unknown`;
}
async function refreshWorkerChat(chat) {
  const page = await workerChatPage(chat);
  if (workerChat !== chat || chat.generation !== generation || projectId !== chat.id || threadPane.hidden) return;
  if (document.querySelector("#worker-messages")) renderWorkerChat(chat, page);
}
function renderWorkerChat(chat, page, opening = false) {
  const transcript = document.querySelector("#worker-messages");
  const atEnd = opening || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  const messages = page.items.map((message, i) => chatMessageHtml({ ...message, index: page.offset + i }, "Worker")).join("") || '<p class="note">No messages yet.</p>';
  if (transcript.dataset.content !== messages) {
    transcript.innerHTML = messages; transcript.dataset.content = messages;
    if (atEnd) transcript.scrollTop = transcript.scrollHeight;
  }
  const lastTool = page.items.findLast(item => item.kind === "tool");
  document.querySelector("#worker-latest").innerHTML = lastTool ? `Latest: <code>${esc(lastTool.name)}</code> ${esc(clip(lastTool.argsPreview ?? "", 90))}` : "";
  document.querySelector("#worker-context").innerHTML = contextRing(page.context);
  if (workerFocus?.threadId === chat.threadId && workerFocus.project === chat.id) focusNode(transcript.querySelector(`[data-index="${workerFocus.index}"]`), workerFocus);
  const pageButton = (label, offset, slice = 0) => `<button data-action="thread-history-page" data-project="${esc(chat.id)}" data-thread="${esc(chat.threadId)}" data-offset="${offset}" data-text-offset="${slice}">${label}</button>`;
  document.querySelector("#worker-history-pages").innerHTML = `${page.offset ? pageButton("Older messages", Math.max(0, page.offset - 30)) : ""}${page.nextOffset !== null ? pageButton("Newer messages", page.nextOffset) : ""}${chat.textOffset ? pageButton("Previous text slice", page.offset, Math.max(0, chat.textOffset - 4000)) : ""}${page.items.some(message => message.nextTextOffset != null) ? pageButton("Next text slice", page.offset, chat.textOffset + 4000) : ""}${page.total > page.items.length ? `<small>Messages ${page.offset + (page.items.length ? 1 : 0)}-${page.offset + page.items.length} of ${page.total}</small>` : ""}`;
  document.querySelector("#worker-evidence").innerHTML = workerChanges(chat.threadId, page.items);
  void loadWorkerArtifacts(chat);
}
function workerChanges(threadId, items) {
  const workIds = new Set((plan?.work ?? []).filter(item => item.threadId === threadId).map(item => item.id));
  const linked = view.evidence.filter(record => record.native?.workId && workIds.has(record.native.workId));
  const legacy = view.evidence.some(record => !record.native);
  const writes = items.filter(item => item.kind === "tool" && /write|edit|patch|create|delete|move|rename/i.test(item.name ?? ""));
  const paths = writes.map(item => {
    try {
      const args = JSON.parse(item.argsPreview);
      const path = args.path ?? args.file ?? args.filePath ?? args.filename;
      return typeof path === "string" ? esc(path) : esc(item.name);
    } catch { return esc(item.name); }
  });
  return `<section class="changes-evidence"><h4>Evidence</h4>${linked.map(artifactButton).join("") || '<p class="note">No evidence linked to this thread.</p>'}${legacy ? '<p class="note">Legacy evidence without native provenance stays unlinked.</p>' : ""}<h4>Files touched (from tool calls)</h4>${paths.length ? `<ul>${paths.map(path => `<li>${path}</li>`).join("")}</ul>` : '<p class="note">No write/edit tool calls in this page.</p>'}</section>`;
}
function captureDialogDraft() {
  const form = dialog.querySelector("[data-task-message]");
  const draft = form && formDrafts.get(form.dataset.draftKey);
  if (draft) draft.text = form.querySelector("textarea").value;
  captureKnowledgeDraft(); captureUploadDraft(); captureSettingsDraft(); captureCreationDraft(); persistDraftsSafely();
}
const draftStorageKey = "pi-projects-ui-drafts:v1";
let lastDraftSnapshot = "";
function persistBrowserDrafts() {
  const state = { version: 1, coordinator: [...drafts], answers: [...answers], forms: [...formDrafts], knowledge: [...knowledgeDrafts], knowledgePaths: [...knowledgePaths], uploads: [...uploadDrafts], settings: [...settingsDrafts], creations: [...creationDrafts] };
  const serialized = JSON.stringify(state);
  validateBrowserDraftState(state);
  if (new TextEncoder().encode(serialized).length > 1048576) throw new Error("Browser draft snapshot exceeds 1 MiB. In-memory drafts retained without truncation");
  if (serialized !== lastDraftSnapshot) { sessionStorage.setItem(draftStorageKey, serialized); lastDraftSnapshot = serialized; }
  lastDraftError = null;
}
function persistDraftsSafely() {
  try { persistBrowserDrafts(); }
  catch (error) { if (error.message !== lastDraftError) { lastDraftError = error.message; report(error); } }
}
function validateBrowserDraftState(state) {
  const pairs = value => Array.isArray(value) && value.length <= 256 && value.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string") && new Set(value.map(pair => pair[0])).size === value.length;
  const text = value => typeof value === "string" && value.length <= 32000;
  if (state?.creations !== undefined && (!pairs(state.creations) || state.creations.some(([id, value]) => !uuid(id) || !value || typeof value.name !== "string" || value.name.length > 120 || !text(value.cwd) || !text(value.objective) || !["draft", "unknown", "created"].includes(value.outcome) || value.requestBound !== undefined && typeof value.requestBound !== "boolean" || (value.outcome === "created" ? !uuid(value.createdId) || value.requestBound === true && value.createdId !== id : value.createdId !== null)))) throw new Error("Malformed creation drafts; nothing restored or truncated");
  if (state?.settings !== undefined && (!pairs(state.settings) || state.settings.some(([key, value]) => !/^[a-f0-9-]{36}:(?:name|objective)$/.test(key) || !value || !text(value.text) || !/^[a-f0-9]{64}$/.test(value.expectedRevision)))) throw new Error("Malformed settings drafts; nothing restored or truncated");
  if (state?.uploads !== undefined && (!pairs(state.uploads) || state.uploads.some(([id, value]) => !uuid(id) || !value || value.importId !== id || !uuid(value.projectId) || typeof value.filename !== "string" || value.filename.length > 240 || typeof value.title !== "string" || value.title.length > 1000 || !["utf8", "base64"].includes(value.encoding) || typeof value.text !== "string" || value.text.length > 43692 || value.submittedFingerprint !== null && !/^[a-f0-9]{64}$/.test(value.submittedFingerprint)))) throw new Error("Malformed upload drafts; nothing restored or truncated");
  if (state?.knowledge !== undefined && (!pairs(state.knowledge) || state.knowledge.some(([key, value]) => !uuid(key.slice(0, 36)) || key[36] !== ":" || !knowledgePath(key.slice(37)) || !value || !text(value.text) || value.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(value.expectedRevision))) || state?.knowledgePaths !== undefined && (!pairs(state.knowledgePaths) || state.knowledgePaths.some(([id, value]) => !uuid(id) || typeof value !== "string" || value.length > 240))) throw new Error("Malformed browser knowledge drafts; nothing restored or truncated");
  if (!state || state.version !== 1 || !pairs(state.coordinator) || !pairs(state.answers) || !pairs(state.forms) || state.coordinator.some(([id, value]) => !(uuid(id) || /^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(id)) || !text(value)) || state.answers.some(([id, value]) => !(uuid(id) || /^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(id)) || !text(value)) || state.forms.some(([key, value]) => !/^[a-f0-9-]{36}:(?:steer|revise|thread-send|thread-steer):[a-f0-9-]{36}$/.test(key) || !value || !text(value.text) || !uuid(value.requestId) || value.submittedText !== null && !text(value.submittedText))) throw new Error("Malformed/oversized browser draft state. In-memory drafts retained without truncation");
}
function restoreBrowserDrafts() {
  try {
    const serialized = sessionStorage.getItem(draftStorageKey);
    if (!serialized) return;
    if (new TextEncoder().encode(serialized).length > 1048576) throw new Error("Browser draft snapshot exceeds 1 MiB");
    const state = JSON.parse(serialized);
    validateBrowserDraftState(state);
    for (const [id, value] of state.coordinator) drafts.set(id, value);
    for (const [id, value] of state.answers) answers.set(id, value);
    for (const [id, value] of state.forms) formDrafts.set(id, { ...value });
    for (const [id, value] of state.knowledge ?? []) knowledgeDrafts.set(id, { ...value });
    for (const [id, value] of state.knowledgePaths ?? []) knowledgePaths.set(id, value);
    for (const [id, value] of state.uploads ?? []) uploadDrafts.set(id, { ...value });
    for (const [id, value] of state.settings ?? []) settingsDrafts.set(id, { ...value });
    for (const [id, value] of state.creations ?? []) creationDrafts.set(id, { name: value.name, cwd: value.cwd, objective: value.objective, outcome: value.outcome, createdId: value.createdId, ...(value.requestBound === undefined ? {} : { requestBound: value.requestBound }) });
    lastDraftSnapshot = JSON.stringify({ version: 1, coordinator: [...drafts], answers: [...answers], forms: [...formDrafts], knowledge: [...knowledgeDrafts], knowledgePaths: [...knowledgePaths], uploads: [...uploadDrafts], settings: [...settingsDrafts], creations: [...creationDrafts] });
  } catch (error) { report(error); }
}
restoreBrowserDrafts();
window.addEventListener("pagehide", () => { captureDialogDraft(); persistDraftsSafely(); });
// Subscription limits. The host fetches and normalizes them (no tokens or raw responses reach the browser) and itself polls a provider at most once every 5 minutes (the refresh button polls now, with a short per-provider cooldown on the host); the bar re-renders every 30 s so countdowns stay current.
let limits = null, limitsRefreshing = false;
const limitTone = percent => percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
function untilReset(at) { const ms = at - Date.now(); return ms <= 0 ? "reset passed" : `resets in ${duration(ms)}`; }
const limitWindowName = { mo: "month" };
function limitWindow(sample) {
  const stale = sample.resetsAt !== null && sample.resetsAt <= Date.now(), percent = Math.round(sample.usedPercent);
  return { stale, percent, html: `<span class="lim-win"${stale ? " data-stale" : ""}><span class="lim-win-name">${limitWindowName[sample.window] ?? sample.window}</span><span class="lim-bar"><i style="width:${percent}%"></i></span>${stale ? "—" : `${percent}%`}</span>` };
}
// Brand marks, inline (no external assets). Paths are from Simple Icons (CC0, https://simpleicons.org; v16.35.0): claude, openai, cursor. The marks are trademarks of their owners and are shown only to identify the provider.
// Claude keeps its brand orange, OpenAI follows the text colour, Cursor is its dark tile with a light mark and a faint outline so it stays visible on any bar background. The provider name stays in aria-label and the hover detail.
const iconSvg = body => `<svg class="prov-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">${body}</svg>`;
const providerIcon = {
  claude: iconSvg('<path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>'),
  codex: iconSvg('<path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>'),
  cursor: iconSvg('<rect x=".5" y=".5" width="23" height="23" rx="5.5" fill="#14120B" stroke="#8a8a8a" stroke-opacity=".55"/><path fill="#fff" transform="translate(4.8 4.8) scale(.6)" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/>'),
};
function elizaItem(provider) {
  const usage = provider.usage, stale = usage && usage.periodEndAt <= Date.now();
  const reading = usage ? usage.amountUsd.toLocaleString("en-US", { style: "currency", currency: "USD" }) : null, amount = stale ? null : reading;
  const failure = usage && provider.reason ? `<small class="lim-error">Last refresh failed: ${esc(provider.reason)}${provider.lastAttemptAt ? ` · ${ago(provider.lastAttemptAt)}` : ""}</small>` : "";
  const detail = usage ? `<div class="lim-cost-detail"><span>${reading} ${stale ? "previous period" : "month to date"}</span><small>${new Date(usage.periodStartAt).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} · USD · all usage buckets</small><small>Account ${esc(usage.account)}${usage.pool ? ` · Pool ${esc(usage.pool)}` : ""} · ${untilReset(usage.periodEndAt)} at 00:00 UTC${stale ? " · waiting for a new reading" : ""}</small><small>Fetched ${ago(usage.observedAt)} via GET /v2/usage</small></div>${failure}` : `<small>${provider.status === "unavailable" ? "Not connected" : "No data yet"}${provider.reason ? `: ${esc(provider.reason)}` : ""}${provider.lastAttemptAt ? ` · last tried ${ago(provider.lastAttemptAt)}` : ""}</small>`;
  const label = `Eliza: ${usage ? stale ? "reset, waiting for new data" : `${amount} month to date` : provider.status === "unavailable" ? "not connected" : "no data yet"}`;
  return `<div class="lim" tabindex="0" role="group" data-provider="eliza" data-tone="low" aria-label="${esc(label)}"><span class="lim-name" aria-hidden="true">Eliza</span><span class="lim-cost">${amount ?? "—"}</span><span class="lim-pop" role="group" aria-label="Eliza details"><b>Eliza</b>${detail}</span></div>`;
}
function limitItem(provider) {
  if (provider.provider === "eliza") return elizaItem(provider);
  const windows = provider.samples.map(limitWindow), live = windows.filter(win => !win.stale);
  const tone = limitTone(Math.max(0, ...live.map(win => win.percent)));
  const rows = provider.samples.map((sample, i) => {
    const win = windows[i];
    return `<div class="lim-row" data-tone="${limitTone(win.percent)}"><span>${limitWindowName[sample.window] ?? sample.window}</span><span class="lim-bar"><i style="width:${win.percent}%"></i></span><span>${win.stale ? "—" : `${win.percent}% used`}</span><small>${sample.resetsAt === null ? "Reset time unknown" : `${untilReset(sample.resetsAt)} · ${new Date(sample.resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`}${win.stale ? " · last reading is from before the reset, waiting for a new one" : ""} · observed ${ago(sample.observedAt)} via ${sample.source === "headers" ? "response headers" : "usage endpoint"}</small></div>`;
  });
  const empty = provider.status === "unavailable" ? "Not connected" : "No data yet";
  const connect = provider.connect, signedOut = provider.status === "unavailable" && !!connect;
  const connectHtml = !connect ? "" : connect.state === "waiting" ? `<small class="lim-connect-note">Waiting for you to sign in. <a href="${esc(connect.loginUrl)}" target="_blank" rel="noopener noreferrer">Open the Cursor sign-in page</a></small>` : signedOut || connect.state === "failed" ? `${connect.error ? `<small>${esc(connect.error)}</small>` : ""}<button type="button" class="small" data-action="cursor-connect">Connect Cursor</button>` : "";
  const failure = provider.samples.length && provider.reason ? `<small class="lim-error">Last refresh failed: ${esc(provider.reason)}${provider.lastAttemptAt ? ` · ${ago(provider.lastAttemptAt)}` : ""}</small>` : "";
  const detail = rows.join("") + failure || `<small>${empty}${provider.reason ? `: ${esc(provider.reason)}` : ""}${provider.lastAttemptAt ? ` · last tried ${ago(provider.lastAttemptAt)}` : ""}</small>`;
  const label = `${provider.label}: ${provider.samples.length ? provider.samples.map((sample, i) => `${sample.window} ${windows[i].stale ? "reset, waiting for new data" : `${windows[i].percent}% used`}`).join(", ") : empty.toLowerCase()}`;
  return `<div class="lim" tabindex="0" role="group" data-provider="${esc(provider.provider)}" data-tone="${tone}" aria-label="${esc(label)}"><span class="lim-name" aria-hidden="true" title="${esc(provider.label)}">${providerIcon[provider.provider] ?? esc(provider.label)}</span>${windows.map(win => win.html).join("") || "<span>—</span>"}<span class="lim-pop" role="group" aria-label="${esc(provider.label)} details"><b>${esc(provider.label)}</b>${detail}${connectHtml}</span>${signedOut && connect.state === "idle" ? '<button type="button" class="lim-connect" data-action="cursor-connect">Connect</button>' : ""}</div>`;
}
function renderLimits() {
  const bar = document.querySelector("#limits-bar");
  const refresh = `<button type="button" class="ghost small lim-refresh${limitsRefreshing ? " spinning" : ""}" data-action="limits-refresh" aria-label="Refresh limits" title="Refresh limits now"${limitsRefreshing ? " disabled" : ""}><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.2v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  const next = limits ? limits.providers.map(limitItem).join("") + refresh : "";
  if (bar.dataset.html === next) { renderMachine(); return; }
  const focused = bar.contains(document.activeElement) ? document.activeElement.closest(".lim")?.dataset.provider : null;
  bar.innerHTML = next; bar.dataset.html = next; renderMachine();
  if (focused) bar.querySelector(`.lim[data-provider="${focused}"]`)?.focus({ preventScroll: true });
}
// Machine status (host-sampled, cached ~5 s there): polled every 10 s while the tab is visible. A null value means unreadable (—); a missing one is hidden.
let machine = null;
const machineIcon = {
  ram: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4.5" width="13" height="6" rx="1"/><path d="M4.5 10.5v2M8 10.5v2M11.5 10.5v2M4.5 7.5h1M7.5 7.5h1M10.5 7.5h1"/></svg>',
  cpu: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5"/></svg>',
  ssd: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="8" width="13" height="5" rx="1.2"/><path d="M1.5 8l2-4.5h9L14.5 8M11.5 10.5h.01"/></svg>',
  battery: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4.5" width="11" height="7" rx="1.2"/><path d="M14.5 7v2"/></svg>',
};
// The machine group is its own node, re-rendered only when its text changes, so a CPU tick never rebuilds the provider items (and drops their hover).
const machineEl = Object.assign(document.createElement("div"), { className: "mach" });
machineEl.setAttribute("role", "group"); machineEl.setAttribute("aria-label", "Machine status");
function renderMachine() {
  const bar = document.querySelector("#limits-bar");
  if (machineEl.parentElement !== bar) bar.append(machineEl);
  const next = machineHtml();
  if (machineEl.dataset.html !== next) { machineEl.innerHTML = next; machineEl.dataset.html = next; }
}
function machineHtml() {
  if (!machine) return "";
  const pct = value => typeof value === "number" ? `${value}%` : "—";
  const items = [];
  if ("ram" in machine) items.push(["ram", machine.ram ? `${machine.ram.usedGb.toFixed(1)} GB / ${machine.ram.totalGb.toFixed(1)} GB` : "—", "Memory in use (app + wired + compressed) / total physical memory"]);
  if ("cpu" in machine) items.push(["cpu", pct(machine.cpu), "CPU usage across all cores"]);
  if ("ssd" in machine) items.push(["ssd", pct(machine.ssd), "Disk space used on the main data volume"]);
  if ("battery" in machine) items.push(["battery", pct(machine.battery), "Battery charge"]);
  return `${items.map(([kind, text, what]) => `<span class="mach-item" tabindex="0" data-kind="${kind}" aria-label="${esc(`${what}: ${text}`)}">${machineIcon[kind]}<span>${esc(text)}</span><span class="mach-tip" role="tooltip">${esc(what)}</span></span>`).join("")}`;
}
async function loadMachine() {
  if (document.hidden) return;
  const loaded = await api({ action: "machine-status" }).catch(() => null);
  if (loaded && typeof loaded === "object") { machine = loaded; renderMachine(); }
}
setInterval(() => void loadMachine(), 10000);
async function loadLimits(visit = false) {
  if (document.hidden) return;
  // A page load or the tab coming back retries a provider that is showing an error instead of waiting out its backoff.
  const loaded = await api({ action: "limits-snapshot", ...(visit ? { visit: true } : {}) }).catch(() => null);
  if (loaded?.providers) { limits = loaded; renderLimits(); }
}
setInterval(() => void loadLimits(), 5 * 60000);
// While a Cursor sign-in is pending, look every 3 s so the bar updates as soon as the host finishes it.
let limitsWatch = null;
function scheduleLimitsWatch() {
  clearInterval(limitsWatch); limitsWatch = null;
  if (limits?.providers.find(item => item.provider === "cursor")?.connect?.state === "waiting") limitsWatch = setInterval(() => void loadLimits().then(scheduleLimitsWatch), 3000);
}
setInterval(renderLimits, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { void loadLimits(true); void loadMachine(); } });
void loadLimits(true);
void loadMachine();
void start();

// Settings section nav: smooth-scroll to a section (no hash navigation) and highlight the section in view.
document.addEventListener("click", event => {
  const link = event.target.closest(".set-nav a");
  if (!link) return;
  event.preventDefault();
  document.querySelector(link.getAttribute("href"))?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
});
const markSettingsNav = () => {
  const sections = [...document.querySelectorAll(".set-section")], body = document.querySelector(".body");
  if (!sections.length || document.querySelector('[data-panel="settings"]').hidden) return;
  const line = body.getBoundingClientRect().top + 90;
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  const current = atEnd ? sections.at(-1) : sections.findLast(section => section.getBoundingClientRect().top <= line) ?? sections[0];
  for (const link of document.querySelectorAll(".set-nav a")) link.classList.toggle("on", link.getAttribute("href") === `#${current.id}`);
};
document.querySelector(".body").addEventListener("scroll", markSettingsNav, { passive: true });
new MutationObserver(markSettingsNav).observe(document.querySelector('[data-panel="settings"]'), { attributes: true, attributeFilter: ["hidden"] });

