import { changeProject, getProjectId, getView, onProjectChange, onRender, projects, registerActions, setTab } from "./shell.js";
import { backgroundChatState, changeChat, chatId, chatState, stateDot } from "./chat.js";
import { clip, esc } from "./format.js";

// Browser-style tabs: one per open coordinator chat, kept per browser. A tab is only a pointer (project + chat) plus the last names seen.
const KEY = "pi-projects-tabs";
const load = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((tab) => typeof tab?.project === "string" && typeof tab?.chat === "string").slice(0, 30)
      : [];
  } catch {
    return [];
  }
};
let tabs = load();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {}
};
const same = (tab, project, chat) => tab.project === project && tab.chat === chat;

function sync(project, chat) {
  if (!project) return;
  if (!tabs.some((tab) => same(tab, project, chat))) tabs.push({ project, chat, title: chat === "main" ? "Main" : "Chat", name: "" });
}
// Names and liveness come from what this page has loaded: the open project's chats, the host's project list for the others.
function refresh() {
  const view = getView(),
    known = new Set(projects.map((project) => project.id));
  if (projects.length) tabs = tabs.filter((tab) => known.has(tab.project));
  if (view?.chats && view.project.id === getProjectId())
    tabs = tabs.filter((tab) => tab.project !== view.project.id || tab.chat === chatId || view.chats.some((chat) => chat.id === tab.chat));
  for (const tab of tabs) {
    const project = projects.find((item) => item.id === tab.project);
    if (project) tab.name = project.name;
    const chat = tab.project === getProjectId() ? view?.chats?.find((item) => item.id === tab.chat) : null;
    if (chat) tab.title = chat.title;
  }
}
const stateOf = (tab) => {
  const view = getView(),
    project = projects.find((item) => item.id === tab.project);
  if (tab.project === getProjectId() && view?.chats) {
    const chat = view.chats.find((item) => item.id === tab.chat);
    return chat ? chatState(chat) : { state: "idle", label: "Idle" };
  }
  return backgroundChatState(project, tab.chat);
};

function draw() {
  sync(getProjectId(), chatId);
  refresh();
  save();
  const strip = document.querySelector("#tab-strip");
  strip.hidden = tabs.length < 2;
  const html = tabs
    .map((tab, index) => {
      const on = same(tab, getProjectId(), chatId),
        { state, label } = stateOf(tab),
        text = `${tab.name || "Project"} · ${tab.title}`;
      return `<div class="chat-tab ${on ? "on" : ""}" role="presentation"><button type="button" role="tab" aria-selected="${on}" class="chat-tab-open" data-action="tab-select" data-index="${index}" title="${esc(text)}">${stateDot(state, label, "chat-dot")}<span class="chat-tab-name">${esc(clip(tab.name, 18))}</span><span class="chat-tab-title">${esc(clip(tab.title, 24))}</span></button><button type="button" class="chat-tab-close" data-action="tab-close" data-index="${index}" aria-label="Close ${esc(text)}" title="Close tab">×</button></div>`;
    })
    .join("");
  if (strip.dataset.html === html) return;
  strip.dataset.html = html;
  strip.innerHTML = html;
  strip.querySelector(".chat-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function open(tab) {
  setTab("coordinator");
  if (tab.project !== getProjectId()) changeProject(tab.project, tab.chat);
  else changeChat(tab.chat);
}
function close(index) {
  const tab = tabs[index];
  if (!tab || tabs.length < 2) return;
  const wasOpen = same(tab, getProjectId(), chatId);
  tabs.splice(index, 1);
  save();
  if (wasOpen) open(tabs[Math.min(index, tabs.length - 1)]);
  else draw();
}
registerActions({
  "tab-select"(node) {
    const tab = tabs[Number(node.dataset.index)];
    if (tab && !same(tab, getProjectId(), chatId)) open(tab);
  },
  "tab-close"(node) {
    close(Number(node.dataset.index));
  },
});
document.addEventListener("auxclick", (event) => {
  const node = event.target.closest?.("#tab-strip .chat-tab-open");
  if (event.button === 1 && node) {
    event.preventDefault();
    close(Number(node.dataset.index));
  }
});
// A deep link or a project switch opens its tab at once; later renders keep names and dots current.
onProjectChange((project, chat) => {
  sync(project, chat);
  draw();
});
onRender(draw);
