// UI 2.0 entry: selection, center focus, streams, status pill and line, hotkeys and the command palette.
// Three areas on every screen: list (left), focus (center), context (right); the Host agent drawer opens over them.
import { setToken, token } from "./api.js";
import { clip, esc } from "./format.js";
import { register, paintHints, onBindingsChange, typing } from "./hotkeys.js";
import { emit, fail, on, project, stale, state, toast } from "./state.js";
import { closeLimitDetail, limitDetailOpen } from "./limit-detail.js";
import { mountUi } from "./ui.js";
import { mountLimits } from "./limits.js";
import { mountDiskDetail } from "./disk-detail.js";
import { mountStatusline } from "./statusline.js";
import { mountTree } from "./tree.js";
import { mountMedia } from "./media.js";
import { mountSlash } from "./slash.js";
import { mountMemory } from "./memory.js";
import { mountChat } from "./chat.js";
import { mountPlugins } from "./plugins.js";
import { mountSidebar } from "./sidebar.js";
import { mountReview } from "./review.js";
import { mountWorkers } from "./workers.js";
import { mountPrompts } from "./prompts.js";
import { mountSettings } from "./settings.js";
import { mountHostagent } from "./hostagent.js";
import { mountPalette } from "./palette.js";
import { hostForPage, hostSwitcher } from "./host-switcher.js";

const client = await hostForPage().catch((error) => {
  if (error.status !== 401) throw error;
  signIn("Open the local inbox link to sign in.");
  // Sign-in reloads this bookmark. Never mount local views as a fallback for a remote host.
  return new Promise(() => {});
});
const ui = mountUi(client);
const limits = mountLimits(client);
const diskDetail = mountDiskDetail(client);
const statusline = mountStatusline(client, ui, limits, diskDetail);
const tree = mountTree(client);
const media = mountMedia(client);
const slash = mountSlash(client);
const memory = mountMemory(client);
const chat = mountChat(client, media, slash, memory);
const plugins = mountPlugins(client);
mountSidebar(client, plugins);
const review = mountReview(client);
const workers = mountWorkers(client, chat, media);
const prompts = mountPrompts(client);
const settings = mountSettings(client, ui, statusline, prompts, limits, plugins);
const hostagent = mountHostagent(client, chat, media);
const palette = mountPalette(client);
const { loadUi, setUi } = ui;
const { paintStatusLine } = statusline;
const { loadLimits } = limits;
const { closeDiskDetail, diskDetailOpen } = diskDetail;
const { archiveDialogOpen, closeArchiveDialog, loadProjects, markSeen, rememberChats, renderTree, requestArchive, visibleChats } = tree;
const { currentChat, loadChat, stopTurn, toggleSteer } = chat;
const { closeReview, renderReview } = review;
const { reviewEntries, closeMergeDialog, loadJobs, loadSide, mergeDialogOpen, renderWorker } = workers;
const { refreshRecentMemory, renderMemoryEntry, renderMemoryList } = memory;
const { closeSettings, openSettings, SECTIONS, settingsBack, settingsOpen, showSection } = settings;
const {
  isOpen: drawerOpen,
  loadApprovals,
  loadHostAgent,
  onHostTopic,
  onTiersChanged,
  pendingApprovals,
  resetHostAgent,
  stopHostAgent,
  toggleHostAgent,
} = hostagent;
const { closePalette, openPalette, paletteOpen, setPaletteSource } = palette;
const { closeSlashMenu, slashMenuOpen } = slash;
const { closeLightbox, lightboxOpen } = media;
export { workers, chat, ui };

const app = document.querySelector("#app"),
  center = document.querySelector("#center"),
  chatView = document.querySelector("#chat-view"),
  focusView = document.querySelector("#focus-view");
let changes = null,
  hostChanges = null;

// ---------------------------------------------------------------------------------------------------------------- selection

async function select(projectId, chatId = "main", { keepFocus = false } = {}) {
  if (!projectId) return;
  const sameProject = projectId === state.projectId;
  if (sameProject && chatId === state.chatId && state.view) {
    if (!keepFocus) leaveFocus();
    return;
  }
  state.generation++;
  state.projectId = projectId;
  state.chatId = chatId;
  state.view = null;
  if (!keepFocus) showChat();
  emit("select", { projectId, chatId });
  const url = new URL(location.href);
  url.searchParams.set("project", projectId);
  chatId === "main" ? url.searchParams.delete("chat") : url.searchParams.set("chat", chatId);
  history.replaceState(null, "", url);
  markSeen(projectId, chatId);
  renderTree();
  paintCrumbs();
  if (!sameProject) {
    changes?.stop();
    const gen = state.generation;
    let connected = false; // the first sync of a stream is the opening read; a later one is a reconnect, after which missed changes are possible
    changes = client.stream(
      `/changes?project=${encodeURIComponent(projectId)}`,
      (change) => {
        if (state.projectId !== projectId) return;
        if (change.t === "sync") {
          emit("plugins-changed");
          void refreshAll();
          void refreshRecentMemory(connected ? { invalidate: true } : { again: true });
          connected = true;
        } else if (change.t === "topic") onTopic(change, gen);
      },
      (up) => {
        state.connected = up;
        emit("connection", up);
        paintStatusLine();
      },
    );
  }
  await refreshAll();
}
on("select-request", ({ projectId, chatId, keepFocus }) => void select(projectId, chatId, { keepFocus }));
async function refreshAll() {
  const gen = state.generation;
  await Promise.all([loadChat(), loadJobs(), loadSide(), loadUsage()]);
  if (stale(gen)) return;
  document.body.dataset.ready = "1";
}
let listTimer = 0;
function onTopic(change) {
  if (change.topic === "chat" && (change.chat === "*" || change.chat === state.chatId || !change.chat)) void loadChat();
  if (change.topic === "jobs") void loadJobs();
  if (change.topic === "settings") {
    emit("prompts-changed");
    emit("plugins-changed");
    void loadChat();
    void loadUsage();
  }
  if (change.topic === "knowledge") {
    void refreshRecentMemory({ again: true });
    if (state.focus.kind === "memory" && !state.focus.path) renderFocus();
  }
  clearTimeout(listTimer);
  listTimer = setTimeout(() => void loadProjects(), 400);
}
on("view", (view) => {
  rememberChats(state.projectId, view.chats ?? []);
  renderTree();
  paintCrumbs();
  paintStatusLine();
  paintPill();
});
on("live", () => paintStatusLine());
on("busy", (busy) => {
  document.body.dataset.busy = busy ? "1" : "0";
  if (!busy) void loadUsage();
});
on("projects-changed", () => void loadProjects());
on("projects", () => {
  paintPill();
  paintCrumbs();
});

// ---------------------------------------------------------------------------------------------------------------- center focus

function showChat() {
  closeReview();
  state.focus = { kind: "chat" };
  center.dataset.focus = "chat";
  focusView.hidden = true;
  focusView.replaceChildren();
  chatView.hidden = false;
  renderTree();
}
function renderFocus() {
  closeReview();
  const focus = state.focus;
  center.dataset.focus = focus.kind;
  chatView.hidden = true;
  focusView.hidden = false;
  focusView.className = `view focus-${focus.kind}`;
  if (focus.kind === "worker") void renderWorker(focusView, focus.id, { steer: focus.steer });
  else if (focus.kind === "pr") void renderReview(focusView, focus);
  else if (focus.kind === "memory" && focus.path) void renderMemoryEntry(focusView, focus.path, focus.edit);
  else if (focus.kind === "memory") void renderMemoryList(focusView);
  renderTree();
  paintCrumbs();
  focusView.querySelector(".back")?.focus({ preventScroll: true });
}
on("open", (focus) => {
  if (settingsOpen()) closeSettings();
  state.focus = { ...focus, from: state.focus.kind === "chat" ? null : state.focus };
  renderFocus();
});
function leaveFocus() {
  if (state.focus.kind === "chat") return false;
  const back = state.focus.from;
  if (back) {
    state.focus = back;
    renderFocus();
  } else showChat();
  paintCrumbs();
  return true;
}
focusView.addEventListener("click", (event) => {
  const source = event.target.closest("[data-source-chat]");
  if (source) void select(state.projectId, source.dataset.sourceChat);
  const memory = event.target.closest(".mem-entry[data-memory], #focus-view .prose [data-memory]");
  if (memory && !event.target.closest(".tool-row")) emit("open", { kind: "memory", path: memory.dataset.memory });
});

// ---------------------------------------------------------------------------------------------------------------- top bar, pill, status line

function paintCrumbs() {
  const name = project()?.name ?? "",
    chat = currentChat()?.title ?? (state.chatId === "main" ? "Main" : "");
  const focus =
    state.focus.kind === "worker"
      ? " › worker"
      : state.focus.kind === "memory"
        ? ` › Memory${state.focus.path ? ` › ${clip(state.focus.path, 40)}` : ""}`
        : state.focus.kind === "pr"
          ? ` › PR #${state.focus.id}`
          : "";
  document.querySelector("#crumbs").innerHTML =
    `<b>${esc(name)}</b>${chat ? `<span class="sep">/</span><span>${esc(chat)}</span>` : ""}<span class="muted">${esc(focus)}</span>`;
  document.title = name ? `${name} · pi-prjcts` : "pi-prjcts";
}
function totals() {
  let working = 0,
    needs = 0;
  for (const item of state.projects) {
    const chats = Object.values(item.activity?.chats ?? {});
    working += chats.length ? chats.filter((chat) => chat.working).length : item.activity?.working ? 1 : 0;
    needs += item.notice?.questions ?? 0;
  }
  if (state.live?.running && !state.projects.find((item) => item.id === state.projectId)?.activity?.chats?.[state.chatId]?.working)
    working++;
  return { working, needs, approvals: pendingApprovals().length };
}
function paintPill() {
  const { working, needs, approvals } = totals(),
    pill = document.querySelector("#status-pill");
  const parts = [];
  if (working) parts.push(`${working} working`);
  if (needs + approvals) parts.push(`${needs + approvals} needs you`);
  pill.querySelector(".pill-text").textContent = parts.join(" · ") || (state.live?.running ? "Answering you" : "All quiet");
  pill.dataset.tone = needs + approvals ? "needs" : working || state.live?.running ? "work" : "idle";
  pill.setAttribute("aria-label", `Status: ${pill.querySelector(".pill-text").textContent}. Jump to it.`);
}
on("live", paintPill);
on("approvals", paintPill);
function jumpToStatus() {
  if (pendingApprovals().length) return toggleHostAgent(true, { at: "approvals" });
  const needs = state.projects.find((item) => item.notice?.questions);
  if (needs) return void select(needs.id, "main").then(() => document.querySelector("#questions textarea")?.focus());
  for (const item of state.projects) {
    const chats = Object.entries(item.activity?.chats ?? {});
    const chat = chats.find(([, value]) => value.working)?.[0];
    // Match totals(): known chat state is authoritative; the aggregate flag can lag behind a just-finished turn.
    if (chat || (!chats.length && item.activity?.working)) return void select(item.id, chat ?? "main");
  }
  toast("Nothing is running and nothing needs you.");
}
async function loadUsage() {
  const gen = state.generation;
  const [usage, profiles] = await Promise.all([
    client.call("usage-snapshot", { id: state.projectId, limit: 1 }).catch(() => null),
    client.call("profiles-get", { projectId: state.projectId }).catch(() => null),
  ]);
  if (stale(gen)) return;
  state.usage = usage;
  state.profiles = profiles?.profiles ?? null;
  state.thinking = state.profiles?.coordinator?.thinking ?? "medium";
  paintStatusLine();
}

// ---------------------------------------------------------------------------------------------------------------- commands and hotkeys

// Narrow screens show the list and context panel as sheets over the chat; the host panel layout stays as it is.
const narrow = matchMedia("(max-width: 760px)");
function toggleSheet(name) {
  app.dataset.sheet = app.dataset.sheet === name ? "" : name;
}
on("select", () => (app.dataset.sheet = ""));
on("open", () => (app.dataset.sheet = ""));
const COMMANDS = {
  "toggle-list": () => (narrow.matches ? toggleSheet("list") : void setUi({ panels: { list: !state.ui.panels.list } })),
  "toggle-context": () => (narrow.matches ? toggleSheet("context") : void setUi({ panels: { context: !state.ui.panels.context } })),
  "host-agent": () => toggleHostAgent(),
  "focus-composer": () => {
    if (state.focus.kind !== "chat") showChat();
    document.querySelector("#composer-input").focus();
  },
  palette: () => (paletteOpen() ? closePalette() : openPalette()),
  settings: () => (settingsOpen() ? closeSettings() : openSettings()),
  stop: () => void (drawerOpen() ? stopHostAgent().then((stopped) => stopped || stopTurn()) : stopTurn()),
  "status-jump": jumpToStatus,
  "new-project": () => toast("New project: ask the Host agent (\\) or run npm run projects -- create <name> <workspace>."),
  "host-agent-reset": () => void resetHostAgent(),
  "leave-focus": leaveTop,
};
/** Esc closes the topmost layer: the "/" menu, palette, settings, drawer, center focus; then leaves the text field. */
// Inside the remote app the relay bootstrap labels the page with its host (relay/bootstrap/host-page.js): name it and link back to the
// host list (scripts/remote-settings-failures.md R8). A local page has no label and no link.
function renderRemoteHost() {
  const name = document.documentElement.dataset.remoteHost;
  if (name === undefined) return;
  const link = document.querySelector("#remote-hosts");
  link.innerHTML = `<span aria-hidden="true">←</span> Hosts <span class="muted">· ${esc(name || "Remote")}</span>`;
  link.hidden = false;
}
document.addEventListener("pi-remote-host", renderRemoteHost);
renderRemoteHost();

function leaveTop() {
  if (lightboxOpen()) return closeLightbox();
  if (archiveDialogOpen()) return closeArchiveDialog();
  if (mergeDialogOpen()) return closeMergeDialog();
  if (limitDetailOpen()) return closeLimitDetail();
  if (diskDetailOpen()) return closeDiskDetail();
  if (slashMenuOpen()) return closeSlashMenu();
  if (paletteOpen()) return closePalette();
  if (app.dataset.sheet) return void (app.dataset.sheet = "");
  if (settingsOpen()) return void (settingsBack() || closeSettings());
  if (drawerOpen()) return toggleHostAgent(false);
  if (leaveFocus()) return;
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
}
const modal = () => archiveDialogOpen() || mergeDialogOpen() || lightboxOpen();
const outside = () => !paletteOpen() && !settingsOpen() && !modal();
const overlays = new Set(["settings", "palette", "stop"]);
for (const [id, run] of Object.entries(COMMANDS))
  register(id, run, {
    when: id === "leave-focus" ? () => true : overlays.has(id) ? () => !modal() : outside,
  });
register("toggle-steer", () => toggleSteer(), { when: outside });
// Only the chat in the center: not while typing, in the worker or Memory view, or with the Host agent drawer open.
register("archive-chat", () => requestArchive(state.projectId, state.chatId), {
  when: (event) => outside() && !typing(event.target) && state.focus.kind === "chat" && !drawerOpen(),
});
for (let i = 1; i <= 9; i++)
  register(
    `chat-${i}`,
    () => {
      const chat = visibleChats()[i - 1];
      if (!chat) return false;
      void select(state.projectId, chat.id);
    },
    { when: outside },
  );
for (const item of SECTIONS) {
  // Appearance answers to the bindings of the four pages it absorbed.
  const ids = item.id === "appearance" ? ["theme", "animations", "display", "statusline"] : [item.id];
  for (const id of ids) register(`settings-${id}`, () => showSection(item.id), { when: () => settingsOpen() });
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cmd]");
  if (button && COMMANDS[button.dataset.cmd]) COMMANDS[button.dataset.cmd]();
});
onBindingsChange(() => paintHints());
on("open-settings", (id) => openSettings(id));
on("profiles", () => void loadUsage());
// ui_focus to a project or chat: straight to the chat, not one step back.
on("leave-focus", () => {
  if (state.focus.kind === "chat") return;
  showChat();
  paintCrumbs();
});

setPaletteSource(() => [
  ...reviewEntries(),
  ...state.projects.flatMap((item) => [
    { id: `p:${item.id}`, label: item.name, hint: "project", run: () => void select(item.id, "main") },
    {
      id: `m:${item.id}`,
      label: `${item.name} › Memory`,
      hint: "memory",
      run: () => void select(item.id, "main").then(() => emit("open", { kind: "memory" })),
    },
  ]),
  ...visibleChats().map((chat) => ({
    id: `c:${chat.id}`,
    label: `${project()?.name ?? ""} › ${chat.title}`,
    hint: "chat",
    run: () => void select(state.projectId, chat.id),
  })),
  { id: "x:host", label: "Host agent", cmd: "host-agent", run: () => toggleHostAgent(true) },
  { id: "x:settings", label: "Settings", cmd: "settings", run: () => openSettings() },
  ...SECTIONS.map((item) => ({
    id: `s:${item.id}`,
    label: `Settings › ${item.label}`,
    hint: item.scope,
    cmd: `settings-${item.id}`,
    run: () => openSettings(item.id),
  })),
  ...["claude", "midnight", "light", "system"].map((themeId) => ({
    id: `t:${themeId}`,
    label: `Theme: ${themeId}`,
    hint: "theme",
    run: () => void setUi({ theme: themeId }),
  })),
  {
    id: "x:pause",
    label: state.view?.paused ? "Resume project" : "Pause project",
    hint: "project",
    run: () =>
      void client
        .call(state.view?.paused ? "resume" : "pause", {
          id: state.projectId,
          ...(state.view?.paused ? { confirm: state.projectId } : {}),
        })
        .then(() => loadChat(), fail),
  },
  {
    id: "x:open-id",
    label: "Open project by ID…",
    hint: "paste a UUID",
    run: () => {
      const id = prompt("Project ID");
      if (id && /^[a-f0-9-]{36}$/.test(id.trim())) void select(id.trim(), "main");
    },
  },
]);

// ---------------------------------------------------------------------------------------------------------------- ⓘ popovers

const popover = document.querySelector("#popover");
document.addEventListener("click", (event) => {
  const infoButton = event.target.closest("[data-info]");
  if (!infoButton) {
    popover.hidden = true;
    return;
  }
  event.stopPropagation();
  if (!popover.hidden && popover.dataset.for === infoButton.dataset.info) {
    popover.hidden = true;
    return;
  }
  popover.textContent = infoButton.dataset.info;
  popover.dataset.for = infoButton.dataset.info;
  popover.hidden = false;
  const rect = infoButton.getBoundingClientRect();
  const host = infoButton.closest("dialog") ?? document.body;
  if (popover.parentElement !== host) host.append(popover);
  popover.style.top = `${Math.min(innerHeight - 120, rect.bottom + 6)}px`;
  popover.style.left = `${Math.max(8, Math.min(innerWidth - 300, rect.left - 140))}px`;
});

// ---------------------------------------------------------------------------------------------------------------- start

function signIn(message = "") {
  const dialog = document.querySelector("#signin");
  dialog.innerHTML = `<form method="dialog" class="signin"><h1>Open pi-prjcts</h1><p class="muted">Paste the inbox link printed by <code>projects ui</code>, including <code>#token=</code>.</p><input name="link" aria-label="Inbox link" placeholder="http://127.0.0.1:…/#token=…" required />${message ? `<p class="error-line small">${esc(message)}</p>` : ""}<button type="submit" class="primary">Open</button></form>`;
  dialog.showModal();
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const next = new URLSearchParams(new URL(dialog.querySelector("input").value).hash.slice(1)).get("token");
      if (!next || !/^[a-f0-9]{64}$/.test(next)) throw new Error("The link has no valid #token=.");
      setToken(next);
      location.reload();
    } catch (error) {
      signIn(error.message);
    }
  });
}
async function start() {
  paintHints();
  paintStatusLine();
  if (!token) return signIn();
  for (const [selector, view] of [
    ["#inbox-host", "projects"],
    ["#agent-host", "agent"],
  ]) {
    void hostSwitcher(document.querySelector(selector), client, view).catch(fail);
  }
  if (!client.local) {
    const status = document.querySelector("#host-connection");
    const paint = () => {
      if (client.state === "forgotten") {
        document.body.replaceChildren();
        location.replace("/");
        return;
      }
      status.hidden = false;
      status.textContent = `${client.name} · ${client.state}`;
    };
    paint();
    client.addEventListener("statechange", paint);
    if (client.state !== "online") {
      client.addEventListener("statechange", () => {
        if (client.state === "online") location.reload();
      });
      return;
    }
  }
  try {
    await client.call("list");
  } catch (error) {
    return signIn(error.status === 401 ? "This link's token is no longer valid. Copy the current inbox link." : error.message);
  }
  await loadUi();
  await loadProjects();
  const url = new URL(location.href);
  const wanted = url.searchParams.get("project"),
    first = state.projects.find((item) => item.id === wanted) ?? state.projects[0];
  if (first) await select(first.id, first.id === wanted ? (url.searchParams.get("chat") ?? "main") : "main");
  else document.body.dataset.ready = "1";
  const panel = url.searchParams.get("panel");
  if (panel === "settings") openSettings();
  if (panel === "agent") toggleHostAgent(true);
  void loadLimits(); // the host's last readings; providers are asked only by the refresh button
  void loadApprovals();
  // Host topics: approvals reach the status pill and ui_focus moves the page even while the drawer is closed.
  hostChanges = client.stream("/changes?project=host", (change) => {
    if (change.t === "sync") {
      void loadApprovals();
      if (drawerOpen()) void loadHostAgent();
      return;
    }
    if (change.t !== "topic") return;
    if (change.topic === "host-agent") emit("prompts-changed"); // Host agent prompt blocks, among its other changes
    if (change.topic === "ui") void loadUi();
    else if (change.topic === "limits")
      void loadLimits(); // which providers show, saved here or elsewhere; reads only
    else if (change.topic === "telegram")
      emit("telegram"); // the bot or its pairing; Settings → Notifications rereads
    else if (change.topic === "remote")
      emit("remote"); // relay state, devices or pairing; Settings → Remote access rereads
    else if (change.topic === "tiers") {
      emit("tiers");
      onTiersChanged();
    } else if (change.topic === "projects") void loadProjects();
    else onHostTopic(change);
  });
  setInterval(() => void loadProjects(), 15000);
}
addEventListener("pagehide", () => {
  changes?.stop();
  hostChanges?.stop();
});
void start();
