// Browser E2E: UI2 worker details say which prompt a running agent has (jobs-snapshot `agents[].prompt`), for agents a host from
// before prompt blocks (base commit 9f4ee13) prepared: still to be checked, then frozen on its original prompt with the backend's
// reason; a worker this host prepared is current, with no line at all. Fakes only; the upgrade flow follows scripts/prompt-blocks-legacy-e2e.mjs.
// Failure cases: scripts/ui2-prompt-editor-failures.md (E20-E22).
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = "9f4ee13";
const repo = process.cwd(),
  core = join(realpathSync(tmpdir()), `ui2-worker-prompt-core-${randomUUID()}`);
mkdirSync(core, { mode: 0o700 });
execFileSync("/bin/sh", ["-c", `git -C "${repo}" archive ${BASE} src web web-ui2 relay package.json tsconfig.json | tar -x -C "${core}"`]);
symlinkSync(join(repo, "node_modules"), join(core, "node_modules"));
process.env.PI_PROJECTS_CORE = core;

const { createKit, call, say } = await import("./lib/e2e-kit.mjs");
const kit = await createKit("ui2-worker-prompt", {
  handler: ({ role, user, results }) => {
    if (role !== "coordinator") return undefined;
    if (user.startsWith("[Durable work")) return say("Noted report.");
    const mark = /MARK-WORKER (\S+)/.exec(user);
    if (mark && !results.length) return call("projects_delegate", { role: "worker", task: `TASK-WORKER ${mark[1]}` });
    if (mark) return say("Noted.");
    return undefined;
  },
});

try {
  await kit.run(async () => {
    const { rpc, check } = kit;
    kit.initRepo();
    const id = await kit.createProject("Worker prompt");
    // A worker prepared by the old host. Its frame (the host contract before contract blocks) no longer rebuilds, so it freezes.
    await kit.updateSettings(id, { prompts: { worker: "OLD-OVERRIDE: one" } });
    await kit.ask(id, "MARK-WORKER unproven");

    // Upgrade: the same home, now on this branch's code (backend and the inbox).
    await kit.stopHost();
    for (const dir of ["src", "web"]) {
      rmSync(join(core, dir), { recursive: true, force: true });
      cpSync(join(repo, dir), join(core, dir), { recursive: true });
    }
    kit.startHost();
    await kit.waitHost();
    const agent = async (marker) => (await rpc({ action: "jobs-snapshot", id })).agents.find((item) => item.brief.includes(marker));
    const unproven = await agent("TASK-WORKER unproven");
    check("setup: the old agent is legacy-unchecked", unproven.prompt?.state === "legacy-unchecked", unproven.prompt);
    // The focus id the worker list opens: the Job for a Job worker, the agent otherwise.
    const focusId = (item) => item.jobId ?? item.id;

    const web = new URL((await rpc({ action: "web" })).url);
    web.searchParams.set("project", id);
    const page = await kit.openPage(web.toString());
    await page.waitFor(`document.body.dataset.ready === "1"`, "UI2 ready");
    const line = `document.querySelector('#center .w-prompt')`;
    const open = async (item) => {
      await page.waitFor(`!!document.querySelector('#workers [data-open-worker="${focusId(item)}"]')`, "worker in the list");
      await page.evaluate(`document.querySelector('#workers [data-open-worker="${focusId(item)}"]').click()`);
      await page.waitFor(`!!document.querySelector('#center .focus-head')`, "worker details");
    };
    const shown = () =>
      page.evaluate(`(() => { const n = ${line}; return n ? { state: n.dataset.promptState, text: n.innerText.trim() } : null; })()`);

    await open(unproven);
    await page.waitFor(`${line}?.dataset.promptState === "legacy-unchecked"`, "legacy-unchecked line");
    const unchecked = await shown();
    check(
      "E21 a worker still to be checked says so, with the backend's reason",
      /check/i.test(unchecked.text) && unchecked.text.includes(unproven.prompt.reason.slice(0, 40)),
      unchecked,
    );
    await page.shot("01-legacy-unchecked", { force: true });

    // Its next turn cannot rebuild the stored prompt: it stays frozen on the original, and the open details follow.
    const legacy = await rpc({ action: "prompt-blocks-get", projectId: id, target: "worker" });
    await rpc({
      action: "prompt-blocks-set",
      projectId: id,
      target: "worker",
      revision: legacy.revision,
      blocks: legacy.blocks.map((block) =>
        block.kind === "custom" ? { id: block.id, name: block.name, enabled: false, text: block.text } : { id: block.id, enabled: true },
      ),
    });
    const follow = async (item, text) => {
      await rpc({ action: "thread-send", id, threadId: item.id, text, requestId: randomUUID() });
      await kit.delay(300);
      await kit.settle(id);
    };
    await follow(unproven, "FOLLOW-UNPROVEN");
    const frozen = (await agent("TASK-WORKER unproven")).prompt;
    check("setup: the unproven worker is frozen", frozen?.state === "frozen" && !!frozen.reason, frozen);
    await page.waitFor(`${line}?.dataset.promptState === "frozen"`, "frozen line without a reload");
    const frozenLine = await shown();
    check("E22 the open details follow the state change without a reload", frozenLine.state === "frozen");
    check(
      "E20 a frozen worker says its prompt is frozen and gives the reason",
      /frozen/i.test(frozenLine.text) && frozenLine.text.includes(frozen.reason),
      frozenLine,
    );
    check("E20 no rebuild or restart control next to it", await page.evaluate(`!(${line}).querySelector('button, a')`));
    await page.shot("02-frozen", { force: true });

    // A worker this host prepared runs the saved behavior: current, so no line.
    await kit.ask(id, "MARK-WORKER fresh");
    const fresh = await agent("TASK-WORKER fresh");
    check("setup: the fresh worker is current", !fresh.prompt || fresh.prompt.state === "current", fresh.prompt);
    await page.evaluate(`document.querySelector('#center [data-cmd="leave-focus"]')?.click()`);
    await open(fresh);
    await page.waitFor(`document.querySelector('#center .focus-head h1')?.innerText.includes("fresh")`, "fresh worker details");
    check("E21 a current worker has no prompt line", (await shown()) === null);
    // A phone opens the page at its width (a live resize keeps the desktop panels open).
    await page.viewport(390, 844, true);
    await page.reload();
    await page.waitFor(`document.body.dataset.ready === "1"`, "UI2 ready at 390 px");
    await open(unproven);
    await page.waitFor(`${line}?.dataset.promptState === "frozen"`, "frozen line at 390 px");
    check(
      "E20 at 390 px the frozen line fits",
      await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && (${line}).getBoundingClientRect().right <= innerWidth`),
    );
    await page.shot("03-frozen-390", { force: true });
  });
} finally {
  if (existsSync(core)) rmSync(core, { recursive: true, force: true });
}
