// A plugin with a quick RPC, a held RPC, a web route and a cleanup step, for per-project enable/disable (plugin-enable-e2e).
const waiting = [];
export const calls = [];
const paused = new Set();
let toolRuns = 0,
  listCalls = 0;
export default {
  name: "gated",
  register(api) {
    const { defineTool, defineExtension } = api.lib.durable,
      { Type } = api.lib.typebox;
    const ping = defineTool({
      name: "gated_ping",
      description: "Counts one run; for the per-project enable test.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "safe",
      async execute() {
        toolRuns++;
        return { output: [{ type: "text", text: "gated_ping ran" }] };
      },
    });
    api.provide({
      coordinatorTools: {
        applies: () => true,
        create: () => ({ tools: [ping], extension: defineExtension({ name: "projects.gated", tools: [ping] }) }),
      },
      prs: {
        id: "gatedprs",
        label: "Gated",
        watchDocKind: "gated.watch",
        url: (id) => `https://gated.invalid/${id}`,
        applies: () => true,
        list: async () => (listCalls++, { prs: [], fetchedAtMs: Date.now(), error: null, rateLimitedUntilMs: null }),
        detail: async (_project, id) => ({
          id,
          title: "x",
          status: "open",
          url: "",
          conflicts: false,
          counts: { ok: 0, failed: 0, running: 0 },
          failedChecks: [],
        }),
        parseRefs: () => [],
        status: async () => ({ status: "open", merged: false, closed: false }),
        published: async () => [],
      },
      rpc: {
        ping: async ({ projectId }) => ({ pong: projectId }),
        hold: async () => new Promise((resolve) => waiting.push(resolve)).then(() => ({ held: true })),
        release: async () => (waiting.splice(0).forEach((resolve) => resolve()), { released: true }),
        waiting: async () => ({ count: waiting.length }),
        counters: async () => ({ toolRuns, listCalls, paused: [...paused] }),
      },
      rpcPolicy: { ping: "read", hold: "write", release: "write", waiting: "read", counters: "read" },
      web: { routes: { data: async ({ projectId }) => ({ mime: "text/plain", bytes: Buffer.from(`data:${projectId}`) }) } },
      lifecycle: { pause: (projectId) => (paused.add(projectId), () => paused.delete(projectId)) },
      cleanup: async ({ projectId }) => (calls.push(projectId), ""),
    });
    api.stateDir;
  },
};
