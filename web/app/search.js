import {
  api,
  closeDialog,
  dialog,
  dialogVersion,
  getProjectId,
  getView,
  html,
  onProjectChange,
  onRender,
  registerActions,
  setTab,
  showDialog,
  tab,
  uiAction,
} from "./shell.js";
import { esc } from "./format.js";
import { changeChat, chatId, refresh, renderWorkingPill, setStickToBottom } from "./chat.js";
import { inspectThread } from "./workers.js";
import { knowledgeRead, uploadOpen } from "./knowledge.js";
import { modelCache } from "./settings.js";
import { when } from "./observability.js";

// Full-text search: the dialog's latest query/results, and the message a jump must render, highlight and scroll to.
export let searchState = { seq: 0, project: null, query: "", terms: [], results: [], active: 0 },
  searchTimer = null,
  searchFocus = null,
  workerFocus = null;
onProjectChange(() => {
  searchFocus = null;
  workerFocus = null;
});

onRender(applySearchFocus);

export function renderModelCycle() {
  const button = document.querySelector("#model-cycle"),
    reference = getView()?.project?.model;
  button.hidden = !reference;
  if (!reference) return;
  const name = modelCache.get(reference)?.name ?? reference.split("/").at(-1);
  button.textContent = name;
  button.title = `${reference}. Next scoped model (Ctrl+P); previous with Shift+Ctrl+P.`;
  button.setAttribute("aria-label", `Coordinator model: ${name}. Switch to the next scoped model.`);
}
// Search UI (Cmd/Ctrl+K): one project's chats (archived too), worker threads, knowledge and uploads. Results jump to the place and highlight it.
function termPattern(terms) {
  return terms.length
    ? new RegExp(
        terms
          .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .sort((a, b) => b.length - a.length)
          .join("|"),
        "giu",
      )
    : null;
}
function highlight(text, terms) {
  const pattern = termPattern(terms);
  if (!pattern) return esc(text);
  let out = "",
    last = 0;
  for (const match of text.matchAll(pattern)) {
    out += `${esc(text.slice(last, match.index))}<mark>${esc(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return out + esc(text.slice(last));
}
// Wraps every term match in rendered text nodes; returns the marks in document order.
function markTerms(root, terms) {
  const pattern = termPattern(terms),
    marks = [];
  if (!root || !pattern) return marks;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("mark, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue,
      matches = [...text.matchAll(pattern)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of matches) {
      fragment.append(text.slice(last, match.index));
      const mark = document.createElement("mark");
      mark.className = "search-mark";
      mark.textContent = match[0];
      fragment.append(mark);
      marks.push(mark);
      last = match.index + match[0].length;
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
  return marks;
}
// Marks the terms and scrolls to the match at or after `offset` of the source text (counted by matches before it).
export function markAt(root, terms, text, offset) {
  const marks = markTerms(root, terms),
    pattern = termPattern(terms);
  if (!marks.length) return;
  const before = [...[...text].slice(0, Math.max(0, offset)).join("").matchAll(pattern)].length;
  const mark = marks[Math.min(before, marks.length - 1)];
  mark.classList.add("current");
  mark.scrollIntoView({ block: "center" });
}
export function focusNode(node, focus) {
  if (!node) return false;
  if (!node.classList.contains("search-focus")) {
    node.classList.add("search-focus");
    if (node.matches("details")) node.open = true;
    markTerms(node.querySelector(".text, .report-body") ?? node, focus.terms);
  }
  if (!focus.scrolled) {
    focus.scrolled = true;
    node.scrollIntoView({ block: "center" });
    requestAnimationFrame(() => node.isConnected && node.scrollIntoView({ block: "center" }));
  }
  return true;
}
function applySearchFocus() {
  if (
    !searchFocus ||
    searchFocus.project !== getProjectId() ||
    searchFocus.chat !== chatId ||
    getView()?.chatId !== chatId ||
    tab !== "coordinator"
  )
    return;
  const first = !searchFocus.scrolled;
  if (focusNode(document.querySelector(`#messages [data-index="${searchFocus.index}"]`), searchFocus) && first) {
    setStickToBottom(false);
    renderWorkingPill();
  }
}
function openSearch() {
  if (!getProjectId()) return;
  const query = searchState.project === getProjectId() ? searchState.query : "";
  showDialog(
    "Search",
    `<div class="search-box"><input id="search-input" type="search" placeholder="Search chats, workers, knowledge and files…" aria-label="Search this project" aria-controls="search-results" autocomplete="off" spellcheck="false" value="${esc(query)}"><p class="note search-scope">${esc(getView()?.project.name ?? "This project")}: every chat (archived too), worker threads, knowledge and uploaded files. ↑↓ to move, Enter to open.</p><div id="search-results" role="listbox" aria-label="Search results"></div></div>`,
  );
  const input = dialog.querySelector("#search-input");
  input.focus();
  input.select();
  if (query) renderSearchResults();
  else dialog.querySelector("#search-results").innerHTML = '<p class="note">Type a word to search.</p>';
}
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(), 180);
}
async function runSearch() {
  const input = dialog.querySelector("#search-input");
  if (!input || !dialog.open) return;
  const query = input.value.trim(),
    id = getProjectId(),
    seq = ++searchState.seq,
    version = dialogVersion,
    box = dialog.querySelector("#search-results");
  if (!query) {
    searchState = { ...searchState, project: id, query: "", terms: [], results: [], active: 0 };
    box.innerHTML = '<p class="note">Type a word to search.</p>';
    return;
  }
  box.setAttribute("aria-busy", "true");
  let reply = null,
    failure = null;
  try {
    reply = await api({ action: "search", id, query, limit: 30 });
  } catch (error) {
    failure = error;
  }
  // A slower earlier query, a closed dialog or another project never overwrites the newest list.
  if (seq !== searchState.seq || version !== dialogVersion || id !== getProjectId() || !box.isConnected) return;
  box.removeAttribute("aria-busy");
  if (failure) {
    searchState = { ...searchState, project: id, query, terms: [], results: [], active: 0 };
    box.innerHTML = `<p class="note">${esc(failure.message.replace(/^Search query needs/, "Search needs"))}</p>`;
    return;
  }
  searchState = { ...searchState, project: id, query, terms: reply.terms, results: reply.results, active: 0 };
  renderSearchResults();
}
function searchWhere(hit) {
  switch (hit.source) {
    case "chat":
      return [
        "Chat",
        `${hit.chat}${hit.archived ? " (archived)" : ""} · ${hit.role === "user" ? (/^\[(Durable work|Child work|Owner-local event)/.test(hit.snippet) ? "Report" : "You") : "Coordinator"}`,
      ];
    case "worker":
      return [hit.child ? "Sub-agent" : "Worker", `${hit.label} · ${hit.role === "user" ? "Task" : "Worker"}`];
    case "knowledge":
      return ["Knowledge", hit.path];
    default:
      return ["File", hit.filename];
  }
}
function renderSearchResults() {
  const box = dialog.querySelector("#search-results");
  if (!box) return;
  const { results, terms, active } = searchState;
  box.innerHTML = results.length
    ? results
        .map((hit, i) => {
          const [kind, where] = searchWhere(hit);
          return `<button type="button" class="search-row${i === active ? " active" : ""}" role="option" aria-selected="${i === active}" data-action="search-open" data-i="${i}" data-source="${esc(hit.source)}"><span class="search-kind">${esc(kind)}</span><span class="search-where" title="${esc(where)}">${esc(where)}</span><small>${hit.at ? esc(when(hit.at)) : ""}</small><span class="search-snippet">${highlight(hit.snippet, terms)}</span></button>`;
        })
        .join("")
    : `<p class="note">No matches for “${esc(searchState.query)}”.</p>`;
  box.querySelector(".search-row.active")?.scrollIntoView({ block: "nearest" });
}
async function openSearchHit(i) {
  const hit = searchState.results[i],
    id = getProjectId();
  if (!hit || searchState.project !== id) return;
  const focus = { project: id, index: hit.index, terms: searchState.terms, offset: hit.offset, scrolled: false };
  // The dialog's close event lands a task later and bumps dialogVersion; let it pass before opening the target.
  if (dialog.open) {
    const closed = new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
    closeDialog();
    await closed;
  }
  if (id !== getProjectId()) return;
  if (hit.source === "chat") {
    searchFocus = { ...focus, chat: hit.chatId };
    if (tab !== "coordinator") setTab("coordinator");
    if (hit.chatId === chatId && getView()?.chatId === chatId) {
      html.delete("#messages");
      await refresh();
    } else changeChat(hit.chatId);
  } else if (hit.source === "worker") {
    workerFocus = { ...focus, threadId: hit.threadId };
    await inspectThread(hit.threadId, Math.max(0, hit.index - 5));
  } else if (hit.source === "knowledge") await knowledgeRead(hit.path, focus);
  else await uploadOpen(hit.uploadId, focus);
}
registerActions({
  search() {
    openSearch();
  },
  async "search-open"(node) {
    await openSearchHit(Number(node.dataset.i));
  },
});
document.addEventListener("input", (event) => {
  if (event.target.id === "search-input") scheduleSearch();
});
document.querySelector(".search-kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "k" && !event.isComposing) {
    event.preventDefault();
    openSearch();
    return;
  }
  if (event.target.id === "search-input" && !event.isComposing) {
    const count = searchState.results.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
      event.preventDefault();
      searchState.active = (searchState.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
      renderSearchResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(searchTimer);
      if (searchState.query === event.target.value.trim() && count) void uiAction(() => openSearchHit(searchState.active));
      else void runSearch();
    }
  }
});
export function setSearchFocus(value) {
  return (searchFocus = value);
}

export function setWorkerFocus(value) {
  return (workerFocus = value);
}
