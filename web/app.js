const initial = new URL(location.href);
const key = `pi-projects-token:${location.origin}`;
const supplied = new URLSearchParams(initial.hash.slice(1)).get("token");
// localStorage, not sessionStorage: browsers such as Arc re-create tabs without the stripped #token fragment.
// Each host start uses a new port, so tokens stored for other origins are dead; drop them.
if (supplied) {
  for (const stored of Object.keys(localStorage)) if (stored.startsWith("pi-projects-token:") && stored !== key) localStorage.removeItem(stored);
  localStorage.setItem(key, supplied);
}
initial.hash = "";
history.replaceState(null, "", initial);
const token = localStorage.getItem(key) || "";
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
let liveFrame = null;
let liveRetryMs = 1000;
// Follow new chat content only while the reader is at the bottom; scrolling up pauses it until they return.
let stickToBottom = true;
let showArchived = false;
function followTranscript() { if (stickToBottom) { const node = document.querySelector("#transcript"); node.scrollTop = node.scrollHeight; } }
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
const tabs = ["coordinator", "knowledge", "activity", "observability", "settings"];
let tab = tabs.includes(initial.searchParams.get("tab")) ? initial.searchParams.get("tab") : "coordinator";
// Observability usage is pinned to the project/generation that requested it.
let usageObs = null, usageLoading = false;
let observability = null, observabilityLoading = false, eventOffset = 0;

let refusal = null;
async function start() {
  document.querySelector("#compose button").disabled = true;
  const current = generation;
  try {
    const loaded = await api({ action: "list" });
    if (current !== generation) return;
    projects = loaded;
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
  } catch (error) { if (current === generation) showError(error); }
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
    try { next = await api({ action: "show", id, ...(chat === "main" ? {} : { chatId: chat }), ...focus }); }
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
    ensureLive();
    if (workerChat && tab === "activity") await refreshWorkerChat(workerChat);
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
  // A committed entry or a finished run means the transcript changed: refresh before hiding the bubble so the final text never blinks out.
  if (previous && (previous.entries !== frame.entries || previous.running !== frame.running)) await settledRefresh();
  renderLive();
}

// A refresh that starts after this call and finishes. A plain refresh() only queues while a poll is in flight, which used to hide the bubble before the transcript caught up.
async function settledRefresh() {
  while (polling === generation) await new Promise(resolve => setTimeout(resolve, 30));
  await refresh();
}

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
  const pill = document.querySelector("#working-pill"), frame = liveStream?.id === projectId ? liveFrame : null;
  const status = frame?.running ? liveStatus(frame) : "";
  pill.hidden = !status || stickToBottom;
  pill.querySelector(".pill-text").textContent = status;
}

function renderLive() {
  const node = document.querySelector("#live-reply");
  const frame = liveStream?.id === projectId ? liveFrame : null;
  if (!frame?.running) { node.hidden = true; node.innerHTML = ""; renderWorkingPill(); return; }
  // Once text streams, the reasoning summary steps aside into a quiet line above it, as in the transcript.
  const status = liveStatus(frame), thought = frame.text && frame.thinkingText ? thoughtText(frame.thinkingText) : "";
  node.innerHTML = `<div class="who">Coordinator <small class="inline">live</small></div>${thought ? `<p class="thought live"><span class="thought-mark">Thinking</span>${esc(thought)}</p>` : ""}${frame.text ? `<div class="text">${renderMarkdown(frame.text)}</div>` : ""}<p class="live-status"><span class="live-dot"></span><span>${esc(status)}</span></p>`;
  node.hidden = false;
  followTranscript();
  renderWorkingPill();
}

function changeProject(id, chat = "main") {
  generation++;
  workerChat = null; searchFocus = null; workerFocus = null;
  projectId = id; chatId = chat;
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
  const inlineThread = document.querySelector("#inline-thread"); if (inlineThread) { inlineThread.hidden = true; inlineThread.replaceChildren(); document.querySelector("#thread-empty").hidden = false; }
  const p = projects.find(p => p.id === id);
  document.querySelector("#eyebrow").hidden = true;
  document.querySelector("#title").textContent = id ? p?.name ?? "Opening project…" : "Create your first project.";
  document.querySelector("#subtitle").textContent = id ? "Restoring the coordinator and worker controls…" : "Choose a trusted workspace. Then send the coordinator any request.";
  document.querySelector("#avatar").textContent = initials(p?.name);
  for (const selector of ["#chat-bar", "#queue", "#letter", "#needs-questions", "#questions", "#activity", "#outcomes", "#notes", "#messages", "#reply-summary", "#workspace", "#evidence-inline", "#work-list", "#obs-kpis", "#obs-usage", "#obs-health", "#obs-trace", "#obs-timeline", "#obs-event-log", "#obs-usage-time", "#owner-steps", "#settings-summary"]) document.querySelector(selector).replaceChildren();
  document.querySelector("#chat-bar").dataset.html = "";
  renderProjects();
  document.querySelector("#warning").hidden = true;
  disableActions();
  void refresh();
}

// Switching chats keeps the project, plan and rail; only the transcript, live stream and draft change.
function changeChat(chat) {
  if (chat === chatId && view?.chatId === chat) return;
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
  const button = chat => `<button class="chat ${chat.id === chatId ? "on" : ""} ${chat.busy ? "busy" : ""} ${chat.attention ? "attention" : ""} ${chat.archived ? "archived" : ""}" data-action="chat-select" data-chat="${esc(chat.id)}" title="${esc(chat.title)}${chat.busy ? " · working" : chat.attention ? " · needs attention" : ""}"><span class="chat-dot"></span><span class="chat-title">${esc(chat.title)}</span></button>`;
  const next = !view?.chats ? "" : `<nav id="chat-list" class="chat-list" aria-label="Chats">${chats.filter(chat => !chat.archived || chat.id === chatId).map(button).join("")}</nav><button type="button" class="ghost small" data-action="chat-new" title="Start a chat that shares this project's workers and knowledge">＋ New chat</button><span class="chat-tools">${current ? `<button type="button" class="ghost small" data-action="chat-rename">Rename</button>` : ""}${current && current.id !== "main" ? current.archived ? `<button type="button" class="ghost small" data-action="chat-restore" data-chat="${esc(current.id)}">Restore</button>` : `<button type="button" class="ghost small" data-action="chat-archive">Archive</button>` : ""}${archived.length ? `<details id="chat-archived" class="chat-archived"><summary>Archived (${archived.length})</summary><div class="archived-list">${archived.map(chat => `<div class="archived-row"><span>${esc(chat.title)}</span><span><button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(chat.id)}">Open</button> <button type="button" class="ghost small" data-action="chat-restore" data-chat="${esc(chat.id)}">Restore</button></span></div>`).join("")}</div></details>` : ""}</span>`;
  if (node.dataset.html !== next) { const open = node.querySelector("#chat-archived")?.open; node.innerHTML = next; node.dataset.html = next; if (open && node.querySelector("#chat-archived")) node.querySelector("#chat-archived").open = true; }
}

function renderProjects() {
  const node = document.querySelector("#projects");
  node.innerHTML = projects.length ? projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("") : '<option value="">No projects yet</option>';
  node.value = projectId ?? "";
  const list = document.querySelector("#project-list");
  const next = projects.map(p => `<button class="proj ${p.id === projectId ? "on" : ""}" data-select-project="${esc(p.id)}"><span class="avatar sm">${esc(initials(p.name))}</span><span class="grow">${esc(p.name)}</span>${p.id === projectId && pendingCount() ? `<span class="count">${pendingCount()}</span>` : ""}</button>`).join("") || '<p class="note">No projects yet.</p>';
  if (list.dataset.html !== next) { list.innerHTML = next; list.dataset.html = next; }
}
function initials(name) { return String(name ?? "π").trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? "").join("").toUpperCase() || "π"; }
function pendingCount() { return view ? view.inbox.filter(item => !item.result).length + (approvalPage?.total ?? 0) : 0; }
function setTab(next) {
  if (!tabs.includes(next)) return;
  tab = next;
  const url = new URL(location.href); url.searchParams.set("tab", next); history.replaceState(null, "", url);
  document.querySelectorAll("[data-panel]").forEach(node => { node.hidden = node.dataset.panel !== next; });
  document.querySelectorAll(".tabs [data-tab]").forEach(node => node.classList.toggle("on", node.dataset.tab === next));
  // A hidden transcript loses its scroll position; coming back to the chat means reading the newest message.
  if (next === "coordinator") { stickToBottom = true; requestAnimationFrame(followTranscript); }
  if (next === "observability") { void loadUsage(); void loadObservability(); }
  if (next === "settings") { void loadAutomationStrip(); void loadEventsIn(); void loadTelegram(); void loadSkillsPicker(); void loadMcpPicker(); void loadWorktrees(); renderNotify(); }
}

function render() {
  if (!view) return;
  const pending = [...view.inbox.filter(item => !item.result), ...(approvalPage?.items ?? []).filter(record => record.status === "pending").map(record => ({ kind: "approval", id: `operation:${record.id}`, title: `${record.operation.provider} ${record.operation.kind} · ${record.operation.repositoryId}`, record }))].sort((a, b) => (a.kind === "question" ? 0 : 1) - (b.kind === "question" ? 0 : 1));
  const pendingTotal = view.inbox.filter(item => !item.result).length + (approvalPage?.total ?? 0);
  // Questions live in the chat transcript; the sidebar card keeps operation approvals only.
  const approvals = pending.filter(item => item.kind === "approval");
  const entry = approvals.find(item => item.id === selected) ?? approvals[0];
  selected = entry?.id ?? null;
  const eyebrow = document.querySelector("#eyebrow");
  eyebrow.textContent = pendingTotal ? `${pendingTotal} ${pendingTotal === 1 ? "thing needs" : "things need"} your call` : ""; eyebrow.hidden = !pendingTotal;
  document.title = `${view.project.name} · Pi Projects`;
  document.querySelector("#title").textContent = view.project.name;
  document.querySelector("#avatar").textContent = initials(view.project.name);
  for (const selector of ["#needs-count"]) { const node = document.querySelector(selector); node.textContent = String(pendingTotal); node.hidden = !pendingTotal; }
  renderProjects();
  renderChats();
  document.querySelector("#subtitle").textContent = pendingTotal && pending.length < pendingTotal ? `Showing ${pending.length}/${pendingTotal} pending decisions. Open all approvals for the rest.` : view.project.objective ?? "";
  setHtml("#queue", approvals.length < 2 ? "" : approvals.map((item, i) => `<button class="inbox-item ${entry.id === item.id ? "active" : ""}" data-action="select" data-entry="${item.id}"><span class="index">${String(i + 1).padStart(2, "0")}</span><span class="item-body"><strong>${esc(item.title)}</strong><small>${item.kind === "question" ? "A decision for the coordinator" : "Exact bound operation, not an execution"}</small></span><span class="arrow">↗</span></button>`).join(""));
  setHtml("#letter", entry ? letter(entry) : "");
  const waiting = questionPlacement();
  setHtml("#needs-questions", waiting.here.length || waiting.elsewhere.length ? `${waiting.here.length ? `<button type="button" class="ghost small" data-action="questions-jump">${waiting.here.length} ${waiting.here.length === 1 ? "question" : "questions"} in chat ↓</button>` : ""}${waiting.elsewhere.length ? `<button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(waiting.elsewhere[0].chat.id)}">${waiting.elsewhere.length} ${waiting.elsewhere.length === 1 ? "question" : "questions"} in other chats →</button>` : ""}` : "");
  document.querySelector("#needs-card").hidden = !entry && !waiting.here.length && !waiting.elsewhere.length;
  document.querySelector("#question-hint").hidden = !waiting.here.length;
  setHtml("#activity", plan ? durableActivity() : '<p class="note">No workers are running.</p>');
  setHtml("#outcomes", plan ? durableResults() : "");
  renderArcPrs(); void loadArcPrs();
  // The rail shows topic documents; the starter files and raw legacy answers live in the Knowledge tab.
  const topics = knowledgeDocs.filter(doc => doc.path !== "MEMORY.md" && doc.path !== "preferences.md" && !doc.path.startsWith("research/legacy/"));
  setHtml("#notes", topics.length ? knowledgeTree(topics, true) : `<p class="note">${knowledgeDocs.length ? "Only the starter MEMORY.md and preferences.md so far." : "No knowledge documents yet."}</p>`);
  setHtml("#knowledge-inline", knowledgeDocs.length ? knowledgeTree(knowledgeDocs, false) : '<p class="note">No knowledge documents yet.</p>');
  setHtml("#uploads-inline", uploadsHtml()); renderAttachments();
  setHtml("#messages", transcriptHtml(waiting.answered) || `<div class="empty-chat"><h2>How can the coordinator help with ${esc(view.project.name)}?</h2><p>Describe an outcome. The coordinator plans the work, spawns workers and brings decisions back here.</p></div>`);
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
  const hint = document.querySelector("#compose-hint");
  hint.textContent = `${view.project.model.split("/").at(-1)} · Enter to send · Shift+Enter for a new line · / for skills${arcPrNow()?.arc ? " · # for PRs" : ""}`; hint.title = view.project.model;
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
  if (transcript.dataset.count !== String(view.messages.length)) {
    // The owner's own send always returns them to the newest message.
    if (view.messages.findLast(message => message.text?.trim() || message.kind === "tool")?.role === "user") stickToBottom = true;
    transcript.dataset.count = String(view.messages.length);
  }
  followTranscript();
  setHtml("#evidence-inline", view.evidence.slice(-6).reverse().map(artifactButton).join("") || '<p class="note">No evidence captured yet.</p>');
  const archivable = item => ["completed", "failed", "stopped", "blocked"].includes(item.status) && !item.archived;
  const workRow = item => {
    const when = item.status === "running" && item.startedAt ? `running ${duration(Date.now() - item.startedAt)}` : item.endedAt ? `${item.status} ${duration(Date.now() - item.endedAt)} ago` : item.status;
    const meta = [item.role, item.attempt?.model?.split("/").at(-1), when, item.archived ? "archived" : "", item.dependsOn.length ? `after ${item.dependsOn.length} item(s)` : ""].filter(Boolean).join(" · ");
    const child = item.parentThreadId ? ` child" data-parent="${esc(item.parentThreadId)}` : "";
    return `<div class="work ${esc(item.status)} ${item.archived ? "archived" : ""} ${workerChat?.threadId === item.threadId ? "on" : ""}${child}"><button class="work-open" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(item.threadId)}" title="${esc(item.text)}"><span class="dot"></span><strong>${item.parentThreadId ? '<span class="sub-label">sub-agent</span> ' : ""}${esc(item.text.replace(/\s+/g, " ").trim().slice(0, 240))}</strong><small>${esc(meta)}</small>${item.blocker ? `<small class="work-blocker">${esc(item.blocker)}</small>` : ""}</button>${archivable(item) ? `<button class="ghost small archive" data-action="work-archive" data-project="${esc(projectId)}" data-work="${esc(item.id)}">Archive</button>` : ""}</div>`;
  };
  const listed = work.filter(item => showArchived || !item.archived);
  document.querySelector("#work-count").textContent = plan ? `Work · ${listed.length}` : "Workers";
  // One level of nesting: a parent worker's children sit under its newest row; orphans (parent hidden) stay top level.
  const newest = listed.toReversed(), shownThreads = new Set(newest.map(item => item.threadId));
  const treeRows = () => { const placed = new Set(); return newest.filter(item => !item.parentThreadId || !shownThreads.has(item.parentThreadId) || item.parentThreadId === item.threadId).map(item => { const first = !placed.has(item.threadId); placed.add(item.threadId); const kids = first ? newest.filter(candidate => candidate.parentThreadId === item.threadId && candidate.threadId !== item.threadId) : []; return workRow(item) + (kids.length ? `<div class="work-children" data-parent="${esc(item.threadId)}">${kids.map(workRow).join("")}</div>` : ""); }).join(""); };
  setHtml("#work-list", plan ? treeRows() || '<p class="note">No work yet. Message the coordinator to start.</p>' : '<p class="note">No workers are running.</p>');
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
  const scopes = p.workspaceAuthorization?.scopes?.length ?? 0, grants = p.githubAuthorization?.length ?? 0, arcProject = p.workspaceAuthorization?.provider === "arc";
  const step = (done, title, detail) => `<li class="${done ? "done" : ""}"><span class="n">${done ? "✓" : "•"}</span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></li>`;
  const wholeRepository = p.workspaceAuthorization?.scopes?.some(scope => scope.wholeRepository);
  setHtml("#owner-steps", [step(scopes > 0, "1. Workspace", wholeRepository ? "Workers can edit this repository" : scopes ? `${scopes} folder-limited scope(s)` : "Workers cannot edit code yet.") + (scopes ? "" : '<li class="step-action"><button class="primary" data-action="workspace-quick">Let workers edit this repo</button></li>'), (arcProject ? step(!!p.arcAuthorization, "2. Arcadia", p.arcAuthorization ? `Draft PRs as ${p.arcAuthorization.login} against trunk` : wholeRepository ? "Workers cannot open draft PRs yet." : "Not connected.") + (wholeRepository && !p.arcAuthorization ? '<li class="step-action"><button class="primary" data-action="arc-quick">Connect Arcadia</button></li>' : "") : step(grants > 0, "2. GitHub", grants ? `Draft PRs on ${p.githubAuthorization.map(grant => grant.repositoryId).join(", ")}` : wholeRepository ? "Workers cannot open draft PRs yet." : "Not connected.") + (wholeRepository && !grants ? '<li class="step-action"><button class="primary" data-action="github-quick">Connect GitHub</button></li>' : "")), ...(wholeRepository ? [] : [step(false, "3. Fixed command profile", "Optional, owner-defined executable and arguments.")]), step(true, wholeRepository ? "3. Skills" : "4. Skills", "Chosen per role in Skills below; repository skills by default.")].join(""));
  if (tab === "settings" && plan) { void loadAutomationStrip(); void loadEventsIn(); void loadSkillsPicker(); void loadMcpPicker(); void loadWorktrees(); void loadContextSettings(); }
  if (tab === "settings" && !telegramView) void loadTelegram();
  setHtml("#settings-summary", `<div class="kv"><span>Coordinator model</span><b>${esc(p.model)}</b>${Object.entries(p.models ?? {}).map(([role, model]) => `<span>${esc(role[0].toUpperCase() + role.slice(1))} model</span><b>${esc(model)}</b>`).join("")}<span>Workspace</span><b class="mono">${esc(p.cwd)}</b></div>`);
  if (tab === "observability" && plan && (!usageObs || Date.now() - usageObs.at > 15000)) void loadUsage();
}

// Skills (Settings): "All profiles" plus per-role additions. Prompts carry only names and descriptions; bodies are read on demand.
const skillProfileTabs = [["all", "All profiles"], ["coordinator", "Coordinator"], ["worker", "Worker"], ["scout", "Scout"], ["reviewer", "Reviewer"]];
const skillSourceLabels = { repo: "Repository", global: "Global", package: "Packages" };
let skillsPicker = null;
async function loadSkillsPicker(force = false) {
  const id = projectId, current = generation, node = document.querySelector("#skills-picker");
  if (!id || !plan || !force && skillsPicker?.projectId === id) return;
  try {
    const [settings, { skills }] = await Promise.all([api({ action: "settings-snapshot", id }), api({ action: "coordinator-skills", id })]);
    if (id !== projectId || current !== generation) return;
    const saved = settings.values.skills;
    const profiles = saved ?? { all: skills.filter(skill => skill.source === "repo").map(skill => skill.name), coordinator: [], worker: [], scout: [], reviewer: [] };
    skillsPicker = { projectId: id, skills, isDefault: !saved, draft: sortedLists(profiles), saved: JSON.stringify(sortedLists(profiles)), tab: skillsPicker?.projectId === id ? skillsPicker.tab : "all", query: skillsPicker?.projectId === id ? skillsPicker.query : "", note: "" };
    renderSkillsPicker();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">Skills unavailable: ${esc(error.message)}</p>`; }
}
// Pickers render in three parts so a toggle never moves anything: "all" = shell (tabs, search, list), "list" = rows only (search, bulk), "chrome" = counts and buttons only (a checkbox toggle).
const sortedLists = value => Object.fromEntries(Object.entries(value).map(([key, list]) => [key, [...list].sort()])); // toggling re-sorts a list; a saved list in another order must not look dirty
const profileTabsHtml = (action, tab, count) => `<div class="skill-tabs" role="tablist">${skillProfileTabs.map(([role, label]) => `<button type="button" role="tab" class="ghost small${role === tab ? " on" : ""}" aria-selected="${role === tab}" data-action="${action}" data-role="${role}">${label} <span class="count">${count(role)}</span></button>`).join("")}</div>`;
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
  const row = skill => { const inherited = state.tab !== "all" && all.has(skill.name); return `<label class="skill-pick${inherited ? " inherited" : ""}"><input type="checkbox" data-skill-pick="${esc(skill.name)}" ${inherited || picked.has(skill.name) ? "checked" : ""} ${inherited ? "disabled" : ""}><span><b>${esc(skill.name)}</b>${inherited ? ' <small class="skill-tag">all profiles</small>' : ""}${skill.manual ? ' <small class="skill-tag">manual only</small>' : ""}<small>${esc(skill.description)}</small></span></label>`; };
  return groups.map(([source, list]) => `<fieldset class="events-group skill-group" data-source="${source}" aria-label="${skillSourceLabels[source]}"><div class="group-head"><b>${skillSourceLabels[source]} <span class="count">${list.length}</span></b>${bulkButtons("skills-select", source)}</div>${list.map(row).join("")}</fieldset>`).join("") || '<p class="note">No skill matches.</p>';
}
function renderSkillsPicker(part = "all") {
  const state = skillsPicker, node = document.querySelector("#skills-picker");
  if (!state || state.projectId !== projectId) return;
  const known = new Set(state.skills.map(skill => skill.name)), count = role => new Set([...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter(name => known.has(name))).size;
  document.querySelector("#skills-summary").textContent = `${state.skills.length} loaded · ${state.isDefault && JSON.stringify(state.draft) === state.saved ? "default: repository skills" : `${count("all")} for every profile`}`;
  const dirty = JSON.stringify(state.draft) !== state.saved;
  if (part === "chrome" && node.querySelector(".skill-groups")) return patchPickerChrome(node, count, dirty);
  if (part === "list" && node.querySelector(".skill-groups")) { node.querySelector(".skill-groups").innerHTML = skillsListHtml(state); node.querySelector(".pick-note").innerHTML = skillsNote(state); return patchPickerChrome(node, count, dirty); }
  node.innerHTML = `${profileTabsHtml("skills-tab", state.tab, count)}
    <p class="note pick-note">${skillsNote(state)}</p>
    <div class="pick-tools"><input type="search" id="skills-search" placeholder="Search ${state.skills.length} skills" value="${esc(state.query)}" aria-label="Search skills">${bulkButtons("skills-select")}</div>
    <div class="skill-groups">${skillsListHtml(state)}</div>
    ${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row pick-actions"><button class="primary" data-action="skills-save" ${dirty ? "" : "disabled data-off"}>Save skills</button><button class="ghost" data-action="skills-reset" ${state.isDefault ? "disabled data-off" : ""}>Reset to default</button><small class="pick-state" ${dirty ? "" : "hidden"}>Unsaved changes</small></div>`;
}
const skillsNote = state => (state.tab === "all" ? "Every profile gets these." : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} gets “All profiles” plus the skills checked here.`) + (state.query.trim() ? ` Select all and Clear apply to the ${skillsShown(state).length} shown.` : "");
/** Bulk select or clear the skills currently shown (respecting search), optionally for one source. Inherited rows stay as they are. */
function bulkSkills(source, mode) {
  const state = skillsPicker, list = new Set(state.draft[state.tab]), inherited = new Set(state.tab === "all" ? [] : state.draft.all);
  for (const skill of skillsShown(state)) if ((!source || skill.source === source) && !inherited.has(skill.name)) { if (mode === "all") list.add(skill.name); else list.delete(skill.name); }
  state.draft[state.tab] = [...list].sort(); state.note = ""; renderSkillsPicker("list");
}
async function saveSkillsPicker(reset) {
  const state = skillsPicker, id = projectId;
  if (!state || state.projectId !== id) throw new Error("Reload Settings before saving skills");
  const settings = await api({ action: "settings-snapshot", id });
  try { await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { skills: reset ? null : state.draft } }, reset ? "Skills reset to repository skills." : "Skills saved. New threads use them; running threads keep theirs."); }
  catch (error) { state.note = error.message; renderSkillsPicker(); throw error; }
  await loadSkillsPicker(true);
}
document.addEventListener("change", event => {
  const box = event.target.closest("[data-skill-pick]");
  if (!box || !skillsPicker) return;
  const list = new Set(skillsPicker.draft[skillsPicker.tab]);
  if (box.checked) list.add(box.dataset.skillPick); else list.delete(box.dataset.skillPick);
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
    const saved = settings.values.mcp ?? { all: [], coordinator: [], worker: [], scout: [], reviewer: [], writes: [] };
    mcpPicker = { projectId: id, catalog, isDefault: !settings.values.mcp, draft: sortedLists(saved), saved: JSON.stringify(sortedLists(saved)), tab: mcpPicker?.projectId === id ? mcpPicker.tab : "all", note: "", probes: {}, query: mcpPicker?.projectId === id ? mcpPicker.query : "" };
    renderMcpPicker();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">MCP unavailable: ${esc(error.message)}</p>`; }
}
const mcpShown = state => { const q = state.query.trim().toLowerCase(); return state.catalog.servers.filter(item => !q || item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)); };
function mcpListHtml(state) {
  const all = new Set(state.draft.all), picked = new Set(state.draft[state.tab]);
  const row = server => {
    const usable = server.status === "ready", inherited = state.tab !== "all" && all.has(server.name), probe = state.probes[server.name];
    return `<div class="skill-pick${inherited || !usable ? " inherited" : ""}"><input type="checkbox" data-mcp-pick="${esc(server.name)}" aria-label="Enable ${esc(server.name)}" ${inherited || picked.has(server.name) ? "checked" : ""} ${inherited || !usable ? "disabled" : ""}><span><b>${esc(server.name)}</b>${inherited ? ' <small class="skill-tag">all profiles</small>' : ""}${usable ? "" : ` <small class="skill-tag">${esc(mcpStatusText[server.status] ?? server.status)}</small>`}<small>${esc(server.description)}</small>${usable ? `<span class="mcp-actions"><label class="check"><input type="checkbox" data-mcp-writes="${esc(server.name)}" ${state.draft.writes.includes(server.name) ? "checked" : ""}> Allow writes <small>(tools that change things; off = read-only)</small></label><span class="row"><button type="button" class="ghost small" data-action="mcp-test" data-server="${esc(server.name)}">Test</button>${probe ? `<small class="${probe.ok ? "" : "bad"}">${esc(probe.ok ? `${probe.tools} tools` : probe.error)}</small>` : ""}</span></span>` : ""}</span></div>`;
  };
  const shown = mcpShown(state);
  return shown.map(row).join("") || `<p class="note">${state.catalog.servers.length ? "No server matches." : `No servers in ${esc(state.catalog.path)}.`}</p>`;
}
const mcpNote = state => (state.tab === "all" ? "Every profile gets these servers." : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} gets “All profiles” plus the servers checked here.`) + (state.query.trim() ? ` Select all and Clear apply to the ${mcpShown(state).length} shown.` : "");
function renderMcpPicker(part = "all") {
  const state = mcpPicker, node = document.querySelector("#mcp-picker");
  if (!state || state.projectId !== projectId) return;
  const servers = state.catalog.servers, known = new Set(servers.map(item => item.name));
  const count = role => new Set([...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter(name => known.has(name))).size;
  document.querySelector("#mcp-summary").textContent = `${servers.length} in mcp.json · ${count("all")} for every profile`;
  const dirty = JSON.stringify(state.draft) !== state.saved;
  if (part === "chrome" && node.querySelector(".skill-groups")) return patchPickerChrome(node, count, dirty);
  if (part === "list" && node.querySelector(".skill-groups")) { node.querySelector(".skill-groups").innerHTML = mcpListHtml(state); node.querySelector(".pick-note").innerHTML = mcpNote(state); return patchPickerChrome(node, count, dirty); }
  node.innerHTML = `${profileTabsHtml("mcp-tab", state.tab, count)}
    <p class="note pick-note">${mcpNote(state)}</p>
    ${servers.length ? `<div class="pick-tools"><input type="search" id="mcp-search" placeholder="Search ${servers.length} servers" value="${esc(state.query)}" aria-label="Search MCP servers">${bulkButtons("mcp-select")}</div>` : ""}
    <div class="skill-groups">${mcpListHtml(state)}</div>
    ${state.catalog.error ? `<p class="note bad">${esc(state.catalog.error)}</p>` : ""}${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row pick-actions"><button class="primary" data-action="mcp-save" ${dirty ? "" : "disabled data-off"}>Save MCP</button><button class="ghost" data-action="mcp-reset" ${state.isDefault ? "disabled data-off" : ""}>Remove all</button><small class="pick-state" ${dirty ? "" : "hidden"}>Unsaved changes</small></div>`;
}
/** Bulk enable or clear the usable servers currently shown (respecting search). Inherited rows stay as they are. */
function bulkMcp(mode) {
  const state = mcpPicker, list = new Set(state.draft[state.tab]), inherited = new Set(state.tab === "all" ? [] : state.draft.all);
  for (const server of mcpShown(state)) if (server.status === "ready" && !inherited.has(server.name)) { if (mode === "all") list.add(server.name); else list.delete(server.name); }
  state.draft[state.tab] = [...list].sort(); state.note = ""; renderMcpPicker("list");
}
async function saveMcpPicker(reset) {
  const state = mcpPicker, id = projectId;
  if (!state || state.projectId !== id) throw new Error("Reload Settings before saving MCP");
  const settings = await api({ action: "settings-snapshot", id });
  try { await mutate({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { mcp: reset ? null : state.draft } }, reset ? "MCP servers removed." : "MCP saved. Applies to the next tool call."); }
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
  const key = box.dataset.mcpPick !== undefined ? mcpPicker.tab : "writes", name = box.dataset.mcpPick ?? box.dataset.mcpWrites, list = new Set(mcpPicker.draft[key]);
  if (box.checked) list.add(name); else list.delete(name);
  mcpPicker.draft[key] = [...list].sort();
  mcpPicker.note = ""; renderMcpPicker("chrome");
});
document.addEventListener("input", event => {
  if (event.target.id !== "mcp-search" || !mcpPicker) return;
  mcpPicker.query = event.target.value; renderMcpPicker("list");
});

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
  const row = item => `<li class="wt-row${item.removable ? " removable" : ""}"><b class="mono">${esc(item.path.split("/").at(-1))}</b> <span class="note">${esc(item.kind === "read-head" ? "PR-head snapshot" : item.branch ?? "")}</span> <span>${esc(item.provider === "arc" ? "Arc virtual mount" : sizeText(item.sizeKb))}</span> ${item.pullRequests.map(pr => `<span class="wt-pr ${esc(pr.state)}">#${esc(pr.number)} ${esc(pr.state)}</span>`).join(" ")} ${setup(item)} <span class="${item.removable ? "good" : "note"}">${item.removable ? "can be removed" : esc(item.reasons.join("; "))}</span></li>`;
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
    <label class="field">Compact at (% of window) <input type="number" id="context-threshold" min="10" max="95" placeholder="${defaultPct ? `${defaultPct} (default)` : "default"}" value="${esc(v?.thresholdPercent ?? "")}"></label>
    <label class="field">Keep recent (tokens) <input type="number" id="context-keep" min="1000" max="1000000" step="1000" placeholder="20000 (default)" value="${esc(v?.keepRecentTokens ?? "")}"></label>
  </div>
  <div class="row"><button class="primary" data-action="context-save">Save</button><button class="ghost" data-action="context-reset" ${v ? "" : "disabled"}>Reset to defaults</button><button class="ghost" data-action="compact-now">Compact this chat now</button></div>`;
}
async function saveContextSettings(reset) {
  const id = projectId, number = selector => { const raw = document.querySelector(selector).value.trim(); if (!raw) return undefined; const value = Number(raw); if (!Number.isSafeInteger(value)) throw new Error("Context settings must be whole numbers"); return value; };
  const context = reset ? null : { autoCompact: document.querySelector("#context-auto").checked, ...Object.fromEntries([["contextWindow", number("#context-window")], ["thresholdPercent", number("#context-threshold")], ["keepRecentTokens", number("#context-keep")]].filter(([, value]) => value !== undefined)) };
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
      <label class="check"><input type="checkbox" id="watchdog-enabled" ${data.watchdog?.enabled !== false ? "checked" : ""}> While workers run, have the coordinator check them on a fixed interval</label>
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
function scheduleNotify() { clearTimeout(notifyTimer); notifyTimer = notifyEnabled() ? setTimeout(() => void pollNotify(), notifyCursor === undefined ? 0 : 3000) : null; }
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
  const github = kind === "github.follow" || kind === "arc.follow", hook = kind.startsWith("webhook.");
  if (kind === "worker.watchdog") { const workers = (body.match(/^- \w+ thread /gm) ?? []).length; return `<details class="report event-card watchdog" data-kind="worker.watchdog"${indexAttr(message)}><summary><span class="event-mark">⏱</span><b>Watchdog check</b><span class="report-task">${workers} running worker${workers === 1 ? "" : "s"}</span><small>${esc(when(message.at))}</small></summary><div class="report-body text"><pre class="mono">${esc(body)}</pre></div></details>`; }
  const changes = github ? (body.match(/^- /gm) ?? []).length : 0;
  const title = github ? (kind === "arc.follow" ? "Arcadia activity" : "GitHub activity") : hook ? `Webhook · ${kind.slice(8)}` : `Event · ${kind}`;
  // Webhook bodies follow a fixed preamble line; summarize the body itself.
  const summary = github ? `${changes} change${changes === 1 ? "" : "s"}${/auto-fix (dispatched|sent)/.test(body) ? " · auto-fix sent" : ""}` : clip((hook ? body.slice(body.indexOf("\n\n") + 2) : body).replace(/\s+/g, " ").trim(), 120);
  return `<details class="report event-card ${github ? "github" : hook ? "webhook" : "event"}" data-kind="${esc(kind)}"${indexAttr(message)}><summary><span class="event-mark">${github ? "PR" : hook ? "↯" : "•"}</span><b>${esc(title)}</b><span class="report-task">${esc(summary)}</span><small>${esc(when(message.at))}</small></summary><div class="report-body text">${renderMarkdown(body)}</div></details>`;
}
function indexAttr(message) { return Number.isInteger(message.index) ? ` data-index="${message.index}"` : ""; }
function chatMessageHtml(message, assistant) {
  if (message.kind === "tool" || message.role === "tool") return toolCallHtml(message);
  const thought = message.thinking ? `<p class="thought" title="${esc(thoughtText(message.thinking))}"><span class="thought-mark">Thought</span>${esc(thoughtText(message.thinking))}</p>` : "";
  if (!message.text?.trim()) return thought;
  const report = message.role === "user" && reportPattern.exec(message.text);
  if (report) return reportHtml(message, report);
  const event = message.role === "user" && /^\[Owner-local event ([\w.-]+)\]\n([\s\S]*)$/.exec(message.text);
  if (event) return eventHtml(message, event[1], event[2]);
  const label = message.role === "user" ? "You" : message.role === "assistant" ? assistant : message.role;
  // The host shows an invoked skill as `/skill:<name> args`; render the command as a chip.
  const skill = message.role === "user" && /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(message.text.trim());
  const attached = message.role === "user" ? attachmentChips(message.text) : { text: message.text, chips: "" };
  const prs = message.role === "user" ? prChips(attached.text) : { text: attached.text, chips: "" };
  const body = (skill ? `<span class="skill-chip" title="Skill /skill:${esc(skill[1])}">${skillIcon}${esc(skill[1])}</span>${skill[2] ? renderMarkdown(prChips(attachmentChips(skill[2]).text).text) : ""}` : renderMarkdown(prs.text)) + prs.chips + attached.chips;
  return `${thought}<article class="msg ${message.role === "user" ? "you" : "them"}"${indexAttr(message)}><div class="who">${esc(label)} <small class="inline">${esc(when(message.at))}</small></div><div class="text">${body}</div>${message.nextTextOffset != null ? `<p class="note">Text continues at character ${message.nextTextOffset}; use the next text slice.</p>` : ""}</article>`;
}
const skillIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>';
// "/" skill picker in the coordinator composer. The catalog loads once per project on first use.
let skillCatalog = null, skillMenu = null, prMenu = null;
async function loadSkills() {
  const id = projectId;
  if (skillCatalog?.projectId === id) return skillCatalog.skills;
  const { skills } = await api({ action: "coordinator-skills", id });
  if (id === projectId) skillCatalog = { projectId: id, skills };
  return skills;
}
function skillQuery(textarea) {
  const before = textarea.value.slice(0, textarea.selectionStart);
  return textarea.selectionStart === textarea.selectionEnd ? /^\/(?:skill:)?(\S*)$/.exec(before)?.[1] ?? null : null;
}
function rankSkills(skills, query) {
  const q = query.toLowerCase();
  if (!q) return skills;
  const score = skill => { const name = skill.name.toLowerCase(); return name.startsWith(q) ? 0 : name.includes(q) ? 1 : skill.description.toLowerCase().includes(q) ? 2 : 3; };
  return skills.map(skill => [score(skill), skill]).filter(([rank]) => rank < 3).sort((a, b) => a[0] - b[0]).map(([, skill]) => skill);
}
function closeSkillMenu() { skillMenu = null; prMenu = null; const node = document.querySelector("#skill-menu"); if (node) { node.hidden = true; node.innerHTML = ""; } document.querySelector("#compose textarea")?.removeAttribute("aria-activedescendant"); }
async function updateSkillMenu(textarea) {
  const query = skillQuery(textarea);
  if (query === null) { updatePrMenu(textarea); return; }
  const skills = await loadSkills();
  if (skillQuery(textarea) !== query) return;
  const items = rankSkills(skills, query).slice(0, 60);
  skillMenu = { items, index: Math.min(skillMenu?.query === query ? skillMenu.index : 0, Math.max(0, items.length - 1)), query };
  renderSkillMenu();
}
function renderSkillMenu() {
  const node = document.querySelector("#skill-menu");
  if (!node || !skillMenu) return;
  const source = { repo: "Repository", global: "Yours", package: "Package" };
  node.innerHTML = skillMenu.items.length
    ? skillMenu.items.map((skill, index) => `<button type="button" role="option" id="skill-option-${index}" class="skill-option${index === skillMenu.index ? " active" : ""}" aria-selected="${index === skillMenu.index}" data-action="skill-pick" data-name="${esc(skill.name)}"><span class="skill-name">/${esc(skill.name)}</span><span class="skill-desc">${esc(skill.description)}</span><span class="skill-source">${esc(source[skill.source] ?? skill.source)}</span></button>`).join("")
    : `<p class="skill-empty">No skill matches “${esc(skillMenu.query)}”</p>`;
  node.hidden = false;
  document.querySelector("#compose textarea").setAttribute("aria-activedescendant", skillMenu.items.length ? `skill-option-${skillMenu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
function pickSkill(name) {
  const textarea = document.querySelector("#compose textarea");
  const rest = textarea.value.slice(textarea.selectionStart).replace(/^\S*\s*/, "");
  textarea.value = `/skill:${name} ${rest}`;
  const caret = name.length + 8;
  textarea.setSelectionRange(caret, caret);
  drafts.set(draftKey(), textarea.value); autosize(textarea); persistDraftsSafely();
  closeSkillMenu(); textarea.focus();
}
// Arcadia PR card (Arc projects only) and the "#" PR menu. Rows come from the host's shared Arcanum cache; the browser asks at most every 20 s.
let arcPrs = { projectId: null, data: null, at: 0, error: "" }, arcPrsLoading = false, arcPrsShowHidden = false;
// Show/hide the hidden-PR list: local view state, not an action, so it works while busy.
document.addEventListener("click", event => { if (!event.target.closest("[data-pr-show-hidden]")) return; arcPrsShowHidden = !arcPrsShowHidden; renderArcPrs(); });
const arcPrNow = () => (arcPrs.projectId === projectId ? arcPrs.data : null);
async function loadArcPrs(force = false) {
  const id = projectId;
  if (!id || arcPrsLoading || (!force && arcPrs.projectId === id && Date.now() - arcPrs.at < 20000)) return;
  arcPrsLoading = true;
  try { const data = await api({ action: "arc-prs", id, ...(force ? { refresh: true } : {}) }); if (id === projectId) arcPrs = { projectId: id, data, at: Date.now(), error: "" }; }
  catch (error) { if (id === projectId) arcPrs = { projectId: id, data: arcPrs.projectId === id ? arcPrs.data : null, at: Date.now(), error: error.message }; }
  finally { arcPrsLoading = false; }
  if (id === projectId) renderArcPrs();
}
const prGlyph = { failing: ["✕", "bad", "Failing: a required check failed or there are conflicts"], running: ["●", "warn", "Required checks are running"], green: ["✓", "good", "Required checks passed"], none: ["○", "muted", "No checks yet"] };
function renderArcPrs() {
  const card = document.querySelector("#prs-card"), data = arcPrNow(), hint = document.querySelector("#compose-hint");
  hint.textContent = hint.textContent.replace(/ · # for PRs$/, "") + (data?.arc ? " · # for PRs" : "");
  card.hidden = !data?.arc;
  if (!data?.arc) return;
  // Hidden PRs leave the card and monitoring; "Show hidden" lists them dimmed with Unhide.
  const hidden = new Set(data.hidden ?? []), all = [...data.prs], hiddenPrs = all.filter(pr => hidden.has(pr.id));
  const order = { failing: 0, running: 1, green: 2, none: 3 }, prs = all.filter(pr => !hidden.has(pr.id)).sort((a, b) => order[a.state] - order[b.state] || b.id - a.id), shown = [...prs.slice(0, 12), ...(arcPrsShowHidden ? hiddenPrs : [])], watched = new Set(data.watched ?? []);
  const rows = shown.map(pr => {
    const isHidden = hidden.has(pr.id), hideButton = `<button type="button" class="ghost small pr-hide" data-action="pr-hide" data-pr="${pr.id}" data-hide="${!isHidden}" title="${isHidden ? "Show this PR on the card and monitor it again" : "Hide this PR from the card and stop monitoring it"}" aria-label="${isHidden ? `Unhide PR #${pr.id}` : `Hide PR #${pr.id}`}">${isHidden ? "Unhide" : "Hide"}</button>`;
    const [glyph, tone, title] = prGlyph[pr.state] ?? prGlyph.none, counts = [["good", "✓", pr.counts.ok], ["bad", "✕", pr.counts.failed], ["warn", "●", pr.counts.running]].filter(([, , n]) => n).map(([cls, mark, n]) => `<span class="${cls}">${mark}${n}</span>`).join(" ");
    const detail = [counts, pr.conflicts ? '<span class="bad">conflicts</span>' : "", pr.mergeFailed ? '<span class="bad">merge failed</span>' : pr.autoMerge ? '<span class="good">auto-merge</span>' : "", pr.failedChecks.length ? `<span class="pr-fails">${esc(pr.failedChecks.slice(0, 2).join(", "))}${pr.failedChecks.length > 2 ? ` +${pr.failedChecks.length - 2}` : ""}</span>` : `<span class="pr-branch">${esc(pr.branch.replace(/^users\/[^/]+\//, ""))}</span>`].filter(Boolean).join(" ");
    return `<div class="pr-row ${esc(pr.state)}${isHidden ? " hidden-pr" : ""}"><span class="pr-icon ${tone}" title="${esc(title)}" role="img" aria-label="${esc(title)}">${glyph}</span><div class="pr-main"><a class="pr-title" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" title="${esc(pr.summary)}"><span class="pr-id">#${pr.id}</span> ${esc(pr.summary)}</a><small class="pr-sub">${detail}</small></div><span class="pr-actions">${isHidden ? "" : `<button type="button" class="ghost small pr-watch${watched.has(pr.id) ? " on" : ""}" data-action="pr-watch" data-pr="${pr.id}" aria-pressed="${watched.has(pr.id)}" title="${watched.has(pr.id) ? "Watching: the coordinator is told when a check or merge fails. Click to stop." : "Watch: tell the coordinator when a check or merge fails"}">${watched.has(pr.id) ? "Watching" : "Watch"}</button>`}${hideButton}</span></div>`;
  }).join("");
  const meta = data.rateLimitedUntilMs ? "rate limited" : data.fetchedAtMs ? ago(new Date(data.fetchedAtMs).toISOString()) : "";
  const problem = arcPrs.error || data.error;
  setHtml("#prs", `${problem ? `<p class="note pr-error">${esc(problem)}${prs.length ? " (showing the last list)" : ""}</p>` : ""}${rows || (problem ? "" : '<p class="note">No open PRs.</p>')}${prs.length > 12 ? `<p class="note">+${prs.length - 12} more in Arcanum</p>` : ""}${hiddenPrs.length ? `<button type="button" class="ghost small pr-show-hidden" data-pr-show-hidden aria-expanded="${arcPrsShowHidden}">${arcPrsShowHidden ? "Hide" : "Show"} ${hiddenPrs.length} hidden</button>` : ""}${data.monitoring ? "" : '<p class="note pr-off">Monitoring is off. Turn on Follow PRs in Settings to hear about failing checks.</p>'}`);
  document.querySelector("#prs-meta").textContent = meta;
}
const prRefs = /(?:^|\s)#([^\s#]*)$/;
function updatePrMenu(textarea) {
  const query = textarea.selectionStart === textarea.selectionEnd ? prRefs.exec(textarea.value.slice(0, textarea.selectionStart))?.[1] ?? null : null, data = arcPrNow();
  if (query === null || !data?.arc || !data.prs.length) { closeSkillMenu(); return; }
  const q = query.toLowerCase(), items = [...data.prs].sort((a, b) => b.id - a.id).filter(pr => !q || String(pr.id).startsWith(q) || pr.summary.toLowerCase().includes(q)).slice(0, 30);
  skillMenu = null; prMenu = { items, index: Math.min(prMenu?.query === query ? prMenu.index : 0, Math.max(0, items.length - 1)), query };
  renderPrMenu();
}
function renderPrMenu() {
  const node = document.querySelector("#skill-menu");
  node.innerHTML = prMenu.items.length
    ? prMenu.items.map((pr, index) => `<button type="button" role="option" id="skill-option-${index}" class="skill-option pr-opt${index === prMenu.index ? " active" : ""}" aria-selected="${index === prMenu.index}" data-action="pr-pick" data-pr="${pr.id}"><span class="skill-name">#${pr.id}</span><span class="skill-desc">${esc(pr.summary)}</span><span class="skill-source pr-icon ${prGlyph[pr.state]?.[1] ?? "muted"}">${prGlyph[pr.state]?.[0] ?? "○"}</span></button>`).join("")
    : `<p class="skill-empty">No open PR matches “${esc(prMenu.query)}”</p>`;
  node.hidden = false;
  document.querySelector("#compose textarea").setAttribute("aria-activedescendant", prMenu.items.length ? `skill-option-${prMenu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
function pickPr(id) {
  const textarea = document.querySelector("#compose textarea"), caret = textarea.selectionStart;
  const before = textarea.value.slice(0, caret).replace(/(?:PR\s+)?#[^\s#]*$/, `PR #${id} `);
  textarea.value = before + textarea.value.slice(caret);
  textarea.setSelectionRange(before.length, before.length);
  drafts.set(draftKey(), textarea.value); autosize(textarea); persistDraftsSafely();
  closeSkillMenu(); textarea.focus();
}
// The host appends a "[Referenced Arcadia PRs …]" block to the coordinator message; show it as chips.
const prBlock = /\n\n\[Referenced Arcadia PRs[^\]\n]*\]\n((?:- [^\n]*(?:\n|$))+)$/;
function prChips(text) {
  const match = prBlock.exec(text);
  if (!match) return { text, chips: "" };
  const chips = match[1].trim().split("\n").map(line => {
    const known = /^- #(\d+)(?: “(.*?)”)? \((.*?)\)/.exec(line), gone = /^- #(\d+): could not be read/.exec(line);
    return known ? `<a class="attach-chip pr-chip" href="https://a.yandex-team.ru/review/${known[1]}" target="_blank" rel="noopener noreferrer" title="${esc(`${known[2] ?? ""} (${known[3]})`)}"><span class="pr-id">#${known[1]}</span><span class="attach-name">${esc(known[2] ?? "")}</span></a>` : gone ? `<span class="attach-chip gone">#${gone[1]} unreadable</span>` : "";
  }).join("");
  return { text: text.slice(0, match.index), chips: `<div class="attach-row">${chips}</div>` };
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
  return [...out, ...rest.map(answeredCard)].join("");
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
function setHtml(selector, text) { const node = document.querySelector(selector); if (html.get(selector) === text || node.contains(document.activeElement)) return; node.innerHTML = text; html.set(selector, text); }
function admissionBlocked() { return !view || view.paused || view.project.archived || view.project.deleted || Boolean(currentChat()?.archived); }
function disableActions() {
  document.querySelectorAll('#letter button, #letter textarea, #questions textarea, .panel button').forEach(node => { node.disabled = busy || !view || node.hasAttribute('data-off'); }); // data-off: a picker button that is idle-disabled (nothing to save), not just busy
  document.querySelectorAll('#compose button, #compose textarea').forEach(node => { node.disabled = busy || admissionBlocked(); });
  document.querySelectorAll('#dialog button[type="submit"], #dialog [data-action="confirm-pause"], #dialog [data-action="confirm-resume"], #create').forEach(node => { node.disabled = busy || node.hasAttribute('data-off'); });
  document.querySelectorAll('[data-action="operation-decision"], [data-action="operation-execute"], [data-action="operation-inspect"]').forEach(node => {
    const record = operationCache.get(node.dataset.operation);
    node.disabled = busy || !view || view.project.archived || view.project.deleted || !record?.scopeCurrent;
  });
  document.querySelectorAll('#dialog [data-thread-mutation], #inline-thread [data-thread-mutation], [data-inline-thread-send] button, [data-inline-thread-send] textarea').forEach(node => { node.disabled = busy || admissionBlocked(); });
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
  constructor(error, frame) { super(error instanceof Error ? error.message : String(error)); this.frame = frame; }
}
async function api(input) {
  const frame = uiFrame();
  try {
    if (!token) throw new Error("Open the inbox with /projects-ui or npm run inbox to authenticate this tab.");
    const response = await fetch("/api", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) });
    const reply = await response.json();
    if (!response.ok || reply?.ok !== true) throw new Error(typeof reply?.error === "string" ? reply.error : `Host returned ${response.status}`);
    return reply.data;
  } catch (error) { throw new UiRequestError(error, frame); }
}
async function uiAction(action) {
  const frame = uiFrame();
  try { await action(); } catch (error) { report(error, error instanceof UiRequestError ? error.frame : frame); }
}

async function mutate(input, success) {
  if (busy) throw new Error("Another action is still pending. Your draft was kept.");
  busy = true; disableActions();
  try { const result = await api(input); toast(success); if (input.id === projectId) { if (document.querySelector("#letter").contains(document.activeElement) || document.querySelector("#questions").contains(document.activeElement)) document.activeElement.blur(); await refresh(); } return result; }
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
function renderMarkdown(value) {
  const blocks = String(value ?? "").split(/```([^\n]*)\n([\s\S]*?)```/g);
  return blocks.map((part, index) => {
    if (index % 3 === 1) return "";
    if (index % 3 === 2) return blocks[index - 1].trim() === "diff" ? `<pre class="diff"><code>${part.split("\n").map(line => `<span class="${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}">${esc(line)}</span>`).join("\n")}</code></pre>` : `<pre><code>${esc(part)}</code></pre>`;
    const lines = part.split("\n"), out = [];
    let list = null, quote = [];
    const flushList = () => { if (list) { out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.tag}>`); list = null; } };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`); quote = []; } };
    for (const line of lines) {
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
// Artifact references become <img>/<video>/download links. Bytes are fetched once per page (token header, so no plain URLs) and cached as blob URLs.
const artifactBlobs = new Map();
const artifactKindOf = path => /\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : /\.(webm|mp4)$/i.test(path) ? "video" : "other";
function artifactBlob(project, thread, path) {
  const key = `${project}/${thread}/${path}`;
  if (!artifactBlobs.has(key)) {
    if (artifactBlobs.size >= 300) { const [oldest, value] = artifactBlobs.entries().next().value; artifactBlobs.delete(oldest); void value.then(url => URL.revokeObjectURL(url), () => {}); }
    artifactBlobs.set(key, fetch(`/artifacts/${project}/${thread}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) }).then(async response => { if (!response.ok) throw new Error(response.status === 404 ? "missing" : `unavailable (${response.status})`); return URL.createObjectURL(await response.blob()); }));
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
document.addEventListener("click", event => {
  const link = event.target.closest?.(".artifact-ref[data-state=link] .artifact-link");
  if (!link) return;
  event.preventDefault();
  const node = link.closest(".artifact-ref"), path = node.dataset.artifactPath;
  artifactBlob(projectId, node.dataset.artifactThread, path).then(url => { const a = document.createElement("a"); a.href = url; a.download = path.split("/").at(-1); a.click(); }, error => { node.dataset.state = "missing"; node.innerHTML = `<span class="artifact-missing">${esc(node.textContent)} (${esc(error.message === "missing" ? "missing artifact" : error.message)})</span>`; });
});
document.addEventListener("toggle", event => { if (event.target.open) hydrateArtifacts(event.target); }, true);
// Activity thread pane: the thread's artifacts folder, newest first, images and videos inline.
async function loadWorkerArtifacts(chat) {
  const node = document.querySelector("#worker-artifacts");
  if (!node || Date.now() - (chat.artifactsAt ?? 0) < 4000) return;
  chat.artifactsAt = Date.now();
  const listing = await api({ action: "artifacts-list", id: chat.id, threadId: chat.threadId }).catch(error => ({ error: error.message }));
  if (workerChat !== chat || !document.querySelector("#worker-artifacts")) return;
  const files = (listing.files ?? []).toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  const html = listing.error ? `<p class="note">Artifacts unavailable: ${esc(listing.error)}</p>` : !files.length ? "" : `<details class="artifacts-box" open><summary><b>Artifacts</b> <small class="inline">${files.length} file(s) · ${esc(size(listing.totalBytes))}${listing.overCap ? ` · over the ${esc(size(listing.capBytes))} cap` : ""}${listing.skipped?.length ? ` · ${listing.skipped.length} skipped (symlinks)` : ""}</small></summary><div class="artifact-grid">${files.slice(0, 60).map(file => `<figure class="artifact-item ${esc(file.kind)}"><span class="artifact-ref" data-artifact-thread="${esc(chat.threadId)}" data-artifact-path="${esc(file.path)}" data-inline="${file.kind === "image" || file.kind === "video" ? "1" : ""}">${esc(file.path.split("/").at(-1))}</span><figcaption class="mono" title="${esc(file.ref)}">${esc(file.path)} · ${esc(size(file.size))}</figcaption></figure>`).join("")}</div></details>`;
  if (node.dataset.content !== html) { node.innerHTML = html; node.dataset.content = html; }
}
function inlineMarkdown(value) {
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
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (all, label, escapedHref) => {
    const href = escapedHref.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    try { const url = new URL(href); return ["http:", "https:", "mailto:"].includes(url.protocol) ? `<a href="${esc(url.href)}" rel="noopener noreferrer" target="_blank">${label}</a>` : label; } catch { return label; }
  });
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
    case "questions-jump": document.querySelector("#questions").scrollIntoView({ block: "center", behavior: "smooth" }); document.querySelector("#questions .question-card textarea")?.focus({ preventScroll: true }); break;
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
    case "chat-select": changeChat(node.dataset.chat); break;
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
    case "all-work": setTab("activity"); break;
    case "jump-latest": searchFocus = null; stickToBottom = true; followTranscript(); renderWorkingPill(); break;
    case "skill-pick": pickSkill(node.dataset.name); break;
    case "pr-pick": pickPr(node.dataset.pr); break;
    case "prs-refresh": await loadArcPrs(true); break;
    case "pr-hide": { await api({ action: "arc-pr-hide", id: projectId, pr: Number(node.dataset.pr), hide: node.dataset.hide === "true" }); arcPrs.at = 0; await loadArcPrs(); break; }
    case "pr-watch": { const on = node.getAttribute("aria-pressed") !== "true"; await api({ action: "arc-pr-watch", id: projectId, pr: Number(node.dataset.pr), watch: on }); arcPrs.at = 0; await loadArcPrs(); break; }
    case "thread-close": workerChat = null; document.querySelector("#inline-thread").hidden = true; document.querySelector("#thread-empty").hidden = false; dialogVersion++; render(); break;
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
    case "automation-save": await saveEventsIn(); break;
    case "worktree-setup-save": await saveWorktreeSetup(); break;
    case "worktrees-cleanup": await cleanupWorktreesNow(); break;
    case "worktrees-refresh": await loadWorktrees(true); break;
    case "context-save": await saveContextSettings(false); break;
    case "context-reset": await saveContextSettings(true); break;
    case "compact-now": await compactNow(); break;
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
    case "arc-quick": await arcQuickDialog(); break;
    case "arc-quick-confirm": await arcQuickConfirm(node.dataset.project, node.dataset.revision); break;
    case "github-quick": await githubQuickDialog(); break;
    case "github-quick-confirm": await githubQuickConfirm(node.dataset.project, node.dataset.revision); break;
    case "owner-setup-edit": await ownerSetupEdit(node.dataset.kind, node.dataset.payload || "{}"); break;
    case "owner-profile-read": await ownerProfileRead(node.dataset.project, node.dataset.profile); break;
    case "settings-back": await settingsList(true); break;
    case "mp-toggle": { const mp = node.closest(".mp"); if (mp.classList.contains("open")) mpClose(mp, true); else mpOpen(mp); break; }
    case "mp-pick": mpPick(node.closest(".mp"), node.dataset.ref); break;
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
    case "thread": requireProject(node.dataset.project); await inspectThread(node.dataset.thread); break;
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
    case "conversation": document.querySelector(".conversation").open = true; document.querySelector(".conversation").scrollIntoView({ block: "start", behavior: "smooth" }); document.querySelector(".conversation summary").focus(); break;
    case "close-dialog": closeDialog(); break;
    case "search": openSearch(); break;
    case "search-open": await openSearchHit(Number(node.dataset.i)); break;
  }
}

async function submit(form) {
  if (form.id === "compose" && (busy || admissionBlocked())) throw new Error("This project cannot accept a request now. Your draft was kept.");
  const data = new FormData(form);
  const id = projectId, version = dialogVersion;
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
      if (field === "models" ? Object.entries(changed).some(([role, reference]) => result.values.models[role] !== reference) : result.values[field] !== changed) throw new Error("Settings receipt differs from the proposed change; retain drafts and inspect");
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
    if (!mergeExecutionAvailable(record) || data.get("confirm") !== target) throw new Error("Exact executable merge approval and project confirmation are required");
    if (!["execute", "inspect"].includes(form.dataset.mode)) throw new Error("Unknown bound merge control");
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
document.addEventListener("submit", event => { if (!event.target.matches("#compose, [data-chat-rename], [data-answer], [data-answer-adopt], [data-task-message], [data-resume-project], [data-operation-decision], [data-operation-execute], [data-inline-thread-send], [data-knowledge-path], [data-knowledge-write], [data-upload-edit], [data-upload-confirm], [data-settings-form], [data-settings-confirm], [data-routine-change], [data-lifecycle-change], [data-open-retained], [data-provider-known], [data-provider-inspect], [data-create]")) return; event.preventDefault(); void uiAction(() => submit(event.target)); });
function autosize(textarea) { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 220)}px`; }
document.addEventListener("change", event => { if (event.target.closest("[data-settings-form]")) settingsSync(); });
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
document.addEventListener("mousedown", event => { if (event.target.closest(".skill-option")) event.preventDefault(); else if ((skillMenu || prMenu) && !event.target.closest("#compose")) closeSkillMenu(); });
document.addEventListener("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && event.target.closest("#compose textarea")) void updateSkillMenu(event.target).catch(() => closeSkillMenu()); });
document.querySelector("#projects").addEventListener("change", event => changeProject(event.target.value));
document.querySelector("#transcript").addEventListener("scroll", event => { const node = event.currentTarget; stickToBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40; renderWorkingPill(); }, { passive: true });
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
  if (event.target.id === "search-input" && !event.isComposing) {
    const count = searchState.results.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) { event.preventDefault(); searchState.active = (searchState.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderSearchResults(); }
    else if (event.key === "Enter") { event.preventDefault(); clearTimeout(searchTimer); if (searchState.query === event.target.value.trim() && count) void uiAction(() => openSearchHit(searchState.active)); else void runSearch(); }
    return;
  }
  if (prMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = prMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) { prMenu.index = (prMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderPrMenu(); } return; }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab") && count) { event.preventDefault(); pickPr(prMenu.items[prMenu.index].id); return; }
    if (event.key === "Escape") { event.preventDefault(); closeSkillMenu(); return; }
  }
  if (skillMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = skillMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) { skillMenu.index = (skillMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderSkillMenu(); } return; }
    if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab") && count) { event.preventDefault(); pickSkill(skillMenu.items[skillMenu.index].name); return; }
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
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
function providerBinding(scopeId, repositoryId) {
  if (!view || view.project.archived || view.project.deleted) throw new Error("Restore the retained project before provider inspection");
  const p = view.project, scope = p.workspaceAuthorization?.scopes.find(scope => scope.id === scopeId), grant = p.githubAuthorization?.find(grant => grant.repositoryId === scope?.repositoryId);
  if (p.workspaceAuthorization?.provider !== "github" || !scope || !grant || repositoryId !== undefined && grant.repositoryId !== repositoryId || !Number.isSafeInteger(grant.numericId)) throw new Error("Receipt has no matching current GitHub scope/repository grant. Arc remains deferred; retained metadata stays readable");
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
  setDialogBody(`<div class="seg-row">${segTabs([["Reads: PRs, CI, reviews", { action: "provider-list", kind: "reads", offset: 0 }, kind === "reads"], ["Changes sent to GitHub", { action: "provider-list", kind: "writes", offset: 0 }, kind === "writes"]])}${pager({ offset, count: page.items.length, total: page.total, size: 100, data: { action: "provider-list", kind } })}</div>${rows.join("") || `<p class="empty-state">Nothing recorded yet. An empty list does not prove that no remote work happened.</p>`}<p class="note">Records are snapshots from when the worker acted. Only GitHub is covered, not Arcadia.</p>${dlgActions(dlgBtn("Check a specific PR…", { action: "provider-known" }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
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
  if (!plan || view.project.workspaceAuthorization?.provider !== "github" || view.project.archived || view.project.deleted) throw new Error("A current active GitHub scope is required. Arc remains deferred");
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
  setDialogBody(`${policy.paused || policy.pausing || schedules.automaticAdmissionBlocker ? `<p class="note-box warn">${policy.paused || policy.pausing ? "The project is paused, so nothing starts automatically. " : ""}${schedules.automaticAdmissionBlocker ? `Automatic runs are blocked until you check an earlier uncertain ${schedules.automaticAdmissionBlocker === "uncertain-command" ? "command" : "GitHub change"}.` : ""}</p>` : ""}<div class="choice-card"><div><b>Outside events ${stateChip(schedules.eventOptIn ? "On" : "Off", schedules.eventOptIn ? "on" : "")}</b><p>Lets events from GitHub or webhooks start work in this project.</p></div>${toggle(schedules.eventOptIn ? "Turn off…" : "Turn on…", schedules.eventOptIn, "", "events")}</div><div class="seg-row mt">${tabs}${pager({ offset, count: page.length, total: records.length, size: 100, data: { action: "routine-list", project: id, lens } })}</div>${rows}<p class="note">Routines run only while your Mac is awake, and only if they are on. Arcadia monitoring is not available. This list is a sample read, not an atomic snapshot.</p>${dlgActions(dlgBtn("Refresh", { action: "routine-list", project: id, lens, offset }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`);
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
  if (!value || !/^[a-f0-9]{64}$/.test(value.revision) || !v || [v.name, v.objective, v.model, v.models?.worker, v.models?.scout, v.models?.reviewer].some(text => typeof text !== "string") || !["read-only", "maintain"].includes(v.knowledgeAccess) || !["none", "coordinator"].includes(v.libraryAccess) || !["none", "coordinator"].includes(v.decisionAccess) || !Number.isSafeInteger(v.workerCap) || v.workerCap < 1 || v.workerCap > 32) throw new Error("Invalid settings snapshot/receipt");
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
  const arcCard = !whole ? "" : snapshot.arc ? `<div class="card"><b>✓ Arcadia connected</b><p class="note">Workers push users/${esc(snapshot.arc.login)}/ branches and open draft PRs against ${esc(snapshot.arc.baseBranch)}. You approve merges.</p></div>` : snapshot.arcQuick?.available ? `<div class="card"><b>Arcadia</b><p class="note">Workers cannot open draft PRs yet.</p><button class="primary" data-action="arc-quick">Connect Arcadia</button></div>` : `<div class="card"><b>Arcadia</b><p class="note">${esc(snapshot.arcQuick?.blocker || "One-click Arcadia is unavailable")}</p></div>`;
  const githubCard = !whole ? "" : snapshot.workspace?.provider === "arc" ? arcCard : connected ? `<div class="card"><b>✓ GitHub connected</b><p class="note">Workers push ${esc(connected.branchPrefix)} branches to ${esc(connected.repositoryId)} and open draft PRs against ${esc(connected.baseBranch)}. You approve merges.</p></div>` : snapshot.githubQuick?.available ? `<div class="card"><b>GitHub</b><p class="note">Workers cannot open draft PRs yet.</p><button class="primary" data-action="github-quick">Connect GitHub</button></div>` : `<div class="card"><b>GitHub</b><p class="note">${esc(snapshot.githubQuick?.blocker || "One-click GitHub is unavailable")}</p></div>`;
  const quick = whole ? `<div class="card"><b>✓ Workers can edit this repository</b><p class="note">${esc(whole.repositoryId)} · new worker threads start from ${snapshot.workspace?.provider === "arc" ? "trunk (arc-wt worktrees)" : "current HEAD"}.</p></div>${githubCard}` : snapshot.quickGrant?.available ? `<div class="card"><b>Workspace</b><p class="note">Workers cannot edit code yet.</p><button class="primary" data-action="workspace-quick">Let workers edit this repo</button></div>` : `<div class="card"><b>Workspace</b><p class="note">${esc(snapshot.quickGrant?.blocker || "One-click access is unavailable")}</p></div>`;
  setDialogBody(`${result ? `<p class="note-box ok">Change recorded. No command was run.</p>${rawDetails(result, "Host response")}` : ""}<div class="choice-list">${quick}</div><details class="advanced"><summary>Advanced: folder scopes, GitHub targets, command profiles</summary>${hist}<h3>Look up a GitHub repository</h3><form data-owner-github-inspect data-project="${esc(id)}" class="row"><label class="grow"><span class="sr-only">Repository, owner/name</span><input name="repositoryId" placeholder="owner/repository" aria-label="Repository, owner/name" required></label><button type="submit" class="small">Look up</button></form><p class="note">Reads its numeric ID and default branch. It must match the checkout's GitHub origin.</p><h3>Add or change</h3><div class="row">${actions}</div><h3>Folder scopes</h3>${workspaces}<h3>GitHub authorizations</h3>${github}<h3>Command profiles</h3>${profiles}</details>${dlgActions(dlgBtn("Refresh", { action: "owner-setup" }), dlgBtn("Done", { action: "close-dialog" }, "primary"))}`);
}

async function workspaceQuickDialog() {
  const id = projectId, generationAtOpen = generation, version = showDialog("Let workers edit this repo", '<p class="note">Reading the project checkout…</p>', "Workers get their own copy of your checkout. Your files are never written.");
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const quick = snapshot.quickGrant;
  if (!quick?.available) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(quick?.blocker || "One-click access is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`; return; }
  const arc = quick.provider === "arc";
  dialog.querySelector(".dialog-body").innerHTML = `<div class="kv"><span>Repository</span><b>${esc(quick.repositoryId)}</b><span>${arc ? "Arc checkout" : "Checkout"}</span><b class="mono">${esc(quick.ownerCheckout)}</b>${arc && quick.subpath ? `<span>Project folder</span><b class="mono">${esc(quick.subpath)}</b>` : ""}<span>Worker copies</span><b class="mono">${esc(quick.approvedRoot)}</b><span>${arc ? "Trunk head" : "Current HEAD"}</span><b class="mono">${esc(quick.head.slice(0, 12))}</b></div>
${arc ? `<ul><li>Each worker gets its own arc-wt worktree of the Arc checkout, leased to this project and starting from trunk, not from your current branch.</li><li>Workers may read, edit and create any file except VCS metadata. Work happens in the project folder (${esc(quick.subpath || ".")}) of the worktree; your mount is never written.</li><li>Workers may run repository commands in their isolated worktree. Draft PRs need Arcadia (step 2); merges always need your approval.</li></ul>` : `<ul><li>Each worker gets its own git worktree, starting from HEAD at the time it starts.</li><li>Workers may read, edit and create any file except VCS metadata (.git). Your checkout is never written.</li><li>Workers may run repository commands in their isolated worktree. Draft PRs need GitHub (step 2); merges always need your approval.</li></ul>`}${quick.dirty ? `<p class="notice">Your checkout has uncommitted changes. Workers ${arc ? "start from trunk and" : "will"} not see them.</p>` : ""}
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Allow workers to edit", { action: "workspace-quick-confirm", project: id, revision: snapshot.workspaceRevision }, "primary"))}`;
}

async function workspaceQuickConfirm(target, revision) {
  requireProject(target);
  await mutate({ action: "workspace-quick-grant", id: target, confirm: target, expectedRevision: revision }, "Workers can now edit this repository.");
  if (projectId === target && dialog.open) await ownerSetupDialog();
}
async function arcQuickDialog() {
  const id = projectId, generationAtOpen = generation, version = showDialog("Connect Arcadia", '<p class="note">Reading the Arc checkout…</p>', "Let workers push branches and open draft pull requests.");
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const quick = snapshot.arcQuick;
  if (!quick?.available) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(quick?.blocker || "One-click Arcadia is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`; return; }
  dialog.querySelector(".dialog-body").innerHTML = `<div class="kv"><span>Repository</span><b>${esc(quick.repositoryId)}</b><span>Login</span><b class="mono">${esc(quick.login)}</b><span>Draft PRs target</span><b class="mono">${esc(quick.baseBranch)}</b><span>Worker branches</span><b class="mono">users/${esc(quick.login)}/…</b></div>
<ul><li>Each worker commits and pushes only its own branch (arc adds the users/${esc(quick.login)}/ namespace).</li><li>The host checks the pushed branch against the worker's HEAD, then opens a draft PR against ${esc(quick.baseBranch)} and links the Tracker ticket named in the task.</li><li>Ticket statuses are never changed. Merges always need your approval.</li></ul>
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Connect Arcadia", { action: "arc-quick-confirm", project: id, revision: snapshot.arcRevision }, "primary"))}`;
}
async function arcQuickConfirm(target, revision) {
  requireProject(target);
  await mutate({ action: "arc-quick-authorize", id: target, confirm: target, expectedRevision: revision }, "Arcadia connected. Workers can open draft PRs.");
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
const settingsRoles = [["coordinator", "Coordinator", "Plans the work and talks to you."], ["worker", "Worker", "Writes code in its own worktree."], ["scout", "Scout", "Reads the repository and reports back."], ["reviewer", "Reviewer", "Checks changes and pull requests."]];
const settingsAccess = {
  knowledgeAccess: ["Workers and project knowledge", "The coordinator always keeps the knowledge notes up to date.", [["read-only", "Workers can read it"], ["maintain", "Workers can read and update it"]]],
  libraryAccess: ["Uploaded files and evidence", "Whether the coordinator may open the project library.", [["none", "Coordinator cannot open them"], ["coordinator", "Coordinator can open them"]]],
  decisionAccess: ["Questions for you", "Whether the coordinator may ask you to decide something.", [["none", "Coordinator cannot ask"], ["coordinator", "Coordinator can ask"]]],
};
let settingsPending = null, modelScoped = [], modelExtensionErrors = [];
const flatSettings = values => ({ name: values.name, objective: values.objective, coordinator: values.model, worker: values.models.worker, scout: values.models.scout, reviewer: values.models.reviewer, knowledgeAccess: values.knowledgeAccess, libraryAccess: values.libraryAccess, decisionAccess: values.decisionAccess, workerCap: String(values.workerCap) });
function settingsFormValues(form) {
  const flat = { name: form.elements.name.value, objective: form.elements.objective.value, workerCap: form.elements.workerCap.value };
  for (const field of Object.keys(settingsAccess)) flat[field] = form.elements[field].value;
  for (const [role] of settingsRoles) flat[role] = form.querySelector(`.mp[data-role="${role}"]`).dataset.value;
  return flat;
}
function settingsChanges(flat, values) {
  const was = flatSettings(values), changes = {};
  for (const field of ["name", "objective", "knowledgeAccess", "libraryAccess", "decisionAccess"]) if (flat[field] !== was[field]) changes[field] = flat[field];
  if (flat.workerCap !== was.workerCap) changes.workerCap = Number(flat.workerCap);
  if (flat.coordinator !== was.coordinator) changes.model = flat.coordinator;
  for (const role of ["worker", "scout", "reviewer"]) if (flat[role] !== was[role]) (changes.models ??= {})[role] = flat[role];
  return changes;
}
function validateSettingsChanges(changes) {
  if ("name" in changes && (!changes.name.trim() || !editableKnowledge(changes.name)) || "objective" in changes && !editableKnowledge(changes.objective)) throw new Error("The name cannot be empty, and name and objective cannot contain control characters. Your edits are kept.");
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
  const roleField = ([role, label, help]) => `<div class="field" data-field="${role}"><span class="flabel">${label} model</span><span class="fhelp">${help}</span>${modelPickerHtml(role, shown[role], pickerError)}</div>`;
  const accessField = ([field, [label, help, options]]) => `<div class="field" data-field="${field}"><label><span class="flabel">${label}</span><select name="${field}">${options.map(([option, text]) => `<option value="${option}"${shown[field] === option ? " selected" : ""}>${text}</option>`).join("")}</select></label><span class="fhelp">${help}</span></div>`;
  setDialogBody(`<form data-settings-form data-project="${esc(id)}" novalidate>
<div class="field" data-field="name"><label><span class="flabel">Project name</span><input name="name" maxlength="120" autocomplete="off" value="${esc(shown.name)}"></label>${draftNote("name")}</div>
<div class="field" data-field="objective"><label><span class="flabel">Objective</span><span class="fhelp">What this project is for. The coordinator reads it in every new conversation.</span><textarea name="objective" rows="5" maxlength="32000">${esc(shown.objective)}</textarea></label>${draftNote("objective")}</div>
<h3>Models</h3><p class="note">New threads use these. Threads that are already running keep the model they started with.${pickerError ? ` The model list is unavailable (${esc(pickerError)}).` : " Scoped models come from your Pi settings; search finds every configured model."}</p>
<div class="field-grid">${settingsRoles.map(roleField).join("")}</div>
<h3>Access and limits</h3>
<div class="field-grid">${Object.entries(settingsAccess).map(accessField).join("")}<div class="field" data-field="workerCap"><label><span class="flabel">Workers at once</span><input name="workerCap" type="number" min="1" max="32" step="1" value="${esc(shown.workerCap)}"></label><span class="fhelp">How many workers may run in parallel (1–32).</span></div></div>
<p class="note">Saving needs an idle project. You review every change before it is saved.</p>
${dlgActions('<span class="hint" role="status"></span>', dlgBtn("Cancel", { action: "close-dialog" }), '<button type="submit" class="primary" data-off disabled>Review changes</button>')}</form>`);
  settingsSync();
}
const accessText = (field, value) => settingsAccess[field][2].find(([option]) => option === value)?.[1] ?? value;
const modelText = ref => { const model = modelCache.get(ref); return model ? `${esc(model.name)}<small class="mono">${esc(ref)}</small>` : esc(ref); };
const emptyText = text => text ? esc(text) : "<small>empty</small>";
function settingsDiffRows(changes, values) {
  const rows = [];
  if ("name" in changes) rows.push(["Project name", emptyText(values.name), emptyText(changes.name)]);
  if ("objective" in changes) rows.push(["Objective", emptyText(values.objective), emptyText(changes.objective)]);
  if ("model" in changes) rows.push(["Coordinator model", modelText(values.model), modelText(changes.model)]);
  for (const [role, label] of settingsRoles.slice(1)) if (changes.models?.[role]) rows.push([`${label} model`, modelText(values.models[role]), modelText(changes.models[role])]);
  for (const field of Object.keys(settingsAccess)) if (field in changes) rows.push([settingsAccess[field][0], esc(accessText(field, values[field])), esc(accessText(field, changes[field]))]);
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
  showDialog("Save these changes?", `<div class="diff-list">${rows.map(diffItem).join("")}</div>${stale ? '<p class="note-box warn">One edit was started on an older version of these settings. If they changed since, the host rejects the save and your edit is kept.</p>' : ""}<p class="note">Applies to new threads. Running threads keep their model and instructions. The project must be idle. No model request, command, publication or merge happens here.</p><form data-settings-confirm data-project="${esc(projectId)}" data-revision="${esc(revision)}"><input type="hidden" name="confirm" value="${esc(projectId)}">${dlgActions(dlgBtn("Back to editing", { action: "settings-back" }), '<button type="submit" class="primary">Save changes</button>')}</form>`, `Project ${view.project.name}. Nothing is saved until you confirm.`);
  settingsConfirmation = proposal; disableActions();
}

// Model picker: the current model, then an in-flow list with Pi's scoped models first and a search over every configured model.
const modelNorm = text => text.toLowerCase().replace(/[-_/.:@]+/g, " ");
async function loadModelPicker() {
  const data = await api({ action: "model-picker-snapshot" });
  if (!data || data.networkChecked !== false || !Array.isArray(data.items) || !Array.isArray(data.scoped)) throw new Error("Invalid model list");
  modelCache.clear();
  for (const model of data.items) {
    if (typeof model?.reference !== "string" || typeof model.name !== "string" || typeof model.configured !== "boolean") throw new Error("Invalid model list entry");
    modelCache.set(model.reference, { ...model, hay: modelNorm(`${model.reference} ${model.name}`) });
  }
  modelScoped = data.scoped.filter(reference => modelCache.get(reference)?.configured);
  modelExtensionErrors = Array.isArray(data.extensionErrors) ? data.extensionErrors : [];
}
function modelButton(reference, disabled = false) {
  const model = modelCache.get(reference), context = compactTokens(model?.contextWindow);
  return `<button type="button" class="mp-current" data-action="mp-toggle" aria-haspopup="listbox" aria-expanded="false"${disabled ? " disabled" : ""}><span class="mp-main"><span class="mp-name">${esc(model?.name ?? reference)}</span>${model ? `<span class="mp-ref mono">${esc(reference)}</span>` : ""}</span>${context ? `<span class="mp-ctx" title="Context window">${context}</span>` : "<span></span>"}<span class="mp-caret" aria-hidden="true">▾</span></button>`;
}
function modelPickerHtml(role, reference, unavailable) {
  const configured = [...modelCache.values()].filter(model => model.configured).length;
  return `<div class="mp" data-role="${role}" data-value="${esc(reference)}">${modelButton(reference, Boolean(unavailable))}${unavailable ? "" : `<div class="mp-pop" hidden><input class="mp-search" type="search" role="combobox" aria-expanded="true" aria-controls="mp-list-${role}" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search ${configured} configured models…" aria-label="Search models for ${role}"><div class="mp-list" id="mp-list-${role}" role="listbox" aria-label="${role} models"></div></div>`}</div>`;
}
const MODEL_ROWS = 40, MODEL_UNCONFIGURED_ROWS = 5;
function modelGroups(query, value) {
  const terms = modelNorm(query).split(/\s+/).filter(Boolean), hit = model => terms.every(term => model.hay.includes(term));
  const configured = [...modelCache.values()].filter(model => model.configured), scoped = new Set(modelScoped), cap = (models, limit, label, extra = {}) => ({ label, models: models.slice(0, limit), more: Math.max(0, models.length - limit), ...extra });
  if (!terms.length) {
    const current = modelCache.get(value), groups = current && !scoped.has(value) ? [{ label: "Current", models: [current], more: 0 }] : [];
    if (!scoped.size) return [...groups, cap(configured, MODEL_ROWS, "Configured models")];
    return [...groups, { label: "Scoped models", models: modelScoped.map(reference => modelCache.get(reference)), more: 0 }, { label: "", models: [], more: 0, hint: `Type to search all ${configured.length} configured models.` }];
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
  mp.querySelector(".mp-list").innerHTML = [...modelGroups(search.value, value), ...modelExtensionErrors.map(item => ({ label: "", models: [], more: 0, hint: `${item.extension} failed to load: ${item.error}` }))].map(group => `${group.label ? `<div class="mp-group" role="presentation">${esc(group.label)}</div>` : ""}${group.models.map(model => {
    const context = compactTokens(model.contextWindow);
    return `<div class="mp-row" role="option" id="mp-${mp.dataset.role}-${index++}" data-ref="${esc(model.reference)}" aria-selected="${model.reference === value}"${group.disabled ? ' aria-disabled="true" title="Add credentials to use this model"' : ' data-action="mp-pick"'}><span class="mp-main"><span class="mp-name">${esc(model.name)}</span><span class="mp-ref mono">${esc(model.reference)}</span></span><span class="mp-tags">${model.reasoning ? '<span class="mp-ctx" title="Supports reasoning">reasoning</span>' : ""}${context ? `<span class="mp-ctx" title="Context window">${context}</span>` : ""}</span></div>`;
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
  if (!modelCache.get(reference)?.configured) throw new Error("That model has no credentials configured");
  mp.dataset.value = reference; mp.querySelector(".mp-current").outerHTML = modelButton(reference);
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
  if (!page || page.offset !== offset || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== offset + page.items.length || !page.items.length) || page.items.some(record => !uuid(record.id) || record.projectId !== id || !/^[a-f0-9]{64}$/.test(record.fingerprint) || typeof record.scopeCurrent !== "boolean" || !["pending", "approved", "rejected"].includes(record.status) || !record.operation || !["merge", "auto-merge", "command"].includes(record.operation.kind))) throw new Error("Invalid owned operation page");
}
function ownedOperation(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== projectId || record.fingerprint !== fingerprint) throw new Error("Operation binding changed; reopen its owned record");
  if (view.project.archived || view.project.deleted || !record.scopeCurrent) throw new Error("Restore the project/use a current scope before changing this operation");
  return record;
}
function executionConsentAvailable(record) { return record.status === "pending" && record.scopeCurrent && record.operation.provider === "github" && ["merge", "command"].includes(record.operation.kind); }
function mergeExecutionAvailable(record) { return record.status === "approved" && record.executionApproved === true && record.scopeCurrent && record.operation.provider === "github" && record.operation.kind === "merge"; }
function operationLetter(record) {
  const attrs = `data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"`;
  return `<article class="letter"><h2>${esc(record.operation.provider)} ${esc(record.operation.kind)}</h2>${badge(record.status)}<p>Project ${esc(record.projectId)}<br>ID ${esc(record.id)}<br>Fingerprint ${esc(record.fingerprint)}<br>Current scope: ${esc(record.scopeCurrent)}</p><pre>${esc(JSON.stringify(record.operation, null, 2))}</pre><p>Plain approval does not authorize execution. Consent and execution are separate. Arc is deferred; auto-merge is unavailable; commands execute only through bound worker profiles.</p><div class="row">${record.status === "pending" ? `<button data-action="operation-decision" ${attrs} data-decision="plain">Approve record only</button>${executionConsentAvailable(record) ? `<button class="danger" data-action="operation-decision" ${attrs} data-decision="execution">Permit exact executor</button>` : ""}<button data-action="operation-decision" ${attrs} data-decision="reject">Reject</button>` : `<p>Decision is immutable. Executable approval: ${esc(record.executionApproved === true)}</p>${mergeExecutionAvailable(record) ? `<button class="danger" data-action="operation-execute" ${attrs}>Execute exact-head merge, separate confirmation</button><button data-action="operation-inspect" ${attrs}>Inspect original merge outcome, never replay</button>` : ""}`}</div></article>`;
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
const operationFacts = record => `<div class="kv tight"><span>Action</span><b>${esc(record.operation.provider)} · ${esc(humanKey(record.operation.kind))}</b>${record.operation.repositoryId ? `<span>Repository</span><b>${esc(record.operation.repositoryId)}</b>` : ""}<span>Status</span><b>${badge(record.status)}</b><span>Scope</span><b>${record.scopeCurrent ? "Still current" : "Changed since"}</b></div>`;
const operationBinding = record => `<details class="raw"><summary>Exact binding</summary><div class="kv tight mt"><span>Project</span><b class="mono">${esc(record.projectId)}</b><span>Request</span><b class="mono">${esc(record.id)}</b><span>Fingerprint</span><b class="mono">${esc(record.fingerprint)}</b></div><pre>${esc(JSON.stringify(record.operation, null, 2))}</pre></details>`;
function operationView(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== projectId || record.fingerprint !== fingerprint) throw new Error("Unknown owned operation record");
  const attrs = { operation: record.id, fingerprint: record.fingerprint };
  const buttons = record.status === "pending"
    ? `${dlgBtn("Reject", { action: "operation-decision", ...attrs, decision: "reject" })}${dlgBtn("Approve, record only", { action: "operation-decision", ...attrs, decision: "plain" })}${executionConsentAvailable(record) ? dlgBtn("Allow exact executor…", { action: "operation-decision", ...attrs, decision: "execution" }, "primary") : ""}`
    : `${mergeExecutionAvailable(record) ? `${dlgBtn("Check what happened to the merge…", { action: "operation-inspect", ...attrs })}${dlgBtn("Merge this exact commit…", { action: "operation-execute", ...attrs }, "danger")}` : ""}`;
  showDialog("Approval request", `${operationFacts(record)}<p class="note-box">${record.status === "pending" ? "Approving only records your decision. Letting the executor act is a separate choice. Arcadia and auto-merge are not available here." : `Your decision is final. Executable approval: ${record.executionApproved === true ? "yes" : "no"}.`}</p>${operationBinding(record)}${dlgActions(dlgBtn("Back to approvals", { action: "operation-list" }), buttons)}`, `${record.operation.provider} · ${humanKey(record.operation.kind)}`); disableActions();
}
function operationDecision(id, fingerprint, mode) {
  const record = ownedOperation(id, fingerprint);
  if (record.status !== "pending" || !["plain", "execution", "reject"].includes(mode) || mode === "execution" && !executionConsentAvailable(record)) throw new Error("This immutable/deferred operation cannot accept that decision");
  const copy = { execution: ["Allow this exact executor?", "Allow executor", "Lets the recorded executor act, including its bound effect. Nothing runs from this dialog."], plain: ["Approve, record only?", "Approve", "Records your decision. It does not allow execution or any remote effect."], reject: ["Reject this request?", "Reject request", "Records a rejection. This cannot be undone."] }[mode];
  showDialog(copy[0], `${operationFacts(record)}<p class="note-box${mode === "execution" ? " warn" : ""}">${esc(copy[2])}</p>${operationBinding(record)}<form data-operation-decision data-project="${esc(projectId)}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}" data-decision="${esc(mode)}">${mode !== "reject" ? `<input type="hidden" name="confirm" value="${esc(projectId)}">` : ""}${dlgActions(dlgBtn("Back", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }), `<button type="submit" class="primary${mode === "plain" ? "" : " danger"}">${copy[1]}</button>`)}</form>`, `${record.operation.provider} · ${humanKey(record.operation.kind)}`); disableActions();
}
function operationExecution(id, fingerprint, inspect = false) {
  const record = ownedOperation(id, fingerprint);
  if (!mergeExecutionAvailable(record)) throw new Error("Only a separately executable exact-head GitHub merge can run here");
  showDialog(inspect ? "Check what happened to this merge?" : "Merge this exact commit?", `${operationFacts(record)}<p class="note-box${inspect ? "" : " warn"}">${inspect ? "Reads the original merge outcome. Matching evidence can settle the record; if none is found it stays unknown. This does not merge or allow another attempt." : "This changes the remote repository. The executor rechecks repository, scope and commit first, and an unknown outcome is never retried automatically."}</p><p class="note">No command, deployment, Arcadia or auto-merge runs from here.</p>${operationBinding(record)}<form data-operation-execute data-mode="${inspect ? "inspect" : "execute"}" data-project="${esc(projectId)}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"><input type="hidden" name="confirm" value="${esc(projectId)}">${dlgActions(dlgBtn("Back", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }), `<button type="submit" class="primary${inspect ? "" : " danger"}">${inspect ? "Check outcome" : "Merge now"}</button>`)}</form>`, `${record.operation.provider} · ${humanKey(record.operation.kind)}`); disableActions();
}
function uuid(value) { return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value); }
function requireProject(id) { if (id !== projectId) throw new Error("Selected project changed. Reopen the intended control."); }
function closeCurrentDialog(id, version) { if (projectId === id && dialogVersion === version) closeDialog(); }
function requireThread(id) { if (!uuid(id) || !plan?.work.some(work => work.threadId === id)) throw new Error("Unknown owned reusable thread in the current plan"); }
function workLine(work, detail) {
  return `<button class="worker-line ${esc(work.status)}" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}" title="${esc(work.text)}"><span class="dot"></span><span class="worker-title">${esc(clip(work.text.replace(/\s+/g, " ").trim(), 60))}</span><small class="worker-meta"><span class="worker-role">${esc(work.role)}</span> · <span class="worker-status">${esc(work.status)}</span>${detail ? ` · <span class="worker-detail">${esc(detail)}</span>` : ""}${holdsBadge(work.holds)}</small></button>`;
}
// Shared resources a running worker holds: leases by resource name, and its running background commands.
function holdsBadge(holds) {
  if (!holds) return "";
  const parts = [...holds.leases.map(lease => `lease ${lease.resource}`), ...(holds.background.length ? [`${holds.background.length} bg`] : [])];
  const title = [...holds.leases.map(lease => `${lease.resource} until ${new Date(lease.until).toLocaleTimeString()}`), ...holds.background.map(item => `background: ${item.label}`)].join("\n");
  return ` · <span class="worker-holds" title="${esc(title)}">${esc(parts.join(", "))}</span>`;
}
const finished = work => ["completed", "failed", "stopped"].includes(work.status);
function durableActivity() {
  const order = { running: 0, queued: 1, interrupted: 2, blocked: 3 };
  // Finished and archived work leave this panel for Recent results; Activity keeps the full list.
  const shown = plan.work.filter(work => !finished(work) && !work.archived).toSorted((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 12);
  const detail = work => work.status === "running" && work.startedAt ? duration(Date.now() - work.startedAt) : work.blocker ? clip(work.blocker, 80) : "";
  const total = plan.work.length;
  return (shown.map(work => workLine(work, detail(work))).join("") || `<p class="note">${total ? "No active workers." : "No workers yet."}</p>`) + (total ? `<button class="ghost small all-work" data-action="all-work">View all work (${total}) →</button>` : "");
}
function durableResults() {
  const done = plan.work.filter(work => finished(work) && !work.archived).toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 5);
  return done.map(work => workLine(work, work.endedAt ? `${duration(Date.now() - work.endedAt)} ago` : "")).join("") || '<p class="note">Finished work appears here.</p>';
}
function threadList() {
  if (!plan) throw new Error("Durable plan is not loaded");
  showDialog("Durable work and reusable threads", `<p>Work items sharing a thread UUID reuse its conversation. Status is not verification evidence.</p>${plan.work.toReversed().map(work => `<article class="task">${badge(work.status)}<strong>${esc(work.text)}</strong><p>Role ${esc(work.role)} · Work ${esc(work.id)}<br>Thread ${esc(work.threadId)}<br>${esc(work.blocker ?? "")}</p><button data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}">Read owned history</button></article>`).join("") || '<p>No retained work items.</p>'}`);
}
async function inspectThread(threadId, offset = null, textOffset = 0) {
  requireThread(threadId);
  if (workerFocus?.threadId !== threadId) workerFocus = null;
  if (![offset ?? 0, textOffset].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error("Invalid thread history page");
  const chat = { id: projectId, generation, threadId, offset, textOffset };
  workerChat = chat;
  setTab("activity");
  const target = document.querySelector("#inline-thread");
  target.hidden = false; target.innerHTML = '<p class="note">Reading worker conversation…</p>'; document.querySelector("#thread-empty").hidden = true;
  const version = ++dialogVersion;
  const page = await workerChatPage(chat);
  if (workerChat !== chat || version !== dialogVersion || chat.generation !== generation || target.hidden) return;
  const work = plan.work.findLast(item => item.threadId === threadId);
  const draft = formDrafts.get(`${chat.id}:thread-send:${threadId}`);
  const role = work?.role ?? "worker";
  target.innerHTML = `<div class="thread-head"><div class="grow"><div class="row thread-title">${badge(work?.status ?? "unknown")}<b>${esc(role[0].toUpperCase() + role.slice(1))}</b><small>${esc(work?.attempt?.model ?? "")}</small></div><p class="thread-task clamp" data-action="toggle-clamp" title="Show the full task">${esc(work?.text ?? "")}</p></div><button class="ghost small" data-action="thread-close" aria-label="Close thread">✕</button></div><section id="worker-artifacts"></section><div id="worker-messages" class="transcript" aria-live="polite"></div><div id="worker-history-pages" class="row"></div><form class="composer" data-inline-thread-send data-project="${esc(chat.id)}" data-thread="${esc(threadId)}"><textarea name="message" aria-label="Message worker" required maxlength="32000" rows="2" placeholder="Follow up with this ${esc(role)}…">${esc(draft?.text ?? "")}</textarea><div class="row between"><small>Reuses this ${esc(role)}'s conversation · Enter to send</small><button class="primary" type="submit">Send</button></div></form><details class="worker-controls"><summary>Evidence, changes and controls</summary><div id="worker-evidence"></div><p class="note">Thread ${esc(threadId)} · Conversation ${esc(page.conversationId)}. Scope, model and tools stay frozen; history, partial files and receipts are kept.</p><div class="row"><button data-thread-mutation data-action="thread-steer" data-project="${esc(chat.id)}" data-thread="${esc(threadId)}">Steer…</button><button data-thread-mutation class="danger" data-action="thread-stop" data-project="${esc(chat.id)}" data-thread="${esc(threadId)}">Stop…</button></div></details>`;
  document.querySelector("#thread-empty").hidden = true;
  renderWorkerChat(chat, page, true);
  render();
}
async function workerChatPage(chat) {
  const read = offset => api({ action: "thread-history", id: chat.id, threadId: chat.threadId, offset, limit: 30, textOffset: chat.textOffset, textLimit: 4000 });
  let page = await read(chat.offset ?? 0);
  if (chat.offset === null && page.total > 30) page = await read(Math.max(0, page.total - 30));
  if (page.threadId !== chat.threadId || !Array.isArray(page.items) || chat.offset !== null && page.offset !== chat.offset) throw new Error("History does not match its owned thread/page");
  return page;
}
async function refreshWorkerChat(chat) {
  const page = await workerChatPage(chat);
  if (workerChat !== chat || chat.generation !== generation || projectId !== chat.id || document.querySelector("#inline-thread").hidden) return;
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
void start();

// Settings section nav: smooth-scroll to a section (no hash navigation) and highlight the section in view.
document.addEventListener("click", event => {
  const link = event.target.closest(".set-nav a");
  if (!link) return;
  event.preventDefault();
  document.querySelector(link.getAttribute("href"))?.scrollIntoView({ block: "start", behavior: "smooth" });
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
