// Left list: projects with their chats and a Memory node nested in one tree. Status dot per row (idle, working, needs you),
// an unread mark when a chat finished after the owner last looked, and a question count badge.
import { call } from "./api.js";
import { esc, clip } from "./format.js";
import { emit, fail, state } from "./state.js";

const tree = document.querySelector("#tree");
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
  chatsByProject.set(
    projectId,
    chats.filter((chat) => !chat.archived).map((chat) => ({ id: chat.id, title: chat.title })),
  );
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
              return `<button type="button" role="treeitem" class="tree-chat${current ? " current" : ""}" data-project-id="${esc(project.id)}" data-chat="${esc(chat.id)}" aria-current="${current}">${dot(activity)}<span class="name">${esc(clip(chat.title, 40))}</span>${unread ? `<span class="unread" aria-label="unread"></span>` : ""}${selected && index < 9 ? `<kbd>${index + 1}</kbd>` : ""}</button>`;
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
}
tree.addEventListener("click", async (event) => {
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
  const items = [...tree.querySelectorAll("button")],
    index = items.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
});
