// Host agent drawer: the owner's agent over the whole host (docs/ui2-contract.md "Host agent requests"), with pending approvals
// as Approve / Deny cards and its own model, thinking and tools. Follows `ui_focus` frames from the host change feed (routed in
// by app.js through onHostTopic). When the host could not open its Host agent, the drawer shows the host's reason.
import { call, stream, uuid } from "./api.js";
import { clip, esc, markdown, oneLine, shortModel } from "./format.js";
import { emit, fail, inline, on, state, toast } from "./state.js";
import { morph, transcriptClick, transcriptHtml } from "./chat.js";

const THINKING = ["off", "low", "medium", "high", "max"];
const drawer = document.querySelector("#host-agent"),
  body = drawer.querySelector(".ha-body"),
  approvalsBox = drawer.querySelector("#ha-approvals"),
  settingsBox = drawer.querySelector("#ha-settings"),
  modelChip = drawer.querySelector("#ha-model"),
  form = drawer.querySelector("#ha-composer"),
  input = form.querySelector("textarea");
let items = [],
  before = null,
  live = null,
  frame = null,
  available = null,
  settings = null,
  approvals = [],
  error = "",
  // Every load gets a number; an older response never paints over a newer one.
  loads = 0;

export const pendingApprovals = () => approvals.filter((item) => item.state === "pending");
export const isOpen = () => drawer.dataset.open === "1";

export function toggleHostAgent(force, { at } = {}) {
  const next = force ?? !isOpen();
  drawer.dataset.open = next ? "1" : "0";
  drawer.setAttribute("aria-hidden", String(!next));
  drawer.inert = !next;
  if (next) {
    void loadHostAgent();
    if (at === "approvals") setTimeout(() => approvalsBox.querySelector("button")?.focus(), 60);
    else setTimeout(() => input.focus(), 30);
  } else {
    live?.stop();
    live = null;
    frame = null;
    if (drawer.contains(document.activeElement)) document.querySelector("#composer-input").focus();
  }
  emit("drawer", next);
}
drawer.inert = true;
// "Review approval" on a coordinator's tool row: open the drawer at that card.
on("review-approval", async (id) => {
  toggleHostAgent(true);
  await loadApprovals();
  const card = approvalsBox.querySelector(`[data-approval="${CSS.escape(id)}"]`);
  if (!card) return toast("That approval was already decided.");
  card.scrollIntoView({ block: "nearest" });
  card.classList.add("flash");
  card.querySelector("[data-decide]")?.focus();
});

/** Host change feed frames for the Host agent and approvals; other host topics belong to app.js. */
export function onHostTopic(change) {
  if (change.topic === "approvals") void loadApprovals();
  else if (change.topic === "host-agent" && change.type === "focus") followFocus(change);
  else if (change.topic === "host-agent" && isOpen()) void loadHostAgent();
}

export async function loadHostAgent() {
  const load = ++loads;
  let problem = "";
  const [history, next] = await Promise.all([
    call("host-agent-history").catch((reason) => ((problem = reason.message), null)),
    call("host-agent-settings").catch(() => null),
    loadApprovals(),
  ]);
  if (load !== loads) return;
  available = !!history;
  drawer.dataset.available = available ? "1" : "0";
  if (!available) {
    body.innerHTML = `<div class="ha-empty"><p class="ha-empty-title">The Host agent is not running</p><p class="error-line small">${esc(problem)}</p><button type="button" class="ghost-btn small" data-ha-retry>Try again</button></div>`;
    input.disabled = true;
    drawer.querySelector("[data-ha-settings]").hidden = true;
    return;
  }
  input.disabled = false;
  input.placeholder = "Ask the host agent…";
  drawer.querySelector("[data-ha-settings]").hidden = false;
  if (next) settings = next;
  paintModel();
  if (!settingsBox.hidden) paintSettings();
  items = history.items ?? [];
  before = history.before;
  paint();
  if (isOpen() && !live)
    live = stream("/live?project=host", (value) => {
      const previous = frame;
      frame = value;
      // Committed entries arrive through the change feed; the live frame only paints the turn in flight.
      if (previous && previous.running && !value.running) void loadHostAgent();
      else paintLive();
    });
}

// ---------------------------------------------------------------------------------------------------------------- focus

const FOCUS_SECTIONS = new Set(["theme", "tiers", "hotkeys", "animations", "statusline", "notifications", "remote", "deploy", "providers"]);
/** `ui_focus { view, projectId?, chatId?, section? }` from the agent: move the page, say where in one line. Settings never open on
 * their own: the owner gets a toast and opens them with its button. */
export function followFocus(focus) {
  const projectId = focus.projectId ?? state.projectId;
  const known = !focus.projectId || state.projects.some((project) => project.id === focus.projectId);
  if (!known) return toast(`Host agent pointed at a project this page does not list.`);
  const select = (chatId) => {
    if (projectId !== state.projectId || chatId !== state.chatId) emit("select-request", { projectId, chatId, keepFocus: true });
  };
  switch (focus.view) {
    case "project":
    case "chat":
      select(focus.chatId ?? (focus.view === "project" ? "main" : state.chatId));
      emit("leave-focus");
      break;
    case "memory":
      select(state.chatId && projectId === state.projectId ? state.chatId : "main");
      emit("open", { kind: "memory" });
      break;
    case "settings":
      offerSettings(focus.section, () => select(focus.chatId ?? (projectId === state.projectId ? state.chatId : "main")));
      break;
    case "approvals":
      toggleHostAgent(true, { at: "approvals" });
      break;
    default:
      if (FOCUS_SECTIONS.has(focus.view)) offerSettings(focus.view);
      else toast(`Host agent pointed at “${focus.view}”, which this page has no view for.`);
  }
}

function offerSettings(section, before = () => {}) {
  toast("The Host agent changed your settings.", {
    action: "Open settings",
    onAction: () => {
      before();
      emit("open-settings", section);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------- transcript

function paint() {
  const transcript = transcriptHtml(items, false, "Host agent", { fold: false });
  morph(
    body,
    (before ? `<button type="button" class="earlier" data-ha-earlier>Show earlier</button>` : "") +
      (transcript || `<p class="muted small ha-hint">Ask anything about this host. Try “what is running?”.</p>`) +
      `<div id="ha-live"></div>` +
      (error ? `<p class="error-line ha-error" role="alert">${esc(error)}</p>` : ""),
  );
  paintLive();
  body.scrollTop = body.scrollHeight;
}
function paintLive() {
  const node = body.querySelector("#ha-live");
  if (!node) return;
  drawer.dataset.running = frame?.running ? "1" : "0";
  if (!frame?.running) return node.replaceChildren();
  const tools = (frame.tools ?? [])
    .filter((tool) => tool.status !== "done")
    .map(
      (tool) =>
        `<div class="tool-row live" data-tool="${esc(tool.name)}" data-status="running"><div class="tool-line"><span class="tool-head static"><span class="spin" aria-label="running"></span><span class="tool-name">${esc(tool.name)}</span><span class="tool-args">${esc(tool.status)}</span><span class="tool-dur"></span></span></div></div>`,
    )
    .join("");
  node.innerHTML = `${tools}${frame.text ? `<article class="msg agent streaming"><div class="msg-meta"><span class="who">Host agent</span></div><div class="prose">${markdown(frame.text)}</div></article>` : ""}<div class="live-status"><span class="pulse" aria-hidden="true"></span>${frame.text ? "Writing" : tools ? "Using tools" : "Working"}…</div>`;
  body.scrollTop = body.scrollHeight;
}
body.addEventListener("click", async (event) => {
  if (event.target.closest("[data-ha-earlier]")) {
    const load = loads;
    const page = await call("host-agent-history", { before }).catch(fail);
    if (load !== loads || !page) return;
    items = [...page.items, ...items];
    before = page.before;
    const top = body.scrollHeight - body.scrollTop;
    paint();
    body.scrollTop = body.scrollHeight - top;
    return;
  }
  if (event.target.closest("[data-ha-open-settings]")) return toggleSettings(true);
  if (event.target.closest("[data-ha-retry]")) return void loadHostAgent();
  void transcriptClick(event, body, paint);
});

// ---------------------------------------------------------------------------------------------------------------- approvals

export async function loadApprovals() {
  const result = await call("approvals-list").catch(() => null);
  if (!result) return null;
  approvals = result.approvals;
  paintApprovals();
  emit("approvals", approvals);
  return approvals;
}
function requester(item) {
  if (item.requestedBy.kind === "host-agent") return "Host agent";
  const project = state.projects.find((entry) => entry.id === item.requestedBy.projectId);
  return `Coordinator · ${project?.name ?? "removed project"}`;
}
function paintApprovals() {
  const pending = pendingApprovals();
  approvalsBox.innerHTML = pending.length
    ? `<h2 class="ha-label">Needs your approval <span class="count">${pending.length}</span></h2>` +
      pending
        .map(
          (item) =>
            `<article class="approval" data-approval="${esc(item.id)}" aria-label="Approval: ${esc(item.summary)}"><div class="ap-head"><span class="badge t-needs">${esc(item.action)}</span><span class="muted small">${esc(requester(item))}</span></div><p class="ap-summary">${esc(item.summary)}</p><details><summary class="small muted">Exact request</summary><pre>${esc(clip(JSON.stringify(item.input, null, 2), 3000))}</pre></details><div class="ap-actions"><button type="button" class="primary small" data-decide="approve">Approve</button><button type="button" class="ghost-btn small" data-decide="deny">Deny</button></div></article>`,
        )
        .join("")
    : "";
}
approvalsBox.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decide]");
  if (!button) return;
  const card = button.closest("[data-approval]");
  const buttons = [...card.querySelectorAll("button")];
  if (buttons.some((node) => node.disabled)) return;
  buttons.forEach((node) => (node.disabled = true));
  card.dataset.deciding = button.dataset.decide;
  try {
    const { approval } = await call("approval-decide", { id: card.dataset.approval, decision: button.dataset.decide });
    // The Host agent's own outcome row lands in this drawer; a coordinator's lands in its chat, so say it here.
    if (approval.requestedBy.kind === "coordinator")
      toast(
        `${approval.state === "denied" ? "Denied" : approval.state === "failed" ? "Approved, but it failed" : "Approved and ran"}: ${clip(approval.summary, 60)}`,
      );
    await loadApprovals();
  } catch (reason) {
    fail(reason);
    buttons.forEach((node) => (node.disabled = false));
    delete card.dataset.deciding;
    void loadApprovals();
  }
});

// ---------------------------------------------------------------------------------------------------------------- settings

function paintModel() {
  modelChip.textContent = settings
    ? `${settings.effectiveModel ? shortModel(settings.effectiveModel) : "no model"} · ${settings.thinking}`
    : "";
}
function toggleSettings(force) {
  const next = force ?? settingsBox.hidden;
  settingsBox.hidden = !next;
  drawer.querySelector("[data-ha-settings]").setAttribute("aria-expanded", String(next));
  if (next) {
    paintSettings();
    void loadModels();
    settingsBox.querySelector("select, button")?.focus();
  }
}
drawer.querySelector("[data-ha-settings]").addEventListener("click", () => toggleSettings());
let models = null,
  tierList = [];
async function loadModels() {
  if (models) return;
  const data = await call("tiers-get").catch(() => null);
  if (!data) return;
  tierList = data.tiers;
  models = data.catalog.filter((item) => item.available);
  if (!settingsBox.hidden) paintSettings();
}
/** Tier edits change what "Automatic" resolves to and which tiers exist. */
export function onTiersChanged() {
  models = null;
  if (!settingsBox.hidden) void loadModels();
  void call("host-agent-settings")
    .then((next) => {
      settings = next;
      paintModel();
      if (!settingsBox.hidden) paintSettings();
    })
    .catch(() => {});
}
function paintSettings() {
  if (!settings) {
    settingsBox.innerHTML = `<p class="muted small">Settings not loaded.</p>`;
    return;
  }
  const current = settings.model ?? "";
  const options = (models ?? []).map(
    (item) => `<option value="${esc(item.ref)}" ${item.ref === current ? "selected" : ""}>${esc(item.ref)}</option>`,
  );
  if (current && !(models ?? []).some((item) => item.ref === current))
    options.unshift(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  const auto = `<option value="" ${current ? "" : "selected"}>From tier · ${esc(settings.effectiveModel ? shortModel(settings.effectiveModel) : "none")}</option>`;
  const tierOptions = [`<option value="" ${settings.tier ? "" : "selected"}>No tier · newest project's model</option>`]
    .concat(
      tierList.map(
        (tier) =>
          `<option value="${esc(tier.id)}" ${tier.id === settings.tier ? "selected" : ""}>${esc(tier.letter)} · ${esc(tier.name)}</option>`,
      ),
    )
    .join("");
  const dangerous = settings.actions.filter((action) => action.dangerous);
  settingsBox.innerHTML = `<div class="ha-row"><label for="ha-tier-select">Tier</label><select id="ha-tier-select">${tierOptions}</select></div>
<div class="ha-row"><label for="ha-model-select">Pinned</label><select id="ha-model-select">${auto}${options.join("")}</select>${current ? `<button type="button" class="info" data-info="A pinned model wins over the tier." aria-label="About the pinned model">ⓘ</button>` : ""}</div>
<div class="ha-row"><span id="ha-thinking-label">Thinking</span><div class="seg" role="radiogroup" aria-labelledby="ha-thinking-label">${THINKING.map((level) => `<button type="button" role="radio" aria-checked="${level === settings.thinking}" data-thinking="${level}">${level}</button>`).join("")}</div></div>
<div class="ha-row top"><span>Tools</span><ul class="ha-tools">${settings.tools
    .map(
      (tool) =>
        `<li><label title="${esc(tool.description)}"><input type="checkbox" data-tool-toggle="${esc(tool.name)}" ${settings.disabledTools.includes(tool.name) ? "" : "checked"} /><span class="mono">${esc(tool.name)}</span><span class="muted small one-line">${esc(oneLine(tool.description))}</span></label></li>`,
    )
    .join("")}</ul></div>
<p class="muted small ha-actions-line">${settings.actions.length} host actions through <code>host_call</code> · ${dangerous.length} wait for your approval <button type="button" class="info" data-info="${esc(`Need approval: ${dangerous.map((action) => action.name).join(", ")}`)}" aria-label="Which actions need approval">ⓘ</button></p>
<p class="ha-status inline-status" role="status" aria-live="polite"></p>`;
}
let settingsWrites = Promise.resolve();
/** Keep rapid tier/model/tool changes on the revision returned by the preceding write. */
function saveSettings(patch, label) {
  const done = settingsWrites.then(() => writeSettings(patch, label));
  settingsWrites = done.catch(() => {});
  return done;
}
async function writeSettings(patch, label) {
  if (!settings) return;
  let problem = null;
  try {
    const next = await call("host-agent-settings", { revision: settings.revision, patch });
    settings = next;
    error = "";
  } catch (reason) {
    problem = reason;
    // A stale revision or a refused model: show what the host has now.
    const fresh = await call("host-agent-settings").catch(() => null);
    if (fresh) settings = fresh;
  }
  paintModel();
  paintSettings();
  const slot = settingsBox.querySelector(".ha-status");
  problem ? inline(slot, problem.message, { error: true }) : inline(slot, label);
}
settingsBox.addEventListener("change", (event) => {
  if (event.target.id === "ha-tier-select") {
    const tier = event.target.value || null;
    void saveSettings({ tier }, tier ? `Host agent tier: ${event.target.selectedOptions[0].textContent}` : "Host agent tier cleared");
  }
  if (event.target.id === "ha-model-select") {
    const model = event.target.value || null;
    void saveSettings({ model }, model ? `Host agent model: ${shortModel(model)}` : "Host agent model: from tier");
  }
  const toggle = event.target.closest("[data-tool-toggle]");
  if (toggle) {
    const name = toggle.dataset.toolToggle;
    const disabled = new Set(settings.disabledTools);
    toggle.checked ? disabled.delete(name) : disabled.add(name);
    void saveSettings({ disabledTools: [...disabled] }, `${name} ${toggle.checked ? "on" : "off"} for the Host agent`);
  }
});
settingsBox.addEventListener("click", (event) => {
  const level = event.target.closest("[data-thinking]");
  if (level && level.dataset.thinking !== settings?.thinking)
    void saveSettings({ thinking: level.dataset.thinking }, `Host agent thinking: ${level.dataset.thinking}`);
});

// ---------------------------------------------------------------------------------------------------------------- composer

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !available || form.dataset.sending === "1") return;
  form.dataset.sending = "1";
  input.value = "";
  try {
    await call("host-agent-send", { requestId: uuid(), text });
    error = "";
    await loadHostAgent();
  } catch (reason) {
    input.value = text;
    // "has no model" / "not in the model catalog": say it where the owner is looking and open the model picker.
    if (/model/i.test(reason.message ?? "")) {
      error = reason.message;
      paint();
      toggleSettings(true);
    } else fail(reason);
  } finally {
    delete form.dataset.sending;
  }
});
export async function resetHostAgent() {
  const result = await call("host-agent-reset").catch(fail);
  if (result) {
    toast("New Host agent session. History kept.");
    void loadHostAgent();
  }
}
export async function stopHostAgent() {
  if (!frame?.running) return false;
  await call("host-agent-stop").catch(fail);
  return true;
}
