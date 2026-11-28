// The views that show data of one host (web/offline.js): each has a key, and its primary read passes the key to the host client
// (`call(..., { view })`), which remembers the connection period of its last live read. Settings and the Host agent publish the section they show
// in `state.panels` with the client that owns its data.
import { emit, state } from "./state.js";

export const chatViewKey = (projectId = state.projectId, chatId = state.chatId) => `chat:${projectId}/${chatId}`;
export const focusViewKey = (focus = state.focus) => `focus:${focus.kind}:${focus.id ?? focus.path ?? ""}`;

/** `[{ client, key }]` of every view that is open and shows data of a host. */
export function openViews() {
  const views = [];
  if (state.host && state.projectId) views.push({ client: state.host, key: chatViewKey() });
  if (state.host && state.projectId && state.focus.kind !== "chat") views.push({ client: state.host, key: focusViewKey() });
  for (const panel of Object.values(state.panels)) if (panel) views.push(panel);
  return views;
}
/** Settings or the Host agent opened, changed section, or closed (`panel` null). */
export function setPanel(name, panel) {
  state.panels[name] = panel;
  emit("panels", name);
}
