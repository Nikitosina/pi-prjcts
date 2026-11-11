// Unit: `projects plugin new|check` and the guide's example plugin (scripts/plugin-dev-failures.md 1-13). Temp directories only: no host, no model, no live home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const core = new URL("..", import.meta.url).pathname;
const fixtures = join(core, "scripts", "fixtures");
const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-dev-")));
// A stand-in for the owner's live home: its plugins.json and env list name broken plugins that must never load.
const liveHome = join(root, "live-home");
mkdirSync(liveHome);
writeFileSync(join(liveHome, "plugins.json"), JSON.stringify({ plugins: [join(fixtures, "bad-provider.mjs")] }));
const env = { ...process.env, PI_PROJECTS_HOME: liveHome, PI_PROJECTS_PLUGINS: join(fixtures, "throws-in-register.mjs") };
const projects = (...args) => {
  const run = spawnSync(process.execPath, [join(core, "src", "cli.ts"), ...args], { cwd: root, env, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {}
  return { code: run.status, json, stdout: run.stdout, stderr: run.stderr };
};

try {
  // 2: a name the loader refuses is refused before anything is written.
  const badName = projects("plugin", "new", join(root, "bad"), "--name", "Bad_Name");
  assert.equal(badName.code, 1, `2 bad name refused: ${badName.stdout}${badName.stderr}`);
  assert.match(badName.stderr, /name/, "2 the refusal names the name rule");
  assert.ok(!existsSync(join(root, "bad")), "2 nothing written for a bad name");

  // 1: a directory with files is refused and left as it was.
  const busy = join(root, "busy");
  mkdirSync(busy);
  writeFileSync(join(busy, "index.mjs"), "// the author's work\n");
  const overwrite = projects("plugin", "new", busy, "--name", "busy");
  assert.equal(overwrite.code, 1, "1 a non-empty directory is refused");
  assert.deepEqual(readdirSync(busy), ["index.mjs"], "1 nothing added");
  assert.equal(readFileSync(join(busy, "index.mjs"), "utf8"), "// the author's work\n", "1 the author's file is untouched");

  // 3/4: the scaffold, outside the core repository, passes its own test with plain node --test.
  const hello = join(root, "elsewhere", "hello");
  const created = projects("plugin", "new", hello, "--name", "hello");
  assert.equal(created.code, 0, `3 scaffold created: ${created.stderr}`);
  assert.deepEqual(created.json?.files?.slice().sort(), ["README.md", "index.mjs", "index.test.mjs"], "3 scaffold files");
  const source = readFileSync(join(hello, "index.mjs"), "utf8");
  assert.ok(!source.includes(core), "4 the scaffold does not point into the core checkout");
  assert.match(source, /name: "hello"/, "3 the scaffold carries its name");
  assert.match(readFileSync(join(hello, "README.md"), "utf8"), /docs\/plugins\/README\.md/, "13 the scaffold's README points at the guide");
  const ownTest = spawnSync(process.execPath, ["--test"], { cwd: hello, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(ownTest.status, 0, `3/4 the scaffold's own test passes: ${ownTest.stdout}${ownTest.stderr}`);

  // 5/6/3/9: check loads only the given directory, in a removed temporary home; the live home is untouched.
  const checked = projects("plugin", "check", hello);
  assert.equal(checked.code, 0, `3 check passes: ${checked.stdout}${checked.stderr}`);
  assert.equal(checked.json?.ok, true, "3 check ok");
  assert.deepEqual(
    checked.json.plugins.map((item) => [item.name, item.state, item.version]),
    [["hello", "loaded", "0.1.0"]],
    "6 only the given plugin loaded, with its version",
  );
  assert.deepEqual(checked.json.plugins[0].provides.sort(), ["rpc", "rpcPolicy"], "3 the scaffold provides a classified RPC");
  assert.ok(checked.json.home && checked.json.home !== liveHome && !checked.json.home.startsWith(liveHome), "5 a separate home");
  assert.ok(!existsSync(checked.json.home), "5 the temporary home is removed");
  assert.deepEqual(readdirSync(liveHome), ["plugins.json"], "5 nothing written to the live home");

  // 7/8: a broken plugin fails the check with the host loader's own reason.
  const broken = projects("plugin", "check", join(fixtures, "bad-provider.mjs"));
  assert.equal(broken.code, 1, "7 a broken plugin fails the check");
  assert.equal(broken.json?.ok, false, "7 check not ok");
  assert.equal(broken.json.plugins[0].state, "failed", "7 recorded as failed");
  assert.match(broken.json.plugins[0].error, /prs\.parseRefs must be a function/, "8 the host loader's message");

  // 9: a plugin without a version still loads.
  const unversioned = projects("plugin", "check", join(fixtures, "second-plugin"));
  assert.equal(unversioned.code, 0, `9 unversioned plugin loads: ${unversioned.stdout}`);
  assert.equal(unversioned.json.plugins[0].version, null, "9 version is null");

  // 10: a version that is not a short string fails with a reason.
  for (const [label, value] of [
    ["empty", '""'],
    ["number", "1"],
    ["long", JSON.stringify("1".repeat(41))],
  ]) {
    const file = join(root, `version-${label}.mjs`);
    writeFileSync(file, `export default { name: "v-${label}", version: ${value}, register() {} };\n`);
    const result = projects("plugin", "check", file);
    assert.equal(result.code, 1, `10 ${label} version refused`);
    assert.match(result.json.plugins[0].error, /version/, `10 ${label} version reason`);
  }

  // 11: a close hook that never settles and holds no handle still lets the check print its result and remove its home.
  const hangs = join(root, "hangs-on-close.mjs");
  writeFileSync(
    hangs,
    `export default { name: "hangs", register(api) { api.provide({ lifecycle: { close: () => new Promise(() => {}) } }); } };\n`,
  );
  const hung = projects("plugin", "check", hangs);
  assert.equal(hung.code, 0, `11 check finishes: ${hung.code} ${hung.stdout}${hung.stderr}`);
  assert.equal(hung.json?.plugins?.[0]?.state, "loaded", "11 the result is printed");
  assert.ok(!existsSync(hung.json.home), "11 the temporary home is removed");

  // 12: the guide's example passes its own test (its tools run with the host's libraries) and the host loader.
  const example = join(core, "docs", "plugins", "examples", "notes");
  const exampleTest = spawnSync(process.execPath, ["--test"], {
    cwd: example,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root },
  });
  assert.equal(exampleTest.status, 0, `12 the example's own test passes: ${exampleTest.stdout}${exampleTest.stderr}`);
  const exampleCheck = projects("plugin", "check", example);
  assert.equal(exampleCheck.code, 0, `12 the example loads: ${exampleCheck.stdout}${exampleCheck.stderr}`);
  assert.deepEqual(
    exampleCheck.json.plugins[0].provides.sort(),
    ["coordinatorTools", "rpc", "rpcPolicy", "web", "workerTools"],
    "12 the example provides what the guide describes",
  );
  assert.equal(exampleCheck.json.plugins[0].version, "1.0.0", "12 the example's version");

  // Missing arguments print the usage.
  assert.equal(projects("plugin", "check").code, 1, "usage without a directory");
  console.log("plugin-dev-unit: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
