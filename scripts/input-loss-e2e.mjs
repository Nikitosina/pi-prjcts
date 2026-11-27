// Multi-host inbox stage 4, fourth review (scripts/remote-hosts-failures.md, 78-87): no path loses the owner's input.
// Rule A (an idle tab never writes a draft), rule B (a dirty form is never re-rendered), the late-read, replay, offline-copy, freshness
// and cross-tab ordering findings. Every check is soft so that one run against old code lists every red check; the run fails when any is red.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { createKit, say } from "./lib/e2e-kit.mjs";
import { pairHost } from "./lib/inbox-journeys.mjs";

const relay = await inboxRelay();
const local = await createKit("input-loss", { handler: () => say("Local reply") });
const remote = await createKit("input-loss-remote", { env: { NODE_EXTRA_CA_CERTS: relay.cert }, handler: () => say("Remote reply") });
const red = [];
const soft = async (label, work) => {
  try {
    await work();
  } catch (error) {
    red.push(`${label}: ${String(error.message).split("\n")[0]}`);
    console.log("RED", label, String(error.message).split("\n").slice(0, 3).join(" | "));
  }
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  await local.run(async () => {
    const url = new URL((await local.rpc({ action: "web" })).url);
    local.initRepo();
    const alpha = await local.createProject("Alpha");
    const side = await local.rpc({ action: "chat-create", id: alpha, title: "Side chat" });
    const sideId = side.id ?? side.chat?.id ?? side.chatId;
    await remote.run(async () => {
      mkdirSync(join(remote.home, "remote"), { recursive: true });
      writeFileSync(join(remote.home, "remote/config.json"), JSON.stringify({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
      const status = await remote.rpc({ action: "remote-reload" });
      relay.allow(status.hostId);
      await remote.waitFor(async () => (await remote.rpc({ action: "remote-status" })).connection === "connected", "Home Mac connected");
      remote.initRepo();
      const gamma = await remote.createProject("Gamma");
      const hostId = status.hostId;
      await remote.rpc({ action: "knowledge-write", id: gamma, path: "decisions/slow.md", text: "# Slow\n\nSlow text.\n", expectedRevision: null });

      const pageA = await local.openPage(url.href, { trustedSpki: relay.spki });
      await pageA.waitFor(`document.body.dataset.ready === '1'`, "inbox ready");
      await pairHost(pageA, (await remote.rpc({ action: "remote-pair-start" })).link);
      const group = (state) => `!!document.querySelector('[data-host-group="${hostId}"][data-state="${state}"]')`;
      await pageA.waitFor(group("online"), "Home Mac online");
      await pageA.waitFor(`document.querySelector('[data-host-group="${hostId}"]').innerText.includes('Gamma')`, "remote project listed");
      const pageB = await pageA.newTab(url.href);
      await pageB.waitFor(`document.body.dataset.ready === '1'`, "second tab ready");

      const composer = `document.querySelector('#composer-input')`;
      const open = async (page, project, chat = "main") => {
        await page.evaluate(
          `import('/state.js').then(({ emit }) => emit('select-request', { projectId: ${JSON.stringify(project)}, chatId: ${JSON.stringify(chat)} }))`,
        );
        await page.waitFor(
          `(async () => { const { state } = await import('/state.js'); return state.projectId === ${JSON.stringify(project)} && state.chatId === ${JSON.stringify(chat)} && !!state.view; })()`,
          `opened ${project}/${chat}`,
          60,
        );
        await page.waitFor(`!${composer}.disabled`, "composer enabled", 60);
      };
      const type = async (page, text) => {
        await page.evaluate(`${composer}.focus(); ${composer}.select()`);
        await page.cdp("Input.insertText", { text });
      };
      const stored = (page, key) => page.evaluate(`(JSON.parse(localStorage.getItem(${JSON.stringify(key)}) ?? 'null') ?? {}).text ?? null`);
      const remoteKey = (project, chat) => `pi-host:${hostId}:pi-draft:${project}:${chat}`;

      // Rule A, 78: a tab that never edited a draft never writes or deletes it
      await soft("78 chat composer: switching chats in an idle tab", async () => {
        await open(pageA, alpha, sideId);
        await open(pageB, alpha, sideId);
        await type(pageA, "typed in tab A");
        await pageA.waitFor(`localStorage.getItem('pi-draft:${alpha}:${sideId}') !== null`, "tab A stored its draft", 20);
        await open(pageB, alpha, "main");
        assert.equal(await stored(pageA, `pi-draft:${alpha}:${sideId}`), "typed in tab A", "an idle tab switching chats erased it");
      });
      await soft("78 chat composer: an idle tab that reloads", async () => {
        await open(pageA, alpha, "main");
        await open(pageB, alpha, "main");
        await type(pageA, "typed in tab A, main");
        await pageA.waitFor(`localStorage.getItem('pi-draft:${alpha}:main') !== null`, "tab A stored its draft", 20);
        await pageB.reload();
        await pageB.waitFor(`document.body.dataset.ready === '1'`, "second tab ready again");
        assert.equal(await stored(pageA, `pi-draft:${alpha}:main`), "typed in tab A, main", "an idle tab closing erased it");
      });
      await soft("78 Host agent composer: an idle tab that reloads", async () => {
        await pageB.evaluate(`localStorage.removeItem('pi-draft:host-agent'); undefined`);
        await pageB.reload();
        await pageB.waitFor(`document.body.dataset.ready === '1'`, "second tab ready again");
        await pageA.evaluate(
          `(() => { const t = document.querySelector('#ha-composer textarea'); t.value = 'agent draft of tab A'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
        );
        await pageB.reload();
        await pageB.waitFor(`document.body.dataset.ready === '1'`, "second tab ready after the draft");
        await pageB.evaluate(`undefined`);
        assert.equal(await stored(pageA, "pi-draft:host-agent"), "agent draft of tab A", "an idle tab erased the Host agent draft");
      });
      await pageB.close();

      // 79: an offline snapshot of a chat never deletes the draft of a newer chat
      await soft("79 an offline chat snapshot deletes a newer chat's draft", async () => {
        await open(pageA, gamma, "main");
        const later = await remote.rpc({ action: "chat-create", id: gamma, title: "Later chat" });
        const laterId = later.id ?? later.chat?.id ?? later.chatId;
        await open(pageA, gamma, laterId);
        await type(pageA, "draft of the newer chat");
        await pageA.waitFor(`localStorage.getItem(${JSON.stringify(remoteKey(gamma, laterId))}) !== null`, "stored", 20);
        await remote.stopHost();
        await pageA.waitFor(group("offline"), "Home Mac offline");
        await pageA.evaluate(
          `import('/state.js').then(({ emit }) => emit('select-request', { projectId: ${JSON.stringify(gamma)}, chatId: 'main' }))`,
        );
        await pageA.waitFor(`document.querySelector('#crumbs').innerText.includes('Gamma')`, "main shown from the copy", 40);
        await pause(800);
        assert.equal(await stored(pageA, remoteKey(gamma, laterId)), "draft of the newer chat", "a stale chat list deleted the draft");
        remote.startHost();
        await remote.waitHost();
        await pageA.waitFor(group("online"), "Home Mac back");
      });

      // 80: a late Memory read never replaces the editor of another view
      await soft("80 a late Memory read replaces a worker editor", async () => {
        await pageA.evaluate(`document.querySelector('[data-host-group="${hostId}"] [data-project="${gamma}"]').click(); undefined`);
        await pageA.waitFor(`document.querySelector('#crumbs').innerText.includes('Gamma')`, "Gamma selected");
        await spy(pageA, hostId);
        await hold(pageA, "knowledge-read:decisions/slow.md");
        await pageA.evaluate(`import('/state.js').then(({ emit }) => emit('open', { kind: 'memory', path: 'decisions/slow.md' })); undefined`);
        await pageA.evaluate(`import('/state.js').then(({ emit }) => emit('open', { kind: 'worker', id: 'w-test' })); undefined`);
        await pageA.waitFor(`!!document.querySelector('#focus-view .worker-send textarea')`, "worker form", 40);
        await pageA.evaluate(`document.querySelector('#focus-view .worker-send textarea').focus(); undefined`);
        await pageA.cdp("Input.insertText", { text: "typed to the worker" });
        await pageA.evaluate(`window.release['knowledge-read:decisions/slow.md'](); undefined`);
        await pause(1000);
        assert.equal(
          await pageA.evaluate(`document.querySelector('#focus-view .worker-send textarea')?.value ?? null`),
          "typed to the worker",
          "the Memory answer replaced the worker form",
        );
        await pageA.evaluate(`document.querySelector('#focus-view .back')?.click(); undefined`);
      });

      // 82: an interrupted read is never replayed, 83: a normal first visit of a PR review is cached under the read-only key
      const fakeClient = (name) => `(async () => {
        const { hostClient } = await import('/api.js');
        const calls = [];
        const t = Object.assign(new EventTarget(), {
          local: false, hostId: ${name}, name: 'Fake host', state: 'online', epoch: 0,
          setState(next) { if (next !== 'online') this.epoch++; this.state = next; this.dispatchEvent(new Event('statechange')); },
          authorizedFetch: () => { throw Error('unused'); },
          run: (_read, _signal, work) => work((path, init) => {
            const body = JSON.parse(init.body);
            calls.push(body);
            if (window.answers?.[body.action]) return Promise.resolve(new Response(JSON.stringify({ ok: true, data: window.answers[body.action] })));
            return new Promise((_ok, fail) => init.signal?.addEventListener('abort', () => fail(init.signal.reason)));
          }),
        });
        return { t, calls, client: hostClient(t) };
      })()`;
      await soft("82 an interrupted read is replayed while the cache answers", async () => {
        const settled = await pageA.evaluate(`(async () => {
          const { t, calls, client } = await ${fakeClient("'fake-replay'")};
          await client.call('search', { query: 'warm the database' }).catch(() => {});
          calls.length = 0;
          const db = await new Promise((ok) => { const r = indexedDB.open('pi-host-cache'); r.onsuccess = () => ok(r.result); });
          const tx = db.transaction(['meta', 'data', 'wiped'], 'readwrite');
          let on = true;
          const spin = () => { if (on) tx.objectStore('meta').get('x').onsuccess = spin; };
          spin();
          const pending = client.call('search', { query: 'in flight' }).then(() => 'answered', (e) => 'error: ' + e.message);
          await new Promise((ok) => setTimeout(ok, 100));
          t.setState('offline');
          await new Promise((ok) => setTimeout(ok, 100));
          t.setState('online');
          await new Promise((ok) => setTimeout(ok, 100));
          on = false;
          await new Promise((ok) => (tx.oncomplete = tx.onabort = ok));
          db.close();
          const outcome = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok('never settled'), 3000))]);
          return { outcome, sent: calls.filter((c) => c.query === 'in flight').length };
        })()`);
        assert.equal(settled.sent, 1, `the interrupted read was sent ${settled.sent} times`);
        assert.match(settled.outcome, /error/);
      });
      await soft("83 a PR review opened online is not cached for the offline open", async () => {
        const offline = await pageA.evaluate(`(async () => {
          window.answers = { 'pr-review-open': { head: 'abc', files: [{ path: 'a.txt' }], threads: [], iterations: [] } };
          const { t, client } = await ${fakeClient("'fake-review'")};
          await client.call('pr-review-open', { id: 'p', provider: 'github', pr: 7, seen: true });
          await new Promise((ok) => setTimeout(ok, 200));
          t.setState('offline');
          const copy = await client.call('pr-review-open', { id: 'p', provider: 'github', pr: 7, seen: false }).then((d) => d.files.length, (e) => 'error: ' + e.message);
          window.answers = {};
          return copy;
        })()`);
        assert.equal(offline, 1, "no offline copy after the first online visit");
      });

      // 84: Settings forms are dirty-tracked: a reconnect never re-renders a form with unsaved input
      await soft("84 a reconnect replaces an unsaved Settings field", async () => {
        await pageA.evaluate(`location.replace(location.pathname + '?host=${hostId}&panel=settings')`);
        await pageA.waitFor(`document.body.dataset.ready === '1' && document.querySelector('#settings')?.open`, "remote Settings open", 80);
        await pageA.waitFor(group("online"), "admin host online", 40);
        await pageA.waitFor(`!!document.querySelector('#project-name')`, "General section", 40);
        await pageA.evaluate(`document.querySelector('#project-name').focus(); document.querySelector('#project-name').select(); undefined`);
        await pageA.cdp("Input.insertText", { text: "Renamed but unsaved" });
        await remote.stopHost();
        await pageA.waitFor(group("offline"), "admin host offline");
        remote.startHost();
        await remote.waitHost();
        await pageA.waitFor(group("online"), "admin host back");
        await pause(1500);
        assert.equal(await pageA.evaluate(`document.querySelector('#project-name')?.value ?? null`), "Renamed but unsaved", "the field was re-rendered");
        await pageA.waitFor(`document.querySelectorAll('#settings [data-offline-off]').length === 0`, "the panel unlocks after a live read", 40);
      });

      // 85: freshness belongs to the current connection period
      await soft("85 controls unlock while the new read of the shown chat is pending", async () => {
        await pageA.evaluate(`location.replace(location.pathname)`);
        await pageA.waitFor(`document.body.dataset.ready === '1' && !!document.querySelector('[data-host-group="${hostId}"]')`, "page back", 80);
        await pageA.waitFor(group("online"), "host online again", 40);
        await pageA.evaluate(`document.querySelector('[data-host-group="${hostId}"] [data-project="${gamma}"]').click(); undefined`);
        await pageA.waitFor(`document.querySelector('#crumbs').innerText.includes('Gamma')`, "Gamma selected");
        await pageA.waitFor(`!${composer}.disabled`, "composer ready", 40);
        await spy(pageA, hostId);
        await remote.stopHost();
        await pageA.waitFor(group("offline"), "host offline");
        await hold(pageA, "show");
        remote.startHost();
        await remote.waitHost();
        await pageA.waitFor(group("online"), "host back");
        await pageA.waitFor(`window.sent.some((c) => c.action === 'show')`, "the chat reads again", 40);
        await pause(600);
        assert.equal(await pageA.evaluate(`${composer}.disabled`), true, "the composer unlocked before the live read answered");
        await pageA.evaluate(`window.release['show'](); undefined`);
        await pageA.waitFor(`!${composer}.disabled`, "unlocked by the live read", 40);
      });

      // 86, 87: order across tabs
      await soft("86 a save that began before another tab's wipe lands after it", async () => {
        const tab = await pageA.newTab(url.href);
        await tab.waitFor(`document.body.dataset.ready === '1'`, "tab ready");
        const result = await pageA.evaluate(`(async () => {
          const m = await import('/host-cache.js');
          const cache = m.hostCache('xtab');
          if (m.stamp) for (let i = 0; i < 30000; i++) m.stamp();
          const token = cache.begin ? await cache.begin() : m.stamp();
          window.__token = token;
          window.__cache = cache;
          return true;
        })()`);
        assert.ok(result);
        await tab.evaluate(`import('/host-cache.js').then((m) => m.wipeHost('xtab'))`);
        const kept = await pageA.evaluate(`(async () => {
          await window.__cache.put('read', {}, 'saved after the wipe', window.__token);
          return (await window.__cache.get('read', {}))?.data ?? null;
        })()`);
        await pageA.evaluate(`import('/host-cache.js').then((m) => m.wipeHost('xtab')); undefined`);
        await tab.close();
        assert.equal(kept, null, "a save from before the wipe was shown");
      });
      await soft("87 two tabs order their reads by the shared counter", async () => {
        const tab = await pageA.newTab(url.href);
        await tab.waitFor(`document.body.dataset.ready === '1'`, "tab ready");
        const kept = await pageA.evaluate(`(async () => {
          const m = await import('/host-cache.js');
          const cache = m.hostCache('xtab2');
          if (!cache.begin) return 'newer';
          window.__older = await cache.begin();
          window.__cache2 = cache;
          return null;
        })()`);
        if (kept === null) {
          await tab.evaluate(`(async () => {
            const m = await import('/host-cache.js');
            const cache = m.hostCache('xtab2');
            const newer = await cache.begin();
            await cache.put('read', {}, 'newer', newer);
          })()`);
          const data = await pageA.evaluate(`(async () => {
            await window.__cache2.put('read', {}, 'older answer arriving late', window.__older);
            return (await window.__cache2.get('read', {}))?.data;
          })()`);
          assert.equal(data, "newer");
        }
        await pageA.evaluate(`import('/host-cache.js').then((m) => m.wipeHost('xtab2')); undefined`);
        await tab.close();
      });

      local.result.errors = local.result.errors.filter((error) => error !== "WebSocket is already in CLOSING or CLOSED state.");
      assert.deepEqual(red, [], `red checks:\n${red.join("\n")}`);

      async function spy(page, id) {
        await page.evaluate(`(async () => {
          const { remoteHost, localHost } = await import('/api.js');
          const entry = (await localHost.call('inbox-hosts')).find((item) => item.hostId === ${JSON.stringify(id)});
          const host = await remoteHost(entry);
          if (host.spied) return;
          host.spied = true;
          const call = host.call.bind(host);
          window.sent = [];
          window.holds = {};
          window.release = {};
          host.call = (action, input, signal, options) => {
            window.sent.push({ action, input });
            const hold = window.holds[action + ':' + (input?.path ?? '')] ?? window.holds[action];
            return hold ? hold.then(() => call(action, input, signal, options)) : call(action, input, signal, options);
          };
        })()`);
      }
      async function hold(page, key) {
        await page.evaluate(
          `window.holds[${JSON.stringify(key)}] = new Promise((ok) => (window.release[${JSON.stringify(key)}] = ok)); undefined`,
        );
      }
    });
    assert.equal(remote.result.status, "passed", remote.result.failure);
    local.result.httpErrors = local.result.httpErrors.filter((e) => !e.url.endsWith("/changes"));
  });
} finally {
  await relay.close();
}
