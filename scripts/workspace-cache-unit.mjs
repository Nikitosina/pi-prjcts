// Unit checks for src/workspace-cache.ts: layout, cache root validation, workspace matching, MCP env and the sweep. Temp folders only.
// Failure cases: scripts/workspace-cache-failures.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheRootError, mcpEnvWithCache, sweepWorkspaceCaches, workspaceCacheDir, workspaceIntentFor } from "../src/workspace-cache.ts";

const project = "11111111-2222-4333-8444-555555555555",
  intent = "aaaaaaaa-bbbb-5ccc-addd-eeeeeeeeeeee",
  other = "ffffffff-bbbb-5ccc-addd-eeeeeeeeeeee";

// Layout (C1, C13): the default root is the project folder; a set root keeps projects apart.
assert.equal(
  workspaceCacheDir({ controlRoot: "/h/p", projectId: project, intentId: intent, cacheRoot: null }),
  `/h/p/workspace-cache/${intent}`,
);
assert.equal(
  workspaceCacheDir({ controlRoot: "/h/p", projectId: project, intentId: intent, cacheRoot: "/caches" }),
  `/caches/${project}/${intent}`,
);

// Cache root setting (C12).
assert.equal(cacheRootError(null), null);
assert.equal(cacheRootError("/Users/me/Library/Developer/pi-cache"), null);
for (const bad of ["", "relative/path", "./x", "/a/../b", "/a//b", "/a/"]) assert.match(cacheRootError(bad) ?? "", /absolute/i, bad);

// Workspace matching (C3, C9, C10): a folder inside a workspace, including an Arc project subfolder, maps to it; anything else does not.
const receipts = [
  { intentId: intent, workspacePath: "/wt/durable-1" },
  { intentId: other, workspacePath: "/arc-wt/pi-chat-1" },
];
assert.equal(workspaceIntentFor(receipts, "/wt/durable-1"), intent);
assert.equal(workspaceIntentFor(receipts, "/wt/durable-1/src/app"), intent);
assert.equal(workspaceIntentFor(receipts, "/arc-wt/pi-chat-1/mobile/ios/keyboard"), other);
assert.equal(workspaceIntentFor(receipts, "/wt/durable-10"), undefined);
assert.equal(workspaceIntentFor(receipts, "/owner/checkout"), undefined);

// MCP env (C4, C5): the caller's cache fills the placeholder; without one, entries that use it are left out.
const env = { XCODEBUILDMCP_DERIVED_DATA_PATH: "${PI_WORKSPACE_CACHE}/DerivedData", KEEP: "x" };
assert.deepEqual(mcpEnvWithCache(env, "/c/1"), { XCODEBUILDMCP_DERIVED_DATA_PATH: "/c/1/DerivedData", KEEP: "x" });
assert.deepEqual(mcpEnvWithCache(env, undefined), { KEEP: "x" });

// Sweep (C6-C8): only intent-named folders under the cache roots whose workspace is not allocated.
const root = mkdtempSync(join(tmpdir(), "workspace-cache-unit-"));
try {
  const defaults = join(root, "project", "workspace-cache"),
    custom = join(root, "custom", project);
  const make = (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file"), "x");
  };
  make(join(defaults, intent)); // live
  make(join(defaults, other)); // gone
  make(join(custom, other)); // gone, under the set root
  make(join(defaults, "not-a-cache")); // not an intent id
  writeFileSync(join(defaults, "12345678-bbbb-5ccc-addd-eeeeeeeeeeee"), "a file, not a folder");
  const removed = sweepWorkspaceCaches({ roots: [defaults, custom, join(root, "missing")], live: new Set([intent]) });
  assert.deepEqual(removed.sort(), [join(custom, other), join(defaults, other)].sort());
  assert.ok(existsSync(join(defaults, intent)) && existsSync(join(defaults, "not-a-cache")));
  assert.ok(existsSync(join(defaults, "12345678-bbbb-5ccc-addd-eeeeeeeeeeee")));
  assert.ok(!existsSync(join(defaults, other)) && !existsSync(join(custom, other)));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("workspace-cache unit: all checks passed");
