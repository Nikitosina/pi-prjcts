// Plugin status rows and plugin panels (Settings → Plugins). A plugin's ui.js calls
// window.piProjects.register({ name, mount(slot, panel), action?(name, node, panel) }) while it first runs. Each script and style
// loads once per page; a panel mounts in its plugin's card while the section shows, and a project change mounts it again.
// Plugin code is trusted, not isolated: the API only keeps it to its own slot, methods, routes and project.
import { call, token } from "./api.js";
import { clip, esc } from "./format.js";

const RETIRED = ["render", "tick", "projectChanged", "hide"]; // the classic inbox's context-panel hooks
const scripts = new Map(); // plugin name -> { definition, error, ready }
const mounted = new Map(); // plugin name -> shows a runtime error in its mounted panel
const isAbort = (error) => error?.name === "AbortError";
const messageOf = (error) => clip(String(error?.message ?? error ?? "failed"), 500);
const ownerOf = (src) => /^\/plugins\/([a-z][a-z0-9-]{0,39})\/ui\.js$/.exec(src ?? "")?.[1];

function register(definition) {
  const owner = ownerOf(document.currentScript?.getAttribute("src")),
    entry = owner && scripts.get(owner);
  if (!entry) throw new Error("piProjects.register must be called while its ui.js runs");
  const refuse = (reason) => {
    if (!entry.definition) entry.refused = reason;
    throw new Error(reason);
  };
  if (definition?.name !== owner)
    refuse(`ui.js registered as "${clip(String(definition?.name), 60)}"; a script registers only its own plugin`);
  if (entry.definition) refuse(`${owner} is already registered`);
  const retired = RETIRED.filter((hook) => hook in definition);
  if (retired.length) refuse(`ui.js uses the retired context-panel hooks (${retired.join(", ")}); a panel provides mount(slot, panel)`);
  if (typeof definition.mount !== "function" || (definition.action !== undefined && typeof definition.action !== "function"))
    refuse("a panel needs mount(slot, panel) and an optional action(name, node, panel)");
  entry.definition = definition;
}
window.piProjects = Object.freeze({ register, esc });

// An uncaught error from a plugin's own file: while it loads it fails the panel, later it shows in the mounted panel.
window.addEventListener("error", (event) => {
  const name = ownerOf(event.filename ? new URL(event.filename, location.href).pathname : ""),
    entry = name && scripts.get(name);
  if (!entry) return;
  const error = event.error ?? event.message;
  if (!entry.definition) entry.error ??= messageOf(error);
  else mounted.get(name)?.(error);
});

function load({ plugin, script, style }) {
  if (scripts.has(plugin)) return scripts.get(plugin).ready;
  const entry = { definition: null, error: null, refused: null, ready: null };
  scripts.set(plugin, entry);
  if (style) document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: style }));
  entry.ready = new Promise((resolve) => {
    const node = Object.assign(document.createElement("script"), { src: script });
    node.addEventListener("load", () => {
      if (!entry.definition) entry.error ??= entry.refused ?? "ui.js did not register a panel (window.piProjects.register)";
      resolve();
    });
    node.addEventListener("error", () => {
      entry.error = `ui.js could not be loaded from ${script}`;
      resolve();
    });
    document.body.append(node);
  });
  return entry.ready;
}

/** What the host loaded at its start: a change on disk shows here only after the next restart. */
export function pluginRow(plugin) {
  const loaded = plugin.state === "loaded";
  const detail = loaded
    ? `<p class="small muted">${esc(plugin.provides.join(", ") || "no capabilities")}</p>`
    : `<p class="small plugin-error">${esc(clip(plugin.error ?? "failed", 300))}</p>${plugin.error?.includes(plugin.source) ? "" : `<p class="small muted mono">${esc(clip(plugin.source, 160))}</p>`}`;
  return `<div class="plugin-row" data-plugin="${esc(plugin.name ?? "")}" data-state="${esc(plugin.state)}" title="${esc(plugin.source)}"><div class="plugin-head"><span class="mono">${esc(plugin.name ?? "unnamed")}</span>${plugin.version ? `<span class="muted small mono">${esc(plugin.version)}</span>` : ""}<span class="badge"${loaded ? "" : ' data-tone="bad"'}>${loaded ? "loaded" : "failed"}</span></div>${detail}</div>`;
}

/** One card per plugin of the `plugins` RPC: its status row and, for a loaded plugin with a script, an empty panel. */
export function pluginCards({ plugins, web }) {
  const panels = new Set(web.filter((item) => item.script).map((item) => item.plugin));
  return plugins
    .map((plugin) => {
      const panel =
        plugin.state === "loaded" && panels.has(plugin.name)
          ? `<section class="plugin-panel" data-plugin="${esc(plugin.name)}" data-state="loading" aria-label="${esc(plugin.name)} panel"><p class="plugin-error small" role="alert" hidden></p><div class="plugin-slot"></div></section>`
          : "";
      return `<div class="plugin-card" data-plugin="${esc(plugin.name ?? "")}" data-state="${esc(plugin.state)}">${pluginRow(plugin)}${panel}</div>`;
    })
    .join("");
}

/** Mounts every panel `pluginCards` rendered inside `container` for `projectId`; the returned function unmounts them. */
export function mountPanels(container, projectId, web) {
  const controller = new AbortController();
  for (const node of container.querySelectorAll(".plugin-panel[data-plugin]")) {
    const item = web.find((entry) => entry.plugin === node.dataset.plugin && entry.script);
    if (item) void mountOne(node, item, projectId, controller.signal);
  }
  return () => controller.abort();
}

async function mountOne(node, item, projectId, signal) {
  const name = item.plugin,
    errorLine = node.querySelector(".plugin-error"),
    slot = node.querySelector(".plugin-slot");
  const show = (error) => {
    if (signal.aborted || isAbort(error)) return;
    errorLine.textContent = messageOf(error);
    errorLine.hidden = false;
  };
  const fail = (error) => {
    if (signal.aborted || isAbort(error)) return;
    show(error);
    node.dataset.state = "failed";
    slot.replaceChildren();
  };
  await load(item);
  const { definition, error } = scripts.get(name);
  if (signal.aborted) return;
  if (!definition) return fail(error);
  // Answers that arrive after the panel went away reject with an AbortError, so they never render into the next project.
  const settled = async (promise) => {
    signal.throwIfAborted();
    const value = await promise;
    signal.throwIfAborted();
    return value;
  };
  const panel = Object.freeze({
    projectId,
    signal,
    rpc: (method, params) => settled(call("plugin", { plugin: name, method, id: projectId, params })),
    fetch: (route, query = {}) =>
      settled(
        fetch(`/plugins/${name}/${encodeURIComponent(route)}?${new URLSearchParams({ ...query, project: projectId })}`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        }),
      ),
  });
  // Clicks inside the slot belong to the plugin: they never reach core handlers (data-cmd, data-profile, ...).
  slot.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target.closest("[data-action]");
    if (!definition.action || !target || !slot.contains(target) || !target.dataset.action.startsWith(`${name}-`)) return;
    Promise.resolve()
      .then(() => definition.action(target.dataset.action, target, panel))
      .catch(show);
  });
  mounted.set(name, show);
  signal.addEventListener("abort", () => mounted.get(name) === show && mounted.delete(name), { once: true });
  try {
    await definition.mount(slot, panel);
    if (!signal.aborted) node.dataset.state = "ready";
  } catch (mountError) {
    fail(mountError);
  }
}
