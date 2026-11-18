// Plugin sections in the right panel: every loaded plugin that opted in (web.sidebar) gets one section under Workers and Pull requests.
// Sections mount once per project/chat selection and are aborted and replaced by the next one; a refresh of jobs, chat or PRs never touches them.
import { call } from "./api.js";
import { mountSections, sectionNodes } from "./plugins.js";
import { on, state, stale } from "./state.js";

const box = document.querySelector("#plugin-sections");
let web = null; // the plugins RPC's `web`, read once per page; a failed read is retried on the next selection
let unmount = () => {};

const webOnce = () =>
  (web ??= call("plugins").then(
    (status) => status.web,
    (error) => {
      web = null;
      throw error;
    },
  ));

on("select", async ({ projectId, chatId }) => {
  const gen = state.generation;
  unmount();
  unmount = () => {};
  box.replaceChildren();
  box.hidden = true;
  const items = await webOnce().catch((error) => void console.warn(error));
  if (!items || stale(gen)) return;
  const nodes = sectionNodes(items);
  if (!nodes.length) return;
  box.replaceChildren(...nodes);
  box.hidden = false;
  unmount = mountSections(nodes, items, { projectId, chatId });
});
