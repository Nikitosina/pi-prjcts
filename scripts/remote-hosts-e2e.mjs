import { createServer } from "node:net";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit } from "./lib/e2e-kit.mjs";

const client = await createKit("inbox-client");
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
    assert.deepEqual(await client.rpc({ action: "list" }), []);
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
  const relay = await inboxRelay();
  try {
    const other = await createKit("inbox-remote", { env: { NODE_EXTRA_CA_CERTS: relay.cert } });
    await other.run(async () => {
      mkdirSync(join(other.home, "remote"), { recursive: true });
      writeFileSync(join(other.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
      const status = await other.rpc({ action: "remote-reload" });
      relay.allow(status.hostId);
      await other.waitFor(async () => (await other.rpc({ action: "remote-status" })).connection === "connected", "remote host connected");
      const { link } = await other.rpc({ action: "remote-pair-start" });
      other.initRepo();
      await other.createProject("Only at home");
      await call("inbox-host-add", { hostId: status.hostId, name: "Home Mac", relayOrigin: relay.origin });
      const page = await client.openPage(url.href, { trustedSpki: relay.spki });
      const projects = await page.evaluate(
        `(async () => { const api = await import('/api.js'); const remote = await api.pairHost(${JSON.stringify(link)}); return (await remote.call('list')).map(p => p.name); })()`,
      );
      assert.deepEqual(projects, ["Only at home"]);
    });
    assert.equal(other.result.status, "passed", other.result.failure);
  } finally {
    await relay.close();
  }
});
