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
    if (rule.fail === "refuse") {
      delete rule.fail;
      return new Response(JSON.stringify({ ok: false, error: "refused for the test", refused: true }), { status: 409 });
    }
    return real(url, init);
  };
})()`;
// Every draft write and removal of a page, kept in sessionStorage so it survives a reload; a tab's only legitimate cause is its own input event.
const logWrites = `(() => {
  const note = (kind, key) => { if (String(key).includes("pi-draft:")) sessionStorage.setItem("__draftWrites", JSON.stringify([...JSON.parse(sessionStorage.getItem("__draftWrites") ?? "[]"), kind + " " + key])); };
  const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, get = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    const value = get.call(this, key);
    if (window.__spin && String(key).includes("pi-draft:")) {
      window.__spin = false;
      set.call(this, "__spinning", "1");
      for (const end = Date.now() + 1500; Date.now() < end; );
    }
    return value;
  };
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
      await kit.delay(80);
    },
    empty: async () => {
      await target.evaluate(
        `(() => { const box = document.querySelector('#composer-input'); box.value = ""; box.dispatchEvent(new Event("input")); })()`,
      );
      await kit.delay(80);
    },
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
      `(() => { for (const k of Object.keys(localStorage)) if (k.includes("pi-draft:") || k.startsWith("pi-pending-send") || k.startsWith("pi-send-settled") || k === "__spinning") localStorage.removeItem(k); sessionStorage.removeItem("__draftWrites"); })()`,
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
  // D25: another tab writes between A's check and A's delete; every read-modify-write of a key takes turns across tabs.
  await section("atomic cleanup", async () => {
    await a.type("base");
    const tabB6 = await newTab();
    const b6 = tab(tabB6);
    await open(tabB6);
    check("D3 tab B shows the draft A typed", (await b6.composer()) === "base", await b6.composer());
    await page.evaluate(`__hold("message")`);
    await a.send();
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending base for D25");
    await page.evaluate(`window.__spin = true; __release("message")`);
    await tabB6.waitFor(`localStorage.getItem("__spinning") === "1"`, "A is between its check and its delete");
    await b6.type(" more");
    await a.reply("base");
    await kit.delay(500);
    check(
      "D25 a draft written between the check and the delete survives",
      (await a.stored(key(A, "main"))) === "base more",
      await a.stored(key(A, "main")),
    );
    await tabB6.close();
    await a.empty();
    // The input path takes its turn: while another tab holds the key, typing waits, and the later text is the one written.
    const holder = await newTab();
    await open(holder);
    await holder.evaluate(
      `void navigator.locks.request(${JSON.stringify(`pi-draft-lock:${key(A, "main")}`)}, () => new Promise((end) => { window.__unlock = end; }))`,
    );
    await holder.waitFor(`!!window.__unlock`, "lock held by the other tab");
    await a.type("x");
    // The other tab queues its own write between A's two inputs: A's later input must still land last.
    await holder.evaluate(
      `void navigator.locks.request(${JSON.stringify(`pi-draft-lock:${key(A, "main")}`)}, () => localStorage.setItem(${JSON.stringify(key(A, "main"))}, JSON.stringify({ text: "between" })))`,
    );
    await a.type("y");
    check("D25 typing waits while another tab holds the key", (await a.stored(key(A, "main"))) === null, await a.stored(key(A, "main")));
    await holder.evaluate(`window.__unlock()`);
    await page.waitFor(`localStorage.getItem(${JSON.stringify(key(A, "main"))}) !== null`, "typed text written");
    await kit.delay(300);
    check(
      "D25 the later input is the one stored, after the other tab's queued write",
      (await a.stored(key(A, "main"))) === "xy",
      await a.stored(key(A, "main")),
    );
    await holder.close();
    await a.empty();
  });
  // D27: a second tab's copy of a pending send settles it once more only on paper.
  await section("settled once", async () => {
    await a.type("same MARK-SAME");
    await page.evaluate(`__hold("message")`);
    await a.send();
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending same");
    const tabB7 = await newTab();
    const b7 = tab(tabB7);
    await open(tabB7);
    await tabB7.waitFor(`!!document.querySelector('#feed [data-pending-retry]')`, "B's copy of the pending send");
    await tabB7.evaluate(`__hold("show")`);
    await page.evaluate(`__release("message")`);
    await a.reply("same MARK-SAME");
    await page.waitFor(`localStorage.getItem(${JSON.stringify(key(A, "main"))}) === null`, "A's draft settled");
    await a.type("same MARK-SAME");
    const fresh = await a.stored(key(A, "main"));
    await tabB7.evaluate(`__release("show")`);
    await tabB7.waitFor(`!document.querySelector('#feed .msg.owner.pending')`, "B's copy settled");
    await kit.delay(500);
    check(
      "D27 the same send settles once across tabs: the fresh identical draft stays",
      fresh === "same MARK-SAME" && (await a.stored(key(A, "main"))) === "same MARK-SAME" && (await b7.owners("MARK-SAME")).length === 1,
      await a.stored(key(A, "main")),
    );
    await tabB7.close();
    await a.empty();
  });
  // D28: a pending handle stored before sends named their host fails closed on Retry instead of going to the selected host.
  await section("handle without a host", async () => {
    await page.evaluate(
      `localStorage.setItem("pi-pending-send:00000000-0000-4000-8000-00000000d028", JSON.stringify({ id: "00000000-0000-4000-8000-00000000d028", projectId: ${JSON.stringify(A)}, chatId: "main", text: "hostless MARK-HOSTLESS" }))`,
    );
    await page.reload();
    await open(page);
    await page.waitFor(`!!document.querySelector('#feed [data-pending-retry]')`, "hostless bubble");
    await page.evaluate(`document.querySelector('#feed [data-pending-retry]').click()`);
    await page.waitFor(`document.body.innerText.includes("does not know the host")`, "fail-closed toast");
    check(
      "D28 a handle without its host is never sent",
      (await page.evaluate(`window.__calls.filter((c) => c.action === "message").length`)) === 0 &&
        (await a.owners("MARK-HOSTLESS")).length === 1,
      await page.evaluate(`window.__calls`),
    );
    await page.evaluate(`document.querySelector('#feed [data-pending-dismiss]').click()`);
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
    check("D12 the bubble stays until Dismiss, even after the field was emptied", (await a.owners("MARK-R1")).length === 1);
    await page.evaluate(`document.querySelector('#feed [data-pending-dismiss]').click()`);

    await page.evaluate(`__rule("message", { fail: "json" })`);
    await a.type("refuse dismiss MARK-R2");
    await a.send();
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`,
      "failed bubble 2",
    );
    const restored = await a.stored(key(A, "main"));
    await page.evaluate(
      `[...document.querySelectorAll('#feed .msg.owner.pending')].find((n) => n.innerText.includes("MARK-R2")).querySelector('[data-pending-dismiss]').click()`,
    );
    check(
      "D14 Dismiss removes the unedited draft with its bubble",
      restored === "refuse dismiss MARK-R2" && (await a.stored(key(A, "main"))) === null && (await a.composer()) === "",
      await a.stored(key(A, "main")),
    );
  });
  // D24: another tab typing over the restored text must not cost the refused message.
  await section("refusal then another tab writes", async () => {
    await page.evaluate(`__rule("message", { fail: "json" })`);
    await a.type("refuse four MARK-R4");
    await a.send();
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`,
      "failed bubble 4",
    );
    const tabB5 = await newTab();
    await open(tabB5);
    await tab(tabB5).type(" B-WROTE");
    await tabB5.close();
    await page.reload();
    await open(page);
    check(
      "D24 the refused message is still on a Retry bubble after a reload",
      (await a.stored(key(A, "main"))) === "refuse four MARK-R4 B-WROTE" && (await a.owners("MARK-R4")).some((item) => item.retry),
      { stored: await a.stored(key(A, "main")), owners: await a.owners("MARK-R4") },
    );
  });
  // D30: whether the bubble offers Retry follows what the composer holds now, not what it held when the refusal came back.
  await section("refusal retry follows the composer", async () => {
    await page.evaluate(`__rule("message", { fail: "json" })`);
    await a.type("refuse five MARK-R5");
    await a.send();
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`,
      "failed bubble 5",
    );
    check(
      "D30 while the composer holds the refused text, the bubble has no Retry",
      (await a.composer()) === "refuse five MARK-R5" && !(await a.owners("MARK-R5")).some((item) => item.retry),
      await a.owners("MARK-R5"),
    );
    await a.chat(A, other);
    const tabB9 = await newTab();
    const b9 = tab(tabB9);
    await open(tabB9);
    await b9.empty();
    await b9.type("other text MARK-B9");
    await tabB9.close();
    await a.chat(A, "main");
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner[data-delivery="failed"]').length === 1`, "failed bubble after return");
    check(
      "D30 once the composer shows another tab's text, the refused bubble has Retry",
      (await a.composer()) === "other text MARK-B9" && (await a.owners("MARK-R5")).some((item) => item.retry),
      { composer: await a.composer(), owners: await a.owners("MARK-R5") },
    );
    await a.empty();
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
    await page.evaluate(
      `[...document.querySelectorAll('#feed .msg.owner.pending')].find((n) => n.innerText.includes("MARK-R3")).querySelector('[data-pending-dismiss]').click()`,
    );
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
    await page.waitFor(`document.body.innerText.includes("Draft not saved")`, "the owner is told");
    check("D18 the older stored text is not deleted", (await a.stored(key(A, "main"))) === "keepme", await a.stored(key(A, "main")));
    check("D18 the typed text stays in the box", (await a.composer()) === "keepme and more", await a.composer());
    await a.chat(A, other);
    await a.chat(A, "main");
    check("D18 the unsaved text is still in the box after a switch", (await a.composer()) === "keepme and more", await a.composer());
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
      await kit.delay(150);
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
  // D26, D29, D18: a refused Host agent text goes back into its composer and its stored draft, merged with whatever is there, never replacing it.
  await section("host agent refusal", async () => {
    const settings = await rpc({ action: "host-agent-settings" });
    await rpc({ action: "host-agent-settings", revision: settings.revision, patch: { model: "fake/fake-model" } });
    const openAgent = async (target) => {
      await target.evaluate(`document.querySelector('[data-cmd="host-agent"]').click()`);
      await target.waitFor(
        `document.querySelector('#host-agent').dataset.open === "1" && getComputedStyle(document.querySelector('#host-agent')).visibility === "visible" && !document.querySelector('#ha-composer textarea').disabled`,
        "host agent open",
      );
    };
    const closeAgent = (target) => target.evaluate(`document.querySelector('#host-agent [data-cmd="host-agent"]').click()`);
    const box = (target) => target.evaluate(`document.querySelector('#ha-composer textarea').value`);
    const emptyAgent = async (target) => {
      await target.evaluate(
        `(() => { const agent = document.querySelector('#ha-composer textarea'); agent.value = ""; agent.dispatchEvent(new Event("input")); })()`,
      );
      await kit.delay(150);
    };
    const submitAgent = (target) => target.evaluate(`document.querySelector('#ha-composer').requestSubmit()`);
    const settled = (target) => target.waitFor(`!document.querySelector('#ha-composer').dataset.sending`, "host agent send settled");
    const sentTexts = () => page.evaluate(`window.__calls.filter((c) => c.action === "host-agent-send").map((c) => c.text)`);

    // D26: A is refused after the owner typed B: the composer and the draft hold both, and the next send carries A.
    await openAgent(page);
    await a.type("first ask MARK-HAA", "#ha-composer textarea");
    await page.evaluate(`__hold("host-agent-send"); __rule("host-agent-send", { fail: "refuse" })`);
    await submitAgent(page);
    await page.waitFor(`document.querySelector('#ha-composer').dataset.sending === "1"`, "host agent sending");
    await a.type("second ask MARK-HAB", "#ha-composer textarea");
    await page.evaluate(`__release("host-agent-send")`);
    await settled(page);
    await kit.delay(150);
    const merged = "second ask MARK-HAB\n\nfirst ask MARK-HAA";
    check("D26 the refused text is appended below the newer text in the composer", (await box(page)) === merged, await box(page));
    check("D26 and stored as the draft", (await a.stored(HOST_KEY)) === merged, await a.stored(HOST_KEY));
    check(
      "D26 the composer grows to show both texts",
      await page.evaluate(
        `(() => { const agent = document.querySelector('#ha-composer textarea'); return agent.scrollHeight <= agent.clientHeight + 1; })()`,
      ),
    );
    await page.shot("host-agent-refused-merged", { force: true });
    await page.reload();
    await open(page);
    await openAgent(page);
    check("D26 a reload keeps both texts", (await box(page)) === merged, await box(page));
    await submitAgent(page);
    await settled(page);
    await kit.delay(300);
    check(
      "D26 sending after the refusal carries the refused text, and the draft goes",
      (await sentTexts()).at(-1)?.includes("MARK-HAA") && (await a.stored(HOST_KEY)) === null,
      { sent: await sentTexts(), stored: await a.stored(HOST_KEY) },
    );
    check("D26 the Host agent has no separate refused-text row", await page.evaluate(`!document.querySelector('#ha-refused')`));

    // D29: another tab stored a newer draft before the refusal: both texts are kept, the newer one first.
    await a.type("alpha MARK-HAR", "#ha-composer textarea");
    await closeAgent(page);
    const tabB8 = await newTab();
    await open(tabB8);
    await openAgent(tabB8);
    await emptyAgent(tabB8);
    await tab(tabB8).type("beta MARK-HAN", "#ha-composer textarea");
    await closeAgent(tabB8);
    await tabB8.close();
    await openAgent(page);
    await page.evaluate(`__rule("host-agent-send", { fail: "refuse" })`);
    await submitAgent(page);
    await settled(page);
    await kit.delay(150);
    check("D29 the refused text goes back to the emptied composer", (await box(page)) === "alpha MARK-HAR", await box(page));
    check(
      "D29 the stored draft keeps the other tab's newer text and adds the refused one",
      (await a.stored(HOST_KEY)) === "beta MARK-HAN\n\nalpha MARK-HAR",
      await a.stored(HOST_KEY),
    );
    await emptyAgent(page);

    // D29: the restore waits for its turn; an edit the owner makes meanwhile is written after it and is what stays.
    await a.type("gamma MARK-HAG", "#ha-composer textarea");
    await page.evaluate(`__hold("host-agent-send"); __rule("host-agent-send", { fail: "refuse" })`);
    await submitAgent(page);
    await page.waitFor(`window.__calls.some((c) => c.action === "host-agent-send" && c.text === "gamma MARK-HAG")`, "gamma on its way");
    await page.evaluate(
      `void navigator.locks.request(${JSON.stringify(`pi-draft-lock:${HOST_KEY}`)}, () => new Promise((end) => { window.__unlockAgent = end; }))`,
    );
    await page.waitFor(`!!window.__unlockAgent`, "Host agent draft lock held");
    await page.evaluate(`__release("host-agent-send")`);
    await page.waitFor(`document.querySelector('#ha-composer textarea').value === "gamma MARK-HAG"`, "refused text back in the box");
    await a.type("!", "#ha-composer textarea");
    await page.evaluate(`window.__unlockAgent(); delete window.__unlockAgent`);
    await settled(page);
    await kit.delay(300);
    check(
      "D29 an edit made while the restore waited is the stored draft, with nothing added twice",
      (await a.stored(HOST_KEY)) === "gamma MARK-HAG!" && (await box(page)) === "gamma MARK-HAG!",
      { stored: await a.stored(HOST_KEY), box: await box(page) },
    );
    await emptyAgent(page);

    // D26: the owner typed the same text again while it was being sent: the refusal adds it, it does not fold into the new copy.
    await a.type("twice MARK-HAT", "#ha-composer textarea");
    await page.evaluate(`__hold("host-agent-send"); __rule("host-agent-send", { fail: "refuse" })`);
    await submitAgent(page);
    await page.waitFor(`document.querySelector('#ha-composer').dataset.sending === "1"`, "host agent sending twice");
    await a.type("twice MARK-HAT", "#ha-composer textarea");
    await page.evaluate(`__release("host-agent-send")`);
    await settled(page);
    await kit.delay(150);
    check(
      "D26 a refused text the owner retyped meanwhile is kept twice",
      (await box(page)) === "twice MARK-HAT\n\ntwice MARK-HAT" && (await a.stored(HOST_KEY)) === "twice MARK-HAT\n\ntwice MARK-HAT",
      { box: await box(page), stored: await a.stored(HOST_KEY) },
    );
    await emptyAgent(page);

    // D29: another tab types the very text being sent: that is a new draft, and the refusal adds the sent one to it.
    await a.type("same again MARK-HAS", "#ha-composer textarea");
    await page.evaluate(`__hold("host-agent-send"); __rule("host-agent-send", { fail: "refuse" })`);
    await submitAgent(page);
    await page.waitFor(`document.querySelector('#ha-composer').dataset.sending === "1"`, "host agent sending same");
    await closeAgent(page);
    const tabB10 = await newTab();
    await open(tabB10);
    await openAgent(tabB10);
    await emptyAgent(tabB10);
    await tab(tabB10).type("same again MARK-HAS", "#ha-composer textarea");
    await closeAgent(tabB10);
    await tabB10.close();
    await page.evaluate(`__release("host-agent-send")`);
    await settled(page);
    await kit.delay(150);
    check(
      "D29 a text another tab typed that reads the same as the refused one is kept apart from it",
      (await a.stored(HOST_KEY)) === "same again MARK-HAS\n\nsame again MARK-HAS",
      await a.stored(HOST_KEY),
    );
    await openAgent(page);
    await emptyAgent(page);

    // D18: a refusal while the browser cannot store drafts keeps the text in the composer and says so.
    await page.evaluate(`window.__deny = true`);
    await a.type("full MARK-HAF", "#ha-composer textarea");
    await kit.delay(150);
    await page.evaluate(`document.querySelector('#toasts').replaceChildren()`);
    await page.evaluate(`__rule("host-agent-send", { fail: "refuse" })`);
    await submitAgent(page);
    await settled(page);
    await kit.delay(150);
    check(
      "D18 a refused Host agent text stays in the composer when storage is full",
      (await box(page)) === "full MARK-HAF",
      await box(page),
    );
    check(
      "D18 and the owner sees the warning",
      await page.evaluate(`document.querySelector('#toasts').innerText.includes("Draft not saved")`),
      await page.evaluate(`document.querySelector('#toasts').innerText`),
    );
    await page.evaluate(`window.__deny = false`);
    await emptyAgent(page);
  });
});
