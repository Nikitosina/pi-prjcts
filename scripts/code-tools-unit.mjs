// Read-only code tools without a host: reads under /tmp and the path guard (scripts/code-tools-failures.md 1-5).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyCodeTools } from "../src/durable-code-tools.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "code-tools-")));
// The shared /tmp is what the owner decision is about, so this one folder lives there; it is removed at the end.
const shared = mkdtempSync("/tmp/code-tools-unit-");
const project = join(base, "project"),
  outside = join(base, "outside");
mkdirSync(project);
mkdirSync(outside);
writeFileSync(join(project, "in.txt"), "INSIDE-TOKEN\n");
writeFileSync(join(outside, "secret.txt"), "OUTSIDE-TOKEN\n");
writeFileSync(join(shared, "brief.md"), "TMP-BRIEF-TOKEN\n");
symlinkSync(join(outside, "secret.txt"), join(shared, "leak.txt"));
symlinkSync(outside, join(shared, "leakdir"));

const { tools } = readOnlyCodeTools(project);
const tool = (name) => tools.find((item) => item.name === name);
const api = { callId: "call-1", output() {} };
const context = { abortSignal: undefined };
const run = async (name, args) => {
  const result = await tool(name).execute(args, api, context);
  return result.output.map((block) => block.text ?? "").join("");
};
const refused = async (name, args, what) => assert.rejects(() => run(name, args), /outside this thread's code root/, `${what} is refused`);

try {
  // F1 /tmp and /private/tmp are readable by every reader.
  assert.match(await run("code_read", { path: "in.txt" }), /INSIDE-TOKEN/, "a project file reads");
  assert.match(await run("code_read", { path: join(shared, "brief.md") }), /TMP-BRIEF-TOKEN/, "F1 a /tmp file reads");
  assert.match(
    await run("code_read", { path: join("/private", shared, "brief.md") }),
    /TMP-BRIEF-TOKEN/,
    "F1 the same file through /private/tmp reads",
  );
  assert.match(await run("code_grep", { pattern: "TMP-BRIEF", path: shared }), /TMP-BRIEF-TOKEN/, "F1 grep under /tmp");
  assert.match(await run("code_ls", { path: shared }), /brief\.md/, "F1 ls under /tmp");

  // F2 a symlink under /tmp to somewhere else stays refused, for files and directories.
  await refused("code_read", { path: join(shared, "leak.txt") }, "F2 a /tmp symlink to an outside file");
  await refused("code_ls", { path: join(shared, "leakdir") }, "F2 a /tmp symlink to an outside directory");
  await refused("code_read", { path: join(shared, "leakdir", "secret.txt") }, "F2 a file below a /tmp symlinked directory");

  // F3 outside both roots stays refused.
  await refused("code_read", { path: join(outside, "secret.txt") }, "F3 an absolute outside path");
  await refused("code_read", { path: "../outside/secret.txt" }, "F3 a relative escape");

  // F4 the guard checks the path pi opens: a leading @ is stripped and file:// URLs are paths.
  await refused("code_read", { path: `@${join(outside, "secret.txt")}` }, "F4 an @-prefixed outside path");
  await refused("code_read", { path: `file://${join(outside, "secret.txt")}` }, "F4 a file:// URL outside");
  assert.match(await run("code_read", { path: "@in.txt" }), /INSIDE-TOKEN/, "F4 an @-prefixed project path still reads");

  // F5 still read-only.
  assert.deepEqual(
    tools.map((item) => item.name).sort(),
    ["code_diff", "code_find", "code_grep", "code_ls", "code_read"],
    "F5 no write tool",
  );
  console.log("code-tools-unit: ok");
} finally {
  rmSync(shared, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
