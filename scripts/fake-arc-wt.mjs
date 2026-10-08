#!/usr/bin/env node
// Fake `arc-wt` for offline E2Es: leased worktrees of the fake Arcadia repo (see fake-arc.mjs), porcelain output in the real format.
// State FAKE_ARC_DIR/wt.json { config, entries }. A `--force` on remove is logged as `forced: true` (tests assert it never happens).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const dir = process.env.FAKE_ARC_DIR, args = process.argv.slice(2);
const wtPath = join(dir, "wt.json"), wt = () => JSON.parse(readFileSync(wtPath, "utf8")), save = value => writeFileSync(wtPath, JSON.stringify(value, null, 2));
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ tool: "arc-wt", argv: args, cwd: process.cwd(), at: Date.now(), forced: args.includes("--force") }) + "\n");
const fail = (message, code = 1) => { process.stderr.write(`arc-wt: ${message}\n`); process.exit(code); };
const out = text => { process.stdout.write(text.endsWith("\n") || !text ? text : text + "\n"); process.exit(0); };
const state = wt(), { config } = state;
const git = (cwd, ...a) => execFileSync("/usr/bin/git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const flag = (name, list) => { const at = list.indexOf(name); return at < 0 ? undefined : list[at + 1]; };
let tick = state.tick ?? 0;
const stamp = () => new Date(Date.UTC(2026, 9, 1) + (++tick) * 1000).toISOString();
const commit = () => { state.tick = tick; save(state); };
const [command, ...rest] = args;

if (command === "config") {
  out(["# Current arc-wt configuration", `# Config file: ${join(dir, "arc-wt.yaml")}`, "", ...Object.entries(config).map(([key, value]) => `${key}: ${value ?? "null"}`)].join("\n"));
}
const entryBlock = entry => {
  let head = "";
  try { head = git(entry.path, "rev-parse", "HEAD"); } catch { /* unmounted */ }
  return ["worktree " + entry.path, "name " + entry.name, "branch " + entry.branch, "name " + entry.name, "mode mount-shared", "base " + entry.base, "repo " + entry.repo, "store " + entry.store, "created " + entry.created, "pre-remove-hook none", ...(head ? ["HEAD " + head] : []), ...(entry.lease ? ["lease-owner " + entry.lease.owner, "lease-renewed " + entry.lease.renewed, "lease-reason " + entry.lease.reason] : [])].join("\n");
};
if (command === "list") {
  const name = rest.find(value => !value.startsWith("-"));
  const entries = state.entries.filter(entry => !name || entry.name === name);
  if (name && !entries.length) fail(`worktree ${name} not found`);
  const trunk = name ? [] : [["worktree " + config.trunk_path, "name trunk", "branch trunk", "HEAD " + git(config.trunk_path, "rev-parse", "trunk")].join("\n")];
  out([...trunk, ...entries.map(entryBlock)].join("\n\n"));
}
const find = name => state.entries.find(entry => entry.name === name) ?? fail(`worktree ${name} not found`);
if (command === "add") {
  const branch = rest[0], name = flag("--name", rest) ?? branch.replaceAll("/", "_"), base = flag("--base", rest) ?? "trunk", repo = flag("--repo", rest) ?? config.default_repo;
  const path = flag("--path", rest) ?? join(config.worktrees_base_path, name), objectStore = flag("--object-store-path", rest) ?? config.object_store_path;
  const owner = flag("--lease-owner", rest), reason = flag("--lease-reason", rest);
  if (!owner || !reason) fail("--lease-owner and --lease-reason are required");
  if (repo !== config.default_repo) fail(`unknown repo ${repo}`);
  if (state.entries.some(entry => entry.name === name || entry.path === path)) fail(`worktree ${name} already exists`);
  if (existsSync(path)) fail(`path ${path} already exists`);
  if (!existsSync(objectStore)) fail(`object store ${objectStore} does not exist`);
  let resolved;
  try { resolved = git(config.trunk_path, "rev-parse", "--verify", `${base}^{commit}`); } catch { fail(`cannot resolve base ${base}`); }
  mkdirSync(dirname(path), { recursive: true });
  try { git(config.trunk_path, "worktree", "add", "-b", branch, path, resolved); } catch (error) { fail(`git worktree add failed: ${String(error.stderr ?? error).trim()}`); }
  mkdirSync(join(path, ".arc"), { recursive: true });
  const store = join(config.stores_base_path, name);
  mkdirSync(join(store, ".arc"), { recursive: true });
  writeFileSync(join(store, ".arc", "config"), `Repository: "${repo}"\nObjectStorePath: "${objectStore}"\n`);
  state.entries.push({ name, path, branch, base, repo, store, created: stamp(), lease: { owner, renewed: stamp(), reason } });
  commit();
  out(`added ${name} at ${path}`);
}
if (command === "lease") {
  const [action, name, ...more] = rest, entry = find(name), owner = flag("--owner", more);
  if (action === "acquire") { if (entry.lease) fail(`worktree ${name} is leased by ${entry.lease.owner}`); entry.lease = { owner, renewed: stamp(), reason: flag("--reason", more) ?? "" }; }
  else if (!entry.lease || entry.lease.owner !== owner) fail(`worktree ${name} is not leased by ${owner}`);
  else if (action === "renew") entry.lease.renewed = stamp();
  else if (action === "handoff") { if (flag("--lease-renewed", more) !== entry.lease.renewed) fail("stale --lease-renewed"); entry.lease = { owner: flag("--to", more), renewed: stamp(), reason: entry.lease.reason }; }
  else if (action === "release") entry.lease = null;
  else fail(`unknown lease action ${action}`);
  commit();
  out(`lease ${action} ok`);
}
if (command === "remove") {
  const name = rest.find(value => !value.startsWith("-")), entry = find(name), owner = flag("--lease-owner", rest), renewed = flag("--lease-renewed", rest);
  if (rest.includes("--force")) fail("--force is not allowed in this fake");
  if (!entry.lease || entry.lease.owner !== owner) fail(`worktree ${name} is not leased by ${owner}`);
  if (renewed !== undefined && renewed !== entry.lease.renewed) fail("--lease-renewed does not match the current lease");
  if (git(entry.path, "status", "--porcelain=v1", "--untracked-files=all")) fail(`worktree ${name} has uncommitted changes`);
  rmSync(join(entry.path, ".arc"), { recursive: true, force: true });
  try { git(config.trunk_path, "worktree", "remove", entry.path); } catch (error) { fail(`git worktree remove failed: ${String(error.stderr ?? error).trim()}`); }
  rmSync(entry.store, { recursive: true, force: true });
  state.entries = state.entries.filter(item => item !== entry);
  commit();
  out(`removed ${name}`);
}
fail(`unsupported fake command: ${args.join(" ")}`, 2);
