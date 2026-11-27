// Multi-host inbox stage 4 (scripts/remote-hosts-failures.md, 38–59): the offline read cache of remote hosts, disabled writes while a host is
// offline, live data replacing the copy on reconnect, per-host limits and isolation, and the wipe on Forget host and revocation.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, say } from "./lib/e2e-kit.mjs";
import { pairHost, typeAndSend } from "./lib/inbox-journeys.mjs";

const hostile = '<strong id="cached-markup">Cached markup</strong>';
const relay = await inboxRelay();
const local = await createKit("offline-cache", { handler: () => say("Local reply") });
const remote = await createKit("offline-cache-remote", {
  env: { NODE_EXTRA_CA_CERTS: relay.cert },
  handler: ({ user }) => say(user.includes("Hello garden") ? `Garden reply ${hostile}` : `Remote reply to ${user.slice(0, 30)}`),
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
      const unopened = await remote.createProject("Never opened");
      const hostId = status.hostId;

      const page = await local.openPage(url.href, { trustedSpki: relay.spki });
      await page.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
      const q = (expression) => page.evaluate(expression);
      const group = (state) => `!!document.querySelector('[data-host-group="${hostId}"][data-state="${state}"]')`;
      const groupText = () => q(`document.querySelector('[data-host-group="${hostId}"]').innerText`);
      const cached = (host = hostId) =>
        q(
          `new Promise((ok) => { const r = indexedDB.open('pi-host-cache'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').index('host').count(${JSON.stringify(host)}); q.onsuccess = () => { r.result.close(); ok(q.result); }; }; r.onerror = () => ok(-1); })`,
        );
      const disabled = (selector) =>
        q(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && e.disabled && e.title.length > 0; })()`);
      const narrow = async (sheet) => {
        await page.viewport(390, 844, true);
        await page.waitFor(`matchMedia('(max-width: 760px)').matches && innerWidth === 390`, "390 px layout");
        await q(`document.querySelector('#app').dataset.sheet = ${JSON.stringify(sheet)}`);
        await new Promise((done) => setTimeout(done, 300));
      };
      const shot = async (name) => {
        await page.shot(name, { force: true });
        await narrow("");
        await page.shot(`${name}-390`, { force: true });
        await narrow("list");
        await page.shot(`${name}-390-list`, { force: true });
        await q(`document.querySelector('#app').dataset.sheet = ''`);
        await page.viewport(1440, 1000);
        await page.waitFor(`innerWidth === 1440`, "desktop layout");
      };

      // 51: no remote hosts, the cache database is never opened
      assert.equal(await q(`indexedDB.databases().then((l) => l.some((d) => d.name === 'pi-host-cache'))`), false);
      await pairHost(page, (await remote.rpc({ action: "remote-pair-start" })).link);
      await page.waitFor(group("online"), "Home Mac online");
      await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Garden plan')`, "remote projects");
      await q(`window.sameDocument = 'yes'`);

      // Load the Garden plan chat while the host is online
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${garden}"]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Garden plan')`, "Garden plan selected");
      await typeAndSend(page, "#composer-input", "Hello garden");
      await page.waitFor(`document.querySelector('#feed').innerText.includes('Garden reply')`, "live reply");
      assert.equal(await q(`document.querySelector('#offline-banner').hidden`), true);
      assert.equal(await q(`document.body.dataset.hostOffline`), "0");
      await page.waitFor(`document.querySelector('#composer-input').placeholder.includes('coordinator')`, "live composer");
      await shot("host-online");
      assert.ok((await cached()) >= 3, "reads of the online host were saved");
      await remote
        .rpc({ action: "knowledge-write", id: garden, path: "preferences.md", text: "# Preferences\n\nMemory version one.\n" })
        .catch(async () => {
          const prefs = await remote.rpc({ action: "knowledge-read", id: garden, path: "preferences.md" });
          await remote.rpc({
            action: "knowledge-write",
            id: garden,
            path: "preferences.md",
            text: "# Preferences\n\nMemory version one.\n",
            expectedRevision: prefs.revision,
          });
        });
      const messagesBefore = (await remote.rpc({ action: "show", id: garden })).messages.length;
      const callsBefore = remote.result.calls.length;

      // 38, 39, 41, 42: offline, the group and the chat stay browsable, marked as an offline copy
      await remote.stopHost();
      await page.waitFor(group("offline"), "Home Mac offline");
      await page.waitFor(`document.querySelector('#offline-banner').innerText.includes('data from')`, "offline banner with a time");
      assert.match(await groupText(), /Garden plan/);
      assert.match(await groupText(), /Offline copy · data from \d\d?:\d\d/);
      assert.match(await q(`document.querySelector('#offline-banner').innerText`), /Offline copy of Home Mac · data from \d\d?:\d\d/);
      assert.ok(await q(`document.querySelector('#feed').innerText.includes('Garden reply')`), "cached transcript shown");
      assert.equal(await q(`!!document.querySelector('#cached-markup')`), false, "50: cached text is escaped");
      assert.equal(await q(`document.querySelectorAll('#decisions .decision').length`), 0);
      assert.match(await q(`document.querySelector('#status-pill').innerText`), /All quiet/);

      // 43, 44: every write is disabled with a reason, the client refuses it, nothing reaches the host
      assert.ok(await disabled("#composer-input"), "composer disabled with a reason");
      assert.ok(await disabled("#composer .send"), "send disabled");
      assert.ok(await disabled("[data-new-chat]"), "New chat disabled");
      assert.match(await q(`document.querySelector('#composer-input').placeholder`), /offline/i);
      await q(`document.querySelector('[data-host-menu="${hostId}"]').click()`);
      await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
      assert.equal(
        await q(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith('New project on')).disabled`),
        true,
      );
      assert.equal(
        await q(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith('Forget')).disabled`),
        false,
      );
      await q(`document.querySelector('[data-host-menu="${hostId}"]').click()`);
      for (const [action, input] of [
        ["message", { id: garden, text: "queued?" }],
        ["chat-create", { id: garden }],
        ["create", { name: "Offline project", cwd: "/tmp", requestId: crypto.randomUUID() }],
        ["chat-update", { id: garden, chatId: "main", archived: true }],
        ["answer", { id: garden, entry: "x", text: "y" }],
        ["plugin", { id: garden, plugin: "p", method: "m" }],
      ]) {
        const refusal = await q(
          `(async () => { const { remoteHost, localHost } = await import('/api.js'); const host = await remoteHost((await localHost.call('inbox-hosts'))[0]); return host.call(${JSON.stringify(action)}, ${JSON.stringify(input)}).then(() => 'sent', (e) => e.message + '|' + e.refused); })()`,
        );
        assert.match(refusal, /offline.*disabled.*\|true$/i, `${action}: ${refusal}`);
      }
      // 40: a chat that was never opened says so
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${unopened}"]').click()`);
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Never opened')`, "unopened project selected");
      await page.waitFor(`!!document.querySelector('#feed .never-loaded')`, "never-loaded notice");
      assert.match(await q(`document.querySelector('#feed .never-loaded').innerText`), /Never loaded.*Home Mac/);
      assert.match(await q(`document.querySelector('#offline-banner').innerText`), /no copy of this view/i);
      assert.equal(await q(`document.querySelectorAll('#toasts .toast').length`), 0, "never-loaded is not a toast");
      await shot("never-loaded");
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${garden}"]').click()`);
      await page.waitFor(`document.querySelector('#feed').innerText.includes('Garden reply')`, "cached chat again");
      await shot("host-offline");

      // 46: back online, live data replaces the copy without a reload; the controls are enabled again
      remote.startHost();
      await remote.waitHost();
      await page.waitFor(group("online"), "Home Mac back online");
      assert.equal(remote.result.calls.length, callsBefore, "44: nothing was queued or sent");
      assert.equal((await remote.rpc({ action: "show", id: garden })).messages.length, messagesBefore, "44: the host never saw a write");
      assert.ok(!(await remote.rpc({ action: "list" })).some((item) => item.name === "Offline project"));
      await page.waitFor(
        `document.querySelector('#offline-banner').hidden && !document.querySelector('#composer-input').disabled`,
        "live again",
      );
      await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Never opened')`, "live list");
      assert.doesNotMatch(await groupText(), /Offline copy/);
      assert.equal(await q(`window.sameDocument`), "yes", "no reload");
      await remote.ask(garden, "Ping live");
      await page.waitFor(`document.querySelector('#feed').innerText.includes('Remote reply to Ping live')`, "new live data");
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${unopened}"]').click()`);
      await page.waitFor(
        `!document.querySelector('#feed .never-loaded') && document.querySelector('#crumbs').innerText.includes('Never opened')`,
        "unopened loads live",
      );

      // 54, 55, 56, 58, 59: a second offline cycle with a Memory document open
      const remoteClient = `(async () => { const { remoteHost, localHost } = await import('/api.js'); return remoteHost((await localHost.call('inbox-hosts'))[0]); })()`;
      await q(`document.querySelector('[data-project-id="${garden}"][data-memory-node]').click()`);
      await page.waitFor(`!!document.querySelector('#focus-view [data-memory="preferences.md"]')`, "memory list");
      await q(`document.querySelector('#focus-view [data-memory="preferences.md"]').click()`);
      await page.waitFor(`document.querySelector('#focus-view').innerText.includes('Memory version one')`, "memory document");
      // 54: a cache read that is overtaken by the host coming back is not returned as live data
      const raced = await q(`(async () => {
        const host = await ${remoteClient};
        host.state = 'offline';
        const read = host.call('show', { id: ${JSON.stringify(garden)} });
        host.state = 'online';
        const data = await read;
        return { live: host.copies.get('show')?.live, messages: data.messages.length > 0 };
      })()`);
      assert.deepEqual(raced, { live: true, messages: true }, "54: the copy was not returned as live data");
      // 56: reads in flight when the host drops fall back to the cache instead of waiting for the host
      await q(`(async () => {
        const host = await ${remoteClient};
        window.calls = new Set();
        window.loop = setInterval(() => {
          const call = host.call('knowledge-read', { id: ${JSON.stringify(garden)}, path: 'preferences.md' });
          const done = () => window.calls.delete(call);
          window.calls.add(call);
          call.then(done, done);
        }, 20);
      })()`);
      await remote.stopHost();
      await page.waitFor(group("offline"), "offline again");
      await q(`clearInterval(window.loop)`);
      await page.waitFor(`window.calls.size === 0`, "56: no read waits for the host");
      // 59: the banner shows the time of the displayed read, not of the memory list
      await q(`(async () => {
        const host = await ${remoteClient};
        host.copies.set('memory-index', { at: host.copies.get('knowledge-read').at - 5 * 3600 * 1000, live: false });
        host.dispatchEvent(new Event('copy'));
      })()`);
      const expected = await q(
        `(async () => { const host = await ${remoteClient}; return (await import('/format.js')).clock(host.copies.get('knowledge-read').at); })()`,
      );
      await page.waitFor(
        `document.querySelector('#offline-banner').innerText.includes('data from ${expected}')`,
        "59: banner time of the displayed read",
      );
      assert.ok(await disabled("[data-edit-memory]"), "memory Edit disabled offline");
      // 58: a write control inside the feed is frozen too
      await q(
        `document.querySelector('#feed').insertAdjacentHTML('beforeend', '<button type="button" data-retry-job="x" id="fake-retry">Retry</button><button type="button" class="media-open" id="fake-media">Open</button>')`,
      );
      await page.waitFor(`document.querySelector('#fake-retry').disabled`, "58: Retry in the feed disabled");
      assert.equal(await q(`document.querySelector('#fake-media').disabled`), false, "reading controls of the feed stay enabled");
      await q(`document.querySelector('#fake-retry').remove(); document.querySelector('#fake-media').remove()`);
      // 55: back online the open document is read again, and only then is it live
      remote.startHost();
      await remote.waitHost();
      const prefs = await remote.rpc({ action: "knowledge-read", id: garden, path: "preferences.md" });
      await remote.rpc({
        action: "knowledge-write",
        id: garden,
        path: "preferences.md",
        text: "# Preferences\n\nMemory version two.\n",
        expectedRevision: prefs.revision,
      });
      await page.waitFor(group("online"), "online again");
      await page.waitFor(
        `document.querySelector('#focus-view').innerText.includes('Memory version two')`,
        "55: the document was read again",
      );
      await page.waitFor(
        `document.querySelector('#offline-banner').hidden && !document.querySelector('[data-edit-memory]').disabled`,
        "55: live and editable",
      );
      await page.waitFor(
        `(() => { const back = document.querySelector('#focus-view:not([hidden]) .back'); back?.click(); return document.querySelector('#focus-view').hidden; })()`,
        "back to chat",
      );

      // 47, 48: a host's entries are its own and its oldest reads leave first
      const evicted = await q(`(async () => {
        const { hostCache, limits, wipeHost } = await import('/host-cache.js');
        const wait = () => new Promise((ok) => setTimeout(ok, 8));
        const keep = limits.hostBytes;
        limits.hostBytes = 500;
        const a = hostCache('evict-A'), b = hostCache('evict-B');
        const before = Date.now();
        await b.put('read', { n: 1 }, 'b'.repeat(100), Date.now());
        for (const n of [1, 2, 3, 4]) { await a.put('read', { n }, 'a'.repeat(100), Date.now()); await wait(); }
        await a.put('read', { n: 5 }, 'x'.repeat(1000));
        const c = hostCache('bytes-C');
        await c.put('read', { n: 1 }, '€'.repeat(100), Date.now());
        await wait();
        await c.put('read', { n: 2 }, '€'.repeat(100), Date.now());
        const result = {
          oldestGone: (await a.get('read', { n: 1 })) === null,
          rest: (await Promise.all([2, 3, 4].map((n) => a.get('read', { n })))).every((item) => item?.data.length === 100),
          oversize: (await a.get('read', { n: 5 })) === null,
          otherUntouched: (await b.get('read', { n: 1 }))?.data.length === 100,
          notShared: (await b.get('read', { n: 2 })) === null,
          bytesCounted: (await c.get('read', { n: 1 })) === null && (await c.get('read', { n: 2 })) !== null,
        sameInputOrder: (await a.get('read', { n: 4 }))?.data.length === 100,
        };
        limits.hostBytes = keep;
        await wipeHost('evict-A');
        result.wiped = (await a.get('read', { n: 4 })) === null;
        await a.put('read', { n: 6 }, 'late', before);
        result.noRefill = (await a.get('read', { n: 6 })) === null;
        const tombstone = await new Promise((ok) => { const r = indexedDB.open('pi-host-cache'); r.onsuccess = () => { const g = r.result.transaction('wiped').objectStore('wiped').get('evict-A'); g.onsuccess = () => { r.result.close(); ok(g.result > 0); }; }; });
        await a.put('read', { n: 7 }, 'after', Date.now());
        result.tombstone = tombstone;
        result.freshSaveAfterWipe = (await a.get('read', { n: 7 }))?.data === 'after';
        await wipeHost('bytes-C');
        return result;
      })()`);
      assert.deepEqual(evicted, {
        oldestGone: true,
        rest: true,
        oversize: true,
        otherUntouched: true,
        notShared: true,
        sameInputOrder: true,
        wiped: true,
        noRefill: true,
        tombstone: true,
        freshSaveAfterWipe: true,
        bytesCounted: true,
      });
      assert.equal(await cached("evict-B"), 1);

      // 49: Forget host wipes that host's entries and only those
      assert.ok((await cached()) > 0);
      await q(`window.confirm = () => true`);
      await q(`document.querySelector('[data-host-menu="${hostId}"]').click()`);
      await page.waitFor(`!!document.querySelector('.host-menu')`, "host menu");
      await q(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith('Forget')).click()`);
      await page.waitFor(`!document.querySelector('[data-host-group="${hostId}"]')`, "group forgotten");
      assert.equal(await cached(), 0, "Forget host wiped the cache");
      assert.equal(await cached("evict-B"), 1, "another host's entries stay");
      await q(`import('/host-cache.js').then(({ wipeHost }) => wipeHost('evict-B'))`);

      // 49: a revoked device wipes the cache too, and a revoked host shows no copy
      await pairHost(page, (await remote.rpc({ action: "remote-pair-start" })).link);
      await page.waitFor(group("online"), "paired again");
      await page.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Garden plan')`, "projects again");
      await q(`document.querySelector('[data-host-group="${hostId}"] [data-project="${garden}"]').click()`);
      await page.waitFor(`document.querySelector('#feed').innerText.includes('Garden reply')`, "chat again");
      assert.ok((await cached()) > 0);
      const deviceId = await q(`(async () => (await (await import('/inbox-wire/store.js')).get('inbox-device:${hostId}')).id)()`);
      await remote.rpc({ action: "remote-revoke", deviceId, confirm: deviceId });
      await page.waitFor(group("revoked"), "revoked");
      await local.waitFor(async () => (await cached()) === 0, "revocation wiped the cache");
      assert.doesNotMatch(await groupText(), /Garden plan|Offline copy/);
      await page.waitFor(`!document.querySelector('#feed').innerText.includes('Garden reply')`, "52: no view of the revoked host stays");
      await page.waitFor(`document.querySelector('#crumbs').innerText.includes('Local notes')`, "52: the open view moved to a live host");
      // The tunnel cancels the open streams of a revoked device after the relay closed its socket; Chrome logs that send (pre-existing, not the cache).
      local.result.errors = local.result.errors.filter((error) => error !== "WebSocket is already in CLOSING or CLOSED state.");
      await page.shot("revoked", { force: true });
    });
    assert.equal(remote.result.status, "passed", remote.result.failure);
    local.result.httpErrors = local.result.httpErrors.filter((e) => !e.url.endsWith("/changes"));
  });
} finally {
  await relay.close();
}
