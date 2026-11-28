// Browser E2E: the composer text is one draft per chat (and one for the Host agent), stored on the owner's input in that tab only, in a real
// two-tab Chrome. Failure cases: chat-drafts-failures.md. The host and the fake model are real; the page's fetch is wrapped to hold or refuse a send.
import { createKit, say } from "./lib/e2e-kit.mjs";

const kit = await createKit("chat-drafts", {
  handler: ({ role, user, tools }) =>
    tools.includes("host_call")
      ? say("ok")
      : role === "coordinator" && !user.startsWith("[Durable work")
        ? say(`ACK ${user.replace(/\s+/g, " ").slice(0, 120)}`)
        : undefined,
});
const { rpc } = kit;
// E2E_SOFT=1 reports every check instead of stopping at the first failure (used to show each case red on main).
const soft = process.env.E2E_SOFT === "1";
const check = (label, ok, detail) => (soft ? console.log(`${ok ? "GREEN" : "RED"} ${label}`) : kit.check(label, ok, detail));

const wrapFetch = `(() => {
  window.__calls = [];
  window.__rules = {};
  const real = window.fetch.bind(window);
  window.__hold = (action) => { let release; const gate = new Promise((ok) => (release = ok)); window.__rules[action] = { ...window.__rules[action], gate, release }; };
  window.__release = (action) => { window.__rules[action]?.release?.(); delete window.__rules[action]?.gate; };
  window.__rule = (action, rule) => { window.__rules[action] = { ...window.__rules[action], ...rule }; };
  window.fetch = async (url, init) => {
    if (url !== "/api" || !init?.body) return real(url, init);
    const body = JSON.parse(init.body);
    window.__calls.push({ action: body.action, text: body.text });
    const rule = window.__rules[body.action] ?? {};
    if (rule.gate) await rule.gate;
    if (rule.fail === "json") {
      delete rule.fail;
      return real(url, { ...init, body: JSON.stringify({ ...body, chatId: crypto.randomUUID() }) });
    }
    return real(url, init);
  };
})()`;
// Every draft write and removal of a page, kept in sessionStorage so it survives a reload; a tab's only legitimate cause is its own input event.
const logWrites = `(() => {
  const note = (kind, key) => { if (String(key).includes("pi-draft:")) sessionStorage.setItem("__draftWrites", JSON.stringify([...JSON.parse(sessionStorage.getItem("__draftWrites") ?? "[]"), kind + " " + key])); };
  const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) { if (window.__deny && String(key).includes("pi-draft:")) throw new DOMException("quota", "QuotaExceededError"); note("set", key); return set.call(this, key, value); };
  Storage.prototype.removeItem = function (key) { note("remove", key); return remove.call(this, key); };
})()`;

kit.initRepo();
await kit.run(async () => {
  const A = await kit.createProject("Drafts A");
  const B = await kit.createProject("Drafts B");
  const other = (await rpc({ action: "chat-create", id: A, title: "Other" })).id;
  const third = (await rpc({ action: "chat-create", id: A, title: "Third" })).id;
  await kit.ask(A, "seed A MARK-SEED-A");
  await kit.ask(B, "seed B MARK-SEED-B");
  const url = await kit.webUrl(A);
  const key = (project, chat) => `pi-draft:${project}:${chat}`;
  const HOST_KEY = "pi-draft:host-agent";
  const chatButton = (id, chat) => `[data-project-id="${id}"][data-chat="${chat}"]`;

  const open = async (target, wrap = true) => {
    await target.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`, "ready");
    await target.waitFor(`document.querySelector('#feed').innerText.includes("seed A MARK-SEED-A")`, "A transcript");
    if (wrap) await target.evaluate(wrapFetch);
  };
  const page = await kit.openPage(url);
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: logWrites });
  await page.reload();
  await open(page);
  const tab = (target) => ({
    stored: async (k) => JSON.parse((await target.evaluate(`localStorage.getItem(${JSON.stringify(k)})`)) ?? "null")?.text ?? null,
    composer: () => target.evaluate(`document.querySelector('#composer-input').value`),
    caret: () => target.evaluate(`document.querySelector('#composer-input').selectionStart`),
    writes: async () => JSON.parse((await target.evaluate(`sessionStorage.getItem("__draftWrites")`)) ?? "[]"),
    clearWrites: () => target.evaluate(`sessionStorage.removeItem("__draftWrites")`),
    type: async (text, selector = "#composer-input") => {
      await target.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await target.cdp("Input.insertText", { text });
    },
    empty: () =>
      target.evaluate(
        `(() => { const box = document.querySelector('#composer-input'); box.value = ""; box.dispatchEvent(new Event("input")); })()`,
      ),
    send: () => target.evaluate(`document.querySelector('#composer').requestSubmit()`),
    reply: (text) =>
      target.waitFor(`document.querySelector('#feed').innerText.includes(${JSON.stringify(`ACK ${text}`)})`, `reply to ${text}`),
    chat: async (id, chat) => {
      await target.evaluate(
        `(() => { if (!document.querySelector(${JSON.stringify(chatButton(id, chat))})) document.querySelector('[data-project="${id}"]').click(); })()`,
      );
      await target.waitFor(`!!document.querySelector(${JSON.stringify(chatButton(id, chat))})`, `row of ${chat}`);
      await target.evaluate(`document.querySelector(${JSON.stringify(chatButton(id, chat))}).click()`);
      await target.waitFor(
        `document.querySelector(${JSON.stringify(chatButton(id, chat))}).getAttribute("aria-current") === "true"`,
        `chat ${chat}`,
      );
    },
    owners: (text) =>
      target.evaluate(
        `[...document.querySelectorAll('#feed .msg.owner')].filter((n) => n.innerText.includes(${JSON.stringify(text)})).map((n) => ({ delivery: n.dataset.delivery ?? "", retry: !!n.querySelector("[data-pending-retry]") }))`,
      ),
  });
  const a = tab(page);
  const extra = [];
  const newTab = async () => {
    const created = await page.newTab(url);
    extra.push(created);
    return created;
  };
  // Every section starts from a clean page of its own: no drafts, no pending handles, no second tabs.
  const section = async (name, body) => {
    for (const created of extra.splice(0)) await created.close().catch(() => {});
    await page.evaluate(
      `(() => { for (const k of Object.keys(localStorage)) if (k.includes("pi-draft:") || k.startsWith("pi-pending-send")) localStorage.removeItem(k); sessionStorage.removeItem("__draftWrites"); })()`,
    );
    await page.reload();
    await open(page);
    await a.chat(A, "main");
    if (!soft) return body();
    try {
      await body();
    } catch (error) {
      console.log(`RED ${name}: ${String(error.message).split("\n")[0].slice(0, 200)}`);
    }
  };

  // D1-D4, D6: every chat keeps its own text; switching writes nothing.
  await section("switching", async () => {
    await a.chat(A, "main");
    await a.type("alpha main");
    await a.chat(A, other);
    check("D1 another chat of the project starts empty", (await a.composer()) === "", await a.composer());
    await a.type("beta other");
    await a.chat(B, "main");
    check("D4 the same chat id in another project starts empty", (await a.composer()) === "", await a.composer());
    await a.type("gamma projB");
    await a.chat(A, other);
    check("D1 the other chat's own draft is back", (await a.composer()) === "beta other", await a.composer());
    await a.chat(A, "main");
    check("D1 main's own draft is back", (await a.composer()) === "alpha main", await a.composer());
    await page.evaluate(`document.querySelector('#composer-input').setSelectionRange(5, 5)`);
    await a.chat(A, other);
    await a.chat(A, "main");
    check("D2 the caret is where the owner left it", (await a.composer()) === "alpha main" && (await a.caret()) === 5, await a.caret());
    await page.shot("switch-main-with-draft", { force: true });
    await a.chat(A, other);
    await page.shot("switch-other-with-draft", { force: true });
    await a.chat(A, "main");
    check(
      "D3 drafts are stored under their own host, project and chat",
      (await a.stored(key(A, "main"))) === "alpha main" && (await a.stored(key(B, "main"))) === "gamma projB",
    );
    const typedWrites = await a.writes();
    await a.clearWrites();
    await page.reload();
    await open(page);
    check("D3 a reload keeps the draft of the open chat", (await a.composer()) === "alpha main", await a.composer());
    await a.chat(A, other);
    check("D3 and of the other chat", (await a.composer()) === "beta other", await a.composer());
    await a.chat(B, "main");
    check("D3 and of the other project", (await a.composer()) === "gamma projB", await a.composer());
    await a.chat(A, "main");
    check("D6 typing wrote, but switching and reloading wrote nothing", typedWrites.length >= 3 && (await a.writes()).length === 0, {
      typedWrites,
      writes: await a.writes(),
    });
    const beforeEmptying = await a.stored(key(A, "main"));
    await a.empty();
    check(
      "D15 emptying the field removes the draft",
      beforeEmptying === "alpha main" && (await a.stored(key(A, "main"))) === null,
      beforeEmptying,
    );
    await a.chat(A, other);
    await a.empty();
    await a.chat(B, "main");
    await a.empty();
    await a.chat(A, "main");
  });
  // D5, D6: an idle second tab never touches the draft of the first.
  await section("idle tab", async () => {
    await a.type("tab text");
    const tabB = await newTab();
    const b = tab(tabB);
    await tabB.cdp("Page.addScriptToEvaluateOnNewDocument", { source: logWrites });
    await tabB.reload();
    await open(tabB);
    check("D3 a second tab opens the stored draft", (await b.composer()) === "tab text", await b.composer());
    await b.chat(A, other);
    await b.chat(A, "main");
    await tabB.reload();
    await open(tabB);
    const loaded = await b.composer();
    await a.type(" more");
    const idleWrites = await b.writes();
    await tabB.close();
    check(
      "D5 a tab that only looked leaves the draft the other tab typed",
      (await a.stored(key(A, "main"))) === "tab text more",
      await a.stored(key(A, "main")),
    );
    check("D6 the idle tab loaded the draft and wrote nothing", loaded === "tab text" && idleWrites.length === 0, { loaded, idleWrites });
    await a.empty();
  });
  // D10, D9: a sent text is not a draft while it is in flight, and goes when the host admits it.
  await section("in flight", async () => {
    await a.type("solo MARK-SOLO");
    await page.evaluate(`__hold("message")`);
    await a.send();
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending solo");
    await a.chat(A, other);
    await a.chat(A, "main");
    check(
      "D10 the text being sent is not shown as a draft after a switch, and stays stored until the host admits it",
      (await a.composer()) === "" && (await a.stored(key(A, "main"))) === "solo MARK-SOLO",
      await a.composer(),
    );
    const inFlight = await a.stored(key(A, "main"));
    await page.reload();
    await open(page, false);
    check(
      "D10 nor after a reload",
      (await a.composer()) === "" && (await a.stored(key(A, "main"))) === "solo MARK-SOLO",
      await a.composer(),
    );
    await page.waitFor(`!!document.querySelector('#feed [data-pending-retry]')`, "unconfirmed bubble after reload");
    await page.evaluate(wrapFetch);
    await page.evaluate(`document.querySelector('#feed [data-pending-retry]').click()`);
    await a.reply("solo MARK-SOLO");
    check(
      "D9 the admitted message's draft is gone",
      inFlight === "solo MARK-SOLO" && (await a.owners("MARK-SOLO")).length === 1 && (await a.stored(key(A, "main"))) === null,
      await a.stored(key(A, "main")),
    );
  });
  // D7: A sends "base" while B has stored a newer draft: B's draft stays.
  await section("two tabs send", async () => {
    await a.type("base");
    const tabB2 = await newTab();
    const b2 = tab(tabB2);
    await open(tabB2);
    await b2.type(" more");
    await page.evaluate(`__hold("message")`);
    await a.send();
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending base");
    await page.evaluate(`__release("message")`);
    await a.reply("base");
    check(
      "D7 the newer draft of the other tab survives A's send",
      (await a.stored(key(A, "main"))) === "base more",
      await a.stored(key(A, "main")),
    );
    await b2.empty();

    // D8: the comparison is exact, no trimming.
    await a.type("hello");
    await tabB2.reload();
    await open(tabB2);
    check("D3 tab B shows the draft A typed", (await b2.composer()) === "hello", await b2.composer());
    await tabB2.evaluate(`(() => { const box = document.querySelector('#composer-input'); box.focus(); box.setSelectionRange(5, 5); })()`);
    await tabB2.cdp("Input.insertText", { text: " " });
    await a.send();
    await a.reply("hello");
    check(
      "D8 a draft that differs only by a trailing space survives",
      (await a.stored(key(A, "main"))) === "hello ",
      JSON.stringify(await a.stored(key(A, "main"))),
    );
    await b2.empty();
    await tabB2.close();
    await a.send();
  });
  // D12, D14: a refusal gives the text back to an empty composer, and it survives a reload; Dismiss takes the unedited draft.
  await section("refusal", async () => {
    await page.evaluate(`__rule("message", { fail: "json" })`);
    await a.type("refuse solo MARK-R1");
    await a.send();
    await page.waitFor(`[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`, "failed bubble");
    check(
      "D12 the refused text is back in the composer and stored as the chat's draft",
      (await a.composer()) === "refuse solo MARK-R1" && (await a.stored(key(A, "main"))) === "refuse solo MARK-R1",
      { composer: await a.composer(), stored: await a.stored(key(A, "main")) },
    );
    await page.reload();
    await open(page);
    check("D12 a reload keeps the restored text", (await a.composer()) === "refuse solo MARK-R1", await a.composer());
    await a.empty();

    await page.evaluate(`__rule("message", { fail: "json" })`);
    await a.type("refuse dismiss MARK-R2");
    await a.send();
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`,
      "failed bubble 2",
    );
    const restored = await a.stored(key(A, "main"));
    await page.evaluate(`document.querySelector('#feed [data-pending-dismiss]').click()`);
    check(
      "D14 Dismiss removes the unedited draft with its bubble",
      restored === "refuse dismiss MARK-R2" && (await a.stored(key(A, "main"))) === null && (await a.composer()) === "",
      await a.stored(key(A, "main")),
    );
  });
  // D11, D13: a refusal does not overwrite the newer draft of another tab; the bubble keeps the text.
  await section("refusal against a newer draft", async () => {
    await a.type("refuse two MARK-R3");
    const tabB3 = await newTab();
    const b3 = tab(tabB3);
    await open(tabB3);
    await page.evaluate(`__hold("message")`);
    await page.evaluate(`__rule("message", { fail: "json" })`);
    await a.send();
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending refuse two");
    await b3.type(" NEWER");
    await page.evaluate(`__release("message")`);
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`,
      "failed bubble 3",
    );
    check(
      "D11 the newer draft of the other tab was not overwritten",
      (await a.stored(key(A, "main"))) === "refuse two MARK-R3 NEWER",
      await a.stored(key(A, "main")),
    );
    check("D11 and the refused text is not forced into the composer", (await a.composer()) === "", await a.composer());
    check(
      "D13 the refused text stays on its bubble with Retry",
      (await a.owners("MARK-R3")).some((item) => item.retry),
      await a.owners("MARK-R3"),
    );
    await tabB3.close();
    await page.reload();
    await open(page);
    await page.waitFor(`!!document.querySelector('#feed [data-pending-retry]')`, "Retry bubble after reload");
    check("D13 the bubble with the refused text survives a reload", (await a.owners("MARK-R3")).length === 1);
    check("D11 the newer draft is in the composer", (await a.composer()) === "refuse two MARK-R3 NEWER", await a.composer());
    await page.evaluate(`document.querySelector('#feed [data-pending-dismiss]').click()`);
    check(
      "D14 Dismiss leaves a draft that differs from the bubble",
      (await a.stored(key(A, "main"))) === "refuse two MARK-R3 NEWER",
      await a.stored(key(A, "main")),
    );
    await a.empty();
  });
  // D16, D17: a confirmed archive removes the chat's draft, a cancelled one does not.
  await section("archive", async () => {
    const archive = async (chat, confirm) => {
      await page.evaluate(`document.querySelector('[data-archive-chat="${chat}"]').click()`);
      await page.waitFor(`document.querySelector('#archive-chat').open`, "archive dialog");
      await page.evaluate(
        `document.querySelector('#archive-chat ${confirm ? "[data-archive-confirm]" : "[data-archive-cancel]"}').click()`,
      );
      await page.waitFor(`!document.querySelector('#archive-chat').open`, "dialog closed");
    };
    await a.chat(A, third);
    await a.type("third draft");
    await a.chat(A, "main");
    await archive(third, false);
    check("D17 a cancelled archive keeps the draft", (await a.stored(key(A, third))) === "third draft", await a.stored(key(A, third)));
    const beforeArchive = await a.stored(key(A, third));
    await archive(third, true);
    await page.waitFor(`!document.querySelector('${chatButton(A, third)}')`, "third archived");
    check(
      "D16 an archived chat's draft is gone",
      beforeArchive === "third draft" && (await a.stored(key(A, third))) === null,
      await a.stored(key(A, third)),
    );
  });
  // D18: a browser that cannot store the draft says so and keeps the older text.
  await section("quota", async () => {
    await a.type("keepme");
    await page.evaluate(`window.__deny = true`);
    await a.type(" and more");
    await page.waitFor(`document.body.innerText.includes("cannot keep that much text")`, "the owner is told");
    check("D18 the older stored text is not deleted", (await a.stored(key(A, "main"))) === "keepme", await a.stored(key(A, "main")));
    check("D18 the typed text stays in the box", (await a.composer()) === "keepme and more", await a.composer());
    await page.evaluate(`window.__deny = false`);
    await a.empty();
  });
  // D19, D20: the Host agent composer has one draft per host.
  await section("host agent", async () => {
    const settings = await rpc({ action: "host-agent-settings" });
    await rpc({ action: "host-agent-settings", revision: settings.revision, patch: { model: "fake/fake-model" } });
    const openAgent = async (target) => {
      await target.evaluate(`document.querySelector('[data-cmd="host-agent"]').click()`);
      await target.waitFor(
        `document.querySelector('#host-agent').dataset.open === "1" && getComputedStyle(document.querySelector('#host-agent')).visibility === "visible" && !document.querySelector('#ha-composer textarea').disabled`,
        "host agent open",
      );
    };
    const agentBox = (target) => target.evaluate(`document.querySelector('#ha-composer textarea').value`);
    await openAgent(page);
    await a.type("ask the host MARK-HA", "#ha-composer textarea");
    check(
      "D19 the Host agent draft is stored once per host",
      (await a.stored(HOST_KEY)) === "ask the host MARK-HA",
      await a.stored(HOST_KEY),
    );
    check("D19 and is not a chat's draft", (await a.stored(HOST_KEY)) !== null && (await a.stored(key(A, "main"))) === null);
    await page.reload();
    await open(page);
    await openAgent(page);
    check("D19 a reload keeps the Host agent draft", (await agentBox(page)) === "ask the host MARK-HA", await agentBox(page));
    check(
      "D19 and the chat composer stays its own",
      (await agentBox(page)) === "ask the host MARK-HA" && (await a.composer()) === "",
      await a.composer(),
    );
    // Chrome allows six connections per origin: the open drawer's live stream and a second tab's views would exceed it.
    await page.evaluate(`document.querySelector('#host-agent [data-cmd="host-agent"]').click()`);
    const tabB4 = await newTab();
    await open(tabB4);
    await openAgent(tabB4);
    await tab(tabB4).type(" NEWER", "#ha-composer textarea");
    await tabB4.evaluate(`document.querySelector('#host-agent [data-cmd="host-agent"]').click()`);
    await page.evaluate(`document.querySelector('#ha-composer').requestSubmit()`);
    await page.waitFor(
      `document.querySelector('#ha-composer textarea').value === "" && !document.querySelector('#ha-composer').dataset.sending`,
      "host agent sent",
    );
    await kit.delay(300);
    check(
      "D20 a newer Host agent draft of another tab survives the send",
      (await a.stored(HOST_KEY)) === "ask the host MARK-HA NEWER",
      await a.stored(HOST_KEY),
    );
    const emptyHostAgent = async () => {
      await tabB4.evaluate(
        `(() => { const box = document.querySelector('#ha-composer textarea'); box.value = ""; box.dispatchEvent(new Event("input")); })()`,
      );
      return a.stored(HOST_KEY);
    };
    check(
      "D15 emptying the Host agent field removes the draft",
      (await a.stored(HOST_KEY)) === "ask the host MARK-HA NEWER" && (await emptyHostAgent()) === null,
    );
    await tabB4.close();
    await openAgent(page);
    await a.type("plain ask MARK-HA2", "#ha-composer textarea");
    const typedAsk = await a.stored(HOST_KEY);
    await page.evaluate(`document.querySelector('#ha-composer').requestSubmit()`);
    await page.waitFor(`document.querySelector('#ha-composer textarea').value === ""`, "host agent sent 2");
    await kit.delay(500);
    check(
      "D20 a successful Host agent send removes its draft",
      typedAsk === "plain ask MARK-HA2" && (await a.stored(HOST_KEY)) === null,
      await a.stored(HOST_KEY),
    );
  });
});
