#!/usr/bin/env node
// Fake `arc` for offline E2Es, backed by a local git repository (the "mount" root has a `.arc/` marker, branch `trunk` is the trunk).
// State dir FAKE_ARC_DIR: state.json { login, repository, bare }, calls.jsonl (every invocation). Server refs live in the bare repo FAKE_ARC_DIR/server.git.
// Reproduces the arc behaviours the skills warn about: `users/<login>/` is added on push (a prefixed local name doubles it), `arc pr create -m` with a literal \n is rejected.
// Never reaches a real Arcadia, mount, Arcanum or network.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { prStore } from "./lib/fake-pr-state.mjs";

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
// Path arguments are relative to the cwd (a project subfolder), so path commands run there.
const here = (...a) => execFileSync("/usr/bin/git", ["-C", process.cwd(), ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const flag = (name, list = rest) => { const at = list.indexOf(name); return at < 0 ? undefined : list[at + 1]; };
const has = (name, list = rest) => list.includes(name);

if (command === "--version") out("arc fake 1.0");
if (!root) fail("not an arc repository (no .arc found)");
const s = state();
const branch = () => tryGit("branch", "--show-current") ?? "";
const server = branchName => `users/${s.login}/${branchName}`;

// Fault knobs in state.json: rootOverride, infoBroken, trunkBroken, fetchBroken, fetchDelayMs, remoteTrunk.
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
  const text = rev.startsWith("users/") ? (() => { try { return execFileSync("/usr/bin/git", ["--git-dir", join(dir, "server.git"), "log", `-n${n}`, "--format=%H %s", `refs/heads/${rev}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } })() : tryGit("log", `-n${n}`, "--format=%H %s", resolved);
  if (text === null) fail(`unknown revision ${rev}`);
  out(text);
}
const author = ["-c", `user.name=${s.login}`, "-c", `user.email=${s.login}@example.invalid`];
const bare = join(dir, "server.git");
const positional = (list = rest) => list.filter((value, at) => !value.startsWith("-") && !["-m", "-F", "-n", "--max-count", "-u"].includes(list[at - 1]));
if (command === "add") { here("add", ...(rest.length ? rest : ["-A"])); out(""); }
if (command === "commit") { const message = flag("-m") ?? fail("commit needs -m"); git(...author, "commit", "-q", ...(has("-a") ? ["-a"] : []), "-m", message); out(git("rev-parse", "HEAD")); }
if (command === "checkout" || command === "switch") {
  if (has("-b")) { git("checkout", "-q", "-b", flag("-b")); out(`switched to new branch ${flag("-b")}`); }
  if (has("--")) { here("checkout", "-q", ...rest); out("restored"); }
  const target = positional()[0] ?? fail("checkout needs a target");
  here("checkout", "-q", target.replace(/^users\/[^/]+\//, "")); out(`switched to ${target}`);
}
// `fetch trunk`: moves the local trunk to state.remoteTrunk (the "server" head) when set; fetchBroken fails.
if (command === "fetch" && positional()[0] === "trunk") {
  if (s.fetchBroken) fail("network unreachable");
  if (s.fetchDelayMs) execFileSync("/bin/sleep", [String(s.fetchDelayMs / 1000)]);
  if (s.remoteTrunk) git("update-ref", "refs/heads/trunk", s.remoteTrunk);
  out("Fetched trunk");
}
if (command === "pull" || command === "rebase" || command === "fetch") out("Already up to date.");
if (command === "branch") {
  const local = git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);
  const remote = has("--all") || has("-a") ? (tryGit("--git-dir", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/") ?? "") : "";
  out([...local, ...(remote ? remote.split("\n") : [])].join("\n"));
}
if (command === "show") out(git("show", ...rest));
if (command === "diff") out(here("diff", ...rest));
if (command === "merge-base") out(git("merge-base", ...rest));
// Server side: the remote name is users/<login>/<local>; a prefixed local name doubles it (the real double-prefix gotcha).
if (command === "push") {
  const current = branch() || fail("detached HEAD cannot be pushed"), name = positional()[0] ?? flag("-u") ?? current, remote = server(name);
  if (has("-d") || has("--delete")) { execFileSync("/usr/bin/git", ["--git-dir", bare, "update-ref", "-d", `refs/heads/${remote}`]); out(`deleted ${remote}`); }
  execFileSync("/usr/bin/git", ["-C", root, "push", ...(has("-f") || has("--force") ? ["--force"] : []), bare, `${current}:refs/heads/${remote}`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const prs = prStore(dir), store = prs.load(); prs.pushed(store, remote, git("rev-parse", "HEAD")); prs.save(store);
  out(`pushed ${current} -> ${remote}`);
}
if (command === "pr") {
  const [sub, ...more] = rest, prs = prStore(dir), store = prs.load();
  const target = list => positional(list)[0];
  const byIdOrBranch = list => { const ref = target(list); return ref && /^\d+$/.test(ref) ? store.prs.find(item => item.id === Number(ref)) : store.prs.find(item => item.from_branch === (ref ?? server(branch()))); };
  if (sub === "create") {
    if (s.prCreateBroken) fail("arcanum is unreachable");
    const message = flag("-m", more), file = flag("-F", more);
    if ((message === undefined) === (file === undefined)) fail("pass exactly one of -m and -F");
    const text = message ?? readFileSync(file, "utf8");
    if (message !== undefined && /\\n/.test(message)) fail("the message contains a literal \\n; use real line breaks or -F");
    const publish = more.some(value => value === "--publish" || (value.startsWith("--publish=") && value !== "--publish=disabled"));
    const remote = server(branch()), head = git("rev-parse", "HEAD");
    execFileSync("/usr/bin/git", ["-C", root, "push", "--force", bare, `${branch()}:refs/heads/${remote}`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (store.prs.some(item => item.from_branch === remote && item.status !== "merged")) fail(`a pull request for ${remote} already exists`);
    const [summary, ...body] = text.split("\n"), id = store.nextPr++;
    const base = git("merge-base", "trunk", "HEAD");
    store.prs.push({ id, summary, description: body.join("\n").replace(/^\n+/, "").trimEnd(), status: publish ? "open" : "draft", published: publish, author: { name: s.login, uid: s.login }, from_branch: remote, tickets: [], auto_merge: "disabled", checks: {}, comments: [], approvedHead: null, diffSets: [{ id: store.nextDiff++, head, base, merge: head, published: publish }] });
    prs.save(store);
    out(has("--json") ? JSON.stringify({ id, url: `https://a.example.invalid/review/${id}` }) : `Pull request ${id} created`);
  }
  const pr = byIdOrBranch(more) ?? fail("pull request not found");
  if (sub === "status") out(JSON.stringify(prs.view(pr)));
  if (sub === "merge") {
    if (has("--auto", more) || has("-A", more)) { pr.auto_merge = "on_satisfied_requirements"; prs.save(store); out("automerge enabled"); }
    if (has("--no-auto", more)) { pr.auto_merge = "disabled"; prs.save(store); out("automerge disabled"); }
    if (!has("--now", more)) fail("pass --now, --auto or --no-auto");
    if (!prs.mergeAllowed(pr)) fail("merge requirements are not satisfied");
    pr.status = "merged"; pr.merge_commit = prs.active(pr).head; prs.save(store); out(has("--json", more) ? JSON.stringify({ id: pr.id, status: "merged" }) : "merged");
  }
  if (sub === "discard") { pr.status = "discarded"; prs.save(store); out("discarded"); }
  fail(`unsupported fake pr command ${sub}`, 2);
}
fail(`unsupported fake command: ${args.join(" ")}`, 2);
