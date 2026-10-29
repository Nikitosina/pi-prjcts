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
import { badge, clip, duration, esc, uuid } from "./format.js";
import { admissionBlocked, chatId, chatMessageHtml, ensureChanges } from "./chat.js";
import { plan, setPlan } from "./decisions.js";
import { artifactButton, lightbox, loadWorkerArtifacts, renderArtifactBrowser } from "./artifacts.js";
import { refMenu } from "./composer.js";
import { verificationNote } from "./settings.js";
import { focusNode, setWorkerFocus, workerFocus } from "./search.js";
import { bindTranscript, displayMessages, hydrate, loadOlder, mergeNewest, reach } from "./transcript.js";

const formDrafts = new Map();
export let workerChat = null;
export let showArchived = false,
  allWork = false;
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
  } else if (wanted && workerChat?.threadId !== wanted && plan?.work.some((work) => work.threadId === wanted))
    void inspectThread(wanted).catch(report);
});
onProjectChange(() => {
  workerChat = null;
  setPlan(null);
  closeWorkerDetail();
  for (const selector of ["#activity", "#outcomes"]) document.querySelector(selector).replaceChildren();
});
onTab((next) => {
  if (next !== "coordinator" && workerChat) closeWorkerDetail();
  // The worker page replaces the coordinator chat panel while it is open.
  if (next === "coordinator") document.querySelector('[data-panel="coordinator"]').hidden = !threadPane.hidden;
});

function renderWork() {
  renderWorkers();
  setHtml("#outcomes", plan ? durableResults() : "");
}
onRender(renderWork);
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
registerActions({
  async "work-archive"(node) {
    const work = plan?.work.find((item) => item.id === node.dataset.work);
    if (node.dataset.project !== getProjectId() || !work || work.archived)
      throw new Error("Displayed work changed; refresh before archiving");
    await mutate({ action: "work-archive", id: getProjectId(), workIds: [work.id] }, "Work archived. Record and thread kept.");
  },
  "thread-list"() {
    threadList();
  },
  "all-work"() {
    allWork = !allWork;
    render();
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
    requireThread(node.dataset.thread);
    textDialog("thread-send", node.dataset.thread);
  },
  "thread-steer"(node) {
    requireProject(node.dataset.project);
    requireThread(node.dataset.thread);
    showDialog(
      "Steer this reusable thread?",
      `<p>Project ${esc(getProjectId())}. Thread ${esc(node.dataset.thread)}. The replacement is recorded before interruption; scope/model/tools stay frozen.</p><button data-action="confirm-thread-steer" data-project="${esc(getProjectId())}" data-thread="${esc(node.dataset.thread)}">Compose replacement</button>`,
    );
  },
  "confirm-thread-steer"(node) {
    requireProject(node.dataset.project);
    textDialog("thread-steer", node.dataset.thread);
  },
  "thread-stop"(node) {
    requireProject(node.dataset.project);
    requireThread(node.dataset.thread);
    showDialog(
      "Stop this reusable thread?",
      `<p>Conversation, receipts and partial files remain.</p><button class="danger" data-action="confirm-thread-stop" data-project="${esc(getProjectId())}" data-thread="${esc(node.dataset.thread)}">Stop thread ${esc(node.dataset.thread)}</button>`,
    );
  },
  async "confirm-thread-stop"(node) {
    const id = node.dataset.project,
      version = dialogVersion;
    requireProject(id);
    await mutate({ action: "thread-stop", id, threadId: node.dataset.thread }, "Thread stop recorded. History and work retained.");
    closeCurrentDialog(id, version);
  },
});
registerForms([
  [
    "[data-inline-thread-send]",
    async (form) => {
      const data = new FormData(form);
      if (isBusy() || admissionBlocked()) throw new Error("This project cannot accept a request now. Your draft was kept.");
      const target = form.dataset.project,
        threadId = form.dataset.thread;
      requireProject(target);
      requireThread(threadId);
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
document.querySelector("#show-archived").addEventListener("change", (event) => {
  setShowArchived(event.target.checked);
  if (getView()) render();
});
function requireThread(id) {
  if (!uuid(id) || !plan?.agents?.some((agent) => agent.id === id)) throw new Error("Unknown owned reusable thread in the current plan");
}
function workLine(work, detail) {
  return `<button class="worker-line ${esc(work.status)}" data-action="thread" data-project="${esc(getProjectId())}" data-thread="${esc(work.threadId)}" title="${esc(work.text)}"><span class="dot"></span><span class="worker-title">${work.parentThreadId ? '<span class="sub-label">sub-agent</span> ' : ""}${esc(clip(work.text.replace(/\s+/g, " ").trim(), 60))}</span><small class="worker-meta"><span class="worker-role">${esc(work.role)}</span> · <span class="worker-status">${esc(work.status)}</span>${detail ? ` · <span class="worker-detail">${esc(detail)}</span>` : ""}${holdsBadge(work.holds)}</small>${contextRing(workerContexts.get(work.threadId))}</button>`;
}
// Shared resources a running worker holds: leases by resource name, and its running background commands.
function holdsBadge(holds) {
  if (!holds) return "";
  const parts = [
    ...holds.leases.map((lease) => `lease ${lease.resource}`),
    ...(holds.background.length ? [`${holds.background.length} bg`] : []),
  ];
  const title = [
    ...holds.leases.map((lease) => `${lease.resource} until ${new Date(lease.until).toLocaleTimeString()}`),
    ...holds.background.map((item) => `background: ${item.label}`),
  ].join("\n");
  return ` · <span class="worker-holds" title="${esc(title)}">${esc(parts.join(", "))}</span>`;
}
const finished = (work) => ["completed", "failed", "stopped"].includes(work.status);
// The chat that admitted a work item (null chatConversationId means Main). Child work keeps the admitting chat, so parentThreadId plays no part.
export function workChatId(work) {
  const chats = getView()?.chats ?? [];
  const main = chats.find((chat) => chat.id === "main")?.conversationId ?? null;
  return (chats.find((chat) => chat.conversationId === (work.chatConversationId ?? main)) ?? chats[0])?.id ?? "main";
}
const inSelectedChat = (work) => !getView()?.chats || workChatId(work) === chatId;
const archivable = (work) => ["completed", "failed", "stopped", "blocked"].includes(work.status) && !work.archived;
function durableActivity() {
  const order = { running: 0, queued: 1, interrupted: 2, blocked: 3 };
  // Finished and archived work leave this card for Recent results; "View all work" lists every item of this chat.
  const pool = allWork
    ? plan.work.filter((work) => showArchived || !work.archived).toReversed()
    : plan.work
        .filter((work) => !finished(work) && !work.archived)
        .toSorted((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const mine = pool.filter(inSelectedChat),
    shown = allWork ? mine : mine.slice(0, 12);
  const detail = (work) =>
    work.archived
      ? "archived"
      : work.status === "running" && work.startedAt
        ? duration(Date.now() - work.startedAt)
        : work.blocker
          ? clip(work.blocker, 80)
          : "";
  const item = (work) => {
    return `<div class="worker-item${work.archived ? " archived" : ""}${work.parentThreadId ? ` child" data-parent="${esc(work.parentThreadId)}` : ""}">${workLine(work, detail(work))}${allWork && archivable(work) ? `<button class="ghost small archive" data-action="work-archive" data-project="${esc(getProjectId())}" data-work="${esc(work.id)}">Archive</button>` : ""}</div>`;
  };
  const elsewhere = pool.length - mine.length,
    total = plan.work.length;
  // One level of nesting: a parent's sub-agents sit under its newest row; orphans (parent not listed) stay top level.
  const threads = new Set(shown.map((work) => work.threadId)),
    placed = new Set();
  const tree = (work) => {
    const first = !placed.has(work.threadId);
    placed.add(work.threadId);
    const kids = first ? shown.filter((child) => child.parentThreadId === work.threadId && child.threadId !== work.threadId) : [];
    return (
      item(work) + (kids.length ? `<div class="work-children" data-parent="${esc(work.threadId)}">${kids.map(item).join("")}</div>` : "")
    );
  };
  return (
    (shown
      .filter((work) => !work.parentThreadId || !threads.has(work.parentThreadId) || work.parentThreadId === work.threadId)
      .map(tree)
      .join("") || `<p class="note">${allWork ? "No work from this chat." : "No active workers from this chat."}</p>`) +
    (elsewhere
      ? `<p class="note other-chats">${elsewhere} ${allWork ? "in" : "active in"} other ${elsewhere === 1 ? "chat" : "chats"}</p>`
      : "") +
    (total
      ? `<button class="ghost small all-work" data-action="all-work">${allWork ? "Show active only" : `View all work (${total}) →`}</button>`
      : "")
  );
}
function renderWorkers() {
  setHtml("#activity", plan ? durableActivity() : '<p class="note">No workers are running.</p>');
  document.querySelector("#archive-toggle").hidden = !allWork;
}
// Context use of the workers listed in the card, read host-side; rows show nothing until a reading exists.
const workerContexts = new Map();
export async function loadWorkerContexts(current) {
  const ids = [...new Set([...document.querySelectorAll("#activity .worker-line[data-thread]")].map((node) => node.dataset.thread))].slice(
    0,
    40,
  );
  if (!ids.length) return;
  const read = await api({ action: "worker-contexts", id: getProjectId(), threadIds: ids }).catch(() => null);
  if (!read || current !== getGeneration()) return;
  let changed = false;
  for (const [id, value] of Object.entries(read))
    if (value && JSON.stringify(workerContexts.get(id)) !== JSON.stringify(value)) {
      workerContexts.set(id, value);
      changed = true;
    }
  if (changed) renderWorkers();
}
// Small ring plus percent; a missing window is said so, never guessed.
function contextRing(context) {
  if (!context || context.tokens == null) return "";
  const percent = context.window ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : null;
  const level = percent === null ? "low" : percent >= 90 ? "high" : percent >= 70 ? "mid" : "low",
    c = 2 * Math.PI * 6;
  return `<span class="ctx-ring" data-level="${level}" title="${esc(contextLine(context))}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" class="track"/><circle cx="8" cy="8" r="6" class="fill" stroke-dasharray="${((c * (percent ?? 0)) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>${percent === null ? "window unknown" : `${percent}%`}</span>`;
}
function durableResults() {
  const done = plan.work
    .filter((work) => finished(work) && !work.archived)
    .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 5);
  return (
    done.map((work) => workLine(work, work.endedAt ? `${duration(Date.now() - work.endedAt)} ago` : "")).join("") ||
    '<p class="note">Finished work appears here.</p>'
  );
}
function threadList() {
  if (!plan) throw new Error("Durable plan is not loaded");
  showDialog(
    "Durable work and reusable threads",
    `<p>Work items sharing a thread UUID reuse its conversation. Status is not verification evidence.</p>${
      plan.work
        .toReversed()
        .map(
          (work) =>
            `<article class="task">${badge(work.status)}<strong>${esc(work.text)}</strong><p>Role ${esc(work.role)} · Work ${esc(work.id)}<br>Thread ${esc(work.threadId)}<br>${esc(work.blocker ?? "")}</p>${verificationNote(plan.verification?.[work.threadId])}<button data-action="thread" data-project="${esc(getProjectId())}" data-thread="${esc(work.threadId)}">Read owned history</button></article>`,
        )
        .join("") || "<p>No retained work items.</p>"
    }`,
  );
}
function workerDetailHtml(chat, page, work) {
  const threadId = chat.threadId,
    draft = formDrafts.get(`${chat.id}:thread-send:${threadId}`),
    role = work?.role ?? "worker";
  const data = `data-project="${esc(chat.id)}" data-thread="${esc(threadId)}"`;
  return `<div class="worker-head"><button type="button" class="ghost small" data-action="thread-close" aria-label="Back to the coordinator chat">← Back</button><div class="row thread-title">${badge(work?.status ?? "unknown")}<b>${esc(role[0].toUpperCase() + role.slice(1))}</b><small>${esc(work?.attempt?.model ?? "")}</small></div><span id="worker-context" class="worker-context"></span><span class="row worker-actions"><button data-thread-mutation data-action="thread-steer" ${data}>Steer…</button><button data-thread-mutation class="danger" data-action="thread-stop" ${data}>Stop…</button></span></div><p class="thread-task clamp" data-action="toggle-clamp" title="Show the full task">${esc(work?.text ?? "")}</p><p class="worker-latest" id="worker-latest"></p><details class="worker-convo" open><summary>Conversation</summary><div id="worker-messages" class="transcript" aria-live="polite"></div><div id="worker-history-pages" class="row"></div></details><form class="composer" data-inline-thread-send ${data}><textarea name="message" aria-label="Message worker" required maxlength="32000" rows="2" placeholder="Follow up with this ${esc(role)}…">${esc(draft?.text ?? "")}</textarea><div class="row between"><span class="row help-line"><small>Reuses this ${esc(role)}'s conversation</small><span class="help-wrap"><button type="button" class="ghost small help-btn" data-action="composer-help" aria-label="Composer help" aria-haspopup="dialog" aria-expanded="false">ⓘ</button><div class="help-pop" role="dialog" aria-label="Composer shortcuts" hidden></div></span></span><button class="primary" type="submit">Send</button></div></form><section class="artifact-pane" id="artifact-pane" aria-label="Worker artifacts"><div class="row between"><b>Artifacts <span id="artifact-count"></span></b><button class="ghost small" data-action="artifacts-sort" id="artifact-sort" title="Sort files">Newest</button></div><small id="artifact-summary" class="note"></small><input id="artifact-filter" type="search" placeholder="Filter by name…" aria-label="Filter artifacts" autocomplete="off"><div id="artifact-tree" class="artifact-tree"></div><div id="artifact-preview" class="artifact-preview" hidden></div></section><details class="worker-controls"><summary>Evidence and changes</summary><div id="worker-evidence"></div><p class="note">Thread ${esc(threadId)} · Conversation ${esc(page.conversationId)}. Scope, model and tools stay frozen; history, partial files and receipts are kept.</p></details>`;
}
export async function inspectThread(threadId) {
  requireThread(threadId);
  if (workerFocus?.threadId !== threadId) setWorkerFocus(null);
  const chat = { id: getProjectId(), generation: getGeneration(), threadId };
  workerChat = chat;
  const target = threadPane;
  target.hidden = false;
  target.innerHTML = '<p class="note">Reading worker conversation…</p>';
  setTab("coordinator");
  setWorkerUrl(threadId);
  document.querySelector(".body").scrollTop = 0;
  render();
  const version = bumpDialogVersion();
  const page = await workerChatPage(chat);
  if (workerChat !== chat || version !== dialogVersion || chat.generation !== getGeneration() || target.hidden) return;
  const work = plan.work.findLast((item) => item.threadId === threadId);
  target.innerHTML = workerDetailHtml(chat, page, work);
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
  void loadWorkerArtifacts(chat);
}
function workerChanges(threadId, items) {
  const workIds = new Set((plan?.work ?? []).filter((item) => item.threadId === threadId).map((item) => item.id));
  const linked = getView().evidence.filter((record) => record.native?.workId && workIds.has(record.native.workId));
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

export function setShowArchived(value) {
  return (showArchived = value);
}
