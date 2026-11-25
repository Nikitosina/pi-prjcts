import { githubGraphql } from "./github-prs.ts";
import type { PrReviewSource } from "./plugin-types.ts";
export const publishGithubReview: NonNullable<PrReviewSource["publish"]> = async (_p, _id, snapshot, op) => {
  if (op.kind === "review") {
    const input = {
      pullRequestId: snapshot.providerId,
      commitOID: snapshot.head,
      event: op.verdict,
      body: op.summary,
      threads: op.comments.map((c) => ({
        path: c.path,
        side: c.side,
        line: c.to,
        body: c.body,
        ...(c.from !== c.to ? { startLine: c.from, startSide: c.side } : {}),
      })),
    };
    const data = await githubGraphql(
      "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{url}}}",
      { input },
    );
    return { url: data.addPullRequestReview.pullRequestReview.url };
  }
  if (op.kind === "reply") {
    const data = await githubGraphql(
      "mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{url}}}",
      { input: { pullRequestReviewThreadId: op.threadId, body: op.body } },
    );
    return { url: data.addPullRequestReviewThreadReply.comment.url };
  }
  const [name, inputType] =
    op.kind === "resolve" ? ["resolveReviewThread", "ResolveReviewThreadInput"] : ["unresolveReviewThread", "UnresolveReviewThreadInput"];
  const data = await githubGraphql(`mutation($input:${inputType}!){${name}(input:$input){thread{id isResolved}}}`, {
    input: { threadId: op.threadId },
  });
  if (data[name!]?.thread?.id !== op.threadId || data[name!].thread.isResolved !== (op.kind === "resolve"))
    throw Error("Missing thread receipt");
  return { url: snapshot.url! };
};
