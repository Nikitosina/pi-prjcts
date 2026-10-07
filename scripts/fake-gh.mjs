#!/usr/bin/env node
// Fake GitHub CLI for offline E2E suites: serves `gh api --hostname github.com --method M path [--input -]`
// from FAKE_GH_STATE (JSON) and the local bare remote FAKE_GH_BARE, logging every call to FAKE_GH_CALLS. Never reaches the network.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [, , command, , hostname, , method, target] = process.argv;
const statePath = process.env.FAKE_GH_STATE, bare = process.env.FAKE_GH_BARE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const input = process.argv.includes("--input") ? readFileSync(0, "utf8") : "";
const log = entry => appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify({ method, target, ...entry }) + "\n");
const fail = (status, message) => { log({ status }); process.stderr.write("gh: " + message + " (HTTP " + status + ")\n"); process.exit(1); };
const out = value => { log({ status: 200 }); process.stdout.write(JSON.stringify(value)); process.exit(0); };
const g = (...args) => execFileSync("/usr/bin/git", ["--git-dir", bare, ...args], { encoding: "utf8" }).trim();
const head = branch => { try { return g("rev-parse", "--verify", "refs/heads/" + branch); } catch { return null; } };
if (command !== "api" || hostname !== "github.com") fail(400, "unsupported invocation");
const url = new URL(target, "https://api.github.invalid/"), parts = url.pathname.slice(1).split("/");
const repo = state.repo, repoRef = { id: repo.id, full_name: repo.full_name };
if (parts[0] !== "repos" || parts[1] + "/" + parts[2] !== repo.full_name) fail(404, "Not Found");
const rest = parts.slice(3);
const pr = item => ({ number: item.number, html_url: "https://github.invalid/" + repo.full_name + "/pull/" + item.number, title: item.title, body: item.body, draft: item.draft, state: "open", head: { ref: item.head, sha: head(item.head), repo: repoRef }, base: { ref: item.base, sha: head(item.base), repo: repoRef } });
if (method === "GET" && rest.length === 0) out({ ...repoRef, default_branch: repo.default_branch });
if (method === "GET" && rest[0] === "git" && rest[1] === "matching-refs" && rest[2] === "heads") { const branch = rest.slice(3).join("/"), sha = head(branch); out(sha ? [{ ref: "refs/heads/" + branch, object: { sha } }] : []); }
if (method === "GET" && rest[0] === "git" && rest[1] === "ref" && rest[2] === "heads") { const sha = head(rest.slice(3).join("/")); if (!sha) fail(404, "Not Found"); out({ object: { sha } }); }
if (method === "GET" && rest[0] === "git" && rest[1] === "commits") { const sha = rest[2]; out({ sha, tree: { sha: g("rev-parse", sha + "^{tree}") }, message: g("log", "-1", "--format=%B", sha) }); }
if (method === "GET" && rest[0] === "git" && rest[1] === "trees") { const sha = rest[2]; const tree = g("ls-tree", sha).split("\n").filter(Boolean).map(line => { const [meta, path] = line.split("\t"); const [mode, type, entry] = meta.split(" "); return { path, mode, type, sha: entry }; }); out({ sha, truncated: false, tree }); }
if (method === "GET" && rest[0] === "git" && rest[1] === "blobs") { const bytes = execFileSync("/usr/bin/git", ["--git-dir", bare, "cat-file", "blob", rest[2]]); out({ sha: rest[2], size: bytes.length, encoding: "base64", content: bytes.toString("base64") }); }
if (method === "GET" && rest[0] === "pulls" && rest.length === 1) { const wanted = url.searchParams.get("head"); out(state.pulls.filter(item => !wanted || repo.full_name.split("/")[0] + ":" + item.head === wanted).map(pr)); }
if (method === "GET" && rest[0] === "pulls" && rest.length === 2) { const item = state.pulls.find(value => value.number === Number(rest[1])); if (!item) fail(404, "Not Found"); out(pr(item)); }
if (method === "POST" && rest[0] === "pulls" && rest.length === 1) {
  const body = JSON.parse(input);
  if (!head(body.head) || !head(body.base)) fail(422, "Validation Failed");
  if (state.pulls.some(item => item.head === body.head)) fail(422, "A pull request already exists");
  const item = { number: state.pulls.length + 1, title: body.title, body: body.body, head: body.head, base: body.base, draft: body.draft === true };
  state.pulls.push(item); writeFileSync(statePath, JSON.stringify(state)); out(pr(item));
}
if (method === "PATCH" && rest[0] === "pulls" && rest.length === 2) {
  const item = state.pulls.find(value => value.number === Number(rest[1])); if (!item) fail(404, "Not Found");
  const body = JSON.parse(input); if (typeof body.title === "string") item.title = body.title; if (typeof body.body === "string") item.body = body.body;
  writeFileSync(statePath, JSON.stringify(state)); out(pr(item));
}
fail(501, "fake gh does not implement " + method + " " + target);
