// Browser E2E: a Settings tab left open across a host restart shows and uses the new host's built-in role prompts.
// The host first runs from a private core copy whose four defaults carry a LEGACY marker, then restarts on the real defaults while the page stays open.
// Fakes only (fake model, private HOME, temp repo). Covers: no override is persisted for defaults, a genuine override and an unsaved edit survive,
// Reset removes the override, new threads use the current text and a thread started before the restart adopts the current behavior inside its frozen prompt.
// The inbox at `/` shows role text as prompt blocks (Settings → Prompt) that are reread on every opening; the classic per-role editor and
// its refresh races (F7-F9, F11) were retired 2026-11-04. Save and Reset of a role override are checked through `settings-update`.
// Cases are listed in settings-prompts-refresh-failures.md.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const repo = process.cwd(),
  core = join(realpathSync(tmpdir()), `settings-prompts-core-${randomUUID()}`);
mkdirSync(core, { mode: 0o700 });
for (const entry of ["src", "web", "relay", "package.json", "tsconfig.json"])
  cpSync(join(repo, entry), join(core, entry), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(core, "node_modules"));
const promptsFile = join(core, "src/role-prompts.ts"),
  current = readFileSync(promptsFile, "utf8");
const ROLES = ["coordinator", "worker", "scout", "reviewer"];
const legacy = ROLES.reduce((text, role) => text.replace(`  ${role}: \``, `  ${role}: \`LEGACY-DEFAULT ${role}. `), current);
if (ROLES.some((role) => !legacy.includes(`LEGACY-DEFAULT ${role}.`))) throw Error("could not mark every legacy default");
writeFileSync(promptsFile, legacy);
process.env.PI_PROJECTS_CORE = core;

const { createKit, call, say, delay } = await import("./lib/e2e-kit.mjs");
const handler = ({ role, user, results }) => {
  if (user.startsWith("[Durable work")) return say("Noted report.");
  const mark = /MARK-(WORKER|SCOUT|REVIEWER) (\S+)/.exec(user);
  if (role === "coordinator" && mark && results.length === 0)
    return call("projects_delegate", { role: mark[1].toLowerCase(), task: `TASK-${mark[1]} ${mark[2]}` });
  if (role === "coordinator" && mark) return say("Noted.");
  return undefined;
};
const kit = await createKit("settings-prompts-refresh", { handler });
const { check, rpc } = kit;
kit.initRepo();
const CUSTOM_SCOUT = "CUSTOM-SCOUT: read only the files you were asked about.";

try {
  await kit.run(async () => {
    const id = await kit.createProject("Prompt refresh");
    const stored = () => JSON.parse(readFileSync(join(kit.home, id, "project.json"), "utf8"));
    check("S0 a new project stores no prompt overrides", !("prompts" in stored()));
    await kit.updateSettings(id, { prompts: { scout: CUSTOM_SCOUT } });
    const before = await rpc({ action: "prompts-snapshot", id });
    check(
      "S0 the first host serves its own (legacy) built-in text",
      before.roles.every((item) => item.default.startsWith(`LEGACY-DEFAULT ${item.role}.`)),
    );

    // A worker thread that starts before the upgrade freezes the legacy text.
    await kit.ask(id, "MARK-WORKER frozen");
    const frozen = (await kit.jobs(id)).find((job) => job.request.includes("TASK-WORKER frozen"));
    check(
      "S1 the pre-upgrade worker runs with the legacy default",
      kit.lastCall("worker", "TASK-WORKER frozen")?.system.includes("LEGACY-DEFAULT worker."),
    );

    const page = await kit.openPage(await kit.webUrl(id));
    await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
    // Every text the Prompt section shows for the coordinator: block editor, block rows and the rendered read-only sections.
    const promptText = async () => {
      await page.evaluate(`document.querySelector('dialog#settings')?.open && document.querySelector('dialog#settings').close()`);
      await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
      await page.waitFor(`!!document.querySelector('dialog#settings[open] nav [data-section="prompt"]')`, "settings open");
      await page.evaluate(`document.querySelector('dialog#settings nav [data-section="prompt"]').click()`);
      await page.waitFor(`!!document.querySelector('dialog#settings .pb-row')`, "prompt blocks");
      return page.evaluate(
        `[document.querySelector('dialog#settings').innerText, ...[...document.querySelectorAll('dialog#settings textarea')].map(t => t.value)].join('\\n')`,
      );
    };
    check("S2 Settings shows the running host's built-in coordinator text", (await promptText()).includes("LEGACY-DEFAULT coordinator."));
    await page.shot("01-settings-before-upgrade", { force: true });
    const origin = await page.evaluate("performance.timeOrigin");

    // Upgrade: the host restarts on the real defaults; the tab stays open on the same address and token.
    await kit.stopHost();
    writeFileSync(promptsFile, current);
    kit.startHost();
    await kit.waitHost();
    const after = await rpc({ action: "prompts-snapshot", id });
    check(
      "S3 the restarted host serves the current built-in text",
      after.roles.every((item) => !item.default.includes("LEGACY-DEFAULT")),
    );

    const expected = Object.fromEntries(after.roles.map((item) => [item.role, item.default]));
    // F1: reopening Settings in the tab left open shows the restarted host's text.
    await page.waitFor(`document.body.dataset.ready === "1"`, "inbox still ready");
    const shown = await promptText();
    check(
      "S4 the open tab shows the current coordinator text after reopening Settings",
      !shown.includes("LEGACY-DEFAULT") && shown.includes(expected.coordinator.slice(0, 60)),
      shown.slice(0, 400),
    );
    check("S4 the tab was not reloaded", (await page.evaluate("performance.timeOrigin")) === origin);
    await page.shot("02-settings-after-upgrade", { force: true });

    // S5/F3 (the classic editor sent no override when its text equalled the default) is retired with that editor.

    // Fresh roles use the current text; the scout override and the frozen worker are untouched.
    await kit.ask(id, "MARK-WORKER fresh");
    await kit.ask(id, "MARK-SCOUT fresh");
    await kit.ask(id, "MARK-REVIEWER fresh");
    const coordinatorCall = kit.result.calls.findLast((c) => c.role === "coordinator");
    check(
      "S6 the coordinator request uses the current default",
      coordinatorCall.system.includes(expected.coordinator) && !coordinatorCall.system.includes("LEGACY-DEFAULT"),
    );
    check("S6 a new worker uses the current default", kit.lastCall("worker", "TASK-WORKER fresh")?.system.includes(expected.worker));
    check(
      "S6 a new reviewer uses the current default",
      kit.lastCall("reviewer", "TASK-REVIEWER fresh")?.system.includes(expected.reviewer),
    );
    check("S6 a new scout uses the genuine override", kit.lastCall("scout", "TASK-SCOUT fresh")?.system.includes(CUSTOM_SCOUT));
    await rpc({ action: "thread-send", id, threadId: frozen.id, text: "FROZEN-FOLLOW-UP", requestId: randomUUID() });
    await delay(300);
    await kit.settle(id);
    const followUp = kit.result.calls.findLast((c) => c.role === "worker" && c.user.includes("FROZEN-FOLLOW-UP"));
    const legacyWorker = kit.lastCall("worker", "TASK-WORKER frozen").system;
    // Owner decision (docs/prompt-blocks.md): behavior follows the saved blocks on the next idle turn; the rest of the prompt stays frozen.
    check(
      "S7 a follow-up on the pre-upgrade worker adopts the current behavior inside its frozen prompt",
      followUp?.system === legacyWorker.replace(before.roles.find((item) => item.role === "worker").default, expected.worker),
    );

    await kit.updateSettings(id, { prompts: { scout: null } });
    check("S8 Reset removes the override", !("prompts" in stored()), stored().prompts);
    check(
      "S8 the scout shows the current default again",
      (await rpc({ action: "prompts-snapshot", id })).roles.find((item) => item.role === "scout").effective === expected.scout,
    );
    writeFileSync(
      join(kit.artifacts, "storage-second-view.json"),
      JSON.stringify(
        {
          projectJsonHasPrompts: "prompts" in stored(),
          settingsPrompts: (await rpc({ action: "settings-snapshot", id })).values.prompts,
          roles: (await rpc({ action: "prompts-snapshot", id })).roles.map((item) => ({
            role: item.role,
            override: item.override,
            legacy: item.effective.includes("LEGACY-DEFAULT"),
          })),
        },
        null,
        2,
      ),
    );
  });
} finally {
  if (existsSync(core)) rmSync(core, { recursive: true, force: true });
}
