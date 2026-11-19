// Plugins for plugin-sidebar-e2e that opt in to a right-panel section (scripts/plugin-sidebar-failures.md).
import { fileURLToPath } from "node:url";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const sidebarPlugin = (name, title, script, { rpc, routes } = {}) => ({
  name,
  version: "0.1.0",
  register(api) {
    api.provide({
      ...(rpc ? { rpc, rpcPolicy: Object.fromEntries(Object.keys(rpc).map((method) => [method, "read"])) } : {}),
      web: {
        script: fileURLToPath(new URL(script, import.meta.url)),
        sidebar: title ? { title } : {},
        ...(routes ? { routes } : {}),
      },
    });
  },
});

export const slowRead = async ({ projectId, params }) => {
  if (params?.slow) await wait(params.slow);
  if (params?.fail) throw new Error("stale read failed");
  return { projectId, chatId: params?.chatId ?? null };
};
