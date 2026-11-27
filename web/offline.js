// What the page shows while the selected remote host is offline (REMOTE_SPEC.md, Multi-host inbox, decision 13): a banner naming the
// offline copy and its time, and every control that writes to that host disabled with its reason. The client refuses the writes too
// (web/api.js); this only makes that visible. A page with no remote hosts never shows or changes anything here.
import { clock, esc } from "./format.js";
import { groupOf, offlineCopy, remoteGroups } from "./hosts.js";
import { on, state } from "./state.js";

export const OFFLINE_WRITES = "Host offline: changes are disabled until it is back.";

// Controls that only read or navigate stay enabled; every other control inside an offline host's views is a write.
const READ = [
  "[data-read]",
  ".back",
  "[data-cmd=leave-focus]",
  "[data-cmd=settings]",
  "[data-cmd=host-agent]",
  "[data-toggle]",
  ".media-open",
  "[data-reveal]",
  "[data-memory]:not([data-edit])",
  "[data-open-worker]:not([data-steer])",
  "[data-earlier]",
  "[data-source-chat]",
  "[data-info]",
  "[data-jump]",
  "[data-goto]",
  "[data-worker-history]",
  "[data-worker-subs]",
  "[data-review-pr]",
  "[data-step]",
  "[data-tour-mode]",
  "[data-iteration]",
  "[data-wrap]",
  "[data-tree]",
  "input[type=search]",
  "#settings nav button",
].join(",");
const CONTROLS = "button, input, textarea, select";

/** The data the open center view rendered: the one answer whose origin (live or a copy, and when) the banner reports. */
const displayed = () => (state.focus.kind === "chat" ? state.view : state.focus.data);

function freeze(root, reason) {
  for (const control of root.querySelectorAll(CONTROLS)) {
    if (control.matches(READ) || control.dataset.offlineOff) continue;
    control.dataset.offlineOff = control.disabled ? "kept" : "1";
    control.dataset.offlineTitle = control.title;
    control.disabled = true;
    control.title = reason;
    if (control.placeholder) {
      control.dataset.offlinePlaceholder = control.placeholder;
      control.placeholder = reason;
    }
  }
}
function thaw(root) {
  for (const control of root.querySelectorAll("[data-offline-off]")) {
    if (control.dataset.offlineOff === "1") control.disabled = false;
    control.title = control.dataset.offlineTitle ?? "";
    if (control.dataset.offlinePlaceholder !== undefined) control.placeholder = control.dataset.offlinePlaceholder;
    for (const key of ["offlineOff", "offlineTitle", "offlinePlaceholder"]) delete control.dataset[key];
  }
}

/** `admin` is the host of Settings and the Host agent; project views follow `state.host`. Nothing is installed until a remote host exists. */
export function mountOffline(admin) {
  let banner = null,
    project = null,
    adminViews = null,
    watching = null,
    queued = false,
    observer = null;
  const adminOffline = () => !admin.local && admin.state === "offline";
  // A panel of Settings or the Host agent that was open when its host came back stays an offline copy until the panel's own read answered.
  const refreshing = new Set();
  const PANELS = { settings: "#settings", agent: "#host-agent" };

  function install() {
    if (banner) return;
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.className = "offline-banner";
    banner.setAttribute("role", "status");
    banner.hidden = true;
    document.querySelector("#center").prepend(banner);
    project = ["#feed", "#dock", "#context", "#focus-view"].map((selector) => document.querySelector(selector));
    adminViews = ["#settings", "#host-agent"].map((selector) => document.querySelector(selector));
    observer = new MutationObserver(later);
    for (const root of [...project, ...adminViews]) observer.observe(root, { childList: true, subtree: true });
  }
  function paintBanner(group) {
    banner.hidden = !group;
    if (!group) return;
    const read = group.client.provenance(displayed());
    banner.innerHTML = !read
      ? `<b>Offline</b>: ${esc(group.name)} has no copy of this view. ${esc(OFFLINE_WRITES)}`
      : offlineCopy(group)
        ? `<b>Offline copy</b> of ${esc(group.name)} · data from ${esc(clock(read.at))}. ${esc(OFFLINE_WRITES)}`
        : `<b>Back online</b>: ${esc(group.name)} is refreshing this view. Until then it is the offline copy from ${esc(clock(read.at))}.`;
    banner.dataset.copy = read ? "1" : "0";
  }
  /** The banner of an admin panel, put back whenever the panel drew over it. */
  function panelBanner(root, shown) {
    let note = root.querySelector(":scope > .offline-banner");
    if (!shown) return void (note && !note.hidden && (note.hidden = true));
    if (!note) {
      note = document.createElement("div");
      note.className = "offline-banner";
      note.setAttribute("role", "status");
      root.prepend(note);
    }
    const next = refreshing.size && !adminOffline() ? "back" : "offline";
    const html =
      next === "back"
        ? `<b>Back online</b>: ${esc(admin.name)} is refreshing this panel. Until then it is the offline copy.`
        : `<b>Offline copy</b> of ${esc(admin.name)}. ${esc(OFFLINE_WRITES)}`;
    if (note.innerHTML !== html) note.innerHTML = html;
    note.hidden = false;
  }
  function paint() {
    install();
    const group = groupOf(state.host);
    // A host that is back stays frozen until the displayed data came from a live read of this connection: the text on screen may still be the copy.
    const read = group && !offlineCopy(group) ? group.client?.provenance(displayed()) : null;
    // Only an answer read live in the current connection period counts: one from before the last drop may be out of date.
    // After a connection loss a shown chat that is no live answer of this period (or not loaded yet) is not known to be fresh.
    const unread = !!group && group.client?.epoch > 0 && !read && state.focus.kind === "chat";
    const stale = unread || (!!read && (read.live === false || read.epoch !== group.client.epoch));
    const frozen = group && (offlineCopy(group) || stale) ? group : null;
    document.body.dataset.hostOffline = frozen ? "1" : "0";
    paintBanner(frozen);
    for (const root of project) frozen ? freeze(root, OFFLINE_WRITES) : thaw(root);
    for (const root of adminViews) {
      const panel = Object.keys(PANELS).find((name) => document.querySelector(PANELS[name]) === root);
      const locked = !admin.local && (admin.state === "offline" || refreshing.has(panel));
      panelBanner(root, locked);
      locked ? freeze(root, OFFLINE_WRITES) : thaw(root);
    }
  }
  function later() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => ((queued = false), paint()));
  }
  function follow() {
    if (watching?.host === state.host) return;
    watching?.host?.removeEventListener?.("copy", later);
    watching = { host: state.host };
    state.host?.addEventListener?.("copy", later);
  }
  admin.addEventListener?.("statechange", () => {
    if (admin.state === "online") {
      for (const [name, selector] of Object.entries(PANELS)) {
        const root = document.querySelector(selector);
        if (root && (root.open || root.getAttribute("aria-hidden") === "false")) refreshing.add(name);
      }
    } else refreshing.clear();
    if (remoteGroups() || !admin.local) later();
  });
  on("panel-live", (name) => {
    refreshing.delete(name);
    later();
  });
  for (const event of ["select", "hosts", "view", "open", "projects"])
    on(event, () => {
      if (!banner && !remoteGroups() && admin.local) return;
      follow();
      later();
    });
}
