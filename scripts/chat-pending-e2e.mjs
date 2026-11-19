// Browser E2E: the owner's message shows as pending the moment it is sent and reconciles to one canonical message; Undo state
// (`memory-recent`) loads on project selection and knowledge changes only. Failure cases: chat-pending-failures.md.
// The page's fetch is wrapped to hold, delay or fail single actions; the host and the fake model are real. Artifact: artifacts/chat-pending-<time>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createKit, call, say } from "./lib/e2e-kit.mjs";

const kit = await createKit("chat-pending", {
  handler: ({ role, user, results }) => {
    if (role !== "coordinator" || user.startsWith("[Durable work")) return undefined;
    const remember = /MARK-REMEMBER(\w*)/.exec(user);
    if (remember && !results.length)
      return call("projects_knowledge_write", {
        path: `decisions/undo-me${remember[1]}.md`,
        text: "# Undo me\n\nbody",
        expectedRevision: null,
      });
    return say(`ACK ${user.replace(/\s+/g, " ").slice(0, 120)}`);
  },
});
const { check, rpc } = kit;
kit.initRepo();

const wrapFetch = `(() => {
  window.__calls = [];
  window.__rules = {};
  const real = window.fetch.bind(window);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  window.__hold = (action) => { let release; const gate = new Promise((ok) => (release = ok)); window.__rules[action] = { ...window.__rules[action], gate, release }; };
  window.__release = (action) => { window.__rules[action]?.release?.(); delete window.__rules[action]?.gate; };
  window.__rule = (action, rule) => { window.__rules[action] = { ...window.__rules[action], ...rule }; };
  window.fetch = async (url, init) => {
    if (url !== "/api" || !init?.body) return real(url, init);
    const body = JSON.parse(init.body);
    const entry = { action: body.action, project: body.projectId ?? body.id, chat: body.chatId ?? "main", text: body.text, requestId: body.requestId, start: performance.now() };
    window.__calls.push(entry);
    const rule = window.__rules[body.action] ?? {};
    if (rule.delay) await sleep(rule.delay);
    if (rule.gate) await rule.gate;
    if (rule.fail === "json") {
      delete rule.fail;
      entry.end = performance.now();
      return new Response(JSON.stringify({ ok: false, error: "Not admitted: simulated refusal" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (rule.fail === "recorded") {
      delete rule.fail;
      await real(url, init);
      entry.end = performance.now();
      return new Response(JSON.stringify({ ok: false, error: "Admission failed after recording: simulated" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (rule.fail === "network") {
      delete rule.fail;
      entry.end = performance.now();
      throw new TypeError("Failed to fetch");
    }
    const response = await real(url, init);
    entry.end = performance.now();
    if (rule.fail === "lost") {
      delete rule.fail;
      throw new TypeError("Failed to fetch");
    }
    return response;
  };
})()`;

await kit.run(async () => {
  const A = await kit.createProject("Pending A");
  const B = await kit.createProject("Pending B");
  const other = (await rpc({ action: "chat-create", id: A, title: "Other" })).id;
  await kit.ask(A, "seed A MARK-SEED-A");
  await kit.ask(B, "seed B MARK-SEED-B");
  await kit.ask(A, "MARK-REMEMBER please");

  const page = await kit.openPage(await kit.webUrl(A));
  const ev = page.evaluate;
  await page.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`, "ready");
  await page.waitFor(`document.querySelector('#feed').innerText.includes("seed A MARK-SEED-A")`, "A transcript");
  await ev(wrapFetch);
  const calls = (action) => ev(`__calls.filter((c) => c.action === ${JSON.stringify(action)})`);
  const countCalls = async (action) => (await calls(action)).length;
  const reset = () => ev(`(__calls.length = 0)`);
  const owners = (text) =>
    ev(
      `[...document.querySelectorAll('#feed .msg.owner')].filter((n) => n.innerText.includes(${JSON.stringify(text)})).map((n) => ({ pending: n.classList.contains("pending"), delivery: n.dataset.delivery ?? "", text: n.innerText }))`,
    );
  const hostCount = async (id, chatId, text) =>
    (await rpc({ action: "show", id, ...(chatId ? { chatId } : {}) })).messages.filter((m) => m.role === "user" && m.text?.includes(text))
      .length;
  const typeAndSend = async (text) => {
    await ev(`(() => { const box = document.querySelector('#composer-input'); box.focus(); })()`);
    await page.cdp("Input.insertText", { text });
    for (const type of ["keyDown", "keyUp"])
      await page.cdp("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
  };
  const select = (selector) => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const inTree = (id) => `[data-project="${id}"]`;
  const chatButton = (id, chat) => `[data-project-id="${id}"][data-chat="${chat}"]`;
  const composer = () => ev(`document.querySelector('#composer-input').value`);
  await page.waitFor(`!!document.querySelector(${JSON.stringify(chatButton(A, other))})`, "tree rows");

  // M1/M7: Undo state is loaded for the opening project; an Undo row works.
  await page.waitFor(`!!document.querySelector('[data-memory-undo]')`, "Undo button for the coordinator's write");

  // M1: ordinary chat switch and send never ask for memory-recent.
  await reset();
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other chat selected",
  );
  await kit.delay(400);
  await select(chatButton(A, "main"));
  await page.waitFor(`document.querySelector('#feed').innerText.includes("seed A MARK-SEED-A")`, "main again");
  await typeAndSend("plain send MARK-PLAIN");
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK plain send MARK-PLAIN")`, "reply");
  check("M1 no memory-recent on chat switch or send", (await countCalls("memory-recent")) === 0, await calls("memory-recent"));
  check("M1 the send used one message call", (await countCalls("message")) === 1);

  // M2/M3/M4: project selection loads Undo state; a slow answer does not delay the transcript nor cross projects.
  await reset();
  await ev(`__rule("memory-recent", { delay: 1500 })`);
  const t0 = await ev(`performance.now()`);
  await select(inTree(B));
  await page.waitFor(`document.querySelector('#feed').innerText.includes("seed B MARK-SEED-B")`, "B transcript");
  const paintMs = (await ev(`performance.now()`)) - t0;
  check("M3 B transcript paints before the delayed memory-recent returns", paintMs < 1200, paintMs);
  await select(chatButton(A, "main")).catch(() => {});
  await page.waitFor(`document.querySelector('#feed').innerText.includes("seed A MARK-SEED-A")`, "A again", 120);
  await kit.delay(2000);
  const recentCalls = await calls("memory-recent");
  check(
    "M2 selecting a project asks for its memory-recent",
    recentCalls.some((c) => c.project === B),
    recentCalls,
  );
  check(
    "M4 the delayed answer of B did not replace A's Undo state",
    await ev(`!!document.querySelector('[data-memory-undo="decisions/undo-me.md"]')`),
  );
  await ev(`__rule("memory-recent", { delay: 0 })`);

  // M5/M6: a knowledge change refreshes Undo state; a burst coalesces.
  await reset();
  const doc = await rpc({ action: "knowledge-read", id: A, path: "decisions/undo-me.md" });
  let revision = doc.revision;
  for (let i = 0; i < 4; i++)
    revision = (
      await rpc({
        action: "knowledge-write",
        id: A,
        path: "decisions/undo-me.md",
        text: `# Undo me\n\nrev ${i}`,
        expectedRevision: revision,
      })
    ).revision;
  await page.waitFor(`document.querySelector('#feed').innerText.includes("Changed since")`, "Undo state refreshed by the knowledge topic");
  await kit.delay(600);
  const burst = await countCalls("memory-recent");
  check("M5 knowledge changes refresh memory-recent", burst >= 1, burst);
  check("M6 four quick writes coalesce", burst <= 3, burst);

  // M7: Undo still works from the refreshed state.
  await reset();
  await typeAndSend("MARK-REMEMBERB second");
  await page.waitFor(`!!document.querySelector('[data-memory-undo="decisions/undo-meB.md"]')`, "Undo for the second write");
  await ev(`document.querySelector('[data-memory-undo="decisions/undo-meB.md"]').click()`);
  await page.waitFor(`document.querySelector('#feed').innerText.includes("Undone")`, "Undone");
  check("M7 Undo ran once and the row says Undone", (await countCalls("memory-undo")) === 1);

  // P1/P2: pending before the ack, one canonical message after it.
  await reset();
  await ev(`__hold("message")`);
  const sendAt = await ev(`performance.now()`);
  await typeAndSend("pending one MARK-P1");
  await page.waitFor(
    `[...document.querySelectorAll('#feed .msg.owner.pending')].some((n) => n.innerText.includes("MARK-P1"))`,
    "pending bubble",
    40,
  );
  const pendingMs = (await ev(`performance.now()`)) - sendAt;
  const shown = await owners("MARK-P1");
  check("P1 the pending message shows before the ack", shown.length === 1 && shown[0].delivery === "sending", shown);
  check("P1 the ack is still outstanding", (await calls("message"))[0]?.end === undefined);
  check("P8 the composer is cleared on send", (await composer()) === "");
  await page.shot("01-pending", { force: true });
  await ev(`__release("message")`);
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK pending one MARK-P1")`, "reply to P1");
  const after = await owners("MARK-P1");
  check("P2 exactly one canonical message, no pending", after.length === 1 && !after[0].pending, after);
  check("P2 the host stored it once", (await hostCount(A, undefined, "MARK-P1")) === 1);
  kit.result.timings = { pendingVisibleMs: Math.round(pendingMs) };

  // P3: a refresh before the ack must not duplicate; the lost-ack path reconciles.
  await reset();
  await ev(`__rule("message", { fail: "lost" })`);
  await typeAndSend("lost ack MARK-P3");
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK lost ack MARK-P3")`, "reply after lost ack");
  await kit.delay(500);
  const lost = await owners("MARK-P3");
  check("P3/P7 a lost ack reconciles to one canonical message", lost.length === 1 && !lost[0].pending, lost);
  check("P7 a lost ack is not sent again", (await countCalls("message")) === 1 && (await hostCount(A, undefined, "MARK-P3")) === 1);

  // P4: identical consecutive texts.
  await reset();
  await ev(`__hold("message")`);
  await typeAndSend("same text MARK-P4");
  await typeAndSend("same text MARK-P4");
  await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 2`, "two pending bubbles");
  await ev(`__release("message")`);
  await page.waitFor(`document.querySelector('#feed').innerText.split("ACK same text MARK-P4").length === 3`, "two replies");
  await kit.delay(300);
  const same = await owners("MARK-P4");
  check("P4 two identical sends show two canonical messages", same.length === 2 && same.every((item) => !item.pending), same);
  check("P4 the host stored both", (await hostCount(A, undefined, "MARK-P4")) === 2);

  // P4c: a short text and a longer one that contains it each find their own transcript message.
  await reset();
  await ev(`__hold("message")`);
  await typeAndSend("yes MARK-Y");
  await typeAndSend("yes MARK-Y please");
  await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 2`, "two pending bubbles for P4c");
  await ev(`__release("message")`);
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK yes MARK-Y please")`, "both answered");
  await kit.delay(400);
  const nested = await owners("MARK-Y");
  check("P4c both messages settle to their own canonical bubble", nested.length === 2 && nested.every((item) => !item.pending), nested);

  // P5: a pending send survives a chat switch, never shows in the other chat.
  await reset();
  await ev(`__hold("message")`);
  await typeAndSend("switching MARK-P5");
  await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending before switch");
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected",
  );
  await kit.delay(300);
  check("P5 the other chat does not show the pending bubble", (await owners("MARK-P5")).length === 0);
  await ev(`__release("message")`);
  await kit.delay(800);
  check("P5 still not in the other chat after the ack", (await owners("MARK-P5")).length === 0);
  await select(chatButton(A, "main"));
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK switching MARK-P5")`, "P5 reply in main");
  const switched = await owners("MARK-P5");
  check("P5 one canonical message back in the original chat", switched.length === 1 && !switched[0].pending, switched);

  // P6: a definite refusal stays visible as not sent, with the text back in the composer and no leak.
  await reset();
  await ev(`__rule("message", { fail: "json" })`);
  await typeAndSend("refused MARK-P6");
  await page.waitFor(`[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`, "failed bubble");
  const failed = await owners("MARK-P6");
  check("P6 the failure is shown on the message", failed.length === 1 && /Not sent/.test(failed[0].text), failed);
  check("P8 the draft is restored", (await composer()) === "refused MARK-P6", await composer());
  check("P6 the host did not store it", (await hostCount(A, undefined, "MARK-P6")) === 0);
  await page.shot("02-failed", { force: true });
  await ev(`document.querySelector('#composer-input').focus()`);
  await page.cdp("Input.insertText", { text: " edited" });
  check(
    "P6 editing the restored draft gives the bubble its own Retry",
    await ev(
      `(() => { const n = document.querySelector('#feed .msg.owner[data-delivery="failed"]'); return !!n.querySelector("[data-pending-retry]") && !/composer/.test(n.innerText); })()`,
    ),
  );
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected again",
  );
  check("P6 the failed bubble does not leak to another chat", (await owners("MARK-P6")).length === 0);
  await select(chatButton(A, "main"));
  await page.waitFor(`document.querySelector('#feed').innerText.includes("seed A MARK-SEED-A")`, "main again 2");
  check("P6 it is still there when the owner comes back", (await owners("MARK-P6")).length === 1);
  check("P6 no automatic retry", (await countCalls("message")) === 1, await calls("message"));
  await ev(`document.querySelector('#feed [data-pending-dismiss]').click()`);
  check("P9 Dismiss removes the failed bubble", (await owners("MARK-P6")).length === 0);
  await ev(`(() => { const box = document.querySelector('#composer-input'); box.value = ""; box.dispatchEvent(new Event("input")); })()`);

  // P6b: a refusal that arrives after the owner left and came back updates the bubble; its draft stays with its own chat.
  await reset();
  await ev(`__hold("message")`);
  await ev(`__rule("message", { fail: "json" })`);
  await typeAndSend("late refusal MARK-LATEREFUSAL");
  await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending before leaving");
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected for P6b",
  );
  await select(chatButton(A, "main"));
  await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "pending after coming back");
  await ev(`__release("message")`);
  await page.waitFor(
    `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`,
    "bubble updated to failed",
  );
  check("P6b the bubble shows the refusal without another repaint", (await owners("MARK-LATEREFUSAL")).length === 1);
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected after refusal",
  );
  check("P6b the refused draft does not follow the owner into another chat", (await composer()) === "", await composer());
  await select(chatButton(A, "main"));
  await page.waitFor(`!!document.querySelector('#feed [data-pending-retry]')`, "Retry on the bubble once the draft left the composer");
  await ev(`document.querySelector('#feed [data-pending-dismiss]').click()`);

  // P7b: the host recorded the message and then reported an error: not "Not sent", no restored draft.
  await reset();
  await ev(`__rule("message", { fail: "recorded" })`);
  await typeAndSend("recorded then error MARK-RECORDED");
  await page.waitFor(
    `document.querySelector('#feed').innerText.includes("ACK recorded then error MARK-RECORDED")`,
    "reply after recorded error",
  );
  await kit.delay(400);
  const recorded = await owners("MARK-RECORDED");
  check("P7b a recorded message reconciles to one canonical message", recorded.length === 1 && !recorded[0].pending, recorded);
  check("P7b the draft was not restored", (await composer()) === "");
  check("P7b not sent again", (await countCalls("message")) === 1 && (await hostCount(A, undefined, "MARK-RECORDED")) === 1);

  // P4b: a refused short text is not claimed by a longer message that contains it.
  await reset();
  await ev(`__rule("message", { fail: "json" })`);
  await typeAndSend("yes");
  await page.waitFor(`[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`, "yes refused");
  await ev(`(() => { const box = document.querySelector('#composer-input'); box.value = ""; box.dispatchEvent(new Event("input")); })()`);
  await typeAndSend("yes please MARK-LONGER");
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK yes please MARK-LONGER")`, "longer message answered");
  await kit.delay(300);
  check(
    "P4b the refused 'yes' stays a failed bubble",
    (await ev(`document.querySelectorAll('#feed .msg.owner[data-delivery="failed"]').length`)) === 1,
  );
  await ev(`document.querySelector('#feed [data-pending-dismiss]').click()`);

  // P7: a network failure before the host answered is unconfirmed, never success and never retried alone.
  await reset();
  await ev(`__rule("message", { fail: "network" })`);
  await typeAndSend("unconfirmed MARK-P7");
  await page.waitFor(
    `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "unconfirmed")`,
    "unconfirmed bubble",
  );
  const unconfirmed = await owners("MARK-P7");
  check(
    "P7 unconfirmed delivery is labelled, not success",
    unconfirmed.length === 1 && /not confirmed/i.test(unconfirmed[0].text),
    unconfirmed,
  );
  await kit.delay(1200);
  check("P7 not retried on its own", (await countCalls("message")) === 1 && (await hostCount(A, undefined, "MARK-P7")) === 0);
  await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK unconfirmed MARK-P7")`, "manual retry reply");
  const retried = await calls("message");
  check("P9 the manual retry reuses the request id", retried.length === 2 && retried[0].requestId === retried[1].requestId, retried);
  check(
    "P9 one canonical message after the retry",
    (await owners("MARK-P7")).length === 1 && (await hostCount(A, undefined, "MARK-P7")) === 1,
  );

  // P10: a job the host recorded but never admitted is not delivery, and no other message is taken for it; Retry admits it once.
  await reset();
  await ev(`__rule("message", { fail: "network" })`);
  await typeAndSend("stranded MARK-STRAND");
  await page.waitFor(
    `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "unconfirmed")`,
    "unconfirmed bubble for P10",
  );
  const stranded = (await calls("message"))[0];
  const inbox = join(kit.home, A, "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(
    join(inbox, `${stranded.requestId}.json`),
    JSON.stringify({ id: stranded.requestId, text: "stranded MARK-STRAND", at: new Date().toISOString(), state: "queued", error: null }),
  );
  await rpc({ action: "message", id: A, text: "stranded MARK-STRAND", requestId: randomUUID() });
  await rpc({ action: "message", id: A, text: "stranded MARK-STRAND\n\nextra block", requestId: randomUUID() });
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK stranded MARK-STRAND extra block")`, "other sends answered");
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected for P10",
  );
  await select(chatButton(A, "main"));
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK stranded MARK-STRAND extra block")`, "main again for P10");
  await kit.delay(500);
  const unadmitted = await owners("MARK-STRAND");
  check(
    "P10 a recorded, never admitted job stays unconfirmed beside two canonical messages",
    unadmitted.length === 3 && unadmitted.filter((item) => item.delivery === "unconfirmed").length === 1,
    unadmitted,
  );
  check("P10 it never says Sent", !unadmitted.some((item) => /\bSent\b/.test(item.text)), unadmitted);
  check("P10 nothing was sent on its own", (await countCalls("message")) === 1);
  await page.shot("03-unadmitted", { force: true });
  await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
  await page.waitFor(
    `[...document.querySelectorAll('#feed .msg.owner')].filter((n) => n.innerText.includes("MARK-STRAND") && !n.classList.contains("pending")).length === 3`,
    "three canonical messages after Retry",
  );
  await kit.delay(400);
  const admittedNow = await owners("MARK-STRAND");
  check(
    "P10 Retry delivers once: three canonical messages, no pending",
    admittedNow.length === 3 && admittedNow.every((item) => !item.pending),
    admittedNow,
  );
  const retriedStranded = await calls("message");
  check("P10 Retry reused the request id", retriedStranded.length === 2 && retriedStranded[0].requestId === retriedStranded[1].requestId);
  check("P10 the host stored three", (await hostCount(A, undefined, "MARK-STRAND")) === 3);

  // P8: slash commands do not create a pending bubble.
  await reset();
  await typeAndSend("/name Slash named");
  await kit.delay(500);
  check(
    "P8 a slash command runs, sends no message and shows no pending bubble",
    (await countCalls("message")) === 0 &&
      (await countCalls("chat-update")) === 1 &&
      (await ev(`document.querySelectorAll('#feed .msg.owner.pending').length`)) === 0,
  );
});
