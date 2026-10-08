#!/usr/bin/env node
// Fake `arc` for offline E2Es, backed by a local git repository (the "mount" root has a `.arc/` marker, branch `trunk` is the trunk).
// State dir FAKE_ARC_DIR: state.json { login, repository, bare }, calls.jsonl (every invocation). Server refs live in the bare repo FAKE_ARC_DIR/server.git.
// Reproduces the arc behaviours the skills warn about: `users/<login>/` is added on push (a prefixed local name doubles it), `arc pr create -m` with a literal \n is rejected.
// Never reaches a real Arcadia, mount, Arcanum or network.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const dir = process.env.FAKE_ARC_DIR, args = process.argv.slice(2);
const statePath = join(dir, "state.json"), state = () => JSON.parse(readFileSync(statePath, "utf8")), save = value => writeFileSync(statePath, JSON.stringify(value, null, 2));
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ tool: "arc", argv: args, cwd: process.cwd(), at: Date.now() }) + "\n");
const fail = (message, code = 1) => { process.stderr.write(`arc: ${message}\n`); process.exit(code); };
const out = text => { process.stdout.write(text.endsWith("\n") || !text ? text : text + "\n"); process.exit(0); };
const rootOf = from => { for (let at = resolve(from); ; at = dirname(at)) { if (existsSync(join(at, ".arc"))) return at; if (dirname(at) === at) return null; } };
const root = rootOf(process.cwd());
const git = (...a) => execFileSync("/usr/bin/git", ["-C", root, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const [command, ...rest] = args;
const flag = (name, list = rest) => { const at = list.indexOf(name); return at < 0 ? undefined : list[at + 1]; };
const has = (name, list = rest) => list.includes(name);

if (command === "--version") out("arc fake 1.0");
if (!root) fail("not an arc repository (no .arc found)");
const s = state();
const branch = () => tryGit("branch", "--show-current") ?? "";
const server = branchName => `users/${s.login}/${branchName}`;

// Fault knobs in state.json: rootOverride, infoBroken, trunkBroken.
if (command === "root") out(s.rootOverride ?? root);
if (command === "info") {
  if (s.infoBroken) fail("info unavailable");
  const info = { repository: s.repository, branch: branch(), hash: git("rev-parse", "HEAD"), user_login: s.login };
  out(has("--json") ? JSON.stringify(info) : `branch: ${info.branch}\nhash: ${info.hash}`);
}
if (command === "status") {
  const text = git("status", "--porcelain=v1", "--untracked-files=all");
  out(has("--short") ? text : text || "nothing to commit");
}
if (command === "log") {
  const n = flag("-n") ?? flag("--max-count") ?? fail("unbounded arc log is refused (pass -n)");
  const revs = rest.filter((value, at) => !value.startsWith("-") && rest[at - 1] !== "-n" && rest[at - 1] !== "--max-count");
  const rev = revs[0] ?? "HEAD", resolved = rev === "trunk" ? "trunk" : rev.startsWith("users/") ? `refs/server/${rev}` : rev;
  if (s.trunkBroken && rev === "trunk") fail("trunk is unreachable");
  const text = tryGit("log", `-n${n}`, "--format=%H %s", resolved);
  if (text === null) fail(`unknown revision ${rev}`);
  out(text);
}
fail(`unsupported fake command: ${args.join(" ")}`, 2);
