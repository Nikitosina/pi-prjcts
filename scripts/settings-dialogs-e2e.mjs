// E2E: Settings host contracts + model picker catalog (the classic dialogs were retired on 2026-11-04). Isolated host, fake model,
// fake Pi settings.json (enabledModels), fake gh, no real providers. Failure cases: settings-dialogs-failures.md.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";

const kit = await createKit("settings-dialogs");
const { check, rpc, root, repo } = kit;

// Fake Pi config: custom providers on top of the fake model, and the owner's scoped list (globs, thinking suffix, a miss).
const modelsPath = join(kit.agentDir, "models.json"),
  models = JSON.parse(readFileSync(modelsPath, "utf8"));
const entry = (id, name, contextWindow, reasoning = false) => ({ id, name, reasoning, input: ["text"], contextWindow, maxTokens: 4096 });
const provider = (list) => ({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "fake", api: "openai-completions", models: list });
models.providers.alpha = provider([
  entry("a-one", "Alpha One", 272000, true),
  entry("a-two", "Alpha Two", 1000000),
  entry("a-three", "Claude Opus Bridge", 200000, true),
]);
models.providers.bulk = provider(
  Array.from({ length: 60 }, (_, i) => entry(`bulk-${String(i).padStart(2, "0")}`, `Bulk Model ${i}`, 128000)),
);
writeFileSync(modelsPath, JSON.stringify(models));
const settingsFile = join(kit.agentDir, "settings.json");
writeFileSync(
  settingsFile,
  JSON.stringify({ enabledModels: ["fake/fake-model", "alpha/*", "bulk/bulk-01:high", "zzz/none", "bulk/bulk-01"] }),
);
for (const key of Object.keys(kit.hostEnv)) if (/(API_KEY|_TOKEN|SECRET)/i.test(key)) delete kit.hostEnv[key]; // built-in providers stay unconfigured

// GitHub: fake gh + bare remote so the known-PR form is reachable.
const bare = join(root, "remote.git"),
  fakeGh = join(root, "fake-gh"),
  ghState = join(root, "fake-gh-state.json");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "scripts/fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
writeFileSync(
  ghState,
  JSON.stringify({ repo: { id: 4242, full_name: "acme/mari", default_branch: "main" }, issues: [], checks: {}, pulls: [] }),
);
writeFileSync(join(root, "gh-calls.jsonl"), "");
execFileSync("/usr/bin/git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
Object.assign(kit.hostEnv, {
  PI_PROJECTS_GH_CLI: fakeGh,
  FAKE_GH_STATE: ghState,
  FAKE_GH_BARE: bare,
  FAKE_GH_CALLS: join(root, "gh-calls.jsonl"),
});
kit.initRepo();
kit.git(kit.workspace, "remote", "add", "origin", "https://github.com/acme/mari.git");
kit.git(kit.workspace, "config", "remote.origin.pushurl", bare);
kit.git(kit.workspace, "push", "-q", "origin", "main");
mkdirSync(join(kit.artifacts, "shots"), { recursive: true });

await kit.run(async () => {
  const id = await kit.createProject("Mari");
  // create connects GitHub one-click by itself (docs/ui2-contract.md, create).
  if (!(await rpc({ action: "owner-setup-snapshot", id })).github?.length) throw Error("create did not connect GitHub");
  const bare2 = await kit.createProject("Fresh", { grant: false });
  // Projects get a whole-repository scope automatically; the owner revokes it here to exercise the re-grant dialog.
  {
    const first = await rpc({ action: "owner-setup-snapshot", id: bare2 });
    await rpc({
      action: "workspace-revoke",
      id: bare2,
      confirm: bare2,
      scopeId: first.workspace.scopes[0].id,
      expectedRevision: first.workspaceRevision,
    });
  }

  // Host: scoped list = Pi enabledModels resolved by Pi, configured only, deduped; missing/corrupt settings.json degrades to no scope.
  const picker = await rpc({ action: "model-picker-snapshot" });
  const expectedScoped = ["fake/fake-model", "alpha/a-one", "alpha/a-two", "alpha/a-three", "bulk/bulk-01"];
  check(
    "scoped models resolve globs, :thinking suffix, drop misses, dedupe",
    JSON.stringify(picker.scoped) === JSON.stringify(expectedScoped),
    picker.scoped,
  );
  check(
    "offline: networkChecked false, unconfigured models listed but flagged",
    picker.networkChecked === false &&
      picker.items.some((m) => !m.configured) &&
      picker.scoped.every((r) => picker.items.find((m) => m.reference === r)?.configured),
  );
  writeFileSync(settingsFile, "{not json");
  check("corrupt settings.json -> empty scope, picker still works", (await rpc({ action: "model-picker-snapshot" })).scoped.length === 0);
  writeFileSync(
    settingsFile,
    JSON.stringify({ enabledModels: ["fake/fake-model", "alpha/*", "bulk/bulk-01:high", "zzz/none", "bulk/bulk-01"] }),
  );

  // The classic Settings dialogs were retired on 2026-11-04 (docs/classic-retirement.md). The host contracts they relied on stay.
  const before = await rpc({ action: "settings-snapshot", id });
  await kit.updateSettings(id, { objective: "changed elsewhere" });
  check(
    "stale revision: the host rejects a save made against an older revision, no rebase",
    (await kit.rejects({ action: "settings-update", id, confirm: id, expectedRevision: before.revision, changes: { name: "Stale" } })) !==
      null && (await rpc({ action: "settings-snapshot", id })).values.name === "Mari",
  );
  await kit.updateSettings(id, { models: { worker: "alpha/a-two" }, stallMinutes: 45 });
  const saved = await rpc({ action: "settings-snapshot", id });
  check(
    "a save changes only the fields sent: worker model + stall minutes changed, others intact",
    saved.values.models.worker === "alpha/a-two" &&
      saved.values.stallMinutes === 45 &&
      saved.values.model === "fake/fake-model" &&
      saved.values.name === "Mari" &&
      saved.values.objective === "changed elsewhere",
    saved.values,
  );
  check(
    "host rejects an unconfigured model",
    (await kit.rejects({
      action: "settings-update",
      id,
      confirm: id,
      expectedRevision: saved.revision,
      changes: { models: { worker: picker.items.find((m) => !m.configured).reference } },
    })) !== null,
  );
});
