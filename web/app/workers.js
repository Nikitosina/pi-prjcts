import {
  api,
  bumpDialogVersion,
  captureDrafts,
  closeCurrentDialog,
  closeDialog,
  dialog,
  dialogVersion,
  draftPairs,
  draftText,
  getGeneration,
  getProjectId,
  getView,
  initial,
  isBusy,
  mutate,
  onBusyChange,
  onProjectChange,
  onRender,
  onTab,
  persistBrowserDrafts,
  persistDraftsSafely,
  registerActions,
  registerDrafts,
  registerForms,
  render,
  report,
  requireProject,
  setHtml,
  setTab,
  showDialog,
  submitOnEnter,
  tab,
} from "./shell.js";
import { badge, clip, esc, uuid } from "./format.js";
import { admissionBlocked, chatId, chatMessageHtml, ensureChanges, stateDot } from "./chat.js";
import { jobsSnap, setJobsSnap } from "./decisions.js";
import { artifactButton, lightbox, loadWorkerArtifacts, renderArtifactBrowser } from "./artifacts.js";
import { refMenu } from "./composer.js";
import { focusNode, setWorkerFocus, workerFocus } from "./search.js";
import { bindTranscript, displayMessages, hydrate, loadOlder, mergeNewest, reach } from "./transcript.js";

const formDrafts = new Map();
export let workerChat = null;
export let allJobs = false;
// The worker view: a main-area page for one worker (?worker=<threadId>) that replaces the coordinator chat until Back or Escape.
const threadPane = document.querySelector("#inline-thread");
export let pendingWorker = /^[a-f0-9-]{36}$/.test(initial.searchParams.get("worker") ?? "") ? initial.searchParams.get("worker") : null;
function setWorkerUrl(threadId) {
  const url = new URL(location.href),
    had = url.searchParams.has("worker");
  if (threadId) url.searchParams.set("worker", threadId);
  else url.searchParams.delete("worker");
  if (url.href !== location.href) {
    if (threadId && !had) history.pushState({ worker: true }, "", url);
    else history.replaceState(threadId ? history.state : null, "", url);
  }
}
function closeWorkerDetail() {
  workerChat = null;
  threadPane.hidden = true;
  threadPane.replaceChildren();
  setWorkerUrl(null);
  document.querySelector('[data-panel="coordinator"]').hidden = tab !== "coordinator";
}
window.addEventListener("popstate", () => {
  const wanted = new URL(location.href).searchParams.get("worker");
  if (!wanted && workerChat) {
    closeWorkerDetail();
    ensureChanges();
    bumpDialogVersion();
    renderArtifactBrowser();
    render();
  } else if (wanted && workerChat?.threadId !== wanted && nodeInfo(wanted)) void inspectThread(wanted).catch(report);
});
onProjectChange(() => {
  workerChat = null;
  setJobsSnap(null);
  closeWorkerDetail();
  document.querySelector("#job-tree").replaceChildren();
});
onTab((next) => {
  if (next !== "coordinator" && workerChat) closeWorkerDetail();
  // The worker page replaces the coordinator chat panel while it is open.
  if (next === "coordinator") document.querySelector('[data-panel="coordinator"]').hidden = !threadPane.hidden;
});

onRender(renderJobTree);
// Stop stays available while paused (the host allows it); steer/send need an admitting project.
onBusyChange(() => {
  document
    .querySelectorAll(
      "#dialog [data-thread-mutation], #inline-thread [data-thread-mutation], [data-inline-thread-send] button, [data-inline-thread-send] textarea",
    )
    .forEach((node) => {
      node.disabled =
        isBusy() ||
        (node.dataset.action === "thread-stop"
          ? !getView() || getView().project.archived || getView().project.deleted
          : admissionBlocked());
    });
});

function textDialog(mode, id) {
  captureDrafts();
  const project = getProjectId(),
    draftKey = `${project}:${mode}:${id}`;
  const draft = formDrafts.get(draftKey) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
  formDrafts.set(draftKey, draft);
  const title = mode === "thread-send" ? "Follow up on this thread" : "Steer this thread";
  showDialog(
    title,
    `<form data-task-message data-project="${esc(project)}" data-draft-key="${esc(draftKey)}" data-mode="${esc(mode)}" data-id="${esc(id)}"><textarea name="message" aria-label="${title}" placeholder="Describe the instruction…" maxlength="32000" required>${esc(draft.text)}</textarea><div class="row signoff"><button class="primary" type="submit">Send</button></div><p class="notice signoff">${mode.startsWith("thread-") ? `This reuses the owned thread with frozen scope/model/tools. Request UUID ${esc(draft.requestId)}. Unresolved retries must keep the same text.` : ""}</p></form>`,
  );
  dialog.querySelector("textarea").focus();
}
// Outcome lines of Approve, kept for this page view: merge-uncertain and auto-merge-pending leave the Job Ready, so the line explains why.
const approveOutcomes = new Map();
export const approveLine = (jobId) => approveOutcomes.get(jobId) ?? null;
const openJobs = new Map();
registerActions({
  "job-toggle"(node) {
    openJobs.set(node.dataset.job, node.getAttribute("aria-expanded") !== "true");
    renderJobTree();
  },
  "all-jobs"() {
    allJobs = !allJobs;
    renderJobTree();
  },
  "thread-close"() {
    if (history.state?.worker) history.back();
    else {
      closeWorkerDetail();
      ensureChanges();
      bumpDialogVersion();
      renderArtifactBrowser();
      render();
    }
  },
  async thread(node) {
    requireProject(node.dataset.project);
    if (dialog.contains(node)) closeDialog();
    await inspectThread(node.dataset.thread);
  },
  async "thread-older"(node) {
    requireProject(node.dataset.project);
    const chat = workerChat;
    if (!chat || chat.threadId !== node.dataset.thread) return;
    await loadOlder(workerKey(chat), (before) =>
      api({ action: "thread-history", id: chat.id, threadId: chat.threadId, before, limit: 30 }),
    );
    await refreshWorkerChat(chat);
  },
  "thread-send"(node) {
    requireProject(node.dataset.project);
    requireAgent(node.dataset.thread);
    textDialog("thread-send", node.dataset.thread);
  },
  "thread-steer"(node) {
    requireProject(node.dataset.project);
    requireAgent(node.dataset.thread);
    textDialog("thread-steer", node.dataset.thread);
  },
  "thread-stop"(node) {
    requireProject(node.dataset.project);
    const info = requireAgent(node.dataset.thread);
    showDialog(
      "Stop this agent?",
      `<form data-thread-stop data-project="${esc(getProjectId())}" data-thread="${esc(info.id)}"><p>${esc(info.title)}. Its subagents and their background processes stop too. The conversation, files and proof stay.</p><label class="field"><span class="flabel">Why are you stopping it?</span><span class="fhelp">The reason is recorded on the Job and shown in the sidebar.</span><textarea name="reason" rows="3" maxlength="500" required aria-label="Reason for stopping"></textarea></label><div class="row signoff"><button class="danger" type="submit">Stop</button></div></form>`,
    );
    dialog.querySelector("textarea").focus();
  },
  async "job-approve"(node) {
    const id = node.dataset.project,
      jobId = node.dataset.job;
    requireProject(id);
    const job = jobsSnap?.jobs.find((item) => item.id === jobId);
    if (!job || !["ready", "ready-with-gaps"].includes(job.status))
      throw new Error("This Job is no longer ready; refresh before approving");
    const outcome = await mutate({ action: "job-approve", id, jobId }, (result) => result.line);
    approveOutcomes.set(jobId, outcome.line);
    render();
  },
});
registerForms([
  [
    "[data-thread-stop]",
    async (form) => {
      const id = form.dataset.project,
        version = dialogVersion,
        reason = new FormData(form).get("reason").trim();
      requireProject(id);
      if (!reason) throw new Error("Say why you are stopping it. Your text is kept.");
      await mutate({ action: "thread-stop", id, threadId: form.dataset.thread, reason }, "Stopped. History and files kept.");
      closeCurrentDialog(id, version);
    },
  ],
  [
    "[data-inline-thread-send]",
    async (form) => {
      const data = new FormData(form);
      if (isBusy() || admissionBlocked()) throw new Error("This project cannot accept a request now. Your draft was kept.");
      const target = form.dataset.project,
        threadId = form.dataset.thread;
      requireProject(target);
      requireAgent(threadId);
      const text = data.get("message");
      if (!text.trim()) return;
      const draftKey = `${target}:thread-send:${threadId}`;
      const draft = formDrafts.get(draftKey) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
      if (draft.submittedText !== null && draft.submittedText !== text)
        throw new Error("Prior thread submission is unresolved. Resend its exact text or inspect history before a different request");
      draft.text = text;
      draft.submittedText = text;
      formDrafts.set(draftKey, draft);
      persistBrowserDrafts();
      await mutate(
        { action: "thread-send", id: target, threadId, requestId: draft.requestId, text },
        "Instruction recorded on the existing thread.",
      );
      if (formDrafts.get(draftKey) === draft) {
        formDrafts.delete(draftKey);
        persistBrowserDrafts();
        if (getProjectId() === target && workerChat?.threadId === threadId) await inspectThread(threadId);
      }
    },
  ],
  [
    "[data-task-message]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const text = data.get("message");
      if (!text.trim()) return;
      const draft = formDrafts.get(form.dataset.draftKey);
      if (!draft) throw new Error("Form draft is missing; reopen the intended target");
      draft.text = data.get("message");
      if (form.dataset.mode !== "thread-send" && form.dataset.mode !== "thread-steer") throw new Error("Unknown message form");
      if (draft.submittedText !== null && draft.submittedText !== text)
        throw new Error("Prior thread submission is unresolved. Resend its exact text or inspect history before a different request");
      draft.submittedText = text;
      persistBrowserDrafts();
      await mutate(
        { action: form.dataset.mode, id: target, threadId: form.dataset.id, requestId: draft.requestId, text },
        "Instruction recorded on the existing thread.",
      );
      if (formDrafts.get(form.dataset.draftKey) === draft) {
        if (draft.text === data.get("message")) {
          formDrafts.delete(form.dataset.draftKey);
          closeCurrentDialog(target, version);
        } else {
          formDrafts.set(form.dataset.draftKey, { text: draft.text, requestId: crypto.randomUUID(), submittedText: null });
          if (getProjectId() === target && dialogVersion === version) textDialog(form.dataset.mode, form.dataset.id);
        }
      }
      persistBrowserDrafts();
    },
  ],
]);
document.addEventListener("input", (event) => {
  const form = event.target.closest("[data-task-message], [data-inline-thread-send]");
  if (!form) return;
  if (form.matches("[data-inline-thread-send]")) {
    const key = `${form.dataset.project}:thread-send:${form.dataset.thread}`;
    const draft = formDrafts.get(key) ?? { text: "", requestId: crypto.randomUUID(), submittedText: null };
    draft.text = form.querySelector("textarea").value;
    formDrafts.set(key, draft);
  } else {
    const draft = formDrafts.get(form.dataset.draftKey);
    if (draft) draft.text = form.querySelector("textarea").value;
  }
  persistDraftsSafely();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    workerChat &&
    !dialog.open &&
    !lightbox.open &&
    !refMenu &&
    !document.querySelector(".mp.open") &&
    !event.isComposing
  ) {
    event.preventDefault();
    document.querySelector('#inline-thread [data-action="thread-close"]')?.click();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  submitOnEnter(event, "[data-task-message] textarea, [data-inline-thread-send] textarea");
});
// What a thread id names: a Job's worker (its id), a subagent of a Job (`<job id>/<conversation id>`), or a scout/reviewer the coordinator spawned.
function nodeInfo(id) {
  if (!jobsSnap || typeof id !== "string") return null;
  const [agentId, childId] = id.split("/");
  const job = jobsSnap.jobs.find((item) => item.id === agentId);
  if (childId !== undefined) {
    const child = job?.children.find((item) => String(item.id) === childId);
    return child ? { id, kind: "subagent", job, role: child.role, title: child.title, working: child.working } : null;
  }
  if (job) return { id, kind: "worker", job, role: "worker", title: job.title, working: job.working };
  const agent = jobsSnap.agents.find((item) => item.id === agentId);
  return agent
    ? { id, kind: "agent", job: null, role: agent.role, title: agent.title, working: agent.working, ended: agent.endedAt !== null }
    : null;
}
function requireAgent(id) {
  const info = nodeInfo(id);
  if (!info || info.kind === "subagent")
    throw new Error("Only a Job's worker, a scout or a reviewer takes messages. Subagents are read-only");
  return info;
}
const finishedJob = (job) => job.status !== "running";
const jobProgress = (job) => (job.eta.total ? `${job.eta.done}/${job.eta.total}` : "no plan yet");
const jobEta = (job) => (job.status === "running" && job.eta.etaMin !== null ? `~${job.eta.etaMin}m left` : "");
// One word for each node, and the dot colour that goes with it.
function jobState(job) {
  if (job.status === "running")
    return job.stalledAt !== null
      ? { label: "stalled", dot: "needs" }
      : job.quota
        ? { label: "waiting for quota", dot: "working" }
        : { label: "running", dot: "working" };
  if (job.status === "failed") return { label: "failed", dot: "needs" };
  if (job.status === "stopped") return { label: "stopped", dot: "idle" };
  return { label: job.status === "ready-with-gaps" ? "ready, gaps" : job.status, dot: "done" };
}
const workerState = (job) =>
  job.status !== "running"
    ? jobState(job)
    : job.leaf !== null && job.leaf !== job.workerConversation
      ? { label: "waiting on a subagent", dot: "working" }
      : { label: job.working ? "working" : "idle", dot: job.working ? "working" : "idle" };
const subagentState = (child) => ({ label: child.working ? "working" : "done", dot: child.working ? "working" : "done" });
// Context use of the agents listed in the tree, read host-side; rows show nothing until a reading exists.
const workerContexts = new Map();
export async function loadWorkerContexts(current) {
  const ids = [...new Set([...document.querySelectorAll("#job-tree [data-context]")].map((node) => node.dataset.context))].slice(0, 40);
  if (!ids.length) return;
  const read = await api({ action: "worker-contexts", id: getProjectId(), threadIds: ids }).catch(() => null);
  if (!read || current !== getGeneration()) return;
  let changed = false;
  for (const [id, value] of Object.entries(read))
    if (value && JSON.stringify(workerContexts.get(id)) !== JSON.stringify(value)) {
      workerContexts.set(id, value);
      changed = true;
    }
  if (changed) renderJobTree();
}
// Small ring plus percent; a missing window is said so, never guessed.
function contextRing(context) {
  if (!context || context.tokens == null) return "";
  const percent = context.window ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : null;
  const level = percent === null ? "low" : percent >= 90 ? "high" : percent >= 70 ? "mid" : "low",
    c = 2 * Math.PI * 6;
  return `<span class="ctx-ring" data-level="${level}" title="${esc(contextLine(context))}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" class="track"/><circle cx="8" cy="8" r="6" class="fill" stroke-dasharray="${((c * (percent ?? 0)) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>${percent === null ? "window unknown" : `${percent}%`}</span>`;
}
// A node of the Jobs tree: status dot, name, then status, plan progress (done/total) and ETA.
function nodeRow({ id, role, title, state, job, withPlan, stop }) {
  const meta = [
    `<span class="job-status">${esc(state.label)}</span>`,
    ...(withPlan
      ? [
          `<span class="job-progress">${esc(jobProgress(job))}</span>`,
          ...(jobEta(job) ? [`<span class="job-eta">${esc(jobEta(job))}</span>`] : []),
        ]
      : []),
  ].join(" · ");
  const open = `<button type="button" class="job-open" data-action="thread" data-project="${esc(getProjectId())}" data-thread="${esc(id)}" title="${esc(title)}">${stateDot(state.dot, state.label, "state-dot")}<span class="job-name">${role ? `<span class="sub-label">${esc(role)}</span> ` : ""}${esc(clip(title.replace(/\s+/g, " ").trim(), 60))}</span><small class="job-meta">${meta}</small></button>`;
  // Context use belongs to the agent that owns a conversation: worker rows and loose scouts/reviewers.
  const measured = role && /^[a-f0-9-]{36}$/.test(id);
  const ring = measured ? contextRing(workerContexts.get(id)) : "";
  return `<div class="job-row" data-thread="${esc(id)}"${measured ? ` data-context="${esc(id)}"` : ""}>${open}${ring}${stop ? `<button type="button" class="ghost small job-stop" data-action="thread-stop" data-project="${esc(getProjectId())}" data-thread="${esc(id)}" aria-label="Stop ${esc(title)}">Stop…</button>` : ""}</div>`;
}
function jobHtml(job) {
  const expanded = openJobs.get(job.id) ?? job.status === "running",
    state = jobState(job);
  const reason = job.reason ? `<p class="job-reason">${esc(clip(job.reason, 200))}</p>` : "";
  const children = job.children
    .map((child) => nodeRow({ id: `${job.id}/${child.id}`, role: child.role, title: child.title, state: subagentState(child) }))
    .join("");
  return `<div class="job" data-job="${esc(job.id)}" data-status="${esc(job.status)}"><div class="job-head"><button type="button" class="job-toggle" data-action="job-toggle" data-job="${esc(job.id)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(job.title)}"><span aria-hidden="true">${expanded ? "▾" : "▸"}</span></button>${nodeRow({ id: job.id, title: job.title, state, job, withPlan: true, stop: job.status === "running" })}</div>${reason}${
    expanded
      ? `<div class="job-children">${nodeRow({ id: job.id, role: "worker", title: job.title, state: workerState(job), job, withPlan: true })}${children}</div>`
      : ""
  }</div>`;
}
const jobsByRecency = (jobs) =>
  jobs.toSorted((a, b) => Number(finishedJob(a)) - Number(finishedJob(b)) || (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
export function renderJobTree() {
  if (!getView()) return;
  const jobs = jobsByRecency(jobsSnap?.jobs ?? []);
  const shown = allJobs ? jobs : jobs.filter((job, index) => !finishedJob(job) || index < 8);
  const loose = (jobsSnap?.agents ?? []).filter((agent) => agent.jobId === null && agent.endedAt === null);
  const html = !jobsSnap
    ? '<p class="note">Reading Jobs…</p>'
    : (shown.map(jobHtml).join("") +
        loose
          .map((agent) =>
            nodeRow({
              id: agent.id,
              role: agent.role,
              title: agent.title,
              state: agent.working ? { label: "working", dot: "working" } : { label: "waiting", dot: "idle" },
              stop: true,
            }),
          )
          .join("") || '<p class="note">No Jobs yet. Ask the coordinator for something and it starts one.</p>') +
      (jobs.length > shown.length || allJobs
        ? `<button type="button" class="ghost small all-jobs" data-action="all-jobs">${allJobs ? "Show recent only" : `Show all Jobs (${jobs.length})`}</button>`
        : "");
  setHtml("#job-tree", html);
  void loadWorkerContexts(getGeneration());
}
function workerDetailHtml(chat, page, info) {
  const threadId = chat.threadId,
    draft = formDrafts.get(`${chat.id}:thread-send:${threadId}`),
    role = info.role;
  const data = `data-project="${esc(chat.id)}" data-thread="${esc(threadId)}"`;
  const state =
    info.kind === "worker"
      ? workerState(info.job)
      : info.kind === "subagent"
        ? subagentState(info)
        : { label: info.working ? "working" : "waiting", dot: "idle" };
  const takesMessages = info.kind !== "subagent",
    stoppable = takesMessages && (info.job ? info.job.status === "running" : !info.ended);
  const job = info.job;
  const plan = job?.plan.length
    ? `<ol class="job-plan">${job.plan.map((step) => `<li data-status="${esc(step.status)}"><span class="plan-mark" aria-hidden="true">${step.status === "done" ? "✓" : step.status === "doing" ? "…" : "○"}</span> ${esc(step.title)}${step.estimateMin ? ` <small>${step.estimateMin}m</small>` : ""}</li>`).join("")}</ol>`
    : "";
  const head = job
    ? `<p class="thread-task clamp" data-action="toggle-clamp" title="Show the full request">${esc(job.request)}</p><p class="job-summary-line"><span class="job-progress">${esc(jobProgress(job))}</span>${jobEta(job) ? ` · <span class="job-eta">${esc(jobEta(job))}</span>` : ""}${job.reason ? ` · <span class="job-reason-inline">${esc(job.reason)}</span>` : ""}</p>${plan}`
    : `<p class="thread-task clamp" data-action="toggle-clamp" title="Show the full task">${esc(info.title)}</p>`;
  const title =
    info.kind === "subagent" ? `${role[0].toUpperCase()}${role.slice(1)} of ${job.title}` : `${role[0].toUpperCase()}${role.slice(1)}`;
  return `<div class="worker-head"><button type="button" class="ghost small" data-action="thread-close" aria-label="Back to the coordinator chat">← Back</button><div class="row thread-title">${badge(job?.status ?? state.label)}<b>${esc(title)}</b><small>${esc(state.label)}</small></div><span id="worker-context" class="worker-context"></span><span class="row worker-actions">${takesMessages ? `<button data-thread-mutation data-action="thread-steer" ${data}>Steer…</button>` : ""}${stoppable ? `<button data-thread-mutation class="danger" data-action="thread-stop" ${data}>Stop…</button>` : ""}</span></div>${head}<p class="worker-latest" id="worker-latest"></p><details class="worker-convo" open><summary>Conversation</summary><div id="worker-messages" class="transcript" aria-live="polite"></div><div id="worker-history-pages" class="row"></div></details>${
    takesMessages
      ? `<form class="composer" data-inline-thread-send ${data}><textarea name="message" aria-label="Message ${esc(role)}" required maxlength="32000" rows="2" placeholder="Follow up with this ${esc(role)}…">${esc(draft?.text ?? "")}</textarea><div class="row between"><span class="row help-line"><small>Reuses this ${esc(role)}'s conversation</small><span class="help-wrap"><button type="button" class="ghost small help-btn" data-action="composer-help" aria-label="Composer help" aria-haspopup="dialog" aria-expanded="false">ⓘ</button><div class="help-pop" role="dialog" aria-label="Composer shortcuts" hidden></div></span></span><button class="primary" type="submit">Send</button></div></form><section class="artifact-pane" id="artifact-pane" aria-label="Worker artifacts"><div class="row between"><b>Artifacts <span id="artifact-count"></span></b><button class="ghost small" data-action="artifacts-sort" id="artifact-sort" title="Sort files">Newest</button></div><small id="artifact-summary" class="note"></small><input id="artifact-filter" type="search" placeholder="Filter by name…" aria-label="Filter artifacts" autocomplete="off"><div id="artifact-tree" class="artifact-tree"></div><div id="artifact-preview" class="artifact-preview" hidden></div></section>`
      : '<p class="note">Subagents are read-only. Message or stop the Job\'s worker instead.</p>'
  }<details class="worker-controls"><summary>Evidence and changes</summary><div id="worker-evidence"></div><p class="note">Thread ${esc(threadId)} · Conversation ${esc(page.conversationId)}. History, partial files and receipts are kept.</p></details>`;
}
export async function inspectThread(threadId) {
  const info = nodeInfo(threadId);
  if (!info) throw new Error("Unknown agent in the current Jobs");
  if (workerFocus?.threadId !== threadId) setWorkerFocus(null);
  const chat = { id: getProjectId(), generation: getGeneration(), threadId };
  workerChat = chat;
  const target = threadPane;
  target.hidden = false;
  target.innerHTML = '<p class="note">Reading transcript…</p>';
  setTab("coordinator");
  setWorkerUrl(threadId);
  document.querySelector(".body").scrollTop = 0;
  render();
  const version = bumpDialogVersion();
  const page = await workerChatPage(chat);
  if (workerChat !== chat || version !== dialogVersion || chat.generation !== getGeneration() || target.hidden) return;
  target.innerHTML = workerDetailHtml(chat, page, nodeInfo(threadId) ?? info);
  renderWorkerChat(chat, page, true);
  render();
}
// The newest page of the worker's conversation plus any older pages already loaded (see transcript.js).
const workerKey = (chat) => `${chat.id}/${chat.threadId}`;
async function workerChatPage(chat) {
  const page = await api({ action: "thread-history", id: chat.id, threadId: chat.threadId, limit: 30, context: true });
  if (!Array.isArray(page.items)) throw new Error("History does not match its owned thread/page");
  const held = mergeNewest(workerKey(chat), page);
  if (workerFocus?.threadId === chat.threadId && workerFocus.project === chat.id)
    await reach(workerKey(chat), workerFocus.index, (before) =>
      api({ action: "thread-history", id: chat.id, threadId: chat.threadId, before, limit: 30 }),
    );
  return { ...page, items: displayMessages(held.items), older: held.cursor !== null };
}
function contextLine({ tokens, window }) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));
  return tokens == null
    ? ""
    : window
      ? `Context ${k(tokens)} / ${k(window)} · ${Math.round((tokens / window) * 100)}%`
      : `Context ${k(tokens)} · window unknown`;
}
export async function refreshWorkerChat(chat) {
  const page = await workerChatPage(chat);
  if (workerChat !== chat || chat.generation !== getGeneration() || getProjectId() !== chat.id || threadPane.hidden) return;
  if (document.querySelector("#worker-messages")) renderWorkerChat(chat, page);
}
function renderWorkerChat(chat, page, opening = false) {
  const transcript = document.querySelector("#worker-messages");
  const atEnd = opening || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  const messages = page.items.map((message) => chatMessageHtml(message, "Worker")).join("") || '<p class="note">No messages yet.</p>';
  if (transcript.dataset.content !== messages) {
    transcript.innerHTML = messages;
    transcript.dataset.content = messages;
    if (atEnd) transcript.scrollTop = transcript.scrollHeight;
  }
  const lastTool = page.items.findLast((item) => item.kind === "tool");
  document.querySelector("#worker-latest").innerHTML = lastTool
    ? `Latest: <code>${esc(lastTool.name)}</code> ${esc(clip(lastTool.argsPreview ?? "", 90))}`
    : "";
  document.querySelector("#worker-context").innerHTML = contextRing(page.context);
  if (workerFocus?.threadId === chat.threadId && workerFocus.project === chat.id)
    focusNode(transcript.querySelector(`[data-index="${workerFocus.index}"]`), workerFocus);
  document.querySelector("#worker-history-pages").innerHTML = page.older
    ? `<button data-action="thread-older" data-project="${esc(chat.id)}" data-thread="${esc(chat.threadId)}">Older messages</button>`
    : "";
  bindTranscript(transcript, {
    text: (ref, offset) => api({ action: "transcript-text", id: chat.id, threadId: chat.threadId, ref, offset, limit: 20000 }),
    image: (ref) => api({ action: "transcript-image", id: chat.id, threadId: chat.threadId, ref }),
  });
  hydrate(transcript);
  document.querySelector("#worker-evidence").innerHTML = workerChanges(chat.threadId, page.items);
  if (document.querySelector("#artifact-pane")) void loadWorkerArtifacts(chat);
}
function workerChanges(threadId, items) {
  const linked = getView().evidence.filter((record) => record.native?.workId === threadId);
  const legacy = getView().evidence.some((record) => !record.native);
  const writes = items.filter((item) => item.kind === "tool" && /write|edit|patch|create|delete|move|rename/i.test(item.name ?? ""));
  const paths = writes.map((item) => {
    try {
      const args = JSON.parse(item.argsPreview);
      const path = args.path ?? args.file ?? args.filePath ?? args.filename;
      return typeof path === "string" ? esc(path) : esc(item.name);
    } catch {
      return esc(item.name);
    }
  });
  return `<section class="changes-evidence"><h4>Evidence</h4>${linked.map(artifactButton).join("") || '<p class="note">No evidence linked to this thread.</p>'}${legacy ? '<p class="note">Legacy evidence without native provenance stays unlinked.</p>' : ""}<h4>Files touched (from tool calls)</h4>${paths.length ? `<ul>${paths.map((path) => `<li>${path}</li>`).join("")}</ul>` : '<p class="note">No write/edit tool calls in this page.</p>'}</section>`;
}
registerDrafts({
  key: "forms",
  required: true,
  entries: () => [...formDrafts],
  validate(pairs) {
    if (
      !draftPairs(pairs) ||
      pairs.some(
        ([key, value]) =>
          !/^[a-f0-9-]{36}:(?:steer|revise|thread-send|thread-steer):[a-f0-9-]{36}$/.test(key) ||
          !value ||
          !draftText(value.text) ||
          !uuid(value.requestId) ||
          (value.submittedText !== null && !draftText(value.submittedText)),
      )
    )
      throw new Error("Malformed/oversized browser draft state. In-memory drafts retained without truncation");
  },
  restore(pairs) {
    for (const [id, value] of pairs) formDrafts.set(id, { ...value });
  },
  capture() {
    const form = dialog.querySelector("[data-task-message]");
    const draft = form && formDrafts.get(form.dataset.draftKey);
    if (draft) draft.text = form.querySelector("textarea").value;
  },
});
export function setPendingWorker(value) {
  return (pendingWorker = value);
}
// A subagent's transcript has no change feed of its own: re-read it while it is open and working.
setInterval(() => {
  if (document.hidden || !workerChat || !workerChat.threadId.includes("/") || workerChat.id !== getProjectId()) return;
  void refreshWorkerChat(workerChat).catch(() => {});
}, 4000);
