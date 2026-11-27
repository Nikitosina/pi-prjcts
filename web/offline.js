// What the page shows while the selected remote host is offline (REMOTE_SPEC.md, Multi-host inbox, decision 13): a banner naming the
// offline copy and its time, and every control that writes to that host disabled with its reason. The client refuses the writes too
// (web/api.js); this only makes that visible. A page with no remote hosts never shows or changes anything here.
import { clock, esc } from "./format.js";
import { groupOf, offlineCopy } from "./hosts.js";
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

/** The read whose saved time a kind of center view shows. */
const COPY_READ = { chat: "show", worker: "thread-history", memory: "memory-index", pr: "pr-review-open" };

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

/** `admin` is the host of Settings and the Host agent; project views follow `state.host`. */
export function mountOffline(admin) {
  const banner = document.createElement("div");
  banner.id = "offline-banner";
  banner.className = "offline-banner";
  banner.setAttribute("role", "status");
  banner.hidden = true;
  document.querySelector("#center").prepend(banner);
  const project = ["#dock", "#context", "#focus-view"].map((selector) => document.querySelector(selector)),
    adminViews = ["#settings", "#host-agent"].map((selector) => document.querySelector(selector));
  const adminOffline = () => !admin.local && admin.state === "offline";
  let watching = null;

  function paintBanner(group) {
    banner.hidden = !group;
    if (!group) return;
    const read = group.client.copies.get(COPY_READ[state.focus.kind]);
    banner.innerHTML = read
      ? `<b>Offline copy</b> of ${esc(group.name)} · data from ${esc(clock(read))}. ${esc(OFFLINE_WRITES)}`
      : `<b>Offline</b>: ${esc(group.name)} has no copy of this view. ${esc(OFFLINE_WRITES)}`;
    banner.dataset.copy = read ? "1" : "0";
  }
  function paint() {
    const group = groupOf(state.host);
    const frozen = group && offlineCopy(group) ? group : null;
    document.body.dataset.hostOffline = frozen ? "1" : "0";
    paintBanner(frozen);
    for (const root of project) frozen ? freeze(root, OFFLINE_WRITES) : thaw(root);
    for (const root of adminViews) adminOffline() ? freeze(root, OFFLINE_WRITES) : thaw(root);
  }
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => ((queued = false), paint()));
  };
  function follow() {
    if (watching?.host === state.host) return;
    watching?.host.removeEventListener?.("copy", later);
    watching = { host: state.host };
    state.host?.addEventListener?.("copy", later);
  }
  const observer = new MutationObserver(later);
  for (const root of [...project, ...adminViews]) observer.observe(root, { childList: true, subtree: true });
  admin.addEventListener?.("statechange", later);
  for (const event of ["select", "hosts", "view", "open", "projects"])
    on(event, () => {
      follow();
      later();
    });
}
