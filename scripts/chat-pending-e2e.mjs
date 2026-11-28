// Browser E2E: the owner's message shows as pending the moment it is sent and reconciles to one canonical message; Undo state
// (`memory-recent`) loads on project selection and knowledge changes only. Failure cases: chat-pending-failures.md.
// The page's fetch is wrapped to hold, delay or fail single actions; the host and the fake model are real. Artifact: artifacts/chat-pending-<time>/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createKit, call, say } from "./lib/e2e-kit.mjs";

const kit = await createKit("chat-pending", {
  handler: ({ role, user, results }) => {
    if (role !== "coordinator" || user.startsWith("[Durable work")) return undefined;
    if (user.includes("MARK-R38MANY"))
      return results.length < 45
        ? call("projects_knowledge_write", { path: `decisions/none-${results.length}.md`, text: "# None\n\nbody", expectedRevision: null })
        : say("ACK MARK-R38MANY");
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
const { rpc } = kit;
// E2E_SOFT=1 reports failing checks of the recovery sections instead of stopping at the first (used to show every red case before the fix).
const soft = process.env.E2E_SOFT === "1";
const check = (label, ok, detail) =>
  soft && !ok ? console.log(`RED ${label}: ${JSON.stringify(detail ?? null).slice(0, 300)}`) : kit.check(label, ok, detail);
const section = async (name, body) => {
  if (!soft) return body();
  try {
    await body();
  } catch (error) {
    console.log(`RED ${name}: ${String(error.message).split("\n")[0].slice(0, 300)}`);
  }
};
kit.initRepo();
mkdirSync(join(kit.agentDir, "skills", "pend-skill"), { recursive: true });
writeFileSync(
  join(kit.agentDir, "skills", "pend-skill", "SKILL.md"),
  "---\nname: pend-skill\ndescription: Pending-send fixture skill.\n---\n\nBODY-pend-skill\n",
);
mkdirSync(join(kit.agentDir, "skills", "pend-skill-denied"), { recursive: true });
writeFileSync(
  join(kit.agentDir, "skills", "pend-skill-denied", "SKILL.md"),
  "---\nname: pend-skill-denied\ndescription: Pending-send fixture skill for denied recovery.\n---\n\nBODY-pend-skill-denied\n",
);

mkdirSync(join(kit.agentDir, "skills", "pend-skill-crash"), { recursive: true });
writeFileSync(
  join(kit.agentDir, "skills", "pend-skill-crash", "SKILL.md"),
  "---\nname: pend-skill-crash\ndescription: Pending-send fixture skill for a crash before the grant.\n---\n\nBODY-pend-skill-crash\n",
);

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
    const entry = { size: body.writes?.length, paths: body.writes?.map((write) => write.path), action: body.action, project: body.projectId ?? body.id, chat: body.chatId ?? "main", text: body.text, requestId: body.requestId, start: performance.now() };
    window.__calls.push(entry);
    const rule = window.__rules[body.action] ?? {};
    if (rule.delay) await sleep(rule.delay);
    if (rule.gate) await rule.gate;
    if (rule.reply) return new Response(JSON.stringify({ ok: true, data: rule.reply }), { headers: { "content-type": "application/json" } });
    if (rule.fail === "json") {
      // A real refusal: the host answers the same message addressed to a chat it does not know, through the browser endpoint.
      delete rule.fail;
      const response = await real(url, { ...init, body: JSON.stringify({ ...body, chatId: crypto.randomUUID() }) });
      entry.end = performance.now();
      return response;
    }
    if (rule.fail === "gateway") {
      delete rule.fail;
      entry.end = performance.now();
      return new Response(JSON.stringify({ ok: false, error: "Bad gateway: simulated proxy error" }), { status: 502, headers: { "content-type": "application/json" } });
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
  check("R34 Dismiss keeps the edited, unsent draft", (await composer()) === "refused MARK-P6 edited", await composer());
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected after dismiss",
  );
  await select(chatButton(A, "main"));
  await page.waitFor(`document.querySelector('#feed').innerText.includes("seed A MARK-SEED-A")`, "main after dismiss");
  check("R34 the edited draft is still the chat's draft after a switch", (await composer()) === "refused MARK-P6 edited", await composer());
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
  await page.waitFor(
    `document.querySelectorAll('#feed .msg.owner[data-delivery="failed"]').length === 1`,
    "failed bubble after coming back",
  );
  check(
    "P6b the refused text is in its own chat's composer, not on the bubble's Retry",
    (await composer()) === "late refusal MARK-LATEREFUSAL",
    await composer(),
  );
  await ev(`document.querySelector('#feed [data-pending-dismiss]').click()`);
  check("P6b Dismiss takes the unedited draft with its bubble", (await composer()) === "", await composer());

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
  // R31: the record has no saved content and no runtime receipt: nothing proves what it said, so Retry never rebuilds it under its id.
  await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
  await kit.eventually(async () => (await countCalls("message")) === 2, "P10 Retry reached the host");
  await kit.delay(600);
  const stillUnproven = await owners("MARK-STRAND");
  check(
    "R31 Retry of a record without evidence is refused and the bubble stays unconfirmed",
    stillUnproven.length === 3 && stillUnproven.filter((item) => item.delivery === "unconfirmed").length === 1,
    stillUnproven,
  );
  const retriedStranded = await calls("message");
  check("P10 Retry reused the request id", retriedStranded.length === 2 && retriedStranded[0].requestId === retriedStranded[1].requestId);
  check("R31 the host stored two, not a rebuilt third", (await hostCount(A, undefined, "MARK-STRAND")) === 2);
  await ev(`document.querySelector('#feed [data-pending-dismiss]').click()`);

  const ledgerPath = (id) => join(kit.home, A, "inbox", `${id}.json`);
  const ledgerText = (id) => readFileSync(ledgerPath(id), "utf8");
  const plant = (record) => {
    mkdirSync(join(kit.home, A, "inbox"), { recursive: true });
    writeFileSync(ledgerPath(record.id), JSON.stringify({ at: new Date().toISOString(), error: null, ...record }));
  };
  const send = (extra) => rpc({ action: "message", id: A, ...extra });
  const invokedSkills = () => {
    try {
      return readFileSync(join(kit.home, A, "invoked-skills.txt"), "utf8");
    } catch {
      return "";
    }
  };

  // U1: the turn card's Retry resends the failed turn's text.
  const failedId = randomUUID();
  plant({
    id: failedId,
    text: "turn card MARK-TURNRETRY",
    state: "failed",
    error: "provider exploded",
    at: new Date(Date.now() + 60000).toISOString(),
    admitted: true,
  });
  await select(chatButton(A, other));
  await page.waitFor(
    `document.querySelector(${JSON.stringify(chatButton(A, other))}).getAttribute("aria-current") === "true"`,
    "other selected for U1",
  );
  await select(chatButton(A, "main"));
  await page.waitFor(`!!document.querySelector('[data-retry-job="${failedId}"]')`, "turn card Retry");
  await page.shot("04-turn-card-retry", { force: true });
  await reset();
  await ev(`document.querySelector('[data-retry-job="${failedId}"]').click()`);
  await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK turn card MARK-TURNRETRY")`, "turn card retry answered");
  const turnRetry = await calls("message");
  check(
    "U1 the turn card Retry sends the failed text once under a new id",
    turnRetry.length === 1 && turnRetry[0].requestId !== failedId && turnRetry[0].text === "turn card MARK-TURNRETRY",
    turnRetry,
  );
  check("U1 the host stored one message", (await hostCount(A, undefined, "MARK-TURNRETRY")) === 1);

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

  // H: a request id names one message. The host refuses a repeat whose chat, text, attachments or origin differ, before it touches anything.
  const colliding = randomUUID();
  await send({ text: "identity MARK-ID", requestId: colliding, chatId: other });
  await kit.eventually(async () => JSON.parse(ledgerText(colliding)).state === "done", "colliding job settled");
  const held = ledgerText(colliding);
  const mismatches = {
    "another chat": { text: "identity MARK-ID", requestId: colliding },
    "other text": { text: "identity MARK-ID changed", requestId: colliding, chatId: other },
    attachments: { text: "identity MARK-ID", requestId: colliding, chatId: other, attachments: [randomUUID()] },
    origin: { text: "identity MARK-ID", requestId: colliding, chatId: other, origin: "telegram" },
  };
  for (const [name, input] of Object.entries(mismatches)) {
    const refusal = await kit.rejects({ action: "message", id: A, ...input });
    check(`H1 a repeated id with ${name} is refused as a different message`, /different message/.test(refusal ?? ""), refusal);
  }
  check("H1 the refusals left the saved record untouched", ledgerText(colliding) === held);
  check(
    "H1 the message is in its own chat once and in no other",
    (await hostCount(A, other, "MARK-ID")) === 1 && (await hostCount(A, undefined, "MARK-ID")) === 0,
  );
  const repeat = await send({ text: "identity MARK-ID", requestId: colliding, chatId: other });
  check("H1 the identical repeat returns the held job", repeat.id === colliding && (await hostCount(A, other, "MARK-ID")) === 1);

  const stranded1 = randomUUID();
  plant({ id: stranded1, text: "stranded MARK-ID2", state: "queued" });
  const heldStranded = ledgerText(stranded1);
  const strandedRefusal = await kit.rejects({ action: "message", id: A, text: "stranded MARK-ID2", requestId: stranded1, chatId: other });
  check("H1b a recorded job is bound to its chat before it was admitted", /different message/.test(strandedRefusal ?? ""), strandedRefusal);
  check("H1b nothing was sent or rewritten", ledgerText(stranded1) === heldStranded && (await hostCount(A, other, "MARK-ID2")) === 0);

  // H2: a denied retry has no side effect, not even an invoked-skill record.
  const archived = (await rpc({ action: "chat-create", id: A, title: "Archived" })).id;
  await rpc({ action: "chat-update", id: A, chatId: archived, archived: true });
  const denied = await kit.rejects({ action: "message", id: A, text: "/skill:pend-skill go", requestId: randomUUID(), chatId: archived });
  check("H2 an archived chat refuses", /archived/i.test(denied ?? ""), denied);
  check("H2 the refused message recorded no invoked skill", !invokedSkills().includes("pend-skill"), invokedSkills());
  await send({ text: "/skill:pend-skill go", requestId: randomUUID() });
  check("H2 an admitted message records the skill", invokedSkills().includes("pend-skill"), invokedSkills());

  // H3: a terminal job the runtime has no record of is never admitted again.
  const legacy = randomUUID();
  plant({ id: legacy, text: "legacy MARK-LEGACY", state: "failed", error: "provider exploded" });
  const heldLegacy = ledgerText(legacy);
  const legacyReply = await send({ text: "legacy MARK-LEGACY", requestId: legacy });
  check("H3 the repeat returns the terminal job", legacyReply.id === legacy && legacyReply.state === "failed", legacyReply);
  check(
    "H3 it was not delivered and not rewritten",
    (await hostCount(A, undefined, "MARK-LEGACY")) === 0 && ledgerText(legacy) === heldLegacy,
  );

  // H4: a crash between recording and admitting. The host reopens, keeps the record unconfirmed, and a deliberate retry delivers the original once.
  const crashed = randomUUID();
  plant({ id: crashed, text: "/skill:pend-skill crash MARK-CRASH", state: "queued", origin: "telegram" });
  await kit.restartHost();
  await kit.delay(800);
  check("H4 a restart does not deliver an unconfirmed record on its own", (await hostCount(A, undefined, "MARK-CRASH")) === 0);
  const afterRestart = JSON.parse(ledgerText(crashed));
  check(
    "H4 the record keeps its text and origin and stays unadmitted",
    afterRestart.origin === "telegram" && !afterRestart.admitted,
    afterRestart,
  );
  const lostOrigin = await kit.rejects({ action: "message", id: A, text: "/skill:pend-skill crash MARK-CRASH", requestId: crashed });
  check("H4 a retry without the original origin is refused", /different message/.test(lostOrigin ?? ""), lostOrigin);
  const replayCrash = await kit.rejects({
    action: "message",
    id: A,
    text: "/skill:pend-skill crash MARK-CRASH",
    requestId: crashed,
    origin: "telegram",
  });
  check("H4 a legacy record without saved content is not rebuilt for a replay", /does not prove/.test(replayCrash ?? ""), replayCrash);
  check(
    "H4 it stays undelivered and unadmitted",
    (await hostCount(A, undefined, "MARK-CRASH")) === 0 && !JSON.parse(ledgerText(crashed)).admitted,
  );

  // H5: two concurrent first sends under one id deliver once.
  const racing = randomUUID();
  await Promise.all([send({ text: "race MARK-RACE", requestId: racing }), send({ text: "race MARK-RACE", requestId: racing })]);
  await kit.delay(500);
  check("H5 concurrent sends of one id deliver once", (await hostCount(A, undefined, "MARK-RACE")) === 1);

  const sendButtonRetry = (id) => ev(`document.querySelector('[data-retry-job="${id}"]').click()`);
  const waitChat = async (id, chat) => {
    await select(chatButton(id, chat));
    await page.waitFor(
      `document.querySelector(${JSON.stringify(chatButton(id, chat))}).getAttribute("aria-current") === "true"`,
      `${chat} selected`,
    );
  };
  const clearComposer = () =>
    ev(`(() => { const box = document.querySelector('#composer-input'); box.value = ""; box.dispatchEvent(new Event("input")); })()`);
  await clearComposer();

  // R8: a turn-card Retry whose ack was lost is the same delivery on the next click.
  await section("R8", async () => {
    const lostRetry = randomUUID();
    plant({
      id: lostRetry,
      text: "turn lost MARK-R8",
      state: "failed",
      error: "provider exploded",
      at: new Date(Date.now() + 120000).toISOString(),
      admitted: true,
    });
    await waitChat(A, other);
    await waitChat(A, "main");
    await page.waitFor(`!!document.querySelector('[data-retry-job="${lostRetry}"]')`, "R8 turn card Retry");
    await reset();
    await ev(`__rule("message", { fail: "network" })`);
    await sendButtonRetry(lostRetry);
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "unconfirmed") && !document.querySelector('[data-retry-job]')?.disabled`,
      "R8 unconfirmed",
    );
    await sendButtonRetry(lostRetry);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK turn lost MARK-R8")`, "R8 answered");
    const lostCalls = await calls("message");
    check("R8 both clicks use one request id", lostCalls.length === 2 && lostCalls[0].requestId === lostCalls[1].requestId, lostCalls);
    check("R8 the chat got one turn", (await hostCount(A, undefined, "MARK-R8")) === 1);
  });
  // R9: a reload keeps a recovery handle for the message in flight; it is not shown in another project and Retry reuses the id.
  await section("R9", async () => {
    await reset();
    await ev(`__rule("message", { fail: "network" })`);
    await typeAndSend("reload MARK-R9");
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "unconfirmed")`,
      "R9 unconfirmed",
    );
    const beforeReload = (await calls("message"))[0].requestId;
    await ev(`delete window.__calls`);
    await page.reload();
    await page.waitFor(
      `!window.__calls && document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`,
      "R9 reloaded",
    );
    await ev(wrapFetch);
    await page.waitFor(`(document.querySelector('#feed')?.innerText ?? "").includes("ACK turn lost MARK-R8")`, "R9 transcript");
    const reloaded = await owners("MARK-R9");
    check("R9 the message survives a reload as unconfirmed", reloaded.length === 1 && reloaded[0].delivery === "unconfirmed", reloaded);
    await waitChat(A, other);
    check("R9 the handle is not shown in another chat", (await owners("MARK-R9")).length === 0);
    await select(inTree(B));
    await page.waitFor(`document.querySelector('#feed').innerText.includes("seed B MARK-SEED-B")`, "R9 B transcript");
    check("R9 the handle is not shown in another project", (await owners("MARK-R9")).length === 0);
    await select(chatButton(A, "main"));
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK turn lost MARK-R8")`, "R9 A again");
    await reset();
    await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK reload MARK-R9")`, "R9 retried");
    const afterReload = await calls("message");
    check(
      "R9 Retry after the reload reuses the request id",
      afterReload.length === 1 && afterReload[0].requestId === beforeReload,
      afterReload,
    );
    check("R9 the host stored it once", (await hostCount(A, undefined, "MARK-R9")) === 1);
    await ev(`__rule("message", { fail: "lost" })`);
    await typeAndSend("reload in flight MARK-R9B");
    await kit.eventually(async () => (await hostCount(A, undefined, "MARK-R9B")) === 1, "R9B reached the host");
    await ev(`delete window.__calls`);
    await page.reload();
    await page.waitFor(
      `!window.__calls && document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`,
      "R9B reloaded",
    );
    await ev(wrapFetch);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK reload in flight MARK-R9B")`, "R9B reply");
    await kit.delay(500);
    const inFlight = await owners("MARK-R9B");
    check("R9 an admitted message becomes one canonical message after a reload", inFlight.length === 1 && !inFlight[0].pending, inFlight);
    check(
      "R9 nothing was sent again after the reload",
      (await countCalls("message")) === 0 && (await hostCount(A, undefined, "MARK-R9B")) === 1,
    );
  });
  // R10: an edited restored draft is its own message and stays in its chat; the old bubble keeps its text and id.
  await section("R10", async () => {
    await reset();
    await ev(`__rule("message", { fail: "json" })`);
    await typeAndSend("restored MARK-R10");
    await page.waitFor(`[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`, "R10 failed");
    const refusedId = (await calls("message"))[0].requestId;
    await ev(`document.querySelector('#composer-input').focus()`);
    await page.cdp("Input.insertText", { text: " edited" });
    await waitChat(A, other);
    check("R10 the edited draft does not follow the owner into another chat", (await composer()) === "", await composer());
    await waitChat(A, "main");
    check("R10 it is back in its own chat", (await composer()) === "restored MARK-R10 edited", await composer());
    await reset();
    await ev(`document.querySelector('#composer').requestSubmit()`);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK restored MARK-R10 edited")`, "R10 edited answered");
    await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 0`, "R10 old retried");
    const isolated = await calls("message");
    check(
      "R10 the edit is a new message and the old bubble retries its own text and id",
      isolated.length === 2 &&
        isolated[0].requestId !== refusedId &&
        isolated[1].requestId === refusedId &&
        isolated[1].text === "restored MARK-R10",
      isolated,
    );
  });
  // R11: a JSON error that is not the host's own refusal is unconfirmed, not "Not sent".
  await section("R11", async () => {
    await reset();
    await ev(`__rule("message", { fail: "gateway" })`);
    await typeAndSend("gateway MARK-R11");
    await page.waitFor(`[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery)`, "R11 settled");
    await kit.delay(600);
    const gateway = await owners("MARK-R11");
    check(
      "R11 a gateway error is unconfirmed",
      gateway.some((item) => item.delivery === "unconfirmed"),
      gateway,
    );
    check("R11 the draft was not restored", (await composer()) === "");
    await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK gateway MARK-R11")`, "R11 retried");
    check("R11 one turn", (await hostCount(A, undefined, "MARK-R11")) === 1);
  });
  // R15: a long pending message is clamped like a saved one.
  await section("R15", async () => {
    await reset();
    await ev(`__hold("message")`);
    const longText = Array.from({ length: 40 }, (_, index) => `line ${index} MARK-R15`).join("\n\n");
    await ev(
      `(() => { const box = document.querySelector('#composer-input'); box.value = ${JSON.stringify(longText)}; box.dispatchEvent(new Event("input")); document.querySelector('#composer').requestSubmit(); })()`,
    );
    await page.waitFor(`document.querySelectorAll('#feed .msg.owner.pending').length === 1`, "R15 pending");
    await kit.delay(300);
    const clamp = await ev(
      `(() => { const n = document.querySelector('#feed .msg.owner.pending'); return { overflow: n.dataset.overflow, height: n.querySelector('.bubble').getBoundingClientRect().height }; })()`,
    );
    check("R15 the pending bubble is clamped", clamp.overflow === "1" && clamp.height < 260, clamp);
    await ev(`__release("message")`);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK line 0 MARK-R15")`, "R15 answered");
  });
  // R16: a worker link that is not one of the project's jobs does not open a worker.
  await section("R16", async () => {
    await ev(
      `document.querySelector('#feed').insertAdjacentHTML("beforeend", '<button id="forged" data-open-worker="00000000-0000-4000-8000-000000000000">forged</button>')`,
    );
    await ev(`document.querySelector('#forged').click()`);
    await kit.delay(500);
    check(
      "R16 a forged job id opens nothing",
      await ev(
        `(() => { const view = document.querySelector('#focus-view'); return !view || view.hidden || !view.querySelector('.focus-head'); })()`,
      ),
    );
    await ev(`document.querySelector('#forged')?.remove()`);
  });
  // R14: after a reconnect, Undo waits for a fresh answer instead of trusting the old one.
  await section("R14", async () => {
    await kit.ask(A, "MARK-REMEMBERX please");
    await page.waitFor(`[...document.querySelectorAll('[data-memory-undo]')].length >= 1`, "R14 Undo shown");
    await ev(`__hold("memory-recent")`);
    await reset();
    await kit.restartHost();
    await page.waitFor(`(__calls.filter((c) => c.action === "memory-recent").length) >= 1`, "R14 refresh after the reconnect", 400);
    check(
      "R14 Undo is withheld while the post-reconnect read is in flight",
      (await ev(`document.querySelectorAll('[data-memory-undo]').length`)) === 0,
    );
    await ev(`__release("memory-recent")`);
    await page.waitFor(`document.querySelectorAll('[data-memory-undo]').length >= 1`, "R14 Undo back after the fresh answer");
  });
  // R12: a record saved before origins were stored takes a Telegram replay of the same message; conflicts are refused.
  await section("R12", async () => {
    const olderThanOrigins = randomUUID();
    plant({ id: olderThanOrigins, text: "older MARK-R12", state: "queued" });
    const conflict = await kit.rejects({
      action: "message",
      id: A,
      text: "older MARK-R12 other",
      requestId: olderThanOrigins,
      origin: "telegram",
    });
    check("R12 a replay with other text is refused", /different message/.test(conflict ?? ""), conflict);
    const unproven = await kit.rejects({
      action: "message",
      id: A,
      text: "older MARK-R12",
      requestId: olderThanOrigins,
      origin: "telegram",
    });
    check("R12 a Telegram replay cannot deliver a record that proves no origin", /does not prove/.test(unproven ?? ""), unproven);
    check("R12 nothing was delivered", (await hostCount(A, undefined, "MARK-R12")) === 0);
    const ownerRepeat = await kit.rejects({ action: "message", id: A, text: "older MARK-R12", requestId: olderThanOrigins });
    check("R31 not even the owner's repeat rebuilds a record that proves nothing", /does not prove/.test(ownerRepeat ?? ""), ownerRepeat);
    check(
      "R31 it stays undelivered and untouched",
      (await hostCount(A, undefined, "MARK-R12")) === 0 && !JSON.parse(ledgerText(olderThanOrigins)).admitted,
    );
    const legacyAdmitted = randomUUID();
    await send({ text: "legacy receipt MARK-R12R", requestId: legacyAdmitted, origin: "telegram" });
    const legacyRecord = JSON.parse(ledgerText(legacyAdmitted));
    delete legacyRecord.origin;
    delete legacyRecord.admitted;
    writeFileSync(ledgerPath(legacyAdmitted), JSON.stringify(legacyRecord));
    const acknowledged = await send({ text: "legacy receipt MARK-R12R", requestId: legacyAdmitted, origin: "telegram" });
    check(
      "R12 a Telegram replay of a legacy record the runtime holds is acknowledged, not delivered again",
      acknowledged.admitted === true && (await hostCount(A, undefined, "MARK-R12R")) === 1,
      acknowledged,
    );
    const webRecord = randomUUID();
    await send({ text: "web MARK-R12W", requestId: webRecord });
    const forged = await kit.rejects({ action: "message", id: A, text: "web MARK-R12W", requestId: webRecord, origin: "telegram" });
    check("R12 a web message is not claimed by a Telegram replay", /different message/.test(forged ?? ""), forged);
  });

  const viaEndpoint = (action, input) =>
    ev(
      `(async () => { const api = await import("/api.js"); try { const data = await api.localHost.call(${JSON.stringify(action)}, ${JSON.stringify(input)}); return { ok: true, data }; } catch (error) { return { ok: false, refused: error.refused, message: error.message }; } })()`,
    );
  // R30: the page's own request to the browser endpoint tells a proven refusal from an unknown error.
  await section("R30", async () => {
    const refused = await viaEndpoint("message", { id: A, text: "refused MARK-R30", requestId: randomUUID(), chatId: randomUUID() });
    check("R30 a refusal before admission carries the host's marker through the browser endpoint", refused.refused === true, refused);
    const unknown = await viaEndpoint("message", { id: randomUUID(), text: "unknown MARK-R30", requestId: randomUUID() });
    check("R30 an error that is not a proven refusal carries no marker", unknown.ok === false && unknown.refused === false, unknown);
    check("R30 neither stored a message", (await hostCount(A, undefined, "MARK-R30")) === 0);
    // A repeat of a message the host already holds, to a project that went inactive meanwhile, is not a proven refusal.
    const C = await kit.createProject("Pending C"),
      held = randomUUID();
    await rpc({ action: "message", id: C, text: "held MARK-R30C", requestId: held });
    await rpc({ action: "archive", id: C });
    const repeat = await viaEndpoint("message", { id: C, text: "held MARK-R30C", requestId: held });
    check(
      "R30 a repeat of an admitted message to an archived project is not marked refused",
      repeat.ok === false && repeat.refused === false,
      repeat,
    );
    const first = await viaEndpoint("message", { id: C, text: "new MARK-R30C", requestId: randomUUID() });
    check("R30 a first send to an archived project is a proven refusal", first.ok === false && first.refused === true, first);
  });
  // R32: a crash after the runtime took the message and before the skill grant finishes the original grant from the receipt, without sending again.
  await section("R32", async () => {
    const id = randomUUID(),
      crashSkills = () => invokedSkills().split("\n");
    await send({ text: "/skill:pend-skill-crash granted MARK-R32", requestId: id });
    await kit.eventually(async () => JSON.parse(ledgerText(id)).state === "done", "R32 settled");
    const record = JSON.parse(ledgerText(id));
    delete record.admitted;
    delete record.entry;
    writeFileSync(ledgerPath(id), JSON.stringify({ ...record, state: "queued", delivery: { content: "expanded MARK-R32" } }));
    writeFileSync(
      join(kit.home, A, "invoked-skills.txt"),
      crashSkills()
        .filter((name) => name && name !== "pend-skill-crash")
        .join("\n") + "\n",
    );
    check("R32 the grant is missing before the restart", !crashSkills().includes("pend-skill-crash"), invokedSkills());
    await kit.restartHost();
    await kit.eventually(async () => crashSkills().includes("pend-skill-crash"), "R32 grant finished after the restart");
    await kit.delay(600);
    const healed = JSON.parse(ledgerText(id));
    check("R32 the record is admitted and drops its saved content", healed.admitted === true && !("delivery" in healed), healed);
    check("R32 nothing was submitted again", (await hostCount(A, undefined, "MARK-R32")) === 1);
    const refusedSkill = await kit.rejects({
      action: "message",
      id: A,
      text: "/skill:pend-skill-denied nothing MARK-R32B",
      requestId: randomUUID(),
      chatId: randomUUID(),
    });
    // The chat is archived before the restart, so any new admission would be refused: only the receipt can finish the grant.
    const archivedAfter = (await rpc({ action: "chat-create", id: A, title: "Crash chat" })).id,
      second = randomUUID();
    await send({ text: "/skill:pend-skill-crash again MARK-R32D", requestId: second, chatId: archivedAfter });
    await kit.eventually(async () => JSON.parse(ledgerText(second)).state === "done", "R32 second settled");
    const secondRecord = JSON.parse(ledgerText(second));
    delete secondRecord.admitted;
    delete secondRecord.entry;
    await rpc({ action: "chat-update", id: A, chatId: archivedAfter, archived: true });
    await kit.delay(500);
    writeFileSync(ledgerPath(second), JSON.stringify({ ...secondRecord, state: "queued", delivery: { content: "expanded MARK-R32D" } }));
    writeFileSync(
      join(kit.home, A, "invoked-skills.txt"),
      crashSkills()
        .filter((name) => name && name !== "pend-skill-crash")
        .join("\n") + "\n",
    );
    check(
      "R32 the grant is missing and the record unadmitted at shutdown",
      !crashSkills().includes("pend-skill-crash") && JSON.parse(ledgerText(second)).admitted !== true,
      invokedSkills(),
    );
    await kit.restartHost();
    await kit.eventually(async () => crashSkills().includes("pend-skill-crash"), "R32 grant finished from the receipt alone");
    await kit.eventually(async () => JSON.parse(ledgerText(second)).admitted === true, "R32 second record admitted from the receipt");
    check("R32 the receipt finished it without a new submission", (await hostCount(A, archivedAfter, "MARK-R32D")) === 1);
    check("R32 a refused send is refused", /Unknown chat/.test(refusedSkill ?? ""), refusedSkill);
    check("R32 a refused send grants nothing", !invokedSkills().includes("pend-skill-denied"), invokedSkills());
  });
  // R33: no recoverable handle, no send: the draft stays in the composer and the host never hears of the message.
  await section("R33", async () => {
    await clearComposer();
    await reset();
    await ev(
      `(() => { window.__realSet = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (String(key).startsWith("pi-pending-send:")) throw new DOMException("full", "QuotaExceededError"); return window.__realSet.call(this, key, value); }; })()`,
    );
    await typeAndSend("unstorable MARK-R33");
    await kit.delay(900);
    check(
      "R33 nothing was sent",
      (await countCalls("message")) === 0 && (await hostCount(A, undefined, "MARK-R33")) === 0,
      await calls("message"),
    );
    check("R33 the draft stays in the composer", (await composer()) === "unstorable MARK-R33", await composer());
    check("R33 no bubble claims it was sent", (await owners("MARK-R33")).length === 0, await owners("MARK-R33"));
    await page.shot("04-unstorable-draft-kept", { force: true });
    check("R33 the owner is told", await ev(`document.querySelector("#toasts").innerText.includes("recovery")`));
    await ev(`(Storage.prototype.setItem = window.__realSet, true)`);
    await ev(`document.querySelector('#composer').requestSubmit()`);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK unstorable MARK-R33")`, "R33 sent once storage works");
    check("R33 then it is sent once", (await hostCount(A, undefined, "MARK-R33")) === 1 && (await countCalls("message")) === 1);
  });
  // R34: dismissing a failed bubble clears only a draft the owner has not touched.
  await section("R34", async () => {
    await clearComposer();
    await reset();
    await ev(`__rule("message", { fail: "json" })`);
    await typeAndSend("untouched MARK-R34");
    await page.waitFor(`[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "failed")`, "R34 failed");
    check("R34 a real refusal restores the draft", (await composer()) === "untouched MARK-R34", await composer());
    await ev(`document.querySelector('#feed [data-pending-dismiss]').click()`);
    check(
      "R34 dismissing the unedited restore clears it",
      (await composer()) === "" && (await owners("MARK-R34")).length === 0,
      await composer(),
    );
  });
  // R37: a handle another tab removed is stored again before Retry sends; without storage Retry does not send.
  await section("R37", async () => {
    await clearComposer();
    await reset();
    await ev(`__rule("message", { fail: "network" })`);
    await typeAndSend("other tab MARK-R37");
    await page.waitFor(
      `[...document.querySelectorAll('#feed .msg.owner')].some((n) => n.dataset.delivery === "unconfirmed")`,
      "R37 unconfirmed",
    );
    const requestId = (await calls("message"))[0].requestId;
    await ev(`localStorage.removeItem("pi-pending-send:${requestId}")`);
    await ev(
      `(() => { window.__realSet = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (String(key).startsWith("pi-pending-send:")) throw new DOMException("full", "QuotaExceededError"); return window.__realSet.call(this, key, value); }; })()`,
    );
    await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
    await kit.delay(700);
    check("R37 Retry without a handle that can be stored sends nothing", (await countCalls("message")) === 1, await calls("message"));
    const unsure = await owners("MARK-R37");
    check(
      "R37 the earlier attempt may have reached the host, so the bubble stays unconfirmed with its Retry",
      unsure.length === 1 && unsure[0].delivery === "unconfirmed" && (await ev(`!!document.querySelector('#feed [data-pending-retry]')`)),
      unsure,
    );
    check(
      "R37 the toast says the retry was not sent again, not that the message was never sent",
      await ev(`document.querySelector("#toasts").innerText.includes("not sent again")`),
    );
    await ev(`(Storage.prototype.setItem = window.__realSet, true)`);
    await ev(`document.querySelector('#feed [data-pending-retry]').click()`);
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK other tab MARK-R37")`, "R37 retried");
    check("R37 the stored handle returned and the retry kept the id", (await calls("message")).at(-1).requestId === requestId);
    check("R37 the host stored it once", (await hostCount(A, undefined, "MARK-R37")) === 1);
  });
  // R38: more writes outside the recent list than one question holds are all asked about, in several questions.
  await section("R38", async () => {
    await reset();
    await clearComposer();
    await typeAndSend("MARK-R38MANY write");
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK MARK-R38MANY")`, "R38 25 writes done", 60000);
    await ev(`__rule("memory-recent", { reply: { writes: [] } })`);
    await select(inTree(B));
    await page.waitFor(`document.querySelector('#feed').innerText.includes("seed B MARK-SEED-B")`, "R38 B shown");
    await reset();
    await select(chatButton(A, "main"));
    await kit.delay(1200);
    await ev(`__rule("memory-recent", { reply: undefined })`);
    await ev(`document.querySelector('#feed [data-earlier]').click()`);
    await kit.delay(1200);
    const rows = await ev(
      `[...new Set([...document.querySelectorAll('#feed .memory-row[data-tool="projects_knowledge_write"][data-status="ok"] [data-memory]')].map((n) => n.dataset.memory))].sort()`,
    );
    const asks = await calls("memory-writes");
    const asked = asks.flatMap((item) => item.paths).sort();
    check(
      "R38 more unknown writes on screen than one question holds are asked about in several questions, none left out",
      rows.length > 20 && asks.length >= 2 && asks.every((item) => item.size <= 20) && JSON.stringify(asked) === JSON.stringify(rows),
      { rows, asks },
    );
  });
  // R35: only a write the host proves is offered Undo; an old, still current write keeps its Undo.
  await section("R35", async () => {
    await clearComposer();
    for (const suffix of ["D", "E", "F"]) {
      await typeAndSend(`MARK-REMEMBER${suffix} write`);
      await page.waitFor(`!!document.querySelector('[data-memory-undo="decisions/undo-me${suffix}.md"]')`, `R35 Undo for ${suffix}`);
    }
    await ev(`document.querySelector('[data-memory-undo="decisions/undo-meE.md"]').click()`);
    await page.waitFor(`!document.querySelector('[data-memory-undo="decisions/undo-meE.md"]')`, "R35 E undone");
    const changedDoc = await rpc({ action: "knowledge-read", id: A, path: "decisions/undo-meD.md" });
    await rpc({
      action: "knowledge-write",
      id: A,
      path: "decisions/undo-meD.md",
      text: "# Undo me\n\nchanged",
      expectedRevision: changedDoc.revision,
    });
    for (let index = 0; index < 55; index++)
      await rpc({
        action: "knowledge-write",
        id: A,
        path: `decisions/fill-${index}.md`,
        text: `# Fill ${index}\n\nbody`,
        expectedRevision: null,
      });
    await ev(`delete window.__calls`);
    await page.reload();
    await page.waitFor(
      `!window.__calls && document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`,
      "R35 reloaded",
    );
    await ev(wrapFetch);
    await page.waitFor(
      `document.querySelector('#feed').innerText.includes("ACK MARK-REMEMBERF")  || document.querySelector('[data-memory="decisions/undo-meF.md"]')`,
      "R35 transcript",
    );
    await kit.delay(1500);
    const rowOf = (path) =>
      ev(
        `(() => { const row = [...document.querySelectorAll('.memory-row[data-tool="projects_knowledge_write"]')].find((n) => n.querySelector('[data-memory="${path}"]')); return row ? { undo: !!row.querySelector("[data-memory-undo]"), text: row.innerText } : null; })()`,
      );
    const changed = await rowOf("decisions/undo-meD.md"),
      undone = await rowOf("decisions/undo-meE.md"),
      current = await rowOf("decisions/undo-meF.md");
    await page.shot("05-old-undo-proven", { force: true });
    check("R35 an old write changed since is not offered Undo", changed && !changed.undo && /Changed since/.test(changed.text), changed);
    check("R35 an old undone write is not offered Undo", undone && !undone.undo && /Undone/.test(undone.text), undone);
    check("R35 an old write that is still current keeps its Undo", current?.undo === true, current);
    await reset();
    await typeAndSend("plain after reload MARK-R35");
    await page.waitFor(`document.querySelector('#feed').innerText.includes("ACK plain after reload MARK-R35")`, "R35 reply");
    check(
      "R35 a send asks for no memory state",
      (await countCalls("memory-recent")) === 0 && (await countCalls("memory-writes")) === 0,
      await calls("memory-recent"),
    );
    await ev(`document.querySelector('[data-memory-undo="decisions/undo-meF.md"]').click()`);
    await page.waitFor(`!document.querySelector('[data-memory-undo="decisions/undo-meF.md"]')`, "R35 undone");
    check("R35 the legitimate old Undo ran", (await countCalls("memory-undo")) === 1);
  });
  // R1-R6: records the host saved before admitting (the CLI and the web page supply no id the host could not make up itself).
  await section("R1-R6", async () => {
    const saved = (id, content, extra = {}) =>
      plant({ id, text: extra.text ?? content, state: "queued", delivery: { content }, origin: "owner", ...extra });
    const recoverTelegram = randomUUID(),
      recoverMain = randomUUID(),
      recoverDenied = randomUUID(),
      recoverTwice = randomUUID();
    saved(recoverTelegram, "EFFECTIVE-ONLY expanded text MARK-R1", {
      text: "/skill:pend-skill short MARK-R1",
      chatId: other,
      origin: "telegram",
    });
    saved(recoverMain, "EFFECTIVE-MAIN no client id MARK-R1B");
    saved(recoverDenied, "EFFECTIVE-DENIED MARK-R5", { text: "/skill:pend-skill-denied go MARK-R5", chatId: archived });
    const twice = await send({ text: "delivered once MARK-R2", requestId: recoverTwice });
    const twiceRecord = JSON.parse(ledgerText(recoverTwice));
    delete twiceRecord.admitted;
    delete twiceRecord.entry;
    writeFileSync(ledgerPath(recoverTwice), JSON.stringify({ ...twiceRecord, delivery: { content: "delivered once MARK-R2" } }));
    await kit.restartHost();
    await kit.eventually(async () => (await hostCount(A, other, "EFFECTIVE-ONLY")) === 1, "saved Telegram message recovered");
    await kit.eventually(async () => (await hostCount(A, undefined, "EFFECTIVE-MAIN")) === 1, "saved main message recovered");
    await kit.delay(800);
    check("R1 the saved content, not a rebuilt prompt, reached its own chat once", (await hostCount(A, other, "EFFECTIVE-ONLY")) === 1);
    check("R1 it did not reach the main chat", (await hostCount(A, undefined, "EFFECTIVE-ONLY")) === 0);
    check("R1 a record without a client id is recovered once", (await hostCount(A, undefined, "EFFECTIVE-MAIN")) === 1);
    const recovered = JSON.parse(ledgerText(recoverTelegram));
    check("R1 the record is admitted and keeps its origin", recovered.admitted === true && recovered.origin === "telegram", recovered);
    check(
      "R6 the saved content is dropped once admitted",
      !("delivery" in recovered) && !("delivery" in JSON.parse(ledgerText(recoverMain))),
    );
    check("R2 an admitted message is reconciled, not admitted again", (await hostCount(A, undefined, "MARK-R2")) === 1);
    check(
      "R2 and its record is marked admitted",
      JSON.parse(ledgerText(recoverTwice)).admitted === true && !("delivery" in JSON.parse(ledgerText(recoverTwice))),
    );
    check(
      "R3 an already admitted message stays single over a restart",
      (await hostCount(A, other, "MARK-ID")) === 1 && twice.admitted === true,
    );
    check(
      "R5 a message whose chat was archived is not delivered anywhere",
      (await hostCount(A, archived, "EFFECTIVE-DENIED")) === 0 && (await hostCount(A, undefined, "EFFECTIVE-DENIED")) === 0,
    );
    check("R5 it stays unadmitted for the owner to see", JSON.parse(ledgerText(recoverDenied)).admitted !== true);
    check("R13 the denied recovery granted no skill access", !invokedSkills().includes("pend-skill-denied"), invokedSkills());
    // Review: a record is the message of its own file name, and a snapshot never carries the saved content.
    const filed = randomUUID(),
      embedded = randomUUID();
    writeFileSync(
      ledgerPath(filed),
      JSON.stringify({
        id: embedded,
        text: "swapped MARK-Z1",
        at: new Date().toISOString(),
        state: "queued",
        error: null,
        origin: "owner",
        admitted: true,
      }),
    );
    const swapped = await kit.rejects({ action: "message", id: A, text: "swapped MARK-Z1", requestId: filed });
    check(
      "Z1 a record whose embedded id differs from its file is refused, not taken as delivered",
      /does not carry the id/.test(swapped ?? ""),
      swapped,
    );
    check("Z1 nothing was delivered", (await hostCount(A, undefined, "MARK-Z1")) === 0);
    const hidden = randomUUID();
    saved(hidden, "SECRET-EXPANDED-CONTENT MARK-Z2", { text: "hidden MARK-Z2", chatId: archived });
    const shown = JSON.stringify((await rpc({ action: "show", id: A, chatId: archived })).jobs);
    check(
      "Z2 a snapshot lists the unadmitted record without its saved content",
      shown.includes(hidden) && !shown.includes("SECRET-EXPANDED"),
      shown,
    );
    const cli = spawnSync(process.execPath, [join(kit.core, "src", "cli.ts"), "send", A, "from the CLI MARK-CLI"], {
      cwd: kit.core,
      env: kit.hostEnv,
      encoding: "utf8",
      timeout: 60000,
    });
    await kit.eventually(async () => (await hostCount(A, undefined, "MARK-CLI")) === 1, "CLI message delivered");
    check("R1 the CLI send is admitted once with a host-made id", cli.status === 0 && /"admitted": true/.test(cli.stdout), cli);
  });
});
