import { publishGithubReview } from "./github-review-publish.ts";
import { checkoutRepository } from "./github-authorization.ts";
import { githubGraphql } from "./github-prs.ts";
import { Type, type TSchema } from "typebox";
import { parse } from "./state.ts";
import type { PrReviewSource, PrIteration } from "./plugin-types.ts";
import type { Project } from "./state.ts";
import { cli, runCli } from "./vcs.ts";
const sha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw Error("Invalid GitHub commit");
  return value;
};
async function checkout(p: Project) {
  const repo = p.githubAuthorization?.[0]?.repositoryId,
    dir = p.workspaceAuthorization?.repositories.find((x) => x.repositoryId === repo)?.ownerCheckout;
  if (!repo || !dir || (await checkoutRepository(dir)).toLowerCase() !== repo.toLowerCase())
    throw Error("Review requires the authorized checkout");
  const git = async (...args: string[]) => {
    const r = await runCli(cli.git(), ["--literal-pathspecs", "--no-replace-objects", "-C", dir, ...args]);
    if (r.code) throw Error(`Git ${args[0]} failed: ${r.stderr.trim().slice(-200)}`);
    return r.stdout;
  };
  const effective = (await git("remote", "get-url", "origin")).trim().toLowerCase();
  if (
    ![`https://github.com/${repo}`, `git@github.com:${repo}`].some((u) => [u.toLowerCase(), `${u.toLowerCase()}.git`].includes(effective))
  )
    throw Error("Review checkout origin was redirected");
  return git;
}
const checksFields = `statusCheckRollup{contexts(first:100){totalCount nodes{... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}`;
const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){databaseId pullRequest(number:$number){id title body state isDraft headRefName baseRefName author{login} headRefOid baseRefOid timelineItems(last:50,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}} commits(last:1){nodes{commit{${checksFields}}}} reviewThreads(first:100){totalCount nodes{id path line diffSide isResolved isOutdated comments(first:20){totalCount nodes{author{login} createdAt body commit{oid}}}}}}}}`;
const nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const str = Type.String(),
  oid = Type.String({ pattern: "^[a-f0-9]{40}$" }),
  commit = Type.Object({ oid }),
  author = nullable(Type.Object({ login: str }));
const nodes = <T extends TSchema>(t: T) => Type.Object({ nodes: Type.Array(t), totalCount: Type.Optional(Type.Integer()) });
const check = Type.Object({
  name: Type.Optional(str),
  context: Type.Optional(str),
  status: Type.Optional(str),
  state: Type.Optional(str),
  conclusion: Type.Optional(nullable(str)),
});
const checks = Type.Object({ statusCheckRollup: nullable(Type.Object({ contexts: nodes(check) })) });
const metadata = Type.Object({
  id: str,
  title: str,
  body: Type.Optional(str),
  state: str,
  isDraft: Type.Boolean(),
  headRefName: str,
  baseRefName: str,
  author,
  headRefOid: oid,
  baseRefOid: oid,
  timelineItems: Type.Optional(nodes(Type.Object({ beforeCommit: nullable(commit), afterCommit: nullable(commit) }))),
  commits: nodes(Type.Object({ commit: checks })),
  reviewThreads: nodes(
    Type.Object({
      id: str,
      path: str,
      line: nullable(Type.Integer()),
      diffSide: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
      isResolved: Type.Boolean(),
      isOutdated: Type.Boolean(),
      comments: nodes(Type.Object({ body: str, createdAt: str, author, commit: nullable(commit) })),
    }),
  ),
});
const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];
export const githubReview: PrReviewSource = {
  publish: publishGithubReview,
  capabilities: { publish: true, reply: true, resolve: true, viewedSync: false, annotations: false, issues: false, suggestions: false },
  async authorize(p) {
    await checkout(p);
    return String(p.githubAuthorization![0]!.numericId);
  },
  async snapshot(p, id, observed) {
    const git = await checkout(p);
    const [owner, name] = p.githubAuthorization![0]!.repositoryId.split("/");
    const repository = (await githubGraphql(query, { owner, name, number: Number(id) })).repository;
    if (repository?.databaseId !== p.githubAuthorization![0]!.numericId)
      throw Error("GitHub repository identity changed; reauthorize before reviewing");
    const data: unknown = repository.pullRequest;
    if (!data) throw Error("PR not found");
    const pr = parse(metadata, data);
    const head = sha(pr.headRefOid),
      base = sha(pr.baseRefOid),
      ref = `refs/pi-prjcts/pr/${id}`;
    const fetch = ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "origin"];
    await git(...fetch, `+refs/pull/${id}/head:${ref}`);
    if ((await git("rev-parse", ref)).trim() !== head) throw Error("PR head changed. Open again.");
    try {
      await git("cat-file", "-e", `${base}^{commit}`);
    } catch {
      await git(...fetch, base);
    }
    const heads = [
      ...new Set(
        [...observed, ...(pr.timelineItems?.nodes ?? []).flatMap((e) => [e.beforeCommit?.oid, e.afterCommit?.oid])].filter(
          (h): h is string => !!h && h !== head,
        ),
      ),
    ].slice(-32);
    const notices = new Set<string>();
    const iterations: PrIteration[] = [];
    let historical: Record<string, unknown> = {};
    if (heads.length) {
      const fields = heads.map((h, i) => `h${i}:object(oid:"${sha(h)}"){... on Commit{${checksFields}}}`).join(" ");
      try {
        historical =
          (await githubGraphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, { owner, name }))
            .repository ?? {};
      } catch {
        notices.add("Historical checks could not be read.");
      }
    }
    for (const [index, h] of [...heads, head].entries()) {
      try {
        if (h !== head) {
          try {
            await git("cat-file", "-e", `${h}^{commit}`);
          } catch {
            await git(...fetch, h);
          }
        }
        const common = sha((await git("merge-base", base, h)).trim());
        const info = h === head ? pr.commits.nodes[0]?.commit : historical[`h${index}`];
        const contexts = info ? parse(checks, info).statusCheckRollup?.contexts : null;
        const list = contexts?.nodes ?? [];
        if ((contexts?.totalCount ?? 0) > list.length) notices.add("Only the first 100 checks are shown.");
        iterations.push({
          head: h,
          base: common,
          ...(info
            ? {
                checks: list.map((c) => ({
                  name: c.name ?? c.context ?? "Check",
                  result: c.conclusion ?? c.state ?? c.status ?? "unknown",
                })),
              }
            : {}),
        });
      } catch (e) {
        if (h === head) throw e;
        notices.add(`Iteration ${h.slice(0, 8)} could not be loaded.`);
      }
    }
    if ((pr.reviewThreads.totalCount ?? 0) > pr.reviewThreads.nodes.length) notices.add("Only the first 100 threads are shown.");
    if (pr.reviewThreads.nodes.some((t) => (t.comments.totalCount ?? 0) > t.comments.nodes.length))
      notices.add("Long discussions show their first 20 comments.");
    return {
      providerId: pr.id,
      description: pr.body?.slice(0, 12000),
      title: pr.title.slice(0, 300),
      author: pr.author?.login ?? "",
      head,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      state: pr.isDraft ? "Draft" : pr.state,
      url: `https://github.com/${owner}/${name}/pull/${id}`,
      iterations,
      notice: [...notices].join(" "),
      threads: pr.reviewThreads.nodes.map((t) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        side: t.diffSide ?? "RIGHT",
        commit: t.comments.nodes[0]?.commit?.oid ?? null,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        comments: t.comments.nodes.map((c) => ({
          createdAt: c.createdAt,
          author: c.author?.login ?? "unknown",
          body: c.body.length > 2000 ? c.body.slice(0, 1999) + "…" : c.body,
        })),
      })),
    };
  },
  async files(p, _id, r) {
    const git = await checkout(p);
    const raw = (await git(...diffArgs, "--raw", "--no-abbrev", "-z", sha(r.base), sha(r.head), "--")).split("\0");
    const stats = new Map(
      (await git(...diffArgs, "--numstat", "-z", sha(r.base), sha(r.head), "--")).split("\0").flatMap((line) => {
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(line);
        return match && match[1] !== "-" ? [[match[3]!, { additions: Number(match[1]), deletions: Number(match[2]) }] as const] : [];
      }),
    );
    const files = [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      const [, , old, blob, status] = raw[i]!.split(" ");
      files.push({ stats: stats.get(raw[i + 1]!), path: raw[i + 1]!, status: status!, blob: status === "D" ? `deleted:${old}` : blob! });
    }
    return files;
  },
  async fileDiff(p, _id, path, r) {
    return (await checkout(p))(...diffArgs, "--unified=3", sha(r.base), sha(r.head), "--", path);
  },
  async fileLines(p, _id, path, head, from, count) {
    const text = await (await checkout(p))("cat-file", "blob", `${sha(head)}:${path}`);
    return text
      .replace(/\n$/, "")
      .split("\n")
      .slice(from - 1, from - 1 + count);
  },
};
