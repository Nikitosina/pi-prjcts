// E2E: Pi input keys in the browser composer (failure cases 11-14 in scripts/chat-queue-failures.md). Private host, fake model, headless Chrome.
import { createKit, say } from "./lib/e2e-kit.mjs";

let release;
const hold = new Promise((ok) => (release = ok));
const kit = await createKit("chat-input-keys", {
  handler: ({ role, user }) => {
    if (role !== "coordinator") return undefined;
    if (user.includes("HOLD"))
      return (async function* () {
        await hold;
        yield say("released");
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
});
