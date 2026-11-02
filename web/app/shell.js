import { ago, esc, idLike } from "./format.js";

export const initial = new URL(location.href);
const key = `pi-projects-token:${location.origin}`;
const supplied = new URLSearchParams(initial.hash.slice(1)).get("token");
// localStorage, not sessionStorage: some browsers re-create tabs without the stripped #token fragment.
// Each host start uses a new port, so tokens stored for other origins are dead; drop them.
if (supplied) {
  for (const stored of Object.keys(localStorage))
    if (stored.startsWith("pi-projects-token:") && stored !== key) localStorage.removeItem(stored);
  localStorage.setItem(key, supplied);
}
// End-to-end runs (?e2e=1) read how much work the live preview and the markdown renderer did; nothing else touches this.
export const probe = initial.searchParams.get("e2e") === "1" ? (window.__projectsProbe = { live: [], markdown: [] }) : null;
// E2E scripts read the open project view by name, as they did before the page was split into modules.
if (probe) {
  Object.defineProperty(window, "view", { get: () => getView() });
  Object.defineProperty(window, "projectId", { get: () => getProjectId() });
  window.render = render;
}
initial.hash = "";
history.replaceState(null, "", initial);
export const token = localStorage.getItem(key) || "";
// iOS Safari's layout viewport does not always follow its visible viewport when the toolbar or keyboard moves.
// Size the whole shell from VisualViewport so neither the composer nor the separate limits bar is stranded mid-screen.
function syncVisualViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty("--visual-viewport-height", `${viewport?.height ?? innerHeight}px`);
  document.documentElement.style.setProperty("--visual-viewport-top", `${viewport?.offsetTop ?? 0}px`);
}
window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
addEventListener("resize", syncVisualViewport);
syncVisualViewport();
export const scrollBehavior = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
const signIn = document.querySelector("#sign-in");
signIn.addEventListener("cancel", (event) => event.preventDefault());
signIn.querySelector("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#sign-in-link"),
    error = document.querySelector("#sign-in-error");
  const button = signIn.querySelector("button");
  error.textContent = "";
  let link;
  try {
    link = new URL(input.value.trim());
  } catch {
    error.textContent = "Paste the full inbox link, including #token=.";
    return;
  }
  if (link.origin !== location.origin) {
    error.textContent = "This link belongs to another host address. Use the link for this app's address.";
    return;
  }
  const next = new URLSearchParams(link.hash.slice(1)).get("token");
  if (!/^[a-f0-9]{64}$/.test(next ?? "")) {
    error.textContent = "This link is missing a valid #token=. Copy the original inbox link.";
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch("/api", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${next}` },
      body: JSON.stringify({ action: "list" }),
      signal: AbortSignal.timeout(15000),
    });
    const reply = await response.json();
    if (!response.ok || reply?.ok !== true) {
      error.textContent = "This link was not accepted. Get the current link with npm run projects -- ui-url.";
      return;
    }
    localStorage.setItem(key, next);
    input.value = "";
    location.reload();
  } catch {
    error.textContent = "Could not sign in. Check that the host is running and browser storage is allowed.";
  } finally {
    button.disabled = false;
  }
});
function showSignIn() {
  if (!signIn.open) signIn.showModal();
}
// The host keeps its port across restarts, so opening its new address in this tab is only a fragment change: take the new token and reload.
addEventListener("hashchange", () => {
  const next = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!next) return;
  localStorage.setItem(key, next);
  const url = new URL(location.href);
  url.hash = "";
  history.replaceState(null, "", url);
  location.reload();
});
export const dialog = document.querySelector("#dialog");
export const html = new Map();
export let projects = [];
let projectId = initial.searchParams.get("project");
let view = null;
let generation = 0;
export let polling = null;
let busy = false;
export let dialogVersion = 0;
export let blobUrl = null;
let toastTimer;
// Dismissed notices: an ✕ hides a warning or error until its text changes; remembered for this tab session.
const dismissKey = "pi-projects-dismissed";
export const dismissed = new Set(
  (() => {
    try {
      return JSON.parse(sessionStorage.getItem(dismissKey) ?? "[]");
    } catch {
      return [];
    }
  })(),
);
const tabs = ["coordinator", "knowledge", "observability", "settings"];
export let tab = tabs.includes(initial.searchParams.get("tab")) ? initial.searchParams.get("tab") : "coordinator";

// data-action and form-submit routing: features register their handlers; plugins claim their own "<name>-" actions through a router.
const actionTable = new Map(),
  actionRouters = [],
  formHandlers = [];
export function registerActions(handlers) {
  for (const [name, run] of Object.entries(handlers)) {
    if (actionTable.has(name)) throw new Error(`Duplicate action ${name}`);
    actionTable.set(name, run);
  }
}
export function registerForms(entries) {
  formHandlers.push(...entries);
}
function routeActions(router) {
  actionRouters.push(router);
}
// Enter in a form's textarea submits it (Shift+Enter and IME composition do not); true when the key was an unmodified Enter in a matching textarea.
export function submitOnEnter(event, textareaSelector) {
  const textarea = event.target.closest(textareaSelector);
  if (!textarea || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
  const form = textarea.form;
  const submitButton = form?.querySelector('button[type="submit"]');
  if (form && !submitButton?.disabled && !busy) {
    event.preventDefault();
    form.requestSubmit();
  }
  return true;
}
async function action(node) {
  for (const router of actionRouters) {
    const run = router(node);
    if (run) {
      await run();
      return;
    }
  }
  await actionTable.get(node.dataset.action)?.(node);
}
async function submit(form) {
  for (const [selector, run] of formHandlers) if (form.matches(selector)) return run(form);
}
// Browser plugins: /plugins/<name>/ui.js calls piProjects.register({ name, mount(slot), projectChanged, render, tick, hide, action(name, node) }).
// Their data-action names start with "<name>-". A failing plugin is logged and skipped; the app keeps working.
const uiPlugins = [],
  uiPluginSources = new Set();
export function uiPluginCall(hook) {
  for (const plugin of uiPlugins) {
    try {
      plugin[hook]?.();
    } catch (error) {
      console.error(`Plugin ${plugin.name} ${hook} failed`, error);
    }
  }
}
export function loadUiPlugins(list) {
  for (const item of list) {
    if (item.style && !uiPluginSources.has(item.style)) {
      uiPluginSources.add(item.style);
      document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: item.style }));
    }
    if (item.script && !uiPluginSources.has(item.script)) {
      uiPluginSources.add(item.script);
      document.body.append(Object.assign(document.createElement("script"), { src: item.script }));
    }
  }
}
routeActions((node) => {
  const owner = uiPlugins.find((plugin) => node.dataset.action?.startsWith(`${plugin.name}-`));
  return owner && (() => owner.action(node.dataset.action, node));
});
window.piProjects = Object.freeze({
  register(plugin) {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/.test(plugin?.name ?? "") ||
      uiPlugins.some((item) => item.name === plugin.name) ||
      typeof plugin.action !== "function"
    )
      throw new Error("Invalid or duplicate browser plugin");
    const slot = document.createElement("div");
    slot.dataset.plugin = plugin.name;
    document.querySelector("#plugin-cards").append(slot);
    plugin.mount?.(slot);
    uiPlugins.push(plugin);
    try {
      plugin.projectChanged?.();
      plugin.render?.();
    } catch (error) {
      console.error(`Plugin ${plugin.name} start failed`, error);
    }
  },
  state: () => ({ projectId, view, tab, generation, dialogVersion }),
  rpc: (plugin, method, id, params) => api({ action: "plugin", plugin, method, id, params }),
  /** Authenticated GET of a plugin route, /plugins/<name>/<route>?... */
  fetch: (path, init = {}) => fetch(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
  dialog,
  showDialog,
  closeDialog,
  esc,
  setHtml,
  ago,
  toast,
  requireProject,
  // Defined further down as consts.
  dlgActions: (...parts) => dlgActions(...parts),
  dlgBtn: (...args) => dlgBtn(...args),
});

// Opening a project invalidates everything in flight (generation) and resets each feature through its registered hook.
// Reset hooks run in load order, so each only clears its own state; anything that reads another feature's state waits for onProjectOpened.
const projectChangeHooks = [];
export function onProjectChange(reset) {
  projectChangeHooks.push(reset);
}
// Runs once the project is switched and the view is cleared: features redraw their navigation and load the new project.
const projectOpenedHooks = [];
export function onProjectOpened(opened) {
  projectOpenedHooks.push(opened);
}
export function changeProject(id, chat = "main") {
  captureDrafts();
  generation++;
  projectId = id;
  uiPluginCall("projectChanged");
  for (const reset of projectChangeHooks) reset(id, chat);
  closeDialog();
  const url = new URL(location.href);
  if (id) url.searchParams.set("project", id);
  else url.searchParams.delete("project");
  history.replaceState(null, "", url);
  document.querySelector("#projects").value = id ?? "";
  html.clear();
  disableActions();
  for (const opened of projectOpenedHooks) opened(id);
}
// Features that load or lay out something per tab register here; they run after the panels switch.
const tabHooks = [];
export function onTab(hook) {
  tabHooks.push(hook);
}
export function setTab(next) {
  if (!tabs.includes(next)) return;
  tab = next;
  const url = new URL(location.href);
  url.searchParams.set("tab", next);
  history.replaceState(null, "", url);
  document.querySelectorAll("[data-panel]").forEach((node) => {
    node.hidden = node.dataset.panel !== next;
  });
  document.querySelectorAll(".tabs [data-tab]").forEach((node) => node.classList.toggle("on", node.dataset.tab === next));
  uiPluginCall("tick");
  for (const hook of tabHooks) hook(next);
}

// Features draw their own part of the page; render() runs them in load order, so they must not depend on each other, then locks controls.
const renderers = [];
export function onRender(draw) {
  renderers.push(draw);
}
export function render() {
  if (!view) return;
  for (const draw of renderers) draw();
  disableActions();
}
export function setHtml(selector, text) {
  const node = document.querySelector(selector),
    selection = document.getSelection();
  if (
    html.get(selector) === text ||
    node.contains(document.activeElement) ||
    (selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode)))
  )
    return;
  node.innerHTML = text;
  html.set(selector, text);
}
// Features own the controls they lock while a request is in flight or the project cannot admit work; each registers its rules here.
const busyHooks = [];
export function onBusyChange(apply) {
  busyHooks.push(apply);
}
export function disableActions() {
  // data-off: a picker button that is idle-disabled (nothing to save), not just busy
  document.querySelectorAll('#dialog button[type="submit"]').forEach((node) => {
    node.disabled = busy || node.hasAttribute("data-off");
  });
  for (const apply of busyHooks) apply();
}

export function uiFrame() {
  return { projectId, generation, dialogVersion };
}
export class UiRequestError extends Error {
  constructor(error, frame, rejected = false) {
    super(error instanceof Error ? error.message : String(error));
    this.frame = frame;
    this.rejected = rejected;
  }
}
export async function api(input) {
  const frame = uiFrame();
  let rejected = false;
  try {
    if (!token) {
      showSignIn();
      throw new Error("Paste your inbox link to sign in.");
    }
    const response = await fetch("/api", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(120000),
    });
    if (response.status === 401) showSignIn();
    const reply = await response.json();
    rejected = reply?.ok === false;
    if (!response.ok || reply?.ok !== true)
      throw new Error(typeof reply?.error === "string" ? reply.error : `Host returned ${response.status}`);
    return reply.data;
  } catch (error) {
    throw new UiRequestError(error, frame, rejected);
  }
}
export async function uiAction(action) {
  const frame = uiFrame();
  try {
    await action();
  } catch (error) {
    report(error, error instanceof UiRequestError ? error.frame : frame);
  }
}

// The chat feature owns refresh(); mutate re-reads the open project through it.
let refreshOpenProject = async () => {};
export function provideRefresh(refresh) {
  refreshOpenProject = refresh;
}
export async function mutate(input, success) {
  if (busy) throw new Error("Another action is still pending. Your draft was kept.");
  busy = true;
  disableActions();
  try {
    const result = await api(input);
    toast(typeof success === "function" ? success(result) : success);
    if (input.id === projectId) {
      if (document.querySelector("#questions").contains(document.activeElement)) document.activeElement.blur();
      await refreshOpenProject();
    }
    return result;
  } finally {
    busy = false;
    disableActions();
  }
}

export function showError(error) {
  const text = error instanceof Error ? error.message : String(error);
  document.querySelector("#connection").textContent = "Disconnected";
  document.querySelector("#connection").dataset.state = "down";
  setError(`${text}. If the host restarted, run /projects-ui to reopen its current address.`, "connection");
}
export function closeButton(key) {
  return `<button type="button" class="notice-close" data-dismiss="${esc(key)}" title="Dismiss" aria-label="Dismiss">✕</button>`;
}
export function setError(text, source) {
  const node = document.querySelector("#error"),
    key = `error:${text}`;
  node.dataset.source = source;
  node.innerHTML = `<div class="notice-row"><span>${esc(text)}</span>${closeButton(key)}</div>`;
  node.hidden = dismissed.has(key);
}
// ✕ on a notice: remember it, drop its row, and hide the box once empty. Not a data-action, so it works while busy.
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dismiss]");
  if (!button) return;
  dismissed.add(button.dataset.dismiss);
  try {
    sessionStorage.setItem(dismissKey, JSON.stringify([...dismissed].slice(-200)));
  } catch {}
  const box = button.closest("#error, #warning");
  button.closest(".notice-row").remove();
  if (box && !box.querySelector(".notice-row")) box.hidden = true;
});
export function toast(text) {
  clearTimeout(toastTimer);
  const node = document.querySelector("#toast");
  node.textContent = text;
  node.classList.add("visible");
  toastTimer = setTimeout(() => node.classList.remove("visible"), 4500);
}
// Features that keep per-dialog state (pending confirmations, object URLs) register a cleanup that runs whenever the dialog closes or is replaced.
const dialogClosers = [];
export function onDialogClose(cleanup) {
  dialogClosers.push(cleanup);
}
function resetDialogState() {
  captureDrafts();
  for (const cleanup of dialogClosers) cleanup();
  dialogVersion++;
}
export function closeDialog() {
  resetDialogState();
  if (dialog.open) dialog.close();
}
export function showDialog(title, content, subtitle = "") {
  closeDialog();
  dialog.innerHTML = `<header class="dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${subtitle ? `<p class="dialog-sub">${esc(subtitle)}</p>` : ""}</div><button type="button" data-action="close-dialog" class="ghost small dialog-x" aria-label="Close" title="Close (Esc)">✕</button></header><div class="dialog-body">${content}</div>`;
  dialog.showModal();
  return dialogVersion;
}
// Shared pieces of the Settings dialogs: sticky footer, buttons, pager, tabs, plain record summaries with raw JSON only inside a collapsed Details.
export const setDialogBody = (html) => {
  dialog.querySelector(".dialog-body").innerHTML = html;
  disableActions();
};
export const dlgBtn = (label, data = {}, cls = "") =>
  `<button type="button"${cls ? ` class="${cls}"` : ""}${Object.entries(data)
    .map(([key, value]) => ` data-${key}="${esc(value)}"`)
    .join("")}>${label}</button>`;
export const dlgActions = (...parts) => `<div class="dialog-actions">${parts.join("")}</div>`;
export const rawDetails = (value, label = "Technical details") =>
  `<details class="raw"><summary>${esc(label)}</summary><pre>${esc(JSON.stringify(value, null, 2) ?? "")}</pre></details>`;
export const humanKey = (key) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
export function recordSummary(record, skip = []) {
  const rows = Object.entries(record)
    .filter(([key, value]) => !skip.includes(key) && value !== null && value !== undefined && typeof value !== "object")
    .map(([key, value]) => {
      const text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
      return `<span>${esc(humanKey(key))}</span><b${idLike(text) ? ` class="mono" title="${esc(text)}"` : ""}>${esc(idLike(text) && text.length > 40 ? `${text.slice(0, 12)}…` : text)}</b>`;
    })
    .join("");
  return `${rows ? `<div class="kv tight">${rows}</div>` : ""}${rawDetails(record)}`;
}
export const compactTokens = (count) =>
  !Number.isFinite(count) || count <= 0
    ? ""
    : count >= 1e6
      ? `${+(count / 1e6).toFixed(1)}M`
      : count >= 1e3
        ? `${Math.round(count / 1e3)}k`
        : String(count);
export const stateChip = (text, tone = "") => `<span class="state-chip ${tone}">${esc(text)}</span>`;
export function pager({ offset, count, total, size, data }) {
  const prev = offset > 0 ? Math.max(0, offset - size) : null,
    next = offset + count < total ? offset + count : null;
  if (prev === null && next === null) return total > 0 ? `<span class="pager">${total} in total</span>` : "";
  return `<span class="pager">${prev === null ? "" : dlgBtn("‹ Previous", { ...data, offset: prev }, "small")}<span>${offset + (count ? 1 : 0)}–${offset + count} of ${total}</span>${next === null ? "" : dlgBtn("Next ›", { ...data, offset: next }, "small")}</span>`;
}
export const segTabs = (items) =>
  `<div class="skill-tabs" role="group">${items
    .map(
      ([label, data, on]) =>
        `<button type="button"${on ? ' class="on"' : ""} aria-pressed="${on ? "true" : "false"}"${Object.entries(data)
          .map(([key, value]) => ` data-${key}="${esc(value)}"`)
          .join("")}>${label}</button>`,
    )
    .join("")}</div>`;
registerActions({
  "toggle-clamp"(node) {
    node.classList.toggle("clamp");
  },
  "close-dialog"() {
    closeDialog();
  },
});

export function report(error, frame = error instanceof UiRequestError ? error.frame : uiFrame()) {
  if (frame.projectId !== projectId || frame.generation !== generation) return;
  const text = error instanceof Error ? error.message : String(error);
  if (dialog.open && frame.dialogVersion === dialogVersion) {
    let node = dialog.querySelector(".dialog-error");
    if (!node) {
      node = document.createElement("p");
      node.className = "dialog-error";
      dialog.append(node);
    }
    node.textContent = text;
  } else setError(text, "action");
}
document.addEventListener("click", (event) => {
  const node = event.target.closest("[data-action]");
  if (node && !node.disabled) void uiAction(() => action(node));
});
document.addEventListener("submit", (event) => {
  if (!event.target.matches(formHandlers.map(([selector]) => selector).join(", "))) return;
  event.preventDefault();
  void uiAction(() => submit(event.target));
});
// Collapsible project sidebar (wide layouts): collapses to an icon rail; toggle button and ⌘B / Ctrl+B; remembered per browser.
function setSidebar(collapsed, persist = true) {
  document.querySelector(".app").classList.toggle("side-collapsed", collapsed);
  const toggle = document.querySelector("#side-toggle"),
    label = `${collapsed ? "Expand" : "Collapse"} sidebar`;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", label);
  toggle.title = `${label} (⌘B / Ctrl+B)`;
  if (persist) {
    try {
      localStorage.setItem("pi-projects:side-collapsed", collapsed ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  }
}
try {
  setSidebar(localStorage.getItem("pi-projects:side-collapsed") === "1", false);
} catch {
  setSidebar(false, false);
}
// The width animates only for toggles, not for the restored state on load.
requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(".app").classList.add("side-animate")));
document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-side-toggle]")) return;
  setSidebar(!document.querySelector(".app").classList.contains("side-collapsed"));
});
document.querySelector("#projects").addEventListener("change", (event) => changeProject(event.target.value));
dialog.addEventListener("close", () => {
  // A delayed close event must not cancel a dialog that has since reopened.
  if (dialog.open) return;
  resetDialogState();
});
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key?.toLowerCase() === "b" &&
    !event.isComposing &&
    !dialog.open
  ) {
    event.preventDefault();
    setSidebar(!document.querySelector(".app").classList.contains("side-collapsed"));
  }
});
export function requireProject(id) {
  if (id !== projectId) throw new Error("Selected project changed. Reopen the intended control.");
}
export function closeCurrentDialog(id, version) {
  if (projectId === id && dialogVersion === version) closeDialog();
}
// Browser-kept drafts survive a reload (sessionStorage, one JSON snapshot). Features register the maps they own: entries() serializes,
// validate(pairs) throws on malformed data, restore(pairs) rebuilds, capture() copies open dialog fields into them.
const draftStorageKey = "pi-projects-ui-drafts:v1";
const draftParts = [];
let lastDraftSnapshot = "";
let lastDraftError = null;
export function registerDrafts(part) {
  draftParts.push(part);
}
export const draftPairs = (value) =>
  Array.isArray(value) &&
  value.length <= 256 &&
  value.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string") &&
  new Set(value.map((pair) => pair[0])).size === value.length;
export const draftText = (value) => typeof value === "string" && value.length <= 32000;
const draftSnapshot = () => ({ version: 1, ...Object.fromEntries(draftParts.map((part) => [part.key, part.entries()])) });
export function captureDrafts() {
  for (const part of draftParts) part.capture?.();
  persistDraftsSafely();
}
export function persistBrowserDrafts() {
  const state = draftSnapshot();
  const serialized = JSON.stringify(state);
  validateBrowserDraftState(state);
  if (new TextEncoder().encode(serialized).length > 1048576)
    throw new Error("Browser draft snapshot exceeds 1 MiB. In-memory drafts retained without truncation");
  if (serialized !== lastDraftSnapshot) {
    sessionStorage.setItem(draftStorageKey, serialized);
    lastDraftSnapshot = serialized;
  }
  lastDraftError = null;
}
export function persistDraftsSafely() {
  try {
    persistBrowserDrafts();
  } catch (error) {
    if (error.message !== lastDraftError) {
      lastDraftError = error.message;
      report(error);
    }
  }
}
function validateBrowserDraftState(state) {
  if (!state || state.version !== 1)
    throw new Error("Malformed/oversized browser draft state. In-memory drafts retained without truncation");
  for (const part of draftParts) {
    if (state[part.key] === undefined && !part.required) continue;
    part.validate(state[part.key]);
  }
}
export function restoreBrowserDrafts() {
  try {
    const serialized = sessionStorage.getItem(draftStorageKey);
    if (!serialized) return;
    if (new TextEncoder().encode(serialized).length > 1048576) throw new Error("Browser draft snapshot exceeds 1 MiB");
    const state = JSON.parse(serialized);
    validateBrowserDraftState(state);
    for (const part of draftParts) part.restore(state[part.key] ?? []);
    lastDraftSnapshot = JSON.stringify(draftSnapshot());
  } catch (error) {
    report(error);
  }
}
window.addEventListener("pagehide", captureDrafts);
setInterval(() => uiPluginCall("tick"), 500);
document.addEventListener("visibilitychange", () => uiPluginCall("tick"));
window.addEventListener("pagehide", () => uiPluginCall("hide"));
document.addEventListener("click", (event) => {
  const pick = event.target.closest("[data-select-project]");
  if (pick && pick.dataset.selectProject !== projectId) changeProject(pick.dataset.selectProject);
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) setTab(tabButton.dataset.tab);
});
export function setView(value) {
  return (view = value);
}

export function getView() {
  return view;
}

export function getProjectId() {
  return projectId;
}

export function setPolling(value) {
  return (polling = value);
}

export function bumpGeneration() {
  return ++generation;
}

export function getGeneration() {
  return generation;
}

export function setProjects(value) {
  return (projects = value);
}

export function isBusy() {
  return busy;
}

export function bumpDialogVersion() {
  return ++dialogVersion;
}

export function setProjectId(value) {
  return (projectId = value);
}

export function setBlobUrl(value) {
  return (blobUrl = value);
}

export function setBusy(value) {
  return (busy = value);
}
