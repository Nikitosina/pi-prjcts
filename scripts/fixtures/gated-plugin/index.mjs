// A plugin with a quick RPC, a held RPC, a web route and a cleanup step, for per-project enable/disable (plugin-enable-e2e).
const waiting = [];
export const calls = [];
const paused = new Set();
let toolRuns = 0,
  listCalls = 0;
const observed = new Map();
const asked = new Map(),
  checking = [],
  roots = new Map();
const touchedBy = new Map(),
  publishedBy = new Map(),
  listedBy = new Map();
export default {
  name: "gated",
  register(api) {
    const { defineTool, defineExtension, defineDoc } = api.lib.durable,
      { Type } = api.lib.typebox;
    const Uncertain = defineDoc({
      kind: "gated.uncertain",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      checkpointWhen: () => false,
      initial: () => ({ mode: "no", project: "" }),
    });
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
        prompt: { name: "Gated rules", text: "GATED-RULE-MARKER", on: () => true },
        create: () => ({ tools: [ping], extension: defineExtension({ name: "projects.gated", tools: [ping] }) }),
      },
      prs: {
        id: "gatedprs",
        label: "Gated",
        watchDocKind: "gated.watch",
        url: (id) => `https://gated.invalid/${id}`,
        applies: () => true,
        list: async (project) => (
          listCalls++,
          listedBy.set(project.id, (listedBy.get(project.id) ?? 0) + 1),
          { prs: [], fetchedAtMs: Date.now(), error: null, rateLimitedUntilMs: null }
        ),
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
      follow: {
        id: "gatedfollow",
        eventKind: "gatedfollow.follow",
        label: "Gated follow",
        repository: (project) => ({ repositoryId: `gated/${project.id}` }),
        observe: async ({ project }) => (
          observed.set(project.id, (observed.get(project.id) ?? 0) + 1),
          { state: { baselined: true, prs: {} }, items: [], failed: [] }
        ),
        published: async (_root, project) => (publishedBy.set(project.id, (publishedBy.get(project.id) ?? 0) + 1), []),
      },
      rpc: {
        ping: async ({ projectId }) => ({ pong: projectId }),
        hold: async () => new Promise((resolve) => waiting.push(resolve)).then(() => ({ held: true })),
        // An RPC without a project id that reaches into a project named in its params (a host-wide plugin working for one project).
        touch: async ({ params, withRoot }) =>
          withRoot(
            params.projectId,
            async () => (touchedBy.set(params.projectId, (touchedBy.get(params.projectId) ?? 0) + 1), { touched: params.projectId }),
          ),
        holdin: async ({ params, withRoot }) =>
          withRoot(params.projectId, () => new Promise((resolve) => waiting.push(resolve)).then(() => ({ held: true }))),
        // The unresolved-write record lives in the project's own durable store, like a real plugin's. The root is kept so a test can write it
        // while the project has the plugin off (the gate refuses `withRoot` then).
        "mark-uncertain": async ({ params, withRoot }) => {
          const root = roots.get(params.projectId) ?? (await withRoot(params.projectId, async (value) => value));
          roots.set(params.projectId, root);
          await root.commit(async (tx) => {
            const doc = await tx.doc(Uncertain, root.id);
            doc.mode = params.mode;
            doc.project = params.projectId;
          }, api.lib.chord.BACKGROUND_CONTEXT);
          return { set: params.mode };
        },
        "release-check": async () => (checking.splice(0).forEach((resolve) => resolve()), { released: true }),
        "check-waiting": async () => ({ count: checking.length }),
        release: async () => (waiting.splice(0).forEach((resolve) => resolve()), { released: true }),
        waiting: async () => ({ count: waiting.length }),
        counters: async () => ({
          toolRuns,
          listCalls,
          published: Object.fromEntries(publishedBy),
          listed: Object.fromEntries(listedBy),
          observed: Object.fromEntries(observed),
          asked: Object.fromEntries(asked),
          touched: Object.fromEntries(touchedBy),
          paused: [...paused],
        }),
      },
      uncertainWrites: async (tx, root) => {
        const { mode, project } = await tx.doc(Uncertain, root);
        asked.set(project, (asked.get(project) ?? 0) + 1);
        if (mode === "fail") throw new Error("gated record unreadable");
        if (mode === "hold") await new Promise((resolve) => checking.push(resolve));
        if (mode === "garbage") return undefined;
        return mode === "yes";
      },
      rpcPolicy: {
        "mark-uncertain": "write",
        "release-check": "write",
        "check-waiting": "read",
        touch: "write",
        holdin: "write",
        ping: "read",
        hold: "write",
        release: "write",
        waiting: "read",
        counters: "read",
      },
      sections: { data: { title: "Gated", place: "settings", read: async ({ projectId }) => ({ rows: [{ text: `data:${projectId}` }] }) } },
      lifecycle: { pause: (projectId) => (paused.add(projectId), () => paused.delete(projectId)) },
      cleanup: async ({ projectId }) => (calls.push(projectId), ""),
    });
    api.stateDir;
  },
};
