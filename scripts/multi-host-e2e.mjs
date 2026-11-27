// Multi-host inbox stage 3 (scripts/remote-hosts-failures.md, 21–37): one sidebar grouped by host, the shared Decision inbox,
// answers routed to the item's own host, per-host live state, host menus and the unchanged single-host page.
import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, call as tool, say } from "./lib/e2e-kit.mjs";
import { pairHost, typeAndSend } from "./lib/inbox-journeys.mjs";

const hostile = '<strong id="remote-markup">Markup</strong>';

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
        await work.createProject(hostile);
        await work.ask(hosts["Work Mac"].project, `Ask approval ${sandbox}`);
        await work.waitFor(
          async () => (await work.rpc({ action: "approvals-list" })).approvals.some((item) => item.state === "pending"),
          "work approval pending",
        );

        const page = await local.openPage(url.href, { trustedSpki: relay.spki });
        const links = relay.browserLinks();
        await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
        const q = (expression) => page.evaluate(expression);
        const ids = { local: "local", home: hosts["Home Mac"].hostId, work: hosts["Work Mac"].hostId };
        const group = (key, state) => `!!document.querySelector('[data-host-group="${key}"][data-state="${state}"]')`;
        const decisions = () => q(`[...document.querySelectorAll('#decisions .decision')].map((d) => d.innerText.replace(/\\s+/g, ' '))`);
        const waitDecisions = (count, label) =>
          page.waitFor(`document.querySelectorAll('#decisions .decision').length === ${count}`, label);
        const groupText = (key) => `document.querySelector('[data-host-group="${key}"]').innerText`;
        const press = (selector) => q(`document.querySelector(${JSON.stringify(selector)}).click()`);
        const menuItem = async (key, label) => {
          await press(`[data-host-menu="${key}"]`);
          await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
          await q(
            `[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`,
          );
        };
        const type = async (selector, text) => {
          await q(`document.querySelector(${JSON.stringify(selector)}).focus()`);
          await page.cdp("Input.insertText", { text });
        };

        // 36: no remote hosts, the page is the pre-stage page and opens no tunnel
        assert.equal(await q(`document.querySelectorAll('[data-host-group]').length`), 0);
        assert.equal(await q(`document.querySelector('#decisions').hidden`), true);
        assert.equal(await q(`document.querySelector('.list-head').hidden`), false);
        assert.equal(links().length, 0);

        for (const name of ["Home Mac", "Work Mac"]) {
          await pairHost(page, (await hosts[name].kit.rpc({ action: "remote-pair-start" })).link);
          await page.waitFor(group(hosts[name].hostId, "online"), `${name} group online`);
        }
        // 24: order and one host per group; 28: markup stays text; 36's counterpart: the top button goes
        assert.deepEqual(await q(`[...document.querySelectorAll('[data-host-group] .host-name')].map((n) => n.textContent)`), [
          "This machine",
          "Home Mac",
          "Work Mac",
        ]);
        await page.waitFor(
          `${groupText(ids.work)}.includes('Quarterly report') && ${groupText(ids.work)}.includes(${JSON.stringify(hostile)})`,
          "work projects",
        );
        assert.equal(await q(`!!document.querySelector('#remote-markup')`), false);
        assert.ok(!(await q(`${groupText(ids.home)}.includes('Quarterly report')`)), "no project in two groups");
        assert.equal(await q(`document.querySelector('.list-head').hidden`), true);
        assert.equal(await q(`document.querySelector('#remote-hosts').hidden`), true);
        assert.equal(await q(`document.querySelector('#host-connection, #inbox-host')`), null, "34: no global switcher");

        // 29, 30: three items, each with its own host chip
        await waitDecisions(3, "three decisions");
        const tagged = await q(
          `[...document.querySelectorAll('#decisions .decision')].map((d) => d.querySelector('.host-tag').textContent)`,
        );
        assert.deepEqual(tagged, ["This machine", "Home Mac", "Work Mac"]);
        assert.match(await q(`document.querySelector('#status-pill').innerText`), /3 needs you/);
        await page.shot("hosts-online", { force: true });
        await press(`[data-host-menu="${ids.home}"]`);
        await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
        await page.shot("host-menu", { force: true });
        await press(`[data-host-menu="${ids.home}"]`);
        await page.viewport(390, 844, true);
        await q(`document.querySelector('#app').dataset.sheet = 'list'`);
        await page.shot("hosts-online-390", { force: true });
        await page.viewport(1440, 1000);
        await q(`document.querySelector('#app').dataset.sheet = ''`);

        // 21, 22, 29: a question opens in its chat on its own host, and its answer reaches that host only
        await q(`document.querySelector('#decisions [data-decision-host="${ids.home}"]').click()`);
        await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Garden plan')`, "Home chat opened");
        assert.match(await q(`document.querySelector('#crumbs').innerText`), /Home Mac/);
        await typeAndSend(page, "#questions textarea", "Blue");
        await home.waitFor(
          async () =>
            (await home.rpc({ action: "show", id: hosts["Home Mac"].project })).inbox.some((i) => i.kind === "question" && i.result),
          "answer stored on Home Mac",
        );
        assert.ok(
          !(await local.rpc({ action: "show", id: localProject })).inbox.some((i) => i.kind === "question" && i.result),
          "local question untouched",
        );
        assert.ok(
          !(await work.rpc({ action: "show", id: hosts["Work Mac"].project })).inbox.some((i) => i.kind === "question" && i.result),
        );
        await waitDecisions(2, "answered question left the inbox");

        // 29: an approval is decided on its host, once
        await q(`document.querySelector('#decisions [data-approval] [data-decide=approve]').click()`);
        await work.waitFor(
          async () => (await work.rpc({ action: "list" })).find((p) => p.id === sandbox)?.archived,
          "Work Mac archived its sandbox",
        );
        assert.equal((await work.rpc({ action: "approvals-list" })).approvals.filter((a) => a.state === "done").length, 1);
        await waitDecisions(1, "approval left the inbox");

        // 31, 30: a new question on a remote host shows without a reload
        await work.ask(hosts["Work Mac"].project, "Ask question");
        await waitDecisions(2, "new Work Mac question");
        assert.ok((await decisions()).some((t) => t.includes("Which colour for Work Mac?") && t.includes("Work Mac")));

        // 37: New project goes to the group's own host
        async function createOn(key, kit, name) {
          await menuItem(key, "New project on");
          await page.waitFor(`document.querySelector('#new-project').open`, "new project dialog");
          assert.match(await q(`document.querySelector('#np-title').textContent`), key === "local" ? /This machine/ : /Mac/);
          await type("#new-project [name=name]", name);
          await type("#new-project [name=cwd]", kit.workspace);
          await q(`document.querySelector('#new-project form').requestSubmit()`);
          await page.waitFor(
            `!document.querySelector('#new-project').open && ${groupText(key)}.includes(${JSON.stringify(name)})`,
            `${name} listed in its group`,
          );
          assert.ok((await kit.rpc({ action: "list" })).some((p) => p.name === name));
        }
        await createOn(ids.home, home, "Made on Home");
        assert.ok(!(await local.rpc({ action: "list" })).some((p) => p.name === "Made on Home"));
        assert.ok(!(await work.rpc({ action: "list" })).some((p) => p.name === "Made on Home"));
        await createOn("local", local, "Made here");

        // 23, 34: Settings and the Host agent open for the group's host, with a switcher in their own header
        await menuItem(ids.work, "Settings");
        await page.waitFor(
          `document.body.dataset.ready === '1' && document.querySelector('#settings').open && !!document.querySelector('#settings select.host-picker')`,
          "Work Mac Settings",
        );
        assert.equal(await q(`document.querySelector('#settings select.host-picker').value`), ids.work);
        await page.shot("settings-switcher", { force: true });
        await page.navigate(url.href);
        await page.waitFor(`document.body.dataset.ready === '1' && ${groupText(ids.work)}.includes('Quarterly report')`, "inbox again");

        // 26, 27, 32: offline collapses the group and drops its items; back online restores them without a reload
        await home.ask(hosts["Home Mac"].project, "Ask question");
        await page.waitFor(`document.querySelectorAll('#decisions .decision').length === 3`, "Home question back");
        await home.stopHost();
        await page.waitFor(group(ids.home, "offline"), "Home Mac offline");
        assert.ok(!(await q(`${groupText(ids.home)}.includes('Garden plan')`)));
        assert.ok(!(await decisions()).some((t) => t.includes("Home Mac")));
        assert.match(await q(`document.querySelector('#status-pill').innerText`), /2 needs you/);
        await page.shot("host-offline", { force: true });
        await page.viewport(390, 844, true);
        await q(`document.querySelector('#app').dataset.sheet = 'list'`);
        await page.shot("host-offline-390", { force: true });
        await page.viewport(1440, 1000);
        await q(`document.querySelector('#app').dataset.sheet = ''`);
        home.startHost();
        await home.waitHost();
        await page.waitFor(group(ids.home, "online"), "Home Mac back online");
        await page.waitFor(
          `${groupText(ids.home)}.includes('Garden plan') && document.querySelectorAll('#decisions .decision').length === 3`,
          "Home Mac items back",
        );

        // 25, 26, 33: a host that needs an update collapses; an older host without question titles shows a count
        await work.stopHost();
        const peer = fork(new URL("./lib/inbox-version-peer.mjs", import.meta.url), {
          env: { ...work.hostEnv, INBOX_TEST_ROOT: work.root },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        const ended = once(peer, "exit");
        try {
          await once(peer, "message");
          let seq = 0;
          const control = async (op, value) => {
            const reply = once(peer, "message");
            peer.send({ id: ++seq, op, value });
            const [data] = await reply;
            assert.equal(data.error, undefined);
          };
          await page.waitFor(group(ids.work, "needs update"), "Work Mac needs update");
          assert.ok(!(await q(`${groupText(ids.work)}.includes('Quarterly report')`)));
          assert.ok(!(await decisions()).some((t) => t.includes("Work Mac")));
          await page.shot("host-needs-update", { force: true });
          await page.viewport(390, 844, true);
          await q(`document.querySelector('#app').dataset.sheet = 'list'`);
          await page.shot("host-needs-update-390", { force: true });
          await page.viewport(1440, 1000);
          await q(`document.querySelector('#app').dataset.sheet = ''`);
          await control("projects", [{ id: "legacy-1", name: "Legacy project", cwd: "/tmp", notice: { questions: 2 }, activity: {} }]);
          await control("restart", 2);
          await page.reload(); // "needs update" ends the tunnel for good, as in remote-hosts-e2e
          await page.waitFor(group(ids.work, "online"), "older host online");
          await page.waitFor(`${groupText(ids.work)}.includes('Legacy project')`, "older host project");
          assert.ok((await decisions()).some((t) => t.includes("2 questions") && t.includes("Work Mac")));

          // 35: Forget host from the group menu removes the group and its items at once
          await q(`window.confirm = () => true`);
          await menuItem(ids.work, "Forget host");
          await page.waitFor(`!document.querySelector('[data-host-group="${ids.work}"]')`, "Work Mac group gone");
          assert.ok(!(await decisions()).some((t) => t.includes("Work Mac")));
          assert.equal(await q(`document.querySelectorAll('[data-host-group]').length`), 2);
          assert.ok(!(await q(`document.querySelector('#crumbs').innerText.includes('Legacy')`)));
        } finally {
          peer.disconnect();
          await ended;
        }
        await page.shot("after-forget", { force: true });
      });
      assert.equal(work.result.status, "passed", work.result.failure);
    });
    assert.equal(home.result.status, "passed", home.result.failure);
  });
} finally {
  await relay.close();
}
