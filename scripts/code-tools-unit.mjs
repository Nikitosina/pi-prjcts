// Read-only code tools without a host: reads under /tmp and the path guard, code_diff path narrowing (git and a plugin kind) and
// mode "stat" (scripts/code-tools-failures.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "code-tools-")));
process.env.PI_PROJECTS_HOME = join(base, "home");
// Two plugin checkout kinds: "narrowing" declares codeDiffPath, "legacy" predates it. Each serves the diff stored in its root.
const plugin = (kind, narrows) => `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const slow = async (root) => { if (existsSync(join(root, ".${kind}", "slow"))) await new Promise((done) => setTimeout(done, 400)); };
export default { name: "${kind}", register(api) { api.provide({ vcs: {
  kind: "${kind}", isRoot: (dir) => existsSync(join(dir, ".${kind}")), ${narrows ? "codeDiffPath: true," : ""}
  changedFiles: async (cwd) => { await slow(cwd.split("/proj")[0]); return []; },
  codeDiff: async (root, _base, helpers) => { await slow(root); appendFileSync(join(root, ".${kind}", "paths.log"), JSON.stringify(helpers.path ?? null) + "\\n"); return JSON.parse(readFileSync(join(root, ".${kind}", "diff.json"), "utf8")); },
  workerState: async (root) => { await slow(root); return { branch: "b", head: "1".repeat(40), status: "" }; },
  resolveContinuation: async () => { throw new Error("none"); },
} }); } };
`;
mkdirSync(join(base, "plugins"));
for (const [kind, narrows] of [
  ["narrowing", true],
  ["legacy", false],
])
  writeFileSync(join(base, "plugins", `${kind}.mjs`), plugin(kind, narrows));
process.env.PI_PROJECTS_PLUGINS = ["narrowing", "legacy"].map((kind) => join(base, "plugins", `${kind}.mjs`)).join(":");
const { loadPlugins, plugins } = await import("../src/plugins.ts");
const { saveProject, loadProject, projectDir } = await import("../src/state.ts");
const { readOnlyCodeTools } = await import("../src/durable-code-tools.ts");
const { RESPONSE_LIMIT } = await import("../src/response-limit.ts");
const loaded = await loadPlugins();
assert.ok(
  loaded.every((item) => item.state === "loaded"),
  JSON.stringify(loaded),
);
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
const api = { callId: "call-1", output() {} };
const context = { abortSignal: undefined };
const runIn = async (list, name, args) => {
  const result = await list.find((item) => item.name === name).execute(args, api, context);
  return result.output.map((block) => block.text ?? "").join("");
};
const run = (name, args) => runIn(tools, name, args);
const bytes = (text) => Buffer.byteLength(text);
const refused = async (name, args, what) => assert.rejects(() => run(name, args), /outside this thread's code root/, `${what} is refused`);

try {
  const evidence = join(base, "cache");
  mkdirSync(evidence);
  writeFileSync(join(evidence, "proof"), "job evidence");
  const reader = readOnlyCodeTools(project, undefined, undefined, async () => [evidence]).tools;
  assert.match(await runIn(reader, "code_read", { path: join(evidence, "proof") }), /job evidence/);
  await assert.rejects(() => runIn(reader, "code_read", { path: join(outside, "secret.txt") }), /outside this thread/);
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

  // A git repository whose project directory is the subfolder app/; the branch changes files in and out of it.
  const repo = join(base, "repo"),
    app = join(repo, "app");
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
  mkdirSync(join(app, "deep"), { recursive: true });
  mkdirSync(join(repo, "other"));
  writeFileSync(join(app, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(app, "c.txt"), "c\n");
  writeFileSync(join(app, "h.txt"), "-- gone\nkeep\n");
  writeFileSync(join(repo, "other", "x.txt"), "x\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  writeFileSync(join(app, "a.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(app, "deep", "b.txt"), "b1\nb2\n");
  // Content lines that look like headers: "++ added" shows as "+++ added", "-- gone" as "--- gone".
  writeFileSync(join(app, "h.txt"), "keep\n++ added\ndiff --git a/fake b/fake\n");
  writeFileSync(join(app, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
  writeFileSync(join(repo, "other", "x.txt"), "x\ny\n");
  git("add", ".");
  git("commit", "-qm", "feature");
  writeFileSync(join(app, "c.txt"), "c\nuncommitted\n");
  writeFileSync(join(app, "new.txt"), "n1\nn2\nn3\n");
  const appTools = readOnlyCodeTools(app).tools;
  const diff = (args) => runIn(appTools, "code_diff", { base: "main", ...args });

  // F6 path is relative to the project directory, like code_read; F10 untracked files outside it are not listed.
  const one = await diff({ path: "a.txt" });
  assert.ok(one.includes(git("rev-parse", "main").trim()), "base commit is visible");
  assert.match(one, /\+TWO/, "F6 the project-relative path narrows to app/a.txt");
  assert.doesNotMatch(one, /\+b1|\+uncommitted|\+n1|other\/x/, "F6/F10 only that file");
  const sub = await diff({ path: "deep" });
  assert.match(sub, /\+b1/, "F6 a project-relative directory narrows");
  // F9 escapes are refused before any command runs.
  for (const path of ["../other/x.txt", "/etc", "-p", "~/x", "a\u0001b"])
    await assert.rejects(() => diff({ path }), /Invalid path/, `F9 ${JSON.stringify(path)} is refused`);

  // F11/F13/F14 file counts: committed, uncommitted and untracked together, project-relative paths, header-like content counted once.
  const stat = await diff({ mode: "stat" });
  const row = (path) => stat.split("\n").find((line) => line.endsWith(` ${path}`)) ?? "";
  assert.match(row("a.txt"), /^\+2 -1 /, `F11 a.txt counts: ${stat}`);
  assert.match(row("deep/b.txt"), /^\+2 -0 /, "F11/F13 a committed new file, project-relative");
  assert.match(row("c.txt"), /^\+1 -0 /, "F11 an uncommitted change");
  assert.match(row("new.txt"), /^\+3 -0 /, "F11 an untracked file counts as additions");
  assert.match(row("h.txt"), /^\+2 -1 /, "F14 header-like content lines are counted, not read as headers");
  assert.match(row("img.bin"), /^binary /, "F11 a binary file is marked");
  assert.match(row("../other/x.txt"), /^\+1 -0 /, "F13 a file outside the project directory keeps a relative path");
  assert.equal(stat.split("\n").filter((line) => line.endsWith(" h.txt")).length, 1, "F14 one row per file");
  assert.ok(!/fake/.test(stat), "F14 a diff header inside content does not start a file");
  // F16 stat with path.
  const deepStat = await diff({ mode: "stat", path: "deep" });
  assert.match(deepStat, /deep\/b\.txt/, "F16 the file under the path is listed");
  assert.doesNotMatch(deepStat, /a\.txt|new\.txt/, "F16 only files under the path");

  // F12 a list past 8 KiB pages by file: each page fits, every file appears exactly once.
  const many = join(app, "many");
  mkdirSync(many);
  for (let i = 0; i < 400; i++) writeFileSync(join(many, `file-with-a-rather-long-name-${String(i).padStart(3, "0")}.txt`), `${i}\n`);
  git("add", "app/many");
  git("commit", "-qm", "many");
  const seen = [];
  for (let offset = 0, pages = 0; ; pages++) {
    assert.ok(pages < 50, "F12 paging ends");
    const page = await diff({ mode: "stat", offset });
    assert.ok(bytes(page) <= RESPONSE_LIMIT, `F12 a stat page is at most 8 KiB (${bytes(page)})`);
    seen.push(...page.split("\n").flatMap((line) => /(many\/file-[^ ]+)$/.exec(line)?.[1] ?? []));
    const next = /continue with offset=(\d+)/.exec(page)?.[1];
    if (!next) {
      assert.match(page, /end of list/, "F12 the last page says so");
      break;
    }
    assert.match(page, /mode="stat"/, "F12/F17 the note keeps the stat mode");
    offset = Number(next);
  }
  assert.equal(seen.length, 400, "F12 every file is listed");
  assert.equal(new Set(seen).size, 400, "F12 no file is listed twice");

  // F17 a git diff page advises path and the stat mode; the changed-file list advises the stat mode.
  const first = await diff({});
  assert.ok(bytes(first) <= RESPONSE_LIMIT, "a diff page is at most 8 KiB");
  assert.match(first, /continue with offset=\d+, pass path for one file, or mode="stat"/, `F17 git note: ${first.slice(-300)}`);
  assert.match(first, /more lines; mode="stat" pages the full list/, "F17 a long changed-file list points at the stat mode");

  // F7 a narrowing plugin kind gets the validated path relative to its checkout root; its project directory is a subfolder.
  const blocks = [
    "diff --git a/proj/k.swift b/proj/k.swift\n--- a/proj/k.swift\n+++ b/proj/k.swift\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n",
    "diff --git a/proj/k.swift b/proj/k.swift\n--- a/proj/k.swift\n+++ b/proj/k.swift\n@@ -2,0 +3,1 @@\n+uncommitted\n",
    "diff --git a/proj/u.swift b/proj/u.swift\nnew file\n--- /dev/null\n+++ b/proj/u.swift\n+u1\n+u2\n",
  ].join("");
  const diffJson = (untracked) =>
    JSON.stringify({ mergeBase: "2".repeat(40), changed: " proj/k.swift | 3 ++-\n", diff: blocks, untracked });
  const kinds = {};
  for (const kind of ["narrowing", "legacy"]) {
    const root = join(base, kind);
    mkdirSync(join(root, `.${kind}`), { recursive: true });
    mkdirSync(join(root, "proj"));
    writeFileSync(join(root, `.${kind}`, "diff.json"), diffJson(["proj/u.swift", "elsewhere/z.swift"]));
    kinds[kind] = { root, tools: readOnlyCodeTools(join(root, "proj")).tools };
  }
  const paths = (kind) =>
    readFileSync(join(kinds[kind].root, `.${kind}`, "paths.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const narrowed = await runIn(kinds.narrowing.tools, "code_diff", { path: "k.swift" });
  assert.deepEqual(paths("narrowing").at(-1), "proj/k.swift", "F7 the plugin gets the path relative to its checkout root");
  assert.doesNotMatch(narrowed, /elsewhere\/z\.swift/, "F10 untracked files outside the path are dropped");
  // F14/F15 two blocks of one file merge; an untracked block without a hunk header counts.
  const kindStat = await runIn(kinds.narrowing.tools, "code_diff", { mode: "stat" });
  assert.match(kindStat, /^\+2 -1 k\.swift$/m, `F14 one row for a file in two blocks: ${kindStat}`);
  assert.match(kindStat, /^\+2 -0 u\.swift$/m, "F15 an untracked block without a hunk header counts");
  assert.equal(paths("narrowing").at(-1), null, "no path when none was asked");

  // F20 a project that turned the checkout kind's plugin off is not served through it: the plugin's diff never runs for that project.
  const stored = (cwd, disabledPlugins) => {
    const id = `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`;
    mkdirSync(projectDir(id), { recursive: true });
    saveProject({
      version: 1,
      id,
      name: "p",
      cwd,
      objective: "",
      runtime: "durable",
      createdAt: new Date().toISOString(),
      model: "fake/fake",
      models: {},
      phase: "ready",
      problem: null,
      ...(disabledPlugins ? { disabledPlugins } : {}),
    });
    return id;
  };
  {
    const logged = () =>
      readFileSync(join(kinds.narrowing.root, ".narrowing", "paths.log"), "utf8")
        .trim()
        .split("\n").length;
    const before = logged();
    const cwd = join(kinds.narrowing.root, "proj");
    const offId = stored(cwd, ["narrowing"]),
      onId = stored(cwd);
    const off = readOnlyCodeTools(cwd, undefined, () => loadProject(offId)).tools;
    await assert.rejects(
      () => runIn(off, "code_diff", {}),
      /not a git checkout/,
      "F20 a disabled kind's checkout has no diff for the project",
    );
    assert.equal(logged(), before, "F20 the disabled plugin's codeDiff did not run");
    const on = readOnlyCodeTools(cwd, undefined, () => loadProject(onId)).tools;
    assert.match(await runIn(on, "code_diff", {}), /narrowing/, "F20 positive control: the same project with the plugin on");

    // F21 the plugin's diff, worker state, head and status reads count as the plugin's work in the project while they run, so a disable
    // is refused meanwhile; a project that turned it off is refused before the plugin runs.
    const { workerChanges } = await import("../src/code-diff.ts");
    const { readHead, changedFiles, confirmCheckout } = await import("../src/vcs.ts");
    writeFileSync(join(kinds.narrowing.root, ".narrowing", "slow"), "");
    const project = loadProject(onId);
    const inFlight = async (what, start) => {
      const running = start();
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(plugins.gate.active(onId, "narrowing"), 1, `F21 ${what} counts as the plugin's work while it runs`);
      assert.match(
        plugins.disableBlock(loadProject(onId), "narrowing") ?? "",
        /./,
        `F21 ${what}: the plugin cannot be turned off meanwhile`,
      );
      await running;
      assert.equal(plugins.gate.active(onId, "narrowing"), 0, `F21 ${what} leaves nothing counted`);
    };
    await inFlight("code_diff", () => runIn(on, "code_diff", {}));
    await inFlight("worker changes (workerState)", () => workerChanges(cwd, undefined, { project }));
    await inFlight("head read (workerState)", () => readHead(cwd, project));
    await inFlight("status read", () => changedFiles(cwd, project));
    await inFlight("checkout confirmation", () => confirmCheckout(cwd, project));
    const calls = () =>
      readFileSync(join(kinds.narrowing.root, ".narrowing", "paths.log"), "utf8")
        .trim()
        .split("\n").length;
    const stopped = calls();
    await assert.rejects(
      () => workerChanges(cwd, undefined, { project: loadProject(offId) }),
      /not a git checkout/,
      "F21 off: refused before the plugin",
    );
    saveProject({ ...loadProject(onId), disabledPlugins: ["narrowing"] });
    const racing = await readHead(cwd, project);
    assert.equal(
      racing.kind,
      "unreadable",
      "F21 a read that starts after the flag was stored (stale project object) is refused at the gate",
    );
    assert.equal(calls(), stopped, "F21 and the plugin did not run");
    saveProject({ ...loadProject(onId), disabledPlugins: undefined });
    rmSync(join(kinds.narrowing.root, ".narrowing", "slow"));
  }

  // F8 a plugin without codeDiffPath: path is refused before its diff runs and no note advises it.
  await assert.rejects(
    () => runIn(kinds.legacy.tools, "code_diff", { path: "k.swift" }),
    /cannot narrow.*mode="stat"/,
    "F8 a legacy plugin refuses path",
  );
  writeFileSync(
    join(kinds.legacy.root, ".legacy", "diff.json"),
    JSON.stringify({ ...JSON.parse(diffJson([])), diff: blocks + "+".repeat(20000) }),
  );
  const legacyPage = await runIn(kinds.legacy.tools, "code_diff", {});
  assert.match(legacyPage, /continue with offset=\d+, or mode="stat"/, "F17 the legacy note names offset and stat");
  assert.doesNotMatch(legacyPage, /pass path/, "F17 the legacy note does not advise path");
  // W3 (jobs-failures.md): a reviewer reads only a checkout confirmed at a readable HEAD with nothing uncommitted.
  const { confirmCheckout } = await import("../src/vcs.ts");
  const tree = join(base, "confirm");
  mkdirSync(tree);
  const inTree = (...args) =>
    execFileSync("/usr/bin/git", ["-C", tree, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.match((await confirmCheckout(join(base, "missing"))).refusal, /does not exist/, "W3 a missing directory is refused");
  inTree("init", "-q", "-b", "main");
  assert.match((await confirmCheckout(tree)).refusal, /HEAD cannot be read/, "W3 a repository with no commit is refused");
  writeFileSync(join(tree, "f.txt"), "1\n");
  inTree("add", ".");
  inTree("commit", "-qm", "one");
  assert.deepEqual(await confirmCheckout(tree), { sha: inTree("rev-parse", "HEAD").trim() }, "W3 a clean checkout gives its commit");
  writeFileSync(join(tree, "f.txt"), "2\n");
  assert.match((await confirmCheckout(tree)).refusal, /1 uncommitted/, "W3 a modified file is refused");
  inTree("checkout", "--", "f.txt");
  writeFileSync(join(tree, "new.txt"), "n\n");
  assert.match((await confirmCheckout(tree)).refusal, /uncommitted/, "W3 an untracked file is refused");
  assert.deepEqual(
    await confirmCheckout(join(kinds.narrowing.root, "proj")),
    { sha: "1".repeat(40) },
    "W3 a plugin kind is confirmed through its provider",
  );
  console.log("code-tools-unit: ok");
} finally {
  rmSync(shared, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
