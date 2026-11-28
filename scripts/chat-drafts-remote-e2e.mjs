// Browser E2E: composer drafts of a remote host live under that host's storage prefix, apart from the local ones, and go with Forget host or a
// revoked device (chat-drafts-failures.md D21-D23). Two real hosts, a local relay, one Chrome.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, say } from "./lib/e2e-kit.mjs";
import { pairHost } from "./lib/inbox-journeys.mjs";

const soft = process.env.E2E_SOFT === "1";
const relay = await inboxRelay();
const handler = ({ role, user }) =>
  role === "coordinator" && !user.startsWith("[Durable work") ? say(`ACK ${user.slice(0, 80)}`) : undefined;
const local = await createKit("chat-drafts-remote", { handler });
const remote = await createKit("chat-drafts-remote-home", { env: { NODE_EXTRA_CA_CERTS: relay.cert }, handler });
const check = (label, ok, detail) => {
  if (!soft) return assert.ok(ok, `${label}: ${JSON.stringify(detail ?? null).slice(0, 500)}`);
  console.log(`${ok ? "GREEN" : "RED"} ${label}`);
};
try {
  await local.run(async () => {
    const url = new URL((await local.rpc({ action: "web" })).url);
    local.initRepo();
    const localProject = await local.createProject("Local drafts");
    await local.ask(localProject, "seed local");
    await remote.run(async () => {
      mkdirSync(join(remote.home, "remote"), { recursive: true });
      writeFileSync(join(remote.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
      const status = await remote.rpc({ action: "remote-reload" });
      const hostId = status.hostId;
      relay.allow(hostId);
      await remote.waitFor(async () => (await remote.rpc({ action: "remote-status" })).connection === "connected", "remote connected");
      remote.initRepo();
      const remoteProject = await remote.createProject("Remote drafts");
      await remote.ask(remoteProject, "seed remote");

      const page = await local.openPage(url.href, { trustedSpki: relay.spki });
      const q = (expression) => page.evaluate(expression);
      await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
      const type = async (text) => {
        await q(`document.querySelector('#composer-input').focus()`);
        await page.cdp("Input.insertText", { text });
        await local.delay(100);
      };
      const composer = () => q(`document.querySelector('#composer-input').value`);
      const stored = async (key) => JSON.parse((await q(`localStorage.getItem(${JSON.stringify(key)})`)) ?? "null")?.text ?? null;
      const remoteKey = `pi-host:${hostId}:pi-draft:${remoteProject}:main`,
        localKey = `pi-draft:${localProject}:main`;
      const hostDrafts = () => q(`Object.keys(localStorage).filter((k) => k.startsWith("pi-host:${hostId}:pi-draft:"))`);
      // A pending-send handle of each host, as a send that never settled leaves it.
      const plantHandles = () =>
        q(
          `(() => { const put = (id, projectId, hostPrefix) => localStorage.setItem("pi-pending-send:" + id, JSON.stringify({ id, projectId, chatId: "main", text: "unsettled " + id, hostPrefix })); put("remote-handle", ${JSON.stringify(remoteProject)}, "pi-host:${hostId}:"); put("local-handle", ${JSON.stringify(localProject)}, ""); })()`,
        );
      const handles = () => q(`Object.keys(localStorage).filter((k) => k.startsWith("pi-pending-send:")).sort()`);
      const pair = async () => {
        await pairHost(page, (await remote.rpc({ action: "remote-pair-start" })).link);
        await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]')?.dataset.state === "online"`, "remote online");
        await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes("Remote drafts")`, "remote project");
      };
      const openProject = async (group, name, seed) => {
        await q(`document.querySelector('[data-host-group="${group}"] [data-project]').click()`);
        await page.waitFor(`document.querySelector('#crumbs').innerText.includes(${JSON.stringify(name)})`, `${name} selected`);
        await page.waitFor(`document.querySelector('#feed').innerText.includes(${JSON.stringify(seed)})`, `${name} transcript`);
      };
      const guarded = async (name, body) => {
        if (!soft) return body();
        try {
          await body();
        } catch (error) {
          console.log(`RED ${name}: ${String(error.message).split("\n")[0].slice(0, 200)}`);
        }
      };

      await pair();
      await openProject("local", "Local drafts", "seed local");
      await type("local draft MARK-L");
      await openProject(hostId, "Remote drafts", "seed remote");
      await guarded("remote host", async () => {
        check("D21 a remote project starts with an empty composer", (await composer()) === "", await composer());
        await type("remote draft MARK-R");
        check(
          "D21 each host's draft sits under its own key",
          (await stored(localKey)) === "local draft MARK-L" && (await stored(remoteKey)) === "remote draft MARK-R",
          { local: await stored(localKey), remote: await stored(remoteKey) },
        );
        await openProject("local", "Local drafts", "seed local");
        check("D21 the local chat shows its own draft", (await composer()) === "local draft MARK-L", await composer());
        await page.shot("remote-switch-local", { force: true });
        await openProject(hostId, "Remote drafts", "seed remote");
        check("D21 the remote chat shows its own draft", (await composer()) === "remote draft MARK-R", await composer());
        await page.shot("remote-switch-remote", { force: true });
      });

      // D28: the failed-turn Retry of a remote chat names the remote host as the send's owner.
      await guarded("failed-turn retry", async () => {
        const failedId = randomUUID();
        mkdirSync(join(remote.home, remoteProject, "inbox"), { recursive: true });
        writeFileSync(
          join(remote.home, remoteProject, "inbox", `${failedId}.json`),
          JSON.stringify({
            id: failedId,
            text: "turn card MARK-D28",
            state: "failed",
            error: "provider exploded",
            at: new Date(Date.now() + 60000).toISOString(),
            admitted: true,
          }),
        );
        await openProject("local", "Local drafts", "seed local");
        await openProject(hostId, "Remote drafts", "seed remote");
        await page.waitFor(`!!document.querySelector('[data-retry-job="${failedId}"]')`, "turn card Retry");
        await q(
          `(() => { window.__handles = []; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.startsWith("pi-pending-send:")) window.__handles.push(JSON.parse(value)); return set.call(this, key, value); }; })()`,
        );
        await q(`document.querySelector('[data-retry-job="${failedId}"]').click()`);
        await page.waitFor(`window.__handles.length > 0`, "pending handle stored");
        const handle = await q(`window.__handles[0]`);
        check("D28 the failed-turn Retry send carries its owning host", handle.hostPrefix === `pi-host:${hostId}:`, handle);
        await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK turn card MARK-D28")`, "retry answered");
      });

      // D22: Forget host removes that host's drafts only.
      await guarded("forget", async () => {
        await plantHandles();
        // An input still waiting for its turn when the host is forgotten must not bring the draft back.
        await q(
          `void navigator.locks.request(${JSON.stringify(`pi-draft-lock:${remoteKey}`)}, () => new Promise((end) => { window.__unlockRemote = end; }))`,
        );
        await page.waitFor(`!!window.__unlockRemote`, "remote draft lock held");
        await type(" queued MARK-Q");
        await q(`window.confirm = () => true; document.querySelector('[data-host-menu="${hostId}"]').click()`);
        await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
        await q(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith("Forget host")).click()`);
        await page.waitFor(`!document.querySelector('[data-host-group="${hostId}"]')`, "group gone");
        await q(`window.__unlockRemote()`);
        await local.delay(300);
        check(
          "D22 Forget host removes the host's drafts and keeps the local one",
          (await hostDrafts()).length === 0 && (await stored(localKey)) === "local draft MARK-L",
          { left: await hostDrafts(), local: await stored(localKey) },
        );
        check(
          "D22 Forget host removes the host's pending-send handles and keeps the local one",
          JSON.stringify(await handles()) === JSON.stringify(["pi-pending-send:local-handle"]),
          await handles(),
        );
      });

      // D23: a revoked device loses the host's drafts too.
      await guarded("revoked", async () => {
        await pair();
        await openProject(hostId, "Remote drafts", "seed remote");
        await type("remote again MARK-R2");
        await page.waitFor(`localStorage.getItem(${JSON.stringify(remoteKey)}) !== null`, "remote draft stored");
        const before = await stored(remoteKey);
        await plantHandles();
        const deviceId = await q(`(async()=> (await (await import('/inbox-wire/store.js')).get('inbox-device:${hostId}')).id)()`);
        await remote.rpc({ action: "remote-revoke", deviceId, confirm: deviceId });
        await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]')?.dataset.state === "revoked"`, "revoked");
        check(
          "D23 a revoked device's drafts are removed, the local one stays",
          before === "remote again MARK-R2" && (await hostDrafts()).length === 0 && (await stored(localKey)) === "local draft MARK-L",
          { before, left: await hostDrafts() },
        );
        check(
          "D23 a revoked device's pending-send handles are removed, the local one stays",
          JSON.stringify(await handles()) === JSON.stringify(["pi-pending-send:local-handle"]),
          await handles(),
        );
      });
      local.result.httpErrors = local.result.httpErrors.filter((e) => !e.url.endsWith("/changes"));
    });
    assert.equal(remote.result.status, "passed", remote.result.failure);
  });
} finally {
  await relay.close();
}
