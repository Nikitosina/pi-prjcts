// PROTOTYPE — sample data only. No host requests, no tokens, no writes.
window.MOCK = (() => {
  const now = Date.parse("2026-10-06T10:40:00");
  const min = m => new Date(now - m * 60000);
  const projects = [
    { id: "p1", name: "Keyboard locale rollout", emoji: "⌨️", color: "#c2653a", state: "running", workspace: "~/code/yk-locales", repo: "yandex/yk-locales", needs: 3, workers: 2, updated: 4,
      instructions: "Ship the uk/kk/uz locales behind the remote flag. Never push to main. Every PR needs E2E evidence from the simulator.",
      description: "Locale packs, autocorrect dictionaries and simulator E2E evidence." },
    { id: "p2", name: "Billing webhook hardening", emoji: "🧾", color: "#3a7bc2", state: "paused", workspace: "~/code/billing", repo: "acme/billing", needs: 1, workers: 0, updated: 95,
      instructions: "Idempotency first. No schema migrations without approval.", description: "Retry storms, signature checks, replay protection." },
    { id: "p3", name: "Docs site migration", emoji: "📚", color: "#4c9a5b", state: "idle", workspace: "~/code/docs", repo: "acme/docs", needs: 0, workers: 0, updated: 1440,
      instructions: "Keep URLs stable. Redirect map lives in knowledge/redirects.md.", description: "Move Docusaurus v2 → v3, redirects, search." },
    { id: "p4", name: "Release notes bot", emoji: "🤖", color: "#8a5bc2", state: "archived", workspace: "~/code/notes-bot", repo: "acme/notes-bot", needs: 0, workers: 0, updated: 8000,
      instructions: "", description: "Weekly digest of merged PRs." },
  ];

  const threads = [
    { id: "t0", kind: "coordinator", title: "Coordinator", role: "coordinator", model: "claude-opus-5-5", status: "running", started: min(180), tokens: 412000, cost: 3.12, progress: null,
      messages: [
        { who: "you", at: min(178), text: "Add uk, kk and uz locales. Start with uk; kk and uz can follow once uk passes E2E." },
        { who: "coordinator", at: min(177), text: "Plan: 1) uk locale pack + dictionary (writer), 2) simulator E2E for uk (verifier), 3) kk/uz in parallel after uk lands. I'll queue the uk writer now.", tools: [{ name: "projects_spawn_worker", arg: "role=writer · uk locale pack" }] },
        { who: "coordinator", at: min(64), text: "uk writer finished. Diff touches 14 files. Spawning verifier for simulator E2E.", tools: [{ name: "projects_spawn_worker", arg: "role=verifier · uk E2E" }] },
        { who: "you", at: min(30), text: "Also check that the long-press popover shows ґ." },
        { who: "coordinator", at: min(29), text: "Steered the verifier to cover ґ in the long-press popover.", tools: [{ name: "projects_steer", arg: "t2 · add ґ long-press case" }] },
        { who: "coordinator", at: min(6), text: "Question for you: kk uses Cyrillic by default, but there's a Latin transition. Which layout should ship first?", decision: "d1" },
      ] },
    { id: "t1", kind: "worker", title: "uk locale pack + dictionary", role: "writer", model: "claude-sonnet-5-5", status: "done", started: min(176), ended: min(65), tokens: 288000, cost: 1.41, progress: 1,
      diff: { files: 14, add: 1203, del: 41 },
      messages: [
        { who: "worker", at: min(175), text: "Reading existing ru locale as template.", tools: [{ name: "read", arg: "Locales/ru/layout.json" }, { name: "read", arg: "Locales/ru/dictionary.tsv" }] },
        { who: "worker", at: min(140), text: "Created uk layout with ґ, є, і, ї. Added frequency dictionary (48k entries).", tools: [{ name: "write", arg: "Locales/uk/layout.json" }, { name: "write", arg: "Locales/uk/dictionary.tsv" }, { name: "bash", arg: "make lint-locales" }] },
        { who: "worker", at: min(66), text: "Lint passes. Done. Evidence: lint log, diff summary." },
      ] },
    { id: "t2", kind: "worker", title: "uk simulator E2E", role: "verifier", model: "claude-sonnet-5-5", status: "running", started: min(63), tokens: 96000, cost: 0.52, progress: 0.62,
      messages: [
        { who: "worker", at: min(62), text: "Booting iPhone 17 simulator, installing debug build.", tools: [{ name: "bash", arg: "xcrun simctl boot 'iPhone 17'" }, { name: "bash", arg: "xcodebuild -scheme Keyboard build" }] },
        { who: "worker", at: min(28), text: "Steering received: adding ґ long-press case." },
        { who: "worker", at: min(3), text: "8/13 cases pass. Running long-press popover cases.", tools: [{ name: "simulator_tap", arg: "key=г long-press" }, { name: "screenshot", arg: "uk-longpress-g.png" }] },
      ] },
    { id: "t3", kind: "worker", title: "kk locale pack", role: "writer", model: "claude-sonnet-5-5", status: "queued", started: null, tokens: 0, cost: 0, progress: 0, blockedBy: "Waiting for your answer on kk layout", messages: [] },
    { id: "t4", kind: "worker", title: "uz locale pack", role: "writer", model: "claude-sonnet-5-5", status: "queued", started: null, tokens: 0, cost: 0, progress: 0, blockedBy: "One writer at a time", messages: [] },
  ];

  const decisions = [
    { id: "d1", kind: "question", thread: "t0", title: "Which kk layout ships first?", at: min(6), body: "kk is moving from Cyrillic to Latin. Shipping both doubles the dictionary work.",
      options: ["Cyrillic first (current majority)", "Latin first (future standard)", "Both behind separate flags"] },
    { id: "d2", kind: "approval", thread: "t1", title: "Open PR yandex/yk-locales#412", at: min(60), body: "Writer wants to open a draft PR from branch pi/uk-locale @ 9f3c2e1 → main. 14 files, +1203 −41.",
      provider: "GitHub", effect: "Creates a draft pull request. Does not merge.", head: "9f3c2e1" },
    { id: "d3", kind: "review", thread: "t1", title: "Review uk locale result", at: min(64), body: "Accept the writer's result or request changes. Accepting does not merge or publish.",
      evidence: ["lint-locales.log", "diff-summary.md"] },
  ];

  const knowledge = [
    { kind: "instructions", name: "Project instructions", size: "214 B", updated: min(2000), pinned: true },
    { kind: "topic", name: "locale-conventions.md", size: "3.1 KB", updated: min(900), rev: "a81c" },
    { kind: "topic", name: "simulator-e2e.md", size: "1.8 KB", updated: min(300), rev: "4f02" },
    { kind: "topic", name: "decisions-log.md", size: "6.4 KB", updated: min(29), rev: "c9d1" },
    { kind: "library", name: "Unicode CLDR uk.xml", size: "88 KB", updated: min(4000), hash: "sha256:7e1…b2" },
    { kind: "library", name: "kk Latin alphabet decree.pdf", size: "412 KB", updated: min(3900), hash: "sha256:19a…0c" },
    { kind: "evidence", name: "lint-locales.log", size: "12 KB", updated: min(66), hash: "sha256:a3d…91" },
    { kind: "evidence", name: "uk-longpress-g.png", size: "240 KB", updated: min(3), hash: "sha256:5bb…e7" },
  ];

  // Observability
  const events = [
    [min(178), "info", "t0", "message.received", "Owner message (94 chars)"],
    [min(177), "info", "t0", "worker.spawn", "t1 writer · claude-sonnet-5-5"],
    [min(176), "info", "t1", "durable.acquire", "lease 30s · writer slot 1/1"],
    [min(140), "info", "t1", "tool.bash", "make lint-locales → exit 0 (41s)"],
    [min(120), "warn", "t1", "model.retry", "529 overloaded · retry 1/3 after 4s"],
    [min(65), "info", "t1", "worker.done", "result + 2 evidence items"],
    [min(64), "info", "t0", "worker.spawn", "t2 verifier · claude-sonnet-5-5"],
    [min(60), "info", "t1", "approval.requested", "github.pr.create yandex/yk-locales"],
    [min(45), "warn", "t2", "tool.bash", "xcodebuild took 212s (p95 90s)"],
    [min(29), "info", "t0", "thread.steer", "t2 · confirmed by owner"],
    [min(20), "error", "t2", "tool.simulator_tap", "element 'key-ґ' not found · retrying with popover"],
    [min(15), "info", "host", "schedule.tick", "nightly-dictionary-check skipped (project busy)"],
    [min(6), "info", "t0", "decision.requested", "d1 kk layout"],
    [min(3), "info", "t2", "evidence.add", "uk-longpress-g.png"],
    [min(1), "info", "host", "health", "durable ok · socket ok · 2 leases"],
  ].map(([at, level, src, type, msg]) => ({ at, level, src, type, msg }));

  // tokens per 10-min bucket over last 3h (input, output)
  const usage = Array.from({ length: 18 }, (_, i) => {
    const t = i / 17;
    return { input: Math.round(18000 + 30000 * Math.sin(t * 5) ** 2 + (i > 11 ? 12000 : 0)), output: Math.round(4000 + 6000 * Math.cos(t * 4) ** 2) };
  });
  const routines = [
    { name: "nightly-dictionary-check", cron: "0 3 * * *", next: "03:00", last: "skipped", enabled: true },
    { name: "weekly CLDR sync", cron: "0 9 * * MON", next: "Mon 09:00", last: "ok · 2 notes", enabled: true },
    { name: "PR CI watcher", cron: "on github.check_suite", next: "event", last: "ok", enabled: false },
  ];
  const receipts = [
    { kind: "PR", ref: "#409 da locale", state: "merged", ci: "pass", at: min(3000) },
    { kind: "PR", ref: "#412 uk locale", state: "awaiting approval", ci: "—", at: min(60) },
    { kind: "CI", ref: "main @ 77ab01", state: "pass", ci: "pass", at: min(500) },
  ];
  const health = { durable: "ok", socket: "ok", awake: "caffeinate on", leases: "2/4", uptime: "3h 12m", queueDepth: 2, p95Tool: "38s", errors1h: 1 };
  const setup = [
    { step: "Workspace scope", done: true, detail: "~/code/yk-locales · write · rev 97294f" },
    { step: "GitHub target", done: true, detail: "yandex/yk-locales (id 88123) · default main" },
    { step: "Command profile", done: false, detail: "Not set — workers can't run fixed `make` profile" },
    { step: "Worker skills", done: false, detail: "0 granted · 3 available in repo" },
  ];
  return { now, projects, threads, decisions, knowledge, events, usage, routines, receipts, health, setup };
})();
