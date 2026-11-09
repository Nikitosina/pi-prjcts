// Settings overlay (⌘,): left nav with a letter hotkey and a Project/Host scope label per item; the core four (Context, Model,
// Prompt, Tools) per profile; Automations as cards; Host sections. Every section reads and writes the host directly.
import { call } from "./api.js";
import { ago, clip, esc, oneLine, shortModel, size, tokens, usd } from "./format.js";
import { bindings, captureNext, conflicts, display, paintHints, DEFAULTS } from "./hotkeys.js";
import { emit, inline, on, stale, state, toast } from "./state.js";
import { setUi } from "./ui.js";
import { STATUS_ITEMS } from "./statusline.js";
import { promptSection } from "./prompts.js";
import { connectCursor, limitShown, loadLimits, refreshLimits, setLimitShown } from "./limits.js";

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
  { id: "storage", label: "Storage", scope: "project", group: "Project", render: storage },
  { id: "tiers", label: "Model tiers", scope: "host", group: "Host", render: tiersSection },
  { id: "theme", label: "Theme", scope: "host", group: "Host", render: theme },
  { id: "animations", label: "Animations", scope: "host", group: "Host", render: animations },
  { id: "statusline", label: "Status line", scope: "host", group: "Host", render: statusLine },
  { id: "hotkeys", label: "Hotkeys", scope: "host", group: "Host", render: hotkeys },
  { id: "notifications", label: "Notifications", scope: "host", group: "Advanced", render: notifications },
  { id: "remote", label: "Remote access", scope: "host", group: "Advanced", render: remote },
  { id: "deploy", label: "Deploy", scope: "host", group: "Advanced", render: deploy },
  { id: "providers", label: "Providers", scope: "host", group: "Advanced", render: providers },
];
let section = "general",
  profile = "coordinator",
  paintGen = 0,
  prompts = null, // the open Prompt section: back() for Esc, refresh() for writes from elsewhere
  back = null; // another open section's own Esc step (an inline edit); true when it stepped back

export const settingsOpen = () => dialog.open;
export function openSettings(id) {
  if (id && SECTIONS.some((item) => item.id === id)) section = id;
  if (!dialog.open) dialog.showModal();
  paint();
}
export function closeSettings() {
  if (dialog.open) dialog.close();
}
/** Esc inside Settings: a section with its own inner view (the Prompt editor) steps back first; true when it did. */
export const settingsBack = () => !!prompts?.back() || !!back?.();
/** Prompt blocks changed elsewhere (another tab, the Host agent): an open Prompt section re-reads; nothing opens. */
on("prompts-changed", () => void prompts?.refresh().catch(() => {}));
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

function paint(keepScroll = false) {
  const scroll = keepScroll ? (dialog.querySelector(".settings-body")?.scrollTop ?? 0) : 0;
  const current = SECTIONS.find((item) => item.id === section);
  dialog.dataset.section = section;
  if (profile === "host" && section !== "prompt") profile = "coordinator";
  prompts = null;
  back = null;
  const scope = current.profile && profile === "host" ? "host" : current.scope;
  const tabs = section === "prompt" ? [...PROFILES, { id: "host", label: "Host agent" }] : PROFILES;
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
  dialog.innerHTML = `<div class="settings-shell"><nav aria-label="Settings sections">${nav}<p class="nav-foot muted small"><kbd>Esc</kbd> close · letters jump</p></nav><section class="settings-main"><header class="settings-head"><h1>${esc(current.label)}</h1>${scope === "project" ? `<span class="scope project">Project · ${esc(clip(projectName, 30))}</span>` : `<span class="scope host">Host</span>`}<span class="settings-status inline-status" role="status" aria-live="polite"></span><span class="grow"></span><button type="button" class="icon-btn" data-cmd="settings" aria-label="Close settings">✕</button></header>${current.profile ? `<div class="profiles" role="tablist" aria-label="Profile">${tabs.map((item) => `<button type="button" role="tab" data-profile="${item.id}" aria-selected="${item.id === profile}">${item.label}</button>`).join("")}</div>` : ""}<div class="settings-body"><p class="loading-line">Loading…</p></div></section></div>`;
  paintHints(dialog);
  // A status said just before a repaint (a save redraws the section) stays visible in the new header.
  if (said && said.section === section && Date.now() - said.at < 3000) inline(dialog.querySelector(".settings-status"), said.text, said);
  const gen = ++paintGen,
    body = dialog.querySelector(".settings-body");
  const alive = () => gen === paintGen && dialog.open && body.isConnected;
  Promise.resolve(current.render(body, alive))
    .then(() => {
      if (alive()) body.scrollTop = scroll;
    })
    .catch((error) => {
      if (alive()) body.innerHTML = `<p class="error-line">${esc(error.message)}</p>`;
    });
}
/** Confirms a change next to the section header: the control that changed is in this section. */
let said = null;
function say(text, { error = false } = {}) {
  said = { text, error, section, at: Date.now() };
  inline(dialog.querySelector(".settings-status"), text, { error });
}
function sayFail(error) {
  console.warn(error);
  say(error?.message ?? String(error), { error: true });
}
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
  if (message) say(message);
  emit("settings-changed");
  return result;
}

// ---------------------------------------------------------------------------------------------------------------- General

async function general(body, alive) {
  const view = state.view,
    projectInfo = view?.project;
  if (!projectInfo) return void (body.innerHTML = `<p class="muted">Select a project first.</p>`);
  const { review } = (await projectSettings()).values;
  if (!alive()) return;
  body.innerHTML = `${line("Name, workspace and lifecycle of this project.")}<form class="field-row" id="name-form"><label for="project-name">Name</label><input id="project-name" value="${esc(projectInfo.name)}" maxlength="200" /><button type="submit" class="ghost-btn small">Save</button></form><form class="field-row" id="review-form"><label for="review-rechecks">Review re-checks</label><input id="review-rechecks" type="number" min="0" max="5" step="1" required value="${esc(String(review.rechecks))}" /><button type="submit" class="ghost-btn small">Save</button>${info("Workers run one full review, then at most this many re-checks of the fix diff and the open findings (0–5). Findings still open after that go to the Ready report's gaps.")}</form><div class="field-row"><span class="label">Workspace</span><code class="path">${esc(projectInfo.cwd)}</code></div><div class="field-row"><span class="label">State</span><span class="badge ${view.paused ? "t-needs" : "t-ready"}">${view.paused ? "Paused" : "Running"}</span><button type="button" class="ghost-btn small" data-life="${view.paused ? "resume" : "pause"}">${view.paused ? "Resume" : "Pause"}</button></div><div class="danger-zone"><p class="desc">Archive hides the project; delete removes it. Both ask once more. ${info("Archived projects can be restored. Delete keeps nothing.")}</p><button type="button" class="ghost-btn small" data-life="archive">Archive…</button><button type="button" class="ghost-btn small danger" data-life="delete">Delete…</button></div>`;
  body.querySelector("#name-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await update({ name: body.querySelector("#project-name").value.trim() }, "Renamed.").catch(sayFail);
    emit("projects-changed");
  });
  body.querySelector("#review-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const rechecks = Number(body.querySelector("#review-rechecks").value);
    await update({ review: { rechecks } }, `Review re-checks: ${rechecks}.`).catch(sayFail);
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
      say({ pause: "Paused. State kept.", resume: "Resumed.", archive: "Archived.", delete: "Deleted." }[action]);
      emit("projects-changed");
      if (action === "archive" || action === "delete") closeSettings();
      else if (alive()) paint();
    } catch (error) {
      sayFail(error);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------- Context

/** Mirrors compactionPolicy in src/durable-runtime.ts: compaction starts at the threshold, and generation blocks (forced compaction)
 * once only the answer reserve is left: reserve = clamp(window − start, 1024, 16384). */
const reserveFor = (window, threshold) => Math.max(1024, Math.min(16384, window - Math.floor((window * threshold) / 100)));

async function context(body, alive) {
  const snap = await projectSettings();
  if (!alive()) return;
  const live = state.view?.context ?? {};
  const settings = snap.values.context ?? { autoCompact: true };
  const window = settings.contextWindow ?? live.window ?? live.catalogWindow ?? 128000;
  let threshold = settings.thresholdPercent ?? 80;
  const keep = settings.keepRecentTokens ?? 20000;
  const used = profile === "coordinator" ? (live.tokens ?? 0) : null;
  let saving = null;
  const draw = () => {
    const reserve = reserveFor(window, threshold),
      forcePct = (100 * (window - reserve)) / window,
      usedPct = used === null ? 0 : Math.min(100, (100 * used) / window);
    body.innerHTML = `${line(profile === "coordinator" ? "How full this chat is, and where compaction starts." : "Context policy is shared by all profiles of this project.", "Drag the auto mark, or focus it and use ←/→ (Shift for 5%). Auto-compaction summarizes older turns in the background. At the force mark only the answer reserve is left, so the next turn waits for compaction. The reserve follows the auto mark.")}
${live.compactionFailure && !live.compacting ? `<details class="compaction-failure" data-compaction-failure><summary>Last compaction failed</summary><p class="error-line small">${esc(clip(live.compactionFailure.error, 2000))}</p><p class="muted small">History is kept. Compact now retries with the current context.</p></details>` : ""}
<div class="ctx-head mono"><span class="ctx-total">${used === null ? "per-chat use shown for the coordinator" : `${tokens(used)} / ${tokens(window)}`}</span><span class="muted">${used === null ? `${tokens(window)} window` : `${Math.round(usedPct)}% used`}</span></div>
<div class="ctx-bar" role="group" aria-label="Context window">${used === null ? "" : `<div class="ctx-used" style="width:${usedPct}%"></div><span class="ctx-now" style="left:${usedPct}%" title="Current use: ${tokens(used)}"></span>`}<div class="ctx-reserve" style="left:${forcePct}%" title="Answer reserve: ${tokens(reserve)}"></div><button type="button" class="mark auto" data-mark="auto" style="left:${threshold}%" role="slider" aria-label="Auto-compaction threshold" aria-valuemin="10" aria-valuemax="95" aria-valuenow="${threshold}" aria-valuetext="${threshold}% (${tokens((window * threshold) / 100)})"><span>auto ${threshold}%</span></button><span class="mark force" style="left:${forcePct}%" title="Forced compaction at ${tokens(window - reserve)}"><span>force ${Math.round(forcePct)}%</span></span></div>
<div class="ctx-legend mono small"><span>0</span><span>${tokens((window * threshold) / 100)} auto · ${tokens(window - reserve)} force</span><span>${tokens(window)} window</span></div>
<div class="field-row"><label class="switch"><input type="checkbox" id="auto-compact" ${settings.autoCompact ? "checked" : ""}/> Auto-compact</label><span class="muted small">keeps the last ${tokens(keep)}</span><span class="grow"></span><button type="button" class="ghost-btn small" id="compact-now">Compact now</button></div>
<details class="small-field"><summary>Advanced ${info("Keep: recent tokens left verbatim after a compaction. Window override: use when the provider's real window is smaller than the catalog says.")}</summary><div class="field-row"><label for="ctx-keep">Keep recent</label><input id="ctx-keep" type="number" min="1000" step="500" value="${keep}" /></div><div class="field-row"><label for="ctx-window">Window</label><input id="ctx-window" type="number" min="4096" step="1024" value="${settings.contextWindow ?? ""}" placeholder="${tokens(live.catalogWindow ?? window)} from catalog" /><button type="button" class="ghost-btn small" id="ctx-save">Save</button></div></details>`;
    bindMark(body.querySelector(".mark.auto"));
    body.querySelector("#ctx-save").addEventListener("click", () => save("Context policy saved"));
    body
      .querySelector("#auto-compact")
      .addEventListener("change", (event) => save(`Auto-compact ${event.target.checked ? "on" : "off"} · saved`));
    body.querySelector("#compact-now").addEventListener("click", async () => {
      await call("compact", { id: state.projectId, ...(state.chatId !== "main" ? { chatId: state.chatId } : {}) }).then(
        () => say("Compacting this chat…"),
        sayFail,
      );
    });
  };
  // The mark moves at once; the save waits for the owner to stop (pointer up, or a pause between keys).
  const bindMark = (mark) => {
    const bar = body.querySelector(".ctx-bar");
    const set = (pct) => {
      const next = Math.round(Math.max(10, Math.min(95, pct)));
      if (next === threshold) return;
      threshold = next;
      draw();
      body.querySelector(".mark.auto").focus();
      clearTimeout(saving);
      saving = setTimeout(() => save(`Auto-compaction at ${threshold}% · saved`), 450);
    };
    mark.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      mark.setPointerCapture(event.pointerId);
      const rect = bar.getBoundingClientRect();
      const move = (next) => {
        const pct = ((next.clientX - rect.left) / rect.width) * 100;
        mark.style.left = `${Math.max(10, Math.min(95, pct))}%`;
        mark.querySelector("span").textContent = `auto ${Math.round(Math.max(10, Math.min(95, pct)))}%`;
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
      set(threshold + (event.shiftKey ? 5 : 1) * (event.key === "ArrowLeft" ? -1 : 1));
    });
  };
  const save = async (message) => {
    if (!alive()) return;
    const override = Number(body.querySelector("#ctx-window").value),
      keepNext = Number(body.querySelector("#ctx-keep").value);
    await update(
      {
        context: {
          autoCompact: body.querySelector("#auto-compact").checked,
          thresholdPercent: threshold,
          keepRecentTokens: keepNext >= 1000 ? keepNext : keep,
          ...(override >= 4096 ? { contextWindow: override } : {}),
        },
      },
      message,
    ).catch(sayFail);
  };
  draw();
}

// ---------------------------------------------------------------------------------------------------------------- Model

/** profiles-set with the revision it read; a refusal (stale revision, unknown tier, locked tool) is shown and the section re-reads. */
async function setProfile(revision, patch, label) {
  try {
    await call("profiles-set", { projectId: state.projectId, revision, profile, patch });
    say(label);
    emit("profiles");
  } catch (error) {
    sayFail(error);
  }
  paint(true);
}
/** Per-million price, like the reference: "$4 in $20 out". */
const perM = (n) => (!Number.isFinite(n) ? "" : n === 0 ? "$0" : `$${n < 0.1 ? n.toFixed(3) : String(+n.toFixed(2))}`);
const priceLine = (item) =>
  Number.isFinite(item?.inputCost) ? `${perM(item.inputCost)} in ${perM(item.outputCost)} out` : "price unknown";

async function model(body, alive) {
  const [profiles, tiers] = await Promise.all([call("profiles-get", { projectId: state.projectId }), call("tiers-get")]);
  if (!alive()) return;
  const current = profiles.profiles[profile];
  const thinking = current.thinking ?? "medium";
  const catalog = new Map(tiers.catalog.map((item) => [item.ref, item]));
  const projectInfo = state.view?.project;
  const projectModel = (profile === "coordinator" ? null : projectInfo?.models?.[profile]) ?? projectInfo?.model ?? "";
  // A row: badge, NAME + letter, the models in fallback order; right: context and price of the model that would run, and a check.
  const row = ({ id, letter, name, models, on }) => {
    const lead = catalog.get(models.find((ref) => catalog.get(ref)?.available) ?? models[0]) ?? { ref: models[0] };
    return `<button type="button" role="radio" class="tier-row${on ? " on" : ""}" data-tier="${esc(id)}" aria-checked="${on}"><span class="tier-badge" aria-hidden="true">${esc(letter || "—")}</span><span class="tier-main"><span class="tier-title">${esc(name)}</span><span class="tier-chain mono">${
      models
        .map((ref, index) => {
          const item = catalog.get(ref);
          return `<span class="${item?.available === false ? "off" : ""}" title="${esc(ref)}${item?.available === false ? " (no credentials)" : ""}">${index ? "→ " : ""}${esc(shortModel(ref))}</span>`;
        })
        .join("") || `<span class="muted">no model</span>`
    }</span></span><span class="tier-cost mono"><span>${tokens(lead.contextWindow)} context</span><span>${esc(priceLine(lead))}</span></span><span class="tier-check" aria-hidden="true">${on ? "✓" : ""}</span></button>`;
  };
  const rows = [
    ...tiers.tiers.map((tier) =>
      row({ id: tier.id, letter: tier.letter, name: tier.name, models: tier.models, on: current.tier === tier.id }),
    ),
    row({ id: "", letter: "", name: "Project model (no tier)", models: projectModel ? [projectModel] : [], on: !current.tier }),
  ];
  body.innerHTML = `${line("Pick a tier and a thinking level for this profile.", "A tier is an ordered list of models. On a quota or rate limit, work moves to the next model of the tier, never back. Edit tiers under Model tiers (I).")}<div class="field-row"><span class="label">Thinking</span><div class="seg" role="radiogroup" aria-label="Thinking level">${THINKING.map((level) => `<button type="button" role="radio" data-thinking="${level}" aria-checked="${level === thinking}">${level}</button>`).join("")}</div><span class="grow"></span><span class="muted small">runs <code>${esc(current.effectiveModel ?? "no model")}</code></span></div><div class="tier-rows" role="radiogroup" aria-label="Tier">${rows.join("")}</div>`;
  body.addEventListener("click", async (event) => {
    const tier = event.target.closest("[data-tier]"),
      level = event.target.closest("[data-thinking]");
    if (level && level.dataset.thinking !== thinking)
      return void setProfile(
        profiles.revision,
        { thinking: level.dataset.thinking },
        `${label(profile)} thinking: ${level.dataset.thinking}`,
      );
    if (!tier || tier.getAttribute("aria-checked") === "true") return;
    if (tier.dataset.tier)
      return void setProfile(
        profiles.revision,
        { tier: tier.dataset.tier },
        `${label(profile)} on ${tier.querySelector(".tier-title").textContent.trim()}`,
      );
    // profiles-set merges its patch, so leaving a tier writes the whole profile without one through settings-update.
    const { effectiveModel: _, tier: __, ...rest } = current;
    try {
      await call("settings-update", {
        id: state.projectId,
        confirm: state.projectId,
        expectedRevision: profiles.revision,
        changes: { profiles: { [profile]: rest } },
      });
      say(`${label(profile)} on the project model`);
      emit("profiles");
    } catch (error) {
      sayFail(error);
    }
    paint();
  });
}
const label = (id) => id[0].toUpperCase() + id.slice(1);

// ---------------------------------------------------------------------------------------------------------------- Prompt

/** Blocks, editor and preview live in prompts.js; the profile tabs add the Host agent here only. */
async function prompt(body, alive) {
  const view = await promptSection(body, alive, { profile, say, sayFail });
  if (alive()) prompts = view;
}

// ---------------------------------------------------------------------------------------------------------------- Tools

async function tools(body, alive) {
  const result = await call("profile-tools", { projectId: state.projectId, profile });
  if (!alive()) return;
  const { groups } = result;
  let q = "",
    view = "title";
  const draw = () => {
    const match = (tool) => !q || `${tool.name} ${tool.description}`.toLowerCase().includes(q);
    body.innerHTML = `${line("What this profile is offered, grouped by source.", "Switching a tool off removes it from new turns of this profile. Locked groups hold the tools the role cannot work without.")}<div class="field-row"><input type="search" id="tool-search" placeholder="Search tools" aria-label="Search tools" value="${esc(q)}" /><div class="seg" role="tablist" aria-label="View">${["title", "description", "params"].map((item) => `<button type="button" role="tab" data-view="${item}" aria-selected="${view === item}">${item[0].toUpperCase() + item.slice(1)}</button>`).join("")}</div></div>${
      groups
        .map((group) => {
          const list = group.tools.filter(match);
          if (!list.length) return "";
          return `<section class="tool-group-card"><header><b>${esc(group.label)}</b><span class="badge">${esc(group.source)}</span>${group.locked ? `<span class="lock" aria-label="locked">🔒</span>` : ""}<span class="muted small">${list.filter((tool) => tool.enabled).length}/${list.length}</span></header><div class="tool-grid${view === "title" ? "" : " wide"}">${list
            .map(
              (tool) =>
                `<label class="tool-toggle" title="${esc(oneLine(tool.description))}"><input type="checkbox" data-tool-name="${esc(tool.name)}" ${tool.enabled ? "checked" : ""} ${group.locked ? "disabled" : ""} /><span class="mono">${esc(tool.name)}</span>${view === "description" ? `<span class="muted small">${esc(clip(tool.description, 160))}</span>` : ""}${view === "params" ? `<pre class="small">${esc(clip(JSON.stringify(tool.parameters ?? {}, null, 1), 600))}</pre>` : ""}</label>`,
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
    if (!box) return;
    const profiles = await call("profiles-get", { projectId: state.projectId }).catch(sayFail);
    if (!profiles || !alive()) return;
    const disabled = new Set(profiles.profiles[profile].tools?.disabled ?? []);
    box.checked ? disabled.delete(box.dataset.toolName) : disabled.add(box.dataset.toolName);
    await setProfile(
      profiles.revision,
      { tools: { disabled: [...disabled] } },
      `${box.dataset.toolName} ${box.checked ? "on" : "off"} for ${profile}`,
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------- Storage

const CLEANUP_ID = "workspace-cleanup";
async function storage(body, alive) {
  let usage = null,
    failure = null,
    outcome = null,
    cleaning = false;
  const measure = async () => {
    try {
      usage = await call("storage-usage", { id: state.projectId });
      failure = null;
    } catch (error) {
      failure = error.message;
    }
    if (alive()) draw();
  };
  const row = (item) =>
    `<tr data-row="${esc(item.id)}"><td>${esc(item.label)}</td><td class="right">${item.count ?? "–"}</td><td class="right">${item.bytes === null ? `<span class="muted">unknown</span>` : esc(size(item.bytes))}</td><td class="right">${item.reclaimableBytes === null ? "–" : esc(size(item.reclaimableBytes))}</td><td class="muted small">${esc(item.note ?? "")}</td></tr>`;
  const draw = () => {
    const rows = usage?.rows ?? [];
    const total = (key) => rows.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    body.innerHTML = `${line("What this project keeps on disk, and what the Workspace cleanup routine would free now.", "Sizes come from du; a worktree on a virtual mount is not measured. Clean up runs the Workspace cleanup routine now; each run is in its History under Automations.")}${
      usage
        ? `<table class="storage"><thead><tr><th>Kind</th><th class="right">Count</th><th class="right">Size</th><th class="right">Cleanup frees</th><th></th></tr></thead><tbody>${rows.map(row).join("")}</tbody><tfoot><tr><td>Total</td><td></td><td class="right">${esc(size(total("bytes")))}</td><td class="right">${esc(size(total("reclaimableBytes")))}</td><td class="muted small">Measured ${esc(ago(usage.measuredAt))}</td></tr></tfoot></table>`
        : failure
          ? `<p class="error-line">${esc(failure)}</p>`
          : `<p class="loading-line">Measuring…</p>`
    }<div class="row"><button type="button" class="primary small" data-storage-clean ${cleaning ? "disabled" : ""}>${cleaning ? "Cleaning up…" : "Clean up"}</button><button type="button" class="ghost-btn small" data-storage-measure ${cleaning ? "disabled" : ""}>Measure again</button></div>${outcome ? `<p class="storage-outcome ${outcome.ok ? "muted" : "error-line"}" role="status">${esc(outcome.text)}</p>` : ""}`;
  };
  draw();
  await measure();
  body.addEventListener("click", async (event) => {
    if (event.target.closest("[data-storage-measure]")) {
      usage = null;
      draw();
      return measure();
    }
    if (!event.target.closest("[data-storage-clean]") || cleaning) return;
    const runs = async () =>
      (await call("schedule-history", { id: state.projectId, kind: "intents" })).items.filter((item) => item.stableId === CLEANUP_ID);
    cleaning = true;
    outcome = null;
    draw();
    try {
      const before = (await runs()).length;
      await call("schedule-run", { id: state.projectId, scheduleId: CLEANUP_ID });
      let done = null;
      while (alive() && !done) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const items = await runs();
        if (items.length > before && items.at(-1).outcome !== null) done = items.at(-1);
      }
      if (done) outcome = { ok: done.outcome === "completed", text: done.summary || done.outcome };
    } catch (error) {
      outcome = { ok: false, text: error.message };
    }
    cleaning = false;
    if (!alive()) return;
    usage = null;
    draw();
    await measure();
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
  const calendar = record.kind === "calendar" ? record.rule : record.calendar;
  if (calendar?.kind === "daily") {
    const [h, m] = calendar.time.split(":");
    return `${Number(m)} ${Number(h)} * * *`;
  }
  if (calendar?.kind === "weekly") {
    const [h, m] = calendar.time.split(":");
    return `${Number(m)} ${Number(h)} * * ${calendar.days.join(",")}`;
  }
  if (record.everyMs && record.everyMs % 3600000 === 0) return `0 */${record.everyMs / 3600000} * * *`;
  if (record.everyMs) return `*/${Math.round(record.everyMs / 60000)} * * * *`;
  return "once";
}
function words(record) {
  const calendar = record.kind === "calendar" ? record.rule : record.calendar;
  if (calendar?.kind === "daily") return `Daily at ${calendar.time}`;
  if (calendar?.kind === "weekly")
    return `Weekly ${calendar.days.map((d) => "Sun Mon Tue Wed Thu Fri Sat".split(" ")[d]).join(", ")} at ${calendar.time}`;
  if (record.everyMs) return every(record.everyMs).replace(/^./, (c) => c.toUpperCase());
  return record.atMs ? `Once at ${new Date(record.atMs).toLocaleString()}` : "Once";
}
async function automations(body, alive) {
  const [schedules, auto] = await Promise.all([
    call("schedule-snapshot", { id: state.projectId }),
    call("automation-snapshot", { id: state.projectId }),
  ]);
  if (!alive()) return;
  let editing = null;
  const card = ({ kind, id, name, when, cron, text, on: enabled, last, target, record }) => {
    // Only prompt routines have a prompt to edit; the cleanup routine cannot be deleted, only turned off.
    const prompt = record && (record.action?.kind ?? "prompt") === "prompt",
      deletable = record && record.action?.kind !== "cleanup";
    if (record && editing === id)
      return `<article class="auto-card editing" data-kind="${kind}" data-id="${esc(id)}"><form data-auto-edit-form><div class="field-row"><label for="auto-name-${esc(id)}">Name</label><input id="auto-name-${esc(id)}" data-edit-name value="${esc(record.name ?? "")}" maxlength="100" placeholder="Schedule name" /></div><div class="field-row top"><label for="auto-text-${esc(id)}">Prompt</label><textarea id="auto-text-${esc(id)}" data-edit-text rows="3" maxlength="12000" required>${esc(record.text)}</textarea></div><div class="field-row"><label for="auto-minutes-${esc(id)}">Repeat every (minutes)</label><input id="auto-minutes-${esc(id)}" data-edit-minutes type="number" min="1" step="1" value="${record.everyMs ? record.everyMs / 60000 : ""}" placeholder="Once" /></div><div class="row"><button type="submit" class="primary small" data-auto-save>Save</button><button type="button" class="ghost-btn small" data-auto-cancel>Cancel</button></div></form></article>`;
    return `<article class="auto-card" data-kind="${kind}" data-id="${esc(id)}"><header><b>${esc(name)}</b><span class="grow"></span><label class="switch" aria-label="${esc(name)} on or off"><input type="checkbox" data-auto-toggle ${enabled ? "checked" : ""} /><span class="track" aria-hidden="true"></span></label></header><p class="auto-when">${esc(when)} <code class="small">${esc(cron)}</code>${target ? ` · <span class="muted">${esc(target)}</span>` : ""}</p>${text ? `<p class="auto-text">${esc(clip(text, 160))}</p>` : ""}<footer><span class="muted small">${last ? `Last run ${esc(ago(last))}` : "Not run yet"}</span><span class="grow"></span>${record ? `<button type="button" class="link-btn" data-auto-run>Run now</button>` : ""}${prompt ? `<button type="button" class="link-btn" data-auto-edit>Edit</button>` : ""}<button type="button" class="link-btn" data-history>History</button>${deletable ? `<button type="button" class="link-btn danger" data-auto-delete>Delete</button>` : ""}</footer></article>`;
  };
  const cleanupText = (settings) =>
    `Removes settled worktrees, workspace caches over ${settings.cacheCapGb} GB or unused for ${settings.unusedDays} days, ${settings.disposable.length ? `ignored ${settings.disposable.join(", ")} older than a day, ` : ""}and videos of Jobs approved or dismissed ${settings.videoDays} days ago.`;
  const chatName = (id) => (state.view?.chats ?? []).find((chat) => chat.id === id)?.title ?? id;
  const cards = () => [
    ...schedules.schedules.map((record) =>
      card({
        kind: "schedule",
        id: record.id,
        name: record.name || clip(record.text.split("\n")[0], 60) || record.id,
        when: words(record),
        cron: cronOf(record),
        text:
          record.action?.kind === "cleanup"
            ? cleanupText(record.action.settings)
            : record.action?.kind === "script"
              ? `$ ${record.action.command}`
              : record.text,
        on: record.enabled,
        last: record.lastRunAt ?? record.lastAtMs,
        record,
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
  const draw = () => {
    body.innerHTML = `${line("Schedules, PR following and webhooks for this project.", "Run now executes even while off. Edit is revision-checked. Delete asks once more; Undo restores it within ten minutes.")}<div class="auto-grid">${cards().join("")}</div>`;
  };
  draw();
  const apply = async (kind, id, enabled) => {
    if (kind === "schedule") return call("schedule-enable", { id: state.projectId, scheduleId: id, enabled });
    else
      return call("automation-update", {
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
      const changed = await apply(node.dataset.kind, node.dataset.id, enabled);
      const record = schedules.schedules.find((item) => item.id === node.dataset.id);
      if (record && changed) Object.assign(record, changed);
      toast(`${node.querySelector("b").textContent} ${enabled ? "on" : "off"}.`, {
        action: "Undo",
        onAction: async () => {
          await apply(node.dataset.kind, node.dataset.id, !enabled).catch(sayFail);
          if (alive()) paint();
        },
      });
    } catch (error) {
      toggle.checked = !enabled;
      sayFail(error);
    }
  });
  body.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-auto-edit-form]");
    if (!form) return;
    event.preventDefault();
    const node = form.closest(".auto-card"),
      record = schedules.schedules.find((item) => item.id === node.dataset.id);
    if (!record) return;
    const minutes = Number(form.querySelector("[data-edit-minutes]").value),
      cadence = minutes > 0 ? Math.round(minutes) * 60000 : null;
    const patch = {
      id: state.projectId,
      scheduleId: record.id,
      revision: record.revision,
      name: form.querySelector("[data-edit-name]").value.trim() || null,
      text: form.querySelector("[data-edit-text]").value.trim(),
    };
    if (cadence !== (record.everyMs ?? null))
      patch.schedule = {
        atMs: record.nextAtMs ?? record.atMs ?? Date.now() + (cadence ?? 3600000),
        ...(cadence ? { everyMs: cadence } : {}),
      };
    try {
      const saved = await call("schedule-update", patch);
      Object.assign(record, saved);
      editing = null;
      say("Schedule saved.");
      draw();
    } catch (error) {
      sayFail(error);
    }
  });
  body.addEventListener("click", async (event) => {
    const node = event.target.closest(".auto-card"),
      record = node?.dataset.kind === "schedule" ? schedules.schedules.find((item) => item.id === node.dataset.id) : null;
    if (event.target.closest("[data-auto-cancel]")) {
      editing = null;
      return draw();
    }
    if (event.target.closest("[data-auto-edit]") && record) {
      editing = record.id;
      draw();
      body.querySelector("[data-edit-name]")?.focus();
      return;
    }
    const run = event.target.closest("[data-auto-run]");
    if (run && record) {
      run.disabled = true;
      try {
        await call("schedule-run", { id: state.projectId, scheduleId: record.id });
        record.lastRunAt = new Date().toISOString();
        say("Schedule ran. History updated.");
        if (alive()) draw();
      } catch (error) {
        run.disabled = false;
        sayFail(error);
      }
      return;
    }
    const remove = event.target.closest("[data-auto-delete]");
    if (remove && record) {
      if (remove.dataset.armed !== "1") {
        remove.dataset.armed = "1";
        remove.textContent = "Confirm delete";
        return;
      }
      remove.disabled = true;
      try {
        await call("schedule-delete", { id: state.projectId, scheduleId: record.id, revision: record.revision });
        schedules.schedules = schedules.schedules.filter((item) => item.id !== record.id);
        editing = null;
        draw();
        toast(`Deleted ${record.name ?? "schedule"}.`, {
          action: "Undo",
          ms: 10000,
          onAction: async () => {
            try {
              const restored = await call("schedule-restore", { id: state.projectId, scheduleId: record.id });
              schedules.schedules.push(restored);
              if (alive()) {
                say("Schedule restored.");
                draw();
              }
            } catch (error) {
              sayFail(error);
            }
          },
        });
      } catch (error) {
        remove.disabled = false;
        sayFail(error);
      }
      return;
    }
    if (!event.target.closest("[data-history]")) return;
    const history = await call("schedule-history", { id: state.projectId, kind: "intents", limit: 10 }).catch(sayFail);
    if (!history || !alive()) return;
    say(`${history.items?.length ?? history.total ?? 0} recent runs. Full history in the CLI for now.`);
  });
}

// ---------------------------------------------------------------------------------------------------------------- Host

async function tiersSection(body, alive) {
  const data = await call("tiers-get");
  if (!alive()) return;
  const catalog = new Map(data.catalog.map((item) => [item.ref, item]));
  let tiers = structuredClone(data.tiers),
    search = { t: -1, q: "" };
  const dirty = () => JSON.stringify(tiers) !== JSON.stringify(data.tiers);
  const price = (item) =>
    `${tokens(item.contextWindow)}${Number.isFinite(item.inputCost) ? ` · ${usd(item.inputCost)}/${usd(item.outputCost)} per M` : ""}`;
  const matches = (tier) => {
    const q = search.q.toLowerCase().trim();
    if (!q) return [];
    return data.catalog
      .filter((item) => item.available && !tier.models.includes(item.ref) && `${item.ref} ${item.name}`.toLowerCase().includes(q))
      .slice(0, 8);
  };
  const draw = () => {
    const changed = dirty();
    body.innerHTML = `${line("Ordered models per tier; the first is preferred, the rest are the fallback order.", "Drag a model or use the arrows. On a quota or rate limit, work moves down the list and never back. A model without credentials shows struck through. A tier a project uses cannot be removed.")}${tiers
      .map((tier, t) => {
        const found = search.t === t ? matches(tier) : [];
        return `<section class="tier-edit" data-t="${t}"><header><input class="tier-letter-input mono" data-field="letter" value="${esc(tier.letter)}" maxlength="2" aria-label="Letter of ${esc(tier.name)}" /><input class="tier-name-input" data-field="name" value="${esc(tier.name)}" maxlength="40" aria-label="Name of tier ${esc(tier.id)}" /><span class="muted small mono">${esc(tier.id)}</span><span class="grow"></span><button type="button" class="link-btn small" data-remove-tier aria-label="Remove tier ${esc(tier.name)}">Remove tier</button></header><ol>${tier.models
          .map((ref, m) => {
            const item = catalog.get(ref) ?? { ref };
            return `<li draggable="true" data-m="${m}" class="${item.available === false ? "off" : ""}"><span class="grip" aria-hidden="true">⋮⋮</span><span class="mono">${esc(ref)}</span>${m ? "" : `<span class="badge">preferred</span>`}<span class="muted small">${price(item)}</span><span class="grow"></span><button type="button" class="icon-btn small" data-move="-1" aria-label="Move ${esc(ref)} up" ${m ? "" : "disabled"}>↑</button><button type="button" class="icon-btn small" data-move="1" aria-label="Move ${esc(ref)} down" ${m < tier.models.length - 1 ? "" : "disabled"}>↓</button><button type="button" class="icon-btn small" data-remove aria-label="Remove ${esc(ref)}">✕</button></li>`;
          })
          .join(
            "",
          )}</ol>${tier.models.length ? "" : `<p class="muted small">Add at least one model before saving.</p>`}<div class="tier-add"><input type="search" data-add-search placeholder="Add model: search ${data.catalog.filter((item) => item.available).length} with credentials" aria-label="Add model to ${esc(tier.name)}" value="${search.t === t ? esc(search.q) : ""}" />${found.length ? `<ul class="tier-results" role="listbox">${found.map((item) => `<li><button type="button" role="option" data-add="${esc(item.ref)}"><span class="mono">${esc(item.ref)}</span><span class="muted small">${price(item)}</span></button></li>`).join("")}</ul>` : search.t === t && search.q.trim() ? `<p class="muted small">No model with credentials matches.</p>` : ""}</div></section>`;
      })
      .join(
        "",
      )}<div class="row tier-actions"><button type="button" class="ghost-btn small" id="tier-new">+ New tier</button><span class="grow"></span>${changed ? `<span class="muted small">Unsaved changes</span><button type="button" class="ghost-btn small" id="tiers-revert">Revert</button><button type="button" class="primary small" id="tiers-save">Save tiers</button>` : ""}</div>`;
  };
  draw();
  const focusSearch = (t) => {
    const input = body.querySelector(`[data-t="${t}"] [data-add-search]`);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  };
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
  body.addEventListener("input", (event) => {
    const t = Number(event.target.closest("[data-t]")?.dataset.t ?? -1);
    if (event.target.matches("[data-add-search]")) {
      search = { t, q: event.target.value };
      draw();
      focusSearch(t);
    } else if (event.target.dataset.field) tiers[t][event.target.dataset.field] = event.target.value;
  });
  // Name and letter edits redraw on blur so the Save row appears without stealing focus while typing.
  body.addEventListener("change", (event) => event.target.dataset.field && draw());
  body.addEventListener("click", async (event) => {
    const section = event.target.closest("[data-t]"),
      t = section ? Number(section.dataset.t) : -1;
    const row = event.target.closest("li[data-m]"),
      m = row ? Number(row.dataset.m) : -1;
    const move = event.target.closest("[data-move]");
    if (move) {
      const list = tiers[t].models,
        to = m + Number(move.dataset.move);
      if (to < 0 || to >= list.length) return;
      [list[m], list[to]] = [list[to], list[m]];
      draw();
      (
        body.querySelector(`[data-t="${t}"] li[data-m="${to}"] [data-move="${move.dataset.move}"]:not([disabled])`) ??
        body.querySelector(`[data-t="${t}"] li[data-m="${to}"] [data-move]:not([disabled])`)
      )?.focus();
      return;
    }
    if (event.target.closest("[data-remove]")) {
      tiers[t].models.splice(m, 1);
      return draw();
    }
    const add = event.target.closest("[data-add]");
    if (add) {
      tiers[t].models.push(add.dataset.add);
      search = { t, q: "" };
      draw();
      return focusSearch(t);
    }
    if (event.target.closest("[data-remove-tier]")) {
      tiers.splice(t, 1);
      return draw();
    }
    if (event.target.closest("#tier-new")) {
      const taken = new Set(tiers.map((tier) => tier.id));
      let n = tiers.length + 1;
      while (taken.has(`tier-${n}`)) n++;
      tiers.push({ id: `tier-${n}`, name: `Tier ${n}`, letter: String.fromCharCode(64 + Math.min(n, 26)), models: [] });
      draw();
      return focusSearch(tiers.length - 1);
    }
    if (event.target.closest("#tiers-revert")) {
      tiers = structuredClone(data.tiers);
      return draw();
    }
    if (event.target.closest("#tiers-save")) {
      try {
        const result = await call("tiers-set", { revision: data.revision, tiers });
        if (!alive()) return;
        data.revision = result.revision;
        data.tiers = structuredClone(result.tiers);
        tiers = structuredClone(result.tiers);
        say("Tiers saved.");
        emit("tiers");
        draw();
      } catch (error) {
        // Refusals (stale revision, empty tier, a tier in use, unknown model) keep the edits on screen.
        sayFail(error);
      }
    }
  });
}
const THEMES = [
  { id: "claude", label: "Claude", hint: "Warm charcoal (default)" },
  { id: "midnight", label: "Midnight", hint: "Deep blue, cooler accents" },
  { id: "light", label: "Light", hint: "Paper and ink" },
  { id: "system", label: "System", hint: "Claude or Light with the OS" },
];
const FONTS = [
  { id: "jetbrains-mono", label: "JetBrains Mono", hint: "Bundled · default" },
  { id: "system-sans", label: "System sans", hint: "Your device's UI font" },
  { id: "system-mono", label: "System mono", hint: "Your device's mono font" },
];
function theme(body) {
  const current = state.ui?.theme ?? "claude",
    font = state.ui?.font ?? "jetbrains-mono";
  body.innerHTML = `${line("Same in every browser; the Host agent can change it too.")}<div class="theme-grid" role="radiogroup" aria-label="Theme">${THEMES.map((item) => `<button type="button" role="radio" class="theme-card" data-theme-option="${item.id}" aria-checked="${item.id === current}"><span class="swatch sw-${item.id}" aria-hidden="true"><i></i><i></i><i></i></span><b>${item.label}</b><span class="muted small">${item.hint}</span></button>`).join("")}</div><div class="font-picker"><span class="label" id="font-label">Font</span><div class="font-options" role="radiogroup" aria-labelledby="font-label">${FONTS.map((item) => `<button type="button" role="radio" data-font-option="${item.id}" aria-checked="${item.id === font}"><span>${item.label}</span><span class="muted small">${item.hint}</span></button>`).join("")}</div></div>`;
  body.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-theme-option]"),
      fontPick = event.target.closest("[data-font-option]");
    if (pick) {
      void setUi({ theme: pick.dataset.themeOption }).then((ok) => ok && say(`Theme: ${pick.querySelector("b").textContent}`));
      body.querySelectorAll("[data-theme-option]").forEach((node) => node.setAttribute("aria-checked", String(node === pick)));
    }
    if (fontPick) {
      const choice = FONTS.find((item) => item.id === fontPick.dataset.fontOption);
      void setUi({ font: fontPick.dataset.fontOption }).then((ok) => ok && say(`Font: ${choice.label}`));
      body.querySelectorAll("[data-font-option]").forEach((node) => node.setAttribute("aria-checked", String(node === fontPick)));
    }
  });
}
function animations(body) {
  const current = state.ui?.animations ?? "subtle",
    reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  body.innerHTML = `${line("Rows slide in, working agents shimmer, panels glide.", "Off removes all motion. Your system's reduced-motion setting always wins.")}<div class="seg big" role="radiogroup" aria-label="Animations">${["off", "subtle", "full"].map((level) => `<button type="button" role="radio" data-motion="${level}" aria-checked="${level === current}">${level}</button>`).join("")}</div>${reduced ? `<p class="muted small">Reduced motion is on in your system settings, so motion stays off.</p>` : ""}`;
  body.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-motion]");
    if (!pick) return;
    void setUi({ animations: pick.dataset.motion }).then((ok) => ok && say(`Animations: ${pick.dataset.motion}`));
    body.querySelectorAll("[data-motion]").forEach((node) => node.setAttribute("aria-checked", String(node === pick)));
  });
}
/** Status line: show the bar, and order and show its built-in items. Keyboard: Tab to an item's ↑/↓ or its checkbox. */
function statusLine(body, alive) {
  const label = (id) => STATUS_ITEMS.find((item) => item.id === id)?.label ?? id;
  const current = () => state.ui.statusItems;
  const shape = () => JSON.stringify([state.ui.statusLine, current()]);
  let drawn = "";
  const draw = (focus) => {
    const items = current();
    drawn = shape();
    body.innerHTML = `${line("Order the items of the bottom status line and choose which ones show.", "Same in every browser; the Host agent can change it too. On a narrow screen the bar scrolls sideways when the shown items do not fit.")}<div class="field-row"><label class="switch"><input type="checkbox" id="statusline-toggle" ${state.ui.statusLine ? "checked" : ""}/> Show the status line</label></div><ol class="sl-order" aria-label="Status line items" data-bar="${state.ui.statusLine ? "on" : "off"}">${items
      .map((item, index) => {
        const meta = STATUS_ITEMS.find((entry) => entry.id === item.id) ?? { label: item.id, hint: "" };
        return `<li data-sl-item="${esc(item.id)}" data-enabled="${item.enabled ? "1" : "0"}"><span class="sl-pos mono" aria-hidden="true">${index + 1}</span><label class="switch"><input type="checkbox" data-sl-toggle="${esc(item.id)}" ${item.enabled ? "checked" : ""} aria-describedby="sl-hint-${esc(item.id)}"/><b>${esc(meta.label)}</b></label><span class="muted small one-line" id="sl-hint-${esc(item.id)}">${esc(meta.hint)}</span><span class="sl-state small">${item.enabled ? "" : "hidden"}</span><span class="sl-moves"><button type="button" class="icon-btn small" data-sl-move="up" data-id="${esc(item.id)}" aria-label="Move ${esc(meta.label)} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="icon-btn small" data-sl-move="down" data-id="${esc(item.id)}" aria-label="Move ${esc(meta.label)} down" ${index === items.length - 1 ? "disabled" : ""}>↓</button></span></li>`;
      })
      .join(
        "",
      )}</ol><p class="muted small"><button type="button" class="ghost-btn small" data-sl-reset>Restore the default order</button></p>`;
    if (!focus) return;
    // Keep the keyboard on the item that moved; at an end the other arrow takes focus.
    const row = body.querySelector(`[data-sl-item="${CSS.escape(focus.id)}"]`);
    const target = row?.querySelector(focus.selector);
    (target && !target.disabled ? target : row?.querySelector("[data-sl-move]:not([disabled])"))?.focus();
  };
  const save = (statusItems, message, focus) => {
    const done = setUi({ statusItems });
    draw(focus);
    void done.then((ok) => (ok ? say(message) : alive() && draw(focus)));
  };
  draw();
  // A change from another browser or the Host agent redraws this section while it is open. The host's echo of this page's own
  // change does not: a redraw under a click in progress would drop that click.
  const off = on("ui", () => {
    if (!alive()) return off();
    if (shape() === drawn) return;
    const active = document.activeElement?.closest?.("[data-sl-item]");
    const selector = document.activeElement?.matches?.("[data-sl-move]")
      ? `[data-sl-move="${document.activeElement.dataset.slMove}"]`
      : document.activeElement?.matches?.("[data-sl-toggle]")
        ? "[data-sl-toggle]"
        : null;
    draw(active && selector ? { id: active.dataset.slItem, selector } : null);
  });
  body.addEventListener("change", (event) => {
    if (event.target.id === "statusline-toggle") {
      const shown = event.target.checked;
      void setUi({ statusLine: shown }).then((ok) => ok && say(`Status line ${shown ? "shown" : "hidden"}`));
      return;
    }
    const toggle = event.target.closest("[data-sl-toggle]");
    if (!toggle) return;
    const id = toggle.dataset.slToggle;
    const next = current().map((item) => (item.id === id ? { ...item, enabled: toggle.checked } : item));
    save(next, `${label(id)} ${toggle.checked ? "shown" : "hidden"}`, { id, selector: "[data-sl-toggle]" });
  });
  body.addEventListener("click", (event) => {
    if (event.target.closest("[data-sl-reset]")) {
      const enabled = new Map(current().map((item) => [item.id, item.enabled]));
      save(
        STATUS_ITEMS.map(({ id }) => ({ id, enabled: enabled.get(id) ?? true })),
        "Default order restored",
      );
      return;
    }
    const move = event.target.closest("[data-sl-move]");
    if (!move || move.disabled) return;
    const items = [...current()],
      from = items.findIndex((item) => item.id === move.dataset.id),
      to = from + (move.dataset.slMove === "up" ? -1 : 1);
    if (from < 0 || to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to], items[from]];
    save(items, `${label(move.dataset.id)} moved ${move.dataset.slMove} to ${to + 1}`, {
      id: move.dataset.id,
      selector: `[data-sl-move="${move.dataset.slMove}"]`,
    });
  });
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
    if (pressed && pressed !== DEFAULTS[edit.dataset.rebind]) {
      if (await setUi({ hotkeys: { ...(state.ui?.hotkeys ?? {}), [edit.dataset.rebind]: pressed } })) say(`Bound to ${display(pressed)}`);
    } else if (pressed) {
      const next = { ...(state.ui?.hotkeys ?? {}) };
      delete next[edit.dataset.rebind];
      await setUi({ hotkeys: next });
    }
    draw();
    body.querySelector(`[data-rebind="${edit.dataset.rebind}"]`)?.focus();
  });
}
/** Browser alerts, and the host's one Telegram bot (scripts/telegram-failures.md 43-45). The token goes in once and never comes back;
 * pairing finished in Telegram reaches this page on host topic `telegram`, so nothing polls. */
async function notifications(body, alive) {
  let telegram = await call("telegram-snapshot").catch((error) => ({ error: error.message }));
  if (!alive()) return;
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  body.innerHTML = `${line("Browser alerts and Telegram.", "Browser alerts are per browser. One Telegram bot serves this host: it sends questions with answer buttons, approvals, results and errors, and your text goes to the chat picked with /projects and /chats.")}<div class="field-row"><span class="label">Browser</span><span class="badge">${esc(permission)}</span>${permission === "default" ? `<button type="button" class="ghost-btn small" id="notify-ask">Allow</button>` : ""}</div><div id="telegram"></div>`;
  body.querySelector("#notify-ask")?.addEventListener("click", async () => {
    await Notification.requestPermission();
    if (alive()) paint();
  });
  const box = body.querySelector("#telegram");
  let problem = "",
    armed = false,
    busy = false;
  const draw = () => {
    const t = telegram,
      input = box.querySelector("#telegram-token"),
      typed = input?.value ?? "",
      active = box.contains(document.activeElement) ? document.activeElement : null,
      focus =
        active?.id === "telegram-token"
          ? "#telegram-token"
          : active?.dataset.telegramAction
            ? `[data-telegram-action="${active.dataset.telegramAction}"]`
            : null;
    const bot = t.botUsername ? `@${t.botUsername}` : "the bot";
    const button = (action, label, tone = "ghost-btn") =>
      `<button type="button" class="${tone} small" data-telegram-${action} data-telegram-action="${action}"${busy ? ` aria-disabled="true"` : ""}>${label}</button>`;
    box.innerHTML = t.error
      ? `<p class="error-line small" role="alert">Telegram: ${esc(t.error)}</p>`
      : `<div class="field-row"><label class="label" for="telegram-token">Telegram</label><input type="password" id="telegram-token" autocomplete="off" spellcheck="false" aria-label="Telegram bot token" placeholder="${t.configured ? "Saved. Paste a new token to replace it" : "Bot token from @BotFather"}" />${button("save", t.configured ? "Replace token" : "Save token")}</div><div class="field-row"><span class="label">Bot</span><span class="badge ${t.configured ? "t-ready" : ""}">${t.configured ? esc(bot) : "not set up"}</span></div><div class="field-row"><span class="label">Owner chat</span><span class="badge ${t.paired ? "t-ready" : ""}">${t.paired ? `paired with ${esc(t.owner)}` : "not paired"}</span></div>${t.configured ? `<div class="field-row"><span class="label">Text goes to</span><span class="small">${t.route?.name ? esc(t.route.name) : "nothing picked (use /projects in Telegram)"}</span></div><div class="field-row"><span class="label">Polling</span><span class="small">${t.polling ? `on${t.lastPollAt ? ` · ${esc(ago(t.lastPollAt))}` : ""}` : "off"}</span></div>` : ""}${t.lastError ? `<p class="error-line small">${esc(t.lastError)}</p>` : ""}${problem ? `<p class="error-line small" role="alert" data-telegram-error>${esc(problem)}</p>` : ""}${t.pairing ? `<p class="small" data-telegram-code>Send <code>/pair ${esc(t.pairing.code)}</code> to ${esc(bot)} in a private chat before ${esc(new Date(t.pairing.expiresAt).toLocaleTimeString())}. Only that chat will be heard.</p>` : ""}${t.configured ? `<div class="field-row">${button("pair", t.pairing ? "New code" : t.paired ? "Pair another chat" : "Pair my chat")}${t.paired ? button("unpair", "Unpair") : ""}${button("remove", armed ? "Confirm: remove bot" : "Remove bot", armed ? "ghost-btn danger" : "ghost-btn")}</div>` : ""}<p class="muted small">The token is kept in a private file on this machine and never shown again.</p>`;
    const next = box.querySelector("#telegram-token");
    if (next) next.value = typed;
    if (focus) box.querySelector(focus)?.focus();
  };
  const act = async (input, cleared) => {
    if (busy) return;
    busy = true;
    draw();
    try {
      telegram = await call(input.action, input);
      problem = "";
    } catch (error) {
      problem = error.message || "The host did not answer";
    }
    busy = false;
    if (cleared) cleared();
    if (alive()) draw();
  };
  draw();
  box.addEventListener("click", (event) => {
    const action = event.target.closest("[data-telegram-action]")?.dataset.telegramAction;
    if (!action) return;
    if (action === "save") {
      const input = box.querySelector("#telegram-token"),
        token = input.value.trim();
      // The field is emptied before the call, so the token never sits in the page after Save.
      input.value = "";
      if (!token) {
        problem = "Paste the bot token first";
        return draw();
      }
      void act({ action: "telegram-token", token });
    } else if (action === "pair") void act({ action: "telegram-pair" });
    else if (action === "unpair") void act({ action: "telegram-unpair" });
    else if (action === "remove") {
      if (!armed) {
        armed = true;
        draw();
        setTimeout(() => {
          if (armed && alive()) {
            armed = false;
            draw();
          }
        }, 6000);
        return;
      }
      armed = false;
      void act({ action: "telegram-remove", confirm: "remove" });
    }
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.id === "telegram-token") box.querySelector("[data-telegram-save]").click();
  });
  const off = on("telegram", async () => {
    if (!alive()) return off();
    const fresh = await call("telegram-snapshot").catch(() => null);
    if (!alive()) return off();
    if (fresh) telegram = fresh;
    draw();
  });
}
const RELAY = { off: "off", connecting: "connecting…", connected: "connected", error: "unreachable" };
/** Remote devices (scripts/remote-settings-failures.md R1-R10). Pairing, rename and revoke happen only on this machine (src/web.ts
 * LOCAL_ONLY); a paired device sees the list. Status, devices and pairing changes arrive on host topic `remote`, so nothing polls. */
async function remote(body, alive) {
  // The relay bootstrap labels a page it serves with its host (relay/bootstrap/host-page.js); a local page has no label.
  const local = document.documentElement.dataset.remoteHost === undefined;
  let status = {},
    devices = [],
    pairing = null,
    problem = "",
    renaming = null,
    armed = null,
    busy = false;
  const read = async () => {
    try {
      status = await call("remote-status");
      devices = status.enabled ? (await call("remote-devices")).filter((device) => !device.revokedAt) : [];
    } catch (error) {
      status = { error: error.message };
    }
    if (!status.pairing) pairing = null;
  };
  await read();
  if (!alive()) return;
  body.innerHTML = `${line("Reach this host from your phone through the relay.", "Each device pairs once with a one-time QR code or link from this machine. A revoked device is cut off at once.")}<div id="remote-access"></div>`;
  const box = body.querySelector("#remote-access");
  const button = (attr, label, tone = "ghost-btn", extra = "") =>
    `<button type="button" class="${tone} small" ${attr}${extra}${busy ? ` aria-disabled="true"` : ""}>${label}</button>`;
  const qr = () =>
    // Only a plain SVG from the host's QR encoder is drawn.
    pairing && /^<svg[\s>]/.test(pairing.qrSvg) && !/<script|\bon\w+=|href=/i.test(pairing.qrSvg) ? pairing.qrSvg : "";
  const deviceRow = (device) => {
    const seen = `paired ${esc(ago(device.pairedAt))} · seen ${device.lastSeenAt ? esc(ago(device.lastSeenAt)) : "never"}${device.push ? " · notifications on" : ""}`;
    const name =
      renaming === device.id
        ? `<input id="remote-rename" maxlength="80" value="${esc(device.name)}" aria-label="Device name" />${button(`data-remote-rename-save="${esc(device.id)}"`, "Save")}${button("data-remote-rename-cancel", "Cancel")}`
        : `<b class="remote-name">${esc(device.name)}</b>`;
    const actions =
      local && renaming !== device.id
        ? `${button(`data-remote-rename="${esc(device.id)}"`, "Rename")}${button(`data-remote-revoke="${esc(device.id)}"`, armed === device.id ? "Revoke now" : "Revoke", armed === device.id ? "ghost-btn danger" : "ghost-btn")}`
        : "";
    return `<div class="field-row remote-device" data-remote-device="${esc(device.id)}"><span class="dot${device.online ? " online" : ""}" role="img" aria-label="${device.online ? "Connected now" : "Not connected"}"></span>${name}<span class="muted small">${seen}</span>${actions}</div>`;
  };
  const draw = () => {
    const typed = box.querySelector("#remote-rename")?.value,
      active = box.contains(document.activeElement) ? document.activeElement : null,
      focus =
        active?.id === "remote-rename"
          ? "#remote-rename"
          : active?.dataset.remoteAction
            ? `[data-remote-action="${active.dataset.remoteAction}"]`
            : null;
    const state = status.error ? "unknown" : status.enabled ? (status.connection ?? "off") : "off";
    const error = problem ? `<p class="error-line small" role="alert" data-remote-error>${esc(problem)}</p>` : "";
    if (status.error || !status.enabled) {
      box.innerHTML = `<div class="field-row"><span class="label">Relay</span><span class="badge" data-remote-state="${state}">${status.error ? "unknown" : "off"}</span></div>${status.error ? `<p class="error-line small" role="alert">${esc(status.error)}</p>` : `<p class="small">Off for this host. To turn it on, deploy the relay (<code>relay/deploy/README.md</code>), then run <code>npm run projects -- remote enable https://relay.&lt;your-domain&gt;</code> on this Mac.</p>`}${error}`;
      return;
    }
    const pair = pairing
      ? `<div class="remote-pair" data-remote-pairing>${qr() ? `<div class="remote-qr" data-remote-qr role="img" aria-label="Pairing QR code">${qr()}</div>` : ""}<div class="remote-pair-text"><p class="small">Scan with the device's camera, or open the link on it. It works once, until ${esc(new Date(pairing.expiresAt).toLocaleTimeString())}.</p><code class="path" data-remote-link>${esc(pairing.link)}</code><div class="field-row">${button(`data-remote-copy data-remote-action="copy"`, "Copy link")}${button(`data-remote-pair-cancel data-remote-action="cancel"`, "Cancel")}</div></div></div>`
      : local
        ? `<div class="field-row">${button(`data-remote-pair data-remote-action="pair"`, "Pair a device", "ghost-btn")}</div>`
        : `<p class="small muted">Pair, rename and revoke devices in the inbox on this host.</p>`;
    box.innerHTML = `<div class="field-row"><span class="label">Relay</span><span class="badge ${state === "connected" ? "t-ready" : state === "error" ? "t-needs" : ""}" data-remote-state="${esc(state)}">${esc(RELAY[state] ?? state)}</span><code class="path">${esc(status.relay ?? "")}</code></div><div class="field-row"><span class="label">Host</span><span>${esc(status.hostName ?? "")}</span><code class="path muted">${esc(status.hostId ?? "")}</code></div><div class="field-row"><span class="label">Fingerprint</span><code class="path">${esc(status.fingerprint ?? "unknown")}</code></div>${status.lastError && state !== "connected" ? `<p class="error-line small">${esc(status.lastError)}</p>` : ""}${pair}${error}<p class="remote-heading">Devices</p>${devices.length ? devices.map(deviceRow).join("") : `<p class="small muted">No paired devices.</p>`}<p class="muted small">Compare the fingerprint with the one your phone shows when the app warns that it changed.</p>`;
    const input = box.querySelector("#remote-rename");
    if (input && typed !== undefined) input.value = typed;
    if (input && (focus === "#remote-rename" || typed === undefined)) input.focus();
    else if (focus) box.querySelector(focus)?.focus();
  };
  const act = async (input) => {
    if (busy) return null;
    busy = true;
    draw();
    let answer = null;
    try {
      answer = await call(input.action, input);
      problem = "";
    } catch (error) {
      problem = error.message || "The host did not answer";
    }
    busy = false;
    if (!alive()) return null;
    await read();
    if (alive()) draw();
    return answer;
  };
  const stopRenaming = () => {
    if (!renaming) return false;
    renaming = null;
    problem = "";
    draw();
    return true;
  };
  const save = async (id) => {
    const name = box.querySelector("#remote-rename")?.value.trim() ?? "";
    if (!name) {
      problem = "Name the device first";
      return draw();
    }
    renaming = null;
    await act({ action: "remote-rename", deviceId: id, name });
  };
  back = stopRenaming; // Esc in the rename field cancels it and keeps Settings open
  draw();
  box.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target || busy) return;
    const data = target.dataset;
    if ("remotePair" in data) {
      const started = await act({ action: "remote-pair-start" });
      if (started && alive()) {
        pairing = started;
        draw();
      }
    } else if ("remotePairCancel" in data) {
      pairing = null;
      await act({ action: "remote-pair-cancel" });
    } else if ("remoteCopy" in data && pairing) {
      await navigator.clipboard.writeText(pairing.link).then(
        () => toast("Pairing link copied. It works once."),
        () => toast("Copy failed; select the link instead."),
      );
    } else if (data.remoteRename) {
      renaming = data.remoteRename;
      armed = null;
      problem = "";
      draw();
    } else if ("remoteRenameCancel" in data) stopRenaming();
    else if (data.remoteRenameSave) await save(data.remoteRenameSave);
    else if (data.remoteRevoke) {
      const id = data.remoteRevoke;
      if (armed !== id) {
        armed = id;
        draw();
        setTimeout(() => {
          if (armed === id && alive()) {
            armed = null;
            draw();
          }
        }, 6000);
        return;
      }
      armed = null;
      if (await act({ action: "remote-revoke", deviceId: id, confirm: id })) toast("Device revoked.");
    }
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.id === "remote-rename" && renaming) {
      event.preventDefault();
      void save(renaming);
    }
  });
  const off = on("remote", async () => {
    if (!alive()) return off();
    await read();
    if (alive()) draw();
  });
}
async function deploy(body, alive) {
  const snap = await call("deploy-snapshot").catch((error) => ({ error: error.message }));
  if (!alive()) return;
  body.innerHTML = `${line("Self-deploys of pi-prjcts, also every night in the window.", "A deploy does not wait for idle projects: running tool calls get 10 s, then every agent continues after the restart.")}<div class="field-row"><span class="label">Window</span><span class="mono">${esc(snap.settings ? `${snap.settings.startHour}:00–${snap.settings.endHour}:00${snap.settings.idle ? " · nightly" : ""}${snap.settings.branch ? ` · follows origin/${snap.settings.branch}` : ""}` : (snap.error ?? ""))}</span><span class="badge ${snap.running ? "t-work" : ""}">${snap.running ? "deploying" : "idle"}</span></div>`;
}
/** Cursor signs in through the host (PKCE on Cursor's own page); offered while Cursor has no fresh reading or the sign-in failed. */
function cursorConnect(item) {
  const connect = item.connect;
  if (!connect) return "";
  if (connect.state === "waiting")
    return `<span class="small" data-cursor-waiting>Waiting for you to sign in. <a href="${esc(connect.loginUrl)}" target="_blank" rel="noopener noreferrer" data-cursor-login>Open the Cursor sign-in page</a></span>`;
  if (item.status === "ok" && !item.reason && connect.state !== "failed") return "";
  return `${connect.error ? `<span class="error-line small">${esc(connect.error)}</span>` : ""}<button type="button" class="ghost-btn small" data-cursor-connect>Connect Cursor</button>`;
}
/** Same readings and refresh as the status line (web/limits.js): opening this section reads, only Refresh asks the providers.
 * Each row's switch shows or hides that provider in the status line; hidden rows stay so they can be shown again. */
async function providers(body, alive) {
  await loadLimits();
  if (!alive()) return;
  const draw = () => {
    const busy = state.limitsRefreshing;
    body.innerHTML = `${line("Subscriptions and their limits.", "Sign in from the CLI with /login; connect Cursor here. Limits update only when you refresh them. The switch chooses which providers the status line and Telegram /status show.")}<div class="field-row"><button type="button" class="ghost-btn small" data-providers-refresh${busy ? ` aria-disabled="true" aria-busy="true"` : ""}>${busy ? "Refreshing…" : "Refresh limits"}</button>${state.limitsError ? `<span class="error-line small" data-limits-error>${esc(oneLine(state.limitsError))}</span>` : ""}</div>${state.limitsVisibilityError ? `<p class="error-line small" role="alert" data-visibility-error>${esc(state.limitsVisibilityError)}</p>` : ""}<ul class="provider-list">${(
      state.limits ?? []
    )
      .map((item) => {
        const saving = item.provider in state.limitsPending;
        const shown = saving ? state.limitsPending[item.provider] : limitShown(item.provider);
        return `<li data-provider="${esc(item.provider)}"><label class="switch" title="Show ${esc(item.label)} in the status line"><input type="checkbox" data-limit-visible="${esc(item.provider)}" aria-label="Show ${esc(item.label)} in the status line" ${shown ? "checked" : ""}${saving ? ` aria-busy="true"` : ""}/><b>${esc(item.label)}</b></label><span class="badge ${item.status === "ok" ? "t-ready" : ""}">${esc(item.status)}</span><span class="muted small one-line">${esc(item.reason ?? (item.usage ? `${usd(item.usage.amountUsd)} this period` : item.samples?.[0] ? `${Math.round(item.samples[0].usedPercent ?? 0)}% used` : ""))}</span><span class="sl-state small">${saving ? "saving…" : shown ? "" : "hidden"}</span>${cursorConnect(item)}</li>`;
      })
      .join("")}</ul>`;
  };
  draw();
  body.addEventListener("click", (event) => {
    if (event.target.closest("[data-providers-refresh]")) void refreshLimits();
    else if (event.target.closest("[data-cursor-connect]")) void connectCursor();
  });
  body.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-limit-visible]");
    if (toggle) void setLimitShown(toggle.dataset.limitVisible, toggle.checked);
  });
  // Buttons and switches stay focusable while busy (aria-disabled / aria-busy, not disabled), so the redraw keeps the keyboard there.
  const off = on("limits", () => {
    if (!alive()) return off();
    const active = document.activeElement;
    const focus = active?.matches?.("[data-providers-refresh]")
      ? "[data-providers-refresh]"
      : active?.matches?.("[data-cursor-connect], [data-cursor-login]")
        ? "[data-cursor-login], [data-cursor-connect]"
        : active?.matches?.("[data-limit-visible]")
          ? `[data-limit-visible="${CSS.escape(active.dataset.limitVisible)}"]`
          : null;
    draw();
    if (focus) body.querySelector(focus)?.focus();
  });
}
