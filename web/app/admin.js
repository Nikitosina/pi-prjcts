import {
  api,
  changeProject,
  closeCurrentDialog,
  dialog,
  dialogVersion,
  disableActions,
  dlgActions,
  dlgBtn,
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
  onTab,
  pager,
  probe,
  projects,
  rawDetails,
  recordSummary,
  registerActions,
  registerForms,
  requireProject,
  segTabs,
  setDialogBody,
  setHtml,
  showDialog,
  stateChip,
  tab,
  toast,
} from "./shell.js";
import { clip, esc, uuid } from "./format.js";
import { admissionBlocked, renderProjects } from "./chat.js";
import { jobsSnap } from "./decisions.js";
import { diffItem } from "./settings.js";
import { when } from "./observability.js";
import { resumeDialog } from "./creation.js";

let routineCache = null,
  routineConfirmation = null;
const providerCache = new Map();
let providerInspection = null;
if (probe) {
  Object.defineProperty(window, "routineConfirmation", { get: () => routineConfirmation });
  Object.defineProperty(window, "providerInspection", { get: () => providerInspection });
  Object.assign(window, { providerCache, providerRecord, ownerFieldsValue });
}
onProjectChange(() => {
  providerCache.clear();
  routineCache = null;
  for (const selector of ["#workspace", "#owner-steps"]) document.querySelector(selector).replaceChildren();
});
onTab((next) => {
  if (next !== "settings") return;
  void loadAutomationStrip();
  void loadEventsIn();
  void loadDeploy();
});

// Deploy (host-wide): the button spawns the deploy CLI detached; "deploy when idle" is an opt-in with a daily window.
let deployView = null,
  deployError = "",
  deployTimer = null;
async function loadDeploy() {
  clearTimeout(deployTimer);
  try {
    deployView = await api({ action: "deploy-snapshot" });
    deployError = "";
  } catch (error) {
    deployError = error.message;
  }
  renderDeploy();
  if (tab === "settings") deployTimer = setTimeout(() => void loadDeploy(), deployView?.running ? 3000 : 15000);
}
const hourOptions = (selected) =>
  Array.from(
    { length: 24 },
    (_, hour) => `<option value="${hour}"${hour === selected ? " selected" : ""}>${String(hour).padStart(2, "0")}:00</option>`,
  ).join("");
function renderDeploy() {
  const node = document.querySelector("#deploy");
  if (!deployView) {
    node.innerHTML = `<p class="note">${deployError ? `Deploy unavailable: ${esc(deployError)}` : "Reading…"}</p>`;
    return;
  }
  // Typing in the window controls must not be overwritten by the next poll.
  if (node.contains(document.activeElement)) return;
  const { settings, state, running } = deployView,
    last = state.lastResult;
  node.innerHTML = `<div class="kv deploy-state"><span>Now</span><b id="deploy-running">${running ? "A deploy is running" : state.queuedAt ? "Deploy queued until no work is running" : "Idle"}</b><span>Last good version</span><b>${state.lastGood ? `<code>${esc(state.lastGood.slice(0, 8))}</code>` : "none yet"}</b><span>Last deploy</span><b id="deploy-last">${last ? `${last.ok ? "ok" : "failed"} · ${esc(when(last.at))} · <code>${esc(last.sha.slice(0, 8))}</code> · ${esc(clip(last.message, 160))}` : "never"}</b></div>
    <div class="row"><button data-action="deploy-start" ${running ? "disabled" : ""}>Deploy now…</button></div>
    <fieldset class="events-group"><legend>Deploy when idle</legend>
      <label class="check"><input type="checkbox" id="deploy-idle" ${settings.idle ? "checked" : ""}> Deploy new code on its own when no Job is running in any project</label>
      <div class="row"><label class="field">From <select id="deploy-from">${hourOptions(settings.startHour)}</select></label><label class="field">To <select id="deploy-to">${hourOptions(settings.endHour)}</select></label></div>
      <p class="note">Checks every few minutes, at most one automatic attempt a day, only inside this window (local time, default 02:00–07:00) and only when the checkout has new code. Equal hours mean any time of day.</p>
      <div class="row"><button class="primary" data-action="deploy-save">Save</button></div>
    </fieldset>`;
}

function renderAdmin() {
  const p = getView().project;
  document.querySelector("#owner-setup-button").hidden = !getView();
  document.querySelector("#usage-button").hidden = !jobsSnap;
  document.querySelector("#provider-button").hidden = !jobsSnap;
  document.querySelector("#routines-button").hidden = !jobsSnap;
  const historyButton = document.querySelector('[data-action="routine-history"]');
  if (historyButton) {
    historyButton.dataset.project = getProjectId() ?? "";
    historyButton.hidden = !jobsSnap;
  }
  document.querySelector("#workspace").textContent = getView().project.cwd;
  document.querySelector("#workspace-policy").textContent =
    "Workers run on this Mac and edit only folders you allow in Settings. Keep the Mac awake while work runs.";
  const scopes = p.workspaceAuthorization?.scopes?.length ?? 0,
    grants = p.githubAuthorization?.length ?? 0,
    pluginProvider = p.workspaceAuthorization && p.workspaceAuthorization.provider !== "github" ? p.workspaceAuthorization.provider : null,
    providerCard = (getView().providerCards ?? [])[0];
  const step = (done, title, detail) =>
    `<li class="${done ? "done" : ""}"><span class="n">${done ? "✓" : "•"}</span><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></li>`;
  const wholeRepository = p.workspaceAuthorization?.scopes?.some((scope) => scope.wholeRepository);
  setHtml(
    "#owner-steps",
    [
      ...(scopes ? [] : [step(false, "Repository", "No Git repository found in the project folder, so workers cannot edit code.")]),
      pluginProvider
        ? providerCard
          ? step(
              providerCard.state === "connected",
              `1. ${providerCard.title}`,
              providerCard.state === "connected" || wholeRepository ? providerCard.body : "Not connected.",
            ) +
            (wholeRepository && providerCard.state === "available" && providerCard.connect
              ? `<li class="step-action"><button class="primary" data-action="provider-connect" data-card="${esc(providerCard.id)}">${esc(providerCard.connect.label)}</button></li>`
              : "")
          : step(
              false,
              `1. ${pluginProvider}`,
              getView().unloadedProvider ? "The provider plugin is not loaded; its records are kept." : "Not connected.",
            )
        : step(
            grants > 0,
            "1. GitHub",
            grants
              ? `Draft PRs on ${p.githubAuthorization.map((grant) => grant.repositoryId).join(", ")}`
              : wholeRepository
                ? "Workers cannot open draft PRs yet."
                : "Not connected.",
          ) +
          (wholeRepository && !grants
            ? '<li class="step-action"><button class="primary" data-action="github-quick">Connect GitHub</button></li>'
            : ""),
      ...(wholeRepository ? [] : [step(false, "2. Fixed command profile", "Optional, owner-defined executable and arguments.")]),
      step(true, wholeRepository ? "2. Skills" : "3. Skills", "Chosen per role in Skills below; repository skills by default."),
    ].join(""),
  );
}
onRender(renderAdmin);

// Events in: Follow PRs and the generic webhook (one card in Settings, rendered from automation-snapshot).
let eventsIn = null;
export async function loadEventsIn(force = false) {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#events-in");
  if (!id || !jobsSnap || (!force && eventsIn?.projectId === id)) return;
  if (eventsIn?.projectId !== id) eventsIn = { projectId: id, data: null, reveal: false, rotateArmed: false };
  try {
    const data = await api({ action: "automation-snapshot", id });
    if (id === getProjectId() && current === getGeneration()) {
      eventsIn.data = data;
      renderEventsIn();
    }
  } catch (error) {
    if (id === getProjectId() && current === getGeneration())
      node.innerHTML = `<p class="note">Events unavailable: ${esc(error.message)}</p>`;
  }
}
const everyChoices = [
  [60000, "1 min"],
  [300000, "5 min"],
  [900000, "15 min"],
  [3600000, "1 hour"],
];
function renderEventsIn() {
  const data = eventsIn?.data,
    node = document.querySelector("#events-in");
  if (!data) return;
  const f = data.follow,
    chats = (getView()?.chats ?? [{ id: "main", title: "Main" }]).filter((chat) => !chat.archived || chat.id === data.eventChat);
  const ago = (at) => (at ? when(at) : "never");
  const fixes = (f?.fixes ?? [])
    .map(
      (fix) =>
        `<li><b>${esc(fix.pr)}</b> ${fix.attempts.map((item, index) => `<span class="fix-attempt ${esc(item.status ?? (item.error ? "failed" : "none"))}" title="${esc(item.error ?? item.mode)}">${index + 1}: ${esc(item.sha.slice(0, 7))} · ${esc(item.mode === "none" ? "no scope" : (item.status ?? (item.error ? "dispatch failed" : "pending")))}</span>`).join(" ")}</li>`,
    )
    .join("");
  const merges = (f?.merges ?? [])
    .map(
      (item) =>
        `<li class="merge-row"><b>${esc(item.pr)}</b> ${item.receipts.map((r) => `<span class="merge-receipt ${esc(r.state)}" title="${esc(r.error ?? r.marker)}">${esc(r.sha.slice(0, 7))} · ${esc(r.state)}${r.mergeCommit ? ` → ${esc(r.mergeCommit.slice(0, 7))}` : ""}</span>`).join(" ")}${item.note ? `<span class="merge-note">${esc(mergeNoteText(item.note))}</span>` : ""}</li>`,
    )
    .join("");
  node.innerHTML = `<div class="events-in">
    <label class="field">Send events to <select id="event-chat">${chats.map((chat) => `<option value="${esc(chat.id)}" ${chat.id === data.eventChat ? "selected" : ""}>${esc(chat.title)}${chat.archived ? " (archived, using Main)" : ""}</option>`).join("")}</select></label>
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
function mergeNoteText(note) {
  const [kind, , ...rest] = note.split(":");
  return (
    {
      merged: "merged",
      review: "waiting for review",
      changes: "reviewer requested changes",
      required: `required check missing: ${rest.join(":")}`,
      ci: "CI not green",
      refused: "refused by GitHub",
      uncertain: "outcome unknown, checking",
      grant: "authorization changed",
      target: "outside authorized base",
      ready: "draft could not be marked ready",
      "review-none": "reviewer gave no verdict",
    }[kind] ?? kind.replace(/^review-/, "reviewer ")
  );
}
async function saveEventsIn() {
  const value = (selector) => document.querySelector(selector);
  const cap = Number(value("#follow-cap").value);
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > 10) throw new Error("Fix attempts must be 0-10");
  const data = await mutate(
    {
      action: "automation-update",
      id: getProjectId(),
      change: {
        eventChat: value("#event-chat").value,
        follow: {
          enabled: value("#follow-enabled").checked,
          everyMs: Number(value("#follow-every").value),
          autoFix: value("#follow-autofix").checked,
          fixCap: cap,
        },
        webhook: { enabled: value("#webhook-enabled").checked },
        autoMerge: { enabled: value("#merge-enabled").checked },
      },
    },
    "Events settings saved.",
  );
  eventsIn.data = data;
  renderEventsIn();
}

export async function loadAutomationStrip() {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#automation-history");
  if (!id || !jobsSnap || (node.dataset.project === id && node.dataset.loaded === "true")) return;
  node.dataset.project = id;
  node.dataset.loaded = "loading";
  try {
    const page = await api({ action: "schedule-history", id, kind: "intents", offset: 0, limit: 5, textOffset: 0, textLimit: 500 });
    if (id !== getProjectId() || current !== getGeneration() || tab !== "settings") return;
    if (!Array.isArray(page.items) || !Array.isArray(page.routines)) throw new Error("Invalid automation history page");
    node.innerHTML = page.routines.length
      ? page.routines
          .map(
            (routine) =>
              `<article class="automation-run"><b>${esc(routine.routineId)}</b><div class="run-dots" aria-label="Recent routine outcomes">${routine.recentRuns.map((run) => `<span class="run-dot ${esc(run.outcome)}" title="${esc(run.outcome)} · ${esc(new Date(run.at).toLocaleString())}" aria-label="${esc(run.outcome)}"></span>`).join("")}</div></article>`,
          )
          .join("")
      : '<p class="note">No automation runs recorded.</p>';
    node.dataset.loaded = "true";
  } catch (error) {
    if (id === getProjectId() && current === getGeneration()) {
      node.innerHTML = `<p class="note">History unavailable: ${esc(error.message)}</p>`;
      node.dataset.loaded = "false";
    }
  }
}
onBusyChange(() => {
  document.querySelectorAll('#dialog [data-action="confirm-pause"], #dialog [data-action="confirm-resume"]').forEach((node) => {
    node.disabled = isBusy() || node.hasAttribute("data-off");
  });
  document.querySelector("#lifecycle").hidden = !getView();
  document.querySelector("#lifecycle-state").textContent = !getView()
    ? ""
    : getView().project.deleted
      ? "Deleted"
      : getView().project.archived
        ? "Archived"
        : getView().paused
          ? "Paused"
          : getView().busy || jobsSnap?.jobs.some((job) => job.status === "running")
            ? "Working"
            : "Idle";
  document.querySelector("#lifecycle-state").dataset.state = document.querySelector("#lifecycle-state").textContent.toLowerCase();
  const pause = document.querySelector("#project-pause"),
    resume = document.querySelector("#project-resume");
  pause.hidden = !getView() || getView().paused || getView().project.archived || getView().project.deleted;
  pause.disabled = isBusy() || admissionBlocked();
  resume.hidden = !getView()?.paused || getView().project.archived || getView().project.deleted;
  resume.disabled = isBusy();
  document.querySelector("#paused-hint").hidden = !getView()?.paused || getView().project.archived || getView().project.deleted;
});
registerActions({
  async "provider-list"(node) {
    await providerList(node.dataset.kind ?? "reads", Number(node.dataset.offset ?? 0));
  },
  "provider-record"(node) {
    requireProject(node.dataset.project);
    providerRecord(node.dataset.record);
  },
  async "provider-fresh"(node) {
    requireProject(node.dataset.project);
    await providerFresh(node.dataset.record);
  },
  "provider-inspect"(node) {
    requireProject(node.dataset.project);
    providerInspect(node.dataset.record);
  },
  "provider-known"() {
    providerKnown();
  },
  async "routine-list"(node) {
    if (node.dataset.project) requireProject(node.dataset.project);
    await routineList(node.dataset.lens ?? "schedules", Number(node.dataset.offset ?? 0));
  },
  async "routine-history"(node) {
    requireProject(node.dataset.project);
    await routineHistory(node.dataset.kind, Number(node.dataset.offset ?? 0), Number(node.dataset.textOffset ?? 0));
  },
  "routine-confirm"(node) {
    requireProject(node.dataset.project);
    routineConfirm(node.dataset.kind, node.dataset.record, node.dataset.enabled);
  },
  async "usage-list"(node) {
    await usageList(Number(node.dataset.offset ?? 0));
  },
  "lifecycle-more"() {
    lifecycleMore();
  },
  "lifecycle-confirm"(node) {
    lifecycleConfirm(node.dataset.project, node.dataset.operation);
  },
  "open-retained"() {
    showDialog(
      "Open known retained project",
      '<p>Enter an owned project UUID to inspect retained state, including projects removed from the ordinary list. This does not restore/resume it.</p><form data-open-retained><label>Known project UUID<input name="id" required maxlength="36" autocomplete="off"></label><button type="submit">Open retained metadata</button></form>',
    );
  },
  async "owner-setup"() {
    await ownerSetupDialog();
  },
  async "workspace-quick"() {
    await workspaceQuickDialog();
  },
  async "workspace-quick-confirm"(node) {
    await workspaceQuickConfirm(node.dataset.project, node.dataset.revision);
  },
  async "provider-connect"(node) {
    await providerConnectDialog(node.dataset.card);
  },
  async "provider-connect-confirm"(node) {
    await providerConnectConfirm(node.dataset.project, node.dataset.card, node.dataset.revision);
  },
  async "github-quick"() {
    await githubQuickDialog();
  },
  async "github-quick-confirm"(node) {
    await githubQuickConfirm(node.dataset.project, node.dataset.revision);
  },
  async "owner-setup-edit"(node) {
    await ownerSetupEdit(node.dataset.kind, node.dataset.payload || "{}");
  },
  async "owner-profile-read"(node) {
    await ownerProfileRead(node.dataset.project, node.dataset.profile);
  },
  async "resume-project"() {
    await resumeDialog();
  },
  async "confirm-resume"(node) {
    const version = dialogVersion;
    if (node.dataset.project !== getProjectId()) throw new Error("The selected project changed. Reopen the resume dialog.");
    await mutate({ action: "resume", id: node.dataset.project }, "Idle project resumed.");
    closeCurrentDialog(node.dataset.project, version);
  },
  "pause-project"() {
    showDialog(
      "Pause this project?",
      `<p>This interrupts the coordinator and workers, and blocks scheduled work. State and partial workspace changes stay intact.</p><p>Resume is a separate action.</p><button class="danger" data-action="confirm-pause" data-project="${esc(getProjectId())}">Pause project</button>`,
    );
  },
  async "confirm-pause"(node) {
    const version = dialogVersion;
    if (node.dataset.project !== getProjectId()) throw new Error("The selected project changed. Reopen the pause confirmation.");
    await mutate({ action: "pause", id: node.dataset.project }, "Project paused. State retained.");
    closeCurrentDialog(node.dataset.project, version);
  },
});
registerActions({
  "deploy-start"() {
    showDialog(
      "Deploy now?",
      `<p>The host restarts from its main checkout. Every project pauses briefly and this page reconnects. If the new host fails its smoke test, the last good version comes back.</p>${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Deploy", { action: "deploy-confirm" }, "danger"))}`,
    );
  },
  async "deploy-confirm"() {
    const version = dialogVersion;
    deployView = await api({ action: "deploy-start" });
    closeCurrentDialog(getProjectId(), version);
    toast(deployView.queued ? deployView.line : "Deploy started. The host restarts shortly.");
    renderDeploy();
  },
  async "deploy-save"() {
    const read = (selector) => document.querySelector(selector);
    deployView = await api({
      action: "deploy-settings",
      settings: {
        idle: read("#deploy-idle").checked,
        startHour: Number(read("#deploy-from").value),
        endHour: Number(read("#deploy-to").value),
      },
    });
    toast("Deploy settings saved.");
    renderDeploy();
  },
  async "automation-refresh"() {
    await loadEventsIn(true);
  },
  async "automation-save"() {
    await saveEventsIn();
  },
  async "follow-poll"() {
    const data = await mutate({ action: "follow-poll", id: getProjectId() }, "Checked GitHub.");
    eventsIn.data = data;
    renderEventsIn();
  },
  "webhook-reveal"() {
    eventsIn.reveal = !eventsIn.reveal;
    renderEventsIn();
  },
  async "webhook-copy"(node) {
    await navigator.clipboard.writeText(node.dataset.what === "url" ? eventsIn.data.webhook.url : eventsIn.data.webhook.secret);
    toast(node.dataset.what === "url" ? "Webhook URL copied." : "Webhook secret copied.");
  },
  async "webhook-rotate"() {
    if (!eventsIn.rotateArmed) {
      eventsIn.rotateArmed = true;
      renderEventsIn();
      setTimeout(() => {
        if (eventsIn?.rotateArmed) {
          eventsIn.rotateArmed = false;
          renderEventsIn();
        }
      }, 6000);
      return;
    }
    eventsIn.rotateArmed = false;
    const data = await mutate(
      { action: "webhook-rotate", id: getProjectId(), confirm: getProjectId() },
      "Webhook secret rotated. The old secret no longer works.",
    );
    eventsIn.data = data;
    eventsIn.reveal = true;
    renderEventsIn();
  },
});
registerForms([
  [
    "[data-routine-change]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const proposal = routineConfirmation;
      if (
        !proposal ||
        proposal.project !== target ||
        proposal.version !== version ||
        data.get("confirm") !== target ||
        JSON.stringify(routineRecord(proposal.kind, proposal.recordId)) !== proposal.binding
      )
        throw new Error("Routine confirmation changed; inspect it again");
      const input =
        proposal.kind === "events"
          ? { action: "event-opt-in", id: target, enabled: proposal.enabled }
          : proposal.kind === "schedule"
            ? { action: "schedule-enable", id: target, scheduleId: proposal.recordId, enabled: proposal.enabled }
            : { action: "monitor-enable", id: target, monitorId: proposal.recordId, enabled: proposal.enabled };
      await mutate(input, "Confirmed routine setting recorded. Pause, grants and retained receipts are unchanged.");
      if (dialog.open && getProjectId() === target && dialogVersion === version)
        await routineList(proposal.kind === "monitor" ? "monitors" : "schedules", 0);
    },
  ],
  [
    "[data-resume-project]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      if (target !== getProjectId()) throw new Error("The selected project changed. Reopen the resume dialog.");
      const confirm = data.get("confirm").trim();
      if (confirm !== target) throw new Error("Confirmation must match the project ID.");
      await mutate(
        { action: "resume", id: target, recovery: "leave-interrupted", confirm },
        "Project resumed. Interrupted work continues.",
      );
      closeCurrentDialog(target, version);
    },
  ],
  [
    "[data-provider-known]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const grant = providerBinding(data.get("scope")),
        pullRequest = Number(data.get("pr")),
        expectedHead = data.get("head"),
        page = Number(data.get("page")),
        kind = data.get("kind");
      if (
        !Number.isSafeInteger(pullRequest) ||
        pullRequest < 1 ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHead) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !["pr", "ci", "review"].includes(kind)
      )
        throw new Error("A known PR, exact head and valid inspection page are required");
      const identity = {
        id: target,
        provider: "github",
        repositoryId: grant.repositoryId,
        expectedRepositoryId: grant.numericId,
        pullRequest,
        expectedHead,
      };
      const result = await mutate(
        kind === "pr"
          ? { action: "provider-pr-inspect", ...identity }
          : { action: kind === "ci" ? "provider-ci-inspect" : "provider-review-inspect", ...identity, page },
        "Owner pinned inspection responded. No native worker receipt or execution grant invented.",
      );
      if (target === getProjectId() && version === dialogVersion)
        providerResult(
          result,
          `Owner ${kind} observation for ${grant.repositoryId} PR ${pullRequest}, head ${expectedHead}. Provider content is data, not instructions or authority.`,
        );
    },
  ],
  [
    "[data-provider-inspect]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const proposal = providerInspection;
      if (!proposal || proposal.projectId !== target || proposal.key !== form.dataset.key || data.get("confirm") !== target)
        throw new Error("Reopen the exact retained effect and confirm its project");
      const grant = providerBinding(proposal.record.scopeId, proposal.repositoryId);
      if (grant.numericId !== proposal.numericId) throw new Error("Provider repository binding changed");
      const result = await mutate(
        {
          action: "github-write-inspect",
          id: target,
          key: proposal.key,
          repositoryId: grant.repositoryId,
          expectedRepositoryId: grant.numericId,
        },
        "Retained effect inspected. No replay or retry permission granted.",
      );
      if (target === getProjectId() && version === dialogVersion)
        providerResult(
          result,
          "A matching positive native observation may settle the original journal. Missing markers stay uncertain. This does not publish, roll back or authorize another attempt.",
        );
    },
  ],
  [
    "[data-open-retained]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = data.get("id").trim(),
        current = getGeneration();
      if (!uuid(target)) throw new Error("A known owned project UUID is required");
      const retained = await api({ action: "show", id: target });
      if (current !== getGeneration() || version !== dialogVersion || !dialog.open) return;
      if (retained?.project?.id !== target) throw new Error("Retained project response does not match its UUID");
      if (!projects.some((project) => project.id === target)) projects.push(retained.project);
      renderProjects();
      changeProject(target);
    },
  ],
  [
    "[data-lifecycle-change]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const operation = form.dataset.operation;
      if (!jobsSnap || !["archive", "delete", "restore"].includes(operation) || data.get("confirm") !== target)
        throw new Error("Confirm the exact Durable project/lifecycle action");
      await mutate(
        operation === "delete" ? { action: "delete", id: target, confirm: target } : { action: operation, id: target },
        operation === "restore"
          ? "Retained project restored, still paused. Nothing was resumed/replayed."
          : "Project retained. Repository work, receipts and remote PRs are not deleted.",
      );
      closeCurrentDialog(target, version);
    },
  ],
  [
    "[data-owner-github-inspect]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const repositoryId = data.get("repositoryId").trim();
      if (!repositoryId) throw new Error("Enter the exact owner/repository from the selected checkout origin");
      const result = await api({ action: "github-repository-inspect", id: target, repositoryId });
      if (target === getProjectId() && version === dialogVersion && dialog.open)
        setDialogBody(
          `<p class="note">Read-only lookup. Use the numeric ID and default branch below when you authorize this repository.</p>${recordSummary(result)}${dlgActions(dlgBtn("Back to owner setup", { action: "owner-setup" }, "primary"))}`,
        );
    },
  ],
  [
    "[data-owner-write]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      if (form.dataset.kind.endsWith("-revoke") && data.get("confirm") !== target)
        throw new Error("Type the exact project ID for fresh owner consent");
      const fields = ownerFieldsValue(form);
      const kind = form.dataset.kind,
        actionByKind = {
          "workspace-grant": "workspace-grant",
          "workspace-revoke": "workspace-revoke",
          "github-authorize": "github-authorize",
          "github-revoke": "github-revoke",
          "command-profile-set": "command-profile-set",
        };
      if (!Object.hasOwn(actionByKind, kind)) throw new Error("Unknown owner setup action");
      const result = await mutate(
        { ...fields, action: actionByKind[kind], id: target, confirm: target },
        "Owner API recorded this explicit revision-checked change. No command was executed.",
      );
      if (getProjectId() === target && version === dialogVersion && dialog.open) await ownerSetupDialog(result);
    },
  ],
]);
function providerBinding(scopeId, repositoryId) {
  if (!getView() || getView().project.archived || getView().project.deleted)
    throw new Error("Restore the retained project before provider inspection");
  const p = getView().project,
    scope = p.workspaceAuthorization?.scopes.find((scope) => scope.id === scopeId),
    grant = p.githubAuthorization?.find((grant) => grant.repositoryId === scope?.repositoryId);
  if (
    p.workspaceAuthorization?.provider !== "github" ||
    !scope ||
    !grant ||
    (repositoryId !== undefined && grant.repositoryId !== repositoryId) ||
    !Number.isSafeInteger(grant.numericId)
  )
    throw new Error(
      "Receipt has no matching current GitHub scope/repository grant. Other workspace providers remain deferred; retained metadata stays readable",
    );
  return grant;
}
async function providerList(kind = "reads", offset = 0) {
  if (!jobsSnap || !["reads", "writes"].includes(kind) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    throw new Error("A loaded Durable project and valid receipt page are required");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(
      "GitHub receipts",
      '<p class="note">Reading what workers recorded…</p>',
      "What workers read from GitHub and sent to it, as recorded at the time. Not live status.",
    );
  const page = await api({ action: kind === "reads" ? "github-read-snapshot" : "github-write-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    (page.nextOffset !== null && (!page.items.length || page.nextOffset !== offset + page.items.length))
  )
    throw new Error("Invalid retained provider receipt page");
  providerCache.clear();
  const rows = page.items.map((record) => {
    if (
      !uuid(record.scopeId) ||
      !Number.isSafeInteger(record.conversationId) ||
      record.conversationId < 1 ||
      !Number.isSafeInteger(record.taskId) ||
      record.taskId < 1 ||
      typeof record.callId !== "string" ||
      typeof record.operation !== "string" ||
      (kind === "reads" &&
        (typeof record.repositoryId !== "string" ||
          !Number.isSafeInteger(record.pullRequest) ||
          record.pullRequest < 1 ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head))) ||
      (kind === "writes" && (!/^[a-f0-9]{64}$/.test(record.key) || !["uncertain", "done"].includes(record.state)))
    )
      throw new Error("Invalid native provider receipt identity");
    const cacheKey = crypto.randomUUID();
    providerCache.set(cacheKey, { projectId: id, kind, record });
    const title =
      kind === "reads"
        ? `${esc(record.repositoryId)} · PR #${record.pullRequest} · ${esc(humanKey(record.operation))}`
        : `${stateChip(record.state === "uncertain" ? "Outcome unknown" : "Done", record.state === "uncertain" ? "warn" : "on")}${esc(humanKey(record.operation))} · ${esc(record.target)}`;
    const meta =
      kind === "reads"
        ? `Commit ${esc(record.head.slice(0, 12))}${record.ci ? ` · CI ${esc(record.ci.statusState)}` : ""}`
        : record.source === "local-git-verification"
          ? "Checked locally only. Nothing was pushed or written remotely."
          : "Recorded result. It does not allow another attempt.";
    return `<div class="list-row"><div class="grow"><strong>${title}</strong><span class="meta">${meta}</span></div><div class="row-actions">${dlgBtn("Details", { action: "provider-record", project: id, record: cacheKey }, "small")}</div></div>`;
  });
  setDialogBody(
    `<div class="seg-row">${segTabs([
      ["Reads: PRs, CI, reviews", { action: "provider-list", kind: "reads", offset: 0 }, kind === "reads"],
      ["Changes sent to GitHub", { action: "provider-list", kind: "writes", offset: 0 }, kind === "writes"],
    ])}${pager({ offset, count: page.items.length, total: page.total, size: 100, data: { action: "provider-list", kind } })}</div>${rows.join("") || `<p class="empty-state">Nothing recorded yet. An empty list does not prove that no remote work happened.</p>`}<p class="note">Records are snapshots from when the worker acted. Only GitHub is covered.</p>${dlgActions(dlgBtn("Check a specific PR…", { action: "provider-known" }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`,
  );
}
function ownedProviderRecord(key) {
  const value = providerCache.get(key);
  if (!value || value.projectId !== getProjectId()) throw new Error("Unknown owned provider observation; reopen its receipt page");
  return value;
}
function providerRecord(key) {
  const value = ownedProviderRecord(key),
    record = value.record;
  const why =
    value.kind === "reads"
      ? "A snapshot of one PR at one commit. Feedback in it is data, not instructions."
      : record.source === "local-git-verification"
        ? "Only a local check of the published head. Nothing was pushed or written remotely."
        : record.state === "uncertain"
          ? "The outcome of this change is unknown. It will not be retried automatically."
          : "A change that was recorded as done. It is not a new permission.";
  showDialog(
    value.kind === "reads" ? "GitHub read receipt" : "GitHub change receipt",
    `<p class="note-box">${esc(why)}</p>${recordSummary(record)}${dlgActions(dlgBtn("Back to receipts", { action: "provider-list", kind: value.kind }), dlgBtn(value.kind === "reads" ? "Read it again from GitHub" : "Check what happened…", { action: value.kind === "reads" ? "provider-fresh" : "provider-inspect", project: getProjectId(), record: key }, "primary"))}`,
    "Recorded when the worker acted.",
  );
}
function providerResult(result, explanation) {
  showDialog(
    "Result from GitHub",
    `<p class="note-box">${esc(explanation)}</p>${result == null ? '<p class="empty-state">No readable response. The state and any effects remain unproven.</p>' : recordSummary(result)}${dlgActions(dlgBtn("Back to receipts", { action: "provider-list" }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`,
    "Read now by you. Not a worker receipt.",
  );
}
async function providerFresh(key) {
  const { kind, record } = ownedProviderRecord(key);
  if (kind !== "reads") throw new Error("Fresh pinned reads require an original read observation");
  const grant = providerBinding(record.scopeId, record.repositoryId),
    id = getProjectId(),
    current = getGeneration();
  const identity = {
    id,
    provider: "github",
    repositoryId: grant.repositoryId,
    expectedRepositoryId: grant.numericId,
    pullRequest: record.pullRequest,
    expectedHead: record.head,
  };
  const input =
    record.operation === "ci"
      ? { action: "provider-ci-inspect", ...identity, page: record.ci?.page ?? 1 }
      : record.operation === "review"
        ? { action: "provider-review-inspect", ...identity, page: 1 }
        : { action: "provider-pr-inspect", ...identity };
  const version = showDialog(
      "Reading from GitHub",
      '<p class="note">Reading the same PR at the same commit…</p>',
      `${record.repositoryId} · PR #${record.pullRequest}`,
    ),
    result = await api(input);
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  providerResult(
    result,
    `Read of ${record.repositoryId} PR #${record.pullRequest} at commit ${record.head.slice(0, 12)}. No worker call is invented. Review reads start at page 1; more pages are listed in the result.`,
  );
}
function providerInspect(key) {
  const { kind, record } = ownedProviderRecord(key);
  if (kind !== "writes") throw new Error("Effect inspection requires an original native write intent");
  const grant = providerBinding(record.scopeId),
    proposal = { projectId: getProjectId(), key: record.key, record, repositoryId: grant.repositoryId, numericId: grant.numericId };
  showDialog(
    "Check what happened?",
    `<div class="kv tight"><span>Repository</span><b>${esc(grant.repositoryId)}</b><span>Change</span><b>${esc(humanKey(record.operation))} · ${esc(record.target)}</b></div><p class="note-box">Only matching evidence on GitHub can settle this record; if none is found it stays unknown. This does not publish, roll back or retry anything.</p>${rawDetails(record)}<form data-provider-inspect data-project="${esc(getProjectId())}" data-key="${esc(record.key)}"><input type="hidden" name="confirm" value="${esc(getProjectId())}">${dlgActions(dlgBtn("Back", { action: "provider-record", project: getProjectId(), record: key }), '<button type="submit" class="primary">Check on GitHub</button>')}</form>`,
    "Read-only check against GitHub.",
  );
  providerInspection = proposal;
  disableActions();
}
function providerKnown() {
  if (
    !jobsSnap ||
    getView().project.workspaceAuthorization?.provider !== "github" ||
    getView().project.archived ||
    getView().project.deleted
  )
    throw new Error("A current active GitHub scope is required. Other workspace providers remain deferred");
  const scopes = getView().project.workspaceAuthorization.scopes.filter((scope) =>
    getView().project.githubAuthorization?.some((grant) => grant.repositoryId === scope.repositoryId),
  );
  if (!scopes.length) throw new Error("No explicit GitHub repository/scope grant is available");
  showDialog(
    "Check a specific pull request",
    `<form data-provider-known data-project="${esc(getProjectId())}"><div class="field-grid"><div class="field"><label><span class="flabel">Repository</span><select name="scope">${scopes.map((scope) => `<option value="${esc(scope.id)}">${esc(scope.repositoryId)}</option>`).join("")}</select></label></div><div class="field"><label><span class="flabel">What to read</span><select name="kind"><option value="pr">The PR itself</option><option value="ci">CI results</option><option value="review">Reviews and comments</option></select></label></div><div class="field"><label><span class="flabel">PR number</span><input name="pr" type="number" min="1" required autofocus></label></div><div class="field"><label><span class="flabel">Page</span><input name="page" type="number" min="1" max="1000000" value="1" required></label><span class="fhelp">Only used for CI and reviews.</span></div></div><div class="field"><label><span class="flabel">Commit (full SHA of the PR head)</span><input name="head" class="mono" minlength="40" maxlength="64" pattern="(?:[a-f0-9]{40}|[a-f0-9]{64})" required autocomplete="off" placeholder="40 hexadecimal characters"></label><span class="fhelp">The host checks repository, PR and commit together before reading.</span></div>${dlgActions(dlgBtn("Back", { action: "provider-list" }), '<button type="submit" class="primary">Read from GitHub</button>')}</form>`,
    "Read-only. It reads exactly what you name and grants nothing.",
  );
  disableActions();
}
function lifecycleMore() {
  if (!jobsSnap) throw new Error("Lifecycle controls require a loaded Durable project");
  const p = getView().project,
    inactive = p.archived || p.deleted,
    state = p.deleted ? "removed from the list" : p.archived ? "archived" : getView().paused ? "paused" : "active";
  const choices = inactive
    ? [["restore", "Restore", "Brings the project back. It stays paused until you resume it."]]
    : [
        ["archive", "Archive", "Pauses the project and keeps everything. You can restore it later."],
        [
          "delete",
          "Remove from list",
          "Pauses it and hides it from the project list. Files and work are kept; open it by its ID to restore.",
        ],
      ];
  showDialog(
    "Archive, delete or restore",
    `<div class="choice-list">${choices.map(([operation, label, help]) => `<div class="choice-card"><div><b>${label}</b><p>${help}</p></div>${dlgBtn(`${label}…`, { action: "lifecycle-confirm", project: getProjectId(), operation }, operation === "restore" ? "" : "danger")}</div>`).join("")}</div><p class="note">Nothing in the repository, worker folders or remote PRs is deleted. Pause and resume keep their own controls.</p>${dlgActions(dlgBtn("Close", { action: "close-dialog" }))}`,
    `${p.name} is ${state}.`,
  );
}
function lifecycleConfirm(id, operation) {
  requireProject(id);
  if (!jobsSnap || !["archive", "delete", "restore"].includes(operation)) throw new Error("Unknown Durable lifecycle action");
  const inactive = getView().project.archived || getView().project.deleted;
  if (operation === "restore" ? !inactive : inactive) throw new Error("Project lifecycle state changed; reopen its controls");
  const copy = {
    restore: [
      "Restore this project?",
      "Restore project",
      "Brings the saved project back. It stays paused; no work is resumed or replayed.",
    ],
    archive: [
      "Archive this project?",
      "Archive project",
      "Pauses and archives the project. Conversations, receipts, repository changes, worker folders and remote PRs all remain.",
    ],
    delete: [
      "Remove this project from the list?",
      "Remove from list",
      "Pauses the project and hides it from the list. All data, repository changes, worker folders and remote PRs remain. Open it by its ID to restore it later.",
    ],
  }[operation];
  showDialog(
    copy[0],
    `<p class="note-box${operation === "restore" ? "" : " warn"}">${esc(copy[2])}</p><div class="kv tight"><span>Project</span><b>${esc(getView().project.name)}</b><span>ID</span><b class="mono">${esc(id)}</b></div><p class="note">No files or provider data are cleaned up.</p><form data-lifecycle-change data-project="${esc(id)}" data-operation="${operation}"><input type="hidden" name="confirm" value="${esc(id)}">${dlgActions(dlgBtn("Back", { action: "lifecycle-more" }), `<button type="submit" class="primary${operation === "restore" ? "" : " danger"}">${copy[1]}</button>`)}</form>`,
    getView().project.name,
  );
  disableActions();
}
async function routineList(lens = "schedules", offset = 0) {
  if (lens === "history") return routineHistory("intents", 0, 0);
  if (!jobsSnap || !["schedules", "monitors"].includes(lens) || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Routine view requires a loaded Durable project and valid cached page");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(
      "Schedules and monitors",
      '<p class="note">Reading your automations…</p>',
      "Turn automations on or off. Every change asks you to confirm first.",
    );
  const [schedules, monitors, policy] = await Promise.all([
    api({ action: "schedule-snapshot", id, includeHistory: false }),
    api({ action: "monitor-snapshot", id }),
    api({ action: "jobs-snapshot", id }),
  ]);
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (
    !schedules ||
    typeof schedules.eventOptIn !== "boolean" ||
    ![null, "uncertain-provider-write", "uncertain-command"].includes(schedules.automaticAdmissionBlocker) ||
    !Array.isArray(schedules.schedules) ||
    !Array.isArray(schedules.events) ||
    !Array.isArray(schedules.intents) ||
    schedules.events.length ||
    schedules.intents.length ||
    schedules.historyIncluded !== false ||
    !Number.isSafeInteger(schedules.historyCounts?.events) ||
    schedules.historyCounts.events < 0 ||
    !Number.isSafeInteger(schedules.historyCounts?.intents) ||
    schedules.historyCounts.intents < 0 ||
    schedules.schedules.some(
      (record) =>
        record.projectId !== id ||
        typeof record.id !== "string" ||
        !record.id ||
        typeof record.enabled !== "boolean" ||
        !["once", "interval", "calendar"].includes(record.kind) ||
        typeof record.text !== "string",
    ) ||
    !monitors ||
    !Array.isArray(monitors.items) ||
    monitors.items.some(
      (record) =>
        !uuid(record.id) ||
        typeof record.enabled !== "boolean" ||
        !["pr", "ci", "review"].includes(record.kind) ||
        typeof record.repositoryId !== "string" ||
        !Number.isSafeInteger(record.expectedRepositoryId) ||
        record.expectedRepositoryId < 1 ||
        !Number.isSafeInteger(record.pullRequest) ||
        record.pullRequest < 1,
    ) ||
    !policy ||
    typeof policy.paused !== "boolean"
  )
    throw new Error("Invalid owned routine projection");
  routineCache = { project: id, schedules, monitors, policy };
  const records = lens === "schedules" ? schedules.schedules : monitors.items,
    page = records.slice(offset, offset + 100),
    kind = lens === "schedules" ? "schedule" : "monitor";
  const tabs = segTabs([
    [
      `Schedules (${schedules.schedules.length})`,
      { action: "routine-list", project: id, lens: "schedules", offset: 0 },
      lens === "schedules",
    ],
    [
      `GitHub monitors (${monitors.items.length})`,
      { action: "routine-list", project: id, lens: "monitors", offset: 0 },
      lens === "monitors",
    ],
    [
      `History (${schedules.historyCounts.events + schedules.historyCounts.intents})`,
      { action: "routine-list", project: id, lens: "history" },
      false,
    ],
  ]);
  const toggle = (label, enabled, recordId = "", recordKind = kind) =>
    dlgBtn(label, { action: "routine-confirm", project: id, kind: recordKind, record: recordId, enabled: !enabled }, "small");
  const rows =
    page
      .map(
        (record) =>
          `<div class="list-row"><div class="grow"><strong>${lens === "schedules" ? esc(clip(record.text, 140)) : `${esc(record.repositoryId)} · PR #${record.pullRequest}`}</strong><span class="meta">${stateChip(record.enabled ? "On" : "Off", record.enabled ? "on" : "")}${esc(humanKey(record.kind))}${lens === "monitors" ? " monitor" : " schedule"}</span></div><div class="row-actions">${toggle(record.enabled ? "Turn off…" : "Turn on…", record.enabled, record.id)}</div>${rawDetails(record)}</div>`,
      )
      .join("") ||
    `<p class="empty-state">No ${lens === "schedules" ? "schedules" : "monitors"} yet. They are created from the command line and start turned off.</p>`;
  setDialogBody(
    `${policy.paused || schedules.automaticAdmissionBlocker ? `<p class="note-box warn">${policy.paused ? "The project is paused, so nothing starts automatically. " : ""}${schedules.automaticAdmissionBlocker ? `Automatic runs are blocked until you check an earlier uncertain ${schedules.automaticAdmissionBlocker === "uncertain-command" ? "command" : "GitHub change"}.` : ""}</p>` : ""}<div class="choice-card"><div><b>Outside events ${stateChip(schedules.eventOptIn ? "On" : "Off", schedules.eventOptIn ? "on" : "")}</b><p>Lets events from GitHub or webhooks start work in this project.</p></div>${toggle(schedules.eventOptIn ? "Turn off…" : "Turn on…", schedules.eventOptIn, "", "events")}</div><div class="seg-row mt">${tabs}${pager({ offset, count: page.length, total: records.length, size: 100, data: { action: "routine-list", project: id, lens } })}</div>${rows}<p class="note">Routines run only while your Mac is awake, and only if they are on. This list is a sample read, not an atomic snapshot.</p>${dlgActions(dlgBtn("Refresh", { action: "routine-list", project: id, lens, offset }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`,
  );
}
function validateRoutineRange(text, range, requested) {
  if (
    typeof text !== "string" ||
    !range ||
    ![range.offset, range.end, range.total].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !/^[a-f0-9]{64}$/.test(range.sha256) ||
    range.offset !== Math.min(requested, range.total) ||
    range.end < range.offset ||
    range.end > range.total ||
    range.end - range.offset !== Array.from(text).length ||
    range.end - range.offset > 4000 ||
    range.nextOffset !== (range.end < range.total ? range.end : null)
  )
    throw new Error("Routine history text range differs from its excerpt");
  return range.nextOffset;
}
async function routineHistory(kind = "intents", offset = 0, textOffset = 0) {
  if (
    !jobsSnap ||
    !["events", "intents"].includes(kind) ||
    ![offset, textOffset].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)
  )
    throw new Error("Routine history requires a loaded owned project and valid page");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(
      "Automation history",
      '<p class="note">Reading recent runs…</p>',
      "Recent runs and events. Read-only; nothing is replayed.",
    );
  const page = await api({ action: "schedule-history", id, kind, offset, limit: 30, textOffset, textLimit: 4000 });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (
    !page ||
    page.kind !== kind ||
    page.offset !== offset ||
    page.limit !== 30 ||
    !Array.isArray(page.items) ||
    page.items.length > 30 ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.items.length > Math.max(0, page.total - offset) ||
    page.nextOffset !== (offset + page.items.length < page.total ? offset + page.items.length : null) ||
    (page.nextOffset !== null && !page.items.length) ||
    !Number.isFinite(page.observedAtMs)
  )
    throw new Error("Routine history differs from the requested owned page");
  const continuations = [];
  for (const item of page.items) {
    if (!item || typeof item.requestId !== "string") throw new Error("Routine history is missing its recorded request identity");
    if (kind === "events") {
      if (item.projectId !== id || typeof item.eventId !== "string" || typeof item.kind !== "string")
        throw new Error("Event history is not bound to this project");
      const next = validateRoutineRange(item.payload, item.payloadRange, textOffset);
      if (next !== null) continuations.push(next);
    } else {
      if (
        typeof item.stableId !== "string" ||
        !["schedule", "event"].includes(item.kind) ||
        !["recorded", "submitted", "interrupted", "uncertain", "failed"].includes(item.status) ||
        (item.submissionId !== null && (!Number.isSafeInteger(item.submissionId) || item.submissionId < 1))
      )
        throw new Error("Invalid native intent identity/status");
      const next = validateRoutineRange(item.text, item.textRange, textOffset);
      if (next !== null) continuations.push(next);
      if (item.outcome === null ? item.outcomeRange !== null : !item.outcomeRange) throw new Error("Intent outcome/range mismatch");
      if (item.outcome !== null) {
        const nextOutcome = validateRoutineRange(item.outcome, item.outcomeRange, textOffset);
        if (nextOutcome !== null) continuations.push(nextOutcome);
      }
    }
  }
  const nextText = continuations.length ? Math.min(...continuations) : null,
    at = (nextOffset, nextTextOffset) => ({
      action: "routine-history",
      project: id,
      kind,
      offset: nextOffset,
      "text-offset": nextTextOffset,
    });
  const row = (item) =>
    kind === "events"
      ? `<div class="list-row"><div class="grow"><strong>${esc(humanKey(item.kind))}</strong><span class="meta">Event ${esc(item.eventId.slice(0, 12))}</span><pre class="excerpt">${esc(item.payload)}</pre></div>${rawDetails(item)}</div>`
      : `<div class="list-row"><div class="grow"><strong>${stateChip(humanKey(item.status), item.status === "submitted" ? "on" : ["uncertain", "failed", "interrupted"].includes(item.status) ? "warn" : "")}${esc(humanKey(item.kind))} run</strong><span class="meta">Request ${esc(item.requestId.slice(0, 12))}</span><pre class="excerpt">${esc(item.text)}</pre>${item.outcome !== null ? `<pre class="excerpt">${esc(item.outcome)}</pre>` : ""}</div>${rawDetails(item)}</div>`;
  setDialogBody(
    `<div class="seg-row">${segTabs([
      ["Runs", { action: "routine-history", project: id, kind: "intents", offset: 0, "text-offset": 0 }, kind === "intents"],
      ["Events", { action: "routine-history", project: id, kind: "events", offset: 0, "text-offset": 0 }, kind === "events"],
    ])}${pager({ offset, count: page.items.length, total: page.total, size: 30, data: { action: "routine-history", project: id, kind, "text-offset": 0 } })}</div><p class="note">Sampled ${esc(new Date(page.observedAtMs).toLocaleString())}. Long text is shown in parts; excerpts cannot prove the full text or any outside effect.</p>${page.items.map(row).join("") || '<p class="empty-state">Nothing recorded in this page.</p>'}${textOffset || nextText !== null ? `<div class="row">${textOffset ? dlgBtn("‹ Earlier text", at(offset, Math.max(0, textOffset - 4000)), "small") : ""}${nextText !== null ? dlgBtn("Later text ›", at(offset, nextText), "small") : ""}</div>` : ""}${dlgActions(dlgBtn("Back to schedules", { action: "routine-list", project: id }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`,
  );
}
function routineRecord(kind, recordId) {
  if (!routineCache || routineCache.project !== getProjectId() || !["schedule", "monitor", "events"].includes(kind))
    throw new Error("Owned routine snapshot unavailable; reread");
  if (kind === "events") return { eventOptIn: routineCache.schedules.eventOptIn };
  const record = (kind === "schedule" ? routineCache.schedules.schedules : routineCache.monitors.items).find(
    (record) => record.id === recordId,
  );
  if (!record) throw new Error("Routine not present in the displayed owned snapshot");
  return record;
}
function routineConfirm(kind, recordId, value) {
  if (value !== "true" && value !== "false") throw new Error("Routine desired state must be explicit");
  const record = routineRecord(kind, recordId),
    enabled = value === "true",
    id = getProjectId();
  if (getView().project.archived || getView().project.deleted) throw new Error("Restore this retained project before changing routines");
  if ((kind === "events" ? record.eventOptIn : record.enabled) === enabled)
    throw new Error("Displayed routine setting changed; reread before confirming");
  const binding = JSON.stringify(record),
    noun = kind === "events" ? "outside events" : `this ${kind}`,
    state = (on) => (on ? "On" : "Off");
  const version = showDialog(
    `Turn ${enabled ? "on" : "off"} ${noun}?`,
    `<div class="diff-list">${diffItem(["Status", state(!enabled), state(enabled)])}</div>${kind === "events" ? "" : recordSummary(record)}<p class="note">${enabled ? "Turning on lets it run while your Mac is awake. It does not resume the project, grant tools or publishing, clear an uncertain outcome or replay anything. Monitors also need outside events on and current repository access." : "Turning off keeps its schedule, history and cursors. It just stops running."}</p><form data-routine-change data-project="${esc(id)}"><input type="hidden" name="confirm" value="${esc(id)}">${dlgActions(dlgBtn("Back", { action: "routine-list", project: id, lens: kind === "monitor" ? "monitors" : "schedules" }), `<button type="submit" class="primary">Turn ${enabled ? "on" : "off"}</button>`)}</form>`,
    getView().project.name,
  );
  routineConfirmation = { project: id, kind, recordId, enabled, binding, version };
}
async function usageList(offset = 0) {
  if (!jobsSnap || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    throw new Error("Usage requires a loaded Durable project/valid page");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog("Usage", '<p class="note">Reading token counts…</p>', "Token counts recorded by the SDK. Estimates, not billing.");
  const page = await api({ action: "usage-snapshot", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (
    !page ||
    page.offset !== offset ||
    !Array.isArray(page.workers) ||
    page.workers.length > 100 ||
    !Number.isSafeInteger(page.totalWorkers) ||
    page.totalWorkers < 0 ||
    !page.coordinator ||
    (page.nextOffset !== null && (!page.workers.length || page.nextOffset !== offset + page.workers.length)) ||
    page.workers.some(
      (worker) =>
        !["thread", "legacy"].includes(worker.kind) ||
        (worker.kind === "thread" && !uuid(worker.threadId)) ||
        !Number.isSafeInteger(worker.conversationId),
    )
  )
    throw new Error("Usage projection differs from its owned conversation/page");
  const number = (value) => Number(value).toLocaleString(),
    stat = (label, value) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const counters = (value) => {
    if (
      !value ||
      [value.totalTokens, value.input, value.output, value.cacheRead, value.cacheWrite, value.cost?.total].some(
        (count) => typeof count !== "number" || !Number.isFinite(count) || count < 0,
      )
    )
      throw new Error("Invalid SDK usage counters");
    return `<div class="stats">${stat("Total tokens", number(value.totalTokens))}${stat("Input", number(value.input))}${stat("Output", number(value.output))}${stat("Cache read", number(value.cacheRead))}${stat("Cache written", number(value.cacheWrite))}${stat("Estimated cost", `$${value.cost.total.toFixed(2)}`)}</div>`;
  };
  const detail = (value) => `${counters(value.total)}${rawDetails({ models: value.models, tools: value.tools }, "By model and tool")}`;
  setDialogBody(
    `<h3>Coordinator</h3>${detail(page.coordinator)}<h3>Workers</h3><p class="note">${esc(page.totalThreads)} reusable threads and ${esc(page.legacyOnlyWorkers)} older workers. The totals below cover this page only, not the whole project.</p>${counters(page.workerPageTotal)}${page.workers.length ? `<div class="seg-row mt"><span class="note">Workers on this page</span>${pager({ offset, count: page.workers.length, total: page.totalWorkers, size: 100, data: { action: "usage-list" } })}</div>` : ""}${page.workers.map((worker) => `<div class="list-row"><div class="grow"><strong>${worker.kind === "thread" ? `Thread ${esc(worker.threadId.slice(0, 8))}` : `Earlier worker ${esc(worker.name)}`}</strong><span class="meta">${number(worker.total.totalTokens)} tokens · $${worker.total.cost.total.toFixed(2)} estimated${(worker.legacyNames ?? []).length ? ` · also known as ${esc(worker.legacyNames.join(", "))}` : ""}</span></div>${detail(worker)}</div>`).join("") || '<p class="empty-state">No workers have run yet.</p>'}<p class="note">Observed ${esc(new Date(page.observedAtMs).toLocaleString())}. ${esc(String(page.accounting).replace(/\.$/, ""))}. SDK estimates are not billing or verified spend.</p>${dlgActions(dlgBtn("Refresh", { action: "usage-list", offset }), dlgBtn("Close", { action: "close-dialog" }, "primary"))}`,
  );
}
async function ownerSetupDialog(result = null) {
  const id = getProjectId(),
    generationAtOpen = getGeneration(),
    version = showDialog(
      "Owner setup",
      '<p class="note">Reading current owner bindings…</p>',
      "What workers on this project are allowed to touch.",
    );
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || getProjectId() !== id || getGeneration() !== generationAtOpen) return;
  const row = (title, meta, button) =>
    `<div class="list-row"><div class="grow"><strong>${title}</strong><span class="meta">${meta}</span></div><div class="row-actions">${button}</div></div>`;
  const workspaces =
    (snapshot.workspace?.scopes || [])
      .map((scope) =>
        row(
          `${esc(scope.repositoryId)}${scope.wholeRepository ? " · whole repository" : ""}`,
          `${scope.fileCount} files · base ${esc(String(scope.baseRevision).slice(0, 12))} · scope ${esc(String(scope.id).slice(0, 8))}`,
          dlgBtn(
            "Revoke…",
            {
              action: "owner-setup-edit",
              kind: "workspace-revoke",
              payload: JSON.stringify({ scopeId: scope.id, expectedRevision: snapshot.workspaceRevision }),
            },
            "danger small",
          ),
        ),
      )
      .join("") || '<p class="empty-state">No folder scopes.</p>';
  const github =
    (snapshot.github || [])
      .map((auth) =>
        row(
          esc(auth.repositoryId),
          `Branches ${esc(auth.branchPrefix)}… · draft PRs against ${esc(auth.baseBranch)}`,
          dlgBtn(
            "Revoke…",
            {
              action: "owner-setup-edit",
              kind: "github-revoke",
              payload: JSON.stringify({ repositoryId: auth.repositoryId, expectedRevision: snapshot.githubRevision }),
            },
            "danger small",
          ),
        ),
      )
      .join("") || '<p class="empty-state">No GitHub authorizations.</p>';
  const profiles =
    (snapshot.profiles || [])
      .map((profile) =>
        row(
          `${esc(profile.label)}`,
          `${esc(profile.repositoryId)} · ${profile.enabled ? "enabled" : "disabled"} · ${esc(profile.blocker || "no blocker")}`,
          dlgBtn("View command", { action: "owner-profile-read", project: id, profile: profile.id }, "small"),
        ),
      )
      .join("") || '<p class="empty-state">No command profiles.</p>';
  const seeds = {
    "workspace-grant": {
      expectedRevision: snapshot.workspaceRevision,
      provider: "github",
      repositoryId: "",
      ownerCheckout: getView().project.cwd,
      approvedRoot: "",
      fileOwnershipPrefix: "",
      files: [],
      baseRevision: "",
    },
    "github-authorize": { expectedRevision: snapshot.githubRevision, repositoryId: "", expectedRepositoryId: 0, branchPrefix: "" },
    "command-profile-set": {
      expectedRevision: snapshot.profilesRevision,
      profile: {
        id: crypto.randomUUID(),
        label: "",
        repositoryId: "",
        scopeIds: [],
        executable: "",
        arguments: [],
        effect: "workspace",
        timeoutMs: 300000,
        maxOutputBytes: 65536,
        enabled: false,
      },
    },
  };
  const actions = [
    ["workspace-grant", "Add a folder scope"],
    ["github-authorize", "Authorize a GitHub repository"],
    ["command-profile-set", "Register a command profile"],
  ]
    .map(([kind, label]) => dlgBtn(label, { action: "owner-setup-edit", kind, payload: JSON.stringify(seeds[kind]) }, "small"))
    .join("");
  const hist = `<p class="note">${esc((snapshot.configuredCatalog?.reason || "Configured skills unavailable").replace(/\.$/, ""))}. Registering a command profile does not run it or approve deployments or destructive actions.</p>${rawDetails({ workspaceRevision: snapshot.workspaceRevision, githubRevision: snapshot.githubRevision, profilesRevision: snapshot.profilesRevision }, "Revisions")}`;
  const whole = (snapshot.workspace?.scopes || []).find((scope) => scope.wholeRepository);
  const connected = whole && (snapshot.github || []).find((auth) => auth.repositoryId === whole.repositoryId);
  const providerCardHtml = (card) =>
    `<div class="card"><b>${card.state === "connected" ? "✓ " : ""}${esc(card.title)}</b><p class="note">${esc(card.body)}</p>${card.state === "available" && card.connect ? `<button class="primary" data-action="provider-connect" data-card="${esc(card.id)}">${esc(card.connect.label)}</button>` : ""}</div>`;
  const pluginCards = !whole
    ? ""
    : snapshot.unloadedProvider
      ? `<div class="card"><b>${esc(snapshot.unloadedProvider)}</b><p class="note">The provider plugin is not loaded, so workers cannot start here. Load it (see the plugin documentation) or remove the grant; its records are kept.</p></div>`
      : (snapshot.providerCards ?? []).map(providerCardHtml).join("");
  const githubCard = !whole
    ? ""
    : snapshot.workspace?.provider && snapshot.workspace.provider !== "github"
      ? pluginCards
      : connected
        ? `<div class="card"><b>✓ GitHub connected</b><p class="note">Workers push ${esc(connected.branchPrefix)} branches to ${esc(connected.repositoryId)} and open draft PRs against ${esc(connected.baseBranch)}. You approve merges.</p></div>`
        : snapshot.githubQuick?.available
          ? `<div class="card"><b>GitHub</b><p class="note">Workers cannot open draft PRs yet.</p><button class="primary" data-action="github-quick">Connect GitHub</button></div>`
          : `<div class="card"><b>GitHub</b><p class="note">${esc(snapshot.githubQuick?.blocker || "One-click GitHub is unavailable")}</p></div>`;
  const quick = whole
    ? githubCard
    : snapshot.quickGrant?.available
      ? `<div class="card"><b>Workspace</b><p class="note">Workers cannot edit code yet.</p><button class="primary" data-action="workspace-quick">Let workers edit this repo</button></div>`
      : `<div class="card"><b>Workspace</b><p class="note">${esc(snapshot.quickGrant?.blocker || "One-click access is unavailable")}</p></div>`;
  setDialogBody(
    `${result ? `<p class="note-box ok">Change recorded. No command was run.</p>${rawDetails(result, "Host response")}` : ""}<div class="choice-list">${quick}</div><details class="advanced"><summary>Advanced: folder scopes, GitHub targets, command profiles</summary>${hist}<h3>Look up a GitHub repository</h3><form data-owner-github-inspect data-project="${esc(id)}" class="row"><label class="grow"><span class="sr-only">Repository, owner/name</span><input name="repositoryId" placeholder="owner/repository" aria-label="Repository, owner/name" required></label><button type="submit" class="small">Look up</button></form><p class="note">Reads its numeric ID and default branch. It must match the checkout's GitHub origin.</p><h3>Add or change</h3><div class="row">${actions}</div><h3>Folder scopes</h3>${workspaces}<h3>GitHub authorizations</h3>${github}<h3>Command profiles</h3>${profiles}</details>${dlgActions(dlgBtn("Refresh", { action: "owner-setup" }), dlgBtn("Done", { action: "close-dialog" }, "primary"))}`,
  );
}

async function workspaceQuickDialog() {
  const id = getProjectId(),
    generationAtOpen = getGeneration(),
    version = showDialog(
      "Let workers edit this repo",
      '<p class="note">Reading the project checkout…</p>',
      "Workers get their own copy of your checkout. Your files are never written.",
    );
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || getProjectId() !== id || getGeneration() !== generationAtOpen) return;
  const quick = snapshot.quickGrant;
  if (!quick?.available) {
    dialog.querySelector(".dialog-body").innerHTML =
      `<p>${esc(quick?.blocker || "One-click access is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`;
    return;
  }
  const other = quick.provider !== "github",
    extra = quick.dialog;
  dialog.querySelector(".dialog-body").innerHTML =
    `<div class="kv"><span>Repository</span><b>${esc(quick.repositoryId)}</b><span>${other ? esc(extra?.checkoutLabel ?? "Checkout") : "Checkout"}</span><b class="mono">${esc(quick.ownerCheckout)}</b>${(extra?.rows ?? []).map(([label, value]) => `<span>${esc(label)}</span><b class="mono">${esc(value)}</b>`).join("")}<span>Worker copies</span><b class="mono">${esc(quick.approvedRoot)}</b><span>${other ? "Base head" : "Current HEAD"}</span><b class="mono">${esc(quick.head.slice(0, 12))}</b></div>
${other ? `<ul>${(extra?.bullets ?? []).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : `<ul><li>Each worker gets its own git worktree, starting from HEAD at the time it starts.</li><li>Workers may read, edit and create any file except VCS metadata (.git). Your checkout is never written.</li><li>Workers may run repository commands in their isolated worktree. Draft PRs need GitHub (step 1); merges always need your approval.</li></ul>`}${quick.dirty ? `<p class="notice">Your checkout has uncommitted changes. Workers ${other ? "start from the provider's base and" : "will"} not see them.</p>` : ""}
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Allow workers to edit", { action: "workspace-quick-confirm", project: id, revision: snapshot.workspaceRevision }, "primary"))}`;
}

async function workspaceQuickConfirm(target, revision) {
  requireProject(target);
  await mutate(
    { action: "workspace-quick-grant", id: target, confirm: target, expectedRevision: revision },
    "Workers can now edit this repository.",
  );
  if (getProjectId() === target && dialog.open) await ownerSetupDialog();
}
// One-click connection of a workspace provider plugin: the plugin's setup card describes the dialog; the confirm calls its RPC with the card's revision.
let connectDraft = null;
async function providerConnectDialog(cardId) {
  const id = getProjectId(),
    generationAtOpen = getGeneration(),
    version = showDialog("Connect", '<p class="note">Reading the project…</p>', "");
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (!dialog.open || version !== dialogVersion || getProjectId() !== id || getGeneration() !== generationAtOpen) return;
  const card = (snapshot.providerCards ?? []).find((item) => item.id === cardId);
  if (!card?.connect) {
    dialog.querySelector(".dialog-body").innerHTML =
      `<p>${esc(card?.body || "This connection is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`;
    return;
  }
  const connect = card.connect;
  dialog.querySelector("#dialog-title").textContent = connect.dialog.title;
  connectDraft = card;
  dialog.querySelector(".dialog-body").innerHTML =
    `${connect.dialog.intro ? `<p>${esc(connect.dialog.intro)}</p>` : ""}<ul>${connect.dialog.bullets.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn(connect.dialog.confirmLabel, { action: "provider-connect-confirm", project: id, card: card.id, revision: card.revision }, "primary"))}`;
}
async function providerConnectConfirm(target, cardId, revision) {
  requireProject(target);
  const connect = connectDraft?.id === cardId ? connectDraft.connect : null;
  if (!connect) throw new Error("This connection is no longer available; refresh");
  await mutate(
    {
      action: "plugin",
      plugin: connect.rpc.plugin,
      method: connect.rpc.method,
      id: target,
      params: { confirm: target, expectedRevision: revision },
    },
    connect.success,
  );
  if (getProjectId() === target && dialog.open) await ownerSetupDialog();
}
async function githubQuickDialog() {
  const id = getProjectId(),
    generationAtOpen = getGeneration(),
    version = showDialog(
      "Connect GitHub",
      '<p class="note">Reading the repository from GitHub…</p>',
      "Let workers push branches and open draft pull requests.",
    );
  const stale = () => !dialog.open || version !== dialogVersion || getProjectId() !== id || getGeneration() !== generationAtOpen;
  const snapshot = await api({ action: "owner-setup-snapshot", id });
  if (stale()) return;
  const quick = snapshot.githubQuick;
  if (!quick?.available) {
    dialog.querySelector(".dialog-body").innerHTML =
      `<p>${esc(quick?.blocker || "One-click GitHub is unavailable")}</p>${dlgActions(dlgBtn("Open owner setup", { action: "owner-setup" }, "primary"))}`;
    return;
  }
  let remote;
  try {
    remote = await api({ action: "github-repository-inspect", id, repositoryId: quick.repositoryId });
  } catch (error) {
    if (!stale())
      dialog.querySelector(".dialog-body").innerHTML =
        `<p>gh could not read ${esc(quick.repositoryId)}: ${esc(error.message)}</p><p class="note">Run <code>gh auth login</code>, then try again.</p>${dlgActions(dlgBtn("Close", { action: "close-dialog" }))}`;
    return;
  }
  if (stale()) return;
  dialog.querySelector(".dialog-body").innerHTML =
    `<div class="kv"><span>Repository</span><b>${esc(remote.repositoryId)}</b><span>Repository ID</span><b class="mono">${esc(remote.numericId)}</b><span>Draft PRs target</span><b class="mono">${esc(remote.defaultBranch)}</b><span>Worker branches</span><b class="mono">${esc(quick.branchPrefix)}…</b></div>
<ul><li>Each worker commits and pushes only its own ${esc(quick.branchPrefix)} branch.</li><li>The host checks that the pushed branch matches the worker's HEAD, then opens or updates a draft PR against ${esc(remote.defaultBranch)}.</li><li>Workers can read PRs, CI results and reviews, and reply to review comments.</li><li>Merges always need your approval.</li></ul>
${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("Connect GitHub", { action: "github-quick-confirm", project: id, revision: snapshot.githubRevision }, "primary"))}`;
}

async function githubQuickConfirm(target, revision) {
  requireProject(target);
  await mutate(
    { action: "github-quick-authorize", id: target, confirm: target, expectedRevision: revision },
    "GitHub connected. Workers can open draft PRs.",
  );
  if (getProjectId() === target && dialog.open) await ownerSetupDialog();
}
const ownerEditCopy = {
  "workspace-grant": ["Add a folder scope", "Let workers read and edit files under one approved folder.", "Create scope"],
  "github-authorize": [
    "Authorize a GitHub repository",
    "Let workers push branches and open draft pull requests on one repository.",
    "Authorize",
  ],
  "command-profile-set": [
    "Register a command profile",
    "A fixed executable and arguments that workers may run. It is not run now.",
    "Save profile",
  ],
  "workspace-revoke": [
    "Revoke this folder scope?",
    "Workers lose access to it for future work. Receipts and history stay.",
    "Revoke access",
  ],
  "github-revoke": [
    "Revoke GitHub access?",
    "Workers can no longer push or open pull requests there. Receipts and history stay.",
    "Revoke access",
  ],
};
// Owner-setup writes keep their exact API fields; the form shows them as labelled controls and rebuilds the same JSON object.
function ownerFieldInputs(value, path = [], hidden = false) {
  return Object.entries(value)
    .map(([key, item]) => {
      const name = [...path, key].join("."),
        label = humanKey(key),
        data = `data-path="${esc(name)}" data-type="${typeof item}"`;
      if (item && typeof item === "object" && !Array.isArray(item))
        return `${hidden ? "" : `<h3>${esc(label)}</h3>`}${ownerFieldInputs(item, [...path, key], hidden)}`;
      if (hidden || key === "expectedRevision" || key === "id") return `<input type="hidden" ${data} value="${esc(item)}">`;
      if (Array.isArray(item))
        return `<div class="field"><label><span class="flabel">${esc(label)}</span><span class="fhelp">One per line.</span><textarea rows="3" data-path="${esc(name)}" data-type="lines" spellcheck="false">${esc(item.join("\n"))}</textarea></label></div>`;
      if (typeof item === "boolean")
        return `<div class="field"><label class="checkbox"><input type="checkbox" data-path="${esc(name)}" data-type="boolean"${item ? " checked" : ""}><span>${esc(label)}</span></label></div>`;
      return `<div class="field"><label><span class="flabel">${esc(label)}</span><input ${data} ${typeof item === "number" ? 'type="number"' : ""} value="${esc(item)}"></label></div>`;
    })
    .join("");
}
function ownerFieldsValue(form) {
  const fields = {};
  for (const input of form.querySelectorAll("[data-path]")) {
    const keys = input.dataset.path.split("."),
      type = input.dataset.type;
    const value =
      type === "lines"
        ? input.value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : type === "boolean"
          ? input.checked
          : type === "number"
            ? Number(input.value)
            : input.value;
    let target = fields;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  return fields;
}
async function ownerSetupEdit(kind, payload) {
  if (!getView()) throw new Error("Select a project before owner setup");
  const target = getProjectId(),
    currentGeneration = getGeneration();
  let initial;
  try {
    initial = JSON.parse(payload);
  } catch {
    throw new Error("Owner setup seed is invalid");
  }
  if (getProjectId() !== target || getGeneration() !== currentGeneration || !Object.hasOwn(ownerEditCopy, kind)) return;
  const [title, subtitle, submit] = ownerEditCopy[kind],
    revoke = kind.endsWith("-revoke");
  const summary = revoke
    ? `<div class="kv tight">${Object.entries(initial)
        .filter(([key]) => key !== "expectedRevision")
        .map(([key, value]) => `<span>${esc(humanKey(key))}</span><b class="mono">${esc(value)}</b>`)
        .join("")}</div><input type="hidden" name="confirm" value="${esc(target)}">`
    : "";
  showDialog(
    title,
    `<form data-owner-write data-kind="${esc(kind)}" data-project="${esc(target)}">${summary}${ownerFieldInputs(initial, [], revoke)}<p class="note">${revoke ? "Revoking only stops future work. Nothing already recorded is deleted." : "The host checks the revision you are looking at and the repository identity before it saves. Nothing runs."}</p>${dlgActions(dlgBtn("Cancel", { action: "owner-setup" }), `<button type="submit" class="primary${revoke ? " danger" : ""}">${submit}</button>`)}</form>`,
    subtitle,
  );
}

async function ownerProfileRead(target, profileId) {
  requireProject(target);
  const generationAtOpen = getGeneration(),
    version = showDialog("Command profile", '<p class="note">Reading the exact command…</p>', "Fixed by you. The model cannot change it.");
  const profile = await api({ action: "command-profile-read", id: target, profileId });
  if (getProjectId() !== target || getGeneration() !== generationAtOpen || !dialog.open || dialogVersion !== version) return;
  setDialogBody(
    `<h3>Command</h3><pre>${esc([profile.executable, ...(profile.arguments ?? [])].filter((part) => part !== undefined).join(" "))}</pre><p class="note">Workers cannot supply the executable, arguments, folder or environment. A profile does not approve deployments or destructive actions.</p><h3>Details</h3>${recordSummary(profile, ["executable"])}${dlgActions(dlgBtn("Back to owner setup", { action: "owner-setup" }, "primary"))}`,
  );
}
onDialogClose(() => {
  routineConfirmation = null;
  providerInspection = null;
});
