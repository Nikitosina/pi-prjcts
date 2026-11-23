import { checkoutRepository } from "./github-authorization.ts";
import { githubGraphql } from "./github-prs.ts";
import type { PrReviewSource, PrReviewThread } from "./plugin-types.ts";
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
  return async (...args: string[]) => {
    const r = await runCli(cli.git(), ["--literal-pathspecs", "--no-replace-objects", "-C", dir, ...args]);
    if (r.code) throw Error(`Git ${args[0]} failed: ${r.stderr.trim().slice(-200)}`);
    return r.stdout;
  };
}
const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){title author{login} headRefOid baseRefOid timelineItems(last:50,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}} reviewThreads(first:100){nodes{path line diffSide isResolved isOutdated comments(first:20){nodes{author{login} body commit{oid}}}}}}}}`;
type Comment = { author: { login: string } | null; body: string; commit: { oid: string } | null };
type Metadata = {
  title: string;
  author: { login: string } | null;
  headRefOid: string;
  baseRefOid: string;
  timelineItems?: { nodes: { beforeCommit?: { oid: string }; afterCommit?: { oid: string } }[] };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup?: {
          contexts: { nodes: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] };
        };
      };
    }[];
  };
  reviewThreads: {
    nodes: {
      path: string;
      line: number | null;
      diffSide?: PrReviewThread["side"];
      isResolved: boolean;
      isOutdated: boolean;
      comments: { nodes: Comment[] };
    }[];
  };
};
const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];
export const githubReview: PrReviewSource = {
  capabilities: { viewedSync: false, annotations: false, issues: false, suggestions: false },
  async snapshot(p, id) {
    const git = await checkout(p);
    const [owner, name] = p.githubAuthorization![0]!.repositoryId.split("/");
    const pr: Metadata | undefined = (await githubGraphql(query, { owner, name, number: Number(id) })).repository?.pullRequest;
    if (!pr) throw Error("PR not found");
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
    const heads = new Set(
      (pr.timelineItems?.nodes ?? [])
        .flatMap((e) => [e.beforeCommit?.oid, e.afterCommit?.oid])
        .filter((h): h is string => !!h && h !== head),
    );
    heads.add(head);
    const iterations = [];
    for (const h of heads) {
      try {
        const common = sha((await git("merge-base", base, sha(h))).trim());
        iterations.push({ head: h, base: common });
      } catch (err) {
        if (h === head) throw err;
      }
    }
    return {
      title: pr.title.slice(0, 300),
      author: pr.author?.login ?? "",
      head,
      iterations,
      checks: (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map((c) => ({
        name: c.name ?? c.context ?? "Check",
        result: c.conclusion ?? c.state ?? c.status ?? "unknown",
      })),
      threads: pr.reviewThreads.nodes.map((t) => ({
        path: t.path,
        line: t.line,
        side: t.diffSide ?? "RIGHT",
        commit: t.comments.nodes[0]?.commit?.oid ?? null,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? "unknown", body: c.body.slice(0, 2000) })),
      })),
    };
  },
  async files(p, _id, r) {
    const git = await checkout(p);
    const raw = (await git(...diffArgs, "--raw", "--no-abbrev", "-z", sha(r.base), sha(r.head), "--")).split("\0");
    const files = [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      const [, , old, blob, status] = raw[i]!.split(" ");
      files.push({ path: raw[i + 1]!, status: status!, blob: status === "D" ? `deleted:${old}` : blob! });
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
