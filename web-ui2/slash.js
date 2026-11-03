// "/" completion in the Coordinator composer, as on the classic page: commands at the start of the message, skills anywhere a
// word starts (after a space or an opening bracket). Skills come from the project's `coordinator-skills` catalog. The textarea keeps
// focus; the menu is a listbox it points at through aria-activedescendant.
import { call } from "./api.js";
import { esc } from "./format.js";
import { chatArgs, emit, on, state, toast } from "./state.js";

const input = document.querySelector("#composer-input"),
  menuNode = document.querySelector("#slash-menu");
const TRIGGER = /(^|[\s(\[])\/(?:skill:)?([\w.-]*)$/;

/** A whole message "/name [argument]" runs here instead of reaching the coordinator. */
const COMMANDS = [
  {
    name: "new",
    description: "Clear this chat's context; earlier messages stay stored",
    run: async () => {
      await call("chat-reset", { id: state.projectId, ...chatArgs() });
      toast("New context started.");
    },
  },
  {
    name: "reload",
    description: "Reload skills, instructions and tools for this chat",
    run: async () => {
      const result = await call("chat-reload", { id: state.projectId, ...chatArgs() });
      const skills = `${result.skills} skill${result.skills === 1 ? "" : "s"}`;
      toast(result.changed ? `Reloaded: ${skills} for this chat; prompt and tools updated.` : `Already up to date (${skills}).`);
    },
  },
  {
    name: "compact",
    description: "Compact this chat's context now",
    run: async () => {
      await call("compact", { id: state.projectId, ...chatArgs() });
      toast("Compacting this chat…");
    },
  },
  {
    name: "name",
    description: "Rename this chat",
    argument: "<title>",
    run: async (title) => {
      if (!title) throw new Error("Type the new title after /name.");
      await call("chat-update", { id: state.projectId, chatId: state.chatId, title: title.slice(0, 120) });
      toast("Chat renamed.");
    },
  },
  {
    name: "copy",
    description: "Copy the last reply to the clipboard",
    run: async () => {
      const reply = state.view?.messages.findLast((item) => item.kind === "message" && item.role === "assistant" && item.text?.trim());
      if (!reply) throw new Error("No reply to copy yet.");
      await navigator.clipboard.writeText(reply.text);
      toast("Last reply copied.");
    },
  },
  { name: "settings", description: "Open settings for this chat", run: async () => emit("open-settings") },
];
export function slashCommand(text) {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = match && COMMANDS.find((item) => item.name === match[1]);
  return command ? { command, argument: match[2]?.trim() ?? "" } : null;
}

// ---------------------------------------------------------------------------------------------------------------- catalog

let catalog = null;
/** The host rebuilds the catalog from disk on every request; keystrokes within two seconds share one answer. */
async function loadSkills(projectId) {
  if (catalog?.projectId === projectId && Date.now() - catalog.at < 2000) return catalog.skills;
  const { skills } = await call("coordinator-skills", { id: projectId });
  if (projectId === state.projectId) catalog = { projectId, skills, at: Date.now() };
  return skills;
}
/** Cursor-style fuzzy match: characters in order; runs and word starts score high, late and long targets lower; -1 when absent. */
function fuzzyScore(query, target) {
  const text = String(target ?? ""),
    lower = text.toLowerCase();
  let from = 0,
    score = 0,
    previous = -2,
    first = -1;
  for (const char of query) {
    const at = lower.indexOf(char, from);
    if (at < 0) return -1;
    if (first < 0) first = at;
    const boundary = at === 0 || /[\s/\\._:#-]/.test(lower[at - 1]) || (text[at] !== lower[at] && text[at - 1] === lower[at - 1]);
    score += 1 + (at === previous + 1 ? 6 : 0) + (boundary ? 8 : 0);
    previous = at;
    from = at + 1;
  }
  return score + 10 - Math.min(first, 40) * 0.25 - Math.min(lower.length, 200) * 0.02;
}
function rank(items, query) {
  const q = query.toLowerCase();
  if (!q) return items;
  return items
    .map((item) => [
      Math.max(fuzzyScore(q, item.name) * 1.5 + (item.name.toLowerCase().startsWith(q) ? 40 : 0), fuzzyScore(q, item.description) * 0.4),
      item,
    ])
    .filter(([score]) => score > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([, item]) => item);
}

// ---------------------------------------------------------------------------------------------------------------- menu

let menu = null, // { items, index, query }
  seq = 0;
function trigger() {
  if (input.selectionStart !== input.selectionEnd) return null;
  const match = TRIGGER.exec(input.value.slice(0, input.selectionStart));
  return match ? { query: match[2], atStart: match.index + match[1].length === 0 } : null;
}
export const slashMenuOpen = () => !!menu;
export function closeSlashMenu() {
  seq++;
  menu = null;
  menuNode.hidden = true;
  menuNode.replaceChildren();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}
/** Re-reads the trigger before the caret; an answer for an older keystroke, project or chat is dropped. */
async function update() {
  const found = trigger();
  if (!found || !state.projectId) return closeSlashMenu();
  const mine = ++seq,
    projectId = state.projectId,
    chatId = state.chatId;
  let skills = [];
  try {
    skills = await loadSkills(projectId);
  } catch {
    skills = []; // commands still work without the catalog
  }
  const now = trigger();
  if (mine !== seq || projectId !== state.projectId || chatId !== state.chatId || now?.query !== found.query) return;
  const commands = found.atStart
    ? rank(
        COMMANDS.map((item) => ({ ...item, kind: "command" })),
        found.query,
      )
    : [];
  const items = [
    ...commands,
    ...rank(
      skills.map((skill) => ({ ...skill, kind: "skill" })),
      found.query,
    ),
  ].slice(0, 60);
  // Mid-message, a "/" that matches no skill is just a slash.
  if (!items.length && !found.atStart) return closeSlashMenu();
  const index = menu?.query === found.query ? Math.min(menu.index, Math.max(0, items.length - 1)) : 0;
  menu = { items, index, query: found.query };
  paint();
}
const SOURCE = { repo: "Repository", global: "Yours", package: "Package" };
function paint() {
  if (!menu) return;
  menuNode.innerHTML = menu.items.length
    ? menu.items
        .map(
          (item, index) =>
            `<div role="option" id="slash-opt-${index}" class="slash-opt" aria-selected="${index === menu.index}" data-index="${index}" data-source="${item.kind}" data-name="${esc(item.name)}"><span class="slash-name">/${esc(item.name)}${item.argument ? ` <small>${esc(item.argument)}</small>` : ""}</span><span class="slash-desc">${esc(item.description ?? "")}</span><span class="slash-kind">${esc(item.kind === "command" ? "Command" : (SOURCE[item.source] ?? item.source ?? "Skill"))}</span></div>`,
        )
        .join("")
    : `<p class="slash-empty">No command or skill matches “${esc(menu.query)}”</p>`;
  menuNode.hidden = false;
  input.setAttribute("aria-expanded", "true");
  if (menu.items.length) input.setAttribute("aria-activedescendant", `slash-opt-${menu.index}`);
  else input.removeAttribute("aria-activedescendant");
  menuNode.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
/** Replaces the trigger before the caret (and the rest of that word) with `text`, keeping undo where the browser allows it. */
function insert(text) {
  const caret = input.selectionStart,
    match = TRIGGER.exec(input.value.slice(0, caret));
  if (!match) return;
  const start = match.index + match[1].length,
    wordEnd = caret + (/^\S*/.exec(input.value.slice(caret))?.[0].length ?? 0),
    end = input.value[wordEnd] === " " ? wordEnd + 1 : wordEnd;
  input.focus();
  input.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) {
    input.setRangeText(text, start, end, "end");
    input.dispatchEvent(new Event("input"));
  }
  closeSlashMenu();
}
/** Enter on a command without an argument runs it; Tab, or a command that takes one, only fills the composer. */
function pick(item, run) {
  if (item.kind === "skill") return insert(`/skill:${item.name} `);
  insert(`/${item.name} `);
  if (run && !item.argument) input.form.requestSubmit();
}
/** Keys while the menu is open; true when consumed. Esc is handled by the app's leave-focus (closeSlashMenu first). */
export function slashKey(event) {
  if (!menu || event.isComposing) return false;
  const count = menu.items.length;
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
    menu.index = (menu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    paint();
  } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && count)
    pick(menu.items[menu.index], event.key === "Enter");
  else return false;
  event.preventDefault();
  return true;
}

input.setAttribute("aria-autocomplete", "list");
input.setAttribute("aria-controls", "slash-menu");
input.setAttribute("aria-expanded", "false");
input.addEventListener("input", () => void update());
input.addEventListener("click", () => void update());
input.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") void update();
});
input.addEventListener("blur", () => closeSlashMenu());
// Pointer picks keep the composer focused: the press is cancelled, the click picks.
menuNode.addEventListener("mousedown", (event) => event.preventDefault());
menuNode.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (option && menu) pick(menu.items[Number(option.dataset.index)], false);
});
on("select", () => {
  catalog = null;
  closeSlashMenu();
});
