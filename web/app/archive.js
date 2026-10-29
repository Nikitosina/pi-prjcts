import { api, dlgBtn, registerActions, registerForms, setDialogBody, showDialog, showError } from "./shell.js";
import { esc, clip } from "./format.js";
import { chatMessageHtml } from "./chat.js";
import { when } from "./observability.js";
import { bindTranscript, displayMessages, forget, hasOlder, hydrate, loadOlder, loadedItems, mergeNewest } from "./transcript.js";

// Archive: the chats and worker transcripts of the old host, read-only. The host opens the old home's databases read-only; this view only lists and pages.
const WORKERS_PER_PAGE = 50;
let state = null;

const transcriptKey = () => `archive/${state.project.projectId}/${state.conversation.id}`;
const read = (action, input = {}) => api({ action, ...input });

async function openArchive() {
  showDialog("Archive", '<p class="note">Reading the old host…</p>', "Read-only copy of an earlier host's projects");
  state = { config: await read("archive-config"), projects: null, project: null, conversation: null, shown: WORKERS_PER_PAGE };
  await showProjects();
}

function homeForm(config) {
  return `<form data-archive-home class="row archive-home"><label>Old host folder<input name="home" value="${esc(config.home)}" spellcheck="false" autocomplete="off" required></label><button type="submit">Use folder</button></form><p class="note">Default ${esc(config.default)}. Opened read-only; point it at a copy while the old host may still run.</p>`;
}

async function showProjects() {
  state.project = state.conversation = null;
  let body;
  try {
    const { projects } = await read("archive-projects");
    state.projects = projects;
    body = projects.length
      ? `<ul class="archive-list">${projects
          .map(
            (project) =>
              `<li><button type="button" class="archive-row" data-action="archive-project" data-project-id="${esc(project.projectId)}"><b>${esc(project.name)}</b><small>${(project.bytes / 1048576).toFixed(0)} MB</small></button></li>`,
          )
          .join("")}</ul>`
      : '<p class="note">No old projects in this folder.</p>';
  } catch (error) {
    body = `<p class="dialog-error" role="alert">${esc(error.message)}</p>`;
  }
  setDialogBody(`${homeForm(state.config)}${body}`);
}

async function showProject(projectId) {
  const project = await read("archive-project", { projectId });
  state.project = { projectId, name: state.projects?.find((item) => item.projectId === projectId)?.name ?? projectId, ...project };
  state.conversation = null;
  const chats = project.chats
    .map(
      (chat) =>
        `<li><button type="button" class="archive-row" data-action="archive-open" data-conversation="${chat.conversationId}" data-title="${esc(chat.title)}"><b>${esc(chat.title)}</b><small>${chat.main ? "Main · " : ""}${chat.archived ? "archived · " : ""}${esc(when(chat.createdAt))}</small></button></li>`,
    )
    .join("");
  const workers = project.workers.slice(0, state.shown);
  setDialogBody(
    `<p>${dlgBtn("← Projects", { action: "archive-projects" }, "ghost small")} <b>${esc(state.project.name)}</b></p>${project.warnings.length ? `<p class="note">${esc(project.warnings.join("; "))}</p>` : ""}<h3>Chats</h3><ul class="archive-list">${chats || '<li class="note">No chats.</li>'}</ul><h3>Workers (${project.workers.length})</h3><ul class="archive-list">${workers
      .map(
        (worker) =>
          `<li><button type="button" class="archive-row" data-action="archive-open" data-conversation="${worker.conversationId}" data-title="${esc(`${worker.role} · ${clip(worker.task, 60)}`)}"><b>${esc(worker.role)} · ${esc(worker.status)}</b><small>${esc(clip(worker.task, 120))}${worker.startedAt ? ` · ${esc(when(worker.startedAt))}` : ""}</small></button></li>`,
      )
      .join(
        "",
      )}</ul>${project.workers.length > workers.length ? `<p>${dlgBtn("More workers", { action: "archive-more-workers" }, "ghost small")}</p>` : ""}`,
  );
}

async function showConversation(conversationId, title) {
  state.conversation = { id: conversationId, title };
  forget(transcriptKey());
  setDialogBody(
    `<p>${dlgBtn("← " + state.project.name, { action: "archive-back" }, "ghost small")} <b>${esc(title)}</b></p><div class="archive-transcript transcript" aria-live="polite"><p class="note">Reading…</p></div>`,
  );
  const root = document.querySelector("#dialog .archive-transcript");
  bindTranscript(root, {
    text: (ref, offset) => read("archive-text", { projectId: state.project.projectId, conversationId, ref, offset, limit: 20000 }),
    image: (ref) => read("archive-image", { projectId: state.project.projectId, conversationId, ref }),
  });
  root.addEventListener(
    "scroll",
    () => {
      if (root.scrollTop < 80 && hasOlder(transcriptKey())) void older(root).catch(showError);
    },
    { passive: true },
  );
  const page = await read("archive-history", { projectId: state.project.projectId, conversationId });
  mergeNewest(transcriptKey(), page);
  paint(root, true);
}

function paint(root, bottom = false) {
  const messages = displayMessages(loadedItems(transcriptKey())).map((message) => chatMessageHtml(message, "Assistant"));
  root.innerHTML =
    (hasOlder(transcriptKey()) ? '<button type="button" class="ghost small" data-action="archive-older">Older messages</button>' : "") +
    (messages.join("") || '<p class="note">No messages.</p>');
  if (bottom) root.scrollTop = root.scrollHeight;
  hydrate(root);
}

let loading = false;
async function older(root) {
  if (loading) return;
  loading = true;
  const before = { height: root.scrollHeight, top: root.scrollTop },
    key = transcriptKey(),
    { projectId } = state.project,
    conversationId = state.conversation.id;
  try {
    if (await loadOlder(key, (cursor) => read("archive-history", { projectId, conversationId, before: cursor }))) {
      paint(root);
      root.scrollTop = before.top + root.scrollHeight - before.height;
    }
  } finally {
    loading = false;
  }
}

registerActions({
  async archive() {
    await openArchive();
  },
  async "archive-projects"() {
    await showProjects();
  },
  async "archive-project"(node) {
    state.shown = WORKERS_PER_PAGE;
    await showProject(node.dataset.projectId);
  },
  async "archive-more-workers"() {
    state.shown += WORKERS_PER_PAGE;
    await showProject(state.project.projectId);
  },
  async "archive-open"(node) {
    await showConversation(Number(node.dataset.conversation), node.dataset.title);
  },
  async "archive-back"() {
    await showProject(state.project.projectId);
  },
  async "archive-older"() {
    await older(document.querySelector("#dialog .archive-transcript"));
  },
});
registerForms([
  [
    "[data-archive-home]",
    async (form) => {
      state.config = await read("archive-config", { home: new FormData(form).get("home").trim() });
      await showProjects();
    },
  ],
]);
