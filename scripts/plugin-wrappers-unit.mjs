// Unit: gated capability wrappers keep their own identity when one provider object serves two capabilities (scripts/plugin-enable-failures.md).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
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

// W2 the status path (plugins.forProject) and findVcsRoot never ask a plugin the project turned off whether a folder is its checkout.
{
  const { findVcsRoot } = await import("../src/vcs.ts");
  const cwd = join(process.env.PI_PROJECTS_HOME, "checkout");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const project = (extra) => ({ id: "p1", cwd, ...extra });
  globalThis.sharedCalls.length = 0;
  plugins.forProject(project({ disabledPlugins: ["shared"] }));
  assert.equal(findVcsRoot(cwd, off)?.kind, "git", "W2 a git checkout is still found with the plugin off");
  assert.deepEqual(globalThis.sharedCalls, [], "W2 no isRoot for a project with the plugin off");
  plugins.forProject(project({}));
  assert.ok(globalThis.sharedCalls.includes("isRoot"), "W2 positive control: another project asks the plugin");
  assert.equal(
    globalThis.sharedCalls.filter((name) => name === "isRoot").length,
    1,
    "W3 one status read looks at the checkout once, not once per plugin",
  );
  const lock = plugins.forProject(project({})).find((item) => item.name === "shared")?.lock;
  assert.equal(lock, null, "W2 a git checkout does not lock the plugin on");
}
console.log("plugin-wrappers-unit: ok");
