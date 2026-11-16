// E2E: Pi input keys in the browser composer (failure cases 11-14 in scripts/chat-queue-failures.md). Private host, fake model, headless Chrome.
import { createKit, say } from "./lib/e2e-kit.mjs";

let release, release2;
const hold = new Promise((ok) => (release = ok));
const hold2 = new Promise((ok) => (release2 = ok));
const kit = await createKit("chat-input-keys", {
  handler: ({ role, user }) => {
    if (role !== "coordinator") return undefined;
    if (user.includes("HOLD"))
      return (async function* () {
        await hold;
        yield say("released");
      })();
    if (user.includes("GATE2"))
      return (async function* () {
        await hold2;
        yield say("released 2");
      })();
    return say("ACK");
  },
});

await kit.run(async () => {
  const { rpc, check, eventually } = kit;
  kit.initRepo();
  const id = await kit.createProject("Input keys");
  const page = await kit.openPage(await kit.webUrl(id));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  const input = `document.querySelector("#composer-input")`;
  const type = (text) =>
    page.evaluate(
      `(() => { const box = ${input}; box.focus(); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
  const key = async (name, code, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await page.cdp("Input.dispatchKeyEvent", { type, key: name, code, windowsVirtualKeyCode, modifiers });
  };
  const ENTER = () => key("Enter", "Enter", 13),
    ALT_ENTER = () => key("Enter", "Enter", 13, 1),
    ALT_UP = () => key("ArrowUp", "ArrowUp", 38, 1);
  const pending = () =>
    page.evaluate(`[...document.querySelectorAll("#pending .pending-row")].map((row) => row.innerText.replace(/\\s+/g, " ").trim())`);
  const visible = (selector) =>
    page.evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return !!node && !node.hidden && node.getClientRects().length > 0; })()`,
    );

  // 14: idle, Alt+Enter is a plain message and Alt+Up restores nothing.
  check("13 the touch buttons are hidden while idle", !(await visible("#followup-btn")) && !(await visible("#dequeue-btn")));
  await type("HOLD first");
  await ENTER();
  await eventually(async () => (await rpc({ action: "show", id })).chats.find((chat) => chat.id === "main")?.busy, "turn running");
  await page.waitFor(`!document.querySelector("#followup-btn").hidden`, "follow-up button shows while running");
  check("13 while a turn runs only the follow-up button shows; the edit button needs a queue", !(await visible("#dequeue-btn")));

  // 11: Enter steers, Alt+Enter follows up; the pending list shows steering first.
  await type("FOLLOW-ONE later");
  await ALT_ENTER();
  await page.waitFor(`document.querySelectorAll("#pending .pending-row").length === 1`, "follow-up pending");
  await type("STEER-ONE now");
  await ENTER();
  await page.waitFor(`document.querySelectorAll("#pending .pending-row").length === 2`, "steer pending");
  const rows = await pending();
  check(
    "11 pending lists Steering before Follow-up",
    /^Steering: STEER-ONE/.test(rows[0] ?? "") && /^Follow-up: FOLLOW-ONE/.test(rows[1] ?? ""),
    rows,
  );
  const modes = (await rpc({ action: "show", id })).jobs
    .filter((job) => job.state === "queued")
    .map((job) => job.delivery)
    .sort()
    .join();
  check("11 the host ledger keeps both modes", modes === "followUp,steer", modes);
  await page.shot("01-pending", { force: true });

  // 12: Alt+Up brings everything back, steering first, ahead of the draft.
  await type("my draft");
  await ALT_UP();
  await page.waitFor(`${input}.value.includes("STEER-ONE")`, "restored to the editor");
  const restored = await page.evaluate(`${input}.value`);
  check(
    "12 Alt+Up restores steering, follow-up and keeps the draft",
    restored === "STEER-ONE now\n\nFOLLOW-ONE later\n\nmy draft",
    restored,
  );
  check(
    "12 the pending list and the host ledger are empty (the page acknowledged the restore)",
    (await pending()).length === 0 && !(await rpc({ action: "show", id })).jobs.some((job) => ["queued", "withdrawn"].includes(job.state)),
  );
  await page.shot("02-restored", { force: true });

  // 13: the touch buttons do the same.
  await type("FOLLOW-TWO tap");
  await page.evaluate(`document.querySelector("#followup-btn").click()`);
  await page.waitFor(`document.querySelectorAll("#pending .pending-row").length === 1`, "follow-up button queued");
  check("13 the edit button shows once something is queued", await visible("#dequeue-btn"));
  await page.evaluate(`document.querySelector("#dequeue-btn").click()`);
  await page.waitFor(`${input}.value.includes("FOLLOW-TWO tap")`, "restore button");
  check("13 the buttons queue a follow-up and restore it", (await pending()).length === 0);

  release();
  await eventually(async () => !(await rpc({ action: "show", id })).chats.find((chat) => chat.id === "main")?.busy, "idle again");
  await page.waitFor(
    `!document.querySelector("#followup-btn") || document.querySelector("#followup-btn").hidden`,
    "buttons hide when idle",
  );
  await type("plain after idle");
  await ALT_ENTER();
  await eventually(
    async () => (await rpc({ action: "show", id })).messages.some((message) => message.text === "plain after idle"),
    "idle Alt+Enter sent",
  );
  const after = (await rpc({ action: "show", id })).jobs.filter((job) => job.text === "plain after idle");
  // The page always sends the key's mode; the host runs an idle chat's message as a plain turn (Q14), so the ledger shows the mode and no queue.
  check("14 idle Alt+Enter is a plain message: sent once, never queued", after.length === 1 && after[0].state !== "queued", after);
  check("14 the page sent the key's mode without guessing the chat state", after[0].delivery === "followUp", after);

  // ---- Third pass (scripts/chat-queue-failures.md W20-W22, W28, W30): real loss, reload and concurrent typing ----
  const draftOf = () => page.evaluate(`JSON.parse(localStorage.getItem("pi-ui2-draft:chat:${id}:main") ?? "null")`);
  const messagesWith = async (text) => (await rpc({ action: "show", id })).messages.filter((message) => message.text === text).length;
  const jobsWith = async (text) => (await rpc({ action: "show", id })).jobs.filter((job) => job.text === text);
  const reload = async () => {
    await page.evaluate(`window.__old = true`);
    await page.reload();
    await page.waitFor(`!window.__old && document.body.dataset.ready === "1"`, "inbox ready after reload");
  };
  // The page's fetch, replaced for one message: `mode` is "lose-response" (the host gets it, the page never hears), "lose-request" (it never leaves),
  // or "refuse" (a typed refusal after `ms`, nothing reaches the host).
  const patchFetch = (marker, mode, ms = 0) =>
    page.evaluate(`(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (!body.includes(${JSON.stringify(marker)}) || !body.includes('"action":"message"')) return real(url, init);
        if (${JSON.stringify(mode)} === "lose-request") throw new TypeError("Failed to fetch");
        if (${JSON.stringify(mode)} === "lose-response") { await real(url, init); throw new TypeError("Failed to fetch"); }
        await new Promise((ok) => setTimeout(ok, ${ms}));
        return new Response(JSON.stringify({ ok: false, error: "Project plan is paused; admission is denied", refused: true }), { status: 400 });
      };
    })()`);

  // W20: the browser refuses to keep the send record: nothing is cleared and nothing is sent.
  await page.evaluate(`(() => {
    const set = Storage.prototype.setItem;
    window.__failDrafts = true;
    Storage.prototype.setItem = function (key, value) {
      if (window.__failDrafts && String(key).startsWith("pi-ui2-draft:") && String(value).includes('"sending":[{')) throw new Error("QuotaExceededError");
      return set.call(this, key, value);
    };
  })()`);
  await type("J1 keep me");
  await ENTER();
  await kit.delay(800);
  check("W20 the editor still holds the text when the record could not be kept", (await page.evaluate(`${input}.value`)) === "J1 keep me");
  check("W20 nothing was sent", (await messagesWith("J1 keep me")) === 0 && (await jobsWith("J1 keep me")).length === 0);
  await page.evaluate(`window.__failDrafts = false`);
  await ENTER();
  await eventually(async () => (await messagesWith("J1 keep me")) === 1, "W20 sent once the record could be kept");
  check("W20 the editor clears after a kept record", (await page.evaluate(`${input}.value`)) === "");

  // W22: the host got the message and the answer never reached the page. The record keeps its id; after a reload it is sent again and runs once.
  await patchFetch("J2 lost answer", "lose-response");
  await type("J2 lost answer");
  await ENTER();
  await eventually(async () => (await messagesWith("J2 lost answer")) === 1, "W22 the host received it");
  await page.waitFor(
    `JSON.parse(localStorage.getItem("pi-ui2-draft:chat:${id}:main") ?? "{}").sending?.length === 1`,
    "record kept as unknown",
  );
  const unknown = (await draftOf()).sending[0];
  check("W22 the editor is not given the text back for an unknown outcome", (await page.evaluate(`${input}.value`)) === "");
  await reload();
  await page.waitFor(
    `JSON.parse(localStorage.getItem("pi-ui2-draft:chat:${id}:main") ?? "{}").sending?.length === 0`,
    "record settled after reload",
  );
  await eventually(async () => (await jobsWith("J2 lost answer")).length >= 1, "ledger has it");
  check(
    "W22 the same id was sent again and the host ran it once",
    (await messagesWith("J2 lost answer")) === 1 &&
      (await jobsWith("J2 lost answer")).length === 1 &&
      (await jobsWith("J2 lost answer"))[0].id === unknown.requestId,
    await jobsWith("J2 lost answer"),
  );
  check("W22 the editor is still empty after the reload", (await page.evaluate(`${input}.value`)) === "");

  // W22: the request never left the page; after the reload the same record is sent, once.
  await patchFetch("J2b never left", "lose-request");
  await type("J2b never left");
  await ENTER();
  await page.waitFor(`JSON.parse(localStorage.getItem("pi-ui2-draft:chat:${id}:main") ?? "{}").sending?.length === 1`, "record kept");
  check("W22 nothing reached the host yet", (await messagesWith("J2b never left")) === 0);
  await reload();
  await eventually(async () => (await messagesWith("J2b never left")) === 1, "W22 the page sent it after the reload");
  await page.waitFor(`JSON.parse(localStorage.getItem("pi-ui2-draft:chat:${id}:main") ?? "{}").sending?.length === 0`, "record done");

  // W21: a refused send A comes back in front of B, which the owner typed meanwhile; typing on keeps both, also after a reload.
  await patchFetch("J3 first A", "refuse", 900);
  await type("J3 first A");
  await ENTER();
  await page.waitFor(`${input}.value === ""`, "A left the editor");
  await type("J3 typed B");
  await page.waitFor(`${input}.value.startsWith("J3 first A")`, "the refusal gave A back through the editor");
  check("W21 A is in front of B in the editor", (await page.evaluate(`${input}.value`)) === "J3 first A\n\nJ3 typed B");
  await type("J3 first A\n\nJ3 typed B and more");
  check("W21 typing on keeps A in the stored draft", (await draftOf()).text === "J3 first A\n\nJ3 typed B and more", await draftOf());
  await reload();
  check("W21 a reload shows both", (await page.evaluate(`${input}.value`)) === "J3 first A\n\nJ3 typed B and more");
  check(
    "W21 the host never saw the refused message",
    (await messagesWith("J3 first A")) === 0 && (await jobsWith("J3 first A")).length === 0,
  );
  await type("");

  // W28/W30: restored messages of different origins and uploads never become one message; the held ones stay at the host and are offered again.
  const web = new URL((await rpc({ action: "web" })).url);
  const upload = async (name) =>
    (
      await (
        await fetch(`${web.origin}/upload?project=${id}`, {
          method: "POST",
          headers: { authorization: `Bearer ${web.hash.slice("#token=".length)}`, "x-filename": name },
          body: `${name}\n`,
        })
      ).json()
    ).data.id;
  const up1 = await upload("one.txt"),
    up2 = await upload("three.txt");
  await rpc({ action: "message", id, text: "GATE2 start" });
  await eventually(async () => (await rpc({ action: "show", id })).chats.find((chat) => chat.id === "main")?.busy, "gated turn running");
  const queueOf = (text, extra) => rpc({ action: "message", id, text, requestId: crypto.randomUUID(), delivery: "followUp", ...extra });
  await queueOf("J4 telegram one", { origin: "telegram", attachments: [up1] });
  await kit.delay(30);
  await queueOf("J4 web two");
  await kit.delay(30);
  await queueOf("J4 telegram three", { origin: "telegram", attachments: [up2] });
  await page.waitFor(`document.querySelectorAll("#pending .pending-row").length === 3`, "three pending");
  await ALT_UP();
  await page.waitFor(`${input}.value.includes("J4 telegram one")`, "first message restored");
  check(
    "W28 only the compatible message joined the editor",
    (await page.evaluate(`${input}.value`)) === "J4 telegram one" &&
      (await draftOf()).origin === "telegram" &&
      (await draftOf()).attachments.join() === up1,
    await draftOf(),
  );
  check(
    "W28 the held messages are still withdrawn at the host, text intact",
    (await jobsWith("J4 web two"))[0]?.state === "withdrawn" && (await jobsWith("J4 telegram three"))[0]?.state === "withdrawn",
    (await rpc({ action: "show", id })).jobs.map((job) => [job.text, job.state]),
  );
  await ENTER();
  await eventually(
    async () => (await jobsWith("J4 telegram one")).some((job) => job.state === "queued"),
    "the restored message was sent as its own message",
  );
  const resent = (await jobsWith("J4 telegram one")).find((job) => job.state === "queued");
  check("W28 the resent message keeps its origin and upload", resent?.origin === "telegram" && resent.attachments?.join() === up1, resent);
  // The resent message is queued again, so Alt+Up takes it back first; the held ones stay held while the draft carries the Telegram origin.
  await ALT_UP();
  await page.waitFor(`${input}.value.includes("J4 telegram one")`, "the resent message came back");
  check(
    "W28 the resent message is the only one restored while its origin is in the editor",
    (await page.evaluate(`${input}.value`)) === "J4 telegram one",
  );
  await type("");
  await ALT_UP();
  await page.waitFor(`${input}.value.includes("J4 web two")`, "second restore");
  check("W28 the next restore brings the web message alone", (await page.evaluate(`${input}.value`)) === "J4 web two");
  await type("");
  await ALT_UP();
  await page.waitFor(`${input}.value.includes("J4 telegram three")`, "third restore");
  check(
    "W30 the last message comes back whole with its upload",
    (await page.evaluate(`${input}.value`)) === "J4 telegram three" && (await draftOf()).attachments.join() === up2,
    await draftOf(),
  );
  await page.shot("03-held-restore", { force: true });
  release2();
});
