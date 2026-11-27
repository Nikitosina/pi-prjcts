// Multi-host inbox stage 4, third review (scripts/remote-hosts-failures.md, 74, 75): the composer draft belongs to one host, project and chat,
// survives a reload, is cleared by sending, archiving a chat, Forget host; the Host agent keeps one draft per host; a recovery handle without
// a host ID is quarantined instead of being routed to the local host.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, say } from "./lib/e2e-kit.mjs";
import { pairHost } from "./lib/inbox-journeys.mjs";

const relay = await inboxRelay();
const local = await createKit("chat-drafts", { handler: () => say("Local reply") });
const remote = await createKit("chat-drafts-remote", { env: { NODE_EXTRA_CA_CERTS: relay.cert }, handler: () => say("Remote reply") });
try {
  await local.run(async () => {
    const url = new URL((await local.rpc({ action: "web" })).url);
    local.initRepo();
    const alpha = await local.createProject("Alpha");
    const beta = await local.createProject("Beta");
    const side = await local.rpc({ action: "chat-create", id: alpha, title: "Side chat" });
    const sideId = side.id ?? side.chat?.id ?? side.chatId;
    assert.ok(sideId);
    await remote.run(async () => {
      mkdirSync(join(remote.home, "remote"), { recursive: true });
      writeFileSync(join(remote.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
      const status = await remote.rpc({ action: "remote-reload" });
      relay.allow(status.hostId);
      await remote.waitFor(async () => (await remote.rpc({ action: "remote-status" })).connection === "connected", "Home Mac connected");
      remote.initRepo();
      const gamma = await remote.createProject("Gamma");
      const hostId = status.hostId;

      const page = await local.openPage(url.href, { trustedSpki: relay.spki });
      await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
      const q = (expression) => page.evaluate(expression);
      const composer = `document.querySelector('#composer-input')`;
      const type = async (text) => {
        await page.waitFor(`!${composer}.disabled`, "composer enabled");
        await q(`${composer}.focus(); ${composer}.select()`);
        await page.cdp("Input.insertText", { text });
        await q(`${composer}.dispatchEvent(new Event('input', { bubbles: true }))`);
      };
      const open = async (project, chat = "main", hostScoped = false) => {
        await q(
          `import('/state.js').then(({ emit }) => emit('select-request', { projectId: ${JSON.stringify(project)}, chatId: ${JSON.stringify(chat)}${hostScoped ? ", host: undefined" : ""} }))`,
        );
        await page.waitFor(
          `(async () => { const { state } = await import('/state.js'); return state.projectId === ${JSON.stringify(project)} && state.chatId === ${JSON.stringify(chat)} && !!state.view; })()`,
          `opened ${project}/${chat}`,
        );
      };
      const draft = () => q(`${composer}.value`);

      await pairHost(page, (await remote.rpc({ action: "remote-pair-start" })).link);
      await page.waitFor(`!!document.querySelector('[data-host-group="${hostId}"][data-state="online"]')`, "Home Mac online");
      await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Gamma')`, "remote project listed");

      // 74: one draft per host, project and chat, restored when its chat returns
      await open(alpha);
      await type("draft alpha main");
      await open(alpha, sideId);
      assert.equal(await draft(), "", "74: another chat of the project starts empty");
      await type("draft alpha side");
      await open(beta);
      assert.equal(await draft(), "", "74: another project starts empty");
      await type("draft beta");
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${gamma}"]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Gamma')`, "remote project selected");
      await page.waitFor(`!document.querySelector('#composer-input').disabled`, "remote composer ready");
      assert.equal(await draft(), "", "74: another host starts empty");
      await type("draft gamma");
      await open(alpha);
      assert.equal(await draft(), "draft alpha main", "74: the chat's own draft is back");
      await open(alpha, sideId);
      assert.equal(await draft(), "draft alpha side");
      await open(beta);
      assert.equal(await draft(), "draft beta");

      // 74: a reload keeps every draft
      await page.reload();
      await page.waitFor(`document.body.dataset.ready === '1'`, "ready after reload");
      await page.waitFor(`!!document.querySelector('[data-host-group="${hostId}"][data-state="online"]')`, "host online after reload");
      await page.waitFor(
        `document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Gamma')`,
        "remote project after reload",
      );
      await open(alpha);
      assert.equal(await draft(), "draft alpha main", "74: drafts survive a reload");
      await open(alpha, sideId);
      assert.equal(await draft(), "draft alpha side");
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${gamma}"]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Gamma')`, "remote project again");
      assert.equal(await draft(), "draft gamma", "74: a remote chat's draft survives a reload");

      // 74: sending clears only that chat's draft
      await open(beta);
      await q(`${composer}.form.requestSubmit()`);
      await page.waitFor(`document.querySelector('#feed').innerText.includes('Local reply')`, "reply in Beta");
      assert.equal(await draft(), "", "74: sending cleared the draft");
      await open(alpha);
      assert.equal(await draft(), "draft alpha main", "74: the other chats keep theirs");

      // 74: archiving a chat drops its draft
      assert.ok(
        await q(`Object.keys(localStorage).some((key) => key.includes(${JSON.stringify(sideId)}))`),
        "the side chat's draft is stored",
      );
      await local.rpc({ action: "chat-update", id: alpha, chatId: sideId, archived: true });
      await page.waitFor(`!document.querySelector('[data-project-id="${alpha}"][data-chat="${sideId}"]')`, "archived chat leaves the tree");
      await page.waitFor(
        `!Object.keys(localStorage).some((key) => key.includes(${JSON.stringify(sideId)}))`,
        "74: the archived chat's draft is gone",
      );

      // 74: the Host agent composer keeps one draft per host
      await q(
        `(() => { const t = document.querySelector('#ha-composer textarea'); t.value = 'host agent draft'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await page.reload();
      await page.waitFor(`document.body.dataset.ready === '1'`, "ready after the second reload");
      assert.equal(
        await q(`document.querySelector('#ha-composer textarea').value`),
        "host agent draft",
        "74: the Host agent draft survives a reload",
      );
      await q(`location.replace(location.pathname + '?host=${hostId}')`);
      await page.waitFor(
        `document.body.dataset.ready === '1' && new URLSearchParams(location.search).get('host') === '${hostId}'`,
        "remote admin page",
      );
      assert.equal(await q(`document.querySelector('#ha-composer textarea').value`), "", "74: another host's Host agent has its own draft");
      await q(`location.replace(location.pathname)`);
      await page.waitFor(`document.body.dataset.ready === '1' && !new URLSearchParams(location.search).has('host')`, "local page");

      // 75: a recovery handle without a host ID is never routed to the local host
      const handleId = crypto.randomUUID();
      await q(
        `localStorage.setItem('pi-pending-send:${handleId}', JSON.stringify({ id: '${handleId}', projectId: '${alpha}', chatId: 'main', text: 'Handle of an unknown host' }))`,
      );
      await page.reload();
      await page.waitFor(`document.body.dataset.ready === '1'`, "ready after the handle");
      await open(alpha);
      assert.equal(
        await q(`document.querySelector('#feed').innerText.includes('Handle of an unknown host')`),
        false,
        "75: not shown as local",
      );
      assert.equal(await q(`localStorage.getItem('pi-pending-send:${handleId}')`), null, "75: not kept as a live handle");
      await q(`localStorage.removeItem('pi-pending-sends')`);

      // 74: Forget host clears that host's drafts
      assert.ok(await q(`Object.keys(localStorage).some((key) => key.includes('${hostId}'))`), "the remote draft is stored under the host");
      await q(`window.confirm = () => true`);
      await q(`document.querySelector('[data-host-menu="${hostId}"]').click()`);
      await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
      await q(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith('Forget')).click()`);
      await page.waitFor(`!document.querySelector('[data-host-group="${hostId}"]')`, "host forgotten");
      assert.equal(
        await q(`Object.keys(localStorage).some((key) => key.includes('${hostId}'))`),
        false,
        "74: Forget host cleared its drafts",
      );
      await open(alpha);
      assert.equal(await draft(), "draft alpha main", "74: other hosts keep their drafts");
      local.result.errors = local.result.errors.filter((error) => error !== "WebSocket is already in CLOSING or CLOSED state.");
    });
    assert.equal(remote.result.status, "passed", remote.result.failure);
    local.result.httpErrors = local.result.httpErrors.filter((e) => !e.url.endsWith("/changes"));
  });
} finally {
  await relay.close();
}
