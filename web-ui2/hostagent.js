// Host agent drawer: the owner's agent over the whole host (docs/ui2-contract.md "Host agent requests"), with pending approvals
// as Approve / Deny cards. Follows `ui_focus` frames. Before the backend merge it shows a quiet unavailable state.
import { contract, isUnavailable, stream, uuid, UNAVAILABLE_TEXT } from "./api.js";
import { clip, esc, markdown, shortModel } from "./format.js";
import { emit, fail, state, toast } from "./state.js";
import { transcriptClick, transcriptHtml } from "./chat.js";

const drawer = document.querySelector("#host-agent"),
  body = drawer.querySelector(".ha-body"),
  approvalsBox = drawer.querySelector("#ha-approvals"),
  form = drawer.querySelector("#ha-composer"),
  input = form.querySelector("textarea");
let items = [],
  live = null,
  frame = null,
  available = null,
  approvals = [];

export const pendingApprovals = () => approvals.filter((item) => item.state === "pending");
export const isOpen = () => drawer.dataset.open === "1";

export function toggleHostAgent(force) {
  const next = force ?? !isOpen();
  drawer.dataset.open = next ? "1" : "0";
  drawer.setAttribute("aria-hidden", String(!next));
  drawer.inert = !next;
  if (next) {
    void loadHostAgent();
    setTimeout(() => input.focus(), 30);
  } else {
    live?.stop();
    live = null;
    if (drawer.contains(document.activeElement)) document.querySelector("#composer-input").focus();
  }
  emit("drawer", next);
}
drawer.inert = true;

export async function loadHostAgent() {
  const [history, list, settings] = await Promise.all([
    contract("host-agent-history").catch((error) => (fail(error), null)),
    loadApprovals(),
    contract("host-agent-settings").catch(() => null),
  ]);
  void list;
  if (!history) return;
  available = !isUnavailable(history);
  if (!available) {
    drawer.dataset.available = "0";
    body.innerHTML = `<div class="ha-empty"><p class="ha-empty-title">${esc(UNAVAILABLE_TEXT)}</p><p class="muted small">The Host agent runs over the whole host: it can create projects, change settings, tiers, theme and hotkeys for you. Dangerous actions wait for your approval here.</p><ul class="ha-examples small"><li>“Switch to the midnight theme”</li><li>“Put workers on the Workhorse tier”</li><li>“What is running right now?”</li></ul></div>`;
    input.disabled = true;
    input.placeholder = UNAVAILABLE_TEXT;
    return;
  }
  drawer.dataset.available = "1";
  input.disabled = false;
  input.placeholder = "Ask the host agent…";
  if (settings && !isUnavailable(settings))
    document.querySelector("#ha-model").textContent = `${shortModel(settings.effectiveModel ?? "")} · ${settings.thinking ?? ""}`;
  items = history.items ?? [];
  paint();
  if (isOpen() && !live) live = stream("/live?project=host", onFrame);
}
function onFrame(next) {
  if (next?.type === "focus") return followFocus(next);
  const previous = frame;
  frame = next;
  if (previous && (previous.entries !== next.entries || previous.running !== next.running)) void loadHostAgent();
  else paint();
}
/** `ui_focus { view, projectId?, chatId?, section? }` from the agent. */
export function followFocus(focus) {
  if (focus.projectId && focus.projectId !== state.projectId)
    emit("select-request", { projectId: focus.projectId, chatId: focus.chatId ?? "main" });
  else if (focus.chatId && focus.chatId !== state.chatId) emit("select-request", { projectId: state.projectId, chatId: focus.chatId });
  if (focus.view === "settings") emit("open-settings", focus.section);
  else if (focus.view === "memory") emit("open", { kind: "memory" });
  else if (focus.view === "worker" && focus.threadId) emit("open", { kind: "worker", id: focus.threadId });
}
function paint() {
  body.innerHTML =
    (transcriptHtml(items, !!frame?.running, "Host agent") ||
      `<p class="muted small ha-hint">Ask anything about this host. Try “what is running?”.</p>`) +
    (frame?.running
      ? `<div class="live-status"><span class="pulse" aria-hidden="true"></span>${frame.text ? "" : "Working…"}</div>${frame.text ? `<article class="msg agent streaming"><div class="prose">${markdown(frame.text)}</div></article>` : ""}`
      : "");
  body.scrollTop = body.scrollHeight;
}
body.addEventListener("click", (event) => void transcriptClick(event, body, paint));

export async function loadApprovals() {
  const result = await contract("approvals-list").catch(() => null);
  if (!result || isUnavailable(result)) return null;
  approvals = result.approvals;
  paintApprovals();
  emit("approvals", approvals);
  return approvals;
}
function requester(item) {
  if (item.requestedBy.kind === "host-agent") return "Host agent";
  const project = state.projects.find((entry) => entry.id === item.requestedBy.projectId);
  return `Coordinator · ${project?.name ?? "project"}`;
}
function paintApprovals() {
  const pending = pendingApprovals();
  approvalsBox.innerHTML = pending
    .map(
      (item) =>
        `<article class="approval" data-approval="${esc(item.id)}"><div class="ap-head"><span class="badge t-needs">Needs approval</span><span class="muted small">${esc(requester(item))}</span></div><p class="ap-summary">${esc(item.summary)}</p><details><summary class="mono small">${esc(item.action)}</summary><pre>${esc(clip(JSON.stringify(item.input, null, 2), 3000))}</pre></details><div class="ap-actions"><button type="button" class="primary small" data-decide="approve">Approve</button><button type="button" class="ghost-btn small" data-decide="deny">Deny</button></div></article>`,
    )
    .join("");
}
approvalsBox.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decide]");
  if (!button) return;
  const card = button.closest("[data-approval]");
  card.querySelectorAll("button").forEach((node) => (node.disabled = true));
  try {
    const result = await contract("approval-decide", { id: card.dataset.approval, decision: button.dataset.decide });
    if (isUnavailable(result)) return toast(UNAVAILABLE_TEXT);
    toast(button.dataset.decide === "approve" ? `Approved: ${result.approval.action} (${result.approval.state})` : "Denied.");
    await loadApprovals();
  } catch (error) {
    fail(error);
    card.querySelectorAll("button").forEach((node) => (node.disabled = false));
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !available) return;
  input.value = "";
  try {
    const result = await contract("host-agent-send", { requestId: uuid(), text });
    if (isUnavailable(result)) return toast(UNAVAILABLE_TEXT);
    await loadHostAgent();
  } catch (error) {
    input.value = text;
    fail(error);
  }
});
export async function resetHostAgent() {
  const result = await contract("host-agent-reset").catch(fail);
  if (isUnavailable(result)) toast(UNAVAILABLE_TEXT);
  else if (result) {
    toast("New Host agent session. History kept.");
    void loadHostAgent();
  }
}
export async function stopHostAgent() {
  if (!frame?.running) return false;
  await contract("host-agent-stop").catch(fail);
  return true;
}
