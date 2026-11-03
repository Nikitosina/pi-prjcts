// Shared page state and a tiny event bus. `generation` changes with every project/chat selection; any code that awaits must
// compare it afterwards (`stale(gen)`) before touching the page, so late answers never render into another project.

export const state = {
  projects: [],
  projectId: null,
  chatId: "main",
  generation: 0,
  view: null, // `show` for the selected chat
  jobs: null, // `jobs-snapshot`
  live: null, // last DurableLiveFrame of the selected chat
  connected: false,
  focus: { kind: "chat" }, // center: chat | worker | memory | report
  ui: null, // UiSettings, or null while unknown
  uiRevision: null,
  steer: false, // composer mode while busy: false = queue, true = steer
  limits: null,
  usage: null,
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
      console.error(`${event} handler failed`, error);
    }
  }
}
export const stale = (generation) => generation !== state.generation;
export const project = () => state.projects.find((item) => item.id === state.projectId) ?? null;
export const chatArgs = () => (state.chatId && state.chatId !== "main" ? { chatId: state.chatId } : {});

export function toast(text, { action, onAction, error = false, ms = 5000 } = {}) {
  const box = document.querySelector("#toasts"),
    node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  const span = document.createElement("span");
  span.textContent = text;
  node.append(span);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action;
    button.addEventListener("click", () => {
      node.remove();
      onAction?.();
    });
    node.append(button);
  }
  // At most three at once (two on a phone); the oldest goes first, so a burst never covers the page.
  const keep = matchMedia("(max-width: 600px)").matches ? 2 : 3;
  [...box.children].slice(0, Math.max(0, box.children.length - keep + 1)).forEach((old) => old.remove());
  box.append(node);
  setTimeout(() => node.remove(), ms);
}
export function fail(error) {
  console.warn(error);
  toast(error?.message ?? String(error), { error: true, ms: 8000 });
}
