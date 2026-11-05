// Settings → Prompt: the behavior blocks of one target (a project role or the Host agent) as a compact list, with the project's
// shared contract blocks (and, for the coordinator, its integration blocks) as their own groups, one
// selected editor and the assembled preview. Project instructions keep their own row (the project's objective); the other generated
// sections are listed read-only. Unsaved text is kept per block in localStorage until it is saved, so a reload or a refused stale
// write never loses it. The host owns the data: `prompt-blocks-get`/`-set`, `prompt-render`, `settings-snapshot`/`-update`.
import { call } from "./api.js";
import { esc, tokens } from "./format.js";
import { state } from "./state.js";

const estimate = (text) => Math.ceil(text.length / 4);
const narrow = matchMedia("(max-width: 760px)");
const OBJECTIVE = "objective"; // the Project instructions row; never a block id (built-ins are named, customs are `custom:<slug>`)
let workerMode = "job"; // Worker tab preview: an independent Job worker or a task helper (one block list, a delivery block per mode)

// ---------------------------------------------------------------------------------------------------------------- host

const where = (target) => (target === "host" ? {} : { projectId: state.projectId });
/** The whole ordered list with the revision it was read at. A built-in sends text only when it differs from its default. */
const saveBlocks = (target, revision, blocks) =>
  call("prompt-blocks-set", {
    ...where(target),
    target,
    revision,
    blocks: blocks.map((item) =>
      item.kind === "custom"
        ? { id: item.id, name: item.name, enabled: item.enabled, text: item.text }
        : { id: item.id, enabled: item.enabled, ...(item.edited ? { text: item.text } : {}) },
    ),
  });
/** The assembled prompt for the next use; `active` only says whether a running conversation already has it. */
const render = (profile) =>
  call("prompt-render", {
    ...where(profile),
    profile,
    ...(profile === "worker" ? { workerMode: workerMode === "task" ? "task" : "job" } : {}),
    // Only the coordinator's prompt is per chat; the host refuses chatId for every other profile.
    ...(profile === "coordinator" && state.chatId !== "main" ? { chatId: state.chatId } : {}),
  });
export const isStale = (error) => /revision/i.test(String(error?.message ?? error));
const ADOPTS = {
  "next-message": "Applies from your next message; a running turn is not interrupted.",
  "next-turn-per-agent": "Each agent picks it up on its next turn; running turns are not interrupted.",
  "next-turn": "Applies from the Host agent's next turn; a running turn is not interrupted.",
  "next-message-and-new-agents":
    "Applies to coordinator chats from your next message and to agents started after saving; running agents keep theirs.",
};
/** Shared groups shown with a profile's behavior: the contract for every project role, integrations for the coordinator. */
const SIDES = { coordinator: ["contract", "integrations"], worker: ["contract"], scout: ["contract"], reviewer: ["contract"], host: [] };
const SIDE_LABELS = {
  contract: ["Contract", "every role of this project"],
  integrations: ["Integrations", "shown while their grant is on"],
};
const PLACEHOLDER_NOTE = "Placeholders: {project}, {projectId}, {githubRepos}.";
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "block";

// ---------------------------------------------------------------------------------------------------------------- drafts

// Project instructions are one text for every role, so their draft is per project, not per target.
const draftKey = (target, id) =>
  `pi-ui2-prompt-draft:${target === "host" ? "host" : state.projectId}:${id === OBJECTIVE ? "project" : target}:${id}`;
function readDraft(target, id) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(target, id)) ?? "null");
  } catch {
    return null;
  }
}
function writeDraft(target, id, draft) {
  try {
    if (draft) localStorage.setItem(draftKey(target, id), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(target, id));
  } catch {}
}

// ---------------------------------------------------------------------------------------------------------------- section

/** Renders the Prompt section of settings profile `profile` into `body`; `say`/`sayFail` report next to the header. Returns
 * `back()` for Esc and `refresh()` for writes from elsewhere. */
export async function promptSection(body, alive, { profile, say, sayFail }) {
  let target,
    model,
    rendered,
    settings,
    others = [], // the contract and integration models: blocks keyed `<target>~<id>`
    reads = 0;
  const tag = (view, owner) => ({
    ...view,
    blocks: view.blocks.map((item) => ({ ...item, target: owner, key: owner === profile ? item.id : `${owner}~${item.id}` })),
  });
  const firstKey = () => model.blocks[0]?.key ?? null;
  const modelOf = (owner) => (owner === target ? model : others.find((item) => item.target === owner));
  // Reads overlap (a save re-reads while the change feed asks for one too): only the newest one started may land.
  const fetchAll = async () => {
    const mine = ++reads,
      next = profile,
      sides = SIDES[next] ?? [];
    const result = await Promise.all([
      call("prompt-blocks-get", { ...where(next), target: next }),
      render(profile),
      next === "host" ? null : call("settings-snapshot", { id: state.projectId }),
      ...sides.map((side) => call("prompt-blocks-get", { ...where(side), target: side })),
    ]);
    if (mine !== reads) return;
    target = next;
    [model, rendered, settings] = [tag(result[0], next), result[1], result[2]];
    others = sides.map((side, n) => tag(result[3 + n], side));
  };
  await fetchAll();
  if (!alive()) return null;
  let selected = firstKey(),
    pane = "blocks",
    view = "list", // narrow screens show the list or the editor
    conflict = false,
    armed = false;

  const objective = () =>
    settings && { id: OBJECTIVE, kind: "project", name: "Project instructions", text: settings.values.objective ?? "", enabled: true };
  const block = (key = selected) =>
    key === "new"
      ? { id: "new", key: "new", target, kind: "custom", name: "", text: "", enabled: true }
      : key === OBJECTIVE
        ? objective()
        : [model, ...others].flatMap((view) => view.blocks).find((item) => item.key === key);
  /** Where a row's draft is kept: its own target and id (project instructions and new blocks: the profile's). */
  const slot = (key = selected) => {
    const item = key === OBJECTIVE || key === "new" ? null : block(key);
    return [item?.target ?? target, item?.id ?? key];
  };
  /** What the editor shows: the saved block with its draft on top. */
  const current = (key = selected) => {
    const saved = block(key);
    if (!saved) return null;
    const draft = readDraft(...slot(key));
    return { saved, draft, name: draft?.name ?? saved.name, text: draft?.text ?? saved.text };
  };
  const source = (item) =>
    item.kind === "project"
      ? "Project"
      : item.id === "custom:legacy"
        ? "Legacy"
        : item.kind === "custom"
          ? "Custom"
          : item.edited
            ? "Edited"
            : "Built-in";
  const badge = (item) => `<span class="pb-src ${source(item).toLowerCase()}">${source(item)}</span>`;
  // Read-only sections: everything but the role text (the blocks) and, for a project, the project instructions (their own row).
  const generated = () => rendered.sections.filter((item) => item.id !== "role" && !(settings && item.id === "project"));
  const sourceLine = (item) => item.source.replace(/; tokens are an estimate \(chars\/4\)$/, "");

  const row = (item) => {
    const on = item.enabled !== false,
      key = item.key ?? item.id;
    const lead =
      item.kind === "project"
        ? `<span class="pb-lead" aria-hidden="true"></span>`
        : item.required
          ? `<span class="pb-lead lock" aria-label="${esc(item.name)} is required">🔒</span>`
          : `<label class="pb-switch"><input class="pb-toggle" type="checkbox" tabindex="-1" ${on ? "checked" : ""} aria-label="${esc(item.name)} ${on ? "on" : "off"}"/><span class="track"></span></label>`;
    const idle = item.active === false ? `<span class="pb-off" title="${esc(item.grant)} is off for this project">grant off</span>` : "";
    return `<li class="pb-row" role="option" tabindex="${key === selected ? 0 : -1}" data-block="${esc(key)}" data-enabled="${on}" data-active="${item.active !== false}" aria-selected="${key === selected}">${lead}<span class="pb-name">${esc(item.name)}</span>${item.mode ? `<span class="pb-mode small muted">${item.mode === "job" ? "Job only" : "Helper only"}</span>` : ""}${on ? idle : `<span class="pb-off">off</span>`}${readDraft(...slot(key)) ? `<span class="pb-draft">draft</span>` : ""}${badge(item)}<span class="pb-tok mono">${tokens(item.tokens ?? estimate(item.text))}</span></li>`;
  };
  const generatedRow = (item) =>
    `<li class="pb-row" data-generated data-block="${esc(item.id)}" title="${esc(sourceLine(item))}"><span class="pb-lead" aria-hidden="true"></span><span class="pb-name">${esc(item.label)}</span><span class="pb-tok mono">${tokens(item.tokens)}</span></li>`;

  const editor = () => {
    const now = current();
    if (!now) return `<section class="pb-editor empty" aria-label="Block editor"><p class="muted">Pick a block, or add one.</p></section>`;
    const { saved, draft } = now;
    const custom = saved.kind === "custom";
    const shared = saved.target && saved.target !== target;
    const note = draft
      ? "Unsaved · kept if you leave or reload."
      : saved.kind === "project"
        ? "Shared by every role of this project."
        : saved.active === false
          ? `Hidden from the agent while ${saved.grant} is off.`
          : `${ADOPTS[modelOf(saved.target ?? target)?.application?.adopts] ?? ""}${shared ? ` ${PLACEHOLDER_NOTE}` : ""}`;
    return `<section class="pb-editor" aria-label="Block editor" data-block="${esc(saved.key ?? saved.id)}">
<header class="pb-editor-head"><button type="button" class="icon-btn small pb-back" aria-label="Back to blocks">←</button>${
      custom
        ? `<input class="pb-title" aria-label="Block name" maxlength="${model.limits.maxNameChars}" placeholder="Block name" value="${esc(now.name)}"/>`
        : `<h2 class="pb-title">${esc(saved.name)}</h2>`
    }${saved.id === "new" ? "" : badge(saved)}<span class="grow"></span><span class="pb-tok mono" data-live-tokens>${tokens(estimate(now.text))} tokens</span></header>
${conflict ? `<div class="pb-conflict" role="alert"><span>Changed elsewhere since you started. Your text is kept.</span><button type="button" class="ghost-btn small" data-conflict="reload">Load latest</button></div>` : ""}
<textarea class="pb-text" aria-label="${esc(now.name || "New block")} text" spellcheck="false" maxlength="${saved.kind === "project" ? 32000 : model.limits.maxBlockChars}" placeholder="What the agent should do, in plain words.">${esc(now.text)}</textarea>
<footer class="pb-actions"><button type="button" class="primary small" id="pb-save" ${(draft || saved.id === "new") && !conflict ? "" : "disabled"}>Save <kbd>⌘↵</kbd></button><button type="button" class="ghost-btn small" id="pb-revert" ${draft ? "" : "disabled"}>Revert</button>${
      saved.kind === "builtin" && saved.edited
        ? `<button type="button" class="ghost-btn small" id="pb-restore">Restore default</button>`
        : ""
    }<span class="grow"></span>${
      custom && saved.id !== "new"
        ? `<button type="button" class="ghost-btn small${armed ? " danger" : ""}" id="pb-delete">${armed ? "Confirm delete" : "Delete"}</button>`
        : ""
    }<span class="muted small pb-note">${esc(note)}</span></footer></section>`;
  };

  const preview = () => {
    const head = (kind, name, path, count) =>
      `<span class="pv-src ${kind.toLowerCase()}">${esc(kind)}</span><span class="pv-name">${esc(name)}</span><span class="pv-path muted one-line">${esc(path)}</span><span class="grow"></span><span class="pv-tok mono">${tokens(count)} tokens</span>`;
    const gen = (item) =>
      `<details class="pv-sec" data-generated><summary>${head("Generated", item.label, sourceLine(item), item.tokens)}</summary><pre class="pv-text">${esc(item.text.trim() || "(empty)")}</pre></details>`;
    const own = (kind, id, name, path, text, count) =>
      `<section class="pv-sec" data-block="${esc(id)}"><header>${head(kind, name, path, count)}</header><pre class="pv-text">${esc(text)}</pre></section>`;
    // The role section is replaced by the enabled blocks in order, so each part shows where it comes from.
    const parts = rendered.sections.flatMap((item) =>
      item.id === "role"
        ? model.blocks
            .filter(
              (entry) =>
                entry.enabled !== false && entry.text.trim() && (!entry.mode || entry.mode === (workerMode === "task" ? "helper" : "job")),
            )
            .map((entry) => own(source(entry), entry.id, entry.name, entry.id, entry.text, entry.tokens ?? estimate(entry.text)))
        : item.id === "project" && settings
          ? [own("Project", item.id, item.label, sourceLine(item), item.text, item.tokens)]
          : [gen(item)],
    );
    const active = rendered.active;
    const activeLine = !active
      ? ""
      : active.matchesConfigured
        ? `<span class="muted small">The running conversation uses this prompt.</span>`
        : `<span class="pv-active small">The running conversation has an older prompt${active.pending ? "; it switches on its next turn" : ""}.</span>`;
    return `<div class="pv-head"><span class="pv-state badge">${esc(rendered.label)}</span>${activeLine}<span class="grow"></span><span class="mono small muted">≈${tokens(rendered.totalTokens)} tokens</span></div><div class="pv-body">${parts.join("")}</div>`;
  };

  const draw = ({ focus } = {}) => {
    if (!alive()) return;
    const customs = model.blocks.filter((item) => item.kind === "custom").length;
    const full = customs >= model.limits.maxCustom || model.blocks.length >= model.limits.maxBlocks;
    const project = objective();
    const group = (view) => {
      const [label, hint] = SIDE_LABELS[view.target];
      return `<p class="pb-group">${label} <span class="muted small">${hint}</span></p><ul role="listbox" aria-label="${label} blocks" data-group="${view.target}">${view.blocks.map(row).join("")}</ul>`;
    };
    const list = `<div class="pb-list">${project ? `<ul role="listbox" aria-label="Project instructions" class="pb-project">${row(project)}</ul>` : ""}${others.map(group).join("")}<p class="pb-group">Behavior</p><ul role="listbox" aria-label="Behavior blocks">${model.blocks.map(row).join("")}</ul><button type="button" class="ghost-btn small pb-new" id="pb-new" ${full ? `disabled title="At most ${model.limits.maxCustom} custom blocks"` : ""}>+ New block</button>${
      generated().length
        ? `<details class="pb-generated"><summary>Generated · read-only <span class="muted">${generated().length}</span></summary><ul>${generated().map(generatedRow).join("")}</ul></details>`
        : ""
    }<p class="pb-keys muted small"><kbd>↑↓</kbd> pick · <kbd>Space</kbd> on/off · <kbd>⌥↑↓</kbd> move · <kbd>↵</kbd> edit</p></div>`;
    const kinds =
      profile === "worker"
        ? `<div class="seg" role="radiogroup" aria-label="Worker kind"><button type="button" role="radio" data-kind="job" aria-checked="${workerMode === "job"}">Independent Job</button><button type="button" role="radio" data-kind="task" aria-checked="${workerMode === "task"}">Task helper</button></div>`
        : "";
    const pending = model.application?.pending
      ? `<span class="pv-active small" title="The Host agent is in a turn; the saved blocks apply on its next one.">pending next turn</span>`
      : "";
    const top = `<div class="pb-bar"><div class="seg" role="tablist" aria-label="Prompt view"><button type="button" role="tab" data-pane="blocks" aria-selected="${pane === "blocks"}">Blocks</button><button type="button" role="tab" data-pane="preview" aria-selected="${pane === "preview"}">Preview</button></div>${kinds}<span class="grow"></span>${pending}<span class="muted small">${model.blocks.filter((item) => item.enabled !== false).length}/${model.blocks.length} on</span></div>`;
    const legacy = model.legacy
      ? `<p class="pb-legacy small">This role still runs its old single prompt (Legacy). Built-ins stay off until you switch them on.</p>`
      : "";
    body.innerHTML = `<div class="pb" data-target="${esc(target)}" data-view="${view}">${top}${legacy}${pane === "preview" ? preview() : `<div class="pb-split">${list}${editor()}</div>`}</div>`;
    if (focus === "row") body.querySelector(`.pb-row[data-block="${CSS.escape(selected ?? "")}"]`)?.focus();
    if (focus === "text") body.querySelector(".pb-text")?.focus();
  };

  const reload = async () => {
    await fetchAll();
    if (selected !== "new" && !block()) selected = firstKey();
  };
  /** Runs one host write, then re-reads. A stale revision keeps the draft and shows the conflict. True when stored. */
  const commit = async (write, message, { focus } = {}) => {
    try {
      await write();
      await fetchAll();
      conflict = false;
      say(message);
      return true;
    } catch (error) {
      if (isStale(error)) {
        conflict = true;
        say("Changed elsewhere · your text is kept", { error: true });
      } else sayFail(error);
      return false;
    } finally {
      draw({ focus });
    }
  };
  const writeBlocks = (blocks, message, options, owner = target) =>
    commit(() => saveBlocks(owner, modelOf(owner).revision, blocks), message, options);
  // One change at a time, each computed from the model the previous one left (a second Space must not reuse the old revision).
  let queue = Promise.resolve();
  const queued =
    (action) =>
    (...args) =>
      (queue = queue.then(() => action(...args)).catch(sayFail));
  /** The owning target's whole list with one block changed. */
  const replace = (key, next) => modelOf(block(key).target).blocks.map((item) => (item.key === key ? { ...item, ...next } : item));

  const store = queued(async () => {
    const now = current();
    if (!now || conflict) return; // Load latest first, so a save never lands on text the owner has not seen
    const id = now.saved.key ?? now.saved.id,
      owner = now.saved.target ?? target;
    let ok;
    if (id === OBJECTIVE)
      ok = await commit(
        () =>
          call("settings-update", {
            id: state.projectId,
            confirm: state.projectId,
            expectedRevision: settings.revision,
            changes: { objective: now.text },
          }),
        "Project instructions saved",
      );
    else if (id === "new") {
      const name = now.name.trim() || "Untitled block";
      let fresh = `custom:${slug(name)}`;
      for (let n = 2; model.blocks.some((item) => item.id === fresh); n++) fresh = `custom:${slug(name)}-${n}`;
      // A refused write keeps the draft on "new", so Load latest and Save again still have it.
      ok = await writeBlocks(
        [...model.blocks, { id: fresh, kind: "custom", name, text: now.text, enabled: true }],
        `${name} added · saved`,
      );
      if (ok) selected = fresh; // behavior blocks are keyed by their id
    } else {
      const next =
        now.saved.kind === "custom"
          ? { name: now.name.trim() || now.saved.name, text: now.text }
          : { text: now.text, edited: now.text !== now.saved.defaultText };
      ok = await writeBlocks(replace(id, next), `${next.name ?? now.saved.name} saved`, {}, owner);
    }
    if (ok) {
      writeDraft(owner, now.saved.id, null);
      draw();
    }
  });
  const toggle = queued((id) => {
    const item = block(id);
    if (!item || item.kind === "project" || item.required || id === "new") return;
    const on = item.enabled === false;
    return writeBlocks(replace(id, { enabled: on }), `${item.name} ${on ? "on" : "off"} · saved`, { focus: "row" }, item.target);
  });
  const move = queued((key, step) => {
    const owner = block(key)?.target;
    if (!owner) return;
    const list = modelOf(owner).blocks,
      from = list.findIndex((item) => item.key === key),
      to = from + step;
    if (from < 0 || to < 0 || to >= list.length) return;
    const next = [...list];
    next.splice(to, 0, ...next.splice(from, 1));
    return writeBlocks(next, `${next[to].name} moved ${step < 0 ? "up" : "down"} · saved`, { focus: "row" }, owner);
  });
  const restore = queued(async () => {
    const item = block();
    if (item?.kind !== "builtin") return;
    if (
      await writeBlocks(
        replace(item.key, { edited: false, text: item.defaultText ?? "" }),
        `${item.name} restored to default`,
        {},
        item.target,
      )
    ) {
      writeDraft(item.target, item.id, null);
      draw();
    }
  });
  const remove = queued(async () => {
    const item = block();
    if (item?.kind !== "custom" || item.id === "new") return;
    const ok = await writeBlocks(
      modelOf(item.target).blocks.filter((entry) => entry.key !== item.key),
      `${item.name} deleted`,
      {},
      item.target,
    );
    if (ok) {
      writeDraft(item.target, item.id, null);
      selected = firstKey();
      view = "list";
      draw();
    }
  });
  const pick = (id, { focus } = {}) => {
    if (id !== selected) armed = false;
    selected = id;
    if (narrow.matches && focus !== "row") view = "editor";
    draw({ focus });
  };

  body.addEventListener("click", async (event) => {
    const t = event.target;
    if (t.closest("button[data-pane]")) {
      pane = t.closest("[data-pane]").dataset.pane;
      return draw();
    }
    if (t.closest("button[data-kind]")) {
      workerMode = t.closest("[data-kind]").dataset.kind;
      await reload().catch(sayFail);
      if (selected !== OBJECTIVE) selected = firstKey();
      return draw();
    }
    const toggleBox = t.closest(".pb-switch");
    if (toggleBox) {
      event.preventDefault(); // the box shows the host state after the write, not the click
      return void toggle(toggleBox.closest(".pb-row").dataset.block);
    }
    const hit = t.closest(".pb-row:not([data-generated])");
    if (hit) return pick(hit.dataset.block);
    if (t.closest("#pb-new")) return pick("new", { focus: "text" });
    if (t.closest(".pb-back")) {
      view = "list";
      return draw({ focus: "row" });
    }
    if (t.closest("#pb-save")) return void store();
    if (t.closest("#pb-revert")) {
      writeDraft(...slot(), null);
      conflict = false;
      return draw();
    }
    if (t.closest("#pb-restore")) return void restore();
    if (t.closest("#pb-delete")) {
      if (!armed) {
        armed = true;
        return draw();
      }
      armed = false;
      return void remove();
    }
    if (t.closest('[data-conflict="reload"]')) {
      await reload().catch(sayFail);
      const draft = readDraft(...slot());
      if (draft && block()) writeDraft(...slot(), { ...draft, base: block().text });
      conflict = false;
      return draw({ focus: "text" });
    }
  });
  // Typing keeps a draft per block; the row and Save follow without a redraw, so the caret stays put.
  body.addEventListener("input", (event) => {
    if (!event.target.closest(".pb-text, input.pb-title")) return;
    const now = current();
    const text = body.querySelector(".pb-text").value,
      name = body.querySelector("input.pb-title")?.value ?? now.name;
    const same = selected !== "new" && text === now.saved.text && name === now.saved.name;
    // `base` is the saved text the draft started from: a newer saved text under it is a conflict, not a silent overwrite.
    writeDraft(...slot(), same ? null : { name, text, base: now.draft?.base ?? now.saved.text });
    body.querySelector("[data-live-tokens]").textContent = `${tokens(estimate(text))} tokens`;
    body.querySelector("#pb-save").disabled = same;
    body.querySelector("#pb-revert").disabled = same;
    const item = body.querySelector(`.pb-row[data-block="${CSS.escape(selected)}"]`);
    if (item && !same && !item.querySelector(".pb-draft"))
      item.querySelector(".pb-name").insertAdjacentHTML("afterend", `<span class="pb-draft">draft</span>`);
    if (item && same) item.querySelector(".pb-draft")?.remove();
  });
  body.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target.closest(".pb-editor")) {
      event.preventDefault();
      return void store();
    }
    const focused = event.target.closest?.(".pb-row:not([data-generated])");
    if (!focused || event.target !== focused) return;
    const id = focused.dataset.block,
      rows = [...body.querySelectorAll(".pb-row:not([data-generated])")],
      at = rows.indexOf(focused);
    if (event.key === " ") {
      event.preventDefault();
      return void toggle(id);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      return pick(id, { focus: "text" });
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.key === "ArrowUp" ? -1 : 1;
    if (event.altKey) return void move(id, step);
    const next = rows[at + step];
    if (next) pick(next.dataset.block, { focus: "row" });
  });
  draw();
  return {
    /** Esc: leave the editor for its row (narrow: back to the list); false when there is nothing to leave. */
    back() {
      if (!body.querySelector(".pb-editor")?.contains(document.activeElement) && view !== "editor") return false;
      view = "list";
      draw({ focus: "row" });
      return true;
    },
    /** A write from elsewhere: re-read and redraw, keeping the caret. A draft whose block changed under it shows the conflict. */
    async refresh() {
      // Our own saves come back through the feed too; redrawing for nothing would swap a button out from under a click.
      const before = JSON.stringify([model, rendered, settings, others]);
      await reload();
      if (JSON.stringify([model, rendered, settings, others]) === before) return;
      const draft = readDraft(...slot());
      if (draft && block() && draft.base !== block().text) conflict = true;
      const field = document.activeElement?.closest?.(".pb-text, input.pb-title");
      const caret = field &&
        body.contains(field) && [field.matches(".pb-text") ? ".pb-text" : "input.pb-title", field.selectionStart, field.selectionEnd];
      const onRow = !!document.activeElement?.closest?.(".pb-row") && body.contains(document.activeElement);
      draw({ focus: onRow ? "row" : undefined });
      if (caret) {
        const next = body.querySelector(caret[0]);
        next?.focus();
        next?.setSelectionRange(caret[1], caret[2]);
      }
    },
  };
}
