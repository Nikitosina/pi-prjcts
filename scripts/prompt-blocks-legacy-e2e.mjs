// E2E: agents prepared by a host from before prompt blocks (base commit 9f4ee13) after the upgrade (scripts/prompt-blocks-failures.md P8).
// An agent whose stored prompt is exactly what the current inputs rebuild (with a behavior it could have had) adopts saved
// blocks inside that frame; one that is not stays on the prompt it started with and says why. Fakes only.
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = "9f4ee13";
const repo = process.cwd(),
  core = join(realpathSync(tmpdir()), `prompt-blocks-legacy-core-${randomUUID()}`);
mkdirSync(core, { mode: 0o700 });
execFileSync("/bin/sh", ["-c", `git -C "${repo}" archive ${BASE} src web web-ui2 relay package.json tsconfig.json | tar -x -C "${core}"`]);
symlinkSync(join(repo, "node_modules"), join(core, "node_modules"));
process.env.PI_PROJECTS_CORE = core;

const { createKit, call, say } = await import("./lib/e2e-kit.mjs");
const kit = await createKit("prompt-blocks-legacy", {
  handler: ({ role, user, results }) => {
    if (role !== "coordinator") return undefined;
    if (user.startsWith("[Durable work")) return say("Noted report.");
    const mark = /MARK-(WORKER|SCOUT) (\S+)/.exec(user);
    if (mark && !results.length) return call("projects_delegate", { role: mark[1].toLowerCase(), task: `TASK-${mark[1]} ${mark[2]}` });
    if (mark) return say("Noted.");
    return undefined;
  },
});

try {
  await kit.run(async () => {
    const { rpc, check } = kit;
    kit.initRepo();
    writeFileSync(join(kit.workspace, "AGENTS.md"), "REPO-RULE-ONE: keep functions short.\n");
    kit.git(kit.workspace, "add", "AGENTS.md");
    kit.git(kit.workspace, "commit", "-qm", "rules");
    const id = await kit.createProject("Legacy blocks");
    // Two workers with different legacy overrides, and a scout on the built-in prompt, all prepared by the old host.
    await kit.updateSettings(id, { prompts: { worker: "OLD-OVERRIDE: one" } });
    await kit.ask(id, "MARK-WORKER unproven");
    await kit.updateSettings(id, { prompts: { worker: "NEWER-OVERRIDE: two" } });
    await kit.ask(id, "MARK-WORKER proven");
    await kit.ask(id, "MARK-SCOUT legacy");
    const started = (marker) => kit.lastCall(marker.startsWith("TASK-SCOUT") ? "scout" : "worker", marker).system;
    check(
      "L0 the old host ran each agent with its override",
      started("TASK-WORKER unproven").includes("OLD-OVERRIDE") && started("TASK-WORKER proven").includes("NEWER-OVERRIDE"),
    );

    // Upgrade: the same home, now on this branch's code.
    await kit.stopHost();
    rmSync(join(core, "src"), { recursive: true, force: true });
    cpSync(join(repo, "src"), join(core, "src"), { recursive: true });
    kit.startHost();
    await kit.waitHost();
    const agent = async (marker) => (await rpc({ action: "jobs-snapshot", id })).agents.find((item) => item.brief.includes(marker));
    check(
      "L1 agents from before frames are legacy-unchecked",
      (await agent("TASK-WORKER proven")).prompt?.state === "legacy-unchecked",
      (await agent("TASK-WORKER proven")).prompt,
    );

    const legacy = await rpc({ action: "prompt-blocks-get", projectId: id, target: "worker" });
    check("L2 the legacy override shows as legacy", legacy.legacy && legacy.text === "NEWER-OVERRIDE: two");
    const adopted = { id: "custom:adopted", name: "Adopted", enabled: true, text: "ADOPTED-BEHAVIOR: say what you checked." };
    const saved = await rpc({
      action: "prompt-blocks-set",
      projectId: id,
      target: "worker",
      revision: legacy.revision,
      blocks: [
        adopted,
        ...legacy.blocks.map((block) =>
          block.kind === "custom" ? { id: block.id, name: block.name, enabled: false, text: block.text } : { id: block.id, enabled: true },
        ),
      ],
    });
    const follow = async (marker, text) => {
      await rpc({ action: "thread-send", id, threadId: (await agent(marker)).id, text, requestId: randomUUID() });
      await kit.delay(300);
      await kit.settle(id);
      return kit.result.calls.findLast((c) => c.user.includes(text))?.system ?? "";
    };

    const proven = await follow("TASK-WORKER proven", "FOLLOW-PROVEN");
    check(
      "P8 a legacy worker whose prompt rebuilds exactly adopts the saved behavior inside its frame",
      proven === started("TASK-WORKER proven").replace("NEWER-OVERRIDE: two", saved.text),
      { length: proven.length },
    );
    check("P8 it is current afterwards", (await agent("TASK-WORKER proven")).prompt?.state === "current");

    const unproven = await follow("TASK-WORKER unproven", "FOLLOW-UNPROVEN");
    check("P8 a legacy worker that does not rebuild keeps the prompt it started with", unproven === started("TASK-WORKER unproven"));
    const frozen = (await agent("TASK-WORKER unproven")).prompt;
    check("P8 and says why", frozen?.state === "frozen" && /does not match/.test(frozen.reason ?? ""), frozen);

    const scout = await rpc({ action: "prompt-blocks-get", projectId: id, target: "scout" });
    await rpc({
      action: "prompt-blocks-set",
      projectId: id,
      target: "scout",
      revision: scout.revision,
      blocks: [{ id: "answer", enabled: true, text: "CUSTOM-SCOUT: list file paths first." }],
    });
    const scoutFollow = await follow("TASK-SCOUT legacy", "FOLLOW-SCOUT");
    check(
      "P8 a legacy scout on the built-in prompt adopts saved behavior",
      scoutFollow === started("TASK-SCOUT legacy").replace(scout.text, "CUSTOM-SCOUT: list file paths first."),
    );
  });
} finally {
  if (existsSync(core)) rmSync(core, { recursive: true, force: true });
}
