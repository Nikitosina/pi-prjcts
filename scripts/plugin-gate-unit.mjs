// Unit: the per-project plugin gate (scripts/plugin-enable-failures.md 1, 3, 5). No host, no model.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginGate } from "../src/plugin-gate.ts";

process.env.PI_PROJECTS_HOME = mkdtempSync(join(tmpdir(), "plugin-gate-unit-"));
process.env.PI_PROJECTS_PLUGINS = new URL("./fixtures/fake-vcs-plugin", import.meta.url).pathname;

const off = new Set();
const gate = createPluginGate((project, plugin) => off.has(`${project}:${plugin}`));
const never = () => new Promise(() => {});

// 5: a tool call on a disabled plugin fails when it executes; the count returns to zero.
const [tool] = gate.tools("p1", "x", [{ name: "t", execute: async (id, params) => `ran:${params.v}` }]);
assert.equal(await tool.execute("c1", { v: 1 }), "ran:1");
off.add("p1:x");
await assert.rejects(() => tool.execute("c2", { v: 2 }), /disabled in this project/);
assert.equal(gate.active("p1", "x"), 0, "5 a refused call leaves no count");
off.delete("p1:x");

// 1/3: work in flight is counted until it settles, also when it throws; other projects and plugins are separate.
let release;
const running = gate.run("p1", "x", () => new Promise((resolve) => (release = resolve)));
assert.equal(gate.active("p1", "x"), 1, "1 running work is counted");
assert.equal(gate.active("p2", "x"), 0, "9 other project");
assert.equal(gate.active("p1", "y"), 0, "9 other plugin");
release("done");
assert.equal(await running, "done");
assert.equal(gate.active("p1", "x"), 0);
await assert.rejects(() => gate.run("p1", "x", async () => Promise.reject(new Error("boom"))), /boom/);
assert.equal(gate.active("p1", "x"), 0, "1 a throwing call is released");

// 3: the check and the flag are one step: a call that starts after the flag is refused, one that started before is counted.
const before = gate.run("p1", "x", never);
assert.equal(gate.active("p1", "x"), 1);
off.add("p1:x");
await assert.rejects(() => gate.run("p1", "x", async () => "late"), /disabled in this project/);
assert.equal(gate.active("p1", "x"), 1, "3 only the earlier call is counted");
void before;
// 13: a provider's listed methods run through the gate; the others stay the provider's own.
{
  const merges = [];
  const provider = { kind: "k", note: "keep", merge: async (input) => (merges.push(input), "merged"), pull: async () => "pulled" };
  const wrapped = gate.methods("p9", "m", provider, ["merge", "pull"]);
  assert.equal(wrapped.kind, "k");
  assert.equal(wrapped.note, "keep");
  const held = never();
  let release;
  const slow = gate.methods("p9", "m", { merge: () => new Promise((resolve) => (release = resolve)) }, ["merge"]);
  const inflight = slow.merge();
  assert.equal(gate.active("p9", "m"), 1);
  release("done");
  assert.equal(await inflight, "done");
  assert.equal(gate.active("p9", "m"), 0);
  assert.equal(await wrapped.merge({ head: "h" }), "merged");
  off.add("p9:m");
  await assert.rejects(() => wrapped.merge({ head: "h2" }), /disabled in this project/);
  await assert.rejects(() => wrapped.pull(), /disabled in this project/);
  assert.equal(merges.length, 1);
  void held;
}

// 20: a result delivered after a disable is dropped: a follow observation that began before the flag must not reach its callback.
{
  const slow = (release) => new Promise((resolve) => (release.fn = resolve));
  const release = {};
  const pending = gate.settled("p7", "z", () => slow(release));
  off.add("p7:z");
  release.fn({ items: ["late"] });
  await assert.rejects(() => pending, /disabled in this project/);
  assert.equal(gate.active("p7", "z"), 0, "20 the count returns to zero");
  off.delete("p7:z");
  assert.deepEqual(await gate.settled("p7", "z", async () => ({ items: [] })), { items: [] }, "20 an enabled plugin's result passes");
}

// 25: the host's gate refuses when the project's stored state cannot be read: an unknown project is not one that has the plugin on.
{
  const { plugins } = await import("../src/plugins.ts");
  let ran = false;
  await assert.rejects(
    () =>
      plugins.gate.run("00000000-0000-4000-8000-000000000000", "simulator", async () => {
        ran = true;
      }),
    /disabled in this project|unavailable/,
  );
  assert.equal(ran, false, "25 the work did not run");
  assert.equal(plugins.gate.isOff("00000000-0000-4000-8000-000000000000", "simulator"), true, "25 unreadable state counts as off");
}

// 28/29: a project that turned a VCS plugin off gets none of its worker rules, and the plugin's grant rebind does not run for it.
{
  const { plugins } = await import("../src/plugins.ts");
  await plugins.load();
  const on = { id: "p", disabledPlugins: [] },
    off = { id: "p", disabledPlugins: ["fake"] };
  assert.ok(
    plugins.workerRules(on).some((rule) => /Fake VCS rule/.test(rule)),
    "28 the enabled project gets the rule",
  );
  assert.deepEqual(plugins.workerRules(off), [], "28 the disabled project gets none");
  const fake = plugins.workspaceProviders().find((item) => item.id === "fake");
  assert.equal(fake?.rebind?.(off), off, "29 rebind leaves a project that turned the plugin off untouched");
}

console.log("plugin-gate-unit passed");
process.exit(0);
