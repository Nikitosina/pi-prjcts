// Offline test of projects_gh: a stub `gh` on PATH echoes its argv, cwd and env; nothing reaches GitHub.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinatorGhTools, ghEnabled, runGh } from "../src/coordinator-gh.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-e2e-")));
const bin = join(root, "bin"), cwd = join(root, "checkout"), dir = join(root, "state");
for (const path of [bin, cwd, dir]) mkdirSync(path);
const stub = join(bin, "gh");
writeFileSync(stub, `#!/usr/bin/env node
const [, , ...args] = process.argv;
if (args[0] === "sleep") setTimeout(() => {}, 60000);
else if (args[0] === "big") process.stdout.write(Array.from({ length: 2000 }, (_, i) => "line " + i).join("\\n"));
else if (args[0] === "stdin") process.stdin.pipe(process.stdout);
else if (args[0] === "fail") { process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n"); process.exit(4); }
else process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), env: { prompt: process.env.GH_PROMPT_DISABLED, update: process.env.GH_NO_UPDATE_NOTIFIER, pager: process.env.GH_PAGER } }));
`);
chmodSync(stub, 0o755);
const originalPath = process.env.PATH;
process.env.PATH = `${bin}:${originalPath}`;

// 1. argv verbatim, cwd, non-interactive env.
const tricky = ["pr", "merge", "12 34", `a"b'c`, "x; echo pwned", "$(id)", "`id`", "*", ""];
const ok = await runGh({ args: tricky, cwd });
assert.equal(ok.exitCode, 0);
const seen = JSON.parse(ok.stdout);
assert.deepEqual(seen.args, tricky);
assert.equal(seen.cwd, cwd);
assert.deepEqual(seen.env, { prompt: "1", update: "1", pager: "cat" });

// 2. stdin only when supplied.
assert.equal((await runGh({ args: ["stdin"], cwd, input: "{\"a\":1}" })).stdout, "{\"a\":1}");

// 3. timeout.
const slow = await runGh({ args: ["sleep"], cwd, timeoutMs: 300 });
assert.equal(slow.exitCode, 124);
assert.match(slow.problem, /timed out/);

// 4. not logged in.
const out = await runGh({ args: ["fail"], cwd });
assert.equal(out.exitCode, 4);
assert.match(out.problem, /gh auth login/);

// 5. tool: output cap declared, coordinator-only, log without bodies, errors thrown clearly.
const gh = coordinatorGhTools({ cwd, dir, isCoordinator: id => id === 1 });
const [tool] = gh.tools;
assert.equal(tool.name, "projects_gh");
assert.deepEqual({ ...tool.outputLimits }, { maxBytes: 8 * 1024, maxLines: 400, retain: "tail" });
const call = (args, id = 1) => tool.execute(args, { conversationId: id, callId: "c" }, { abortSignal: new AbortController().signal });
const result = await call({ args: ["pr", "view", "x; rm -rf /"] });
assert.deepEqual(JSON.parse(result.content[0].text).args, ["pr", "view", "x; rm -rf /"]);
await assert.rejects(call({ args: ["pr", "list"] }, 2), /coordinator-only/);
await assert.rejects(call({ args: ["fail"] }), /not logged in.*gh auth login/s);
const big = await call({ args: ["big"] });
assert.ok(big.content[0].text.includes("line 1999"));
const log = readFileSync(join(dir, "gh-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
assert.equal(log.length, 3);
assert.deepEqual(log[0].args, ["pr", "view", "x; rm -rf /"]);
assert.equal(log[1].exitCode, 4);
assert.ok(log.every(entry => typeof entry.durationMs === "number" && !("stdout" in entry) && !JSON.stringify(entry).includes("line 1999")));

// 6. setting: default on, off unbinds.
assert.equal(ghEnabled({}), true);
assert.equal(ghEnabled({ githubCli: "full" }), true);
assert.equal(ghEnabled({ githubCli: "none" }), false);

// 7. gh missing.
process.env.PATH = join(root, "empty");
const missing = await runGh({ args: ["auth", "status"], cwd });
assert.equal(missing.exitCode, 127);
assert.match(missing.problem, /gh not installed/);
await assert.rejects(call({ args: ["auth", "status"] }), /gh not installed/);
process.env.PATH = originalPath;
console.log("coordinator-gh: all checks passed");
