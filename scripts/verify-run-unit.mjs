// projects_verify_run without a host: HEAD through the checkout kind's provider and refusals that name the next step (scripts/verify-run-failures.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "verify-run-")));
process.env.PI_PROJECTS_HOME = join(base, "home");
// A plugin checkout kind whose HEAD is the content of .kindh/head; without that file its provider throws like a failing `arc info`.
const pluginFile = join(base, "kindh.mjs");
writeFileSync(
  pluginFile,
  `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export default { name: "kindh", register(api) { api.provide({ vcs: {
  kind: "kindh", isRoot: (dir) => existsSync(join(dir, ".kindh")),
  changedFiles: async () => [],
  codeDiff: async () => ({ mergeBase: "", changed: "", diff: "", untracked: [] }),
  workerState: async (root) => {
    const at = join(root, ".kindh", "head");
    if (!existsSync(at)) throw new Error("kindh info failed: mount is gone");
    return { branch: "b", head: readFileSync(at, "utf8").trim(), status: "" };
  },
  resolveContinuation: async () => { throw new Error("none"); },
} }); } };
`,
);
process.env.PI_PROJECTS_PLUGINS = pluginFile;
const { loadPlugins } = await import("../src/plugins.ts");
const { proofTools } = await import("../src/proof.ts");
const { ResourceLeases } = await import("../src/resource-leases.ts");
assert.ok((await loadPlugins()).every((item) => item.state === "loaded"));

const repo = join(base, "repo");
mkdirSync(repo);
const git = (...args) =>
  execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", ".");
git("commit", "-qm", "one");
const first = git("rev-parse", "HEAD");
writeFileSync(join(repo, "a.txt"), "b\n");
git("commit", "-qam", "two");
const second = git("rev-parse", "HEAD");
const arcLike = join(base, "arclike", "project");
mkdirSync(join(base, "arclike", ".kindh"), { recursive: true });
mkdirSync(arcLike);
const plain = join(base, "plain");
mkdirSync(plain);

const { tools } = proofTools({
  projectId: "p",
  controlRoot: join(base, "control"),
  background: {},
  leases: new ResourceLeases(),
  // Reaching the shell policy means every HEAD check passed.
  shell: () => ({ refusal: "SHELL-REACHED" }),
});
const tool = tools.find((item) => item.name === "projects_verify_run");
const run = async ({ cwd, candidate, helper = false }) => {
  const job = { id: "job-1", workerConversation: 7, candidate, ...(helper ? { workspace: { kind: "shared" } } : {}) };
  const api = {
    conversationId: 7,
    snapshot: async () => ({ subagents: {}, jobs: { [job.id]: job } }),
    agent: async () => ({ cwd }),
  };
  const result = await tool.execute({ command: "true" }, api, { abortSignal: undefined });
  return result.output.map((block) => block.text).join("");
};

try {
  // F1/F6 the candidate passes on git and on a plugin kind whose HEAD comes from its provider.
  assert.equal(await run({ cwd: repo, candidate: second }), "SHELL-REACHED", "F6 git on the candidate runs");
  writeFileSync(join(base, "arclike", ".kindh", "head"), "c".repeat(40));
  assert.equal(await run({ cwd: arcLike, candidate: "c".repeat(40) }), "SHELL-REACHED", "F1 a plugin kind reads HEAD through its provider");

  // F2 an unreadable HEAD is not a mismatch.
  rmSync(join(base, "arclike", ".kindh", "head"));
  const providerFailed = await run({ cwd: arcLike, candidate: "c".repeat(40) });
  assert.match(providerFailed, /cannot read HEAD: .*kindh info failed: mount is gone/, `F2 provider error: ${providerFailed}`);
  assert.doesNotMatch(providerFailed, /unknown commit|check out|record/, "F2 no candidate advice for an unreadable HEAD");
  const notCheckout = await run({ cwd: plain, candidate: second });
  assert.match(notCheckout, /cannot read HEAD: /, `F2 not a checkout: ${notCheckout}`);
  assert.doesNotMatch(notCheckout, /unknown commit/, "F2 no unknown commit");

  // F3/F4 no candidate: independent workers push and record branch and PR; helpers record a local commit only.
  const independent = await run({ cwd: repo, candidate: null });
  assert.match(independent, /commit/i, "F3 commit");
  assert.match(independent, /push/, "F3 push");
  assert.match(independent, /job \{action:"candidate", sha, branch, pr\}/, `F3 the candidate call: ${independent}`);
  assert.match(independent, /retry/, "F3 retry");
  const helper = await run({ cwd: repo, candidate: null, helper: true });
  assert.match(helper, /job \{action:"candidate", sha\}/, `F4 the local candidate call: ${helper}`);
  assert.match(helper, /no push/, "F4 helpers do not push");
  assert.doesNotMatch(helper, /branch, pr/, "F4 no branch or PR for helpers");

  // F5 a mismatch names the current HEAD in full and both ways out, per worker kind.
  const moved = await run({ cwd: repo, candidate: first });
  assert.match(moved, new RegExp(`job \\{action:"candidate", sha:"${second}", branch, pr\\}`), `F5 independent: ${moved}`);
  assert.match(moved, /push/, "F5 independent pushes first");
  assert.match(moved, new RegExp(`check out the candidate ${first}`), "F5 or check out the candidate");
  const movedHelper = await run({ cwd: repo, candidate: first, helper: true });
  assert.match(movedHelper, new RegExp(`job \\{action:"candidate", sha:"${second}"\\}`), `F5 helper: ${movedHelper}`);
  assert.doesNotMatch(movedHelper, /push/, "F5 helpers do not push");
  console.log("verify-run-unit: ok");
} finally {
  rmSync(base, { recursive: true, force: true });
}
