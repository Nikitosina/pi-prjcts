// Unit: the per-project plugin gate (scripts/plugin-enable-failures.md 1, 3, 5). No host, no model.
import assert from "node:assert/strict";
import { createPluginGate } from "../src/plugin-gate.ts";

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
console.log("plugin-gate-unit passed");
process.exit(0);
