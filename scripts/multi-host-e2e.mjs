// Multi-host inbox stage 3 (scripts/remote-hosts-failures.md, 21–36): one sidebar grouped by host, the shared Decision inbox,
// answers routed to the item's own host, per-host live state, host menus and the unchanged single-host page.
import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, call as tool, say } from "./lib/e2e-kit.mjs";
import { pairHost } from "./lib/inbox-journeys.mjs";

const handler =
  (host) =>
  ({ role, user, results, msgs }) => {
    if (role !== "coordinator" || results.length) return say(`${host} done`);
    if (user.includes("Ask question")) return tool("projects_question", { question: `Which colour for ${host}?` });
    const archive = /Ask approval (\S+)/.exec(user);
    if (archive)
      return tool("owner_approval_request", { action: "archive", input: { id: archive[1] }, summary: `Archive the ${host} sandbox` });
    return say(`${host} replies to ${user.slice(0, 40)}`);
  };

const relay = await inboxRelay();
const local = await createKit("multi-host", { handler: handler("This machine") });
const remote = (name) =>
  createKit(`multi-host-${name.split(" ")[0].toLowerCase()}`, { env: { NODE_EXTRA_CA_CERTS: relay.cert }, handler: handler(name) });
try {
  await local.run(async () => {
    const url = new URL((await local.rpc({ action: "web" })).url);
    local.initRepo();
    const localProject = await local.createProject("Local notes");
    await local.ask(localProject, "Ask question");
    const home = await remote("Home Mac");
    await home.run(async () => {
      const work = await remote("Work Mac");
      await work.run(async () => {
        const hosts = {};
        for (const [kit, name, project] of [
          [home, "Home Mac", "Garden plan"],
          [work, "Work Mac", "Quarterly report"],
        ]) {
          mkdirSync(join(kit.home, "remote"), { recursive: true });
          writeFileSync(join(kit.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: name }));
          const status = await kit.rpc({ action: "remote-reload" });
          relay.allow(status.hostId);
          await kit.waitFor(async () => (await kit.rpc({ action: "remote-status" })).connection === "connected", `${name} connected`);
          kit.initRepo();
          hosts[name] = { kit, hostId: status.hostId, project: await kit.createProject(project) };
        }
        await home.ask(hosts["Home Mac"].project, "Ask question");
        const sandbox = await work.createProject("Sandbox");
        await work.ask(hosts["Work Mac"].project, `Ask approval ${sandbox}`);
        await work.waitFor(
          async () => (await work.rpc({ action: "approvals-list" })).approvals.some((item) => item.state === "pending"),
          "work approval pending",
        );

        const page = await local.openPage(url.href, { trustedSpki: relay.spki });
        await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
        for (const name of ["Home Mac", "Work Mac"]) {
          await pairHost(page, (await hosts[name].kit.rpc({ action: "remote-pair-start" })).link);
          await page.waitFor(
            `!!document.querySelector('[data-host-group="${hosts[name].hostId}"][data-state="online"]')`,
            `${name} group online`,
          );
        }
        const groupOrder = `[...document.querySelectorAll('[data-host-group]')].map((g) => g.querySelector('.host-name').textContent)`;
        await page.waitFor(`document.querySelectorAll('#decisions .decision').length === 3`, "three decisions");
        assert.deepEqual(await page.evaluate(groupOrder), ["This machine", "Home Mac", "Work Mac"]);
        await page.shot("hosts-online", { force: true });
        await page.evaluate(`document.querySelector('[data-host-menu="${hosts["Home Mac"].hostId}"]').click()`);
        await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
        await page.shot("host-menu", { force: true });
        await page.evaluate(`document.querySelector('[data-host-menu="${hosts["Home Mac"].hostId}"]').click()`);
        await page.viewport(390, 844, true);
        await page.evaluate(`document.querySelector('#app').dataset.sheet = 'list'`);
        await page.shot("hosts-online-390", { force: true });
        await page.viewport(1440, 1000);
        await page.evaluate(`document.querySelector('#app').dataset.sheet = ''`);

        await home.stopHost();
        await page.waitFor(
          `!!document.querySelector('[data-host-group="${hosts["Home Mac"].hostId}"][data-state="offline"]')`,
          "Home Mac offline",
        );
        await page.shot("host-offline", { force: true });
        await page.viewport(390, 844, true);
        await page.evaluate(`document.querySelector('#app').dataset.sheet = 'list'`);
        await page.shot("host-offline-390", { force: true });
        await page.viewport(1440, 1000);
        await page.evaluate(`document.querySelector('#app').dataset.sheet = ''`);

        await work.stopHost();
        const peer = fork(new URL("./lib/inbox-version-peer.mjs", import.meta.url), {
          env: { ...work.hostEnv, INBOX_TEST_ROOT: work.root },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        const ended = once(peer, "exit");
        try {
          await once(peer, "message");
          await page.waitFor(
            `!!document.querySelector('[data-host-group="${hosts["Work Mac"].hostId}"][data-state="needs update"]')`,
            "Work Mac needs update",
          );
          await page.shot("host-needs-update", { force: true });
          await page.viewport(390, 844, true);
          await page.evaluate(`document.querySelector('#app').dataset.sheet = 'list'`);
          await page.shot("host-needs-update-390", { force: true });
        } finally {
          peer.disconnect();
          await ended;
        }
      });
      assert.equal(work.result.status, "passed", work.result.failure);
    });
    assert.equal(home.result.status, "passed", home.result.failure);
  });
} finally {
  await relay.close();
}
