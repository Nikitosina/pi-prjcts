// E2E: knowledge as Memory (docs/ui2-contract.md "Memory"): memory-index, memory-undo and the prompt brief and index.
// Private host, fake provider, owner-written fixture files. Failure cases M1-M10 in scripts/ui2-backend-failures.md.
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createKit, say, randomUUID } from "./lib/e2e-kit.mjs";

const kit = await createKit("memory", { handler: ({ role }) => say(`OK ${role}`) });
const UUID = "0b6f3c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const files = {
  "preferences.md": "# Preferences\n\nPREF-MARK Always answer in British English.\n",
  "MEMORY.md": "# Project memory\n\nHAND-WRITTEN-INDEX-MARK\n",
  "decisions/dataset-ux.md":
    "# Dataset UX\n\nRows open a side panel, not a page.\n\nSee [the runbook](../runbooks/fixtures.md) and [gone](missing.md).\n",
  "decisions/old-ux.md": "---\nstatus: superseded\nsupersededBy: decisions/dataset-ux.md\n---\n# Old dataset UX\n\nRows opened a page.\n",
  "decisions/ghost.md": "---\nsupersededBy: decisions/nowhere.md\n---\n# Ghost\n\nReplaced by nothing.\n",
  "runbooks/fixtures.md":
    "---\nkind: decision\nsummary: Use the seeded fixtures, never production data.\nsource:\n  chatId: main\n  entryId: 42\nlastConfirmedAt: 2026-11-01\n---\n# Fixtures\n\nBody text. [external](https://example.com/x.md)\n",
  "runbooks/broken-front.md": "---\nkind decision without colon\n---\n# Broken front\n\nStill a procedure.\n",
  "plans/next.md": "# ARCHIVE-PLAN-MARK\n\nOld plan.\n",
  "research/legacy/notes.md": "# ARCHIVE-LEGACY-MARK\n\nOld notes.\n",
  [`architecture/${UUID}.md`]: "# ARCHIVE-UUID-MARK\n\nImported note.\n",
};

await kit.run(async () => {
  const { rpc, check, rejects, result } = kit;
  kit.initRepo();
  const id = await kit.createProject("Memory");
  const root = join(kit.home, id, "knowledge");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const tree = () => {
    const seen = {};
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".knowledge") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else seen[relative(root, full)] = `${statSync(full).mtimeMs}:${readFileSync(full, "utf8")}`;
      }
    };
    visit(root);
    return JSON.stringify(seen);
  };
  const before = tree();
  const index = await rpc({ action: "memory-index", projectId: id });
  const full = await rpc({ action: "memory-index", projectId: id, includeArchive: true });
  check("M1 reading the index moves and rewrites nothing", tree() === before);
  const entry = (path, list = full.entries) => list.find((item) => item.path === path);
  check(
    "M2 folders classify files without front matter",
    entry("preferences.md").kind === "preference" &&
      entry("decisions/dataset-ux.md").kind === "decision" &&
      entry("runbooks/broken-front.md").kind === "procedure" &&
      entry("plans/next.md").kind === "archive" &&
      entry("research/legacy/notes.md").kind === "archive" &&
      entry(`architecture/${UUID}.md`).kind === "archive",
    full.entries.map((item) => [item.path, item.kind]),
  );
  const fixtures = entry("runbooks/fixtures.md");
  check(
    "M2 front matter wins over the folder",
    fixtures.kind === "decision" &&
      fixtures.summary === "Use the seeded fixtures, never production data." &&
      fixtures.source?.chatId === "main" &&
      fixtures.source?.entryId === 42 &&
      fixtures.lastConfirmedAt === "2026-11-01" &&
      fixtures.title === "Fixtures",
    fixtures,
  );
  check("M3 malformed front matter falls back to the folder", entry("runbooks/broken-front.md").title === "Broken front");
  check(
    "M4 archive entries are left out unless asked for",
    !index.entries.some((item) => item.kind === "archive") && full.entries.some((item) => item.kind === "archive"),
  );
  const broken = JSON.stringify(full.brokenLinks);
  check(
    "M5 broken links and supersededBy targets are listed, external links are not",
    broken.includes('"to":"decisions/missing.md"') &&
      broken.includes('"to":"decisions/nowhere.md"') &&
      !broken.includes("example.com") &&
      !broken.includes("runbooks/fixtures.md"),
    full.brokenLinks,
  );
  check(
    "M9 a superseded decision names its replacement",
    entry("decisions/old-ux.md").status === "superseded" && entry("decisions/old-ux.md").supersededBy === "decisions/dataset-ux.md",
  );

  // Undo restores the prior text, removes a just-created entry and refuses a stale revision.
  const prefs = await rpc({ action: "knowledge-read", id, path: "preferences.md" });
  const written = await rpc({
    action: "knowledge-write",
    id,
    path: "preferences.md",
    text: "# Preferences\n\nChanged.\n",
    expectedRevision: prefs.revision,
  });
  check(
    "M6 a stale undo is refused",
    (await rejects({ action: "memory-undo", projectId: id, path: "preferences.md", revision: prefs.revision })) !== null,
  );
  const undone = await rpc({ action: "memory-undo", projectId: id, path: "preferences.md", revision: written.revision });
  check(
    "M6 undo restores the exact previous text",
    readFileSync(join(root, "preferences.md"), "utf8") === files["preferences.md"] && undone.entry.kind === "preference",
  );
  const history = await rpc({ action: "knowledge-history", id, path: "preferences.md" });
  check(
    "M6 the undo is a revision in history",
    history.some((item) => item.author === "memory-undo"),
    history.map((item) => item.author),
  );
  const created = await rpc({
    action: "knowledge-write",
    id,
    path: "decisions/new.md",
    text: "# New\n\nJust made.\n",
    expectedRevision: null,
  });
  const removed = await rpc({ action: "memory-undo", projectId: id, path: "decisions/new.md", revision: created.revision });
  check(
    "M6 undoing a creation removes the entry",
    removed.entry === null &&
      !(await rpc({ action: "memory-index", projectId: id })).entries.some((item) => item.path === "decisions/new.md"),
  );

  // The prompt carries the generated index and the preferences brief, for every role.
  await kit.ask(id, "MEMORY-TURN hello");
  const coordinator = result.calls.findLast((call) => call.role === "coordinator").system;
  check(
    "M7 the generated index replaces MEMORY.md and leaves the archive out",
    coordinator.includes("Dataset UX") &&
      coordinator.includes("Use the seeded fixtures") &&
      !coordinator.includes("HAND-WRITTEN-INDEX-MARK") &&
      !/ARCHIVE-(PLAN|LEGACY|UUID)-MARK/.test(coordinator),
  );
  check(
    "M9 the prompt index marks the superseded decision",
    /Old dataset UX[^\n]*superseded by decisions\/dataset-ux\.md/.test(coordinator),
  );
  check(
    "M8 the coordinator prompt carries current preferences with a revision",
    /PREF-MARK/.test(coordinator) && /preferences\.md @ [a-f0-9]{12}/.test(coordinator),
  );
  check(
    "M10 the coordinator prompt states the auto-remember rules",
    /lasting preference, save it/.test(coordinator) && /never grants execution authority/.test(coordinator),
  );
  const scopeId = (await rpc({ action: "workspace-catalog", id })).find((scope) => scope.wholeRepository).id;
  await rpc({
    action: "work-submit",
    id,
    threadId: randomUUID(),
    requestId: randomUUID(),
    workspaceScopeId: scopeId,
    text: "MEMORY-WORKER go",
  });
  await kit.eventually(
    async () => result.calls.some((call) => call.role === "worker" && call.user.includes("MEMORY-WORKER")),
    "worker request",
  );
  const worker = result.calls.find((call) => call.role === "worker" && call.user.includes("MEMORY-WORKER")).system;
  check("M8 a worker prompt carries the same preferences", worker.includes("PREF-MARK"));
  writeFileSync(join(root, "preferences.md"), `# Preferences\n\n${"P".repeat(9000)}\n`);
  const render = await rpc({ action: "prompt-render", projectId: id, profile: "scout" });
  const preferences = render.sections.find((section) => section.id === "preferences");
  check(
    "M8 the preferences brief is bounded and its own prompt-render section",
    preferences.label === "Preferences (memory)" && preferences.text.length <= 4000,
    preferences.text.length,
  );
  await kit.settle(id);
});
