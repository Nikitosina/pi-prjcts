// Section probe for scripts/plugin-sections-e2e.mjs: a settings and a chat section whose views the test picks with `set-mode`,
// and RPC methods that record every call and every read, so the test sees exactly what the page sent.
const hostile = "<img src=x onerror=sectionsHacked=1>";
const reads = [];
const calls = [];
let mode = "normal";
let failNext = 0;
let slowMs = 0;
let inFlight = 0;
let maxInFlight = 0;

function settingsView(projectId) {
  const count = calls.filter((call) => call.method === "bump" && call.projectId === projectId).length;
  if (mode === "hostile")
    return {
      rows: [
        {
          label: `L${hostile}`,
          text: `T${hostile}`,
          status: { label: `S${hostile}`, tone: "good" },
          detail: [`D${hostile}`],
          links: [{ label: `K${hostile}`, url: "https://example.test/a?b=<c>" }],
          buttons: [{ label: `B${hostile}`, method: "wipe", confirm: `C${hostile}` }],
          html: "<b id=extra>x</b>",
          onclick: "window.sectionsHacked=2",
        },
      ],
      footer: `F${hostile}`,
      script: "window.sectionsHacked=3",
    };
  if (mode === "empty") return { rows: [], empty: `E${hostile}` };
  if (mode === "badlink") return { rows: [{ text: "x", links: [{ label: "run", url: "javascript:alert(1)" }] }] };
  if (mode === "datalink") return { rows: [{ text: "x", links: [{ label: "run", url: "data:text/html,hi" }] }] };
  if (mode === "relative") return { rows: [{ text: "x", links: [{ label: "run", url: "/api" }] }] };
  if (mode === "toomany") return { rows: Array.from({ length: 51 }, (_, i) => ({ text: `row ${i}` })) };
  if (mode === "longtext") return { rows: [{ text: "x".repeat(501) }] };
  if (mode === "badtone") return { rows: [{ text: "x", status: { label: "odd", tone: "purple" } }] };
  if (mode === "bigparams")
    return { rows: [{ text: "x", buttons: [{ label: "Big", method: "bump", params: { blob: "x".repeat(2100) } }] }] };
  if (mode === "notjson") return { rows: [{ text: "x", buttons: [{ label: "Fn", method: "bump", params: { at: 10n } }] }] };
  if (mode === "nomethod") return { rows: [{ text: "x", buttons: [{ label: "Gone", method: "missing" }] }] };
  if (mode === "nopolicy") return { rows: [{ text: "x", buttons: [{ label: "Loose", method: "loose" }] }] };
  if (mode === "noconfirm") return { rows: [{ text: "x", buttons: [{ label: "Wipe", method: "wipe" }] }] };
  return {
    rows: [
      {
        label: "Project",
        text: projectId ?? "none",
        status: { label: `bumped ${count}`, tone: count ? "good" : "neutral" },
        links: [{ label: "Docs", url: "https://example.test/docs" }],
        buttons: [
          { label: "Bump", method: "bump", params: { by: 1 } },
          { label: "Wipe", method: "wipe", confirm: "Wipe all probe data?" },
        ],
      },
      {
        label: "More",
        text: "policy by params, refusals and lost answers",
        buttons: [
          { label: "Hard", method: "maybe", params: { hard: true }, confirm: "Hard reset?" },
          { label: "Soft", method: "maybe", params: { hard: false } },
        ],
      },
      {
        label: "Calls",
        text: "answers",
        buttons: [
          { label: "Refuse", method: "refuse" },
          { label: "Lost", method: "lost" },
        ],
      },
    ],
    footer: `mode ${mode}`,
  };
}

async function track(section, context, view) {
  reads.push({ section, ...context, at: Date.now() });
  if (section === "main" && failNext > 0) {
    failNext--;
    throw new Error(`probe read failed <b>${hostile}</b>`);
  }
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (slowMs) await new Promise((ok) => setTimeout(ok, slowMs));
    return view();
  } finally {
    inFlight--;
  }
}

export default {
  name: "probe",
  register(api) {
    api.provide({
      rpc: {
        "set-mode": async ({ params }) => {
          mode = params.mode ?? mode;
          failNext = params.failNext ?? failNext;
          slowMs = params.slowMs ?? slowMs;
          if (params.resetCounts) maxInFlight = 0;
          return { mode };
        },
        log: async () => ({ reads, calls, maxInFlight }),
        bump: async ({ projectId, params }) => (calls.push({ method: "bump", projectId, params }), { ok: true }),
        wipe: async ({ projectId, params }) => (calls.push({ method: "wipe", projectId, params }), { ok: true }),
        maybe: async ({ projectId, params }) => (calls.push({ method: "maybe", projectId, params }), { ok: true }),
        loose: async () => ({ ok: true }),
        refuse: async () => {
          throw new Error("probe refused <b>this</b>");
        },
        // Answered normally; the test drops this answer in the page, as if the connection broke after the host acted.
        lost: async ({ projectId, params }) => (calls.push({ method: "lost", projectId, params }), { ok: true }),
      },
      rpcPolicy: {
        "set-mode": "write",
        log: "read",
        bump: "write",
        wipe: "dangerous",
        maybe: (params) => (params?.hard ? "dangerous" : "write"),
        refuse: "write",
        lost: "write",
      },
      sections: {
        main: {
          title: "Probe settings",
          place: "settings",
          refreshMs: 2000,
          read: (context) => track("main", context, () => settingsView(context.projectId)),
        },
        side: {
          title: "Probe chat",
          place: "chat",
          refreshMs: 2000,
          read: (context) =>
            track("side", context, () => ({
              rows: [{ text: `chat ${context.chatId}`, detail: [`project ${context.projectId}`] }],
              footer: mode === "hostile" ? `F${hostile}` : undefined,
            })),
        },
      },
    });
  },
};
