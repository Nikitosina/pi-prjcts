#!/usr/bin/env node
// Fake GitHub CLI for offline E2E suites: serves `gh api --hostname github.com --method M path [--input -]`
// from FAKE_GH_STATE (JSON) and the local bare remote FAKE_GH_BARE, logging every call to FAKE_GH_CALLS. Never reaches the network.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
// Fault injection: any target containing one of state.failPaths answers 502.
if ((state.failPaths ?? []).some(part => target.includes(part))) fail(502, "Bad Gateway");
const url = new URL(target, "https://api.github.invalid/"), parts = url.pathname.slice(1).split("/");
const repo = state.repo, repoRef = { id: repo.id, full_name: repo.full_name };
// Issues (coordinator GitHub tools): state.issues = [{ number, title, body, state, state_reason, labels, assignees, comments: [{ body }] }].
const issues = state.issues ??= [];
const issueView = item => ({ number: item.number, title: item.title, body: item.body ?? null, state: item.state, state_reason: item.state_reason ?? null, html_url: "https://github.invalid/" + repo.full_name + "/issues/" + item.number, user: { login: "owner" }, labels: item.labels.map(name => ({ name })), assignees: item.assignees.map(login => ({ login })), milestone: null, comments: item.comments.length, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" });
const saveState = () => writeFileSync(statePath, JSON.stringify(state));
if (method === "GET" && parts[0] === "search" && parts[1] === "issues") {
  const q = url.searchParams.get("q") ?? "";
  if (!q.includes("repo:" + repo.full_name)) fail(422, "Validation Failed");
  const words = q.split(/\s+/).filter(word => word && !word.includes(":"));
  const wantState = /is:(open|closed)/.exec(q)?.[1];
  const found = issues.filter(item => (!wantState || item.state === wantState) && words.every(word => (item.title + " " + (item.body ?? "")).toLowerCase().includes(word.toLowerCase())));
  out({ total_count: found.length, items: found.map(issueView) });
}
const login = name => ({ login: name ?? "owner", type: /\[bot\]$/.test(name ?? "") ? "Bot" : "User" });
const pr = item => ({ number: item.number, node_id: "PR_" + item.number, merge_commit_sha: item.mergeCommit ?? null, html_url: "https://github.invalid/" + repo.full_name + "/pull/" + item.number, title: item.title, body: item.body, draft: item.draft, state: item.state ?? "open", merged_at: item.merged ? "2026-10-03T00:00:00Z" : null, user: login(item.user), updated_at: new Date(Date.parse("2026-10-01T00:00:00Z") + parseInt(createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 8), 16) % 2592000000).toISOString(), head: { ref: item.head, sha: item.sha ?? head(item.head), repo: repoRef }, base: { ref: item.base, sha: head(item.base), repo: repoRef } });
// GraphQL: PR watching reads (list / detail / status; read-only) and the auto-merge ready-for-review mutation.
// PR fields: item.user, item.mergeable ("MERGEABLE"|"CONFLICTING"|"UNKNOWN"), item.mergeState, item.reviewDecision, item.autoMerge, item.threads [{ resolved, path, line, user, body }], item.files [paths];
// checks come from state.checks[sha] (check runs) and state.statuses[sha] (commit statuses). Fault injection: state.graphql = { rateLimit: "primary"|"secondary", unauth, nullRepo, badJson, errors, failNumbers }.
if (method === "POST" && parts[0] === "graphql") {
  const body = JSON.parse(input), query = body.query ?? "", vars = body.variables ?? {}, fault = state.graphql ?? {};
  const kind = /markPullRequestReadyForReview/.test(query) ? "mutation" : /pullRequests\(states:OPEN/.test(query) ? "list" : /reviewThreads/.test(query) ? "detail" : "status";
  if (kind !== "mutation") {
    log({ status: 200, graphql: kind, number: vars.number, files: /files\(first/.test(query) }); 
    const stop = (text, errors) => { process.stderr.write("gh: " + text + "\n"); process.stdout.write(JSON.stringify({ errors })); process.exit(1); };
    if (fault.rateLimit === "primary") stop("API rate limit exceeded for user ID 1. (HTTP 403)", [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]);
    if (fault.rateLimit === "secondary") { process.stderr.write("gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\n"); process.exit(1); }
    if (fault.unauth) { process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\n"); process.exit(4); }
    if (fault.badJson) { process.stdout.write("<html>oops"); process.exit(0); }
    if (fault.errors) stop("GraphQL: Something went wrong while executing your query", [{ message: "Something went wrong while executing your query" }]);
    if (fault.nullRepo || vars.owner + "/" + vars.name !== repo.full_name) { process.stdout.write(JSON.stringify({ data: { viewer: { login: state.viewer ?? "owner" }, repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] })); process.exit(1); }
    const runsOf = sha => (state.checks ?? {})[sha] ?? [], statusesOf = sha => (state.statuses ?? {})[sha] ?? [];
    const contexts = (item, rich) => { const sha = item.sha ?? head(item.head); return [
      ...runsOf(sha).map(run => ({ __typename: "CheckRun", name: run.name, status: (run.status ?? "completed").toUpperCase(), conclusion: run.conclusion ? run.conclusion.toUpperCase() : null, ...(rich ? { detailsUrl: run.details_url ?? null, title: run.output?.title ?? null, summary: run.output?.summary ?? null } : {}) })),
      ...statusesOf(sha).map(entry => ({ __typename: "StatusContext", context: entry.context, state: entry.state.toUpperCase(), ...(rich ? { targetUrl: entry.target_url ?? null, description: entry.description ?? null } : {}) })),
    ]; };
    const node = (item, rich) => ({
      number: item.number, title: item.title, url: "https://github.com/" + repo.full_name + "/pull/" + item.number, state: item.merged ? "MERGED" : (item.state ?? "open") === "closed" ? "CLOSED" : "OPEN", merged: item.merged === true, isDraft: item.draft === true,
      headRefName: item.head, headRefOid: item.sha ?? head(item.head), mergeable: item.mergeable ?? "MERGEABLE", mergeStateStatus: item.mergeState ?? "CLEAN", reviewDecision: item.reviewDecision ?? null, updatedAt: pr(item).updated_at,
      author: { login: item.user ?? "owner" }, autoMergeRequest: item.autoMerge ? { enabledAt: "2026-10-03T00:00:00Z" } : null, latestOpinionatedReviews: { nodes: (item.opinions ?? []).map(value => ({ state: value })) },
      reviewThreads: { nodes: (item.threads ?? []).map(thread => ({ isResolved: thread.resolved === true, isOutdated: false, path: thread.path ?? "a.txt", line: thread.line ?? 1, comments: { nodes: [{ author: { login: thread.user ?? "rev" }, body: thread.body ?? "" }] } })) },
      commits: { nodes: [{ commit: { oid: item.sha ?? head(item.head), statusCheckRollup: contexts(item, rich).length ? { contexts: { nodes: contexts(item, rich) } } : null } }] },
      files: { nodes: (item.files ?? []).map(path => ({ path })) },
    });
    const reply = data => { process.stdout.write(JSON.stringify({ data })); process.exit(0); };
    if (kind === "list") reply({ viewer: { login: state.viewer ?? "owner" }, repository: { pullRequests: { nodes: state.pulls.filter(item => (item.state ?? "open") === "open" && !item.merged).toReversed().slice(0, 50).map(item => node(item, false)) } } });
    const item = state.pulls.find(value => value.number === vars.number);
    if ((state.graphql?.failNumbers ?? []).includes(vars.number)) stop("GraphQL: boom", [{ message: "boom" }]);
    reply({ repository: { pullRequest: item ? node(item, kind === "detail") : null } });
  }
  const number = Number(/^PR_(\d+)$/.exec(vars.id ?? "")?.[1]), item = state.pulls.find(value => value.number === number);
  if (!item) fail(422, "Could not resolve to a node");
  item.draft = false; saveState(); log({ status: 200, body: input }); process.stdout.write(JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })); process.exit(0);
}
if (parts[0] !== "repos" || parts[1] + "/" + parts[2] !== repo.full_name) fail(404, "Not Found");
const rest = parts.slice(3);
// Follow PRs fields: item.state ("open"|"closed"), item.merged, item.sha (head override), item.user, item.reviews / comments / lineComments; updated_at changes whenever the item does, as on GitHub.
const feedback = (list, extra = () => ({})) => (list ?? []).map(entry => ({ id: entry.id, user: login(entry.user), body: entry.body ?? "", created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...extra(entry) }));
if (method === "GET" && rest.length === 0) out({ ...repoRef, default_branch: repo.default_branch });
if (method === "GET" && rest[0] === "git" && rest[1] === "matching-refs" && rest[2] === "heads") { const branch = rest.slice(3).join("/"), sha = head(branch); out(sha ? [{ ref: "refs/heads/" + branch, object: { sha } }] : []); }
if (method === "GET" && rest[0] === "git" && rest[1] === "ref" && rest[2] === "heads") { const sha = head(rest.slice(3).join("/")); if (!sha) fail(404, "Not Found"); out({ object: { sha } }); }
if (method === "GET" && rest[0] === "git" && rest[1] === "commits") { const sha = rest[2]; out({ sha, tree: { sha: g("rev-parse", sha + "^{tree}") }, message: g("log", "-1", "--format=%B", sha) }); }
if (method === "GET" && rest[0] === "git" && rest[1] === "trees") { const sha = rest[2]; const tree = g("ls-tree", sha).split("\n").filter(Boolean).map(line => { const [meta, path] = line.split("\t"); const [mode, type, entry] = meta.split(" "); return { path, mode, type, sha: entry }; }); out({ sha, truncated: false, tree }); }
if (method === "GET" && rest[0] === "git" && rest[1] === "blobs") { const bytes = execFileSync("/usr/bin/git", ["--git-dir", bare, "cat-file", "blob", rest[2]]); out({ sha: rest[2], size: bytes.length, encoding: "base64", content: bytes.toString("base64") }); }
if (method === "GET" && rest[0] === "pulls" && rest.length === 1) { const wanted = url.searchParams.get("head"), which = url.searchParams.get("state") ?? "open"; out(state.pulls.filter(item => (!wanted || repo.full_name.split("/")[0] + ":" + item.head === wanted) && (which === "all" || (item.state ?? "open") === which)).toReversed().map(pr)); }
if (method === "GET" && rest[0] === "commits" && rest[2] === "check-runs") { const runs = (state.checks ?? {})[rest[1]] ?? []; out({ total_count: runs.length, check_runs: runs.map((run, index) => ({ id: run.id ?? index + 1, name: run.name, head_sha: rest[1], status: run.status ?? "completed", conclusion: run.conclusion ?? null, details_url: run.details_url ?? null, output: run.output ?? { title: null, summary: null } })) }); }
if (method === "GET" && rest[0] === "pulls" && rest.length === 3 && (rest[2] === "reviews" || rest[2] === "comments")) { const item = state.pulls.find(value => value.number === Number(rest[1])); if (!item) fail(404, "Not Found"); out(rest[2] === "reviews" ? feedback(item.reviews, entry => ({ state: entry.state ?? "COMMENTED", submitted_at: "2026-10-02T00:00:00Z" })) : feedback(item.lineComments, entry => ({ path: entry.path ?? "README.md", line: 1, commit_id: item.sha ?? head(item.head) }))); }
if (method === "GET" && rest[0] === "issues" && rest[2] === "comments" && !issues.some(value => value.number === Number(rest[1]))) { const item = state.pulls.find(value => value.number === Number(rest[1])); if (!item) fail(404, "Not Found"); out(feedback(item.comments)); }
// Auto-merge reads/writes: state.protection[branch] = { contexts, checks }, state.statuses[sha] = [{ context, state }], state.racePush[number] = sha (a push landing just before the merge call).
if (method === "GET" && rest[0] === "branches" && rest.at(-2) === "protection" && rest.at(-1) === "required_status_checks") { const rule = (state.protection ?? {})[decodeURIComponent(rest.slice(1, -2).join("/"))]; if (!rule) fail(404, "Branch not protected"); out({ strict: false, contexts: rule.contexts ?? [], checks: (rule.checks ?? []).map(context => ({ context, app_id: null })) }); }
if (method === "GET" && rest[0] === "commits" && rest[2] === "status") out({ sha: rest[1], state: "success", statuses: (state.statuses ?? {})[rest[1]] ?? [] });
if (method === "GET" && rest[0] === "commits" && rest.length === 2) { const message = (state.mergeCommits ?? {})[rest[1]]; if (message === undefined) fail(404, "No commit found"); out({ sha: rest[1], commit: { message } }); }
if (method === "GET" && rest[0] === "pulls" && rest[2] === "files") { const item = state.pulls.find(value => value.number === Number(rest[1])); if (!item) fail(404, "Not Found"); let files = []; try { const range = head(item.base) + "..." + (item.sha ?? head(item.head)); files = g("diff", "--name-status", range).split("\n").filter(Boolean).map(line => { const [code, filename] = line.split("\t"); return { filename, status: { A: "added", D: "removed" }[code] ?? "modified", additions: 1, deletions: 0, patch: g("diff", range, "--", filename).split("\n").slice(4).join("\n") }; }); } catch {} out(files); }
if (method === "PUT" && rest[0] === "pulls" && rest[2] === "merge") {
  const item = state.pulls.find(value => value.number === Number(rest[1])), body = JSON.parse(input); if (!item) fail(404, "Not Found");
  log({ status: "attempt", body: input });
  const race = (state.racePush ?? {})[item.number]; if (race) { item.sha = race; delete state.racePush[item.number]; saveState(); }
  if ((item.state ?? "open") !== "open" || item.merged) fail(405, "Pull Request is not mergeable");
  if (item.draft) fail(405, "Pull Request is still a draft");
  if (body.sha && body.sha !== (item.sha ?? head(item.head))) fail(409, "Head branch was modified. Review and try the merge again.");
  const sha = createHash("sha1").update("merge:" + item.number + ":" + body.sha).digest("hex");
  Object.assign(item, { state: "closed", merged: true, mergeCommit: sha, mergeMethod: body.merge_method }); (state.mergeCommits ??= {})[sha] = body.commit_title + "\n\n" + body.commit_message; saveState();
  out({ sha, merged: true, message: "Pull Request successfully merged" });
}
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
if (rest[0] === "issues") {
  const item = rest.length >= 2 ? issues.find(value => value.number === Number(rest[1])) : null;
  if (rest.length >= 2 && !item) fail(404, "Not Found");
  const body = input ? JSON.parse(input) : {};
  if (method === "GET" && rest.length === 1) { const wanted = url.searchParams.get("state") ?? "open"; out(issues.filter(value => wanted === "all" || value.state === wanted).map(issueView)); }
  if (method === "GET" && rest.length === 2) out(issueView(item));
  if (method === "GET" && rest[2] === "comments") out(item.comments.map((comment, index) => ({ id: index + 1, body: comment.body, user: { login: "owner" }, created_at: "2026-10-02T00:00:00Z", html_url: issueView(item).html_url + "#issuecomment-" + (index + 1) })));
  if (method === "POST" && rest.length === 1) {
    if (!body.title) fail(422, "Validation Failed");
    const created = { number: issues.length + 100, title: body.title, body: body.body ?? null, state: "open", labels: body.labels ?? [], assignees: body.assignees ?? [], comments: [] };
    issues.push(created); saveState(); out(issueView(created));
  }
  if (method === "POST" && rest[2] === "comments") { item.comments.push({ body: body.body }); saveState(); out({ id: item.comments.length, body: body.body, html_url: issueView(item).html_url + "#issuecomment-" + item.comments.length }); }
  if (method === "PATCH" && rest.length === 2) {
    for (const key of ["title", "body", "labels", "assignees", "state", "state_reason"]) if (key in body) item[key] = body[key];
    if (body.state === "open") item.state_reason = null;
    saveState(); out(issueView(item));
  }
}
fail(501, "fake gh does not implement " + method + " " + target);
