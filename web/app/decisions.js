import {
  api,
  closeCurrentDialog,
  dialog,
  dialogVersion,
  disableActions,
  dlgActions,
  dlgBtn,
  draftPairs,
  draftText,
  getGeneration,
  getProjectId,
  getView,
  humanKey,
  isBusy,
  mutate,
  onBusyChange,
  onDialogClose,
  onProjectChange,
  onRender,
  pager,
  probe,
  persistBrowserDrafts,
  persistDraftsSafely,
  registerActions,
  registerDrafts,
  registerForms,
  render,
  requireProject,
  scrollBehavior,
  setDialogBody,
  setHtml,
  showDialog,
  submitOnEnter,
  toast,
} from "./shell.js";
import { ago, badge, clip, esc, uuid } from "./format.js";
import { renderMarkdown } from "./markdown.js";
import { chatId } from "./chat.js";
import { when } from "./observability.js";

const answers = new Map();
let answerAdoption = null;
function answerKey(project, entry) {
  return `${project}:${entry}`;
}
// The project's Jobs and agents (host action jobs-snapshot); null until the first read.
export let jobsSnap = null;
export let approvalPage = null;
export const operationCache = new Map();
// E2E runs (?e2e=1) seed and open approval records by name.
if (probe) Object.assign(window, { operationCache, operationView, operationsDialog });
let selected = null;
onProjectChange(() => {
  approvalPage = null;
  operationCache.clear();
  selected = null;
  for (const selector of ["#queue", "#letter", "#needs-questions", "#questions"]) document.querySelector(selector).replaceChildren();
});
export function pendingCount() {
  return getView() ? getView().inbox.filter((item) => !item.result).length + (approvalPage?.total ?? 0) : 0;
}

// Unanswered questions plus pending approvals, questions first.
export function pendingItems() {
  return [
    ...getView().inbox.filter((item) => !item.result),
    ...(approvalPage?.items ?? [])
      .filter((record) => record.status === "pending")
      .map((record) => ({
        kind: "approval",
        id: `operation:${record.id}`,
        title: `${record.operation.provider} ${record.operation.kind} · ${record.operation.repositoryId}`,
        record,
      })),
  ].sort((a, b) => (a.kind === "question" ? 0 : 1) - (b.kind === "question" ? 0 : 1));
}
function renderInbox() {
  const pending = pendingItems();
  const pendingTotal = getView().inbox.filter((item) => !item.result).length + (approvalPage?.total ?? 0);
  // Questions live in the chat transcript; the sidebar card keeps operation approvals only.
  const approvals = pending.filter((item) => item.kind === "approval");
  const entry = approvals.find((item) => item.id === selected) ?? approvals[0];
  selected = entry?.id ?? null;
  for (const selector of ["#needs-count"]) {
    const node = document.querySelector(selector);
    node.textContent = String(pendingTotal);
    node.hidden = !pendingTotal;
  }
  setHtml(
    "#queue",
    approvals.length < 2
      ? ""
      : approvals
          .map(
            (item, i) =>
              `<button class="inbox-item ${entry.id === item.id ? "active" : ""}" data-action="select" data-entry="${item.id}"><span class="index">${String(i + 1).padStart(2, "0")}</span><span class="item-body"><strong>${esc(item.title)}</strong><small>${item.kind === "question" ? "A decision for the coordinator" : "Exact bound operation, not an execution"}</small></span><span class="arrow">↗</span></button>`,
          )
          .join(""),
  );
  setHtml("#letter", entry ? letter(entry) : "");
  const waiting = questionPlacement();
  setHtml(
    "#needs-questions",
    waiting.here.length || waiting.elsewhere.length
      ? `${waiting.here.length ? `<button type="button" class="ghost small" data-action="questions-jump">${waiting.here.length} ${waiting.here.length === 1 ? "question" : "questions"} in chat ↓</button>` : ""}${waiting.elsewhere.length ? `<button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(waiting.elsewhere[0].chat.id)}">${waiting.elsewhere.length} ${waiting.elsewhere.length === 1 ? "question" : "questions"} in other chats →</button>` : ""}`
      : "",
  );
  document.querySelector("#needs-card").hidden = !entry && !waiting.here.length && !waiting.elsewhere.length;
  document.querySelector("#question-hint").hidden = !waiting.here.length;
  setHtml(
    "#questions",
    waiting.here.map(questionCard).join("") +
      waiting.elsewhere
        .map(
          ({ item, chat }) =>
            `<p class="question-away"><span>Question waiting in chat <b>${esc(chat.title)}</b>: ${esc(clip(item.title, 90))}</span><button type="button" class="small" data-action="chat-select" data-chat="${esc(chat.id)}">Open</button></p>`,
        )
        .join(""),
  );
  document.querySelector("#approvals-button").hidden = !jobsSnap;
  document.querySelector("#approval-page-note").textContent = approvalPage
    ? `Inbox includes pending approvals ${approvalPage.items.length ? 1 : 0}-${approvalPage.items.length}/${approvalPage.total}. Completed history is excluded; open all approvals for later pending/history records.`
    : "";
}
onRender(renderInbox);

function letter(entry) {
  if (entry.kind === "approval") return operationLetter(entry.record);
  return "";
}

// A question belongs to the chat whose conversation asked it; legacy entries without a native identity belong to Main.
export function questionChat(item) {
  return (
    (getView().chats ?? []).find((chat) => item.native && chat.conversationId === item.native.conversationId) ??
    (getView().chats ?? []).find((chat) => chat.id === "main")
  );
}
export function questionPlacement() {
  const here = [],
    elsewhere = [],
    answered = [];
  for (const item of getView().inbox.filter((entry) => entry.kind === "question")) {
    const chat = questionChat(item);
    if (item.result) {
      if (!chat || chat.id === chatId) answered.push(item);
    } else if (!chat || chat.id === chatId) here.push(item);
    else elsewhere.push({ item, chat });
  }
  return { here, elsewhere, answered };
}
function questionCard(item) {
  const rest =
    item.question.trim() !== item.title
      ? item.question.startsWith(item.title)
        ? item.question.slice(item.title.length).trim()
        : item.question
      : "";
  const oldDraft = answers.has(item.id) && !answers.has(answerKey(getProjectId(), item.id));
  return `<article class="question-card" data-question="${esc(item.id)}" tabindex="-1" aria-label="Question from the coordinator"><div class="q-who">Coordinator asks <small class="inline">${esc(ago(item.at))}</small></div><h3 class="q-title">${esc(item.title)}</h3>${rest ? `<div class="q-body">${renderMarkdown(rest)}</div>` : ""}${item.choices.length ? `<div class="choices" role="group" aria-label="Choices">${item.choices.map((choice, index) => `<button type="button" data-action="answer" data-project="${esc(getProjectId())}" data-entry="${item.id}" data-choice="${index}" data-choice-text="${esc(choice)}"><kbd>${index + 1}</kbd><span>${esc(choice)}</span></button>`).join("")}</div>` : ""}${answerForm(item)}${oldDraft ? `<p class="notice">An old UUID-only draft is retained without project ownership. It has not been filled into this question.</p><button type="button" data-action="answer-adopt" data-project="${esc(getProjectId())}" data-entry="${esc(item.id)}">Inspect and explicitly adopt old draft</button>` : ""}</article>`;
}
export function answeredCard(item) {
  return `<article class="question-done" data-question="${esc(item.id)}"><span class="q-check" aria-hidden="true">✓</span><span class="q-done-body"><b>${esc(item.title)}</b><span>Answered: ${esc(clip(item.result.text, 300))}</span></span><small class="inline">${esc(when(Date.parse(item.result.at)))}</small></article>`;
}
function answerForm(entry) {
  return `<form data-answer data-project="${esc(getProjectId())}" data-entry="${entry.id}" class="q-answer"><textarea name="answer" rows="1" aria-label="Answer the coordinator's question" placeholder="${entry.choices.length ? "Or write your own answer…" : "Your answer…"}" title="Enter to send, Shift+Enter for a new line" maxlength="24000" required>${esc(answers.get(answerKey(getProjectId(), entry.id)) ?? "")}</textarea><button class="primary" type="submit">Send answer</button></form>`;
}
onBusyChange(() => {
  document.querySelectorAll("#letter button, #letter textarea, #questions textarea").forEach((node) => {
    node.disabled = isBusy() || !getView() || node.hasAttribute("data-off");
  });
  document
    .querySelectorAll('[data-action="operation-decision"], [data-action="operation-execute"], [data-action="operation-inspect"]')
    .forEach((node) => {
      const record = operationCache.get(node.dataset.operation);
      node.disabled = isBusy() || !getView() || getView().project.archived || getView().project.deleted || !record?.scopeCurrent;
    });
});
registerActions({
  select(node) {
    selected = node.dataset.entry;
    document.activeElement.blur();
    render();
  },
  "answer-adopt"(node) {
    requireProject(node.dataset.project);
    const entry = getView()?.inbox.find((item) => item.id === node.dataset.entry);
    if (entry?.kind !== "question" || entry.result || !answers.has(entry.id))
      throw new Error("No retained unbound draft for this pending question");
    const key = answerKey(getProjectId(), entry.id),
      text = answers.get(entry.id);
    if (answers.has(key)) throw new Error("A project-bound draft already exists; it will not be overwritten");
    const version = showDialog(
      "Adopt this old answer draft?",
      `<p>Target project ${esc(getProjectId())}, question ${esc(entry.id)}: ${esc(entry.title)}.</p><pre>${esc(text)}</pre><form data-answer-adopt data-project="${esc(getProjectId())}" data-entry="${esc(entry.id)}"><input type="hidden" name="confirm" value="${esc(getProjectId())}"><button type="submit">Copy draft only, do not send</button></form>`,
    );
    answerAdoption = { projectId: getProjectId(), entryId: entry.id, text, version };
  },
  "questions-jump"() {
    document.querySelector("#questions").scrollIntoView({ block: "center", behavior: scrollBehavior() });
    document.querySelector("#questions .question-card textarea")?.focus({ preventScroll: true });
  },
  async answer(node) {
    requireProject(node.dataset.project);
    const entry = getView()?.inbox.find((item) => item.id === node.dataset.entry);
    const index = Number(node.dataset.choice);
    if (
      entry?.kind !== "question" ||
      entry.result ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= entry.choices.length ||
      entry.choices[index] !== node.dataset.choiceText
    )
      throw new Error("Displayed choice changed or question is resolved; refresh and choose again");
    await mutate(
      { action: "answer", id: node.dataset.project, entry: entry.id, text: node.dataset.choiceText },
      "Answer sent to the coordinator.",
    );
  },
  async "operation-list"(node) {
    await operationsDialog(Number(node.dataset.offset ?? 0));
  },
  "operation-view"(node) {
    operationView(node.dataset.operation, node.dataset.fingerprint);
  },
  "operation-decision"(node) {
    operationDecision(node.dataset.operation, node.dataset.fingerprint, node.dataset.decision);
  },
  "operation-execute"(node) {
    operationExecution(node.dataset.operation, node.dataset.fingerprint);
  },
  "operation-inspect"(node) {
    operationExecution(node.dataset.operation, node.dataset.fingerprint, true);
  },
});
registerForms([
  [
    "[data-answer-adopt]",
    (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const proposal = answerAdoption;
      requireProject(form.dataset.project);
      if (
        !proposal ||
        proposal.projectId !== getProjectId() ||
        proposal.entryId !== form.dataset.entry ||
        proposal.version !== version ||
        data.get("confirm") !== getProjectId() ||
        answers.get(proposal.entryId) !== proposal.text
      )
        throw new Error("Draft adoption binding changed; inspect and confirm it again");
      const entry = getView()?.inbox.find((entry) => entry.id === proposal.entryId && entry.kind === "question" && !entry.result);
      const key = answerKey(getProjectId(), proposal.entryId);
      if (!entry || answers.has(key)) throw new Error("Target is resolved or has a newer draft; nothing overwritten");
      answers.set(key, proposal.text);
      persistBrowserDrafts();
      closeCurrentDialog(getProjectId(), version);
      render();
      toast("Old draft copied. No answer sent; original unbound draft retained.");
    },
  ],
  [
    "[data-answer]",
    async (form) => {
      const data = new FormData(form);
      const id = getProjectId();
      requireProject(form.dataset.project);
      const text = data.get("answer").trim();
      if (!text) return;
      const entry = getView()?.inbox.find((entry) => entry.id === form.dataset.entry && !entry.result);
      if (!entry) throw new Error("Answer target is no longer pending in this project");
      await mutate({ action: "answer", id, entry: form.dataset.entry, text }, "Answer sent to the coordinator.");
    },
  ],
  [
    "[data-operation-decision]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const record = ownedOperation(form.dataset.operation, form.dataset.fingerprint);
      if (record.status !== "pending") throw new Error("Operation decision is immutable");
      const mode = form.dataset.decision;
      if (!["plain", "execution", "reject"].includes(mode)) throw new Error("Unknown operation decision");
      if (mode !== "reject" && data.get("confirm") !== target) throw new Error("Confirmation must match the project ID");
      if (mode === "execution" && !executionConsentAvailable(record))
        throw new Error("Executable consent is unavailable for this operation");
      await mutate(
        mode === "reject"
          ? { action: "operation-decide", id: target, operationId: record.id, fingerprint: record.fingerprint, decision: "reject" }
          : {
              action: "operation-decide",
              id: target,
              operationId: record.id,
              fingerprint: record.fingerprint,
              decision: "approve",
              confirm: target,
              ...(mode === "execution" ? { execution: true } : {}),
            },
        "Operation decision recorded. No operation was executed.",
      );
      closeCurrentDialog(target, version);
    },
  ],
  [
    "[data-operation-execute]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const record = ownedOperation(form.dataset.operation, form.dataset.fingerprint);
      if (!operationExecutionAvailable(record) || data.get("confirm") !== target)
        throw new Error("Exact executable approval and project confirmation are required");
      if (!["execute", "inspect"].includes(form.dataset.mode)) throw new Error("Unknown bound operation control");
      const result = await mutate(
        {
          action: form.dataset.mode === "inspect" ? "operation-inspect" : "operation-execute",
          id: target,
          operationId: record.id,
          fingerprint: record.fingerprint,
          confirm: target,
        },
        form.dataset.mode === "inspect"
          ? "Bound outcome inspected. No replay/retry permission inferred."
          : "Executor responded. Inspect its receipt; no new retry permission inferred.",
      );
      if (target === getProjectId() && dialogVersion === version)
        showDialog(
          "Bound executor response",
          `<p>Approval is not effect verification. Uncertain effects must be inspected, never replayed automatically.</p><pre>${esc(JSON.stringify(result, null, 2) ?? "No readable receipt returned; outcome remains unproven.")}</pre>`,
        );
    },
  ],
]);
document.addEventListener("input", (event) => {
  const answerForm = event.target.closest("[data-answer]");
  if (answerForm?.dataset.project !== getProjectId()) return;
  answers.set(answerKey(getProjectId(), answerForm.dataset.entry), answerForm.querySelector("textarea").value);
  persistDraftsSafely();
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (submitOnEnter(event, "[data-answer] textarea")) return;
  const card =
    /^[1-9]$/.test(event.key) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !dialog.open &&
    !event.target.closest("input, textarea, select, [contenteditable]")
      ? event.target.closest?.(".question-card")
      : null;
  if (card) {
    const choice = card.querySelectorAll(".choices button")[Number(event.key) - 1];
    if (choice && !choice.disabled) {
      event.preventDefault();
      choice.click();
    }
  }
});
export function validateOperations(page, id, offset) {
  if (
    !page ||
    page.offset !== offset ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    (page.nextOffset !== null &&
      (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== offset + page.items.length || !page.items.length)) ||
    page.items.some(
      (record) =>
        !uuid(record.id) ||
        record.projectId !== id ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
        typeof record.scopeCurrent !== "boolean" ||
        !["pending", "approved", "rejected"].includes(record.status) ||
        !record.operation ||
        !["merge", "auto-merge", "command", "vcs"].includes(record.operation.kind),
    )
  )
    throw new Error("Invalid owned operation page");
}
function ownedOperation(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== getProjectId() || record.fingerprint !== fingerprint)
    throw new Error("Operation binding changed; reopen its owned record");
  if (getView().project.archived || getView().project.deleted || !record.scopeCurrent)
    throw new Error("Restore the project/use a current scope before changing this operation");
  return record;
}
function executionConsentAvailable(record) {
  return (
    record.status === "pending" &&
    record.scopeCurrent &&
    (record.operation.kind === "vcs" || (record.operation.provider === "github" && ["merge", "command"].includes(record.operation.kind)))
  );
}
function mergeExecutionAvailable(record) {
  return (
    record.status === "approved" &&
    record.executionApproved === true &&
    record.scopeCurrent &&
    record.operation.provider === "github" &&
    record.operation.kind === "merge"
  );
}
function operationExecutionAvailable(record) {
  return (
    mergeExecutionAvailable(record) ||
    (record.status === "approved" && record.executionApproved === true && record.scopeCurrent && record.operation.kind === "vcs")
  );
}
function operationLetter(record) {
  const attrs = `data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"`;
  return `<article class="letter"><h2>${esc(record.operation.provider)} ${esc(record.operation.kind)}</h2>${badge(record.status)}<p>Project ${esc(record.projectId)}<br>ID ${esc(record.id)}<br>Fingerprint ${esc(record.fingerprint)}<br>Current scope: ${esc(record.scopeCurrent)}</p><pre>${esc(JSON.stringify(record.operation, null, 2))}</pre><p>Plain approval does not authorize execution. VCS execution is limited to the exact recorded action and state. Auto-merge is unavailable; commands execute only through bound worker profiles.</p><div class="row">${record.status === "pending" ? `<button data-action="operation-decision" ${attrs} data-decision="plain">Approve record only</button>${executionConsentAvailable(record) ? `<button class="danger" data-action="operation-decision" ${attrs} data-decision="execution">Permit exact executor</button>` : ""}<button data-action="operation-decision" ${attrs} data-decision="reject">Reject</button>` : `<p>Decision is immutable. Executable approval: ${esc(record.executionApproved === true)}</p>${operationExecutionAvailable(record) ? `<button class="danger" data-action="operation-execute" ${attrs}>${record.operation.kind === "vcs" ? "Execute exact VCS operation" : "Execute exact-head merge"}, separate confirmation</button><button data-action="operation-inspect" ${attrs}>Inspect original outcome, never replay</button>` : ""}`}</div></article>`;
}
async function operationsDialog(offset = 0) {
  if (!jobsSnap || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    throw new Error("A loaded project and valid approval page are required");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(
      "Approvals",
      '<p class="note">Reading approval requests…</p>',
      "Every approval request recorded for this project. Decisions are final.",
    );
  const page = await api({ action: "operation-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || current !== getGeneration() || id !== getProjectId()) return;
  validateOperations(page, id, offset);
  for (const record of page.items) operationCache.set(record.id, record);
  setDialogBody(
    `${page.total ? `<div class="seg-row"><span class="note">${page.total} ${page.total === 1 ? "request" : "requests"}</span>${pager({ offset, count: page.items.length, total: page.total, size: 100, data: { action: "operation-list" } })}</div>` : ""}${page.items.map((record) => `<div class="list-row"><div class="grow"><strong>${badge(record.status)} ${esc(humanKey(record.operation.kind))} · ${esc(record.operation.repositoryId)}</strong><span class="meta">${esc(record.operation.provider)} · ${record.scopeCurrent ? "scope still current" : "scope has changed"}</span></div><div class="row-actions">${dlgBtn("Details", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }, "small")}</div></div>`).join("") || '<p class="empty-state">No approval requests yet.</p>'}${dlgActions(dlgBtn("Close", { action: "close-dialog" }, "primary"))}`,
  );
}
const operationFacts = (record) =>
  `<div class="kv tight"><span>Action</span><b>${esc(record.operation.provider)} · ${esc(humanKey(record.operation.kind === "vcs" ? record.operation.action : record.operation.kind))}</b>${record.operation.repositoryId ? `<span>Repository</span><b>${esc(record.operation.repositoryId)}</b>` : ""}<span>Status</span><b>${badge(record.status)}</b><span>Scope</span><b>${record.scopeCurrent ? "Still current" : "Changed since"}</b>${record.operation.kind === "vcs" ? `<span>Checkout</span><b class="mono">${esc(record.operation.checkout)}</b><span>Target</span><b class="mono">${esc(record.operation.target)}</b><span>Expected state</span><b class="mono">${esc(record.operation.expectedState)}</b>` : ""}</div>${record.operation.kind === "vcs" ? `<p class="note-box warn">Approval applies once, to this target and state only. Changed state requires a new request. Active-worker protections remain in force.</p><ul>${record.operation.risks.map((risk) => `<li>${esc(risk)}</li>`).join("")}</ul><h3>State reviewed for approval</h3><pre>${esc(typeof record.operation.state === "string" ? record.operation.state : JSON.stringify(record.operation.state, null, 2))}</pre>` : ""}`;
const operationBinding = (record) =>
  `<details class="raw"><summary>Exact binding</summary><div class="kv tight mt"><span>Project</span><b class="mono">${esc(record.projectId)}</b><span>Request</span><b class="mono">${esc(record.id)}</b><span>Fingerprint</span><b class="mono">${esc(record.fingerprint)}</b></div><pre>${esc(JSON.stringify(record.operation, null, 2))}</pre></details>`;
function operationView(id, fingerprint) {
  const record = operationCache.get(id);
  if (!record || record.projectId !== getProjectId() || record.fingerprint !== fingerprint)
    throw new Error("Unknown owned operation record");
  const attrs = { operation: record.id, fingerprint: record.fingerprint };
  const buttons =
    record.status === "pending"
      ? `${dlgBtn("Reject", { action: "operation-decision", ...attrs, decision: "reject" })}${dlgBtn("Approve, record only", { action: "operation-decision", ...attrs, decision: "plain" })}${executionConsentAvailable(record) ? dlgBtn("Allow exact executor…", { action: "operation-decision", ...attrs, decision: "execution" }, "primary") : ""}`
      : `${operationExecutionAvailable(record) ? `${dlgBtn("Inspect original outcome…", { action: "operation-inspect", ...attrs })}${dlgBtn(record.operation.kind === "vcs" ? "Execute this exact VCS operation…" : "Merge this exact commit…", { action: "operation-execute", ...attrs }, "danger")}` : ""}`;
  showDialog(
    "Approval request",
    `${operationFacts(record)}<p class="note-box">${record.status === "pending" ? "Approving only records your decision. Letting the executor act is a separate choice. Auto-merge is not available here." : `Your decision is final. Executable approval: ${record.executionApproved === true ? "yes" : "no"}.`}</p>${operationBinding(record)}${dlgActions(dlgBtn("Back to approvals", { action: "operation-list" }), buttons)}`,
    `${record.operation.provider} · ${humanKey(record.operation.kind)}`,
  );
  disableActions();
}
function operationDecision(id, fingerprint, mode) {
  const record = ownedOperation(id, fingerprint);
  if (
    record.status !== "pending" ||
    !["plain", "execution", "reject"].includes(mode) ||
    (mode === "execution" && !executionConsentAvailable(record))
  )
    throw new Error("This immutable/deferred operation cannot accept that decision");
  const copy = {
    execution: [
      "Allow this exact executor?",
      "Allow executor",
      "Lets the recorded executor act, including its bound effect. Nothing runs from this dialog.",
    ],
    plain: ["Approve, record only?", "Approve", "Records your decision. It does not allow execution or any remote effect."],
    reject: ["Reject this request?", "Reject request", "Records a rejection. This cannot be undone."],
  }[mode];
  showDialog(
    copy[0],
    `${operationFacts(record)}<p class="note-box${mode === "execution" ? " warn" : ""}">${esc(copy[2])}</p>${operationBinding(record)}<form data-operation-decision data-project="${esc(getProjectId())}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}" data-decision="${esc(mode)}">${mode !== "reject" ? `<input type="hidden" name="confirm" value="${esc(getProjectId())}">` : ""}${dlgActions(dlgBtn("Back", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }), `<button type="submit" class="primary${mode === "plain" ? "" : " danger"}">${copy[1]}</button>`)}</form>`,
    `${record.operation.provider} · ${humanKey(record.operation.kind)}`,
  );
  disableActions();
}
function operationExecution(id, fingerprint, inspect = false) {
  const record = ownedOperation(id, fingerprint);
  if (!operationExecutionAvailable(record)) throw new Error("Exact executable approval with a current scope is required");
  const vcs = record.operation.kind === "vcs";
  showDialog(
    inspect ? "Inspect original outcome?" : vcs ? "Execute this exact VCS operation?" : "Merge this exact commit?",
    `${operationFacts(record)}<p class="note-box${inspect ? "" : " warn"}">${inspect ? "Reads the original execution receipt. This does not execute, retry, or grant permission to replay an uncertain outcome." : vcs ? "The host rechecks the target and expected state before running this operation once. Changed state requires fresh approval. An uncertain outcome is never retried automatically." : "This changes the remote repository. The executor rechecks repository, scope and commit first, and an unknown outcome is never retried automatically."}</p><p class="note">No deployment or auto-merge runs from here.</p>${operationBinding(record)}<form data-operation-execute data-mode="${inspect ? "inspect" : "execute"}" data-project="${esc(getProjectId())}" data-operation="${esc(record.id)}" data-fingerprint="${esc(record.fingerprint)}"><input type="hidden" name="confirm" value="${esc(getProjectId())}">${dlgActions(dlgBtn("Back", { action: "operation-view", operation: record.id, fingerprint: record.fingerprint }), `<button type="submit" class="primary${inspect ? "" : " danger"}">${inspect ? "Check outcome" : vcs ? "Execute once" : "Merge now"}</button>`)}</form>`,
    `${record.operation.provider} · ${humanKey(record.operation.kind)}`,
  );
  disableActions();
}
onDialogClose(() => {
  answerAdoption = null;
});
registerDrafts({
  key: "answers",
  required: true,
  entries: () => [...answers],
  validate(pairs) {
    if (!draftPairs(pairs) || pairs.some(([id, value]) => !(uuid(id) || /^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(id)) || !draftText(value)))
      throw new Error("Malformed/oversized browser draft state. In-memory drafts retained without truncation");
  },
  restore(pairs) {
    for (const [id, value] of pairs) answers.set(id, value);
  },
});
export function setJobsSnap(value) {
  return (jobsSnap = value);
}
// The chat that spawned a Job (job.chat is the chat's conversation id).
export function jobChatId(job) {
  return getView()?.chats?.find((chat) => chat.conversationId === job.chat)?.id ?? "main";
}

export function setApprovalPage(value) {
  return (approvalPage = value);
}
