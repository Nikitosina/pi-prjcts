// Unit: the pause a plugin disable holds survives lifecycle transitions and a restart, also for a plugin whose hook is one boolean/Set
// (scripts/plugin-enable-failures.md 43). No host, no model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "plugin-pause-unit-"));
process.env.PI_PROJECTS_HOME = home;
process.env.PI_PROJECTS_PLUGINS = new URL("./fixtures/simple-pause", import.meta.url).pathname;
const { loadPlugins, plugins } = await import("../src/plugins.ts");
const { saveProject, loadProject, projectDir } = await import("../src/state.ts");
const { mkdirSync } = await import("node:fs");

assert.equal((await loadPlugins()).find((item) => item.name === "simple")?.state, "loaded");
const paused = globalThis.simplePaused;
const make = () => {
  const project = {
    version: 1,
    id: randomUUID(),
    name: "p",
    cwd: home,
    objective: "",
    runtime: "durable",
    createdAt: new Date().toISOString(),
    model: "fake/fake",
    models: {},
    phase: "ready",
    problem: null,
  };
  mkdirSync(projectDir(project.id), { recursive: true });
  saveProject(project);
  return project;
};
const alpha = make(),
  beta = make();

// U1 a write with an unknown outcome kept outside the store refuses the disable (it fails closed), leaves the plugin on with no pause
// held, and does not stop a lifecycle transition (restore, recovery); resolving it lets the disable through.
{
  const root = {};
  const disable = () => plugins.disable(() => loadProject(beta.id), "simple", root, saveProject);
  globalThis.simpleUnresolved.set(beta.id, "boot outcome is unknown");
  await assert.rejects(disable, /unknown outcome/, "U1 an unresolved write refuses the disable");
  assert.ok(!paused.has(beta.id), "U1 the refusal holds no pause");
  assert.equal(loadProject(beta.id).disabledPlugins, undefined, "U1 the plugin stays on");
  plugins.pauseLifecycle(beta.id)();
  globalThis.simpleUnresolved.set(beta.id, new Error("unreadable"));
  await assert.rejects(disable, /could not be checked/, "U1 a check that throws refuses too");
  globalThis.simpleUnresolved.set(beta.id, "");
  await assert.rejects(disable, /could not be checked/, "U1 an answer that is neither a reason nor null refuses");
  globalThis.simpleUnresolved.delete(beta.id);
  assert.deepEqual((await disable()).disabledPlugins, ["simple"], "U1 resolved: the disable goes through");
  assert.ok(paused.has(beta.id));
  plugins.setEnabled(loadProject(beta.id), "simple", true, saveProject);
  assert.ok(!paused.has(beta.id));
}

const off = plugins.setEnabled(alpha, "simple", false, saveProject);
assert.ok(paused.has(alpha.id), "P1 the disable holds the plugin's pause");
plugins.pauseLifecycle(alpha.id)();
assert.ok(paused.has(alpha.id), "P1 a lifecycle transition on the project keeps the held pause");
plugins.pauseLifecycle(beta.id)();
assert.ok(paused.has(alpha.id), "P1 a transition on another project keeps it too");
assert.ok(!paused.has(beta.id), "P1 the other project is not paused after its transition");
const again = plugins.pauseLifecycle(alpha.id);
again();
again();
assert.ok(paused.has(alpha.id), "P1 a resume called twice keeps it");

// A restart forgets every pause; the host takes them again for projects that have the plugin off, and a transition after that keeps them.
plugins.reset();
paused.clear();
await loadPlugins();
assert.ok(paused.has(alpha.id), "P2 after a restart the disabled project's pause is held again");
plugins.pauseLifecycle(alpha.id)();
assert.ok(paused.has(alpha.id), "P2 a transition after the restart keeps it");

plugins.setEnabled(loadProject(alpha.id), "simple", true, saveProject);
assert.ok(!paused.has(alpha.id), "P3 the enable releases the pause");
plugins.pauseLifecycle(alpha.id)();
assert.ok(!paused.has(alpha.id), "P3 and later transitions leave it released");
assert.deepEqual(off.disabledPlugins, ["simple"]);
console.log("plugin-pause-unit: ok");
