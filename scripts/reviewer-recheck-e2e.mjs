// E2E: a worker's re-check continues its reviewer (scripts/reviewer-recheck-failures.md). Private host, git project, fake model; the reviewer is a real
// child whose own code_read tool reads the worker's real worktree, so the content it reports (CONTENT-A, then CONTENT-B) comes from disk, never from the prompt.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createKit, call, say, randomUUID } from "./lib/e2e-kit.mjs";

const SHA = /\b[0-9a-f]{40}\b/;
const failed = {
  status: 400,
  body: { error: { message: "scripted terminal failure", type: "invalid_request_error" } },
};
let reviewerId = null;
const shaOf = (results, index) => SHA.exec(results[index] ?? "")?.[0];
const commit = (name) =>
  `printf 'CONTENT-${name}\\n' > proof.txt && git add proof.txt && git -c user.email=e@x.invalid -c user.name=e commit -qm ${name} && git rev-parse HEAD`;
const recheck = (task) => call("subagent", { role: "reviewer", kind: "recheck", task, continues: reviewerId });
// Each step answers the worker's next request; the previous tool results are in `results`.
const STEPS = [
  () => call("bash", { command: commit("A") }),
  (r) => call("job", { action: "candidate", sha: shaOf(r, 0) }),
  () => call("subagent", { role: "reviewer", kind: "full", task: "REVIEW the candidate: read proof.txt and report what it says." }),
  (r) => {
    reviewerId = /reviewer (\d+)/.exec(r[2])?.[1];
    return call("bash", { command: commit("B") });
  },
  (r) => call("job", { action: "candidate", sha: shaOf(r, 3) }),
  () => recheck("RECHECK-B read proof.txt again."),
  () => call("bash", { command: "printf 'DIRTY\\n' >> proof.txt" }),
  () => recheck("RECHECK-DIRTY"),
  () => call("bash", { command: "git checkout -q proof.txt && git switch -q --detach HEAD~1" }),
  () => recheck("RECHECK-OFF-CANDIDATE"),
  () => call("bash", { command: "git switch -q - && " + commit("C") }),
  (r) => call("job", { action: "candidate", sha: shaOf(r, 10) }),
  () => recheck("RECHECK-FAIL read proof.txt again."),
  () => recheck("RECHECK-C read proof.txt again after the failure."),
];
// A second Job with a fresh budget: its worktree disappears before its first review.
const GONE = [
  () => call("bash", { command: commit("G") }),
  (r) => call("job", { action: "candidate", sha: shaOf(r, 0) }),
  () => call("bash", { command: 'cd / && rm -rf "$OLDPWD"' }),
  () => call("subagent", { role: "reviewer", kind: "full", task: "REVIEW-GONE read proof.txt." }),
];
const kit = await createKit("reviewer-recheck", {
  handler: ({ role, user, results }) => {
    if (role === "reviewer") {
      if (user.includes("RECHECK-FAIL")) return failed;
      return results.length ? say(`SAW[${results[0].trim()}]`) : call("code_read", { path: "proof.txt" });
    }
    if (role !== "worker" || !/RECHK|GONE/.test(user)) return undefined;
    const step = (user.includes("RECHK") ? STEPS : GONE)[results.length];
    return step ? step(results) : say("Finished the scripted re-checks.");
  },
});
await kit.run(async () => {
  kit.initRepo();
  const id = await kit.createProject("Reviewer recheck");
  const scopeId = (await kit.rpc({ action: "workspace-catalog", id })).find((scope) => scope.wholeRepository).id;
  const jobId = (
    await kit.rpc({
      action: "work-submit",
      id,
      threadId: randomUUID(),
      requestId: randomUUID(),
      workspaceScopeId: scopeId,
      text: "RECHK go",
    })
  ).id;
  await kit.eventually(async () => (await kit.jobs(id)).find((item) => item.id === jobId)?.status !== "running", "worker finished", 1200);
  const worker = kit.result.calls.filter((item) => item.role === "worker" && item.user.includes("RECHK")).at(-1);
  const out = (index) => worker.results[index] ?? "";
  const reviewerRuns = (marker) => kit.result.calls.filter((item) => item.role === "reviewer" && item.user.includes(marker));
  const read = (marker) => reviewerRuns(marker).find((item) => item.results.length)?.results[0] ?? "";
  const { check } = kit;
  const goneId = (
    await kit.rpc({
      action: "work-submit",
      id,
      threadId: randomUUID(),
      requestId: randomUUID(),
      workspaceScopeId: scopeId,
      text: "GONE go",
    })
  ).id;
  await kit.eventually(
    async () => (await kit.jobs(id)).find((item) => item.id === goneId)?.status !== "running",
    "gone worker finished",
    1200,
  );
  const gone = kit.result.calls.filter((item) => item.role === "worker" && item.user.includes("GONE")).at(-1);
  check(
    "D1 a worktree that is gone is refused for a full review; no reviewer runs, so none reads the owner checkout",
    /does not exist|cannot be read|no working directory/i.test(gone.results[3] ?? "") && !reviewerRuns("REVIEW-GONE").length,
    gone.results,
  );

  check(
    "A1 the first review reads A from the worktree through its own code tool",
    /CONTENT-A/.test(read("REVIEW the candidate")),
    read("REVIEW"),
  );
  check(
    "A2 the continued reviewer reads B from the same worktree, not A and not the prompt",
    /CONTENT-B/.test(read("RECHECK-B")),
    read("RECHECK-B"),
  );
  check(
    "A3 it is the same conversation: the re-check turn carries the note that the commit changed",
    /commit under review changed/.test(reviewerRuns("RECHECK-B")[0]?.user ?? ""),
    reviewerRuns("RECHECK-B")[0]?.user,
  );
  check(
    "B1 a dirty checkout is refused and no reviewer turn is sent",
    /uncommitted/.test(out(7)) && !reviewerRuns("RECHECK-DIRTY").length,
    out(7),
  );
  check(
    "B2 a checkout that is not the recorded candidate is refused and no reviewer turn is sent",
    /recorded candidate/.test(out(9)) && !reviewerRuns("RECHECK-OFF-CANDIDATE").length,
    out(9),
  );
  check("C1 a failed re-check reports it", /did not answer/.test(out(12)), out(12));
  check("C2 after the failure the same reviewer can be continued and reads C", /CONTENT-C/.test(read("RECHECK-C")), read("RECHECK-C"));
  const job = (await kit.jobs(id)).find((item) => item.id === jobId);
  check(
    "E1 budget: one full, the failed re-check given back (B and C spent)",
    job.reviews.full === 1 && job.reviews.rechecks === 3,
    job.reviews,
  );
  check(
    "F1 the owner checkout was not touched",
    existsSync(join(kit.workspace, "README.md")) && !existsSync(join(kit.workspace, "proof.txt")),
  );
});
