// Plugin sections in the right panel: every chat section of a plugin enabled for this project, under Workers and Pull requests.
// A project/chat selection or a changed set of sections replaces them; a refresh of jobs, chat, PRs or an unchanged plugin status never touches them.
import { on, stale, state } from "./state.js";
import { mountSection, sectionNode } from "./sections.js";

export function mountSidebar(client) {
  const box = document.querySelector("#plugin-sections");
  let mountedKey = null;
  let selectionKey = null;
  let refreshId = 0;
  let unmount = () => {};

  const clear = () => {
    unmount();
    unmount = () => {};
    box.replaceChildren();
    box.hidden = true;
  };

  async function refresh({ projectId, chatId }) {
    const gen = state.generation;
    const ask = ++refreshId;
    const status = projectId ? await client.call("plugins", { id: projectId }).catch((error) => void console.warn(error)) : null;
    if (!status || stale(gen) || ask !== refreshId) return;
    const entries = status.sections.filter((entry) => entry.place === "chat");
    const key = `${projectId}\0${chatId}\0${entries.map((entry) => `${entry.plugin}/${entry.id}/${entry.title}/${entry.refreshMs}`).join("\0")}`;
    if (key === mountedKey) return;
    mountedKey = key;
    clear();
    if (!entries.length) return;
    const nodes = entries.map((entry) => sectionNode(entry, { className: "ctx-section" }));
    box.replaceChildren(...nodes);
    box.hidden = false;
    const unmounts = entries.map((entry, index) => mountSection(client, nodes[index], entry, { projectId, chatId }));
    unmount = () => unmounts.forEach((stop) => stop());
  }

  on("select", (context) => {
    const key = `${context.projectId}\0${context.chatId}`;
    if (key !== selectionKey) {
      selectionKey = key;
      mountedKey = null;
      clear();
    }
    void refresh(context);
  });
  on("plugins-changed", () => void refresh({ projectId: state.projectId, chatId: state.chatId }));
}
