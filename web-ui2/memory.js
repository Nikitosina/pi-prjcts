// Memory (knowledge reimagined): the project's Preferences, Decisions and Procedures from `memory-index`, with the archive behind a
// toggle and broken links listed. Entries open and save through knowledge-read/-write; chat rows undo a write with `memory-undo`.
import { call } from "./api.js";
import { ago, esc, markdown } from "./format.js";
import { fail, stale, state, toast } from "./state.js";

const KINDS = [
  { id: "preference", label: "Preferences", one: "Preference" },
  { id: "decision", label: "Decisions", one: "Decision" },
  { id: "procedure", label: "Procedures", one: "Procedure" },
];
const UUID_NAME = /(^|\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[^/]*$/;

/** The folder rule of docs/ui2-contract.md, for chat rows that only know a path; the Memory view uses the host's kinds. */
export function memoryKind(path) {
  if (path === "preferences.md") return "preference";
  if (path.startsWith("decisions/")) return "decision";
  if (path === "MEMORY.md" || path.startsWith("research/") || path.startsWith("plans/") || UUID_NAME.test(path)) return "archive";
  return "procedure";
}
export function memoryTitle(path) {
  const base = String(path).split("/").pop().replace(/\.md$/, "");
  if (base === "preferences") return "Preferences";
  return (
    base
      .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
      .replace(/[-_]+/g, " ")
      .replace(/^./, (c) => c.toUpperCase()) || path
  );
}

let cache = { projectId: null, entries: [], source: "", brokenLinks: [] };
let query = "";

let archive = false;
export async function loadMemory() {
  const gen = state.generation,
    projectId = state.projectId;
  const index = await call("memory-index", { projectId, ...(archive ? { includeArchive: true } : {}) });
  if (stale(gen)) return null;
  cache = { projectId, entries: index.entries, brokenLinks: index.brokenLinks ?? [] };
  return cache;
}
export const memoryEntry = (path) => (cache.projectId === state.projectId ? cache.entries.find((item) => item.path === path) : null);

/** The Memory list in the center. */
export async function renderMemoryList(root) {
  root.innerHTML = `<div class="focus-head"><button type="button" class="back" data-cmd="leave-focus" aria-label="Back to chat">← <kbd>Esc</kbd></button><h1>Memory</h1><span class="scope">Project</span><button type="button" class="info" data-info="What agents remember about this project. Preferences go into every prompt; decisions and procedures are read on demand. Edits keep revision history." aria-label="About memory">ⓘ</button></div><p class="loading-line">Loading memory…</p>`;
  const gen = state.generation;
  let memory;
  try {
    memory = await loadMemory();
  } catch (error) {
    if (stale(gen) || !root.isConnected) return;
    root.querySelector(".loading-line").outerHTML =
      `<p class="error-line">Could not read memory: ${esc(error.message)} <button type="button" class="link-btn" data-retry-memory>Retry</button></p>`;
    root.querySelector("[data-retry-memory]").addEventListener("click", () => void renderMemoryList(root));
    return;
  }
  if (stale(gen) || !memory || !root.isConnected) return;
  paintList(root, memory);
}
function paintList(root, memory) {
  const q = query.toLowerCase();
  const match = (entry) => !q || `${entry.title} ${entry.summary} ${entry.path}`.toLowerCase().includes(q);
  const groups = KINDS.map((kind) => ({ ...kind, items: memory.entries.filter((entry) => entry.kind === kind.id && match(entry)) }));
  const archived = memory.entries.filter((entry) => entry.kind === "archive" && match(entry));
  const row = (entry) =>
    `<li><button type="button" class="mem-entry" data-memory="${esc(entry.path)}"><span class="mem-title">${esc(entry.title)}</span>${entry.status && entry.status !== "current" ? `<span class="badge st-${esc(entry.status)}">${esc(entry.status)}</span>` : ""}${entry.supersededBy ? `<span class="muted small">→ ${esc(memoryTitle(entry.supersededBy))}</span>` : ""}${entry.summary ? `<span class="mem-summary">${esc(entry.summary)}</span>` : ""}<span class="mem-meta mono">${esc(entry.path)} · ${esc(ago(entry.updatedAt))}${entry.lastConfirmedAt ? ` · confirmed ${esc(ago(entry.lastConfirmedAt))}` : ""}</span></button>${entry.source?.chatId ? `<button type="button" class="link-btn" data-source-chat="${esc(entry.source.chatId)}">source ↗</button>` : ""}</li>`;
  const html = groups
    .map(
      (group) =>
        `<section class="mem-group"><h2>${esc(group.label)} <span class="count">${group.items.length}</span></h2>${group.items.length ? `<ul>${group.items.map(row).join("")}</ul>` : `<p class="muted small">None yet.</p>`}</section>`,
    )
    .join("");
  const head = root.querySelector(".focus-head").outerHTML;
  const broken = memory.brokenLinks.length
    ? `<section class="mem-group broken"><h2>Broken links <span class="count needs">${memory.brokenLinks.length}</span></h2><ul>${memory.brokenLinks.map((link) => `<li class="small"><button type="button" class="link-btn" data-memory="${esc(link.from)}">${esc(memoryTitle(link.from))}</button> <span class="muted">→ <span class="mono">${esc(link.to)}</span> is missing</span></li>`).join("")}</ul></section>`
    : "";
  const current = memory.entries.filter((entry) => entry.kind !== "archive").length;
  root.innerHTML = `${head}<div class="mem-tools"><input type="search" id="memory-search" placeholder="Search memory" aria-label="Search memory" value="${esc(query)}" /><span class="muted small">${current} ${current === 1 ? "entry" : "entries"}</span><span class="grow"></span><label class="mem-archive small"><input type="checkbox" id="memory-archive" ${archive ? "checked" : ""} /> Show archive</label></div>${broken}${html}${archive ? `<section class="mem-group archive"><h2>Archive <span class="count">${archived.length}</span></h2>${archived.length ? `<ul>${archived.map(row).join("")}</ul>` : `<p class="muted small">Nothing archived.</p>`}</section>` : ""}`;
  root.querySelector("#memory-archive").addEventListener("change", (event) => {
    archive = event.target.checked;
    void renderMemoryList(root);
  });
  const search = root.querySelector("#memory-search");
  search.addEventListener("input", () => {
    query = search.value;
    const at = search.selectionStart;
    paintList(root, memory);
    const next = root.querySelector("#memory-search");
    next.focus();
    next.setSelectionRange(at, at);
  });
}

/** Kind, status and source live in optional front matter; the read view shows them as badges, Edit keeps them in the text. */
const withoutFrontMatter = (text) => text.replace(/^---\n[\s\S]*?\n---\n?/, "");

/** One entry in the center: rendered, with Edit (revision-checked through knowledge-write). */
export async function renderMemoryEntry(root, path, edit = false) {
  const gen = state.generation;
  root.innerHTML = `<div class="focus-head"><button type="button" class="back" data-cmd="leave-focus" aria-label="Back">← <kbd>Esc</kbd></button><h1>${esc(memoryTitle(path))}</h1></div><p class="loading-line">Loading…</p>`;
  let doc;
  try {
    doc = await call("knowledge-read", { id: state.projectId, path });
  } catch (error) {
    if (stale(gen)) return;
    root.querySelector(".loading-line").textContent = error.message;
    return;
  }
  if (stale(gen) || !root.isConnected) return;
  const entry = cache.entries.find((item) => item.path === path);
  const kind = KINDS.find((item) => item.id === (entry?.kind ?? memoryKind(path)));
  const paint = (editing) => {
    root.innerHTML = `<div class="focus-head"><button type="button" class="back" data-cmd="leave-focus" aria-label="Back">← <kbd>Esc</kbd></button><h1>${esc(entry?.title ?? memoryTitle(path))}</h1>${kind ? `<span class="badge">${esc(kind.one)}</span>` : ""}${entry ? `${entry.status ? `<span class="badge st-${esc(entry.status)}">${esc(entry.status)}</span>` : ""}` : ""}<span class="grow"></span>${editing ? "" : `<button type="button" class="ghost-btn small" data-edit-memory>Edit</button>`}</div><p class="mono muted small">${esc(path)} · rev ${esc(doc.revision.slice(0, 8))} · ${esc(ago(doc.updatedAt))} by ${esc(doc.author)}${entry?.supersededBy ? ` · superseded by <button type="button" class="link-btn" data-memory="${esc(entry.supersededBy)}">${esc(memoryTitle(entry.supersededBy))}</button>` : ""}</p>${editing ? `<form class="mem-edit"><textarea aria-label="Memory text" maxlength="32000">${esc(doc.text)}</textarea><div class="row"><button type="submit" class="primary small">Save</button><button type="button" class="ghost-btn small" data-cancel>Cancel</button><span class="muted small">Saves a new revision; history is kept.</span></div></form>` : `${entry?.summary ? `<p class="mem-lede">${esc(entry.summary)}</p>` : ""}<article class="prose doc">${markdown(withoutFrontMatter(doc.text))}</article>`}`;
    root.querySelector("[data-edit-memory]")?.addEventListener("click", () => paint(true));
    root.querySelector("[data-cancel]")?.addEventListener("click", () => paint(false));
    const form = root.querySelector(".mem-edit");
    if (form) {
      form.querySelector("textarea").focus();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = form.querySelector("textarea").value;
        try {
          const saved = await call("knowledge-write", { id: state.projectId, path, text, expectedRevision: doc.revision });
          if (stale(gen)) return;
          doc = { ...doc, ...saved, text };
          toast("Memory saved.");
          paint(false);
        } catch (error) {
          fail(error);
        }
      });
    }
  };
  paint(edit);
}
