// Shared page state and a tiny event bus. `generation` changes with every project/chat selection; any code that awaits must
// compare it afterwards (`stale(gen)`) before touching the page, so late answers never render into another project.

/** Rethrows outside the event bus, so an uncaught page error reaches the console and tests (a handler failure must never be silent). */
const reportError = (error) => {
  console.error(error);
  queueMicrotask(() => {
    throw error;
  });
};

export const state = {
  projects: [],
  projectId: null,
  chatId: "main",
  generation: 0,
  view: null, // `show` for the selected chat
  jobs: null, // `jobs-snapshot`
  live: null, // last DurableLiveFrame of the selected chat
  liveHeld: null, // "writing" | "thinking" while a committed step still shows live, waiting for the transcript read
  connected: false,
  focus: { kind: "chat" }, // center: chat | worker | memory | report
  ui: null, // UiSettings, or null while unknown
  uiRevision: null,
  steer: false, // composer mode while busy: false = queue, true = steer
  limits: null, // `limits-snapshot` providers
  limitsRefreshing: false,
  limitsError: null,
  limitsVisibility: null, // host's saved `limits-visibility`: provider → shown in the status line
  limitsPending: {}, // provider → the choice a toggle shows while its save is queued or in flight
  limitsVisibilityError: null,
  usage: null,
  panels: { settings: null, agent: null }, // the open Settings section and Host agent: { client, key } of the host data they show
};

const handlers = new Map();
export function on(event, handler) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(handler);
  return () => handlers.get(event).delete(handler);
}
export function emit(event, payload) {
  for (const handler of handlers.get(event) ?? []) {
    try {
      handler(payload);
    } catch (error) {
      reportError(error); // an uncaught error, so a page error check sees what a handler threw
    }
  }
}
export const stale = (generation) => generation !== state.generation;
const renders = new WeakMap();
/** Every render of a view takes a token from its root; a read that began for an older render must not draw (`newest`), however late it answers. */
export const claim = (root) => {
  const token = (renders.get(root) ?? 0) + 1;
  renders.set(root, token);
  return token;
};
export const newest = (root, token) => renders.get(root) === token;
/** A form with unsaved input marks its root dirty (`input` events); an automatic redraw (a reconnect, a background refresh) never replaces a dirty
 * root, while a render the owner asked for starts clean. */
export const markDirty = (root) => void (root.dataset.dirty = "1");
export const clean = (root) => void delete root.dataset.dirty;
export const isDirty = (root) => root.dataset.dirty === "1";
/** An input that is not work to lose: a search or filter field, or a switch that saves the moment it is toggled. */
export const isFilter = (target) => target.matches?.("input[type=search], input[type=checkbox], input[type=radio], [data-filter]");
export const project = () => state.projects.find((item) => item.id === state.projectId) ?? null;
export const chatArgs = () => (state.chatId && state.chatId !== "main" ? { chatId: state.chatId } : {});

/** Toasts are for background events and errors. An identical message already showing restarts its timer instead of stacking;
 * at most two show; each leaves on its own. A change the owner just made reports next to its control (`inline`) instead. */
export function toast(text, { action, onAction, error = false, ms = 5000 } = {}) {
  const box = document.querySelector("#toasts");
  const same = [...box.children].find((item) => item.dataset.text === text && !item.dataset.leaving);
  if (same) {
    clearTimeout(Number(same.dataset.timer));
    same.dataset.timer = String(setTimeout(() => dismiss(same), ms));
    return;
  }
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.dataset.text = text;
  if (error) node.setAttribute("role", "alert");
  const span = document.createElement("span");
  span.textContent = text;
  node.append(span);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action;
    button.addEventListener("click", () => {
      dismiss(node);
      onAction?.();
    });
    node.append(button);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-x";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  close.addEventListener("click", () => dismiss(node));
  node.append(close);
  [...box.children]
    .filter((item) => !item.dataset.leaving)
    .slice(0, -1)
    .forEach(dismiss);
  box.append(node);
  node.dataset.timer = String(setTimeout(() => dismiss(node), ms));
}
function dismiss(node) {
  if (node.dataset.leaving) return;
  node.dataset.leaving = "1";
  clearTimeout(Number(node.dataset.timer));
  node.classList.add("leaving");
  setTimeout(() => node.remove(), 160);
}

/** One short status next to the control that changed ("Saved · Coordinator thinking: high"). `slot` is the element that shows it;
 * it clears itself after a few seconds, and a newer status replaces an older one. */
export function inline(slot, text, { error = false } = {}) {
  if (!slot) return toast(text, { error });
  clearTimeout(Number(slot.dataset.timer));
  slot.textContent = `${error ? "⚠ " : "✓ "}${text}`;
  slot.classList.toggle("error", error);
  slot.classList.remove("fade");
  void slot.offsetWidth; // restart the entry animation
  slot.classList.add("show");
  slot.dataset.timer = String(
    setTimeout(
      () => {
        slot.classList.remove("show");
        slot.classList.add("fade");
      },
      error ? 8000 : 3500,
    ),
  );
}

export function fail(error) {
  console.warn(error);
  if (error?.neverLoaded) return; // the view itself says it was never loaded
  toast(error?.message ?? String(error), { error: true, ms: 8000 });
}
