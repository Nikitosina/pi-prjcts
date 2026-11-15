// A plugin with a quick RPC, a held RPC, a web route and a cleanup step, for per-project enable/disable (plugin-enable-e2e).
const waiting = [];
export const calls = [];
export default {
  name: "gated",
  register(api) {
    api.provide({
      rpc: {
        ping: async ({ projectId }) => ({ pong: projectId }),
        hold: async () => new Promise((resolve) => waiting.push(resolve)).then(() => ({ held: true })),
        release: async () => (waiting.splice(0).forEach((resolve) => resolve()), { released: true }),
        waiting: async () => ({ count: waiting.length }),
      },
      rpcPolicy: { ping: "read", hold: "write", release: "write", waiting: "read" },
      web: { routes: { data: async ({ projectId }) => ({ mime: "text/plain", bytes: Buffer.from(`data:${projectId}`) }) } },
      cleanup: async ({ projectId }) => (calls.push(projectId), ""),
    });
    api.stateDir;
  },
};
