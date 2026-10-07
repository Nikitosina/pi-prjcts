import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Type } from "typebox";
import { parse, type Project, type Request } from "./state.ts";
import { trustedOwner } from "./workspace-authorization.ts";
import { githubCli } from "./github-authorization.ts";

const run = promisify(execFile);
type Input = Extract<Request, { action: "provider-pr-inspect" | "provider-ci-inspect" | "provider-review-inspect" | "provider-ci-detail" | "provider-conflict-inspect" | "provider-ci-job-inspect" }>;
const Repository = Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), full_name: Type.String({ minLength: 1, maxLength: 256 }) });
const Ref = Type.Object({ sha: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), ref: Type.String({ minLength: 1, maxLength: 1024 }), repo: Type.Union([Repository, Type.Null()]) });
const PullRequest = Type.Object({ number: Type.Integer({ minimum: 1 }), state: Type.Union([Type.Literal("open"), Type.Literal("closed")]), draft: Type.Boolean(), html_url: Type.String({ pattern: "^https://github\\.com/", maxLength: 4096 }), head: Ref, base: Ref });

const Sha = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const Mergeability = Type.Object({ ...PullRequest.properties, mergeable: Type.Union([Type.Boolean(), Type.Null()]), mergeable_state: Type.String({ maxLength: 64 }) });
const Comparison = Type.Object({ base_commit: Type.Object({ sha: Sha }), merge_base_commit: Type.Object({ sha: Sha }), status: Type.Union([Type.Literal("ahead"), Type.Literal("behind"), Type.Literal("diverged"), Type.Literal("identical")]), ahead_by: Type.Integer({ minimum: 0 }), behind_by: Type.Integer({ minimum: 0 }), total_commits: Type.Integer({ minimum: 0 }), commits: Type.Array(Type.Object({ sha: Sha }), { maxItems: 100 }), files: Type.Optional(Type.Array(Type.Object({ filename: Type.String({ maxLength: 4096 }), status: Type.String({ maxLength: 64 }), additions: Type.Integer({ minimum: 0 }), deletions: Type.Integer({ minimum: 0 }), changes: Type.Integer({ minimum: 0 }) }), { maxItems: 300 })) });
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const CheckRun = Type.Object({ id: Type.Integer({ minimum: 1 }), name: Type.String({ maxLength: 1024 }), head_sha: Sha, status: Type.String({ maxLength: 64 }), conclusion: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]), details_url: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]) });
const Job = Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), run_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), head_sha: Sha, name: Type.String({ maxLength: 1024 }), status: Type.String({ maxLength: 64 }), conclusion: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]), steps: Type.Array(Type.Object({ number: Type.Integer({ minimum: 1 }), name: Type.String({ maxLength: 1024 }), status: Type.String({ maxLength: 64 }), conclusion: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]) }), { maxItems: 1000 }) });
const WorkflowRun = Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), head_sha: Sha, repository: Repository, pull_requests: Type.Array(Type.Object({ number: Type.Integer({ minimum: 1 }), head: Type.Object({ sha: Sha }), base: Type.Object({ repo: Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }) }) }), { maxItems: 100 }) });

function actionJob(url: string | null, repositoryId: string) {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.host !== "github.com" || parsed.username || parsed.password) return null;
    const prefix = `/${repositoryId}/actions/runs/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const match = /^(\d+)\/job\/(\d+)$/.exec(parsed.pathname.slice(prefix.length));
    if (!match) return null;
    const runId = Number(match[1]), jobId = Number(match[2]);
    return Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(jobId) && jobId > 0 ? { runId, jobId } : null;
  } catch { return null; }
}
const CheckDetail = Type.Object({ ...CheckRun.properties, output: Type.Object({ title: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]), summary: Type.Union([Type.String({ maxLength: 65536 }), Type.Null()]), text: Type.Union([Type.String({ maxLength: 65536 }), Type.Null()]), annotations_count: Count }) });
const Annotation = Type.Object({ path: Type.String({ maxLength: 4096 }), start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }), annotation_level: Type.String({ maxLength: 64 }), message: Type.String({ maxLength: 65536 }), title: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]), raw_details: Type.Union([Type.String({ maxLength: 65536 }), Type.Null()]) });
const Checks = Type.Object({ total_count: Count, check_runs: Type.Array(CheckRun, { maxItems: 100 }) });
const Status = Type.Object({ id: Type.Integer({ minimum: 1 }), context: Type.String({ maxLength: 1024 }), state: Type.String({ maxLength: 64 }) });
const Author = Type.Object({ login: Type.String({ maxLength: 256 }) });
const Review = Type.Object({ id: Type.Integer({ minimum: 1 }), user: Author, body: Type.String({ maxLength: 65536 }), state: Type.String({ maxLength: 64 }), submitted_at: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]) });
const DiscussionComment = Type.Object({ id: Type.Integer({ minimum: 1 }), user: Author, body: Type.String({ maxLength: 65536 }), created_at: Type.String({ maxLength: 64 }), updated_at: Type.String({ maxLength: 64 }) });
const LineComment = Type.Object({ ...DiscussionComment.properties, path: Type.String({ maxLength: 4096 }), commit_id: Sha, in_reply_to_id: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()])), line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) });
const Statuses = Type.Object({ sha: Sha, state: Type.String({ maxLength: 64 }), total_count: Count, statuses: Type.Array(Status, { maxItems: 100 }) });

async function get(path: string, signal: AbortSignal): Promise<unknown> {
  try {
    const result = await run(githubCli(), ["api", "--hostname", "github.com", "--method", "GET", path], { signal, timeout: 15000, maxBuffer: 1048576, encoding: "utf8" });
    const value: unknown = JSON.parse(result.stdout);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider failure";
    throw new Error(`GitHub read-only inspection failed; fingerprint ${createHash("sha256").update(message).digest("hex")}`);
  }
}

export function createGithubInspection() {
  let closed = false;
  const active = new Set<{ controller: AbortController; task: Promise<unknown> }>();
  async function inspect(project: Project, input: Input, signal?: AbortSignal) {
    if (closed) throw new Error("GitHub inspection is stopping");
    const grant = project.workspaceAuthorization;
    const repository = grant?.repositories.find(item => item.repositoryId === input.repositoryId);
    if (project.id !== input.id || input.provider !== "github" || grant?.provider !== "github" || grant.owner !== trustedOwner() || repository?.provider !== "github" || !grant.scopes.some(scope => scope.repositoryId === input.repositoryId)) throw new Error("GitHub inspection requires the exact authorized provider and repository");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repositoryId)) throw new Error("GitHub inspection requires a canonical owner/repository binding");
    const controller = new AbortController();
    const task = read(input, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
    const pending = { controller, task };
    active.add(pending);
    try { return await task; }
    finally { active.delete(pending); }
  }
  async function read(input: Input, signal: AbortSignal) {
    const path = `repos/${input.repositoryId.split("/").map(encodeURIComponent).join("/")}`;
    const repository = parse(Repository, await get(path, signal));
    if (repository.id !== input.expectedRepositoryId || repository.full_name !== input.repositoryId) throw new Error("GitHub repository identity does not match");
    const pr = parse(PullRequest, await get(`${path}/pulls/${input.pullRequest}`, signal));
    if (pr.number !== input.pullRequest || pr.base.repo?.id !== repository.id || pr.base.repo.full_name !== repository.full_name) throw new Error("GitHub PR does not belong to the authorized repository");
    if (input.expectedHead !== undefined && input.expectedHead !== pr.head.sha) throw new Error("GitHub PR head changed; inspect before authorizing an operation");
    const result = {
      provider: "github", repository: { id: repository.id, fullName: repository.full_name },
      pullRequest: { number: pr.number, state: pr.state, draft: pr.draft, url: pr.html_url,
        head: { sha: pr.head.sha, branch: pr.head.ref, repositoryId: pr.head.repo?.id ?? null },
        base: { sha: pr.base.sha, branch: pr.base.ref, repositoryId: pr.base.repo.id } },
    };
    function assertBinding(current: typeof pr) {
      if (current.number !== pr.number || current.head.sha !== pr.head.sha || current.head.ref !== pr.head.ref || current.head.repo?.id !== pr.head.repo?.id || current.base.sha !== pr.base.sha || current.base.ref !== pr.base.ref || current.base.repo?.id !== repository.id || current.base.repo.full_name !== repository.full_name) throw new Error("PR binding changed during inspection; reread before continuing");
    }
    async function assertCurrentBinding() {
      assertBinding(parse(PullRequest, await get(`${path}/pulls/${pr.number}`, signal)));
    }
    if (input.action === "provider-pr-inspect") return result;
    if (input.action === "provider-ci-job-inspect") {
      const job = parse(Job, await get(`${path}/actions/jobs/${input.jobId}`, signal));
      if (job.id !== input.jobId) throw new Error("Actions job identity does not match");
      const workflow = parse(WorkflowRun, await get(`${path}/actions/runs/${job.run_id}`, signal));
      if (workflow.id !== job.run_id || workflow.repository.id !== repository.id || workflow.repository.full_name !== repository.full_name || job.head_sha !== workflow.head_sha) throw new Error("Actions job/run repository or tested commit does not match");
      const direct = workflow.head_sha === pr.head.sha;
      const associated = workflow.pull_requests.some(item => item.number === pr.number && item.head.sha === pr.head.sha && item.base.repo.id === repository.id);
      if (!direct && !associated) throw new Error("Actions run is not associated with the exact PR head");
      if (!direct) {
        const ancestry = parse(Comparison, await get(`${path}/compare/${pr.head.sha}...${workflow.head_sha}?per_page=100&page=1`, signal));
        if (ancestry.base_commit.sha !== pr.head.sha || ancestry.behind_by !== 0 || !["ahead", "identical"].includes(ancestry.status)) throw new Error("Actions tested commit does not contain the exact PR head");
      }
      await assertCurrentBinding();
      return { ...result, actionJob: { untrusted: true, grantsExecutionPermission: false, id: job.id, runId: workflow.id, runHead: workflow.head_sha, relationship: direct ? "head" : "merge-test-descendant", name: job.name, status: job.status, conclusion: job.conclusion,
        steps: job.steps.map(step => ({ number: step.number, name: step.name, status: step.status, conclusion: step.conclusion })) } };
    }
    const page = input.page ?? 1;
    const query = `per_page=100&page=${page}`;
    if (input.action === "provider-conflict-inspect") {
      if (pr.base.sha !== input.expectedBase) throw new Error("PR base changed; reread before inspecting conflicts");
      const comparison = parse(Comparison, await get(`${path}/compare/${input.expectedBase}...${input.expectedHead}?${query}`, signal));
      if (comparison.base_commit.sha !== input.expectedBase) throw new Error("Comparison base does not match the inspected PR");
      const current = parse(Mergeability, await get(`${path}/pulls/${pr.number}`, signal));
      assertBinding(current);
      return { ...result, conflict: { untrusted: true, grantsMergePermission: false, page,
        mergeability: current.mergeable === null ? "unknown" : current.mergeable ? "mergeable" : "conflicting", providerState: current.mergeable_state,
        base: comparison.base_commit.sha, mergeBase: comparison.merge_base_commit.sha, status: comparison.status, aheadBy: comparison.ahead_by, behindBy: comparison.behind_by,
        commits: { total: comparison.total_commits, items: comparison.commits.map(item => item.sha), nextPage: page * 100 < comparison.total_commits ? page + 1 : null },
        files: { firstPageOnly: true, mayBeTruncated: true, items: (comparison.files ?? []).map(item => ({ path: item.filename, status: item.status, additions: item.additions, deletions: item.deletions, changes: item.changes })) }
      } };
    }
    if (input.action === "provider-ci-detail") {
      const detail = parse(CheckDetail, await get(`${path}/check-runs/${input.checkRunId}`, signal));
      if (detail.id !== input.checkRunId || detail.head_sha !== pr.head.sha) throw new Error("Check-run does not belong to the inspected PR head");
      const annotations = parse(Type.Array(Annotation, { maxItems: 100 }), await get(`${path}/check-runs/${detail.id}/annotations?${query}`, signal));
      await assertCurrentBinding();
      return { ...result, diagnostic: { untrusted: true, page,
        checkRun: { id: detail.id, name: detail.name, status: detail.status, conclusion: detail.conclusion, title: detail.output.title, summary: detail.output.summary, text: detail.output.text, actionJob: actionJob(detail.details_url, repository.full_name) },
        annotations: { total: detail.output.annotations_count, nextPage: page * 100 < detail.output.annotations_count ? page + 1 : null,
          items: annotations.map(item => ({ path: item.path, startLine: item.start_line, endLine: item.end_line, level: item.annotation_level, message: item.message, title: item.title, details: item.raw_details })) }
      } };
    }
    if (input.action === "provider-review-inspect") {
      const [rawReviews, rawLines, rawDiscussion] = await Promise.all([
        get(`${path}/pulls/${pr.number}/reviews?${query}`, signal),
        get(`${path}/pulls/${pr.number}/comments?${query}`, signal),
        get(`${path}/issues/${pr.number}/comments?${query}`, signal),
      ]);
      const reviews = parse(Type.Array(Review, { maxItems: 100 }), rawReviews);
      const lines = parse(Type.Array(LineComment, { maxItems: 100 }), rawLines);
      const discussion = parse(Type.Array(DiscussionComment, { maxItems: 100 }), rawDiscussion);
      await assertCurrentBinding();
      return { ...result, feedback: { page, untrusted: true,
        reviews: { nextPage: reviews.length === 100 ? page + 1 : null, items: reviews.map(item => ({ id: item.id, author: item.user.login, body: item.body, state: item.state, submittedAt: item.submitted_at })) },
        lineComments: { nextPage: lines.length === 100 ? page + 1 : null, items: lines.map(item => ({ id: item.id, author: item.user.login, body: item.body, path: item.path, line: item.line, replyTo: item.in_reply_to_id ?? null, commit: item.commit_id, outdated: item.commit_id !== pr.head.sha, createdAt: item.created_at, updatedAt: item.updated_at })) },
        discussion: { nextPage: discussion.length === 100 ? page + 1 : null, items: discussion.map(item => ({ id: item.id, author: item.user.login, body: item.body, createdAt: item.created_at, updatedAt: item.updated_at })) },
      } };
    }
    const [rawChecks, rawStatuses] = await Promise.all([
      get(`${path}/commits/${pr.head.sha}/check-runs?${query}`, signal),
      get(`${path}/commits/${pr.head.sha}/status?${query}`, signal),
    ]);
    const checks = parse(Checks, rawChecks), statuses = parse(Statuses, rawStatuses);
    if (statuses.sha !== pr.head.sha || checks.check_runs.some(item => item.head_sha !== pr.head.sha)) throw new Error("GitHub CI head does not match the inspected PR");
    await assertCurrentBinding();
    return { ...result, ci: {
      head: pr.head.sha, page,
      checkRuns: { total: checks.total_count, nextPage: page * 100 < checks.total_count ? page + 1 : null,
        items: checks.check_runs.map(item => ({ id: item.id, name: item.name, status: item.status, conclusion: item.conclusion, actionJob: actionJob(item.details_url, repository.full_name) })) },
      commitStatuses: { state: statuses.state, total: statuses.total_count, nextPage: page * 100 < statuses.total_count ? page + 1 : null,
        items: statuses.statuses.map(item => ({ id: item.id, context: item.context, state: item.state })) },
    } };
  }
  async function close() {
    closed = true;
    const pending = [...active];
    for (const item of pending) item.controller.abort();
    await Promise.allSettled(pending.map(item => item.task));
  }
  return { inspect, close };
}
