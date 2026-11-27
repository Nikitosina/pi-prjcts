// Multi-host inbox stage 4, third review (scripts/remote-hosts-failures.md, 69–73, 76, 77): reads are not replayed after a lost connection,
// each view reads again after the reconnect without losing input, controls unlock only after the view's own live read, a read that gates
// a write never continues into it after an offline period, a PR review offline marks nothing, and a host revoked at startup opens no panel.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, say } from "./lib/e2e-kit.mjs";
import { pairHost, typeAndSend } from "./lib/inbox-journeys.mjs";

const relay = await inboxRelay();
const local = await createKit("offline-reconnect", { handler: () => say("Local reply") });
const remote = await createKit("offline-reconnect-remote", {
  env: { NODE_EXTRA_CA_CERTS: relay.cert },
  handler: ({ user }) => say(`Remote reply to ${user.slice(0, 30)}`),
});
try {
  await local.run(async () => {
    const url = new URL((await local.rpc({ action: "web" })).url);
    local.initRepo();
    await local.createProject("Local notes");
    await remote.run(async () => {
      mkdirSync(join(remote.home, "remote"), { recursive: true });
      writeFileSync(join(remote.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
      const status = await remote.rpc({ action: "remote-reload" });
      relay.allow(status.hostId);
      await remote.waitFor(async () => (await remote.rpc({ action: "remote-status" })).connection === "connected", "Home Mac connected");
      remote.initRepo();
      const garden = await remote.createProject("Garden plan");
      const hostId = status.hostId;
      for (const [path, text] of [
        ["decisions/alpha.md", "# Alpha\n\nAlpha text.\n"],
        ["decisions/beta.md", "# Beta\n\nBeta text.\n"],
      ])
        await remote.rpc({ action: "knowledge-write", id: garden, path, text, expectedRevision: null });

      const page = await local.openPage(url.href, { trustedSpki: relay.spki });
      await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
      const q = (expression) => page.evaluate(expression);
      const group = (state) => `!!document.querySelector('[data-host-group="${hostId}"][data-state="${state}"]')`;
      const client = `(async () => { const { remoteHost, localHost } = await import('/api.js'); return remoteHost((await localHost.call('inbox-hosts'))[0]); })()`;
      // Records every call of the remote host client and holds the ones named in `window.holds` until their promise settles.
      const spy = () =>
        q(`(async () => {
          const host = await ${client};
          if (host.spied) return;
          host.spied = true;
          const call = host.call.bind(host);
          window.sent = [];
          window.holds = {};
          host.call = (action, input, signal, options) => {
            window.sent.push({ action, input });
            const hold = window.holds[action + ':' + (input?.path ?? '')] ?? window.holds[action];
            return hold ? hold.then(() => call(action, input, signal, options)) : call(action, input, signal, options);
          };
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (...args) { return window.dropFrames ? undefined : send.apply(this, args); };
        })()`);
      const settleSoon = (name, expression) =>
        q(
          `window.${name} = undefined; Promise.resolve(${expression}).then((v) => (window.${name} = v), (e) => (window.${name} = 'error: ' + e.message)); undefined`,
        );
      const hold = (key) =>
        q(
          `window.holds[${JSON.stringify(key)}] = new Promise((ok) => (window.release = { ...window.release, [${JSON.stringify(key)}]: ok })); undefined`,
        );
      const release = (key) => q(`window.release[${JSON.stringify(key)}]()`);

      await pairHost(page, (await remote.rpc({ action: "remote-pair-start" })).link);
      await page.waitFor(group("online"), "Home Mac online");
      await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Garden plan')`, "remote projects");
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${garden}"]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Garden plan')`, "Garden plan selected");
      await typeAndSend(page, "#composer-input", "Hello garden");
      await page.waitFor(`document.querySelector('#feed').innerText.includes('Remote reply')`, "live reply");
      await spy();

      // 77: reads of one millisecond never tie
      assert.deepEqual(
        await q(`(async () => {
          const { hostCache, stamp } = await import('/host-cache.js');
          const now = Date.now;
          Date.now = () => 1000;
          const older = stamp(), newer = stamp();
          Date.now = now;
          const cache = hostCache('tie-A');
          await cache.put('read', {}, 'newer', newer);
          await cache.put('read', {}, 'older answer arriving late', older);
          const kept = (await cache.get('read', {}))?.data;
          await (await import('/host-cache.js')).wipeHost('tie-A');
          return { ordered: older < newer, kept };
        })()`),
        { ordered: true, kept: "newer" },
        "77: a monotonic sequence orders reads of one millisecond",
      );

      // 69: a read in flight when the host drops answers at once and is never replayed
      await q(`window.dropFrames = true`);
      await settleSoon("inflight", `(async () => (await ${client}).call('search', { query: 'never saved' }).then(() => 'answered'))()`);
      await remote.stopHost();
      await page.waitFor(group("offline"), "Home Mac offline");
      await page.waitFor(`window.inflight !== undefined`, "69: the unfinished read settled while the host is away", 40);
      assert.match(await q(`window.inflight`), /error: .*(never loaded|offline)/i);
      await q(`window.dropFrames = false`);

      // 73: a PR review opened offline shows its copy and never marks it seen, nor does the reconnect
      await q(`(async () => {
        const { hostCache } = await import('/host-cache.js');
        await hostCache(${JSON.stringify(hostId)}).put('pr-review-open', { id: ${JSON.stringify(garden)}, provider: 'github', pr: 7, seen: false }, { head: 'abc', files: [], threads: [], iterations: [] }, Date.now());
        window.sent.length = 0;
        (await import('/state.js')).emit('open', { kind: 'pr', id: 7, provider: 'github' });
      })()`);
      await page.waitFor(`window.sent.some((c) => c.action === 'pr-review-open')`, "the review was opened offline");
      remote.startHost();
      await remote.waitHost();
      await page.waitFor(group("online"), "online after the review");
      await page.waitFor(`window.sent.filter((c) => c.action === 'pr-review-open').length >= 2`, "the review read again");
      await new Promise((done) => setTimeout(done, 500));
      assert.deepEqual(
        await q(`window.sent.filter((c) => c.action === 'pr-review-open' && c.input.seen === true).length`),
        0,
        "73: nothing marked the review seen",
      );
      await q(`document.querySelector('#focus-view .back')?.click()`);

      // 70: only the newest read of a view draws it
      await q(`window.release = {}`);
      await hold("knowledge-read:decisions/alpha.md");
      await q(`import('/state.js').then(({ emit }) => emit('open', { kind: 'memory', path: 'decisions/alpha.md' }))`);
      await q(`import('/state.js').then(({ emit }) => emit('open', { kind: 'memory', path: 'decisions/beta.md' }))`);
      await page.waitFor(`document.querySelector('#focus-view').innerText.includes('Beta text')`, "the newest document drew");
      await release("knowledge-read:decisions/alpha.md");
      await new Promise((done) => setTimeout(done, 800));
      assert.equal(
        await q(`document.querySelector('#focus-view').innerText.includes('Alpha text')`),
        false,
        "70: an older read never draws over the newest",
      );
      await q(`document.querySelector('#focus-view .back')?.click()`);

      // Settings of the remote host: the panel is locked until its own live read
      await q(`location.replace(location.pathname + '?host=${hostId}&panel=settings')`);
      await page.waitFor(`document.body.dataset.ready === '1' && document.querySelector('#settings').open`, "remote Settings open");
      await page.waitFor(group("online"), "admin host online");
      await spy();
      await q(`document.querySelector('nav [data-section=tiers]').click()`);
      await page.waitFor(`document.querySelector('#settings .settings-body').innerText.includes('New tier')`, "tiers loaded");
      await remote.stopHost();
      await page.waitFor(group("offline"), "admin host offline");
      await page.waitFor(`!!document.querySelector('#settings .offline-banner:not([hidden])')`, "71: the banner is in the visible panel");
      assert.match(await q(`document.querySelector('#settings .offline-banner').innerText`), /Offline copy of Home Mac/);
      await q(`window.release = {}`);
      await hold("tiers-get");
      remote.startHost();
      await remote.waitHost();
      await page.waitFor(group("online"), "admin host back");
      await page.waitFor(`window.sent.some((c) => c.action === 'tiers-get')`, "the panel reads again");
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(
        await q(
          `document.querySelectorAll('#settings [data-offline-off]').length > 0 && !!document.querySelector('#settings .offline-banner:not([hidden])')`,
        ),
        true,
        "71: the panel stays an offline copy until its own read answered",
      );
      await release("tiers-get");
      await page.waitFor(
        `document.querySelectorAll('#settings [data-offline-off]').length === 0 && !!document.querySelector('#settings .offline-banner[hidden]')`,
        "71: unlocked by its own live read",
      );

      // 72: the UI revision retry never writes after an offline period
      const ui = await remote.rpc({ action: "ui-get" });
      await remote.rpc({ action: "ui-set", revision: ui.revision, patch: { chatTextPercent: 105 } });
      await hold("ui-get");
      await settleSoon("uiWrite", `import('/app.js').then(({ ui }) => ui.setUi({ chatTextPercent: 120 }))`);
      await page.waitFor(`window.sent.some((c) => c.action === 'ui-set')`, "the first ui-set was sent");
      await page.waitFor(`window.sent.filter((c) => c.action === 'ui-get').length >= 1`, "the retry's read started");
      await remote.stopHost();
      await page.waitFor(group("offline"), "offline during the retry");
      remote.startHost();
      await remote.waitHost();
      await page.waitFor(group("online"), "online after the retry");
      await release("ui-get");
      await new Promise((done) => setTimeout(done, 1200));
      assert.equal(
        (await remote.rpc({ action: "ui-get" })).ui.chatTextPercent,
        105,
        "72: the retry did not write after the offline period",
      );

      // 72: the Settings tool toggle never writes after an offline period
      await q(`document.querySelector('nav [data-section=tools]').click()`);
      await page.waitFor(`!!document.querySelector('#settings [data-tool-name]:not([disabled])')`, "tools loaded");
      const before = JSON.stringify((await remote.rpc({ action: "profiles-get", projectId: garden })).profiles);
      await hold("profiles-get");
      await q(`document.querySelector('#settings [data-tool-name]:not([disabled])').click()`);
      await page.waitFor(`window.sent.some((c) => c.action === 'profiles-get')`, "the toggle's read started");
      await remote.stopHost();
      await page.waitFor(group("offline"), "offline during the toggle");
      remote.startHost();
      await remote.waitHost();
      await page.waitFor(group("online"), "online after the toggle");
      await release("profiles-get");
      await new Promise((done) => setTimeout(done, 1200));
      assert.equal(
        JSON.stringify((await remote.rpc({ action: "profiles-get", projectId: garden })).profiles),
        before,
        "72: the toggle did not write after the offline period",
      );
      assert.equal(await q(`window.sent.filter((c) => c.action === 'profiles-set').length`), 0);

      // 76: a host that is already revoked when the page starts opens neither Settings nor the Host agent
      const deviceId = await q(`(async () => (await (await import('/inbox-wire/store.js')).get('inbox-device:${hostId}')).id)()`);
      await remote.rpc({ action: "remote-revoke", deviceId, confirm: deviceId });
      await page.waitFor(`!new URLSearchParams(location.search).has('host')`, "leaves the host when it is revoked");
      await page.waitFor(`document.body.dataset.ready === '1'`, "ready after the redirect");
      await q(`location.replace(location.pathname + '?host=${hostId}&panel=settings')`);
      await page.waitFor(
        `!new URLSearchParams(location.search).has('host') && document.body.dataset.ready === '1'`,
        "76: startup on a revoked host returns to the local host",
      );
      await new Promise((done) => setTimeout(done, 1500));
      await page.waitFor(`!!document.querySelector('#settings') && document.body.dataset.ready === '1'`, "local page loaded");
      assert.equal(await q(`document.querySelector('#settings').open`), false, "76: Settings stays closed");
      local.result.errors = local.result.errors.filter((error) => error !== "WebSocket is already in CLOSING or CLOSED state.");
    });
    assert.equal(remote.result.status, "passed", remote.result.failure);
    local.result.httpErrors = local.result.httpErrors.filter((e) => !e.url.endsWith("/changes"));
  });
} finally {
  await relay.close();
}
