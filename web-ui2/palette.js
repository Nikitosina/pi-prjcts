// ⌘K: search chats, projects and commands in one list; also full-text search of the selected project (`search`).
import { call } from "./api.js";
import { clip, esc } from "./format.js";
import { display, binding } from "./hotkeys.js";
import { fail, state } from "./state.js";

const dialog = document.querySelector("#palette");
let items = [],
  active = 0,
  results = [],
  searchTimer = 0,
  searchGen = 0;
/** Entries come from app.js: { id, label, hint?, cmd?, run() }. */
let source = () => [];
export function setPaletteSource(fn) {
  source = fn;
}
export const paletteOpen = () => dialog.open;
export function openPalette() {
  dialog.innerHTML = `<div class="palette"><div class="pal-input"><span class="glyph" aria-hidden="true">⌕</span><input type="text" aria-label="Search chats, projects and commands" placeholder="Search chats, projects, commands…" /><kbd>Esc</kbd></div><ul role="listbox" aria-label="Results"></ul></div>`;
  dialog.showModal();
  const input = dialog.querySelector("input");
  input.addEventListener("input", () => filter(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, Math.min(visible().length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(visible()[active]);
    }
  });
  filter("");
  input.focus();
}
export function closePalette() {
  if (dialog.open) dialog.close();
}
dialog.addEventListener("cancel", (event) => event.preventDefault());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) return closePalette();
  const row = event.target.closest("[data-index]");
  if (row) choose(visible()[Number(row.dataset.index)]);
});
function visible() {
  return [...items, ...results];
}
function filter(q) {
  const text = q.trim().toLowerCase();
  items = source()
    .filter((item) => !text || item.label.toLowerCase().includes(text) || item.hint?.toLowerCase().includes(text))
    .slice(0, 40);
  results = [];
  active = 0;
  paint();
  clearTimeout(searchTimer);
  if (text.length < 3 || !state.projectId) return;
  const gen = ++searchGen,
    projectId = state.projectId;
  searchTimer = setTimeout(async () => {
    const found = await call("search", { id: projectId, query: q.trim(), limit: 8 }).catch(() => null);
    if (gen !== searchGen || !dialog.open || projectId !== state.projectId || !found) return;
    const hits = Array.isArray(found) ? found : (found.results ?? found.items ?? []);
    results = hits.slice(0, 8).map((hit) => ({
      id: `hit:${hit.ref ?? hit.path ?? hit.id}`,
      label: clip(hit.title ?? hit.text ?? hit.snippet ?? hit.path ?? "", 90),
      hint: hit.kind ?? hit.source ?? "match",
      run: () => {},
    }));
    paint();
  }, 200);
}
function paint() {
  const list = dialog.querySelector("ul");
  if (!list) return;
  list.innerHTML =
    visible()
      .map(
        (item, index) =>
          `<li role="option" data-index="${index}" aria-selected="${index === active}" class="${index === active ? "on" : ""}"><span class="pal-label">${esc(item.label)}</span>${item.hint ? `<span class="muted small">${esc(item.hint)}</span>` : ""}${item.cmd && binding(item.cmd) ? `<kbd>${esc(display(binding(item.cmd)))}</kbd>` : ""}</li>`,
      )
      .join("") || `<li class="muted small pal-empty">Nothing found.</li>`;
  list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function choose(item) {
  if (!item) return;
  closePalette();
  try {
    item.run();
  } catch (error) {
    fail(error);
  }
}
