import {
  closeCurrentDialog,
  dialog,
  dialogVersion,
  draftPairs,
  draftText,
  getProjectId,
  getView,
  isBusy,
  mutate,
  onBusyChange,
  onDialogClose,
  onProjectChange,
  onRender,
  persistBrowserDrafts,
  persistDraftsSafely,
  registerActions,
  registerDrafts,
  registerForms,
  render,
  requireProject,
  scrollBehavior,
  setHtml,
  showDialog,
  submitOnEnter,
  toast,
} from "./shell.js";
import { ago, clip, esc, uuid } from "./format.js";
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
onProjectChange(() => {
  for (const selector of ["#needs-questions", "#questions"]) document.querySelector(selector).replaceChildren();
});
export function pendingCount() {
  return getView() ? getView().inbox.filter((item) => !item.result).length : 0;
}

// Unanswered questions.
export function pendingItems() {
  return getView().inbox.filter((item) => !item.result);
}
function renderInbox() {
  const pendingTotal = pendingCount();
  const node = document.querySelector("#needs-count");
  node.textContent = String(pendingTotal);
  node.hidden = !pendingTotal;
  const waiting = questionPlacement();
  setHtml(
    "#needs-questions",
    waiting.here.length || waiting.elsewhere.length
      ? `${waiting.here.length ? `<button type="button" class="ghost small" data-action="questions-jump">${waiting.here.length} ${waiting.here.length === 1 ? "question" : "questions"} in chat ↓</button>` : ""}${waiting.elsewhere.length ? `<button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(waiting.elsewhere[0].chat.id)}">${waiting.elsewhere.length} ${waiting.elsewhere.length === 1 ? "question" : "questions"} in other chats →</button>` : ""}`
      : "",
  );
  document.querySelector("#needs-card").hidden = !waiting.here.length && !waiting.elsewhere.length;
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
}
onRender(renderInbox);

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
  document.querySelectorAll("#questions textarea").forEach((node) => {
    node.disabled = isBusy() || !getView() || node.hasAttribute("data-off");
  });
});
registerActions({
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
