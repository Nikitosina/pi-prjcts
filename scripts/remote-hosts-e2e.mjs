import { createServer } from "node:net";
import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, call as tool, say } from "./lib/e2e-kit.mjs";

import { switchPanels, forgetAcrossViews, typeAndSend } from "./lib/inbox-journeys.mjs";
import { refusedWelcome } from "./lib/inbox-wrong-welcome.mjs";

const thread = crypto.randomUUID();
const hostile = '<strong id="remote-markup">not markup</strong>';
const client = await createKit("inbox-client", {
  handler: ({ role, user, results }) =>
    role === "coordinator" && user === "Check worker without inbox" && !results.length
      ? tool("projects_delegate", { role: "worker", task: "Report while the inbox port is occupied" })
      : say(user.includes("Work agent check") ? "Work Mac replies" : `Finished ${role}`),
});
await client.run(async () => {
  const url = new URL((await client.rpc({ action: "web" })).url);
  const headers = { authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`, "content-type": "application/json" };
  const call = async (action, input = {}) => {
    const response = await fetch(new URL("/api", url), { method: "POST", headers, body: JSON.stringify({ action, ...input }) });
    const reply = await response.json();
    assert.equal(reply.ok, true, reply.error);
    return reply.data;
  };
  assert.deepEqual(await call("api-version"), { version: 2 });
  assert.deepEqual(await call("inbox-hosts"), []);
  const entry = { hostId: "A".repeat(43), name: "Test host", relayOrigin: "https://127.0.0.1:33443" };
  await call("inbox-host-add", entry);
  assert.deepEqual(await call("inbox-hosts"), [entry]);
  const csp = async () =>
    (await fetch(url.origin)).headers
      .get("content-security-policy")
      .split("; ")
      .find((v) => v.startsWith("connect-src "));
  assert.equal(await csp(), "connect-src 'self' wss://127.0.0.1:33443");
  await client.stopHost();
  const occupied = createServer((socket) => socket.destroy());
  await new Promise((ok, fail) => occupied.once("error", fail).listen(Number(url.port), "127.0.0.1", ok));
  const bindStarted = Date.now();
  try {
    client.startHost();
    await client.waitHost();
    assert.match(await client.rejects({ action: "web" }), new RegExp(`inbox unavailable.*${url.port}.*taken`, "i"));
    client.initRepo();
    const id = await client.createProject("Only at work");
    await client.ask(id, "Check worker without inbox");
    client.check(
      "Worker ran with occupied inbox port",
      client.result.calls.some((c) => c.role === "worker"),
    );
    assert.match(await client.rejects({ action: "web" }), /taken/i);
  } finally {
    await new Promise((ok) => occupied.close(ok));
  }
  await client.waitFor(async () => !(await client.rejects({ action: "web" })), "saved inbox port recovered", {
    timeout: 45000,
    interval: 500,
  });
  assert.ok(Date.now() - bindStarted >= 28000, "port retry must back off");
  assert.equal(new URL((await client.rpc({ action: "web" })).url).origin, url.origin);
  assert.deepEqual(await call("inbox-hosts"), [entry]);
  await call("inbox-host-forget", { hostId: entry.hostId });
  assert.deepEqual(await call("inbox-hosts"), []);
  assert.equal(await csp(), "connect-src 'self'");
  await client.stopHost();
  const savedHosts = join(client.home, "inbox-hosts.json");
  writeFileSync(savedHosts, "not JSON");
  client.startHost();
  await client.waitHost();
  assert.equal(await csp(), "connect-src 'self'");
  assert.deepEqual(await call("inbox-hosts"), []);
  await client.stopHost();
  writeFileSync(savedHosts, "[]");
  client.startHost();
  await client.waitHost();
  const relay = await inboxRelay();
  try {
    const other = await createKit("inbox-remote", {
      env: { NODE_EXTRA_CA_CERTS: relay.cert },
      handler: ({ role, user, results }) =>
        role === "coordinator" && user.includes("Remote journey") && !results.length
          ? tool("projects_question", { question: "Which colour for the remote project?" })
          : say(
              user.includes("Home agent check")
                ? "Home Mac replies"
                : user.includes("Lost receipt")
                  ? "Received exactly here."
                  : `${hostile}\n\n![Remote icon](artifact:${thread}/icon.png)`,
            ),
    });
    await other.run(async () => {
      mkdirSync(join(other.home, "remote"), { recursive: true });
      writeFileSync(join(other.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
      const status = await other.rpc({ action: "remote-reload" });
      relay.allow(status.hostId);
      await other.waitFor(async () => (await other.rpc({ action: "remote-status" })).connection === "connected", "remote host connected");
      const { link } = await other.rpc({ action: "remote-pair-start" });
      other.initRepo();
      const remoteProject = await other.createProject("Only at home");
      const artifactDir = join(other.home, remoteProject, "artifacts", thread);
      mkdirSync(artifactDir, { recursive: true });
      copyFileSync("relay/bootstrap/icon-180.png", join(artifactDir, "icon.png"));
      const links = relay.browserLinks();
      const page = await client.openPage(url.href, { trustedSpki: relay.spki });
      await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
      async function addPanel() {
        await page.evaluate(
          `document.querySelector('#topbar [data-cmd="settings"]').click(); document.querySelector('nav [data-section="remote"]').click()`,
        );
        await page.waitFor(`!!document.querySelector('[data-add-host]')`, "local Add host");
      }
      await page.shot("no-hosts-before", { force: true });
      const chromeClip = { x: 0, y: 0, width: 240, height: 144, scale: 1 };
      const sidebar = async () => (await page.cdp("Page.captureScreenshot", { clip: chromeClip })).data;
      // Top-left inbox chrome from the pre-stage web/ (1e02b5b), same private project and viewport.
      const baseline = readFileSync(new URL("./fixtures/no-hosts-sidebar.png", import.meta.url)).toString("base64");
      assert.ok((await sidebar()) === baseline, "local sidebar matches pre-stage screenshot");
      assert.equal(links().length, 0);
      await addPanel();
      await page.waitFor(`!!document.querySelector('[aria-label="Host pairing link"]')`, "Add host from link", 3);
      async function addLink(link) {
        await page.evaluate(`document.querySelector('[aria-label="Host pairing link"]').focus()`);
        await page.cdp("Input.insertText", { text: link });
        const { x, y } = await page.evaluate(
          `(() => {const r = document.querySelector('[data-add-host]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await page.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await other.rpc({ action: "remote-pair-cancel" });
      await addLink(link);
      await page.waitFor(
        `document.querySelector('[data-add-host]').form.querySelector('[role=alert]').textContent.length > 0`,
        "expired pairing refused",
      );
      assert.deepEqual(await call("inbox-hosts"), [], "failed pairing must not add a host");
      assert.equal(await csp(), "connect-src 'self'");
      await addLink((await other.rpc({ action: "remote-pair-start" })).link);
      await page.waitFor(`document.body.innerText.includes('Only at home')`, "remote project tree");
      assert.equal(await page.evaluate(`location.pathname`), "/", "remote projects open in the real inbox");
      assert.ok(await page.evaluate(`!!document.querySelector('#composer-input')`));
      const inGroup = (key) => `document.querySelector('[data-host-group="${key}"]').innerText`;
      assert.ok(await page.evaluate(`${inGroup("local")}.includes('Only at work') && !${inGroup("local")}.includes('Only at home')`));
      assert.ok(await page.evaluate(`${inGroup(status.hostId)}.includes('Only at home') && !${inGroup(status.hostId)}.includes('Only at work')`));
      await page.evaluate(`document.querySelector('[data-host-group="${status.hostId}"] [data-project]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Only at home')`, "remote project selected");
      await typeAndSend(page, "#composer-input", "Remote journey");
      await typeAndSend(page, "#questions textarea", "Purple");
      await other.waitFor(
        async () => (await other.rpc({ action: "show", id: remoteProject })).inbox.some((q) => q.kind === "question" && q.result),
        "answer stored on remote",
      );
      await page.waitFor(`document.querySelector('#feed').innerText.includes(${JSON.stringify(hostile)})`, "remote markup shown literally");
      assert.equal(await page.evaluate(`!!document.querySelector('#remote-markup')`), false);
      await page.waitFor(`document.querySelector('img.media-img[src^="blob:"]')?.naturalWidth === 180`, "decoded remote artifact");
      await page.shot("remote-inbox", { force: true });
      await page.evaluate(
        `{ const d = new DataTransfer(); d.setData('text/uri-list','file:///tmp/work-path'); document.querySelector('#composer-input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d})); }`,
      );
      assert.ok(
        await page.evaluate(
          `document.querySelector('#toasts').innerText.includes('Local paths cannot be attached') && !document.querySelector('#composer-input').value`,
        ),
      );
      await refusedWelcome(page, relay, status.hostId);
      for (const kit of [client, other]) {
        const { revision } = await kit.rpc({ action: "host-agent-settings" });
        await kit.rpc({ action: "host-agent-settings", revision, patch: { model: "fake/fake-model" } });
      }
      await switchPanels(page, status.hostId);
      assert.equal((await other.rpc({ action: "ui-get" })).ui.theme, "midnight");
      assert.notEqual((await client.rpc({ action: "ui-get" })).ui.theme, "midnight");
      const channels = links();
      assert.ok(channels.length);
      for (const [socket, plain] of channels) plain.unpipe(socket);
      await typeAndSend(page, "#composer-input", "Lost receipt");
      await other.waitFor(() => other.result.calls.some((c) => c.user.includes("Lost receipt")), "write reached remote host");
      for (const [socket] of channels) socket.destroy();
      await page.waitFor(
        `document.body.innerText.toLowerCase().includes('result unknown, check after reconnecting')`,
        "uncertain write notice",
      );
      await page.shot("uncertain-write", { force: true });
      await page.waitFor(
        `document.querySelector('#feed').innerText.includes('Received exactly here.') && !document.querySelector('[data-delivery=unconfirmed]')`,
        "read back after reconnect",
      );
      // Chrome allows six HTTP/1.1 connections per origin: views of the remote project keep only the host stream on the local host.
      await page.evaluate(`document.querySelector('[data-host-group="${status.hostId}"] [data-project]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Only at home')`, "remote project selected again");
      await forgetAcrossViews(page, status.hostId);
      assert.deepEqual(await call("inbox-hosts"), []);
      await page.shot("no-hosts-after", { force: true });
      assert.ok((await sidebar()) === baseline, "local sidebar restored after Forget");
      await addPanel();
      await addLink((await other.rpc({ action: "remote-pair-start" })).link);
      await page.waitFor(`document.body.innerText.includes('Only at home')`, "paired again");
      await other.stopHost();
      await page.waitFor(`document.querySelector('[data-host-group]:not([data-host-group=local])')?.dataset.state === 'offline'`, "remote offline");
      await page.shot("remote-offline", { force: true });
      const peer = fork(new URL("./lib/inbox-version-peer.mjs", import.meta.url), {
        env: { ...other.hostEnv, INBOX_TEST_ROOT: other.root },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const ended = once(peer, "exit");
      try {
        await once(peer, "message");
        let seq = 0;
        async function control(op, value) {
          const reply = once(peer, "message");
          peer.send({ id: ++seq, op, value });
          const [data] = await reply;
          assert.equal(data.error, undefined);
          return data;
        }
        const statusIs = (s) => `document.querySelector('[data-host-group]:not([data-host-group=local])')?.dataset.state === ${JSON.stringify(s)}`;
        await page.waitFor(statusIs("needs update"), "incompatible host");
        await page.shot("needs-update", { force: true });
        assert.deepEqual((await control("status")).requests, ["api-version"]);
        await control("restart", null);
        await page.reload();
        await page.waitFor(statusIs("needs update"), "missing version");
        assert.deepEqual((await control("status")).requests, ["api-version", "api-version"]);
        await control("restart", 2);
        await page.reload();
        await page.waitFor(statusIs("online"), "compatible host");
        await page.evaluate(
          `(async()=>{ const {localHost,remoteHost}=await import('/api.js'); window.probe=await remoteHost((await localHost.call('inbox-hosts'))[0]); window.readResult=probe.call('search',{query:'retry probe'}).catch(e=>e.message); window.writeResult=probe.call('message',{text:'no replay'}).catch(e=>e.message); })()`,
        );
        await other.waitFor(async () => {
          const r = await control("status");
          return r.requests.includes("search") && r.requests.includes("message");
        }, "both probes in flight");
        await control("stop");
        await page.waitFor(statusIs("offline"), "lost replies");
        assert.match(await page.evaluate("writeResult"), /result unknown, check after reconnecting/i);
        await control("restart", 2);
        await other.waitFor(
          async () => (await control("status")).requests.filter((r) => r === "search").length === 2,
          "first replay in flight",
        );
        await control("stop");
        await page.waitFor(statusIs("offline"), "lost replay");
        await control("restart", 2);
        assert.equal(await page.evaluate("readResult"), "retry probe");
        const requests = (await control("status")).requests;
        assert.equal(requests.filter((r) => r === "message").length, 1);
        assert.equal(requests.filter((r) => r === "search").length, 3);
        await page.evaluate(`(async()=>{window.large = await probe.authorizedFetch('/large');})()`);
        assert.equal((await page.evaluate(`probe.call('list')`)).length, 0);
        assert.match(await page.evaluate(`probe.authorizedFetch('/changes?project=host').then(r=>r.text())`), /sync/);
        assert.equal(await page.evaluate(`large.arrayBuffer().then(b=>b.byteLength)`), 8 << 20);
      } finally {
        peer.disconnect();
        await ended;
      }
      other.startHost();
      await other.waitHost();
      await page.waitFor(`document.querySelector('[data-host-group]:not([data-host-group=local])')?.dataset.state === 'online'`, "real host reconnected");
      const deviceId = await page.evaluate(
        `(async()=> (await (await import('/inbox-wire/store.js')).get('inbox-device:${status.hostId}')).id)()`,
      );
      await other.rpc({ action: "remote-revoke", deviceId, confirm: deviceId });
      await page.waitFor(`document.querySelector('[data-host-group]:not([data-host-group=local])')?.dataset.state === 'revoked'`, "revoked device stopped");
      await page.shot("revoked", { force: true });
    });
    assert.equal(other.result.status, "passed", other.result.failure);
  } finally {
    await relay.close();
  }
});
