// Settings overlay (⌘,): left nav with a letter hotkey and a Project/Host scope label per item; the core four (Context, Model,
// Prompt, Tools) per profile; Automations as cards; Host sections. Contract requests that the host lacks show a quiet state.
import { call, contract, isUnavailable, UNAVAILABLE_TEXT } from "./api.js";
import { ago, clip, esc, shortModel, tokens, usd } from "./format.js";
import { bindings, captureNext, conflicts, display, paintHints, DEFAULTS } from "./hotkeys.js";
import { emit, fail, on, stale, state, toast } from "./state.js";
import { setUi } from "./ui.js";

const dialog = document.querySelector("#settings");
const PROFILES = [
  { id: "coordinator", label: "Coordinator" },
  { id: "worker", label: "Worker" },
  { id: "scout", label: "Scout" },
  { id: "reviewer", label: "Reviewer" },
];
const THINKING = ["off", "low", "medium", "high", "max"];
export const SECTIONS = [
  { id: "general", label: "General", scope: "project", group: "Essentials", render: general },
  { id: "context", label: "Context", scope: "project", group: "Core four", profile: true, render: context },
  { id: "model", label: "Model", scope: "project", group: "Core four", profile: true, render: model },
  { id: "prompt", label: "Prompt", scope: "project", group: "Core four", profile: true, render: prompt },
  { id: "tools", label: "Tools", scope: "project", group: "Core four", profile: true, render: tools },
  { id: "automations", label: "Automations", scope: "project", group: "Project", render: automations },
  { id: "tiers", label: "Model tiers", scope: "host", group: "Host", render: tiersSection },
  { id: "theme", label: "Theme", scope: "host", group: "Host", render: theme },
  { id: "animations", label: "Animations", scope: "host", group: "Host", render: animations },
  { id: "hotkeys", label: "Hotkeys", scope: "host", group: "Host", render: hotkeys },
  { id: "notifications", label: "Notifications", scope: "host", group: "Advanced", render: notifications },
  { id: "remote", label: "Remote access", scope: "host", group: "Advanced", render: remote },
  { id: "deploy", label: "Deploy", scope: "host", group: "Advanced", render: deploy },
  { id: "providers", label: "Providers", scope: "host", group: "Advanced", render: providers },
];
let section = "general",
  profile = "coordinator",
  paintGen = 0;

export const settingsOpen = () => dialog.open;
export function openSettings(id) {
  if (id && SECTIONS.some((item) => item.id === id)) section = id;
  if (!dialog.open) dialog.showModal();
  paint();
}
export function closeSettings() {
  if (dialog.open) dialog.close();
}
export function showSection(id) {
  if (!dialog.open || !SECTIONS.some((item) => item.id === id)) return false;
  section = id;
  paint();
  dialog.querySelector(`nav [data-section="${id}"]`)?.focus();
  return true;
}
on("select", () => dialog.open && paint());
dialog.addEventListener("cancel", (event) => event.preventDefault()); // Esc goes through the hotkey registry (leave-focus)
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeSettings();
  const nav = event.target.closest("nav [data-section]");
  if (nav) showSection(nav.dataset.section);
  const pick = event.target.closest("[data-profile]");
  if (pick) {
    profile = pick.dataset.profile;
    paint();
  }
});

function paint() {
  const current = SECTIONS.find((item) => item.id === section);
  dialog.dataset.section = section;
  const groups = [...new Set(SECTIONS.map((item) => item.group))];
  const nav = groups
    .map(
      (group) =>
        `<p class="nav-group">${esc(group)}</p>${SECTIONS.filter((item) => item.group === group)
          .map(
            (item) =>
              `<button type="button" data-section="${item.id}" data-scope="${item.scope}" aria-current="${item.id === section}"><span>${esc(item.label)}</span><span class="scope-tag ${item.scope}">${item.scope === "project" ? "proj" : "host"}</span><kbd data-hint="settings-${item.id}"></kbd></button>`,
          )
          .join("")}`,
    )
    .join("");
  const projectName = state.projects.find((item) => item.id === state.projectId)?.name ?? "";
  dialog.innerHTML = `<div class="settings-shell"><nav aria-label="Settings sections">${nav}<p class="nav-foot muted small"><kbd>Esc</kbd> close · letters jump</p></nav><section class="settings-main" aria-live="polite"><header class="settings-head"><h1>${esc(current.label)}</h1><span class="scope ${current.scope}">${current.scope === "project" ? `Project · ${esc(clip(projectName, 30))}` : "Host"}</span><span class="grow"></span><button type="button" class="icon-btn" data-cmd="leave-focus" aria-label="Close settings">✕</button></header>${current.profile ? `<div class="profiles" role="tablist" aria-label="Profile">${PROFILES.map((item) => `<button type="button" role="tab" data-profile="${item.id}" aria-selected="${item.id === profile}">${item.label}</button>`).join("")}</div>` : ""}<div class="settings-body"><p class="loading-line">Loading…</p></div></section></div>`;
  paintHints(dialog);
  const gen = ++paintGen,
    body = dialog.querySelector(".settings-body");
  const alive = () => gen === paintGen && dialog.open && body.isConnected;
  Promise.resolve(current.render(body, alive)).catch((error) => {
    if (alive()) body.innerHTML = `<p class="error-line">${esc(error.message)}</p>`;
  });
}
const quiet = (what) =>
  `<div class="quiet"><span class="quiet-dot" aria-hidden="true"></span><span><b>${esc(what)}</b> · ${esc(UNAVAILABLE_TEXT.toLowerCase())}</span></div>`;
const info = (text) => `<button type="button" class="info" data-info="${esc(text)}" aria-label="More information">ⓘ</button>`;
const line = (text, more) => `<p class="desc">${esc(text)}${more ? ` ${info(more)}` : ""}</p>`;

async function projectSettings() {
  return call("settings-snapshot", { id: state.projectId });
}
async function update(changes, message) {
  const gen = state.generation,
    id = state.projectId;
  const snap = await projectSettings();
  if (stale(gen)) return null;
  const result = await call("settings-update", { id, confirm: id, expectedRevision: snap.revision, changes });
  if (message) toast(message);
  emit("settings-changed");
  return result;
}

// ---------------------------------------------------------------------------------------------------------------- General

async function general(body, alive) {
  const view = state.view,
    projectInfo = view?.project;
  if (!projectInfo) return void (body.innerHTML = `<p class="muted">Select a project first.</p>`);
  body.innerHTML = `${line("Name, workspace and lifecycle of this project.")}<form class="field-row" id="name-form"><label for="project-name">Name</label><input id="project-name" value="${esc(projectInfo.name)}" maxlength="200" /><button type="submit" class="ghost-btn small">Save</button></form><div class="field-row"><span class="label">Workspace</span><code class="path">${esc(projectInfo.cwd)}</code></div><div class="field-row"><span class="label">State</span><span class="badge ${view.paused ? "t-needs" : "t-ready"}">${view.paused ? "Paused" : "Running"}</span><button type="button" class="ghost-btn small" data-life="${view.paused ? "resume" : "pause"}">${view.paused ? "Resume" : "Pause"}</button></div><div class="danger-zone"><p class="desc">Archive hides the project; delete removes it. Both ask once more. ${info("Archived projects can be restored. Delete keeps nothing.")}</p><button type="button" class="ghost-btn small" data-life="archive">Archive…</button><button type="button" class="ghost-btn small danger" data-life="delete">Delete…</button></div>`;
  body.querySelector("#name-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await update({ name: body.querySelector("#project-name").value.trim() }, "Renamed.").catch(fail);
    emit("projects-changed");
  });
  body.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-life]");
    if (!button || !alive()) return;
    const action = button.dataset.life;
    if ((action === "archive" || action === "delete") && button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = action === "delete" ? "Confirm delete" : "Confirm archive";
      button.classList.add("danger");
      return;
    }
    try {
      await call(action, { id: state.projectId, ...(action === "delete" || action === "resume" ? { confirm: state.projectId } : {}) });
      toast({ pause: "Paused. State kept.", resume: "Resumed.", archive: "Archived.", delete: "Deleted." }[action]);
      emit("projects-changed");
      if (action === "archive" || action === "delete") closeSettings();
      else if (alive()) paint();
    } catch (error) {
      fail(error);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------- Context

async function context(body, alive) {
  const snap = await projectSettings();
  if (!alive()) return;
  const live = state.view?.context ?? {};
  const settings = snap.values.context ?? { autoCompact: true };
  const window = settings.contextWindow ?? live.window ?? live.catalogWindow ?? 128000;
  let threshold = settings.thresholdPercent ?? 80,
    keep = settings.keepRecentTokens ?? 20000;
  const used = profile === "coordinator" ? (live.tokens ?? 0) : null;
  const draw = () => {
    const keepPct = Math.min(95, (100 * keep) / window);
    body.innerHTML = `${line(profile === "coordinator" ? "Current use, where auto-compaction starts and what it keeps." : "Context policy is shared by all profiles of this project.", "Drag a mark or focus it and use ←/→ (Shift for 5%). Compaction summarizes older turns and keeps the most recent tokens.")}<div class="ctx-bar" role="group" aria-label="Context window"><div class="ctx-used" style="width:${used === null ? 0 : Math.min(100, (100 * used) / window)}%"></div><div class="ctx-keep" style="width:${keepPct}%"></div><button type="button" class="mark auto" data-mark="auto" style="left:${threshold}%" role="slider" aria-label="Auto-compaction threshold" aria-valuemin="10" aria-valuemax="95" aria-valuenow="${threshold}" aria-valuetext="${threshold}% (${tokens((window * threshold) / 100)})"><span>auto ${threshold}%</span></button><button type="button" class="mark force" data-mark="keep" style="left:${keepPct}%" role="slider" aria-label="Tokens kept after compaction" aria-valuemin="1000" aria-valuemax="${window}" aria-valuenow="${keep}"><span>keep ${tokens(keep)}</span></button></div><div class="ctx-legend mono small"><span>${used === null ? "per-chat use shown for the coordinator" : `${tokens(used)} used`}</span><span>${tokens(window)} window</span></div><div class="field-row"><label class="switch"><input type="checkbox" id="auto-compact" ${settings.autoCompact ? "checked" : ""}/> Auto-compact</label><span class="grow"></span><button type="button" class="ghost-btn small" id="compact-now">Compact now</button></div><details class="small-field"><summary>Window override ${info("Use when the provider's real window is smaller than the catalog says.")}</summary><input id="ctx-window" type="number" min="4096" step="1024" value="${settings.contextWindow ?? ""}" placeholder="${tokens(live.catalogWindow ?? window)} from catalog" /></details><div class="row"><button type="button" class="primary small" id="ctx-save">Save</button></div>`;
    for (const mark of body.querySelectorAll(".mark")) bindMark(mark);
    body.querySelector("#ctx-save").addEventListener("click", save);
    body.querySelector("#compact-now").addEventListener("click", async () => {
      await call("compact", { id: state.projectId, ...(state.chatId !== "main" ? { chatId: state.chatId } : {}) }).then(
        () => toast("Compacting this chat…"),
        fail,
      );
    });
  };
  const bindMark = (mark) => {
    const bar = body.querySelector(".ctx-bar");
    const set = (pct) => {
      if (mark.dataset.mark === "auto") threshold = Math.round(Math.max(10, Math.min(95, pct)));
      else keep = Math.round(Math.max(1000, Math.min(window * 0.95, (pct / 100) * window)) / 500) * 500;
      draw();
      body.querySelector(`[data-mark="${mark.dataset.mark}"]`).focus();
    };
    mark.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      mark.setPointerCapture(event.pointerId);
      const rect = bar.getBoundingClientRect();
      const move = (next) => {
        const pct = ((next.clientX - rect.left) / rect.width) * 100;
        mark.style.left = `${Math.max(0, Math.min(100, pct))}%`;
        mark.dataset.pct = String(pct);
      };
      mark.addEventListener("pointermove", move);
      mark.addEventListener(
        "pointerup",
        () => {
          mark.removeEventListener("pointermove", move);
          if (mark.dataset.pct) set(Number(mark.dataset.pct));
        },
        { once: true },
      );
    });
    mark.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const step = (event.shiftKey ? 5 : 1) * (event.key === "ArrowLeft" ? -1 : 1);
      set(mark.dataset.mark === "auto" ? threshold + step : (100 * keep) / window + step);
    });
  };
  const save = async () => {
    const override = Number(body.querySelector("#ctx-window").value);
    await update(
      {
        context: {
          autoCompact: body.querySelector("#auto-compact").checked,
          thresholdPercent: threshold,
          keepRecentTokens: keep,
          ...(override >= 4096 ? { contextWindow: override } : {}),
        },
      },
      "Context policy saved.",
    ).catch(fail);
  };
  draw();
}

// ---------------------------------------------------------------------------------------------------------------- Model

async function model(body, alive) {
  const [profiles, tiers, snap] = await Promise.all([
    contract("profiles-get", { projectId: state.projectId }),
    contract("tiers-get"),
    projectSettings(),
  ]);
  if (!alive()) return;
  const legacy = profile === "coordinator" ? snap.values.model : (snap.values.models?.[profile] ?? snap.values.model);
  const current = isUnavailable(profiles) ? null : profiles.profiles[profile];
  const thinking = current?.thinking ?? "medium";
  const tierHtml = isUnavailable(tiers)
    ? quiet("Model tiers")
    : `<div class="tier-list" role="radiogroup" aria-label="Tier">${tiers.tiers
        .map((tier) => {
          const models = tier.models.map((ref) => tiers.catalog.find((item) => item.ref === ref) ?? { ref, name: ref });
          return `<button type="button" role="radio" class="tier${current?.tier === tier.id ? " on" : ""}" data-tier="${esc(tier.id)}" aria-checked="${current?.tier === tier.id}" ${isUnavailable(profiles) ? "disabled" : ""}><span class="tier-letter">${esc(tier.letter)}</span><span class="tier-name">${esc(tier.name)}</span><span class="tier-models">${models.map((item, index) => `<span class="mono small${item.available === false ? " off" : ""}">${index ? "→ " : ""}${esc(shortModel(item.ref))} <span class="muted">${tokens(item.contextWindow)}${Number.isFinite(item.inputCost) ? ` · ${usd(item.inputCost)}/${usd(item.outputCost)}` : ""}</span></span>`).join("")}</span></button>`;
        })
        .join("")}</div>`;
  body.innerHTML = `${line("Tier and thinking level for this profile.", "A tier is an ordered list of models. When a model's quota runs out or its provider fails, work continues on the next one.")}<div class="field-row"><span class="label">Effective</span><code>${esc(current?.effectiveModel ?? legacy ?? "")}</code></div>${tierHtml}<div class="field-row"><span class="label">Thinking</span><div class="seg" role="radiogroup" aria-label="Thinking level">${THINKING.map((level) => `<button type="button" role="radio" data-thinking="${level}" aria-checked="${level === thinking}" ${current ? "" : "disabled"}>${level}</button>`).join("")}</div></div>${current ? "" : quiet("Thinking level and tiers per profile")}${isUnavailable(profiles) ? `<details class="small-field"><summary>Model (legacy, per role) ${info("Until tiers land, each role has one model.")}</summary><div id="legacy-picker" class="muted small">Loading models…</div></details>` : ""}`;
  body.addEventListener("click", async (event) => {
    const tier = event.target.closest("[data-tier]"),
      level = event.target.closest("[data-thinking]");
    if (!tier && !level) return;
    const result = await contract("profiles-set", {
      projectId: state.projectId,
      revision: profiles.revision,
      profile,
      patch: tier ? { tier: tier.dataset.tier } : { thinking: level.dataset.thinking },
    }).catch(fail);
    if (result && !isUnavailable(result) && alive()) {
      toast("Profile updated.");
      paint();
    }
  });
  const legacyBox = body.querySelector("#legacy-picker");
  if (legacyBox) {
    const picker = await call("model-picker-snapshot", { id: state.projectId }).catch(() => null);
    if (!alive() || !picker) return;
    const items = picker.items.filter((item) => item.configured || item.reference === legacy);
    legacyBox.innerHTML = `<select id="legacy-model" aria-label="Model for ${esc(profile)}">${items.map((item) => `<option value="${esc(item.reference)}" ${item.reference === legacy ? "selected" : ""}>${esc(item.name)} · ${tokens(item.contextWindow)}</option>`).join("")}</select>`;
    legacyBox.querySelector("select").addEventListener("change", async (event) => {
      const value = event.target.value;
      await update(
        profile === "coordinator" ? { model: value } : { models: { [profile]: value } },
        `Model for ${profile}: ${shortModel(value)}`,
      ).catch(fail);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------- Prompt

async function prompt(body, alive) {
  const rendered = await contract("prompt-render", {
    projectId: state.projectId,
    profile,
    ...(state.chatId !== "main" ? { chatId: state.chatId } : {}),
  });
  if (!alive()) return;
  let sections,
    total,
    fallback = false;
  if (isUnavailable(rendered)) {
    fallback = true;
    const [prompts, snap] = await Promise.all([call("prompts-snapshot", { id: state.projectId }), projectSettings()]);
    if (!alive()) return;
    const role = prompts.roles.find((item) => item.role === profile);
    sections = [
      {
        id: "project",
        label: "Project instructions",
        source: "project settings · objective",
        editable: true,
        text: snap.values.objective ?? "",
      },
      {
        id: "role",
        label: "Role instructions",
        source: role?.override ? "project override" : "built-in",
        editable: true,
        text: role?.effective ?? "",
      },
    ].map((item) => ({ ...item, tokens: Math.ceil(item.text.length / 4) }));
    total = sections.reduce((sum, item) => sum + item.tokens, 0);
  } else {
    sections = rendered.sections;
    total = rendered.totalTokens;
  }
  let mode = "rendered";
  const draw = () => {
    body.innerHTML = `${line("The assembled prompt by section, with source and size.", "Locked sections come from the host and the repository. Edit changes only the editable ones.")}<div class="field-row"><div class="seg" role="tablist"><button type="button" role="tab" data-mode="rendered" aria-selected="${mode === "rendered"}">Rendered</button><button type="button" role="tab" data-mode="edit" aria-selected="${mode === "edit"}">Edit</button></div><span class="grow"></span><span class="mono small muted">≈${tokens(total)} tokens${fallback ? " (chars/4)" : ""}</span></div>${fallback ? quiet("Full rendered prompt (host contract, AGENTS.md, skills)") : ""}${sections
      .filter((item) => mode === "rendered" || item.editable)
      .map(
        (item) =>
          `<section class="prompt-sec${item.editable ? "" : " locked"}" data-sec="${esc(item.id)}"><header><b>${esc(item.label)}</b><span class="muted small">${esc(item.source)}</span><span class="grow"></span><span class="mono small muted">${tokens(item.tokens)}</span>${item.editable ? "" : `<span class="lock" aria-label="locked">🔒</span>`}</header>${mode === "edit" ? `<textarea aria-label="${esc(item.label)}" maxlength="32000">${esc(item.text)}</textarea>` : `<pre class="prompt-text">${esc(item.text)}</pre>`}</section>`,
      )
      .join(
        "",
      )}${mode === "edit" ? `<div class="row"><button type="button" class="primary small" id="prompt-save">Save</button></div>` : ""}`;
  };
  draw();
  body.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-mode]");
    if (tab) {
      mode = tab.dataset.mode;
      return draw();
    }
    if (!event.target.closest("#prompt-save")) return;
    const value = (id) => body.querySelector(`[data-sec="${id}"] textarea`)?.value;
    const changes = {};
    if (value("project") !== undefined) changes.objective = value("project");
    if (value("role") !== undefined) changes.prompts = { [profile]: value("role").trim() ? value("role") : null };
    await update(changes, "Prompt saved.").catch(fail);
  });
}

// ---------------------------------------------------------------------------------------------------------------- Tools

async function tools(body, alive) {
  const result = await contract("profile-tools", { projectId: state.projectId, profile });
  if (!alive()) return;
  let groups,
    fallback = false;
  if (isUnavailable(result)) {
    fallback = true;
    const names = profile === "coordinator" ? (state.view?.coordinatorAccess?.toolNames ?? []) : [];
    const groupOf = (name) =>
      /^(read|write|edit|bash|grep|find|ls)$/.test(name)
        ? "Coding"
        : name === "agents"
          ? "Delegation"
          : /knowledge/.test(name)
            ? "Memory"
            : /gh|github/.test(name)
              ? "GitHub"
              : /archive/.test(name)
                ? "Archive"
                : "Project";
    const map = new Map();
    for (const name of names) {
      const id = groupOf(name);
      if (!map.has(id)) map.set(id, { id, label: id, source: "core", locked: true, tools: [] });
      map.get(id).tools.push({ name, description: "", parameters: null, enabled: true });
    }
    groups = [...map.values()];
  } else groups = result.groups;
  let q = "",
    view = "title";
  const draw = () => {
    const match = (tool) => !q || `${tool.name} ${tool.description}`.toLowerCase().includes(q);
    body.innerHTML = `${line("What this profile is offered, grouped by source.", "Switching a tool off removes it from new turns of this profile. MCP servers have an extra switch for write tools.")}<div class="field-row"><input type="search" id="tool-search" placeholder="Search tools" aria-label="Search tools" value="${esc(q)}" /><div class="seg" role="tablist" aria-label="View">${["title", "description", "params"].map((item) => `<button type="button" role="tab" data-view="${item}" aria-selected="${view === item}">${item[0].toUpperCase() + item.slice(1)}</button>`).join("")}</div></div>${fallback ? quiet(profile === "coordinator" ? "Toggles per profile (read-only list from this chat)" : `Tools for ${profile}`) : ""}${
      groups
        .map((group) => {
          const list = group.tools.filter(match);
          if (!list.length) return "";
          return `<section class="tool-group-card"><header><b>${esc(group.label)}</b><span class="badge">${esc(group.source)}</span><span class="muted small">${list.filter((tool) => tool.enabled).length}/${list.length}</span></header><div class="tool-grid${view === "title" ? "" : " wide"}">${list
            .map(
              (tool) =>
                `<label class="tool-toggle"><input type="checkbox" data-tool-name="${esc(tool.name)}" ${tool.enabled ? "checked" : ""} ${fallback || group.locked ? "disabled" : ""} /><span class="mono">${esc(tool.name)}</span>${view === "description" ? `<span class="muted small">${esc(clip(tool.description, 160))}</span>` : ""}${view === "params" ? `<pre class="small">${esc(clip(JSON.stringify(tool.parameters ?? {}, null, 1), 600))}</pre>` : ""}</label>`,
            )
            .join("")}</div></section>`;
        })
        .join("") || `<p class="muted">No tools match.</p>`
    }`;
    const search = body.querySelector("#tool-search");
    search.addEventListener("input", () => {
      q = search.value.toLowerCase();
      const at = search.selectionStart;
      draw();
      body.querySelector("#tool-search").focus();
      body.querySelector("#tool-search").setSelectionRange(at, at);
    });
  };
  draw();
  body.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-view]");
    if (tab) {
      view = tab.dataset.view;
      draw();
    }
  });
  body.addEventListener("change", async (event) => {
    const box = event.target.closest("[data-tool-name]");
    if (!box || fallback) return;
    const profiles = await contract("profiles-get", { projectId: state.projectId });
    if (isUnavailable(profiles) || !alive()) return;
    const disabled = new Set(profiles.profiles[profile].tools?.disabled ?? []);
    box.checked ? disabled.delete(box.dataset.toolName) : disabled.add(box.dataset.toolName);
    await contract("profiles-set", {
      projectId: state.projectId,
      revision: profiles.revision,
      profile,
      patch: { tools: { disabled: [...disabled] } },
    }).catch(fail);
  });
}

// ---------------------------------------------------------------------------------------------------------------- Automations

function every(ms) {
  if (!ms) return "";
  const min = ms / 60000;
  return min % 1440 === 0
    ? `every ${min / 1440 === 1 ? "day" : `${min / 1440} days`}`
    : min % 60 === 0
      ? `every ${min / 60 === 1 ? "hour" : `${min / 60} hours`}`
      : `every ${min} min`;
}
function cronOf(record) {
  if (record.calendar?.kind === "daily") {
    const [h, m] = record.calendar.time.split(":");
    return `${Number(m)} ${Number(h)} * * *`;
  }
  if (record.calendar?.kind === "weekly") {
    const [h, m] = record.calendar.time.split(":");
    return `${Number(m)} ${Number(h)} * * ${record.calendar.days.join(",")}`;
  }
  if (record.everyMs && record.everyMs % 3600000 === 0) return `0 */${record.everyMs / 3600000} * * *`;
  if (record.everyMs) return `*/${Math.round(record.everyMs / 60000)} * * * *`;
  return "once";
}
function words(record) {
  if (record.calendar?.kind === "daily") return `Daily at ${record.calendar.time}`;
  if (record.calendar?.kind === "weekly")
    return `Weekly ${record.calendar.days.map((d) => "Sun Mon Tue Wed Thu Fri Sat".split(" ")[d]).join(", ")} at ${record.calendar.time}`;
  if (record.everyMs) return every(record.everyMs).replace(/^./, (c) => c.toUpperCase());
  return record.atMs ? `Once at ${new Date(record.atMs).toLocaleString()}` : "Once";
}
async function automations(body, alive) {
  const [schedules, auto] = await Promise.all([
    call("schedule-snapshot", { id: state.projectId }),
    call("automation-snapshot", { id: state.projectId }),
  ]);
  if (!alive()) return;
  const card = ({ kind, id, name, when, cron, text, on: enabled, last, target }) =>
    `<article class="auto-card" data-kind="${kind}" data-id="${esc(id)}"><header><b>${esc(name)}</b><span class="grow"></span><label class="switch" aria-label="${esc(name)} on or off"><input type="checkbox" data-auto-toggle ${enabled ? "checked" : ""} /><span class="track" aria-hidden="true"></span></label></header><p class="auto-when">${esc(when)} <code class="small">${esc(cron)}</code>${target ? ` · <span class="muted">${esc(target)}</span>` : ""}</p>${text ? `<p class="auto-text">${esc(clip(text, 160))}</p>` : ""}<footer><span class="muted small">${last ? `Last run ${esc(ago(last))}` : "Not run yet"}</span><span class="grow"></span><button type="button" class="link-btn" disabled title="${esc(UNAVAILABLE_TEXT)}">Run now</button><button type="button" class="link-btn" data-history>History</button><button type="button" class="link-btn" disabled title="${esc(UNAVAILABLE_TEXT)}">Edit</button><button type="button" class="link-btn" disabled title="${esc(UNAVAILABLE_TEXT)}">Delete</button></footer></article>`;
  const chatName = (id) => (state.view?.chats ?? []).find((chat) => chat.id === id)?.title ?? id;
  const cards = [
    ...schedules.schedules.map((record) =>
      card({
        kind: "schedule",
        id: record.id,
        name: clip(record.text.split("\n")[0], 60) || record.id,
        when: words(record),
        cron: cronOf(record),
        text: record.text,
        on: record.enabled,
        last: record.lastRunAt ?? record.lastAtMs,
      }),
    ),
    card({
      kind: "follow",
      id: "follow",
      name: "Follow PRs",
      when: every(auto.follow.everyMs).replace(/^./, (c) => c.toUpperCase()),
      cron: cronOf({ everyMs: auto.follow.everyMs }),
      text: `Watches ${auto.follow.repos.length || "no"} repositories${auto.follow.autoFix ? `, fixes up to ${auto.follow.fixCap} times` : ""}.`,
      on: auto.follow.enabled,
      last: auto.follow.lastPollAtMs,
      target: `→ ${chatName(auto.follow.eventChat)}`,
    }),
    card({
      kind: "webhook",
      id: "webhook",
      name: "Webhook",
      when: "On each delivery",
      cron: "event",
      text: "",
      on: auto.webhook.enabled,
      last: null,
      target: `→ ${chatName(auto.eventChat)}`,
    }),
  ];
  body.innerHTML = `${line("Schedules, PR following and webhooks for this project.", "Switching applies at once; use Undo in the toast to switch back. New schedules are created by the coordinator or the CLI.")}<div class="auto-grid">${cards.join("")}</div>`;
  const apply = async (kind, id, enabled) => {
    if (kind === "schedule") await call("schedule-enable", { id: state.projectId, scheduleId: id, enabled });
    else
      await call("automation-update", {
        id: state.projectId,
        change: kind === "follow" ? { follow: { enabled } } : { webhook: { enabled } },
      });
  };
  body.addEventListener("change", async (event) => {
    const toggle = event.target.closest("[data-auto-toggle]");
    if (!toggle) return;
    const node = toggle.closest(".auto-card"),
      enabled = toggle.checked;
    try {
      await apply(node.dataset.kind, node.dataset.id, enabled);
      toast(`${node.querySelector("b").textContent} ${enabled ? "on" : "off"}.`, {
        action: "Undo",
        onAction: async () => {
          await apply(node.dataset.kind, node.dataset.id, !enabled).catch(fail);
          if (alive()) paint();
        },
      });
    } catch (error) {
      toggle.checked = !enabled;
      fail(error);
    }
  });
  body.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-history]")) return;
    const history = await call("schedule-history", { id: state.projectId, kind: "intents", limit: 10 }).catch(fail);
    if (!history || !alive()) return;
    toast(`${history.items?.length ?? history.total ?? 0} recent runs. Full history in the CLI for now.`);
  });
}

// ---------------------------------------------------------------------------------------------------------------- Host

async function tiersSection(body, alive) {
  const data = await contract("tiers-get");
  if (!alive()) return;
  if (isUnavailable(data))
    return void (body.innerHTML = `${line("Named, ordered model lists that profiles pick from.")}${quiet("Model tiers editor")}`);
  let tiers = structuredClone(data.tiers);
  const draw = () => {
    body.innerHTML = `${line("Ordered models per tier; the first is preferred, the rest are the fallback order.", "Drag a model or use the arrows to reorder. A model that is not signed in shows struck through.")}${tiers
      .map(
        (tier, t) =>
          `<section class="tier-edit" data-t="${t}"><header><span class="tier-letter">${esc(tier.letter)}</span><b>${esc(tier.name)}</b><span class="muted small mono">${esc(tier.id)}</span></header><ol>${tier.models
            .map((ref, m) => {
              const item = data.catalog.find((entry) => entry.ref === ref) ?? {};
              return `<li draggable="true" data-m="${m}" class="${item.available === false ? "off" : ""}"><span class="grip" aria-hidden="true">⋮⋮</span><span class="mono">${esc(ref)}</span><span class="muted small">${tokens(item.contextWindow)}${Number.isFinite(item.inputCost) ? ` · ${usd(item.inputCost)}/${usd(item.outputCost)} per M` : ""}</span><span class="grow"></span><button type="button" class="icon-btn small" data-move="-1" aria-label="Move up">↑</button><button type="button" class="icon-btn small" data-move="1" aria-label="Move down">↓</button><button type="button" class="icon-btn small" data-remove aria-label="Remove">✕</button></li>`;
            })
            .join("")}</ol><select data-add aria-label="Add model to ${esc(tier.name)}"><option value="">Add model…</option>${data.catalog
            .filter((entry) => !tier.models.includes(entry.ref))
            .map(
              (entry) =>
                `<option value="${esc(entry.ref)}">${esc(entry.name ?? entry.ref)}${entry.available ? "" : " (not signed in)"}</option>`,
            )
            .join("")}</select></section>`,
      )
      .join("")}<div class="row"><button type="button" class="primary small" id="tiers-save">Save tiers</button></div>`;
  };
  draw();
  let dragging = null;
  body.addEventListener("dragstart", (event) => {
    const item = event.target.closest("li[data-m]");
    if (item) dragging = { t: Number(item.closest("[data-t]").dataset.t), m: Number(item.dataset.m) };
  });
  body.addEventListener("dragover", (event) => event.target.closest("li[data-m]") && event.preventDefault());
  body.addEventListener("drop", (event) => {
    const item = event.target.closest("li[data-m]");
    if (!item || !dragging) return;
    const t = Number(item.closest("[data-t]").dataset.t);
    if (t !== dragging.t) return;
    const list = tiers[t].models,
      [moved] = list.splice(dragging.m, 1);
    list.splice(Number(item.dataset.m), 0, moved);
    dragging = null;
    draw();
  });
  body.addEventListener("click", async (event) => {
    const row = event.target.closest("li[data-m]");
    const t = row ? Number(row.closest("[data-t]").dataset.t) : -1,
      m = row ? Number(row.dataset.m) : -1;
    const move = event.target.closest("[data-move]");
    if (move) {
      const list = tiers[t].models,
        to = m + Number(move.dataset.move);
      if (to < 0 || to >= list.length) return;
      [list[m], list[to]] = [list[to], list[m]];
      draw();
      body.querySelector(`[data-t="${t}"] li[data-m="${to}"] [data-move="${move.dataset.move}"]`)?.focus();
      return;
    }
    if (event.target.closest("[data-remove]")) {
      tiers[t].models.splice(m, 1);
      return draw();
    }
    if (event.target.closest("#tiers-save")) {
      const result = await contract("tiers-set", { revision: data.revision, tiers }).catch(fail);
      if (result && !isUnavailable(result)) {
        data.revision = result.revision;
        tiers = structuredClone(result.tiers);
        toast("Tiers saved.");
      }
    }
  });
  body.addEventListener("change", (event) => {
    const add = event.target.closest("[data-add]");
    if (!add || !add.value) return;
    tiers[Number(add.closest("[data-t]").dataset.t)].models.push(add.value);
    draw();
  });
}
const THEMES = [
  { id: "claude", label: "Claude", hint: "Warm charcoal (default)" },
  { id: "midnight", label: "Midnight", hint: "Deep blue, cooler accents" },
  { id: "light", label: "Light", hint: "Paper and ink" },
  { id: "system", label: "System", hint: "Claude or Light with the OS" },
];
function theme(body) {
  const current = state.ui?.theme ?? "claude";
  body.innerHTML = `${line(state.uiAvailable ? "Same in every browser; the Host agent can change it too." : "Kept in this browser until the host ui document lands.")}<div class="theme-grid" role="radiogroup" aria-label="Theme">${THEMES.map((item) => `<button type="button" role="radio" class="theme-card" data-theme-option="${item.id}" aria-checked="${item.id === current}"><span class="swatch sw-${item.id}" aria-hidden="true"><i></i><i></i><i></i></span><b>${item.label}</b><span class="muted small">${item.hint}</span></button>`).join("")}</div>${state.uiAvailable ? "" : quiet("Host-wide theme")}`;
  body.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-theme-option]");
    if (!pick) return;
    void setUi({ theme: pick.dataset.themeOption });
    body.querySelectorAll("[data-theme-option]").forEach((node) => node.setAttribute("aria-checked", String(node === pick)));
  });
}
function animations(body) {
  const current = state.ui?.animations ?? "subtle",
    reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  body.innerHTML = `${line("Rows slide in, working agents shimmer, panels glide.", "Off removes all motion. Your system's reduced-motion setting always wins.")}<div class="seg big" role="radiogroup" aria-label="Animations">${["off", "subtle", "full"].map((level) => `<button type="button" role="radio" data-motion="${level}" aria-checked="${level === current}">${level}</button>`).join("")}</div>${reduced ? `<p class="muted small">Reduced motion is on in your system settings, so motion stays off.</p>` : ""}<div class="field-row"><label class="switch"><input type="checkbox" id="statusline-toggle" ${state.ui?.statusLine !== false ? "checked" : ""}/> Status line at the bottom</label></div>`;
  body.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-motion]");
    if (!pick) return;
    void setUi({ animations: pick.dataset.motion });
    body.querySelectorAll("[data-motion]").forEach((node) => node.setAttribute("aria-checked", String(node === pick)));
  });
  body.querySelector("#statusline-toggle").addEventListener("change", (event) => void setUi({ statusLine: event.target.checked }));
}
function hotkeys(body) {
  const draw = () => {
    const clash = conflicts();
    const rows = bindings().filter((item) => !/^chat-[2-9]$/.test(item.id));
    body.innerHTML = `${line("Every binding in one list.", "Press Edit, then the new key. Esc cancels. Settings letters work only while this overlay is open.")}<table class="hotkeys"><tbody>${rows
      .map(
        (item) =>
          `<tr class="${clash.has(item.id) ? "clash" : ""}"><td>${esc(item.id === "chat-1" ? "Open chat 1–9" : item.id.startsWith("settings-") ? `Settings · ${SECTIONS.find((s) => `settings-${s.id}` === item.id)?.label ?? item.id}` : item.label)}</td><td><kbd>${esc(display(item.binding))}</kbd>${item.id === "chat-1" ? " … <kbd>9</kbd>" : ""}${clash.has(item.id) ? ` <span class="badge t-bad">conflict</span>` : ""}</td><td class="right">${item.id === "chat-1" ? "" : `<button type="button" class="link-btn" data-rebind="${item.id}">Edit</button>${item.changed ? `<button type="button" class="link-btn" data-reset="${item.id}">Reset</button>` : ""}`}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  };
  draw();
  body.addEventListener("click", async (event) => {
    const reset = event.target.closest("[data-reset]");
    if (reset) {
      const next = { ...(state.ui?.hotkeys ?? {}) };
      delete next[reset.dataset.reset];
      await setUi({ hotkeys: next });
      return draw();
    }
    const edit = event.target.closest("[data-rebind]");
    if (!edit) return;
    edit.textContent = "Press a key…";
    const pressed = await captureNext();
    if (pressed && pressed !== DEFAULTS[edit.dataset.rebind])
      await setUi({ hotkeys: { ...(state.ui?.hotkeys ?? {}), [edit.dataset.rebind]: pressed } });
    else if (pressed) {
      const next = { ...(state.ui?.hotkeys ?? {}) };
      delete next[edit.dataset.rebind];
      await setUi({ hotkeys: next });
    }
    draw();
    body.querySelector(`[data-rebind="${edit.dataset.rebind}"]`)?.focus();
  });
}
async function notifications(body, alive) {
  const telegram = await call("telegram-snapshot").catch(() => null);
  if (!alive()) return;
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  body.innerHTML = `${line("Browser alerts and Telegram.", "Browser alerts are per browser. Telegram pairing is done from the CLI or the classic inbox.")}<div class="field-row"><span class="label">Browser</span><span class="badge">${esc(permission)}</span>${permission === "default" ? `<button type="button" class="ghost-btn small" id="notify-ask">Allow</button>` : ""}</div><div class="field-row"><span class="label">Telegram</span><span class="badge ${telegram?.paired ? "t-ready" : ""}">${telegram?.paired ? `paired${telegram.botUsername ? ` · @${esc(telegram.botUsername)}` : ""}` : telegram?.configured ? "not paired" : "not set up"}</span></div>`;
  body.querySelector("#notify-ask")?.addEventListener("click", async () => {
    await Notification.requestPermission();
    if (alive()) paint();
  });
}
async function remote(body, alive) {
  const status = await call("remote-status").catch((error) => ({ error: error.message }));
  if (!alive()) return;
  body.innerHTML = `${line("Reach this host from your phone through the relay.", "Pairing and device management stay in the local inbox or CLI.")}<div class="field-row"><span class="label">Relay</span><span class="badge ${status.enabled ? "t-ready" : ""}">${esc(status.error ?? status.connection ?? "off")}</span><code class="small">${esc(status.hostName ?? "")}</code></div>${status.lastError ? `<p class="error-line small">${esc(status.lastError)}</p>` : ""}`;
}
async function deploy(body, alive) {
  const snap = await call("deploy-snapshot").catch((error) => ({ error: error.message }));
  if (!alive()) return;
  body.innerHTML = `${line("Self-deploys of pi-prjcts in a quiet window.", "Deploy is an owner-only action: the Host agent may prepare it, never press it.")}<div class="field-row"><span class="label">Window</span><span class="mono">${esc(snap.settings ? `${snap.settings.startHour}:00–${snap.settings.endHour}:00${snap.settings.idle ? " · when idle" : ""}` : (snap.error ?? ""))}</span><span class="badge ${snap.running ? "t-work" : ""}">${snap.running ? "deploying" : "idle"}</span></div>`;
}
async function providers(body, alive) {
  const limits = await call("limits-snapshot").catch(() => null);
  if (!alive() || !limits) return;
  body.innerHTML = `${line("Subscriptions and their limits.", "Sign in from the CLI with /login; Cursor connects from the classic inbox.")}<ul class="provider-list">${limits.providers
    .map(
      (item) =>
        `<li><b>${esc(item.label)}</b><span class="badge ${item.status === "ok" ? "t-ready" : ""}">${esc(item.status)}</span><span class="muted small">${esc(item.reason ?? (item.usage ? `${usd(item.usage.amountUsd)} this period` : item.samples?.[0] ? `${Math.round(item.samples[0].usedPercent ?? 0)}% used` : ""))}</span></li>`,
    )
    .join("")}</ul>`;
}
