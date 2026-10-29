import {
  api,
  closeCurrentDialog,
  compactTokens,
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
  isBusy,
  mutate,
  onDialogClose,
  onProjectChange,
  onRender,
  onTab,
  persistBrowserDrafts,
  persistDraftsSafely,
  projects,
  registerActions,
  registerDrafts,
  registerForms,
  requireProject,
  scrollBehavior,
  setDialogBody,
  setHtml,
  setProjects,
  showDialog,
  tab,
  toast,
  uiAction,
  probe,
} from "./shell.js";
import { esc } from "./format.js";
import { chatId, renderProjects } from "./chat.js";
import { jobsSnap } from "./decisions.js";
import { editableKnowledge } from "./knowledge.js";
import { loadAutomationStrip, loadEventsIn } from "./admin.js";
import { renderModelCycle } from "./search.js";

const settingsDrafts = new Map();
if (probe) window.settingsDrafts = settingsDrafts;
export const modelCache = new Map();
let settingsCache = null;
let settingsConfirmation = null;
// E2E runs (?e2e=1) assert that closing a dialog drops its pending proposal.
if (probe) Object.defineProperty(window, "settingsConfirmation", { get: () => settingsConfirmation });
onProjectChange(() => {
  settingsCache = null;
  modelCache.clear();
  document.querySelector("#settings-summary").replaceChildren();
});
onTab((next) => {
  if (next !== "settings") return;
  void loadSkillsPicker();
  void loadMcpPicker();
  void loadPrompts(true, true);
  void loadWorktrees();
});

function renderSettings() {
  const p = getView().project;
  document.querySelector("#settings-button").hidden = !jobsSnap;
  renderModelCycle();
  setHtml(
    "#settings-summary",
    `<div class="kv"><span>Coordinator model</span><b>${esc(p.model)}</b>${Object.entries(p.models ?? {})
      .map(([role, model]) => `<span>${esc(role[0].toUpperCase() + role.slice(1))} model</span><b>${esc(model)}</b>`)
      .join("")}${Object.entries(p.fallbackModels ?? {})
      .map(([role, model]) => `<span>${esc(role[0].toUpperCase() + role.slice(1))} quota fallback</span><b>${esc(model)}</b>`)
      .join("")}<span>Workspace</span><b class="mono">${esc(p.cwd)}</b></div>`,
  );
}
onRender(renderSettings);

function renderSettingsCards() {
  if (tab === "settings" && jobsSnap) {
    void loadAutomationStrip();
    void loadEventsIn();
    void loadSkillsPicker();
    void loadMcpPicker();
    void loadPrompts();
    void loadWorktrees();
    void loadContextSettings();
  }
  renderContextMeter(getView().context);
}
onRender(renderSettingsCards);
async function cycleModel(step) {
  if (!getProjectId() || !getView()) return;
  await loadModelPicker();
  if (modelScopeSet && !modelScoped.length)
    throw new Error(
      "None of your scoped models is usable (not installed or no credentials). Fix the scope in Settings; the model button never switches outside it.",
    );
  const configured = [...modelCache.values()].filter((model) => model.configured).map((model) => model.reference),
    list = modelScopeSet ? modelScoped : configured;
  const at = list.indexOf(getView().project.model),
    next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length];
  if (!next || next === getView().project.model) {
    toast("There is no other scoped model to switch to. Edit the scope in Settings.");
    return;
  }
  const settings = await api({ action: "settings-snapshot", id: getProjectId() });
  const focused = document.activeElement,
    id = getProjectId(),
    chat = chatId;
  try {
    await mutate(
      { action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { model: next } },
      `Coordinator model: ${modelCache.get(next)?.name ?? next}. Next requests and new threads use it.`,
    );
    settingsCache = null;
  } finally {
    // Disabling the composer during the update drops focus; do not steal it from another field or dialog.
    if (
      getProjectId() === id &&
      chatId === chat &&
      !dialog.open &&
      document.activeElement === document.body &&
      focused?.isConnected &&
      !focused.disabled
    )
      focused.focus({ preventScroll: true });
  }
}
function renderContextMeter(context) {
  const meter = document.querySelector("#compose .context-meter");
  const known = context && context.window;
  const percent = known ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : 0;
  const label = known
    ? `Context ${percent}% used · ${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens`
    : "Context use unknown";
  const circumference = 2 * Math.PI * 8;
  meter
    .querySelector(".fill")
    .setAttribute("stroke-dasharray", `${((circumference * percent) / 100).toFixed(2)} ${circumference.toFixed(2)}`);
  meter.dataset.level = percent >= 90 ? "high" : percent >= 70 ? "mid" : "low";
  meter.setAttribute("aria-label", label);
  const popup = meter.querySelector(".context-popup"),
    compacting = !!context?.compacting;
  const popupHtml = `<span class="context-label">${esc(compacting ? `${label} · compacting…` : label)}</span><button type="button" class="ghost small" data-action="compact-now" ${compacting ? "disabled" : ""}>${compacting ? "Compacting…" : "Compact now"}</button>`;
  if (popup.dataset.html !== popupHtml) {
    popup.innerHTML = popupHtml;
    popup.dataset.html = popupHtml;
  }
  meter.querySelector(".context-pct").textContent = known ? `${percent}%` : "";
}

// Skills (Settings): "All profiles" plus per-role additions. Prompts carry only names and descriptions; bodies are read on demand.
const skillProfileTabs = [
  ["all", "All profiles"],
  ["coordinator", "Coordinator"],
  ["worker", "Worker"],
  ["scout", "Scout"],
  ["reviewer", "Reviewer"],
];
const skillSourceLabels = { repo: "Repository", global: "Global", package: "Packages" };
let skillsPicker = null;
async function loadSkillsPicker(force = false) {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#skills-picker");
  if (!id || !jobsSnap) return;
  // Opening Settings rebuilds the list from disk. Unsaved choices are kept: only the catalog is refreshed, so a skill installed meanwhile still shows up.
  if (!force && skillsPicker?.projectId === id && JSON.stringify(skillsPicker.draft) !== skillsPicker.saved) {
    try {
      const { skills } = await api({ action: "coordinator-skills", id });
      if (id === getProjectId() && current === getGeneration() && skillsPicker?.projectId === id) {
        skillsPicker.skills = skills;
        renderSkillsPicker();
      }
    } catch {}
    return;
  }
  try {
    const [settings, { skills }] = await Promise.all([api({ action: "settings-snapshot", id }), api({ action: "coordinator-skills", id })]);
    if (id !== getProjectId() || current !== getGeneration()) return;
    const saved = settings.values.skills;
    const profiles = { ...{ all: [], coordinator: [], worker: [], scout: [], reviewer: [] }, ...(saved?.off ?? {}) };
    skillsPicker = {
      projectId: id,
      skills,
      isDefault: !saved?.off || !Object.values(saved.off).some((list) => list.length),
      draft: sortedLists(profiles),
      saved: JSON.stringify(sortedLists(profiles)),
      tab: skillsPicker?.projectId === id ? skillsPicker.tab : "all",
      query: skillsPicker?.projectId === id ? skillsPicker.query : "",
      note: "",
    };
    renderSkillsPicker();
  } catch (error) {
    if (id === getProjectId() && current === getGeneration())
      node.innerHTML = `<p class="note">Skills unavailable: ${esc(error.message)}</p>`;
  }
}
// Pickers render in three parts so a toggle never moves anything: "all" = shell (tabs, search, list), "list" = rows only (search, bulk), "chrome" = counts and buttons only (a checkbox toggle).
const sortedLists = (value) => Object.fromEntries(Object.entries(value).map(([key, list]) => [key, [...list].sort()])); // toggling re-sorts a list; a saved list in another order must not look dirty
// One shared selection is the normal case. Per-role lists stay reachable, and open by themselves when a role already has its own.
const rolesShown = (state) =>
  state.roles || state.tab !== "all" || ["coordinator", "worker", "scout", "reviewer"].some((role) => state.draft[role].length);
const profileTabsHtml = (action, tab, count, expanded) =>
  `<div class="skill-tabs" role="tablist">${skillProfileTabs.map(([role, label]) => `<button type="button" role="tab"${role !== "all" && !expanded ? " hidden" : ""} class="ghost small${role === tab ? " on" : ""}" aria-selected="${role === tab}" data-action="${action}" data-role="${role}">${label} <span class="count">${count(role)}</span></button>`).join("")}${expanded ? "" : `<button type="button" class="ghost small" data-action="profile-roles" data-picker="${action.split("-")[0]}">Different per role…</button>`}</div>`;
const patchPickerChrome = (node, count, dirty) => {
  for (const button of node.querySelectorAll(".skill-tabs [data-role]"))
    button.querySelector(".count").textContent = count(button.dataset.role);
  const save = node.querySelector('[data-action$="-save"]');
  if (save) {
    save.disabled = !dirty;
    save.toggleAttribute("data-off", !dirty);
  }
  const bar = node.querySelector(".pick-state");
  if (bar) bar.hidden = !dirty;
};
const bulkButtons = (action, source = "") =>
  `<span class="pick-bulk"><button type="button" class="ghost small" data-action="${action}" data-source="${source}" data-mode="all">Select all</button><button type="button" class="ghost small" data-action="${action}" data-source="${source}" data-mode="none">Clear</button></span>`;
function skillsShown(state) {
  const q = state.query.trim().toLowerCase();
  return state.skills.filter((skill) => !q || skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
}
function skillsListHtml(state) {
  const all = new Set(state.draft.all),
    picked = new Set(state.draft[state.tab]),
    shown = skillsShown(state);
  const groups = Object.keys(skillSourceLabels)
    .map((source) => [source, shown.filter((skill) => skill.source === source)])
    .filter(([, list]) => list.length);
  const row = (skill) => {
    const inherited = state.tab !== "all" && all.has(skill.name);
    return `<label class="skill-pick${inherited ? " inherited" : ""}"><input type="checkbox" data-skill-pick="${esc(skill.name)}" ${!inherited && !picked.has(skill.name) ? "checked" : ""} ${inherited ? "disabled" : ""}><span><b>${esc(skill.name)}</b>${inherited ? ' <small class="skill-tag">off for all profiles</small>' : ""}${skill.manual ? ' <small class="skill-tag">manual only</small>' : ""}<small>${esc(skill.description)}</small></span></label>`;
  };
  return (
    groups
      .map(
        ([source, list]) =>
          `<fieldset class="events-group skill-group" data-source="${source}" aria-label="${skillSourceLabels[source]}"><div class="group-head"><b>${skillSourceLabels[source]} <span class="count">${list.length}</span></b>${bulkButtons("skills-select", source)}</div>${list.map(row).join("")}</fieldset>`,
      )
      .join("") || '<p class="note">No skill matches.</p>'
  );
}
function renderSkillsPicker(part = "all") {
  const state = skillsPicker,
    node = document.querySelector("#skills-picker");
  if (!state || state.projectId !== getProjectId()) return;
  const known = new Set(state.skills.map((skill) => skill.name)),
    count = (role) =>
      state.skills.length -
      new Set([...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter((name) => known.has(name))).size;
  document.querySelector("#skills-summary").textContent = `${state.skills.length} loaded · ${count("all")} on for every profile`;
  const dirty = JSON.stringify(state.draft) !== state.saved;
  if (part === "chrome" && node.querySelector(".skill-groups")) return patchPickerChrome(node, count, dirty);
  if (part === "list" && node.querySelector(".skill-groups")) {
    node.querySelector(".skill-groups").innerHTML = skillsListHtml(state);
    node.querySelector(".pick-note").innerHTML = skillsNote(state);
    return patchPickerChrome(node, count, dirty);
  }
  node.innerHTML = `${profileTabsHtml("skills-tab", state.tab, count, rolesShown(state))}
    <p class="note pick-note">${skillsNote(state)}</p>
    <div class="pick-tools"><input type="search" id="skills-search" placeholder="Search ${state.skills.length} skills" value="${esc(state.query)}" aria-label="Search skills">${bulkButtons("skills-select")}</div>
    <div class="skill-groups">${skillsListHtml(state)}</div>
    ${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row pick-actions"><button class="primary" data-action="skills-save" ${dirty ? "" : "disabled data-off"}>Save skills</button><button class="ghost" data-action="skills-reset" ${state.isDefault ? "disabled data-off" : ""}>Turn all on</button><small class="pick-state" ${dirty ? "" : "hidden"}>Unsaved changes</small></div>`;
}
const skillsNote = (state) =>
  (state.tab === "all"
    ? "All installed skills are on, including ones installed later. Uncheck to switch one off for every profile."
    : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} uses every skill that is on. Uncheck to switch one off for this profile only.`) +
  (state.query.trim() ? ` Select all and Clear apply to the ${skillsShown(state).length} shown.` : "");
/** Bulk select or clear the skills currently shown (respecting search), optionally for one source. Inherited rows stay as they are. */
function bulkSkills(source, mode) {
  const state = skillsPicker,
    list = new Set(state.draft[state.tab]),
    inherited = new Set(state.tab === "all" ? [] : state.draft.all);
  for (const skill of skillsShown(state))
    if ((!source || skill.source === source) && !inherited.has(skill.name)) {
      if (mode === "all") list.delete(skill.name);
      else list.add(skill.name);
    }
  state.draft[state.tab] = [...list].sort();
  state.note = "";
  renderSkillsPicker("list");
}
async function saveSkillsPicker(reset) {
  const state = skillsPicker,
    id = getProjectId();
  if (!state || state.projectId !== id) throw new Error("Reload Settings before saving skills");
  const settings = await api({ action: "settings-snapshot", id });
  try {
    await mutate(
      {
        action: "settings-update",
        id,
        confirm: id,
        expectedRevision: settings.revision,
        changes: { skills: reset ? null : { off: state.draft } },
      },
      reset ? "All skills are on again." : "Skills saved. New threads use them; running threads keep theirs.",
    );
  } catch (error) {
    state.note = error.message;
    renderSkillsPicker();
    throw error;
  }
  await loadSkillsPicker(true);
}
document.addEventListener("change", (event) => {
  const box = event.target.closest("[data-skill-pick]");
  if (!box || !skillsPicker) return;
  const list = new Set(skillsPicker.draft[skillsPicker.tab]);
  if (box.checked) list.delete(box.dataset.skillPick);
  else list.add(box.dataset.skillPick);
  skillsPicker.draft[skillsPicker.tab] = [...list].sort();
  skillsPicker.note = "";
  renderSkillsPicker("chrome");
});
document.addEventListener("input", (event) => {
  if (event.target.id !== "skills-search" || !skillsPicker) return;
  skillsPicker.query = event.target.value;
  renderSkillsPicker("list");
});

// MCP servers (Settings): same profile model as skills, plus a per-server "Allow writes". Servers come from the owner's mcp.json; env and arguments never reach the browser.
const mcpStatusText = {
  ready: "",
  disabled: "disabled in mcp.json",
  "needs-sign-in": "needs sign-in (not supported)",
  invalid: "invalid config",
};
let mcpPicker = null;
async function loadMcpPicker(force = false) {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#mcp-picker");
  if (!id || !jobsSnap || (!force && mcpPicker?.projectId === id)) return;
  try {
    const [settings, catalog] = await Promise.all([api({ action: "settings-snapshot", id }), api({ action: "mcp-catalog", id })]);
    if (id !== getProjectId() || current !== getGeneration()) return;
    const saved = {
      ...{ all: [], coordinator: [], worker: [], scout: [], reviewer: [] },
      ...(settings.values.mcp?.off ?? {}),
      writes: settings.values.mcp?.writes ?? [],
    };
    mcpPicker = {
      projectId: id,
      catalog,
      isDefault: !settings.values.mcp,
      draft: sortedLists(saved),
      saved: JSON.stringify(sortedLists(saved)),
      tab: mcpPicker?.projectId === id ? mcpPicker.tab : "all",
      note: "",
      probes: {},
      query: mcpPicker?.projectId === id ? mcpPicker.query : "",
    };
    renderMcpPicker();
  } catch (error) {
    if (id === getProjectId() && current === getGeneration()) node.innerHTML = `<p class="note">MCP unavailable: ${esc(error.message)}</p>`;
  }
}
const mcpShown = (state) => {
  const q = state.query.trim().toLowerCase();
  return state.catalog.servers.filter((item) => !q || item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q));
};
function mcpListHtml(state) {
  const all = new Set(state.draft.all),
    picked = new Set(state.draft[state.tab]);
  const row = (server) => {
    const usable = server.status === "ready",
      inherited = state.tab !== "all" && all.has(server.name),
      probe = state.probes[server.name];
    return `<div class="skill-pick${inherited || !usable ? " inherited" : ""}"><input type="checkbox" data-mcp-pick="${esc(server.name)}" aria-label="Enable ${esc(server.name)}" ${usable && !inherited && !picked.has(server.name) ? "checked" : ""} ${inherited || !usable ? "disabled" : ""}><span><b>${esc(server.name)}</b>${inherited ? ' <small class="skill-tag">off for all profiles</small>' : ""}${usable ? "" : ` <small class="skill-tag">${esc(mcpStatusText[server.status] ?? server.status)}</small>`}<small>${esc(server.description)}</small>${usable ? `<span class="mcp-actions"><label class="check"><input type="checkbox" data-mcp-writes="${esc(server.name)}" ${state.draft.writes.includes(server.name) ? "checked" : ""}> Allow writes <small>(tools that change things; off = read-only)</small></label><span class="row"><button type="button" class="ghost small" data-action="mcp-test" data-server="${esc(server.name)}">Test</button>${probe ? `<small class="${probe.ok ? "" : "bad"}">${esc(probe.ok ? `${probe.tools} tools` : probe.error)}</small>` : ""}</span></span>` : ""}</span></div>`;
  };
  const shown = mcpShown(state);
  return (
    shown.map(row).join("") ||
    `<p class="note">${state.catalog.servers.length ? "No server matches." : `No servers in ${esc(state.catalog.path)}.`}</p>`
  );
}
const mcpNote = (state) =>
  (state.tab === "all"
    ? "All servers in mcp.json are on, including ones added later. Uncheck to switch one off for every profile. Write tools stay blocked unless “Allow writes” is checked."
    : `${esc(skillProfileTabs.find(([role]) => role === state.tab)[1])} uses every server that is on. Uncheck to switch one off for this profile only.`) +
  (state.query.trim() ? ` Select all and Clear apply to the ${mcpShown(state).length} shown.` : "");
function renderMcpPicker(part = "all") {
  const state = mcpPicker,
    node = document.querySelector("#mcp-picker");
  if (!state || state.projectId !== getProjectId()) return;
  const servers = state.catalog.servers,
    known = new Set(servers.map((item) => item.name));
  const ready = servers.filter((item) => item.status === "ready").length,
    count = (role) =>
      ready -
      new Set(
        [...state.draft.all, ...(role === "all" ? [] : state.draft[role])].filter(
          (name) => known.has(name) && servers.find((item) => item.name === name).status === "ready",
        ),
      ).size;
  document.querySelector("#mcp-summary").textContent = `${servers.length} in mcp.json · ${count("all")} on for every profile`;
  const dirty = JSON.stringify(state.draft) !== state.saved;
  if (part === "chrome" && node.querySelector(".skill-groups")) return patchPickerChrome(node, count, dirty);
  if (part === "list" && node.querySelector(".skill-groups")) {
    node.querySelector(".skill-groups").innerHTML = mcpListHtml(state);
    node.querySelector(".pick-note").innerHTML = mcpNote(state);
    return patchPickerChrome(node, count, dirty);
  }
  node.innerHTML = `${profileTabsHtml("mcp-tab", state.tab, count, rolesShown(state))}
    <p class="note pick-note">${mcpNote(state)}</p>
    ${servers.length ? `<div class="pick-tools"><input type="search" id="mcp-search" placeholder="Search ${servers.length} servers" value="${esc(state.query)}" aria-label="Search MCP servers">${bulkButtons("mcp-select")}</div>` : ""}
    <div class="skill-groups">${mcpListHtml(state)}</div>
    ${state.catalog.error ? `<p class="note bad">${esc(state.catalog.error)}</p>` : ""}${state.note ? `<p class="note bad">${esc(state.note)}</p>` : ""}
    <div class="row pick-actions"><button class="primary" data-action="mcp-save" ${dirty ? "" : "disabled data-off"}>Save MCP</button><button class="ghost" data-action="mcp-reset" ${state.isDefault ? "disabled data-off" : ""}>Turn all on</button><small class="pick-state" ${dirty ? "" : "hidden"}>Unsaved changes</small></div>`;
}
/** Bulk enable or clear the usable servers currently shown (respecting search). Inherited rows stay as they are. */
function bulkMcp(mode) {
  const state = mcpPicker,
    list = new Set(state.draft[state.tab]),
    inherited = new Set(state.tab === "all" ? [] : state.draft.all);
  for (const server of mcpShown(state))
    if (server.status === "ready" && !inherited.has(server.name)) {
      if (mode === "all") list.delete(server.name);
      else list.add(server.name);
    }
  state.draft[state.tab] = [...list].sort();
  state.note = "";
  renderMcpPicker("list");
}
async function saveMcpPicker(reset) {
  const state = mcpPicker,
    id = getProjectId();
  if (!state || state.projectId !== id) throw new Error("Reload Settings before saving MCP");
  const settings = await api({ action: "settings-snapshot", id });
  try {
    await mutate(
      {
        action: "settings-update",
        id,
        confirm: id,
        expectedRevision: settings.revision,
        changes: {
          mcp: reset
            ? null
            : {
                off: {
                  all: state.draft.all,
                  coordinator: state.draft.coordinator,
                  worker: state.draft.worker,
                  scout: state.draft.scout,
                  reviewer: state.draft.reviewer,
                },
                writes: state.draft.writes,
              },
        },
      },
      reset ? "MCP servers are on again, writes off." : "MCP saved. Applies to the next tool call.",
    );
  } catch (error) {
    state.note = error.message;
    renderMcpPicker();
    throw error;
  }
  await loadMcpPicker(true);
}
async function testMcpServer(server) {
  const state = mcpPicker;
  state.probes[server] = { ok: false, error: "Testing…" };
  renderMcpPicker("list");
  state.probes[server] = await api({ action: "mcp-probe", id: getProjectId(), server });
  renderMcpPicker("list");
}
document.addEventListener("change", (event) => {
  const box = event.target.closest("[data-mcp-pick], [data-mcp-writes]");
  if (!box || !mcpPicker) return;
  const isPick = box.dataset.mcpPick !== undefined,
    key = isPick ? mcpPicker.tab : "writes",
    name = box.dataset.mcpPick ?? box.dataset.mcpWrites,
    list = new Set(mcpPicker.draft[key]);
  if (box.checked === !isPick) list.add(name);
  else list.delete(name);
  mcpPicker.draft[key] = [...list].sort();
  mcpPicker.note = "";
  renderMcpPicker("chrome");
});
document.addEventListener("input", (event) => {
  if (event.target.id !== "mcp-search" || !mcpPicker) return;
  mcpPicker.query = event.target.value;
  renderMcpPicker("list");
});

// Advanced: per-project system prompt overrides. The textarea shows the effective prompt (the override, else the built-in text); Save stores an override, Reset returns to the built-in text.
const promptTitles = { coordinator: "Coordinator", worker: "Worker", scout: "Scout", reviewer: "Reviewer", verifier: "Verifier" };
let promptsState = null;
// Only the newest snapshot request may render, and none while a save is in flight: a snapshot read before Save or Reset must not bring back the old text.
let promptsSeq = 0,
  promptsSaving = 0;
// Opening Settings refetches (keepEdits): a tab left open across a host restart would otherwise keep showing the built-in text of the previous host. Unsaved edits stay in their editors.
async function loadPrompts(force = false, keepEdits = false) {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#prompts");
  if (!id || !jobsSnap || (!force && promptsState?.projectId === id)) return;
  const seq = ++promptsSeq,
    fresh = () => id === getProjectId() && current === getGeneration() && seq === promptsSeq && !promptsSaving;
  try {
    const data = await api({ action: "prompts-snapshot", id });
    if (!fresh()) return;
    const edits =
      keepEdits && promptsState?.projectId === id
        ? promptsState.roles.flatMap((item) => {
            const text = document.querySelector(`[data-prompt="${item.role}"]`)?.value;
            return text === undefined || text === item.effective ? [] : [[item.role, text]];
          })
        : [];
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
  if (!promptsState || promptsState.projectId !== getProjectId()) return;
  node.innerHTML = promptsState.roles
    .map(
      (
        item,
      ) => `<fieldset class="events-group prompt-role" data-role="${item.role}"><legend>${promptTitles[item.role]} ${item.override ? '<span class="skill-tag prompt-custom">Customized</span>' : '<small class="note">Default</small>'}</legend>
    <label class="field"><span class="sr-only">${promptTitles[item.role]} system prompt</span><textarea class="mono prompt-text" rows="8" maxlength="24000" data-prompt="${item.role}" aria-label="${promptTitles[item.role]} system prompt">${esc(item.effective)}</textarea></label>
    <div class="row pick-actions"><button class="primary" data-action="prompt-save" data-role="${item.role}">Save</button><button class="ghost" data-action="prompt-reset" data-role="${item.role}" ${item.override ? "" : "disabled data-off"}>Reset to default</button></div></fieldset>`,
    )
    .join("");
}
async function savePrompt(role, reset) {
  const id = getProjectId(),
    item = promptsState?.roles.find((entry) => entry.role === role);
  if (!item || promptsState.projectId !== id) throw new Error("Reload Settings before saving prompts");
  const text = document.querySelector(`[data-prompt="${role}"]`).value;
  promptsSaving++;
  promptsSeq++;
  try {
    const settings = await api({ action: "settings-snapshot", id });
    await mutate(
      {
        action: "settings-update",
        id,
        confirm: id,
        expectedRevision: settings.revision,
        changes: { prompts: { [role]: reset || !text.trim() || text === item.default ? null : text } },
      },
      reset
        ? `${promptTitles[role]} prompt reset to default.`
        : `${promptTitles[role]} prompt saved. New turns and new worker threads use it.`,
    );
  } catch (error) {
    if (id === getProjectId()) showPromptsError(error.message);
    throw error;
  } finally {
    promptsSaving--;
  }
  await loadPrompts(true);
}
// Worktrees: the per-project setup command (run once in each new coding worktree) and safe cleanup with reclaimable size.
let worktrees = null;
const sizeText = (kb) =>
  kb < 0 ? "size unknown" : kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
async function loadWorktrees(force = false) {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#worktrees");
  if (!id || !jobsSnap || (!force && worktrees?.projectId === id && worktrees.data)) return;
  worktrees = { projectId: id, data: null, setup: "", revision: "" };
  try {
    const [data, settings] = await Promise.all([api({ action: "worktrees-snapshot", id }), api({ action: "settings-snapshot", id })]);
    if (id !== getProjectId() || current !== getGeneration()) return;
    Object.assign(worktrees, { data, setup: settings.values.worktreeSetup ?? "", revision: settings.revision });
    renderWorktrees();
  } catch (error) {
    if (id === getProjectId() && current === getGeneration())
      node.innerHTML = `<p class="note">Worktrees unavailable: ${esc(error.message)}</p>`;
  }
}
function renderWorktrees() {
  const data = worktrees?.data,
    node = document.querySelector("#worktrees");
  if (!data) return;
  const removable = data.items.filter((item) => item.removable);
  document.querySelector("#worktrees-summary").textContent =
    `${data.items.length} · ${sizeText(data.totalKb)} · ${sizeText(data.reclaimableKb)} reclaimable`;
  const setup = (item) =>
    !item.setup
      ? ""
      : item.setup.ok
        ? `<span class="wt-setup ok">setup ok</span>`
        : `<details class="wt-setup bad"><summary>setup failed (exit ${esc(item.setup.exitCode)})</summary><pre>${esc(item.setup.output)}</pre></details>`;
  const row = (item) =>
    `<li class="wt-row${item.removable ? " removable" : ""}"><b class="mono">${esc(item.path.split("/").at(-1))}</b> <span class="note">${esc(item.kind === "read-head" ? "PR-head snapshot" : (item.branch ?? ""))}</span> <span>${esc(item.provider && item.sizeKb < 0 ? (item.mountLabel ?? "virtual mount") : sizeText(item.sizeKb))}</span> ${item.pullRequests.map((pr) => `<span class="wt-pr ${esc(pr.state)}">#${esc(pr.number)} ${esc(pr.state)}</span>`).join(" ")} ${setup(item)} <span class="${item.removable ? "good" : "note"}">${item.removable ? "can be removed" : esc(item.reasons.join("; "))}</span></li>`;
  node.innerHTML = `<label class="field">Setup command <input id="worktree-setup" class="mono" maxlength="4000" placeholder="e.g. bun run worktree:setup" value="${esc(worktrees.setup)}"></label>
    <p class="note">Runs once with sh in each new coding worktree before the worker starts (15 min limit). The worker is told whether it failed.</p>
    <div class="row"><button data-action="worktree-setup-save">Save setup command</button></div>
    ${data.items.length ? `<ul id="worktree-list" class="fix-list">${data.items.map(row).join("")}</ul>` : '<p class="note">No worktrees.</p>'}
    <div class="row"><button class="primary" data-action="worktrees-cleanup" ${removable.length ? "" : "disabled"}>Clean up worktrees (${esc(sizeText(data.reclaimableKb))})</button><button class="ghost small" data-action="worktrees-refresh">Refresh</button></div>`;
}
async function saveWorktreeSetup() {
  const id = getProjectId(),
    value = document.querySelector("#worktree-setup").value.trim();
  const settings = await api({ action: "settings-snapshot", id });
  await mutate(
    { action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { worktreeSetup: value } },
    value ? "Setup command saved. New worktrees run it." : "Setup command removed.",
  );
  await loadWorktrees(true);
}
async function cleanupWorktreesNow() {
  const id = getProjectId(),
    result = await mutate({ action: "worktrees-cleanup", id, confirm: id }, "Cleaning up worktrees…");
  toast(
    `Removed ${result.removed.length} worktree(s), reclaimed ${sizeText(result.reclaimedKb)}${result.failed.length ? `; ${result.failed.length} could not be removed` : ""}.`,
  );
  await loadWorktrees(true);
}

// Context and compaction (Settings): window override, auto-compact, threshold, keep-recent; applied live. "Compact now" also sits in the context ring.
let contextCard = null;
async function loadContextSettings(force = false) {
  const id = getProjectId(),
    current = getGeneration(),
    node = document.querySelector("#context-settings");
  if (!id || !jobsSnap || (!force && contextCard?.projectId === id)) return;
  try {
    const settings = await api({ action: "settings-snapshot", id });
    if (id !== getProjectId() || current !== getGeneration()) return;
    contextCard = { projectId: id, values: settings.values.context, revision: settings.revision };
    renderContextSettings();
  } catch (error) {
    if (id === getProjectId() && current === getGeneration())
      node.innerHTML = `<p class="note">Context settings unavailable: ${esc(error.message)}</p>`;
  }
}
function renderContextSettings() {
  const state = contextCard,
    node = document.querySelector("#context-settings");
  if (!state || state.projectId !== getProjectId()) return;
  const v = state.values,
    catalog = getView()?.context?.catalogWindow ?? null,
    window = v?.contextWindow ?? catalog;
  const defaultPct = catalog ? Math.round(((catalog - 16384 - 32768) / catalog) * 100) : null;
  document.querySelector("#context-summary").textContent =
    `${window ? `${window.toLocaleString()} tokens` : "window unknown"} · ${v && !v.autoCompact ? "auto-compact off" : `compacts at ${v?.thresholdPercent ?? defaultPct ?? "?"}%`}`;
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
  const slider = document.querySelector("#context-threshold"),
    output = document.querySelector("#context-threshold-value");
  if (!slider || !output) return;
  const typed = Number(document.querySelector("#context-window").value.trim()),
    window = typed > 0 ? typed : (getView()?.context?.catalogWindow ?? null);
  slider.disabled = !document.querySelector("#context-auto").checked;
  output.textContent = `${slider.value}%${window ? ` · ${Math.floor((window * slider.value) / 100).toLocaleString()} tokens` : ""}${slider.hasAttribute("data-default") ? " (default)" : ""}`;
}
document.addEventListener("input", (event) => {
  if (event.target.id === "context-threshold") event.target.removeAttribute("data-default");
  if (["context-threshold", "context-window", "context-auto"].includes(event.target.id)) renderContextThreshold();
});
async function saveContextSettings(reset) {
  const id = getProjectId(),
    number = (selector) => {
      const raw = document.querySelector(selector).value.trim();
      if (!raw) return undefined;
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error("Context settings must be whole numbers");
      return value;
    };
  const slider = document.querySelector("#context-threshold"),
    threshold = slider.hasAttribute("data-default") ? undefined : Number(slider.value);
  const context = reset
    ? null
    : {
        autoCompact: document.querySelector("#context-auto").checked,
        ...Object.fromEntries(
          [
            ["contextWindow", number("#context-window")],
            ["thresholdPercent", threshold],
            ["keepRecentTokens", number("#context-keep")],
          ].filter(([, value]) => value !== undefined),
        ),
      };
  const settings = await api({ action: "settings-snapshot", id });
  await mutate(
    { action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { context } },
    reset ? "Context settings reset to defaults." : "Context settings saved; they apply from the next step.",
  );
  await loadContextSettings(true);
}
export async function compactNow() {
  await mutate({ action: "compact", id: getProjectId(), ...(chatId && chatId !== "main" ? { chatId } : {}) }, "Compacting this chat…");
}
registerActions({
  async "settings-list"() {
    await settingsList();
  },
  async "settings-back"() {
    await settingsList(true);
  },
  "mp-toggle"(node) {
    const mp = node.closest(".mp");
    if (mp.classList.contains("open")) mpClose(mp, true);
    else mpOpen(mp);
  },
  "mp-pick"(node) {
    mpPick(node.closest(".mp"), node.dataset.ref);
  },
  async "model-cycle"() {
    await cycleModel(1);
  },
  "scope-clear"() {
    for (const box of dialog.querySelectorAll("[data-scope-ref]")) box.checked = false;
    settingsSync();
  },
  "settings-discard"(node) {
    settingsDiscard(node.dataset.project, node.dataset.field);
  },
  async "settings-confirm-discard"(node) {
    requireProject(node.dataset.project);
    if (!["name", "objective"].includes(node.dataset.field)) throw new Error("Unknown settings draft field");
    settingsDrafts.delete(`${getProjectId()}:${node.dataset.field}`);
    if (settingsPending?.projectId === getProjectId()) delete settingsPending.flat[node.dataset.field];
    persistBrowserDrafts();
    await settingsList(true);
  },
});
registerActions({
  async "worktree-setup-save"() {
    await saveWorktreeSetup();
  },
  async "worktrees-cleanup"() {
    await cleanupWorktreesNow();
  },
  async "worktrees-refresh"() {
    await loadWorktrees(true);
  },
  async "context-save"() {
    await saveContextSettings(false);
  },
  async "context-reset"() {
    await saveContextSettings(true);
  },
  async "compact-now"() {
    await compactNow();
  },
  async "prompt-save"(node) {
    await savePrompt(node.dataset.role, false);
  },
  async "prompt-reset"(node) {
    await savePrompt(node.dataset.role, true);
  },
  "skills-tab"(node) {
    skillsPicker.tab = node.dataset.role;
    renderSkillsPicker();
  },
  "skills-select"(node) {
    bulkSkills(node.dataset.source, node.dataset.mode);
  },
  "mcp-select"(node) {
    bulkMcp(node.dataset.mode);
  },
  async "skills-save"() {
    await saveSkillsPicker(false);
  },
  async "skills-reset"() {
    await saveSkillsPicker(true);
  },
  "mcp-tab"(node) {
    mcpPicker.tab = node.dataset.role;
    renderMcpPicker();
  },
  async "mcp-save"() {
    await saveMcpPicker(false);
  },
  async "mcp-reset"() {
    await saveMcpPicker(true);
  },
  async "mcp-test"(node) {
    await testMcpServer(node.dataset.server);
  },
  "profile-roles"(node) {
    const skills = node.dataset.picker === "skills";
    (skills ? skillsPicker : mcpPicker).roles = true;
    (skills ? renderSkillsPicker : renderMcpPicker)();
  },
});
registerForms([
  [
    "[data-settings-form]",
    (form) => {
      requireProject(form.dataset.project);
      captureSettingsDraft();
      persistBrowserDrafts();
      if (!settingsCache || settingsCache.projectId !== getProjectId()) throw new Error("Reopen the project settings first");
      const changes = settingsChanges(settingsFormValues(form), settingsCache.values);
      if (!Object.keys(changes).length) throw new Error("There are no changes to review yet.");
      validateSettingsChanges(changes);
      settingsReview(settingsRevisionFor(changes), changes);
    },
  ],
  [
    "[data-settings-confirm]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const proposal = settingsConfirmation;
      if (!proposal || proposal.projectId !== target || proposal.revision !== form.dataset.revision || data.get("confirm") !== target)
        throw new Error("Reopen the exact settings proposal and confirm its project ID");
      persistBrowserDrafts();
      const result = await mutate(
        { action: "settings-update", id: target, confirm: target, expectedRevision: proposal.revision, changes: proposal.changes },
        "Settings saved. New threads use them; running threads keep what they started with.",
      );
      validateSettings(result);
      for (const [field, changed] of Object.entries(proposal.changes)) {
        if (
          field === "verification"
            ? JSON.stringify(result.values.verification) !== JSON.stringify(changed)
            : field === "models" || field === "fallbackModels"
              ? Object.entries(changed).some(([role, reference]) => (result.values[field][role] ?? null) !== reference)
              : field === "scopedModels"
                ? JSON.stringify(result.values.scopedModels) !== JSON.stringify(changed)
                : result.values[field] !== changed
        )
          throw new Error("Settings receipt differs from the proposed change; retain drafts and inspect");
      }
      for (const key of proposal.draftKeys) {
        const draft = settingsDrafts.get(key),
          field = key.slice(key.indexOf(":") + 1);
        if (draft?.expectedRevision === proposal.revision && draft.text === proposal.changes[field]) settingsDrafts.delete(key);
      }
      persistBrowserDrafts();
      settingsPending = null;
      if (target === getProjectId()) {
        settingsCache = { ...result, projectId: target };
        setProjects(projects.map((project) => (project.id === target ? { ...project, name: result.values.name } : project)));
        renderProjects();
        closeCurrentDialog(target, version);
      }
    },
  ],
]);
document.addEventListener("change", (event) => {
  if (event.target.closest("[data-settings-form]")) settingsSync();
});
document.addEventListener("input", (event) => {
  const filter = event.target.closest?.("[data-scope-filter]");
  if (!filter) return;
  const terms = modelNorm(filter.value).split(/\s+/).filter(Boolean);
  for (const row of filter.closest(".scope-editor").querySelectorAll(".scope-row"))
    row.hidden = !terms.every((term) => modelNorm(row.textContent).includes(term));
});
document.addEventListener("input", (event) => {
  if (event.target.matches(".mp-search")) {
    renderModelList(event.target.closest(".mp"));
    return;
  }
  if (!event.target.closest("[data-settings-form]")) return;
  captureSettingsDraft();
  persistDraftsSafely();
  settingsSync();
});
// Esc inside an open model list closes only the list.
dialog.addEventListener("cancel", (event) => {
  const open = dialog.querySelector(".mp.open");
  if (open) {
    event.preventDefault();
    mpClose(open, true);
  }
});
dialog.addEventListener("mousedown", (event) => {
  if (event.target.closest(".mp-row")) event.preventDefault();
});
document.addEventListener("click", (event) => {
  for (const mp of dialog.querySelectorAll(".mp.open")) if (!mp.contains(event.target)) mpClose(mp);
});
// Key handling is split by feature; each handler matches its own keys and targets, and submit-on-Enter stands down for handled events.
document.addEventListener("keydown", (event) => {
  const picker = event.target.closest?.(".mp");
  if (picker && !event.isComposing && mpKey(event, picker)) return;
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key?.toLowerCase() === "p" &&
    !event.isComposing &&
    !dialog.open &&
    getProjectId() &&
    getView()
  ) {
    event.preventDefault();
    if (!isBusy()) void uiAction(() => cycleModel(event.shiftKey ? -1 : 1));
  }
});
function validateSettings(value) {
  const v = value?.values;
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    !v ||
    [v.name, v.objective, v.model].some((text) => typeof text !== "string") ||
    [
      v.models?.worker,
      v.models?.scout,
      v.models?.reviewer,
      v.models?.verifier,
      v.fallbackModels?.worker,
      v.fallbackModels?.scout,
      v.fallbackModels?.reviewer,
    ].some((text) => text !== undefined && typeof text !== "string") ||
    (v.scopedModels !== null && !Array.isArray(v.scopedModels)) ||
    !["read-only", "maintain"].includes(v.knowledgeAccess) ||
    !["none", "coordinator"].includes(v.libraryAccess) ||
    !["none", "coordinator"].includes(v.decisionAccess) ||
    (v.verification !== null && (typeof v.verification?.enabled !== "boolean" || typeof v.verification.skill !== "string")) ||
    !Number.isSafeInteger(v.stallMinutes) ||
    (value.verificationProblem !== null && typeof value.verificationProblem !== "string")
  )
    throw new Error("Invalid settings snapshot/receipt");
}
function captureSettingsDraft() {
  const form = dialog.querySelector("[data-settings-form]");
  if (!form || !settingsCache || form.dataset.project !== settingsCache.projectId) return;
  const flat = settingsFormValues(form),
    was = flatSettings(settingsCache.values);
  settingsPending = {
    projectId: form.dataset.project,
    flat: Object.fromEntries(Object.entries(flat).filter(([field, value]) => value !== was[field])),
  };
  for (const field of ["name", "objective"]) {
    const key = `${form.dataset.project}:${field}`,
      draft = settingsDrafts.get(key);
    if (flat[field] === settingsCache.values[field]) settingsDrafts.delete(key);
    else if (draft) draft.text = flat[field];
    else settingsDrafts.set(key, { text: flat[field], expectedRevision: settingsCache.revision });
  }
}

const DEFAULT_VERIFY_ROUNDS = 3;
// Project settings: one form (name, objective, models, stall time, verification, access), then one confirmation that shows every before → after.
const settingsRoles = [
  ["coordinator", "Coordinator", "Plans the work and talks to you."],
  ["worker", "Worker", "Writes code in its own worktree."],
  ["scout", "Scout", "Reads the repository and reports back."],
  ["reviewer", "Reviewer", "Checks changes and pull requests."],
  ["verifier", "Verifier", "Runs the verification skill against finished work. Needed when verification is on."],
];
const settingsAccess = {
  knowledgeAccess: [
    "Workers and project knowledge",
    "The coordinator always keeps the knowledge notes up to date.",
    [
      ["read-only", "Workers can read it"],
      ["maintain", "Workers can read and update it"],
    ],
  ],
  libraryAccess: [
    "Uploaded files and evidence",
    "Whether the coordinator may open the project library.",
    [
      ["none", "Coordinator cannot open them"],
      ["coordinator", "Coordinator can open them"],
    ],
  ],
  decisionAccess: [
    "Questions for you",
    "Whether the coordinator may ask you to decide something.",
    [
      ["none", "Coordinator cannot ask"],
      ["coordinator", "Coordinator can ask"],
    ],
  ],
  githubCli: [
    "Coordinator GitHub CLI (gh): full access",
    "Lets the coordinator run any gh command as you (merge, close, delete, settings). Off removes the tool.",
    [
      ["full", "Full access (merge, close, delete, settings)"],
      ["none", "Off"],
    ],
  ],
};
let settingsPending = null,
  modelScoped = [],
  modelUnavailableScoped = [],
  modelScopeSet = false,
  modelExtensionErrors = [];
const scopeKey = (refs) => [...refs].sort().join("\n");
const flatSettings = (values) => ({
  name: values.name,
  objective: values.objective,
  coordinator: values.model,
  worker: values.models.worker ?? "",
  scout: values.models.scout ?? "",
  reviewer: values.models.reviewer ?? "",
  verifier: values.models.verifier ?? "",
  verifyEnabled: values.verification?.enabled ? "on" : "off",
  verifySkill: values.verification?.skill ?? "",
  workerFallback: values.fallbackModels?.worker ?? "",
  scoutFallback: values.fallbackModels?.scout ?? "",
  reviewerFallback: values.fallbackModels?.reviewer ?? "",
  scoped: scopeKey(values.scopedModels ?? []),
  knowledgeAccess: values.knowledgeAccess,
  libraryAccess: values.libraryAccess,
  decisionAccess: values.decisionAccess,
  githubCli: values.githubCli ?? "full",
  stallMinutes: String(values.stallMinutes),
  verifyRounds: String(values.verification?.rounds ?? DEFAULT_VERIFY_ROUNDS),
});
function settingsFormValues(form) {
  const flat = {
    name: form.elements.name.value,
    objective: form.elements.objective.value,
    stallMinutes: form.elements.stallMinutes.value,
    verifyRounds: form.elements.verifyRounds.value,
    verifyEnabled: form.elements.verifyEnabled.checked ? "on" : "off",
    verifySkill: form.elements.verifySkill.value.trim(),
  };
  for (const field of Object.keys(settingsAccess)) flat[field] = form.elements[field].value;
  for (const [role] of settingsRoles) {
    flat[role] = form.querySelector(`.mp[data-role="${role}"]`).dataset.value;
    if (role !== "coordinator" && role !== "verifier")
      flat[`${role}Fallback`] = form.querySelector(`.mp[data-role="${role}-fallback"]`).dataset.value;
  }
  flat.scoped = scopeKey([...form.querySelectorAll("[data-scope-ref]:checked")].map((box) => box.dataset.scopeRef));
  return flat;
}
function settingsChanges(flat, values) {
  const was = flatSettings(values),
    changes = {};
  for (const field of ["name", "objective", "knowledgeAccess", "libraryAccess", "decisionAccess", "githubCli"])
    if (flat[field] !== was[field]) changes[field] = flat[field];
  if (flat.stallMinutes !== was.stallMinutes) changes.stallMinutes = Number(flat.stallMinutes);
  if (flat.coordinator !== was.coordinator) changes.model = flat.coordinator;
  for (const role of ["worker", "scout", "reviewer"]) {
    if (flat[role] !== was[role]) (changes.models ??= {})[role] = flat[role] === "" ? null : flat[role];
    if (flat[`${role}Fallback`] !== was[`${role}Fallback`])
      (changes.fallbackModels ??= {})[role] = flat[`${role}Fallback`] === "" ? null : flat[`${role}Fallback`];
  }
  if (flat.verifier !== was.verifier) (changes.models ??= {}).verifier = flat.verifier === "" ? null : flat.verifier;
  if (
    flat.verifyEnabled !== was.verifyEnabled ||
    (flat.verifyEnabled === "on" && (flat.verifySkill !== was.verifySkill || flat.verifyRounds !== was.verifyRounds))
  )
    changes.verification =
      flat.verifyEnabled === "on" ? { enabled: true, skill: flat.verifySkill, rounds: Number(flat.verifyRounds) } : null;
  if (flat.scoped !== was.scoped) changes.scopedModels = flat.scoped === "" ? null : flat.scoped.split("\n");
  return changes;
}
function validateSettingsChanges(changes) {
  if (
    ("name" in changes && (!changes.name.trim() || !editableKnowledge(changes.name))) ||
    ("objective" in changes && !editableKnowledge(changes.objective))
  )
    throw new Error("The name cannot be empty, and name and objective cannot contain control characters. Your edits are kept.");
  if (changes.verification?.enabled && !changes.verification.skill)
    throw new Error("Name the verification skill to run, or turn verification off. Your edits are kept.");
  if ("stallMinutes" in changes && (!Number.isSafeInteger(changes.stallMinutes) || changes.stallMinutes < 1 || changes.stallMinutes > 240))
    throw new Error("Minutes before a stall notice must be a whole number from 1 to 240. Your edits are kept.");
  if (
    changes.verification?.enabled &&
    (!Number.isSafeInteger(changes.verification.rounds) || changes.verification.rounds < 1 || changes.verification.rounds > 10)
  )
    throw new Error("Verifier rounds must be a whole number from 1 to 10. Your edits are kept.");
}
// The request must use the revision each retained text edit started from, so a stale edit is rejected by the host instead of being rebased.
function settingsRevisionFor(changes) {
  const revisions = new Set();
  for (const field of ["name", "objective"]) {
    const draft = field in changes && settingsDrafts.get(`${getProjectId()}:${field}`);
    if (draft) revisions.add(draft.expectedRevision);
  }
  if (revisions.size > 1)
    throw new Error(
      "The name and objective edits started on different versions of the settings. Discard one of them or save them separately.",
    );
  return [...revisions][0] ?? settingsCache.revision;
}
function settingsSync() {
  const form = dialog.querySelector("[data-settings-form]");
  if (!form || !settingsCache) return;
  const flat = settingsFormValues(form),
    was = flatSettings(settingsCache.values);
  let count = 0;
  for (const field of form.querySelectorAll(".field[data-field]")) {
    const changed = flat[field.dataset.field] !== was[field.dataset.field];
    field.classList.toggle("changed", changed);
    if (changed) count++;
  }
  const submit = form.querySelector('[type="submit"]'),
    hint = form.querySelector(".hint");
  submit.toggleAttribute("data-off", !count);
  submit.disabled = isBusy() || !count;
  hint.textContent = count ? `${count} unsaved ${count === 1 ? "change" : "changes"}` : "No changes yet";
  hint.classList.toggle("dirty", count > 0);
}
export async function settingsList(keep = false) {
  if (!jobsSnap) throw new Error("Settings require a loaded Durable project");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog("Project settings", '<p class="note">Loading settings…</p>', "Name, objective, models and what workers may use.");
  if (!keep) settingsPending = null;
  const [value, pickerError] = await Promise.all([
    api({ action: "settings-snapshot", id }),
    loadModelPicker().then(
      () => "",
      (error) => error.message,
    ),
  ]);
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  validateSettings(value);
  settingsCache = { ...value, projectId: id };
  const draftOf = (field) => settingsDrafts.get(`${id}:${field}`),
    pending = settingsPending?.projectId === id ? settingsPending.flat : {};
  const shown = {
    ...flatSettings(value.values),
    ...Object.fromEntries(["name", "objective"].filter((field) => draftOf(field)).map((field) => [field, draftOf(field).text])),
    ...pending,
  };
  const draftNote = (field) => {
    const draft = draftOf(field);
    return draft && draft.text !== value.values[field]
      ? `<span class="field-draft">Unsent edit kept${draft.expectedRevision !== value.revision ? " from an older version of these settings. Saving it is checked and may be rejected" : ""}. ${dlgBtn("Discard edit…", { action: "settings-discard", project: id, field }, "ghost small")}</span>`
      : "";
  };
  const roleField = ([role, label, help]) =>
    `<div class="field" data-field="${role}"><span class="flabel">${label} model</span><span class="fhelp">${help}${role === "coordinator" ? "" : role === "verifier" ? " No default: pick one to turn verification on." : " Follows the coordinator unless you pick a model."}</span>${modelPickerHtml(role, shown[role], pickerError)}</div>`;
  const fallbackField = ([role, label]) =>
    `<div class="field" data-field="${role}Fallback"><span class="flabel">${label} quota fallback</span><span class="fhelp">Only this model is used after quota exhaustion. Leave empty to wait for quota reset. Other frozen permissions stay unchanged.</span>${modelPickerHtml(`${role}-fallback`, shown[`${role}Fallback`], pickerError, "Wait for quota reset")}</div>`;
  const chosenScope = shown.scoped ? shown.scoped.split("\n") : [],
    scopeRows = [...modelCache.values()].filter((model) => model.configured || chosenScope.includes(model.reference));
  const scopeField = `<div class="field" data-field="scoped"><span class="flabel">Scoped models</span><span class="fhelp">The models the model button and Ctrl+P cycle through, in list order. Leave all unchecked to use your Pi scope.</span><details class="scope-editor"${chosenScope.length ? " open" : ""}><summary>${chosenScope.length ? `${chosenScope.length} chosen for this project` : "Your Pi scope"}</summary><input type="search" class="scope-filter" data-scope-filter placeholder="Filter ${scopeRows.length} models…" aria-label="Filter scoped models" autocomplete="off"><div class="scope-list">${scopeRows.map((model) => `<label class="scope-row"><input type="checkbox" data-scope-ref="${esc(model.reference)}"${chosenScope.includes(model.reference) ? " checked" : ""}${model.configured ? "" : " disabled"}><span>${esc(model.name)}</span><small class="mono">${esc(model.reference)}</small></label>`).join("") || '<p class="note">No models are available.</p>'}</div>${dlgBtn("Use my Pi scope", { action: "scope-clear" }, "ghost small")}</details></div>`;
  const accessField = ([field, [label, help, options]]) =>
    `<div class="field" data-field="${field}"><label><span class="flabel">${label}</span><select name="${field}">${options.map(([option, text]) => `<option value="${option}"${shown[field] === option ? " selected" : ""}>${text}</option>`).join("")}</select></label><span class="fhelp">${help}</span></div>`;
  setDialogBody(`<form data-settings-form data-project="${esc(id)}" novalidate>
<div class="field" data-field="name"><label><span class="flabel">Project name</span><input name="name" maxlength="120" autocomplete="off" value="${esc(shown.name)}"></label>${draftNote("name")}</div>
<div class="field" data-field="objective"><label><span class="flabel">Objective</span><span class="fhelp">What this project is for. The coordinator reads it in every new conversation.</span><textarea name="objective" rows="5" maxlength="32000">${esc(shown.objective)}</textarea></label>${draftNote("objective")}</div>
<h3>Models</h3><p class="note">New threads use these. Threads that are already running keep the model they started with. The coordinator can be switched from the model button in the chat.${pickerError ? ` The model list is unavailable (${esc(pickerError)}).` : " Scoped models come from your Pi settings; search finds every configured model."}</p>
<div class="field-grid">${settingsRoles.map(roleField).join("")}</div>${scopeField}
<h3>Quota recovery</h3><p class="note">New threads freeze these fallback choices. After a recognized quota error, work continues on the same thread with its fallback. Without one, it waits for a known reset or retries with bounded exponential backoff. Paused or stopped workers never restart automatically.</p><div class="field-grid">${settingsRoles
    .filter(([role]) => role !== "coordinator" && role !== "verifier")
    .map(fallbackField)
    .join("")}</div>
<h3>Stalls</h3>
<div class="field-grid"><div class="field" data-field="stallMinutes"><label><span class="flabel">Minutes before a stall notice</span><input name="stallMinutes" type="number" min="1" max="240" step="1" value="${esc(shown.stallMinutes)}"></label><span class="fhelp">A running Job with no progress for this long raises one notice in its chat (1–240, default 20). Nothing is stopped or steered automatically.</span></div></div>
<h3>Verification</h3>${value.verificationProblem ? `<p class="note-box warn" data-verify-problem>Verification is on, but no worker of this project can pass it. ${esc(value.verificationProblem)}. Turn it off, or every finished worker ends as not verified.</p>` : ""}
<div class="field-grid"><div class="field" data-field="verifyEnabled"><label><span class="flabel">Verify finished workers</span><span class="fhelp">Off by default. When on, a fresh verifier (the Verifier model above, never a fallback) runs the skill against the worker's exact result, uncommitted files included. A failure goes back to the worker, which repairs and asks again, up to the rounds below; then the Job is Ready with gaps.</span><span class="fhelp" data-verify-trust><b>The verifier is trusted like the worker, not sandboxed.</b> It runs shell commands in the worker's worktree as you, with the worker's shell policy and the host's resource leases. It can do what a worker's shell can do. Checking the revision and the files it changed keeps the evidence honest; it is not a security boundary. Only workers in a git workspace scope are verified; any other worker ends as not verified.</span><input name="verifyEnabled" type="checkbox"${shown.verifyEnabled === "on" ? " checked" : ""}></label></div><div class="field" data-field="verifySkill"><label><span class="flabel">Verification skill</span><span class="fhelp">Name of an installed project skill, for example verify-pi-prjcts.</span><input name="verifySkill" maxlength="128" autocomplete="off" value="${esc(shown.verifySkill)}"></label></div><div class="field" data-field="verifyRounds"><label><span class="flabel">Verifier rounds</span><span class="fhelp">How many times the worker may repair and re-verify (1–10, default 3).</span><input name="verifyRounds" type="number" min="1" max="10" step="1" value="${esc(shown.verifyRounds)}"></label></div></div>
<details class="advanced"><summary>Access to project functions</summary><div class="field-grid">${Object.entries(settingsAccess).map(accessField).join("")}</div></details>
<p class="note">Model changes apply to the next request without interrupting current work. New threads use the current role selections. The stall time applies at once. Other changes need an idle project. You review every change before it is saved.</p>
${dlgActions('<span class="hint" role="status"></span>', dlgBtn("Cancel", { action: "close-dialog" }), '<button type="submit" class="primary" data-off disabled>Review changes</button>')}</form>`);
  settingsSync();
}
const accessText = (field, value) => settingsAccess[field][2].find(([option]) => option === value)?.[1] ?? value;
const scopeText = (refs) =>
  refs?.length ? refs.map((ref) => esc(modelCache.get(ref)?.name ?? ref)).join(", ") : "<small>Your Pi scope</small>";
const modelText = (ref, role = "") => {
  if (ref === "") return emptyModelName(role);
  const model = modelCache.get(ref);
  return model ? `${esc(model.name)}<small class="mono">${esc(ref)}</small>` : esc(ref);
};
const verifyText = (value) =>
  value?.enabled
    ? `On: skill <b>${esc(value.skill)}</b>, up to ${value.rounds ?? DEFAULT_VERIFY_ROUNDS} rounds, verifier model above`
    : "Off";
const emptyText = (text) => (text ? esc(text) : "<small>empty</small>");
function settingsDiffRows(changes, values) {
  const rows = [];
  if ("name" in changes) rows.push(["Project name", emptyText(values.name), emptyText(changes.name)]);
  if ("objective" in changes) rows.push(["Objective", emptyText(values.objective), emptyText(changes.objective)]);
  if ("model" in changes) rows.push(["Coordinator model", modelText(values.model), modelText(changes.model)]);
  for (const [role, label] of settingsRoles.slice(1)) {
    if (changes.models && role in changes.models)
      rows.push([`${label} model`, modelText(values.models[role] ?? "", role), modelText(changes.models[role] ?? "", role)]);
    if (changes.fallbackModels && role in changes.fallbackModels)
      rows.push([`${label} quota fallback`, modelText(values.fallbackModels?.[role] ?? ""), modelText(changes.fallbackModels[role] ?? "")]);
  }
  if ("scopedModels" in changes) rows.push(["Scoped models", scopeText(values.scopedModels), scopeText(changes.scopedModels)]);
  for (const field of Object.keys(settingsAccess))
    if (field in changes)
      rows.push([settingsAccess[field][0], esc(accessText(field, values[field])), esc(accessText(field, changes[field]))]);
  if ("verification" in changes) rows.push(["Verification", verifyText(values.verification), verifyText(changes.verification)]);
  if ("stallMinutes" in changes) rows.push(["Minutes before a stall notice", String(values.stallMinutes), String(changes.stallMinutes)]);
  return rows;
}
export const diffItem = ([label, before, after]) =>
  `<div class="diff-item"><b>${esc(label)}</b><div class="diff-pair"><div class="diff-side before"><small>Now</small>${before}</div><span class="arrow" aria-hidden="true">→</span><div class="diff-side after"><small>After saving</small>${after}</div></div></div>`;
function settingsDiscard(id, field) {
  requireProject(id);
  if (!["name", "objective"].includes(field) || !settingsCache || settingsCache.projectId !== id)
    throw new Error("Reopen the project settings before discarding an edit");
  const draft = settingsDrafts.get(`${id}:${field}`);
  if (!draft) throw new Error("There is no unsent edit to discard");
  showDialog(
    "Discard your unsent edit?",
    `<div class="diff-item"><b>Your edit of the ${field}</b><div class="diff-side before">${emptyText(draft.text)}</div></div><p class="note">The saved ${field} stays as it is. Nothing is sent to the server.</p>${dlgActions(dlgBtn("Keep editing", { action: "settings-back" }), dlgBtn("Discard edit", { action: "settings-confirm-discard", project: id, field }, "danger"))}`,
    "This only deletes the text you typed.",
  );
}
function settingsReview(revision, changes) {
  if (!settingsCache || settingsCache.projectId !== getProjectId() || !/^[a-f0-9]{64}$/.test(revision))
    throw new Error("Reopen the project settings");
  const stale = revision !== settingsCache.revision,
    rows = settingsDiffRows(changes, settingsCache.values);
  const proposal = {
    projectId: getProjectId(),
    revision,
    changes,
    draftKeys: ["name", "objective"].filter((field) => field in changes).map((field) => `${getProjectId()}:${field}`),
  };
  showDialog(
    "Save these changes?",
    `<div class="diff-list">${rows.map(diffItem).join("")}</div>${stale ? '<p class="note-box warn">One edit was started on an older version of these settings. If they changed since, the host rejects the save and your edit is kept.</p>' : ""}<p class="note">Role models apply to new threads. New threads freeze their quota fallback choice. Quota fallback is the only automatic model change and keeps the thread, tools and instructions. The project must be idle for non-model changes. No model request, command, publication or merge happens here.</p><form data-settings-confirm data-project="${esc(getProjectId())}" data-revision="${esc(revision)}"><input type="hidden" name="confirm" value="${esc(getProjectId())}">${dlgActions(dlgBtn("Back to editing", { action: "settings-back" }), '<button type="submit" class="primary">Save changes</button>')}</form>`,
    `Project ${getView().project.name}. Nothing is saved until you confirm.`,
  );
  settingsConfirmation = proposal;
  disableActions();
}

// Model picker: the current model, then an in-flow list with Pi's scoped models first and a search over every configured model.
const modelNorm = (text) => text.toLowerCase().replace(/[-_/.:@]+/g, " ");
async function loadModelPicker() {
  const data = await api({ action: "model-picker-snapshot", ...(getProjectId() ? { id: getProjectId() } : {}) });
  if (!data || data.networkChecked !== false || !Array.isArray(data.items) || !Array.isArray(data.scoped))
    throw new Error("Invalid model list");
  modelCache.clear();
  for (const model of data.items) {
    if (typeof model?.reference !== "string" || typeof model.name !== "string" || typeof model.configured !== "boolean")
      throw new Error("Invalid model list entry");
    modelCache.set(model.reference, { ...model, hay: modelNorm(`${model.reference} ${model.name}`) });
  }
  modelScoped = data.scoped.filter((reference) => modelCache.get(reference)?.configured);
  modelUnavailableScoped = (data.unavailableScoped ?? []).filter(
    (reference) => modelCache.has(reference) && !modelCache.get(reference).configured,
  );
  modelScopeSet = data.scopeSet === true;
  modelExtensionErrors = Array.isArray(data.extensionErrors) ? data.extensionErrors : [];
}
const emptyModelName = (role) => (role === "verifier" ? "No verifier model" : "Inherit coordinator");
function modelButton(reference, disabled = false, emptyLabel = "Inherit coordinator") {
  const model = modelCache.get(reference),
    context = compactTokens(model?.contextWindow);
  return `<button type="button" class="mp-current" data-action="mp-toggle" aria-haspopup="listbox" aria-expanded="false"${disabled ? " disabled" : ""}><span class="mp-main"><span class="mp-name">${esc(reference === "" ? emptyLabel : (model?.name ?? reference))}</span>${model ? `<span class="mp-ref mono">${esc(reference)}</span>` : ""}</span>${context ? `<span class="mp-ctx" title="Context window">${context}</span>` : "<span></span>"}<span class="mp-caret" aria-hidden="true">▾</span></button>`;
}
function modelPickerHtml(role, reference, unavailable, emptyLabel = emptyModelName(role)) {
  const configured = [...modelCache.values()].filter((model) => model.configured).length;
  return `<div class="mp" data-role="${role}" data-empty-label="${esc(emptyLabel)}" data-value="${esc(reference)}">${modelButton(reference, Boolean(unavailable), emptyLabel)}${unavailable ? "" : `<div class="mp-pop" hidden><input class="mp-search" type="search" role="combobox" aria-expanded="true" aria-controls="mp-list-${role}" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search ${configured} configured models…" aria-label="Search models for ${role}"><div class="mp-list" id="mp-list-${role}" role="listbox" aria-label="${role} models"></div></div>`}</div>`;
}
const MODEL_ROWS = 40,
  MODEL_UNCONFIGURED_ROWS = 5;
const INHERIT_MODEL = { reference: "", name: "Inherit coordinator", contextWindow: null, reasoning: false, configured: true };
const NO_VERIFIER_MODEL = { ...INHERIT_MODEL, name: "No verifier model (verification off)" };
// Worker, scout and reviewer pickers start with "Inherit coordinator" (stored as no model); the coordinator picker does not.
function modelGroups(query, value, role) {
  const groups = modelGroupsBase(query, value);
  const fallback = role?.endsWith("-fallback"),
    emptyName = fallback ? "Wait for quota reset" : role === "verifier" ? NO_VERIFIER_MODEL.name : "Inherit coordinator";
  if (!role || role === "coordinator" || (query.trim() && !modelNorm(emptyName).includes(modelNorm(query.trim())))) return groups;
  return [{ label: "", models: [{ ...INHERIT_MODEL, name: emptyName }], more: 0 }, ...groups];
}
function modelGroupsBase(query, value) {
  const terms = modelNorm(query).split(/\s+/).filter(Boolean),
    hit = (model) => terms.every((term) => model.hay.includes(term));
  const configured = [...modelCache.values()].filter((model) => model.configured),
    scoped = new Set(modelScoped),
    cap = (models, limit, label, extra = {}) => ({
      label,
      models: models.slice(0, limit),
      more: Math.max(0, models.length - limit),
      ...extra,
    });
  if (!terms.length) {
    const current = modelCache.get(value),
      groups =
        current && !scoped.has(value) && !modelUnavailableScoped.includes(value) ? [{ label: "Current", models: [current], more: 0 }] : [];
    if (scoped.size) groups.push({ label: "Scoped models", models: modelScoped.map((reference) => modelCache.get(reference)), more: 0 });
    if (modelUnavailableScoped.length)
      groups.push({
        label: "Scoped models without credentials",
        models: modelUnavailableScoped.map((reference) => modelCache.get(reference)),
        more: 0,
        hint: "Installed, but credentials are unavailable to this host. Check the host's environment and Pi provider configuration. On macOS, restart the host after changing exported zsh startup variables.",
      });
    if (!scoped.size && !modelScopeSet) groups.push(cap(configured, MODEL_ROWS, "Configured models"));
    else groups.push({ label: "", models: [], more: 0, hint: `Type to search all ${configured.length} configured models.` });
    return groups;
  }
  const groups = [],
    inScope = modelScoped.map((reference) => modelCache.get(reference)).filter(hit);
  if (inScope.length) groups.push({ label: "Scoped models", models: inScope, more: 0 });
  const others = configured.filter((model) => !scoped.has(model.reference) && hit(model));
  if (others.length) groups.push(cap(others, MODEL_ROWS, scoped.size ? "Other configured models" : "Configured models"));
  const missing = [...modelCache.values()].filter((model) => !model.configured && hit(model));
  if (missing.length) groups.push(cap(missing, MODEL_UNCONFIGURED_ROWS, "No credentials configured", { disabled: true }));
  return groups.length ? groups : [{ label: "", models: [], more: 0, hint: `No model matches “${query.trim()}”.` }];
}
function renderModelList(mp) {
  const search = mp.querySelector(".mp-search"),
    value = mp.dataset.value;
  let index = 0;
  mp.querySelector(".mp-list").innerHTML = [
    ...modelGroups(search.value, value, mp.dataset.role),
    ...modelExtensionErrors.map((item) => ({ label: "", models: [], more: 0, hint: `${item.extension} failed to load: ${item.error}` })),
  ]
    .map(
      (group) =>
        `${group.label ? `<div class="mp-group" role="presentation">${esc(group.label)}</div>` : ""}${group.models
          .map((model) => {
            const context = compactTokens(model.contextWindow);
            return `<div class="mp-row" role="option" id="mp-${mp.dataset.role}-${index++}" data-ref="${esc(model.reference)}" aria-selected="${model.reference === value}"${group.disabled || !model.configured ? ' aria-disabled="true" title="Credentials unavailable to this host. Check its environment and Pi provider configuration."' : ' data-action="mp-pick"'}><span class="mp-main"><span class="mp-name">${esc(model.name)}</span><span class="mp-ref mono">${esc(model.reference)}</span></span><span class="mp-tags">${model.reasoning ? '<span class="mp-ctx" title="Supports reasoning">reasoning</span>' : ""}${context ? `<span class="mp-ctx" title="Context window">${context}</span>` : ""}</span></div>`;
          })
          .join(
            "",
          )}${group.more ? `<div class="mp-more">+${group.more} more. Keep typing to narrow the list.</div>` : ""}${group.hint ? `<div class="mp-more">${esc(group.hint)}</div>` : ""}`,
    )
    .join("");
  const rows = [...mp.querySelectorAll(".mp-row:not([aria-disabled])")],
    selected = rows.findIndex((row) => row.dataset.ref === value);
  mpSetActive(mp, search.value.trim() || selected < 0 ? 0 : selected);
}
function mpSetActive(mp, index) {
  const rows = [...mp.querySelectorAll(".mp-row:not([aria-disabled])")],
    search = mp.querySelector(".mp-search");
  mp.dataset.active = rows.length ? String(Math.min(Math.max(index, 0), rows.length - 1)) : "";
  rows.forEach((row, at) => row.classList.toggle("active", String(at) === mp.dataset.active));
  const row = rows[Number(mp.dataset.active)];
  if (row) {
    search.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView({ block: "nearest" });
  } else search.removeAttribute("aria-activedescendant");
}
function mpClose(mp, refocus = false) {
  mp.classList.remove("open");
  mp.querySelector(".mp-pop").hidden = true;
  const button = mp.querySelector(".mp-current");
  button.setAttribute("aria-expanded", "false");
  if (refocus) button.focus();
}
function mpOpen(mp) {
  dialog.querySelectorAll(".mp.open").forEach((other) => other !== mp && mpClose(other));
  mp.classList.add("open");
  mp.querySelector(".mp-pop").hidden = false;
  mp.querySelector(".mp-current").setAttribute("aria-expanded", "true");
  const search = mp.querySelector(".mp-search");
  search.value = "";
  renderModelList(mp);
  search.focus();
  mp.querySelector(".mp-pop").scrollIntoView({ block: "nearest" });
}
function mpPick(mp, reference) {
  if (reference !== "" && !modelCache.get(reference)?.configured) throw new Error("That model has no credentials configured");
  mp.dataset.value = reference;
  mp.querySelector(".mp-current").outerHTML = modelButton(reference, false, mp.dataset.emptyLabel);
  mpClose(mp, true);
  settingsSync();
}
function mpKey(event, mp) {
  const search = mp.querySelector(".mp-search");
  if (event.target === search) {
    const count = mp.querySelectorAll(".mp-row:not([aria-disabled])").length,
      active = Number(mp.dataset.active || 0);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) mpSetActive(mp, (active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = mp.querySelectorAll(".mp-row:not([aria-disabled])")[active];
      if (row) mpPick(mp, row.dataset.ref);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      mpClose(mp, true);
      return true;
    }
  } else if (event.target.matches(".mp-current") && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    mpOpen(mp);
    return true;
  }
  return false;
}
onDialogClose(() => {
  settingsConfirmation = null;
});
registerDrafts({
  key: "settings",
  entries: () => [...settingsDrafts],
  validate(pairs) {
    if (
      !draftPairs(pairs) ||
      pairs.some(
        ([key, value]) =>
          !/^[a-f0-9-]{36}:(?:name|objective)$/.test(key) ||
          !value ||
          !draftText(value.text) ||
          !/^[a-f0-9]{64}$/.test(value.expectedRevision),
      )
    )
      throw new Error("Malformed settings drafts; nothing restored or truncated");
  },
  restore(pairs) {
    for (const [id, value] of pairs) settingsDrafts.set(id, { ...value });
  },
  capture: captureSettingsDraft,
});

// Settings section nav: smooth-scroll to a section (no hash navigation) and highlight the section in view.
document.addEventListener("click", (event) => {
  const link = event.target.closest(".set-nav a");
  if (!link) return;
  event.preventDefault();
  document.querySelector(link.getAttribute("href"))?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
});
const markSettingsNav = () => {
  const sections = [...document.querySelectorAll(".set-section")],
    body = document.querySelector(".body");
  if (!sections.length || document.querySelector('[data-panel="settings"]').hidden) return;
  const line = body.getBoundingClientRect().top + 90;
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  const current = atEnd ? sections.at(-1) : (sections.findLast((section) => section.getBoundingClientRect().top <= line) ?? sections[0]);
  for (const link of document.querySelectorAll(".set-nav a")) link.classList.toggle("on", link.getAttribute("href") === `#${current.id}`);
};
document.querySelector(".body").addEventListener("scroll", markSettingsNav, { passive: true });
new MutationObserver(markSettingsNav).observe(document.querySelector('[data-panel="settings"]'), {
  attributes: true,
  attributeFilter: ["hidden"],
});
