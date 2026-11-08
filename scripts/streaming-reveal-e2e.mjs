// Real host/browser regression in the inbox at `/`. Only the provider cadence is a controlled fixture. Failure cases:
// streaming-reveal-failures.md (the classic client's paced fade-in, S1-S5 and S8, was retired with it on 2026-11-04).
import { createKit, delay } from "./lib/e2e-kit.mjs";

const chunk = (text, finish = null) =>
  `data: ${JSON.stringify({ id: "reveal", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish }] })}\n\n`;
const intro = "# Smooth stream\n\nAn earlier paragraph stays readable and never fades again.\n\n```js\nconst ready = true;\n```\n\n";
const bursts = [
  "New text arrives in a burst. ".repeat(15),
  "Later words keep the same paragraph alive. ".repeat(15),
  '\n\n```sh\nprintf "complete code\\n"\n```\n\nFinal readable paragraph.',
];
const gates = [],
  release = [];
for (let i = 0; i < 7; i++)
  gates.push(
    new Promise((resolve) => {
      release.push(resolve);
    }),
  );
const cancelled = "Cancellation keeps the latest received preview safe. ".repeat(70);
const k = await createKit("streaming-reveal", {
  handler: async ({ user, role }) => {
    if (role !== "coordinator") return;
    if (user.includes("MARK-SMOOTH"))
      return (async function* () {
        yield chunk(intro);
        for (let i = 0; i < bursts.length; i++) {
          await gates[i];
          yield chunk(bursts[i]);
        }
        await gates[3];
        yield chunk("", "stop") + "data: [DONE]\n\n";
      })();
    if (user.includes("MARK-CANCEL"))
      return (async function* () {
        yield chunk(cancelled);
        await gates[4];
        yield chunk("", "stop") + "data: [DONE]\n\n";
      })();
  },
});
await k.run(async () => {
  const id = await k.createProject("Smooth reveal", { grant: false });
  const side = await k.rpc({ action: "chat-create", id, title: "Other" });
  const page = await k.openPage(await k.webUrl(id));
  await page.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`, "project and composer ready");
  const send = async (text) => {
    await page.evaluate(`document.querySelector('#composer-input').focus()`);
    await page.cdp("Input.insertText", { text });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const live = `(document.querySelector('#live-turn')?.innerText ?? '')`;
  await send("MARK-SMOOTH");
  await page.waitFor(`${live}.includes('never fades again')`, "intro streamed");
  release[0]();
  release[1]();
  release[2]();
  await page.waitFor(`${live}.includes('Final readable paragraph')`, "bursts streamed");

  // S6: another chat's transcript never shows this chat's live text; coming back restores it.
  await page.evaluate(`document.querySelector('#tree [data-chat="${side.id}"]').click()`);
  await page.waitFor(
    `!${live}.includes('New text arrives') && !document.querySelector('#feed').innerText.includes('New text arrives')`,
    "other chat",
  );
  await delay(400);
  k.check(
    "S6 chat switch cannot leak live text into the other transcript",
    !(await page.evaluate(`document.querySelector('#feed').innerText.includes('New text arrives')`)),
  );
  await page.evaluate(`document.querySelector('#tree [data-chat="main"]').click()`);
  await page.waitFor(`${live}.includes('Final readable paragraph')`, "main live reply restores");
  k.check("S6 returning to the chat restores its live reply", true);

  // S7: completion shows what the host stored.
  release[3]();
  await page.waitFor(
    `!document.querySelector('#live-turn .streaming') && [...document.querySelectorAll('#feed .msg.agent')].at(-1)?.innerText.includes('Final readable paragraph')`,
    "completion",
  );
  const expected = intro + bursts.join("");
  const host = (await k.rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text;
  const final = await page.evaluate(`(() => { const m = [...document.querySelectorAll('#feed .msg.agent')].at(-1);
    return { text: m.innerText, heading: m.querySelector('.md-h')?.textContent === 'Smooth stream', code: [...m.querySelectorAll('pre code')].map(n => n.textContent) }; })()`);
  k.check(
    "S7 completion matches the stored reply and renders it once",
    expected.startsWith(host.slice(0, -1)) &&
      host.length > 1000 &&
      final.heading &&
      final.code.some((code) => code.includes("const ready = true")) &&
      final.code.some((code) => code.includes('printf "complete code')) &&
      (await page.evaluate(
        `[...document.querySelectorAll('#feed .msg.agent')].filter(m => m.innerText.includes('Final readable paragraph')).length`,
      )) === 1,
    { hostLength: host?.length, heading: final.heading, code: final.code },
  );

  // S9/S10: Stop clears the live reply; the received part is kept in storage and the transcript.
  await send("MARK-CANCEL");
  await page.waitFor(`${live}.includes('Cancellation keeps')`, "cancellable live reply");
  await page.waitFor(`!document.querySelector('#stop-btn').hidden`, "stop button");
  await page.evaluate(`document.querySelector('#stop-btn').click()`);
  await page.waitFor(`!document.querySelector('#live-turn .streaming')`, "stop clears the live reply");
  release[4]();
  await delay(500);
  k.check("S9 after Stop no live reply comes back", !(await page.evaluate(`!!document.querySelector('#live-turn .streaming')`)));
  const cancelHost = (await k.rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text;
  await page.waitFor(
    `document.querySelector('#feed').innerText.includes('Cancellation keeps the latest received preview safe.')`,
    "partial in the transcript",
  );
  k.check("S10 Stop keeps the received partial text in storage and the transcript", cancelHost === cancelled, {
    hostLength: cancelHost?.length,
    expectedLength: cancelled.length,
  });
  await page.shot("01-after-stop");
});
