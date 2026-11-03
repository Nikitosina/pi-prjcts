// Memory (knowledge reimagined): the project's Preferences, Decisions and Procedures. Reads `memory-index` when the host has it,
// otherwise `knowledge-list` classified by folder as docs/ui2-contract.md describes. Entries open and save through knowledge-read/-write.
import { call, contract, isUnavailable, UNAVAILABLE_TEXT } from "./api.js";
import { ago, esc, markdown } from "./format.js";
import { fail, stale, state, toast } from "./state.js";

const KINDS = [
  { id: "preference", label: "Preferences", one: "Preference" },
  { id: "decision", label: "Decisions", one: "Decision" },
  { id: "procedure", label: "Procedures", one: "Procedure" },
];
const UUID_NAME = /(^|\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[^/]*$/;

export function memoryKind(path) {
  if (path === "preferences.md" || path.startsWith("preferences/")) return "preference";
  if (path.startsWith("decisions/")) return "decision";
  if (path.startsWith("runbooks/") || path.startsWith("procedures/")) return "procedure";
  if (path.startsWith("research/legacy/") || path.startsWith("plans/") || path.startsWith("archive/") || UUID_NAME.test(path))
    return "archive";
  return "other";
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

export async function loadMemory() {
  const gen = state.generation,
    projectId = state.projectId;
  const index = await contract("memory-index", { projectId });
  if (stale(gen)) return null;
  if (!isUnavailable(index)) {
    cache = { projectId, entries: index.entries, source: "index", brokenLinks: index.brokenLinks ?? [] };
    return cache;
  }
  const list = await call("knowledge-list", { id: projectId });
  if (stale(gen)) return null;
  const entries = list
    .filter((item) => item.path !== "MEMORY.md")
    .map((item) => ({
      path: item.path,
      kind: memoryKind(item.path),
      title: memoryTitle(item.path),
      summary: "",
      status: "", // unknown until memory-index lands
      revision: item.revision,
      updatedAt: item.updatedAt,
      author: item.author,
      size: item.size,
    }))
    .filter((item) => item.kind !== "archive");
  cache = { projectId, entries, source: "folders", brokenLinks: [] };
  return cache;
}

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
  const other = memory.entries.filter((entry) => !KINDS.some((kind) => kind.id === entry.kind) && match(entry));
  const row = (entry) =>
    `<li><button type="button" class="mem-entry" data-memory="${esc(entry.path)}"><span class="mem-title">${esc(entry.title)}</span>${entry.status ? `<span class="badge st-${esc(entry.status)}">${esc(entry.status)}</span>` : ""}${entry.summary ? `<span class="mem-summary">${esc(entry.summary)}</span>` : ""}<span class="mem-meta mono">${esc(entry.path)} · ${esc(ago(entry.updatedAt))}${entry.lastConfirmedAt ? ` · confirmed ${esc(ago(entry.lastConfirmedAt))}` : ""}</span></button>${entry.source?.chatId ? `<button type="button" class="link-btn" data-source-chat="${esc(entry.source.chatId)}">source ↗</button>` : ""}</li>`;
  const html = groups
    .map(
      (group) =>
        `<section class="mem-group"><h2>${esc(group.label)} <span class="count">${group.items.length}</span></h2>${group.items.length ? `<ul>${group.items.map(row).join("")}</ul>` : `<p class="muted small">None yet.</p>`}</section>`,
    )
    .join("");
  const head = root.querySelector(".focus-head").outerHTML;
  root.innerHTML = `${head}<div class="mem-tools"><input type="search" id="memory-search" placeholder="Search memory" aria-label="Search memory" value="${esc(query)}" /><span class="muted small">${memory.source === "index" ? `${memory.entries.length} entries${memory.brokenLinks.length ? ` · ${memory.brokenLinks.length} broken links` : ""}` : `Grouped by folder · ${UNAVAILABLE_TEXT.toLowerCase()} for status and summaries`}</span></div>${html}${other.length ? `<section class="mem-group"><h2>Other files <span class="count">${other.length}</span></h2><ul>${other.map(row).join("")}</ul></section>` : ""}`;
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
    root.innerHTML = `<div class="focus-head"><button type="button" class="back" data-cmd="leave-focus" aria-label="Back">← <kbd>Esc</kbd></button><h1>${esc(entry?.title ?? memoryTitle(path))}</h1>${kind ? `<span class="badge">${esc(kind.one)}</span>` : ""}${entry ? `${entry.status ? `<span class="badge st-${esc(entry.status)}">${esc(entry.status)}</span>` : ""}` : ""}<span class="grow"></span>${editing ? "" : `<button type="button" class="ghost-btn small" data-edit-memory>Edit</button>`}</div><p class="mono muted small">${esc(path)} · rev ${esc(doc.revision.slice(0, 8))} · ${esc(ago(doc.updatedAt))} by ${esc(doc.author)}${entry?.supersededBy ? ` · superseded by <button type="button" class="link-btn" data-memory="${esc(entry.supersededBy)}">${esc(memoryTitle(entry.supersededBy))}</button>` : ""}</p>${editing ? `<form class="mem-edit"><textarea aria-label="Memory text" maxlength="32000">${esc(doc.text)}</textarea><div class="row"><button type="submit" class="primary small">Save</button><button type="button" class="ghost-btn small" data-cancel>Cancel</button><span class="muted small">Saves a new revision; history is kept.</span></div></form>` : `<article class="prose doc">${markdown(doc.text)}</article>`}`;
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
