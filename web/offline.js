// What the page shows while the selected remote host is offline (REMOTE_SPEC.md, Multi-host inbox, decision 13): a banner naming the
// offline copy and its time, and every control that writes to that host disabled with its reason. The client refuses the writes too
// (web/api.js); this only makes that visible. A page with no remote hosts never shows or changes anything here.
import { clock, esc } from "./format.js";
import { groupOf, groups, HostState, offlineCopy, remoteGroups } from "./hosts.js";
import { on, state } from "./state.js";
import { openViews } from "./views.js";

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

/** The data the open center view rendered: the one answer whose time the banner reports. */
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

/** A remote host is read-only (REMOTE_SPEC.md, decision 14) while it is not online, and after a drop until every view open on it has read live in the
 * current connection period. It is one state for the whole host: a view never unlocks on its own. */
function frozenGroup(group) {
  if (!group?.entry) return false;
  const client = group.client;
  if (!client || group.state !== HostState.Online) return true;
  return client.epoch > 0 && openViews().some((view) => view.client === client && !client.isLive(view.key));
}

/** `admin` is the host of Settings and the Host agent; project views follow `state.host`. Nothing is installed until a remote host exists. */
export function mountOffline(admin) {
  let banner = null,
    project = null,
    adminViews = null,
    queued = false,
    observer = null;
  const attached = new Set();

  function install() {
    if (banner) return;
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.className = "offline-banner";
    banner.setAttribute("role", "status");
    banner.hidden = true;
    document.querySelector("#center").prepend(banner);
    project = ["#feed", "#dock", "#context", "#focus-view"].map((selector) => document.querySelector(selector));
    adminViews = [
      { root: document.querySelector("#settings"), panel: "settings" },
      { root: document.querySelector("#host-agent"), panel: "agent" },
    ];
    observer = new MutationObserver(later);
    for (const root of [...project, ...adminViews.map((view) => view.root)]) observer.observe(root, { childList: true, subtree: true });
  }
  const noteOf = (group, copy) =>
    offlineCopy(group)
      ? `<b>Offline copy</b> of ${esc(group.name)}${copy ? ` · data from ${esc(clock(copy.at))}` : ""}. ${esc(OFFLINE_WRITES)}`
      : `<b>Back online</b>: ${esc(group.name)} is reading its open views again. Changes unlock when every one of them has been read.`;
  function paintBanner(group) {
    banner.hidden = !group;
    if (!group) return;
    const read = group.client?.provenance(displayed()) ?? null;
    banner.innerHTML =
      read || !offlineCopy(group)
        ? noteOf(group, read)
        : `<b>Offline</b>: ${esc(group.name)} has no copy of this view. ${esc(OFFLINE_WRITES)}`;
    banner.dataset.copy = read ? "1" : "0";
  }
  /** The banner of an admin panel, put back whenever the panel drew over it. */
  function panelBanner(root, group) {
    let note = root.querySelector(":scope > .offline-banner");
    if (!group) return void (note && !note.hidden && (note.hidden = true));
    if (!note) {
      note = document.createElement("div");
      note.className = "offline-banner";
      note.setAttribute("role", "status");
      root.prepend(note);
    }
    const html = noteOf(group, null);
    if (note.innerHTML !== html) note.innerHTML = html;
    note.hidden = false;
  }
  function paint() {
    install();
    const group = groupOf(state.host);
    const frozen = frozenGroup(group) ? group : null;
    document.body.dataset.hostOffline = frozen ? "1" : "0";
    paintBanner(frozen);
    for (const root of project) frozen ? freeze(root, OFFLINE_WRITES) : thaw(root);
    for (const { root, panel } of adminViews) {
      const owner = groupOf(state.panels[panel]?.client ?? admin);
      const locked = frozenGroup(owner) ? owner : null;
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
    for (const group of groups) {
      if (!group.client || group.client.local || attached.has(group.client)) continue;
      attached.add(group.client);
      for (const event of ["fresh", "copy", "statechange"]) group.client.addEventListener(event, later);
    }
  }
  for (const event of ["select", "hosts", "view", "open", "projects", "panels", "host-online"])
    on(event, () => {
      if (!banner && !remoteGroups() && admin.local) return;
      follow();
      later();
    });
}
