// Unit: gated capability wrappers keep their own identity when one provider object serves two capabilities (scripts/plugin-enable-failures.md).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_PROJECTS_HOME = mkdtempSync(join(tmpdir(), "plugin-wrappers-unit-"));
process.env.PI_PROJECTS_PLUGINS = new URL("./fixtures/shared-provider", import.meta.url).pathname;
const { loadPlugins, plugins } = await import("../src/plugins.ts");
const [loaded] = (await loadPlugins()).filter((item) => item.name === "shared");
assert.equal(loaded?.state, "loaded", loaded?.error);

const off = { disabledPlugins: ["shared"] };
const follow = plugins.followProviders().find((item) => item.id === "shared");
const pr = plugins.prProvider("shared");
assert.ok(follow && pr);
assert.notEqual(follow, pr, "W1 the follow and PR wrappers are separate objects");
assert.equal(follow.repository(off), undefined, "W1 follow refuses a project with the plugin off");
assert.equal(pr.applies(off), false, "W1 the PR provider refuses a project with the plugin off");
assert.deepEqual(globalThis.sharedCalls, [], "W1 nothing reached the plugin for the disabled project");
assert.equal(follow.repository({}), "owner/repo", "W1 positive control: a project with the plugin on reaches it");
assert.equal(pr.applies({}), true);
assert.deepEqual(globalThis.sharedCalls, ["repository", "applies"]);
console.log("plugin-wrappers-unit: ok");
