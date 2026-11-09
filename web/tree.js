// Left list: projects with their chats and a Memory node nested in one tree. Status dot per row (idle, working, needs you),
// an unread mark when a chat finished after the owner last looked, and a question count badge. Chats other than Main archive from
// their row's button or Mod+Shift+E after a confirmation, with Undo.
import { call } from "./api.js";
import { esc, clip } from "./format.js";
import { binding, display, onBindingsChange } from "./hotkeys.js";
import { emit, fail, state, toast } from "./state.js";

const tree = document.querySelector("#tree");
const archiveDialog = document.querySelector("#archive-chat");
const archiving = new Set(); // `${project}:${chat}` while its archive request runs
const ARCHIVE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3h11v3h-11zM3.5 6v7h9V6M6.5 8.5h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const archiveTitle = () => `Archive chat${binding("archive-chat") ? ` (${display(binding("archive-chat"))})` : ""}`;
const chatsByProject = new Map(); // project id -> [{ id, title }] from the last `show` of that project
const open = new Set();
const SEEN = "pi-ui2-seen";
let seen = {};
try {
  seen = JSON.parse(localStorage.getItem(SEEN) || "{}") || {};
  for (const [id, chats] of Object.entries(JSON.parse(localStorage.getItem("pi-ui2-chats") || "{}") || {})) chatsByProject.set(id, chats);
} catch {}

export async function loadProjects() {
  try {
    const projects = await call("list");
    state.projects = projects.filter((item) => !item.archived && !item.deleted);
    renderTree();
    emit("projects", state.projects);
  } catch (error) {
    fail(error);
  }
}
export function rememberChats(projectId, chats) {
  storeChats(
    projectId,
    chats.filter((chat) => !chat.archived).map((chat) => ({ id: chat.id, title: chat.title })),
  );
}
function storeChats(projectId, chats) {
  chatsByProject.set(projectId, chats);
  try {
    localStorage.setItem("pi-ui2-chats", JSON.stringify(Object.fromEntries(chatsByProject)));
  } catch {}
}
export function markSeen(projectId, chatId) {
  seen[`${projectId}:${chatId}`] = Date.now();
  try {
    localStorage.setItem(SEEN, JSON.stringify(seen));
  } catch {}
}
/** Chats of the selected project in tree order; hotkeys 1–9 pick from this. */
export function visibleChats() {
  return chatsByProject.get(state.projectId) ?? [{ id: "main", title: "Main" }];
}
function dot(activity) {
  if (activity?.needs) return `<span class="dot needs" aria-label="needs you"></span>`;
  if (activity?.working) return `<span class="dot working" aria-label="working"></span>`;
  if (activity?.paused) return `<span class="dot paused" aria-label="paused"></span>`;
  return `<span class="dot idle" aria-hidden="true"></span>`;
}
export function renderTree() {
  open.add(state.projectId);
  // Redraws replace every row: keep keyboard focus on the same row, found by its data attributes.
  const active = document.activeElement,
    focused =
      active instanceof HTMLElement && tree.contains(active)
        ? [...active.attributes]
            .filter((item) => item.name.startsWith("data-"))
            .map((item) => `[${item.name}="${CSS.escape(item.value)}"]`)
            .join("")
        : "";
  tree.innerHTML = state.projects
    .map((project) => {
      const selected = project.id === state.projectId,
        expanded = open.has(project.id);
      const chats = chatsByProject.get(project.id) ?? [{ id: "main", title: "Main" }];
      const questions = project.notice?.questions ?? 0;
      const rows = expanded
        ? chats
            .map((chat, index) => {
              const activity = project.activity?.chats?.[chat.id];
              const unread =
                !!activity?.finishedAt &&
                activity.finishedAt > (seen[`${project.id}:${chat.id}`] ?? 0) &&
                !(selected && chat.id === state.chatId);
              const current = selected && chat.id === state.chatId && state.focus.kind !== "memory";
              const row = `<button type="button" role="treeitem" class="tree-chat${current ? " current" : ""}" data-project-id="${esc(project.id)}" data-chat="${esc(chat.id)}" aria-current="${current}">${dot(activity)}<span class="name">${esc(clip(chat.title, 40))}</span>${unread ? `<span class="unread" aria-label="unread"></span>` : ""}${selected && index < 9 ? `<kbd>${index + 1}</kbd>` : ""}</button>`;
              if (chat.id === "main") return row;
              const pending = archiving.has(`${project.id}:${chat.id}`);
              return `<div class="tree-row" role="none">${row}<button type="button" class="tree-archive" data-project-id="${esc(project.id)}" data-archive-chat="${esc(chat.id)}" aria-label="Archive chat “${esc(clip(chat.title, 40))}”" title="${esc(archiveTitle())}"${pending ? " disabled" : ""}>${ARCHIVE_ICON}</button></div>`;
            })
            .join("") +
          `<button type="button" role="treeitem" class="tree-chat tree-memory${selected && state.focus.kind === "memory" ? " current" : ""}" data-project-id="${esc(project.id)}" data-memory-node><span class="node-icon" aria-hidden="true">◆</span><span class="name">Memory</span></button>` +
          (selected
            ? `<button type="button" class="tree-chat tree-new" data-new-chat="${esc(project.id)}"><span class="node-icon" aria-hidden="true">＋</span><span class="name">New chat</span></button>`
            : "")
        : "";
      return `<div class="tree-project${selected ? " selected" : ""}" role="group"><button type="button" role="treeitem" aria-expanded="${expanded}" class="tree-head" data-project="${esc(project.id)}"><span class="chev" aria-hidden="true">${expanded ? "▾" : "▸"}</span>${dot(project.activity)}<span class="name">${esc(project.name)}</span>${questions ? `<span class="count needs" aria-label="${questions} questions">${questions}</span>` : ""}</button>${rows ? `<div class="tree-children">${rows}</div>` : ""}</div>`;
    })
    .join("");
  if (!state.projects.length) tree.innerHTML = `<p class="muted small empty-line">No projects yet.</p>`;
  if (focused) tree.querySelector(focused)?.focus({ preventScroll: true });
}
onBindingsChange(() => {
  for (const button of tree.querySelectorAll("[data-archive-chat]")) button.title = archiveTitle();
});

export const archiveDialogOpen = () => archiveDialog.open;
export function closeArchiveDialog() {
  if (archiveDialog.open) archiveDialog.close();
}
/** Asks before archiving a chat of `projectId`; the row's button and the archive-chat hotkey both come here. */
export function requestArchive(projectId, chatId) {
  if (chatId === "main") return toast("Main cannot be archived.");
  const chat = chatsByProject.get(projectId)?.find((item) => item.id === chatId);
  if (!chat || archiveDialog.open || archiving.has(`${projectId}:${chatId}`)) return;
  const opener = document.activeElement;
  archiveDialog.innerHTML = `<form method="dialog" class="confirm"><h2 id="archive-chat-title">Archive “${esc(clip(chat.title, 60))}”?</h2><p class="muted">It leaves the list. Its transcript is kept, and Undo brings it back.</p><div class="confirm-actions"><button type="button" class="ghost-btn" data-archive-cancel>Cancel</button><button type="button" class="primary" data-archive-confirm>Archive</button></div></form>`;
  archiveDialog.querySelector("[data-archive-cancel]").addEventListener("click", closeArchiveDialog);
  const confirm = archiveDialog.querySelector("[data-archive-confirm]");
  confirm.addEventListener("click", () => {
    confirm.disabled = true;
    void archive(projectId, chat);
  });
  archiveDialog.addEventListener(
    "close",
    () => {
      // The tree may have redrawn meanwhile: give focus back to the same row's button when the old node is gone.
      const target = opener?.isConnected
        ? opener
        : opener?.dataset?.archiveChat && tree.querySelector(`[data-archive-chat="${CSS.escape(chatId)}"]`);
      if (target instanceof HTMLElement) target.focus();
    },
    { once: true },
  );
  archiveDialog.showModal();
  confirm.focus();
}
async function archive(projectId, chat) {
  const key = `${projectId}:${chat.id}`;
  if (archiving.has(key)) return;
  archiving.add(key);
  renderTree();
  try {
    // Archiving aborts a running turn in the runtime; refuse instead of stopping it behind the owner's back.
    const view = await call("show", { id: projectId, chatId: chat.id });
    if (view.chats?.find((item) => item.id === chat.id)?.busy)
      throw new Error(`“${clip(chat.title, 40)}” is answering. Open it and stop the turn (${display(binding("stop"))}) before archiving.`);
    await call("chat-update", { id: projectId, chatId: chat.id, archived: true });
    closeArchiveDialog();
    const chats = chatsByProject.get(projectId) ?? [],
      index = chats.findIndex((item) => item.id === chat.id),
      rest = chats.filter((item) => item.id !== chat.id);
    storeChats(projectId, rest);
    if (state.projectId === projectId && state.chatId === chat.id)
      emit("select-request", { projectId, chatId: (rest[index] ?? rest[index - 1])?.id ?? "main" });
    toast(`Archived “${clip(chat.title, 40)}”.`, { action: "Undo", onAction: () => void unarchive(projectId, chat, index), ms: 8000 });
  } catch (error) {
    closeArchiveDialog();
    fail(error);
  } finally {
    archiving.delete(key);
    renderTree();
  }
}
async function unarchive(projectId, chat, index) {
  try {
    await call("chat-update", { id: projectId, chatId: chat.id, archived: false });
    const chats = (chatsByProject.get(projectId) ?? []).filter((item) => item.id !== chat.id);
    chats.splice(Math.max(0, index), 0, chat);
    storeChats(projectId, chats);
    emit("select-request", { projectId, chatId: chat.id });
  } catch (error) {
    fail(error);
  }
}

tree.addEventListener("click", async (event) => {
  const archiveButton = event.target.closest("[data-archive-chat]");
  if (archiveButton) return requestArchive(archiveButton.dataset.projectId, archiveButton.dataset.archiveChat);
  const head = event.target.closest("[data-project]");
  if (head) {
    const id = head.dataset.project;
    if (id === state.projectId) {
      open.has(id) ? open.delete(id) : open.add(id);
      renderTree();
    } else {
      open.add(id);
      emit("select-request", { projectId: id, chatId: "main" });
    }
    return;
  }
  const chat = event.target.closest("[data-chat]");
  if (chat) return emit("select-request", { projectId: chat.dataset.projectId, chatId: chat.dataset.chat });
  const memory = event.target.closest("[data-memory-node]");
  if (memory) {
    if (memory.dataset.projectId !== state.projectId) emit("select-request", { projectId: memory.dataset.projectId, chatId: "main" });
    emit("open", { kind: "memory" });
    return;
  }
  const create = event.target.closest("[data-new-chat]");
  if (create) {
    try {
      const chat = await call("chat-create", { id: create.dataset.newChat });
      emit("select-request", { projectId: create.dataset.newChat, chatId: chat.id ?? chat.chat?.id ?? "main" });
    } catch (error) {
      fail(error);
    }
  }
});
// Arrow keys move through the tree like a list.
tree.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [...tree.querySelectorAll("button:not(.tree-archive)")],
    from = document.activeElement?.classList.contains("tree-archive")
      ? document.activeElement.previousElementSibling
      : document.activeElement,
    index = items.indexOf(from);
  if (index < 0) return;
  event.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
});
