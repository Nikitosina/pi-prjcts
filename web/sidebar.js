// Plugin sections in the right panel: every plugin enabled for this project that opted in (web.sidebar) gets one section
// under Workers and Pull requests. A project/chat selection or a changed enabled set aborts and replaces the sections;
// a refresh of jobs, chat, PRs or an unchanged plugin status never touches them.
import { call } from "./api.js";
import { mountSections, sectionNodes } from "./plugins.js";
import { on, stale, state } from "./state.js";

const box = document.querySelector("#plugin-sections");
let mountedKey = null;
let selectionKey = null;
let refreshId = 0;
let unmount = () => {};

async function refresh({ projectId, chatId }) {
  const gen = state.generation;
  const ask = ++refreshId;
  // With per-project plugin disable the same RPC returns each plugin's `enabled`; without it every loaded plugin is enabled.
  const status = await call("plugins", { id: projectId }).catch((error) => void console.warn(error));
  if (!status || stale(gen) || ask !== refreshId) return;
  const enabled = new Set(status.plugins.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.name));
  const items = status.web.filter((item) => enabled.has(item.plugin));
  const nodes = sectionNodes(items);
  const key = `${projectId}\0${chatId}\0${nodes.map((node) => node.dataset.plugin).join("\0")}`;
  if (key === mountedKey) return;
  mountedKey = key;
  unmount();
  unmount = () => {};
  box.replaceChildren();
  box.hidden = !nodes.length;
  if (!nodes.length) return;
  box.replaceChildren(...nodes);
  unmount = mountSections(nodes, items, { projectId, chatId });
}

on("select", (context) => {
  const key = `${context.projectId}\0${context.chatId}`;
  if (key !== selectionKey) {
    selectionKey = key;
    mountedKey = null;
    unmount();
    unmount = () => {};
    box.replaceChildren();
    box.hidden = true;
  }
  void refresh(context);
});
on("plugins-changed", () => void refresh({ projectId: state.projectId, chatId: state.chatId }));
