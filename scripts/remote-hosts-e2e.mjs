import { createServer } from "node:net";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, call as tool, say } from "./lib/e2e-kit.mjs";

const client = await createKit("inbox-client", {
  handler: ({ role, user, results }) =>
    role === "coordinator" && user === "Check worker without inbox" && !results.length
      ? tool("projects_delegate", { role: "worker", task: "Report while the inbox port is occupied" })
      : say(`Finished ${role}`),
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
  assert.deepEqual(await call("api-version"), { version: 1 });
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
          : say("Noted on Home Mac."),
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
      const page = await client.openPage(url.href, { trustedSpki: relay.spki });
      await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
      await page.evaluate(
        `document.querySelector('[data-cmd="settings"]').click(); document.querySelector('nav [data-section="remote"]').click()`,
      );
      await page.waitFor(`!!document.querySelector('[aria-label="Host pairing link"]')`, "Add host from link", 3);
      await page.evaluate(`document.querySelector('[aria-label="Host pairing link"]').focus()`);
      await page.cdp("Input.insertText", { text: link });
      const { x, y } = await page.evaluate(
        `(() => {const r = document.querySelector('[data-add-host]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      );
      for (const type of ["mousePressed", "mouseReleased"])
        await page.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      await page.waitFor(`document.body.innerText.includes('Only at home')`, "remote project tree");
      assert.ok(!(await page.evaluate(`document.body.innerText.includes('Only at work')`)));
      async function submit(label, text) {
        const field = `document.querySelector('textarea[aria-label="${label}"]')`;
        await page.waitFor(`!!${field}`, label);
        await page.evaluate(`${field}.focus()`);
        await page.cdp("Input.insertText", { text });
        await page.evaluate(`${field}.form.requestSubmit()`);
      }
      await submit("Send message", "Remote journey");
      await submit("Answer", "Purple");
      await other.waitFor(
        async () => (await other.rpc({ action: "show", id: remoteProject })).inbox.some((q) => q.kind === "question" && q.result),
        "answer stored on remote",
      );
      await page.shot("remote-inbox", { force: true });
      await other.stopHost();
      await page.waitFor(`document.querySelector('#connection')?.textContent === 'offline'`, "remote offline");
      await page.shot("remote-offline", { force: true });
    });
    assert.equal(other.result.status, "passed", other.result.failure);
  } finally {
    await relay.close();
  }
});
