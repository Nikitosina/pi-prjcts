// Private host, real Git worktrees and fake-model tool calls. See coordinator-workspace-failures.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, call, say, randomUUID } from "./lib/e2e-kit.mjs";

const commands = {
  "MARK-ALLOCATE": [["bash", { command: "pwd; git branch --show-current" }]],
  "MARK-SWITCH": [
    ["bash", { command: "git switch -c coordinator/followup" }],
    ["read", { path: "README.md" }],
    ["bash", { command: "printf keep > dirty.txt; git branch --show-current" }],
  ],
  "MARK-PROBE": [["bash", { command: "git branch --show-current; cat dirty.txt" }]],
  "MARK-DETACH": [
    ["bash", { command: "git switch --detach HEAD" }],
    ["read", { path: "dirty.txt" }],
  ],
  "MARK-DETACHED": [["bash", { command: "git rev-parse --abbrev-ref HEAD; cat dirty.txt" }]],
  "MARK-RESTORE": [
    ["bash", { command: "git switch -" }],
    ["read", { path: "README.md" }],
  ],
};
const sharedMarker = "SHARED-BRANCH-PROBE";
// H1-H3 (task-worker-failures.md): a helper reads and commits, but never publishes.
const helperCommands = [
  "pwd; git branch --show-current; cat dirty.txt",
  "git push origin HEAD:refs/heads/coordinator/followup",
  "gh pr create --title x --body y",
  "git log -1 --format=%s; git status --short | wc -l",
];
const k = await createKit("coordinator-workspace", {
  handler: ({ role, user, results }) => {
    if (role === "worker" && user.includes(sharedMarker))
      return results.length < helperCommands.length
        ? call("bash", { command: helperCommands[results.length] })
        : say("Shared helper finished");
    if (role !== "coordinator") return;
    if (user === "MARK-SHARED")
      return results.length
        ? say("Shared helper queued")
        : call("agents", {
            action: "spawn",
            role: "worker",
            workspace: { kind: "shared" },
            title: sharedMarker,
            brief: sharedMarker,
            acceptance: ["Read the prepared chat worktree"],
            requestId: randomUUID(),
          });
    const steps = commands[user];
    return steps && results.length < steps.length ? call(...steps[results.length]) : say("Coordinator finished");
  },
});
await k.run(async () => {
  k.initRepo();
  const id = await k.createProject("Coordinator branch ownership");
  const resultsFor = (marker) => k.result.calls.findLast((c) => c.role === "coordinator" && c.user === marker)?.results ?? [];
  const ask = async (marker) => {
    await k.ask(id, marker);
    const results = resultsFor(marker);
    k.check(
      `${marker} completes every tool without an ownership blocker`,
      results.length === commands[marker].length && results.every((r) => !r.includes("<harness>") && !r.includes("Owned Git")),
      results,
    );
    return results;
  };
  await ask("MARK-ALLOCATE");
  const allocation = resultsFor("MARK-ALLOCATE")[0];
  const worktree = allocation.split("\n").find((line) => line.startsWith(k.root));
  k.check("Coordinator owns a separate worktree", worktree && worktree !== k.workspace, allocation);
  const initialBranch = k.git(worktree, "branch", "--show-current");
  const switched = await ask("MARK-SWITCH");
  k.check(
    "read and bash work immediately after a branch switch",
    switched[1].includes("base") && switched[2].includes("coordinator/followup"),
    switched,
  );
  await k.restartHost();
  k.check("reopen preserves branch and dirty files", (await ask("MARK-PROBE"))[0].includes("coordinator/followup\nkeep"));
  await k.ask(id, "MARK-SHARED");
  const helper = (await k.jobs(id)).find((job) => job.title === sharedMarker);
  const helperResults =
    k.result.calls.findLast((c) => c.role === "worker" && c.user.includes(sharedMarker) && c.results.length)?.results ?? [];
  const shared = helperResults[0];
  k.check(
    "shared helper borrows changed-branch allocation",
    helper?.status === "completed" && shared?.includes(`${worktree}\ncoordinator/followup\nkeep`),
    { helper, shared },
  );
  const blockedForHelper = (text) => /Blocked/.test(text ?? "") && /Coordinator/.test(text ?? "");
  k.check("H1/H2 a task helper's git push is blocked and names who publishes", blockedForHelper(helperResults[1]), helperResults[1]);
  k.check("H1/H2 a task helper's gh pr write is blocked", blockedForHelper(helperResults[2]), helperResults[2]);
  k.check("H3 a task helper still reads git", /^base|^c1/m.test(helperResults[3] ?? ""), helperResults[3]);
  await ask("MARK-DETACH");
  await k.restartHost();
  k.check("detached HEAD stays usable after reopen", (await ask("MARK-DETACHED"))[0].includes("HEAD\nkeep"));
  await ask("MARK-RESTORE");
  k.check("Coordinator can restore its branch after detaching", k.git(worktree, "branch", "--show-current") === "coordinator/followup");
  // Return to the allocated branch through the same execution path, not a host repair.
  commands["MARK-ORIGINAL"] = [
    ["bash", { command: `git switch ${initialBranch}` }],
    ["read", { path: "dirty.txt" }],
  ];
  await ask("MARK-ORIGINAL");
  k.check(
    "original branch and local files survive",
    k.git(worktree, "branch", "--show-current") === initialBranch && readFileSync(join(worktree, "dirty.txt"), "utf8") === "keep",
  );
  k.check(
    "owner checkout is unchanged",
    k.git(k.workspace, "status", "--porcelain") === "" && k.git(k.workspace, "branch", "--show-current") === "main",
  );
});
