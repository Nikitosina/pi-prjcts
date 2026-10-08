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
const customAnswers = new Set();
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
const tabs = ["coordinator", "knowledge", "activity", "observability", "settings"];
let tab = tabs.includes(initial.searchParams.get("tab")) ? initial.searchParams.get("tab") : "coordinator";
// Observability usage is pinned to the project/generation that requested it.
let usageObs = null, usageLoading = false;
let observability = null, observabilityLoading = false, eventOffset = 0;

async function start() {
  document.querySelector("#compose button").disabled = true;
  const current = generation;
  try {
    const loaded = await api({ action: "list" });
    if (current !== generation) return;
    projects = loaded;
    renderProjects();
    if (!projects.some(p => p.id === projectId)) projectId = projects[0]?.id ?? null;
    changeProject(projectId, chatId);
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
    const [nextPlan, nextApprovals, nextDocs] = await Promise.all(next.project.runtime === "durable" ? [api({ action: "plan-snapshot", id }), api({ action: "operation-snapshot", id, status: "pending", offset: 0, limit: 100 }), api({ action: "knowledge-list", id })] : [null, null, api({ action: "knowledge-list", id })]);
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
    if (next.project.runtime === "durable") ensureLive();
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
  for (const selector of ["#chat-bar", "#queue", "#letter", "#activity", "#outcomes", "#notes", "#messages", "#reply-summary", "#workspace", "#evidence-inline", "#work-list", "#obs-kpis", "#obs-usage", "#obs-health", "#obs-trace", "#obs-timeline", "#obs-event-log", "#obs-usage-time", "#owner-steps", "#settings-summary"]) document.querySelector(selector).replaceChildren();
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
  if (next === "settings") { void loadAutomationStrip(); void loadEventsIn(); void loadTelegram(); void loadSkillsPicker(); renderNotify(); }
}

function render() {
  if (!view) return;
  const pending = [...view.inbox.filter(item => !item.result), ...(approvalPage?.items ?? []).filter(record => record.status === "pending").map(record => ({ kind: "approval", id: `operation:${record.id}`, title: `${record.operation.provider} ${record.operation.kind} · ${record.operation.repositoryId}`, record }))].sort((a, b) => (a.kind === "question" ? 0 : 1) - (b.kind === "question" ? 0 : 1));
  const pendingTotal = view.inbox.filter(item => !item.result).length + (approvalPage?.total ?? 0);
  const entry = pending.find(item => item.id === selected) ?? pending[0];
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
  setHtml("#queue", pending.length < 2 ? "" : pending.map((item, i) => `<button class="inbox-item ${entry.id === item.id ? "active" : ""}" data-action="select" data-entry="${item.id}"><span class="index">${String(i + 1).padStart(2, "0")}</span><span class="item-body"><strong>${esc(item.title)}</strong><small>${item.kind === "question" ? "A decision for the coordinator" : item.kind === "approval" ? "Exact bound operation, not an execution" : `${esc(item.outcome)} run ready for review`}</small></span><span class="arrow">↗</span></button>`).join(""));
  setHtml("#letter", entry ? letter(entry) : "");
  document.querySelector("#needs-card").hidden = !entry;
  setHtml("#activity", plan ? durableActivity() : view.activeRuns.map(run => `<div class="task">${badge(state(run.id))}<strong>${esc(run.task.slice(0, 160))}</strong><small>${esc(run.role)} · ${esc(view.project.models[run.role])}</small><br><button class="ghost small" data-action="worker" data-run="${run.id}">Inspect worker ↗</button></div>`).join("") || '<p class="note">No workers are running.</p>');
  const outcomes = view.inbox.filter(item => item.kind === "review" && item.result).slice(-5).reverse();
  if (plan) setHtml("#outcomes", durableResults());
  else setHtml("#outcomes", outcomes.map(item => `<div class="task">${badge(item.outcome)}<strong>${esc(item.title)}</strong><small>${item.result.action === "accept" ? "You accepted this result" : "You requested changes"}</small><br><button class="ghost small" data-action="worker" data-run="${item.run}">Read result ↗</button></div>`).join("") || '<p class="note">No reviewed results yet.</p>');
  // The rail shows topic documents; the starter files and raw legacy answers live in the Knowledge tab.
  const topics = knowledgeDocs.filter(doc => doc.path !== "MEMORY.md" && doc.path !== "preferences.md" && !doc.path.startsWith("research/legacy/"));
  setHtml("#notes", topics.length ? knowledgeTree(topics, true) : `<p class="note">${knowledgeDocs.length ? "Only the starter MEMORY.md and preferences.md so far." : "No knowledge documents yet."}</p>`);
  setHtml("#knowledge-inline", knowledgeDocs.length ? knowledgeTree(knowledgeDocs, false) : '<p class="note">No knowledge documents yet.</p>');
  setHtml("#uploads-inline", uploadsHtml()); renderAttachments();
  setHtml("#messages", view.messages.map(message => chatMessageHtml(message, "Coordinator")).join("") || `<div class="empty-chat"><h2>How can the coordinator help with ${esc(view.project.name)}?</h2><p>Describe an outcome. The coordinator plans the work, spawns workers and brings decisions back here.</p></div>`);
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
  hint.textContent = `${view.project.model.split("/").at(-1)} · Enter to send · Shift+Enter for a new line · / for skills`; hint.title = view.project.model;
  renderPanels();
  document.querySelector("#workspace").textContent = view.project.cwd;
  document.querySelector("#workspace-policy").textContent = plan ? "Workers run on this Mac and edit only folders you allow in Settings. Keep the Mac awake while work runs." : "Legacy workers use this checkout directly. Keep the Mac awake while work runs.";
  // Failures older than the newest settled turn are history, not current problems.
  const lastDone = view.jobs.findLastIndex(job => job.state === "done");
  const failures = view.jobs.slice(lastDone + 1).filter(job => ["failed", "interrupted"].includes(job.state)).slice(-2);
  const warnings = failures.map(job => `<div>${esc(job.state)}: ${esc(job.error ?? job.text)} <button class="ghost small" data-action="retry-message" data-project="${esc(view.project.id)}" data-job="${esc(job.id)}">Retry</button></div>`);
  if (plan) warnings.push(...plan.work.filter(work => work.blocker && !work.archived).slice(-3).map(work => `<div>${esc(`${work.role} ${work.threadId}: ${work.blocker}`)}</div>`));
  const shownProblem = failures.some(job => job.error === view.project.problem);
  // The problem may come from another chat; offer to open it.
  const problemChat = (view.chats ?? []).find(chat => chat.attention && chat.id !== chatId && view.project.problem?.startsWith(`Chat "${chat.title}": `));
  if (view.project.problem && !shownProblem && !pending.some(item => item.kind === "question" && item.question === view.project.problem)) warnings.unshift(`<div>${esc(view.project.problem)}${problemChat ? ` <button class="ghost small" data-action="chat-select" data-chat="${esc(problemChat.id)}">Open chat</button>` : ""}</div>`);
  const warning = document.querySelector("#warning");
  setHtml("#warning", warnings.join("")); warning.hidden = !warnings.length;
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
  meter.querySelector(".context-popup").textContent = label;
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
  setHtml("#work-list", plan ? treeRows() || '<p class="note">No work yet. Message the coordinator to start.</p>' : view.activeRuns.map(run => `<div class="work">${badge(state(run.id))}<div class="grow"><strong>${esc(run.task.slice(0, 240))}</strong><small>${esc(run.role)}</small></div><button class="ghost small" data-action="worker" data-run="${run.id}">Inspect ↗</button></div>`).join("") || '<p class="note">No workers are running.</p>');
  const kpi = (label, value, tone = "") => `<div class="card kpi ${tone}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
  setHtml("#obs-kpis", [kpi("Needs you", pendingCount(), pendingCount() ? "warn" : ""), kpi("Running", plan ? count("running") : view.activeRuns.length), kpi("Queued", count("queued")), kpi("Blocked", count("blocked"), count("blocked") ? "err" : ""), kpi("Work items", work.length), kpi("Worker cap", plan?.workerCap ?? "—")].join(""));
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
  const scopes = p.workspaceAuthorization?.scopes?.length ?? 0, grants = p.githubAuthorization?.length ?? 0;
  const step = (done, title, detail) => `<li class="${done ? "done" : ""}"><span class="n">${done ? "✓" : "•"}</span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></li>`;
  const wholeRepository = p.workspaceAuthorization?.scopes?.some(scope => scope.wholeRepository);
  setHtml("#owner-steps", [step(scopes > 0, "1. Workspace", wholeRepository ? "Workers can edit this repository" : scopes ? `${scopes} folder-limited scope(s)` : "Workers cannot edit code yet.") + (scopes ? "" : '<li class="step-action"><button class="primary" data-action="workspace-quick">Let workers edit this repo</button></li>'), step(grants > 0, "2. GitHub", grants ? `Draft PRs on ${p.githubAuthorization.map(grant => grant.repositoryId).join(", ")}` : wholeRepository ? "Workers cannot open draft PRs yet." : "Not connected.") + (wholeRepository && !grants ? '<li class="step-action"><button class="primary" data-action="github-quick">Connect GitHub</button></li>' : ""), ...(wholeRepository ? [] : [step(false, "3. Fixed command profile", "Optional, owner-defined executable and arguments.")]), step(true, wholeRepository ? "3. Skills" : "4. Skills", "Chosen per role in Skills below; repository skills by default.")].join(""));
  if (tab === "settings" && plan) { void loadAutomationStrip(); void loadEventsIn(); void loadSkillsPicker(); }
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
    skillsPicker = { projectId: id, skills, isDefault: !saved, draft: structuredClone(profiles), saved: JSON.stringify(profiles), tab: skillsPicker?.projectId === id ? skillsPicker.tab : "all", query: skillsPicker?.projectId === id ? skillsPicker.query : "", note: "" };
    renderSkillsPicker();
  } catch (error) { if (id === projectId && current === generation) node.innerHTML = `<p class="note">Skills unavailable: ${esc(error.message)}</p>`; }
}
function renderSkillsPicker() {
  const state = skillsPicker, node = document.querySelector("#skills-picker");
  if (!state || state.projectId !== projectId) return;
  const known = new Set(state.skills.map(skill => skill.name)), count = role => new Set([...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter(name => known.has(name))).size;
  document.querySelector("#skills-summary").textContent = `${state.skills.length} loaded · ${state.isDefault && JSON.stringify(state.draft) === state.saved ? "default: repository skills" : `${count("all")} for every profile`}`;
  const q = state.query.trim().toLowerCase(), all = new Set(state.draft.all), picked = new Set(state.draft[state.tab]);
  const shown = state.skills.filter(skill => !q || skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
  const groups = Object.keys(skillSourceLabels).map(source => [source, shown.filter(skill => skill.source === source)]).filter(([, list]) => list.length);
  const row = skill => { const inherited = state.tab !== "all" && all.has(skill.name); return `<label class="skill-pick${inherited ? " inherited" : ""}"><input type="checkbox" data-skill-pick="${esc(skill.name)}" ${inherited || picked.has(skill.name) ? "checked" : ""} ${inherited ? "disabled" : ""}><span><b>${esc(skill.name)}</b>${inherited ? ' <small class="skill-tag">all profiles</small>' : ""}${skill.manual ? ' <small class="skill-tag">manual only</small>' : ""}<small>${esc(skill.description)}</small></span></label>`; };
  const dirty = JSON.stringify(state.draft) !== state.saved;
  node.innerHTML = `<div class="skill-tabs" role="tablist">${skillProfileTabs.map(([role, label]) => `<button type="button" role="tab" class="ghost small${role === state.tab ? " on" : ""}" aria-selected="${role === state.tab}" data-action="skills-tab" data-role="${role}">${label} <span class="count">${count(role)}</span></button>`).join("")}</div>
    <p class="note">${state.tab === "all" ? "Every profile gets these." : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} gets “All profiles” plus the skills checked here.`}</p>
    <input type="search" id="skills-search" placeholder="Search ${state.skills.length} skills" value="${esc(state.query)}" aria-label="Search skills">
    <div class="skill-groups">${groups.map(([source, list]) => `<fieldset class="events-group skill-group" data-source="${source}"><legend>${skillSourceLabels[source]} · ${list.length}</legend>${list.map(row).join("")}</fieldset>`).join("") || '<p class="note">No skill matches.</p>'}</div>
    ${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row"><button class="primary" data-action="skills-save" ${dirty ? "" : "disabled"}>Save skills</button><button class="ghost" data-action="skills-reset" ${state.isDefault ? "disabled" : ""}>Reset to default</button></div>`;
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
  skillsPicker.note = ""; renderSkillsPicker();
});
document.addEventListener("input", event => {
  if (event.target.id !== "skills-search" || !skillsPicker) return;
  skillsPicker.query = event.target.value; renderSkillsPicker();
  const input = document.querySelector("#skills-search"); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
});

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
  const data = await mutate({ action: "automation-update", id: projectId, change: { eventChat: value("#event-chat").value, follow: { enabled: value("#follow-enabled").checked, everyMs: Number(value("#follow-every").value), autoFix: value("#follow-autofix").checked, fixCap: cap }, webhook: { enabled: value("#webhook-enabled").checked }, autoMerge: { enabled: value("#merge-enabled").checked } } }, "Events settings saved.");
  eventsIn.data = data; renderEventsIn();
}

// Notifications (host-wide): browser notifications from the host notice feed while the owner is away from this tab, and the Telegram bot.
// Away = tab hidden or window not focused (another app in front keeps `visibilityState` "visible"). `notifyAway` also remembers that the
// owner was away since the last poll, so a backlog collected after a throttled/frozen or failing poll still notifies on return.
const notifyKey = "pi-projects-notify";
let notifyCursor, notifyTimer = null, notifyPolling = false, notifyAway = false, notifyProblem = "", notifyNote = "";
const notifyAwayNow = () => document.visibilityState === "hidden" || !document.hasFocus();
const noticeLabels = { question: "Question", approval: "Approval", review: "Review", result: "Finished", error: "Error" };
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
  const values = [["Host", document.querySelector("#connection").textContent.split(" · ")[0]], ["Runtime", project.runtime ?? "legacy"], ["Coordinator", (view.chats ?? []).some(chat => chat.busy) || view.busy ? `busy${(view.chats?.length ?? 0) > 1 ? ` · ${view.chats.filter(chat => chat.busy).length}/${view.chats.length} chats` : ""}` : "idle"], ["Project", project.deleted ? "deleted" : project.archived ? "archived" : plan?.pausing ? "pausing" : view.paused ? "paused" : project.phase === "attention" ? "needs attention" : "ready"], ["Uptime", h ? duration(h.uptimeMs) : "Reading…"], ["Queue depth", h ? (h.queue?.queued ?? 0) + (h.queue?.running ?? 0) : "Reading…"], ["Leases", h?.activeLeases ?? "—"], ["Project locks", h?.activeLocks ?? "—"], ["Mac awake", h?.macAwake === null ? "Unknown" : h?.macAwake ?? "Reading…"], ["Failed jobs", view.failedJobs ?? view.jobs.filter(job => ["failed", "interrupted"].includes(job.state)).length], ["Evidence", view.evidence.length]];
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
  const github = kind === "github.follow", hook = kind.startsWith("webhook.");
  const changes = github ? (body.match(/^- /gm) ?? []).length : 0;
  const title = github ? "GitHub activity" : hook ? `Webhook · ${kind.slice(8)}` : `Event · ${kind}`;
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
  const body = (skill ? `<span class="skill-chip" title="Skill /skill:${esc(skill[1])}">${skillIcon}${esc(skill[1])}</span>${skill[2] ? renderMarkdown(attachmentChips(skill[2]).text) : ""}` : renderMarkdown(attached.text)) + attached.chips;
  return `${thought}<article class="msg ${message.role === "user" ? "you" : "them"}"${indexAttr(message)}><div class="who">${esc(label)} <small class="inline">${esc(when(message.at))}</small></div><div class="text">${body}</div>${message.nextTextOffset != null ? `<p class="note">Text continues at character ${message.nextTextOffset}; use the next text slice.</p>` : ""}</article>`;
}
const skillIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>';
// "/" skill picker in the coordinator composer. The catalog loads once per project on first use.
let skillCatalog = null, skillMenu = null;
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
function closeSkillMenu() { skillMenu = null; const node = document.querySelector("#skill-menu"); if (node) { node.hidden = true; node.innerHTML = ""; } document.querySelector("#compose textarea")?.removeAttribute("aria-activedescendant"); }
async function updateSkillMenu(textarea) {
  const query = skillQuery(textarea);
  if (query === null) { closeSkillMenu(); return; }
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
  if (entry.kind === "question") return `<article class="letter"><h2>${esc(entry.title)}</h2>${entry.question.trim() !== entry.title ? `<p class="description">${esc(entry.question.startsWith(entry.title) ? entry.question.slice(entry.title.length).trim() : entry.question)}</p>` : ""}<div class="choices">${entry.choices.map((choice, index) => `<button data-action="answer" data-project="${esc(projectId)}" data-entry="${entry.id}" data-choice="${index}" data-choice-text="${esc(choice)}">${esc(choice)}</button>`).join("")}</div>${entry.choices.length && !customAnswers.has(answerKey(projectId, entry.id)) ? `<button class="ghost" data-action="custom-answer" data-project="${esc(projectId)}" data-entry="${entry.id}">Write a different answer…</button>` : answerForm(entry)}${answers.has(entry.id) && !answers.has(answerKey(projectId, entry.id)) ? `<p class="notice">An old UUID-only draft is retained without project ownership. It has not been filled into this question.</p><button data-action="answer-adopt" data-project="${esc(projectId)}" data-entry="${esc(entry.id)}">Inspect and explicitly adopt old draft</button>` : ""}<p class="signoff">Asked ${esc(ago(entry.at))}</p></article>`;
  const run = view.project.runs.find(run => run.id === entry.run);
  const status = view.runStates.find(state => state.id === entry.run);
  const files = view.evidence.filter(file => status?.sessionFile && file.sessionFile === status.sessionFile);
  return `<article class="letter"><div class="row between"><span class="eyebrow">A run result for your review</span>${badge(entry.outcome)}</div><h2>${esc(entry.title)}</h2><p class="description">${esc(status?.summary || "Open the worker report for its result and verification details.")}</p><button data-action="worker" data-run="${entry.run}">Read worker report ↗</button>${files.map(artifactButton).join("")}<p class="notice">${files.length ? "These are immutable copies captured by the worker." : "No verification files were attached to this run. Do not treat its process status as proof that the feature works."}</p><div class="row"><button class="primary" data-action="accept" data-project="${esc(projectId)}" data-entry="${entry.id}" data-run="${esc(entry.run)}">${entry.outcome === "complete" ? "Accept result" : "Acknowledge result"}</button><button data-action="revise" data-project="${esc(projectId)}" data-entry="${entry.id}" data-run="${esc(entry.run)}">Request changes</button></div><p class="notice signoff">Accepting closes this review. It does not merge, commit, publish, or start work.</p><p class="signoff">${esc(run?.role ?? "worker")} · ${esc(entry.run)} · ${esc(new Date(entry.at).toLocaleString())}</p></article>`;
}

function answerForm(entry) {
  return `<form data-answer data-project="${esc(projectId)}" data-entry="${entry.id}" class="stack"><textarea name="answer" aria-label="Answer coordinator" placeholder="Your answer… (Enter to send, Shift+Enter for a new line)" maxlength="24000" required>${esc(answers.get(answerKey(projectId, entry.id)) ?? "")}</textarea><div><button class="primary" type="submit">Send answer</button></div></form>`;
}
function artifactButton(file) { return `<button class="artifact" data-action="artifact" data-file="${file.id}"><strong>${esc(file.title)}</strong><small>${esc(file.filename)} · ${Math.ceil(file.size / 1024)} KiB · SHA-256 ${esc(file.sha256.slice(0, 12))}</small></button>`; }
function state(id) { return view.runStates.find(run => run.id === id)?.state ?? "unknown"; }
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
  document.querySelectorAll('#letter button, #letter textarea, .panel button').forEach(node => { node.disabled = busy || !view; });
  document.querySelectorAll('#compose button, #compose textarea').forEach(node => { node.disabled = busy || admissionBlocked(); });
  document.querySelectorAll('#dialog button[type="submit"], #dialog [data-action="confirm-pause"], #dialog [data-action="confirm-resume"], #create').forEach(node => { node.disabled = busy; });
  document.querySelectorAll('[data-action="operation-decision"], [data-action="operation-execute"], [data-action="operation-inspect"]').forEach(node => {
    const record = operationCache.get(node.dataset.operation);
    node.disabled = busy || !view || view.project.archived || view.project.deleted || !record?.scopeCurrent;
  });
  document.querySelectorAll('#dialog [data-thread-mutation], #inline-thread [data-thread-mutation], [data-inline-thread-send] button, [data-inline-thread-send] textarea').forEach(node => { node.disabled = busy || admissionBlocked(); });
  document.querySelector('#lifecycle').hidden = view?.project.runtime !== 'durable';
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
  try { const result = await api(input); toast(success); if (input.id === projectId) { if (document.querySelector("#letter").contains(document.activeElement)) document.activeElement.blur(); await refresh(); } return result; }
  finally { busy = false; disableActions(); }
}

function showError(error) {
  const text = error instanceof Error ? error.message : String(error);
  document.querySelector("#connection").textContent = "Disconnected"; document.querySelector("#connection").dataset.state = "down";
  const node = document.querySelector("#error");
  node.dataset.source = "connection";
  node.textContent = `${text}. If the host restarted, run /projects-ui to reopen its current address.`;
  node.hidden = false;
}
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
function inlineMarkdown(value) {
  const code = [];
  let text = esc(value).replace(/`([^`]+)`/g, (_, body) => { const key = `\u0000${code.length}\u0000`; code.push(`<code>${body}</code>`); return key; });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (all, label, escapedHref) => {
    const href = escapedHref.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    try { const url = new URL(href); return ["http:", "https:", "mailto:"].includes(url.protocol) ? `<a href="${esc(url.href)}" rel="noopener noreferrer" target="_blank">${label}</a>` : label; } catch { return label; }
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}
function closeDialog() { captureDialogDraft(); answerAdoption = null; routineConfirmation = null; uploadConfirmations.clear(); settingsConfirmation = null; providerInspection = null; dialogVersion++; if (dialog.open) dialog.close(); if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; }
function showDialog(title, content) { closeDialog(); dialog.innerHTML = `<div class="row between"><h2 id="dialog-title">${esc(title)}</h2><button data-action="close-dialog" class="small">Close</button></div><div class="dialog-body">${content}</div>`; dialog.showModal(); return dialogVersion; }

async function inspectWorker(id) {
  const project = projectId;
  const version = showDialog("Worker report", '<p class="note">Reading the saved run…</p>');
  const result = await api({ action: "workers", id: project, run: id });
  if (!dialog.open || version !== dialogVersion) return;
  const active = view.activeRuns.some(run => run.id === id);
  dialog.querySelector(".dialog-body").innerHTML = `<div class="worker-actions row">${badge(state(id))}${active ? `<button data-action="steer" data-run="${id}">Steer worker</button><button class="danger" data-action="stop" data-run="${id}">Stop worker</button>` : ""}</div><pre>${esc(result.text ?? JSON.stringify(result, null, 2))}</pre><button data-action="worker" data-run="${id}">Refresh report</button>`;
}

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
  const review = mode === "revise" ? view?.inbox.find(entry => entry.id === id && entry.kind === "review" && !entry.result) : null;
  if (mode === "revise" && !review) throw new Error("Pending review is unavailable; refresh before requesting changes");
  const draft = formDrafts.get(draftKey) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
  formDrafts.set(draftKey, draft);
  const title = mode === "thread-send" ? "Follow up on this thread" : mode === "thread-steer" ? "Steer this thread" : mode === "steer" ? "Steer this worker" : "Request another pass";
  showDialog(title, `<form data-task-message data-project="${esc(project)}" data-draft-key="${esc(draftKey)}" data-mode="${esc(mode)}" data-id="${esc(id)}" data-run="${esc(review?.run ?? "")}"><textarea name="message" aria-label="${title}" placeholder="Describe the instruction…" maxlength="32000" required>${esc(draft.text)}</textarea><div class="row signoff"><button class="primary" type="submit">Send</button></div><p class="notice signoff">${mode.startsWith("thread-") ? `This reuses the owned thread with frozen scope/model/tools. Request UUID ${esc(draft.requestId)}. Unresolved retries must keep the same text.` : mode === "steer" ? "This instruction goes to the existing worker." : "The coordinator receives your request and inspects the existing run before planning another pass."}</p></form>`);
  dialog.querySelector("textarea").focus();
}

async function action(node) {
  if (["answer", "custom-answer", "answer-adopt", "accept", "revise"].includes(node.dataset.action)) requireProject(node.dataset.project);
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
    case "custom-answer": {
      if (entry?.kind !== "question" || entry.result) throw new Error("Question is missing or already resolved; refresh before answering");
      customAnswers.add(answerKey(projectId, entry.id)); document.activeElement.blur(); render(); document.querySelector("[data-answer] textarea").focus(); break;
    }
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
    case "accept": {
      if (entry?.kind !== "review" || entry.result || entry.run !== node.dataset.run) throw new Error("Displayed review changed or is resolved; refresh before deciding");
      await mutate({ action: "review", id: node.dataset.project, entry: entry.id, operation: "accept" }, "Result accepted. No merge or publication."); break;
    }
    case "revise": {
      if (entry?.kind !== "review" || entry.result || entry.run !== node.dataset.run) throw new Error("Displayed review changed or is resolved; refresh before requesting changes");
      textDialog("revise", entry.id); break;
    }
    case "worker": await inspectWorker(node.dataset.run); break;
    case "thread-list": threadList(); break;
    case "all-work": setTab("activity"); break;
    case "jump-latest": searchFocus = null; stickToBottom = true; followTranscript(); renderWorkingPill(); break;
    case "skill-pick": pickSkill(node.dataset.name); break;
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
    case "skills-tab": skillsPicker.tab = node.dataset.role; renderSkillsPicker(); break;
    case "skills-save": await saveSkillsPicker(false); break;
    case "skills-reset": await saveSkillsPicker(true); break;
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
    case "github-quick": await githubQuickDialog(); break;
    case "github-quick-confirm": await githubQuickConfirm(node.dataset.project, node.dataset.revision); break;
    case "owner-setup-edit": await ownerSetupEdit(node.dataset.kind, node.dataset.payload || "{}"); break;
    case "owner-profile-read": await ownerProfileRead(node.dataset.project, node.dataset.profile); break;
    case "settings-edit": requireProject(node.dataset.project); settingsEdit(node.dataset.field); break;
    case "settings-discard": settingsDiscard(node.dataset.project, node.dataset.field); break;
    case "settings-confirm-discard": {
      requireProject(node.dataset.project);
      if (!["name", "objective"].includes(node.dataset.field)) throw new Error("Unknown settings draft field");
      settingsDrafts.delete(`${projectId}:${node.dataset.field}`); persistBrowserDrafts(); settingsEdit(node.dataset.field); break;
    }
    case "settings-models": requireProject(node.dataset.project); await settingsModels(node.dataset.role, node.dataset.revision, Number(node.dataset.offset ?? 0)); break;
    case "settings-model": {
      requireProject(node.dataset.project);
      const model = modelCache.get(node.dataset.reference);
      if (!model?.configured || model.projectId !== projectId || model.role !== node.dataset.role || model.revision !== node.dataset.revision) throw new Error("Reopen the configured offline model entry");
      const changes = model.role === "coordinator" ? { model: model.reference } : { models: { [model.role]: model.reference } };
      settingsReview(model.revision, changes); break;
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
    case "steer": textDialog("steer", node.dataset.run); break;
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
    case "stop": showDialog("Stop this worker?", `<p>Partial work stays in the checkout. This does not stop other workers or discard files.</p><button class="danger" data-action="confirm-stop" data-project="${esc(projectId)}" data-run="${esc(node.dataset.run)}">Stop worker</button>`); break;
    case "confirm-stop": {
      const id = node.dataset.project, version = dialogVersion; requireProject(id);
      await mutate({ action: "control", id, run: node.dataset.run, operation: "stop" }, "Stop requested for this worker."); closeCurrentDialog(id, version); break;
    }
    case "artifact": await inspectArtifact(node.dataset.file); break;
    case "notes": showDialog("Shared project notes", view.notes.map(note => `<article class="message"><div class="eyebrow">${esc(note.author)} · ${esc(new Date(note.at).toLocaleString())}</div><p>${esc(note.text)}</p></article>`).join("") || '<p class="note">No notes yet.</p>'); break;
    case "evidence-list": showDialog("Project evidence", view.evidence.map(artifactButton).join("") || '<p class="note">No evidence captured. Ask the worker to attach reports with projects_evidence.</p>'); break;
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
    answers.set(key, proposal.text); customAnswers.add(key); persistBrowserDrafts();
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
    if (form.dataset.mode === "thread-send" || form.dataset.mode === "thread-steer") {
      if (draft.submittedText !== null && draft.submittedText !== text) throw new Error("Prior thread submission is unresolved. Resend its exact text or inspect history before a different request");
      draft.submittedText = text; persistBrowserDrafts();
      await mutate({ action: form.dataset.mode, id: target, threadId: form.dataset.id, requestId: draft.requestId, text }, "Instruction recorded on the existing thread.");
    } else if (form.dataset.mode === "steer") await mutate({ action: "control", id, run: form.dataset.id, operation: "steer", message: text }, "Instruction sent to the worker.");
    else {
      const review = view?.inbox.find(entry => entry.id === form.dataset.id && entry.kind === "review" && !entry.result);
      if (!review || review.run !== form.dataset.run) throw new Error("Displayed review changed or is resolved; draft retained without submitting");
      await mutate({ action: "review", id, entry: form.dataset.id, operation: "revise", text }, "Changes requested. The coordinator will inspect the result.");
    }
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
    if (target === projectId && version === dialogVersion && dialog.open) dialog.querySelector(".dialog-body").innerHTML = `<p>Read-only GitHub identity lookup. Use the numeric repository ID and default branch shown to review a separate authorization request.</p><pre>${esc(JSON.stringify(result, null, 2))}</pre><button data-action="owner-setup">Back to owner setup</button>`;
  } else if (form.matches("[data-owner-write]")) {
    const target = form.dataset.project; requireProject(target);
    if (form.dataset.kind.endsWith("-revoke") && data.get("confirm") !== target) throw new Error("Type the exact project ID for fresh owner consent");
    let fields;
    try { fields = JSON.parse(data.get("payload")); } catch { throw new Error("Owner setup payload must be valid JSON"); }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Owner setup payload must be one JSON object");
    const kind = form.dataset.kind, actionByKind = { "workspace-grant": "workspace-grant", "workspace-revoke": "workspace-revoke", "github-authorize": "github-authorize", "github-revoke": "github-revoke", "command-profile-set": "command-profile-set" };
    if (!Object.hasOwn(actionByKind, kind)) throw new Error("Unknown owner setup action");
    const result = await mutate({ ...fields, action: actionByKind[kind], id: target, confirm: target }, "Owner API recorded this explicit revision-checked change. No command was executed.");
    if (projectId === target && version === dialogVersion && dialog.open) await ownerSetupDialog(result);
  } else if (form.matches("[data-settings-edit]")) {
    requireProject(form.dataset.project); captureSettingsDraft(); persistBrowserDrafts();
    const field = form.dataset.field, key = `${projectId}:${field}`, draft = settingsDrafts.get(key);
    if (!["name", "objective"].includes(field) || !draft || !editableKnowledge(draft.text) || field === "name" && !draft.text.trim()) throw new Error("Invalid settings text; draft retained");
    settingsReview(draft.expectedRevision, { [field]: draft.text }, key);
  } else if (form.matches("[data-settings-choice]")) {
    requireProject(form.dataset.project);
    const field = form.dataset.field, value = data.get("value");
    const choices = { knowledgeAccess: ["read-only", "maintain"], libraryAccess: ["none", "coordinator"], decisionAccess: ["none", "coordinator"] };
    if (field === "workerCap") { const cap = Number(value); if (!Number.isSafeInteger(cap) || cap < 1 || cap > 32) throw new Error("Worker cap must be 1-32"); settingsReview(form.dataset.revision, { workerCap: cap }); }
    else { if (!Object.hasOwn(choices, field) || !choices[field].includes(value)) throw new Error("Unknown settings grant choice"); settingsReview(form.dataset.revision, { [field]: value }); }
  } else if (form.matches("[data-settings-confirm]")) {
    const target = form.dataset.project; requireProject(target);
    const proposal = settingsConfirmation;
    if (!proposal || proposal.projectId !== target || proposal.revision !== form.dataset.revision || data.get("confirm") !== target) throw new Error("Reopen the exact settings proposal and confirm its project ID");
    persistBrowserDrafts();
    const result = await mutate({ action: "settings-update", id: target, confirm: target, expectedRevision: proposal.revision, changes: proposal.changes }, "Settings update acknowledged. Existing threads retain frozen models/instructions.");
    validateSettings(result);
    for (const [field, changed] of Object.entries(proposal.changes)) {
      if (field === "models" ? Object.entries(changed).some(([role, reference]) => result.values.models[role] !== reference) : result.values[field] !== changed) throw new Error("Settings receipt differs from the proposed change; retain drafts and inspect");
    }
    if (proposal.draftKey) {
      const draft = settingsDrafts.get(proposal.draftKey);
      if (draft?.expectedRevision === proposal.revision && draft.text === (proposal.changes.name ?? proposal.changes.objective)) settingsDrafts.delete(proposal.draftKey);
    }
    persistBrowserDrafts();
    if (target === projectId && version === dialogVersion) { projects = projects.map(project => project.id === target ? { ...project, name: result.values.name } : project); renderProjects(); await settingsList(); }
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
  else { const node = document.querySelector("#error"); node.dataset.source = "action"; node.textContent = text; node.hidden = false; }
}
document.addEventListener("click", event => { const node = event.target.closest("[data-action]"); if (node && !node.disabled) void uiAction(() => action(node)); });
document.addEventListener("submit", event => { if (!event.target.matches("#compose, [data-chat-rename], [data-answer], [data-answer-adopt], [data-task-message], [data-resume-project], [data-operation-decision], [data-operation-execute], [data-inline-thread-send], [data-knowledge-path], [data-knowledge-write], [data-upload-edit], [data-upload-confirm], [data-settings-edit], [data-settings-choice], [data-settings-confirm], [data-routine-change], [data-lifecycle-change], [data-open-retained], [data-provider-known], [data-provider-inspect], [data-create]")) return; event.preventDefault(); void uiAction(() => submit(event.target)); });
function autosize(textarea) { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 220)}px`; }
document.addEventListener("input", event => {
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
});
// Clicking elsewhere closes the skill picker; moving the caret re-evaluates it.
document.addEventListener("mousedown", event => { if (event.target.closest(".skill-option")) event.preventDefault(); else if (skillMenu && !event.target.closest("#compose")) closeSkillMenu(); });
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
  dialogVersion++; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null;
});
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "k" && !event.isComposing) { event.preventDefault(); openSearch(); return; }
  if (event.target.id === "search-input" && !event.isComposing) {
    const count = searchState.results.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) { event.preventDefault(); searchState.active = (searchState.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count; renderSearchResults(); }
    else if (event.key === "Enter") { event.preventDefault(); clearTimeout(searchTimer); if (searchState.query === event.target.value.trim() && count) void uiAction(() => openSearchHit(searchState.active)); else void runSearch(); }
    return;
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
  const id = projectId, current = generation, version = showDialog("GitHub provider receipts", '<p>Reading retained native observations…</p>');
  const page = await api({ action: kind === "reads" ? "github-read-snapshot" : "github-write-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextOffset !== null && (!page.items.length || page.nextOffset !== offset + page.items.length)) throw new Error("Invalid retained provider receipt page");
  providerCache.clear();
  const rows = page.items.map(record => {
    if (!uuid(record.scopeId) || !Number.isSafeInteger(record.conversationId) || record.conversationId < 1 || !Number.isSafeInteger(record.taskId) || record.taskId < 1 || typeof record.callId !== "string" || typeof record.operation !== "string" || kind === "reads" && (typeof record.repositoryId !== "string" || !Number.isSafeInteger(record.pullRequest) || record.pullRequest < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)) || kind === "writes" && (!/^[a-f0-9]{64}$/.test(record.key) || !["uncertain", "done"].includes(record.state))) throw new Error("Invalid native provider receipt identity");
    const cacheKey = crypto.randomUUID(); providerCache.set(cacheKey, { projectId: id, kind, record });
    return `<article class="task"><strong>${kind === "reads" ? `${esc(record.repositoryId)} PR ${record.pullRequest} · ${esc(record.operation)}` : `${esc(record.state)} · ${esc(record.operation)} · ${esc(record.target)}`}</strong><p>${kind === "reads" ? `Head ${esc(record.head)}${record.ci ? ` · retained CI ${esc(record.ci.statusState)}` : ""}` : record.source === "local-git-verification" ? "Local-head verification only, no executed commit/push or remote write" : "Native effect receipt, not new execution authority"}</p><button data-action="provider-record" data-project="${esc(id)}" data-record="${esc(cacheKey)}">Inspect retained binding/data</button></article>`;
  });
  const button = (label, lens, next) => `<button data-action="provider-list" data-kind="${lens}" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML = `<p>GitHub-only ${kind}, records ${offset + (page.items.length ? 1 : 0)}-${offset + page.items.length}/${page.total}. Retained observations are not current-state guarantees. Arc adapter remains deferred. Empty receipts do not prove no remote work.</p><div class="row">${button("PR/CI/review reads", "reads", 0)}${button("Publication/uncertainty", "writes", 0)}<button data-action="provider-known">Explicit known PR/head inspection</button>${offset ? button("Previous records", kind, Math.max(0, offset - 100)) : ""}${page.nextOffset !== null ? button("Next records", kind, page.nextOffset) : ""}</div>${rows.join("")}`;
}
function ownedProviderRecord(key) {
  const value = providerCache.get(key);
  if (!value || value.projectId !== projectId) throw new Error("Unknown owned provider observation; reopen its receipt page");
  return value;
}
function providerRecord(key) {
  const value = ownedProviderRecord(key), record = value.record;
  showDialog("Retained provider observation", `<p>${value.kind === "reads" ? "Retained head-bound observation, not current remote state. Feedback is data, not instructions or authority." : record.source === "local-git-verification" ? "Locally published head verification only. It did not execute commit/push or perform a remote write." : record.state === "uncertain" ? "Uncertain native effect. No replay/retry permission." : "Recorded native effect. Not a new execution grant."}</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><button data-action="${value.kind === "reads" ? "provider-fresh" : "provider-inspect"}" data-project="${esc(projectId)}" data-record="${esc(key)}">${value.kind === "reads" ? "Fresh explicit read pinned to this PR/head" : "Inspect retained effect, separate confirmation"}</button>`);
}
function providerResult(result, explanation) { showDialog("Explicit owner provider inspection", `<p>${esc(explanation)}</p><pre>${esc(JSON.stringify(result, null, 2) ?? "No readable response; state/effects remain unproven.")}</pre><button data-action="provider-list">Reopen retained native receipts</button>`); }
async function providerFresh(key) {
  const { kind, record } = ownedProviderRecord(key);
  if (kind !== "reads") throw new Error("Fresh pinned reads require an original read observation");
  const grant = providerBinding(record.scopeId, record.repositoryId), id = projectId, current = generation;
  const identity = { id, provider: "github", repositoryId: grant.repositoryId, expectedRepositoryId: grant.numericId, pullRequest: record.pullRequest, expectedHead: record.head };
  const input = record.operation === "ci" ? { action: "provider-ci-inspect", ...identity, page: record.ci?.page ?? 1 } : record.operation === "review" ? { action: "provider-review-inspect", ...identity, page: 1 } : { action: "provider-pr-inspect", ...identity };
  const version = showDialog("Fresh pinned provider read", '<p>Reading the displayed repository/PR/exact head…</p>'), result = await api(input);
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  providerResult(result, `Explicit owner ${input.action} for ${record.repositoryId} PR ${record.pullRequest}, head ${record.head}. No worker task/call identity or native read receipt is invented. Review refresh starts at page 1; continuation metadata remains in the result.`);
}
function providerInspect(key) {
  const { kind, record } = ownedProviderRecord(key);
  if (kind !== "writes") throw new Error("Effect inspection requires an original native write intent");
  const grant = providerBinding(record.scopeId), proposal = { projectId, key: record.key, record, repositoryId: grant.repositoryId, numericId: grant.numericId };
  showDialog("Inspect retained native effect?", `<p>Repository ${esc(grant.repositoryId)} (${grant.numericId})<br>Exact key ${esc(record.key)}. Only actual matching native evidence may settle the original record. Missing markers remain uncertain. No publication, rollback, replay or retry permission.</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><form data-provider-inspect data-project="${esc(projectId)}" data-key="${esc(record.key)}"><input type="hidden" name="confirm" value="${esc(projectId)}"><button type="submit">Inspect exact retained effect only</button></form>`);
  providerInspection = proposal; disableActions();
}
function providerKnown() {
  if (!plan || view.project.workspaceAuthorization?.provider !== "github" || view.project.archived || view.project.deleted) throw new Error("A current active GitHub scope is required. Arc remains deferred");
  const scopes = view.project.workspaceAuthorization.scopes.filter(scope => view.project.githubAuthorization?.some(grant => grant.repositoryId === scope.repositoryId));
  if (!scopes.length) throw new Error("No explicit GitHub repository/scope grant is available");
  showDialog("Explicit known PR/head inspection", `<p>Read-only owner inspection, not a model probe or native worker receipt. The host rechecks the complete repository/PR/head binding. No execution authority. Use continuation page metadata from earlier results for CI/review paging.</p><form data-provider-known data-project="${esc(projectId)}"><label>Current authorized scope<select name="scope">${scopes.map(scope => `<option value="${esc(scope.id)}">${esc(scope.repositoryId)} · ${esc(scope.id)}</option>`).join("")}</select></label><label>Known PR number<input name="pr" type="number" min="1" required></label><label>Exact known head SHA<input name="head" minlength="40" maxlength="64" pattern="(?:[a-f0-9]{40}|[a-f0-9]{64})" required autocomplete="off"></label><label>Read kind<select name="kind"><option value="pr">PR</option><option value="ci">CI</option><option value="review">Reviews/comments</option></select></label><label>CI/review page<input name="page" type="number" min="1" max="1000000" value="1" required></label><button type="submit">Read this exact binding</button></form>`); disableActions();
}
function lifecycleMore() {
  if (!plan) throw new Error("Lifecycle controls require a loaded Durable project");
  const p = view.project, choices = p.archived || p.deleted ? ["restore"] : ["archive", "delete"];
  showDialog("Retained project lifecycle", `<p>Project ${esc(p.name)} · ${esc(projectId)}<br>State ${p.deleted ? "deleted from ordinary listing" : p.archived ? "archived" : view.paused ? "paused" : "active"}. No repository/provider cleanup is offered. Restore remains paused. Existing pause/resume controls keep their explicit recovery policy.</p>${choices.map(operation => `<button class="danger" data-action="lifecycle-confirm" data-project="${esc(projectId)}" data-operation="${operation}">${operation === "restore" ? "Restore retained metadata, remain paused" : operation === "delete" ? "Delete from listing, retain work" : "Archive, retain work"}</button>`).join("")}`);
}
function lifecycleConfirm(id, operation) {
  requireProject(id);
  if (!plan || !["archive", "delete", "restore"].includes(operation)) throw new Error("Unknown Durable lifecycle action");
  const inactive = view.project.archived || view.project.deleted;
  if (operation === "restore" ? !inactive : inactive) throw new Error("Project lifecycle state changed; reopen its controls");
  const consequence = operation === "restore" ? "Restore retained metadata. Remain paused; no work is resumed or replayed." : operation === "archive" ? "Pause and archive the project. Conversations, receipts, repository changes, allocated workspaces and remote PRs remain." : "Pause and remove the project from ordinary listing. All project data, repository changes, allocated workspaces and remote PRs remain. Use its known UUID to reopen/restore later.";
  showDialog(`Confirm ${operation}`, `<p>${esc(consequence)}</p><p>Project ${esc(view.project.name)}<br>ID ${esc(id)}. This performs no filesystem/provider cleanup.</p><form data-lifecycle-change data-project="${esc(id)}" data-operation="${operation}"><input type="hidden" name="confirm" value="${esc(id)}"><button type="submit" class="danger">Confirm ${operation} only</button></form>`); disableActions();
}
async function routineList(lens = "schedules", offset = 0) {
  if (lens === "history") return routineHistory("intents", 0, 0);
  if (!plan || !["schedules", "monitors"].includes(lens) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Routine view requires a loaded Durable project and valid cached page");
  const id = projectId, current = generation, version = showDialog("Retained Durable routines", '<p>Reading owned definitions, admission metadata and plan policy…</p>');
  const [schedules, monitors, policy] = await Promise.all([api({ action: "schedule-snapshot", id, includeHistory: false }), api({ action: "monitor-snapshot", id }), api({ action: "plan-snapshot", id })]);
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!schedules || typeof schedules.eventOptIn !== "boolean" || ![null, "uncertain-provider-write", "uncertain-command"].includes(schedules.automaticAdmissionBlocker) || !Array.isArray(schedules.schedules) || !Array.isArray(schedules.events) || !Array.isArray(schedules.intents) || schedules.events.length || schedules.intents.length || schedules.historyIncluded !== false || !Number.isSafeInteger(schedules.historyCounts?.events) || schedules.historyCounts.events < 0 || !Number.isSafeInteger(schedules.historyCounts?.intents) || schedules.historyCounts.intents < 0 || schedules.schedules.some(record => record.projectId !== id || typeof record.id !== "string" || !record.id || typeof record.enabled !== "boolean" || !["once", "interval", "calendar"].includes(record.kind) || typeof record.text !== "string") || !monitors || !Array.isArray(monitors.items) || monitors.items.some(record => !uuid(record.id) || typeof record.enabled !== "boolean" || !["pr", "ci", "review"].includes(record.kind) || typeof record.repositoryId !== "string" || !Number.isSafeInteger(record.expectedRepositoryId) || record.expectedRepositoryId < 1 || !Number.isSafeInteger(record.pullRequest) || record.pullRequest < 1) || !policy || typeof policy.paused !== "boolean" || typeof policy.pausing !== "boolean") throw new Error("Invalid owned routine projection");
  routineCache = { project: id, schedules, monitors, policy };
  const button = (label, nextLens, nextOffset = 0) => `<button data-action="routine-list" data-project="${esc(id)}" data-lens="${nextLens}" data-offset="${nextOffset}">${label}</button>`;
  const controls = `<div class="row">${button("Schedules", "schedules")}${button("GitHub monitors", "monitors")}${button(`Paged history: ${schedules.historyCounts.events} events / ${schedules.historyCounts.intents} intents`, "history")}</div>`;
  const optIn = `<button data-action="routine-confirm" data-project="${esc(id)}" data-kind="events" data-record="" data-enabled="${!schedules.eventOptIn}">${schedules.eventOptIn ? "Disable" : "Separately opt into"} events</button>`;
  let body;
  {
    const records = lens === "schedules" ? schedules.schedules : monitors.items, page = records.slice(offset, offset + 100);
    body = `<h3>${lens} ${offset + (page.length ? 1 : 0)}-${offset + page.length}/${records.length}</h3><p>This pages a sampled full snapshot locally, not server-side history. Definitions are immutable by ID; enable/disable is separate.</p><div class="row">${offset ? button("Previous", lens, Math.max(0, offset - 100)) : ""}${offset + page.length < records.length ? button("Next", lens, offset + page.length) : ""}${button("Reread", lens, offset)}</div>${page.map(record => `<article class="task"><h3>${esc(record.kind)} ${esc(record.id)}</h3><p>${record.enabled ? "Enabled" : "Disabled"}</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><button data-action="routine-confirm" data-project="${esc(id)}" data-kind="${lens === "schedules" ? "schedule" : "monitor"}" data-record="${esc(record.id)}" data-enabled="${!record.enabled}">Inspect and confirm ${record.enabled ? "disable" : "enable"}</button></article>`).join("") || '<p>No retained definitions.</p>'}`;
  }
  dialog.querySelector(".dialog-body").innerHTML = `<p>Plan ${policy.paused || policy.pausing ? "paused/draining" : "open"}. Events ${schedules.eventOptIn ? "opted in" : "off"}. Automatic admission blocker: ${esc(schedules.automaticAdmissionBlocker ?? "none recorded")}. These separate snapshot reads are not an atomic current-state guarantee.</p><p>No client-created timers or polling; existing authorized backend routines may continue. Creation uses stable-ID CLI commands and starts disabled. Arc monitoring remains deferred. Your Mac must stay awake.</p>${controls}${optIn}${body}`;
  disableActions();
}
function validateRoutineRange(text, range, requested) {
  if (typeof text !== "string" || !range || ![range.offset, range.end, range.total].every(value => Number.isSafeInteger(value) && value >= 0) || !/^[a-f0-9]{64}$/.test(range.sha256) || range.offset !== Math.min(requested, range.total) || range.end < range.offset || range.end > range.total || range.end - range.offset !== Array.from(text).length || range.end - range.offset > 4000 || range.nextOffset !== (range.end < range.total ? range.end : null)) throw new Error("Routine history text range differs from its excerpt");
  return range.nextOffset;
}
async function routineHistory(kind = "intents", offset = 0, textOffset = 0) {
  if (!plan || !["events", "intents"].includes(kind) || ![offset, textOffset].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error("Routine history requires a loaded owned project and valid page");
  const id = projectId, current = generation, version = showDialog("Bounded retained routine history", '<p>Reading sampled owner-backed history without replay…</p>');
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
  const button = (label, nextKind, nextOffset, nextText) => `<button data-action="routine-history" data-project="${esc(id)}" data-kind="${nextKind}" data-offset="${nextOffset}" data-text-offset="${nextText}">${label}</button>`;
  const nextText = continuations.length ? Math.min(...continuations) : null;
  dialog.querySelector(".dialog-body").innerHTML = `<p>Sampled ${esc(new Date(page.observedAtMs).toLocaleString())}. Pages are live observations, not a stable historical cursor. Full-text SHA-256 identifies recorded text; these excerpts cannot prove the full hash or external effects. No replay is permitted here.</p><h3>${kind} ${offset + (page.items.length ? 1 : 0)}-${offset + page.items.length}/${page.total}</h3><div class="row">${button("Events", "events", 0, 0)}${button("Intents", "intents", 0, 0)}${offset ? button("Previous records", kind, Math.max(0, offset - 30), 0) : ""}${page.nextOffset !== null ? button("Next records", kind, page.nextOffset, 0) : ""}${textOffset ? button("Previous text", kind, offset, Math.max(0, textOffset - 4000)) : ""}${nextText !== null ? button("Next text excerpts", kind, offset, nextText) : ""}${button("Reread this slice", kind, offset, textOffset)}</div><button data-action="routine-list" data-project="${esc(id)}">Return to routine definitions</button>${page.items.map(item => `<article class="task"><h3>${esc(item.requestId)}</h3><pre>${esc(JSON.stringify(item, null, 2))}</pre></article>`).join("") || '<p>No retained records in this sampled page.</p>'}`;
  disableActions();
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
  const binding = JSON.stringify(record);
  const version = showDialog("Confirm routine setting", `<p>Project ${esc(id)}. ${enabled ? "Enable" : "Disable"} ${esc(kind)} ${esc(recordId)}.</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><p>Enabling permits future authorized work/polling while awake. It does not resume, grant tools/publication, clear uncertainty or replay retained intents. Monitors need separate event opt-in and current repository authorization. Disabling keeps ticks/cursors. Local confirmation pins this displayed snapshot, not a backend CAS.</p><form data-routine-change data-project="${esc(id)}"><input type="hidden" name="confirm" value="${esc(id)}"><button type="submit">Record this setting only</button></form>`);
  routineConfirmation = { project: id, kind, recordId, enabled, binding, version };
}
async function usageList(offset = 0) {
  if (!plan || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("Usage requires a loaded Durable project/valid page");
  const id = projectId, current = generation, coordinatorId = view.durableInspection?.identity.coordinatorConversationId, version = showDialog("Owner-backed usage", '<p>Reading existing SDK conversation counters…</p>');
  const page = await api({ action: "usage-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || page.offset !== offset || !Array.isArray(page.workers) || page.workers.length > 100 || !Number.isSafeInteger(page.totalWorkers) || page.totalWorkers < 0 || !page.coordinator || coordinatorId !== undefined && page.coordinator.conversationId !== coordinatorId || page.nextOffset !== null && (!page.workers.length || page.nextOffset !== offset + page.workers.length) || page.workers.some(worker => !["thread", "legacy"].includes(worker.kind) || worker.kind === "thread" && !uuid(worker.threadId) || !Number.isSafeInteger(worker.conversationId))) throw new Error("Usage projection differs from its owned conversation/page");
  const counters = value => {
    if (!value || [value.totalTokens, value.input, value.output, value.cacheRead, value.cacheWrite, value.cost?.total].some(number => typeof number !== "number" || !Number.isFinite(number) || number < 0)) throw new Error("Invalid SDK usage counters");
    return `Tokens ${value.totalTokens} · input ${value.input} · output ${value.output} · cache read ${value.cacheRead} · cache write ${value.cacheWrite} · SDK estimated cost ${value.cost.total}`;
  };
  const detail = value => `<p>${esc(counters(value.total))}</p><details><summary>Recorded model/tool breakdown</summary><pre>${esc(JSON.stringify({ models: value.models, tools: value.tools }, null, 2))}</pre></details>`;
  const button = (label, next) => `<button data-action="usage-list" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML = `<p>Observed ${esc(new Date(page.observedAtMs).toLocaleString())}. ${esc(page.accounting)}. SDK estimates are not billing or verified spend.</p><h3>Coordinator conversation ${esc(page.coordinator.conversationId)}</h3>${detail(page.coordinator)}<h3>Worker page ${offset + (page.workers.length ? 1 : 0)}-${offset + page.workers.length}/${page.totalWorkers}</h3><p>Registered reusable threads ${esc(page.totalThreads)} · legacy-only workers ${esc(page.legacyOnlyWorkers)}.</p><p>PAGE-ONLY worker total, not whole-project total: ${esc(counters(page.workerPageTotal))}</p><div class="row">${offset ? button("Previous workers", Math.max(0, offset - 100)) : ""}${page.nextOffset !== null ? button("Next workers", page.nextOffset) : ""}${button("Reread this page", offset)}</div>${page.workers.map(worker => `<article class="task"><h3>${worker.kind === "thread" ? `Thread ${esc(worker.threadId)}` : `Retained legacy worker ${esc(worker.name)}`}</h3><p>Conversation ${esc(worker.conversationId)}. Legacy names ${esc((worker.legacyNames ?? []).join(", ") || "none")}.</p>${detail(worker)}</article>`).join("")}`;
}
function validateSettings(value) {
  const v = value?.values;
  if (!value || !/^[a-f0-9]{64}$/.test(value.revision) || !v || [v.name, v.objective, v.model, v.models?.worker, v.models?.scout, v.models?.reviewer].some(text => typeof text !== "string") || !["read-only", "maintain"].includes(v.knowledgeAccess) || !["none", "coordinator"].includes(v.libraryAccess) || !["none", "coordinator"].includes(v.decisionAccess) || !Number.isSafeInteger(v.workerCap) || v.workerCap < 1 || v.workerCap > 32) throw new Error("Invalid settings snapshot/receipt");
}
function captureSettingsDraft() {
  const form = dialog.querySelector("[data-settings-edit]"), draft = form && settingsDrafts.get(`${form.dataset.project}:${form.dataset.field}`);
  if (draft) draft.text = form.querySelector('[name="text"]').value;
}
async function ownerSetupDialog(result = null) {
  const id = projectId, generationAtOpen = generation, version = showDialog("Owner setup", '<p class="note">Reading current owner bindings…</p>');
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const workspaces = (snapshot.workspace?.scopes || []).map(scope => `<article class="task"><strong>Scope ${esc(scope.id)}</strong><p>Repository ${esc(scope.repositoryId)} · ${scope.fileCount} files · base ${esc(scope.baseRevision)}</p><button class="danger" data-action="owner-setup-edit" data-kind="workspace-revoke" data-payload="${esc(JSON.stringify({ scopeId: scope.id, expectedRevision: snapshot.workspaceRevision }))}">Revoke scope</button></article>`).join("") || '<p class="note">No active workspace scopes.</p>';
  const github = (snapshot.github || []).map(auth => `<article class="task"><strong>${esc(auth.repositoryId)}</strong><p>Repository ID ${esc(auth.numericId)} · ${esc(auth.branchPrefix)} · base ${esc(auth.baseBranch)}</p><button class="danger" data-action="owner-setup-edit" data-kind="github-revoke" data-payload="${esc(JSON.stringify({ repositoryId: auth.repositoryId, expectedRevision: snapshot.githubRevision }))}">Revoke GitHub authorization</button></article>`).join("") || '<p class="note">No active GitHub authorizations.</p>';
  const profiles = (snapshot.profiles || []).map(profile => `<article class="task"><strong>${esc(profile.label)} · ${esc(profile.id)}</strong><p>${esc(profile.repositoryId)} · ${profile.enabled ? "enabled" : "disabled"} · ${esc(profile.blocker || "No reported blocker")}</p><button data-action="owner-profile-read" data-project="${esc(id)}" data-profile="${esc(profile.id)}">Read fixed argv and executable identity</button></article>`).join("") || '<p class="note">No fixed command profiles.</p>';
  const seeds = {
    "workspace-grant": { expectedRevision: snapshot.workspaceRevision, provider: "github", repositoryId: "", ownerCheckout: view.project.cwd, approvedRoot: "", fileOwnershipPrefix: "", files: [], baseRevision: "" },
    "github-authorize": { expectedRevision: snapshot.githubRevision, repositoryId: "", expectedRepositoryId: 0, branchPrefix: "" },
    "command-profile-set": { expectedRevision: snapshot.profilesRevision, profile: { id: crypto.randomUUID(), label: "", repositoryId: "", scopeIds: [], executable: "", arguments: [], effect: "workspace", timeoutMs: 300000, maxOutputBytes: 65536, enabled: false } },
  };
  const actions = [["workspace-grant", "Create workspace scope"], ["github-authorize", "Authorize GitHub target"], ["command-profile-set", "Register or disable fixed profile"]].map(([kind, label]) => `<button data-action="owner-setup-edit" data-kind="${kind}" data-payload="${esc(JSON.stringify(seeds[kind]))}">${label}</button>`).join("");
  const hist = `<p>Workspace revision ${esc(snapshot.workspaceRevision)} · GitHub revision ${esc(snapshot.githubRevision)} · profile revision ${esc(snapshot.profilesRevision)}</p><p class="notice">${esc(snapshot.configuredCatalog?.reason || "Configured skills unavailable")}. No Arc setup. Profile registration does not execute commands or approve deployment/destructive effects.</p>`;
  const whole = (snapshot.workspace?.scopes || []).find(scope => scope.wholeRepository);
  const connected = whole && (snapshot.github || []).find(auth => auth.repositoryId === whole.repositoryId);
  const githubCard = !whole ? "" : connected ? `<div class="card"><b>✓ GitHub connected</b><p class="note">Workers push ${esc(connected.branchPrefix)} branches to ${esc(connected.repositoryId)} and open draft PRs against ${esc(connected.baseBranch)}. You approve merges.</p></div>` : snapshot.githubQuick?.available ? `<div class="card"><b>GitHub</b><p class="note">Workers cannot open draft PRs yet.</p><button class="primary" data-action="github-quick">Connect GitHub</button></div>` : `<div class="card"><b>GitHub</b><p class="note">${esc(snapshot.githubQuick?.blocker || "One-click GitHub is unavailable")}</p></div>`;
  const quick = whole ? `<div class="card"><b>✓ Workers can edit this repository</b><p class="note">${esc(whole.repositoryId)} · new worker threads start from current HEAD.</p></div>${githubCard}` : snapshot.quickGrant?.available ? `<div class="card"><b>Workspace</b><p class="note">Workers cannot edit code yet.</p><button class="primary" data-action="workspace-quick">Let workers edit this repo</button></div>` : `<div class="card"><b>Workspace</b><p class="note">${esc(snapshot.quickGrant?.blocker || "One-click access is unavailable")}</p></div>`;
  dialog.querySelector(".dialog-body").innerHTML = `${result ? `<p class="notice">Host response: ${esc(JSON.stringify(result))}</p>` : ""}${quick}<details class="advanced"><summary>Advanced: folder-limited scopes, GitHub, command profiles</summary>${hist}<form data-owner-github-inspect data-project="${esc(id)}"><label><span>Exact owner/repository, matching the checkout's GitHub origin</span><input name="repositoryId" placeholder="owner/repository" required></label><button type="submit">Read GitHub numeric ID and default branch</button></form><div class="row">${actions}</div><h3>Workspace scopes</h3>${workspaces}<h3>GitHub authorizations</h3>${github}<h3>Fixed profiles</h3>${profiles}</details><button data-action="owner-setup">Refresh</button>`;
}

async function workspaceQuickDialog() {
  const id = projectId, generationAtOpen = generation, version = showDialog("Let workers edit this repo", '<p class="note">Reading the project checkout…</p>');
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen) return;
  const quick = snapshot.quickGrant;
  if (!quick?.available) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(quick?.blocker || "One-click access is unavailable")}</p><button data-action="owner-setup">Open owner setup</button>`; return; }
  dialog.querySelector(".dialog-body").innerHTML = `<div class="kv"><span>Repository</span><b>${esc(quick.repositoryId)}</b><span>Checkout</span><b class="mono">${esc(quick.ownerCheckout)}</b><span>Worker copies</span><b class="mono">${esc(quick.approvedRoot)}</b><span>Current HEAD</span><b class="mono">${esc(quick.head.slice(0, 12))}</b></div>
<ul><li>Each worker gets its own git worktree, starting from HEAD at the time it starts.</li><li>Workers may read, edit and create any file except VCS metadata (.git). Your checkout is never written.</li><li>Workers may run repository commands in their isolated worktree. Draft PRs need GitHub (step 2); merges always need your approval.</li></ul>${quick.dirty ? '<p class="notice">Your checkout has uncommitted changes. Workers will not see them.</p>' : ""}
<div class="row"><button class="primary" data-action="workspace-quick-confirm" data-project="${esc(id)}" data-revision="${esc(snapshot.workspaceRevision)}">Confirm</button><button data-action="close-dialog">Cancel</button></div>`;
}

async function workspaceQuickConfirm(target, revision) {
  requireProject(target);
  await mutate({ action: "workspace-quick-grant", id: target, confirm: target, expectedRevision: revision }, "Workers can now edit this repository.");
  if (projectId === target && dialog.open) await ownerSetupDialog();
}
async function githubQuickDialog() {
  const id = projectId, generationAtOpen = generation, version = showDialog("Connect GitHub", '<p class="note">Reading the repository from GitHub…</p>');
  const stale = () => !dialog.open || version !== dialogVersion || projectId !== id || generation !== generationAtOpen;
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (stale()) return;
  const quick = snapshot.githubQuick;
  if (!quick?.available) { dialog.querySelector(".dialog-body").innerHTML = `<p>${esc(quick?.blocker || "One-click GitHub is unavailable")}</p><button data-action="owner-setup">Open owner setup</button>`; return; }
  let remote;
  try { remote = await api({ action: "github-repository-inspect", id, repositoryId: quick.repositoryId }); }
  catch (error) { if (!stale()) dialog.querySelector(".dialog-body").innerHTML = `<p>gh could not read ${esc(quick.repositoryId)}: ${esc(error.message)}</p><p class="note">Run <code>gh auth login</code>, then try again.</p>`; return; }
  if (stale()) return;
  dialog.querySelector(".dialog-body").innerHTML = `<div class="kv"><span>Repository</span><b>${esc(remote.repositoryId)}</b><span>Repository ID</span><b class="mono">${esc(remote.numericId)}</b><span>Draft PRs target</span><b class="mono">${esc(remote.defaultBranch)}</b><span>Worker branches</span><b class="mono">${esc(quick.branchPrefix)}…</b></div>
<ul><li>Each worker commits and pushes only its own ${esc(quick.branchPrefix)} branch.</li><li>The host checks that the pushed branch matches the worker's HEAD, then opens or updates a draft PR against ${esc(remote.defaultBranch)}.</li><li>Workers can read PRs, CI results and reviews, and reply to review comments.</li><li>Merges always need your approval.</li></ul>
<div class="row"><button class="primary" data-action="github-quick-confirm" data-project="${esc(id)}" data-revision="${esc(snapshot.githubRevision)}">Confirm</button><button data-action="close-dialog">Cancel</button></div>`;
}

async function githubQuickConfirm(target, revision) {
  requireProject(target);
  await mutate({ action: "github-quick-authorize", id: target, confirm: target, expectedRevision: revision }, "GitHub connected. Workers can open draft PRs.");
  if (projectId === target && dialog.open) await ownerSetupDialog();
}
async function ownerSetupEdit(kind, payload) {
  if (!view) throw new Error("Select a project before owner setup");
  const target = projectId, currentGeneration = generation;
  let initial;
  try { initial = JSON.parse(payload); } catch { throw new Error("Owner setup seed is invalid"); }
  const candidates = "";
  if (projectId !== target || generation !== currentGeneration) return;
  showDialog(`Owner setup · ${kind}`, `<p>Project ${esc(target)}. Edit only the action fields. The host checks the inspected revision and immutable identities. Owner confirmation is required below for each write and is never saved in the draft.</p>${candidates}<form data-owner-write data-kind="${esc(kind)}" data-project="${esc(target)}"><label><span>API fields as JSON</span><textarea name="payload" required spellcheck="false">${esc(JSON.stringify(initial, null, 2))}</textarea></label>${kind.endsWith("-revoke") ? `<input type="hidden" name="confirm" value="${esc(target)}">` : ""}<button class="danger" type="submit">Confirm</button><p>Cancel leaves authority unchanged. Workspace/GitHub revocation stops future admissions. Retained receipts and history remain.</p></form>`);
}

async function ownerProfileRead(target, profileId) {
  requireProject(target);
  const generationAtOpen = generation, version = showDialog("Fixed command profile", '<p class="note">Reading the exact owner-defined executable and argv…</p>');
  const profile = await api({ action: "command-profile-read", id: target, profileId });
  if (projectId !== target || generation !== generationAtOpen || !dialog.open || dialogVersion !== version) return;
  dialog.querySelector(".dialog-body").innerHTML = `<p>Fixed owner configuration only. The model cannot supply executable, argv, cwd or environment. This definition does not approve deployment/destructive execution.</p><pre>${esc(JSON.stringify(profile, null, 2))}</pre><button data-action="owner-setup">Back to owner setup</button>`;
}

async function settingsList() {
  if (!plan) throw new Error("Settings require a loaded Durable project");
  const id = projectId, current = generation, version = showDialog("Project settings", '<p>Reading revision-checked project defaults…</p>');
  const value = await api({ action: "settings-snapshot", id });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  validateSettings(value); settingsCache = { ...value, projectId: id }; modelCache.clear();
  const choices = { knowledgeAccess: ["read-only", "maintain"], libraryAccess: ["none", "coordinator"], decisionAccess: ["none", "coordinator"], workerCap: Array.from({ length: 32 }, (_, i) => String(i + 1)) };
  dialog.querySelector(".dialog-body").innerHTML = `<p>Revision ${esc(value.revision)}. Updates require an idle Durable project and explicit confirmation. Existing threads retain frozen models/instructions. Knowledge/library/question grants are separate from execution authority. knowledgeAccess gates workers only; the coordinator always maintains knowledge.</p><details><summary>Current defaults</summary><pre>${esc(JSON.stringify(value.values, null, 2))}</pre></details><div class="row">${["name", "objective"].map(field => `<button data-action="settings-edit" data-project="${esc(id)}" data-field="${field}">Edit ${field}${settingsDrafts.has(`${id}:${field}`) ? " retained draft" : ""}</button>`).join("")}</div><h3>Models for new threads/defaults</h3>${["coordinator", "worker", "scout", "reviewer"].map(role => `<p>${role}: ${esc(role === "coordinator" ? value.values.model : value.values.models[role])} <button data-action="settings-models" data-project="${esc(id)}" data-role="${role}" data-revision="${esc(value.revision)}">Choose offline catalog entry</button></p>`).join("")}<h3>Explicit grants and hard concurrency</h3>${Object.entries(choices).map(([field, options]) => `<form data-settings-choice data-project="${esc(id)}" data-field="${field}" data-revision="${esc(value.revision)}"><label>${field}<select name="value">${options.map(option => `<option value="${option}" ${String(value.values[field]) === option ? "selected" : ""}>${option}</option>`).join("")}</select></label><button type="submit">Review this single change</button></form>`).join("")}`;
  disableActions();
}
function settingsEdit(field) {
  if (!settingsCache || settingsCache.projectId !== projectId || !["name", "objective"].includes(field)) throw new Error("Reread the owned settings before editing");
  const key = `${projectId}:${field}`;
  let draft = settingsDrafts.get(key);
  if (!draft) { draft = { text: settingsCache.values[field], expectedRevision: settingsCache.revision }; settingsDrafts.set(key, draft); }
  if (!editableKnowledge(draft.text)) throw new Error("Control-bearing/invalid Unicode settings are read-only here; use the explicit API to repair them");
  persistBrowserDrafts();
  showDialog(`Edit project ${field}`, `<p>Original revision ${esc(draft.expectedRevision)}. ${draft.expectedRevision !== settingsCache.revision ? "Retained draft conflicts with the last read revision. Saving still uses the original revision, never a silently rebased value." : "Changes affect defaults, not frozen thread instructions."}</p><form data-settings-edit data-project="${esc(projectId)}" data-field="${field}"><label>${field}<textarea name="text" rows="${field === "name" ? 2 : 12}" maxlength="32000" ${field === "name" ? "required" : ""}>${esc(draft.text)}</textarea></label><button type="submit">Review exact change</button></form><div class="row"><button data-action="settings-list">Reread without discarding draft</button><button data-action="settings-discard" data-project="${esc(projectId)}" data-field="${field}">Discard retained draft, explicit confirmation</button></div>`); disableActions();
}
function settingsDiscard(id, field) {
  requireProject(id);
  if (!["name", "objective"].includes(field) || !settingsCache || settingsCache.projectId !== id) throw new Error("Reread the owned settings before discarding a draft");
  const draft = settingsDrafts.get(`${id}:${field}`);
  if (!draft) throw new Error("No retained settings draft");
  showDialog("Discard retained settings draft?", `<p>This deletes only the unsent ${field} draft below. A new editor uses the last explicitly read settings revision, which the server still checks. No settings update happens here.</p><pre>${esc(draft.text)}</pre><button class="danger" data-action="settings-confirm-discard" data-project="${esc(id)}" data-field="${field}">Discard and start from last read settings</button>`);
}
async function settingsModels(role, revision, offset = 0) {
  if (!["coordinator", "worker", "scout", "reviewer"].includes(role) || !settingsCache || settingsCache.projectId !== projectId || settingsCache.revision !== revision || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("Reread the intended settings/model page");
  const id = projectId, current = generation, version = showDialog(`${role} model catalog`, '<p>Reading installed model and credential-status metadata without model/network probes…</p>');
  const page = await api({ action: "models-snapshot", offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== projectId || current !== generation) return;
  if (!page || page.offset !== offset || page.networkChecked !== false || !Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || page.total < 0 || page.nextOffset !== null && (!page.items.length || page.nextOffset !== offset + page.items.length) || page.items.some(model => typeof model.reference !== "string" || typeof model.name !== "string" || typeof model.configured !== "boolean")) throw new Error("Invalid offline model catalog");
  modelCache.clear(); for (const model of page.items) modelCache.set(model.reference, { ...model, projectId: id, role, revision });
  const button = (label, next) => `<button data-action="settings-models" data-project="${esc(id)}" data-role="${role}" data-revision="${esc(revision)}" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML = `<p>Entries ${offset + (page.items.length ? 1 : 0)}-${offset + page.items.length}/${page.total}. Offline metadata only. Configured credentials do not prove connectivity, quota or default transport. Existing threads retain their frozen model.</p><div class="row">${offset ? button("Previous models", Math.max(0, offset - 100)) : ""}${page.nextOffset !== null ? button("Next models", page.nextOffset) : ""}</div>${page.items.map(model => `<article class="task"><strong>${esc(model.name)}</strong><p>${esc(model.reference)} · credentials ${model.configured ? "configured, untested" : "missing"}</p><button data-action="settings-model" data-project="${esc(id)}" data-role="${role}" data-revision="${esc(revision)}" data-reference="${esc(model.reference)}" ${model.configured ? "" : "disabled"}>Review model default change</button></article>`).join("")}`;
}
function settingsReview(revision, changes, draftKey = null) {
  if (!settingsCache || settingsCache.projectId !== projectId || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("Reopen the owned settings proposal");
  const proposal = { projectId, revision, changes, draftKey };
  showDialog("Confirm exact project setting change", `<p>Project ${esc(projectId)}<br>Expected revision ${esc(revision)}. A conflict retains drafts and does not retry/rebase. Changes require host idle/compatibility checks. No model request, shell, publication or merge is authorized here.</p><pre>${esc(JSON.stringify(changes, null, 2))}</pre><form data-settings-confirm data-project="${esc(projectId)}" data-revision="${esc(revision)}"><input type="hidden" name="confirm" value="${esc(projectId)}"><button type="submit">Save exact revision-checked change</button></form>`);
  settingsConfirmation = proposal; disableActions();
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
  const id = projectId, current = generation, version = showDialog("All retained approvals", '<p>Reading bound operation records…</p>');
  const page = await api({ action: "operation-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || current !== generation || id !== projectId) return;
  validateOperations(page, id, offset);
  for (const record of page.items) operationCache.set(record.id, record);
  dialog.querySelector(".dialog-body").innerHTML = `<p>Records ${offset + (page.items.length ? 1 : 0)}-${offset + page.items.length}/${page.total}. Decisions are retained, not upgraded.</p><div class="row">${offset ? `<button data-action="operation-list" data-offset="${Math.max(0, offset - 100)}">Previous records</button>` : ""}${page.nextOffset !== null ? `<button data-action="operation-list" data-offset="${page.nextOffset}">Next records</button>` : ""}</div>${page.items.map(record => `<article class="task">${badge(record.status)}<strong>${esc(record.operation.provider)} ${esc(record.operation.kind)} · ${esc(record.operation.repositoryId)}</strong><p>${esc(record.id)} · ${record.scopeCurrent ? "current scope" : "scope changed"}</p><button data-action="operation-view" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}">Inspect exact binding</button></article>`).join("")}`;
}
function operationView(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== projectId || record.fingerprint !== fingerprint) throw new Error("Unknown owned operation record");
  showDialog("Exact operation binding", operationLetter(record)); disableActions();
}
function operationDecision(id, fingerprint, mode) {
  const record = ownedOperation(id, fingerprint);
  if (record.status !== "pending" || !["plain", "execution", "reject"].includes(mode) || mode === "execution" && !executionConsentAvailable(record)) throw new Error("This immutable/deferred operation cannot accept that decision");
  showDialog(mode === "execution" ? "Permit exact executor?" : mode === "plain" ? "Approve record only?" : "Reject permanently?", `<pre>${esc(JSON.stringify(record, null, 2))}</pre><p>${mode === "execution" ? "This permits the exact recorded executor, including its bound effect. It does not execute it here." : "This records a decision only. It does not authorize execution or perform a remote effect."}</p><form data-operation-decision data-project="${esc(projectId)}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}" data-decision="${esc(mode)}">${mode !== "reject" ? `<input type="hidden" name="confirm" value="${esc(projectId)}">` : ""}<button type="submit" class="danger">Confirm this exact decision</button></form>`); disableActions();
}
function operationExecution(id, fingerprint, inspect = false) {
  const record = ownedOperation(id, fingerprint);
  if (!mergeExecutionAvailable(record)) throw new Error("Only a separately executable exact-head GitHub merge can run here");
  showDialog(inspect ? "Inspect this original merge outcome?" : "Execute this exact-head merge?", `<pre>${esc(JSON.stringify(record, null, 2))}</pre><p>${inspect ? "Read the original bound outcome. Positive matching evidence may settle its journal; missing evidence remains uncertain. This does not merge, replay or grant another attempt." : "This can change the remote repository. The executor rechecks repository/scope/head. Uncertain effects are not replayed automatically."} No command, deployment, Arc or auto-merge execution through this control.</p><form data-operation-execute data-mode="${inspect ? "inspect" : "execute"}" data-project="${esc(projectId)}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"><input type="hidden" name="confirm" value="${esc(projectId)}"><button type="submit" class="danger">${inspect ? "Inspect original outcome only" : "Execute bound merge"}</button></form>`); disableActions();
}
function uuid(value) { return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value); }
function requireProject(id) { if (id !== projectId) throw new Error("Selected project changed. Reopen the intended control."); }
function closeCurrentDialog(id, version) { if (projectId === id && dialogVersion === version) closeDialog(); }
function requireThread(id) { if (!uuid(id) || !plan?.work.some(work => work.threadId === id)) throw new Error("Unknown owned reusable thread in the current plan"); }
function workLine(work, detail) {
  return `<button class="worker-line ${esc(work.status)}" data-action="thread" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}" title="${esc(work.text)}"><span class="dot"></span><span class="worker-title">${esc(clip(work.text.replace(/\s+/g, " ").trim(), 60))}</span><small class="worker-meta"><span class="worker-role">${esc(work.role)}</span> · <span class="worker-status">${esc(work.status)}</span>${detail ? ` · <span class="worker-detail">${esc(detail)}</span>` : ""}</small></button>`;
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
  target.innerHTML = `<div class="thread-head"><div class="grow"><div class="row thread-title">${badge(work?.status ?? "unknown")}<b>${esc(role[0].toUpperCase() + role.slice(1))}</b><small>${esc(work?.attempt?.model ?? "")}</small></div><p class="thread-task clamp" data-action="toggle-clamp" title="Show the full task">${esc(work?.text ?? "")}</p></div><button class="ghost small" data-action="thread-close" aria-label="Close thread">✕</button></div><div id="worker-messages" class="transcript" aria-live="polite"></div><div id="worker-history-pages" class="row"></div><form class="composer" data-inline-thread-send data-project="${esc(chat.id)}" data-thread="${esc(threadId)}"><textarea name="message" aria-label="Message worker" required maxlength="32000" rows="2" placeholder="Follow up with this ${esc(role)}…">${esc(draft?.text ?? "")}</textarea><div class="row between"><small>Reuses this ${esc(role)}'s conversation · Enter to send</small><button class="primary" type="submit">Send</button></div></form><details class="worker-controls"><summary>Evidence, changes and controls</summary><div id="worker-evidence"></div><p class="note">Thread ${esc(threadId)} · Conversation ${esc(page.conversationId)}. Scope, model and tools stay frozen; history, partial files and receipts are kept.</p><div class="row"><button data-thread-mutation data-action="thread-steer" data-project="${esc(chat.id)}" data-thread="${esc(threadId)}">Steer…</button><button data-thread-mutation class="danger" data-action="thread-stop" data-project="${esc(chat.id)}" data-thread="${esc(threadId)}">Stop…</button></div></details>`;
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
