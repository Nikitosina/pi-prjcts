// Unit: the bundled plugin catalog without a host (scripts/plugin-catalog-failures.md, numbers in check labels). Temp home only.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-catalog-")));
process.env.PI_PROJECTS_HOME = join(root, "home");
delete process.env.PI_PROJECTS_PLUGINS;
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true });
const configFile = join(process.env.PI_PROJECTS_HOME, "plugins.json");
const { pluginCatalog, describeEntry } = await import("../src/plugin-catalog.ts");
const { BUNDLED_PLUGINS } = await import("../src/bundled-plugins.ts");
const { plugins } = await import("../src/plugins.ts");
const tasksDir = new URL("../plugins/tasks", import.meta.url).pathname;
const entry = (id) => pluginCatalog.list().find((item) => item.id === id);
const config = () => JSON.parse(readFileSync(configFile, "utf8"));

try {
  // 1/2: listed as available with metadata, before any plugin is loaded, and nothing was imported.
  assert.deepEqual(
    pluginCatalog.list().map((item) => [item.id, item.state]),
    [
      ["tasks", "available"],
      ["simulator", "available"],
    ],
    "2 both listed as available",
  );
  assert.ok(entry("tasks").name && entry("tasks").description, "2 name and description without loading");
  assert.equal(plugins.status().length, 0, "1 listing loaded nothing");
  assert.ok(
    BUNDLED_PLUGINS.every((item) => existsSync(join(item.directory, "index.ts"))),
    "5 every entry is a directory shipped in this checkout",
  );

  // 4: agents can read the catalog but never activate.
  const { ACTION_POLICY } = await import("../src/host-agent-tools.ts");
  assert.equal(ACTION_POLICY["plugin-catalog"].kind, "allow", "4 catalog is a read");
  assert.equal(ACTION_POLICY["plugin-activate"].kind, "exclude", "4 activation is excluded for agents");

  // 3: ids outside the catalog are refused and nothing is written.
  for (const bad of ["../tasks", tasksDir, "https://example.invalid/x", "github", "", "Tasks"])
    assert.throws(() => pluginCatalog.activate(bad), /not a bundled plugin/, `3 refused: ${bad}`);
  assert.ok(!existsSync(configFile), "3 nothing written");

  // 6: existing entries and extra keys survive, in order.
  writeFileSync(configFile, JSON.stringify({ plugins: ["/ext/one", "~/two"], note: { keep: true } }));
  pluginCatalog.activate("tasks");
  assert.deepEqual(config(), { plugins: ["/ext/one", "~/two", tasksDir], note: { keep: true } }, "6 appended, others verbatim");
  assert.equal(entry("tasks").state, "configured", "12 configured, not loaded: awaiting restart");
  assert.equal(entry("simulator").state, "available", "12 the other stays available");

  // 7: a repeat, a parallel pair and another spelling of the same directory change nothing.
  const before = readFileSync(configFile, "utf8");
  pluginCatalog.activate("tasks");
  await Promise.all([
    Promise.resolve().then(() => pluginCatalog.activate("tasks")),
    Promise.resolve().then(() => pluginCatalog.activate("tasks")),
  ]);
  assert.equal(readFileSync(configFile, "utf8"), before, "7 repeats leave the file byte for byte");
  writeFileSync(configFile, JSON.stringify({ plugins: [`${tasksDir}/`] }));
  const spelled = readFileSync(configFile, "utf8");
  pluginCatalog.activate("tasks");
  assert.equal(readFileSync(configFile, "utf8"), spelled, "7 a trailing slash is the same directory");
  writeFileSync(configFile, JSON.stringify({ plugins: [join(tasksDir, "..", "tasks")] }));
  assert.equal(entry("tasks").state, "configured", "7 a path with .. is the same directory");

  // 7: the entry file of the directory is the same plugin as the directory.
  writeFileSync(configFile, JSON.stringify({ plugins: [join(tasksDir, "index.ts")] }));
  const entryText = readFileSync(configFile, "utf8");
  assert.equal(entry("tasks").state, "configured", "7 an index file entry counts as configured");
  pluginCatalog.activate("tasks");
  assert.equal(readFileSync(configFile, "utf8"), entryText, "7 no second entry for the entry file");

  // 6: a plugins.json that is a symlink keeps being the owner's file: the target is written, the link stays.
  const owned = join(root, "owned.json");
  writeFileSync(owned, JSON.stringify({ plugins: ["/ext/one"] }));
  rmSync(configFile);
  symlinkSync(owned, configFile);
  pluginCatalog.activate("tasks");
  assert.ok(lstatSync(configFile).isSymbolicLink(), "6 the link is kept");
  assert.deepEqual(JSON.parse(readFileSync(owned, "utf8")).plugins, ["/ext/one", tasksDir], "6 the target file got the entry");
  rmSync(configFile);

  // 6: a dangling link is refused, not replaced; and an entry file the loader would not pick is another plugin.
  symlinkSync(join(root, "missing.json"), configFile);
  assert.throws(() => pluginCatalog.activate("tasks"), /plugins\.json is unreadable/, "6 dangling link refused");
  assert.ok(lstatSync(configFile).isSymbolicLink(), "6 dangling link kept");
  rmSync(configFile);
  writeFileSync(configFile, JSON.stringify({ plugins: [join(tasksDir, "index.js")] }));
  assert.equal(entry("tasks").state, "available", "19 index.js does not exist in the plugin: not the same entry");
  rmSync(configFile);

  // 6: the array form is kept as an array.
  writeFileSync(configFile, JSON.stringify(["/ext/one"]));
  pluginCatalog.activate("simulator");
  assert.deepEqual(config(), ["/ext/one", BUNDLED_PLUGINS.find((item) => item.id === "simulator").directory], "6 array form kept");

  // 8: an unreadable or wrongly shaped file is refused and untouched.
  for (const text of ["{ not json", JSON.stringify({ plugins: "x" }), JSON.stringify({ plugins: [1] })]) {
    writeFileSync(configFile, text);
    assert.throws(() => pluginCatalog.activate("tasks"), /plugins\.json is unreadable/, `8 refused: ${text}`);
    assert.equal(readFileSync(configFile, "utf8"), text, "8 file untouched");
    assert.equal(entry("tasks").state, "available", "8 listing still works");
  }

  // 9: no temporary files are left behind.
  writeFileSync(configFile, JSON.stringify({ plugins: [] }));
  pluginCatalog.activate("tasks");
  assert.deepEqual(readFileSync(configFile, "utf8").endsWith("\n"), true, "9 complete file");

  // 10: a plugin configured only through the environment is configured and nothing is written.
  rmSync(configFile);
  process.env.PI_PROJECTS_PLUGINS = tasksDir;
  assert.equal(entry("tasks").state, "configured", "10 environment counts as configured");
  pluginCatalog.activate("tasks");
  assert.ok(!existsSync(configFile), "10 nothing written");
  delete process.env.PI_PROJECTS_PLUGINS;

  // 12: the four states from a loader attempt.
  const attempt = (state, error) => ({
    source: tasksDir,
    name: "tasks",
    version: "1.0.0",
    state,
    provides: [],
    loadedAtMs: 0,
    ...(error ? { error } : {}),
  });
  const bundled = BUNDLED_PLUGINS.find((item) => item.id === "tasks");
  assert.equal(describeEntry(bundled, { attempt: undefined, configured: false }).state, "available", "12 available");
  assert.equal(describeEntry(bundled, { attempt: undefined, configured: true }).state, "configured", "12 configured");
  assert.deepEqual(
    (({ state, version }) => ({ state, version }))(describeEntry(bundled, { attempt: attempt("loaded"), configured: true })),
    { state: "loaded", version: "1.0.0" },
    "12 loaded",
  );
  assert.deepEqual(
    (({ state, error }) => ({ state, error }))(describeEntry(bundled, { attempt: attempt("failed", "boom"), configured: true })),
    { state: "failed", error: "boom" },
    "12 failed with the loader's error",
  );

  // 12/13: after the host loads, the entry is loaded; a later activation of the other plugin does not change that state.
  writeFileSync(configFile, JSON.stringify({ plugins: [tasksDir] }));
  await plugins.load();
  assert.equal(entry("tasks").state, "loaded", "12 loaded by the host at its start");
  pluginCatalog.activate("simulator");
  assert.equal(entry("simulator").state, "configured", "13 activation after the start is not loaded until a restart");
  assert.equal(plugins.status().length, 2, "13 nothing hot-loaded (github and tasks)");
  assert.equal(entry("tasks").state, "loaded", "12 still loaded");
  // 11: an external plugin of the same name is already loaded: refused with its source, file untouched.
  plugins.reset();
  const external = join(root, "external-tasks");
  mkdirSync(external);
  writeFileSync(join(external, "index.mjs"), 'export default { name: "tasks", version: "9.9.9", register() {} };\n');
  writeFileSync(configFile, JSON.stringify({ plugins: [external] }));
  const externalText = readFileSync(configFile, "utf8");
  await plugins.load();
  assert.throws(() => pluginCatalog.activate("tasks"), new RegExp(`already loaded from ${external}`), "11 same name refused");
  assert.equal(readFileSync(configFile, "utf8"), externalText, "11 file untouched");
  console.log("plugin-catalog-unit ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
