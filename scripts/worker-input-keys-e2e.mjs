// E2E: Pi input keys in the Worker composer and the Host agent drawer. Real key events in headless Chrome on a private host with the fake provider:
// Enter steers a running agent, Alt+Enter queues a follow-up delivered after its turn, and Alt+Up takes the queued inputs back with the same
// withdraw-then-acknowledge protocol as the Coordinator (scripts/chat-queue-failures.md, W1-W8).
import { createKit, say } from "./lib/e2e-kit.mjs";

let releaseWorker, releaseHost;
const workerHold = new Promise((ok) => (releaseWorker = ok));
const hostHold = new Promise((ok) => (releaseHost = ok));
// Re-armable holds: a turn whose first request carries the marker waits here, so inputs queue behind it.
const deferred = () => {
  let open;
  return { wait: new Promise((ok) => (open = ok)), open };
};
let gateW = deferred(),
  gateH = deferred(),
  workerId = "";
// Test seams (src/test-seams.ts): the worker's delivery waits after its check, and a Host agent send fails after the runtime took the input.
const kit = await createKit("worker-input-keys", {
  env: {
    PI_PROJECTS_TEST_SEAMS: JSON.stringify({
      "worker-submit-delay": { marker: "SLOW-SUBMIT", ms: 1500 },
      "host-agent-submit-lost": { marker: "LOST-OUTCOME", times: 1 },
    }),
  },
  handler: ({ role, user, results, tools }) => {
    if (tools.includes("host_call") && user.includes("HK-GATE") && !results.length) {
      const gate = gateH;
      return (async function* () {
        await gate.wait;
        yield kit.call("host_call", { action: "list", input: {} });
      })();
    }
    if (role === "worker" && user.includes("W-GATE") && !results.length) {
      const gate = gateW;
      return (async function* () {
        await gate.wait;
        yield kit.call("bash", { command: "echo GATE-STEP" });
      })();
    }
    if (role === "coordinator" && user.includes("KEYS-NUDGE") && !results.length)
      return kit.call("agents", { action: "send", id: workerId, message: "C-NUDGE from the coordinator", followUp: true });
    // The held turn ends in a tool call, so a steer lands in the request that follows it, inside the same turn.
    if (tools.includes("host_call") && results.length && user.includes("HK-HOLD")) return say("HK-FIRST");
    if (tools.includes("host_call") && user.includes("HK-HOLD"))
      return (async function* () {
        await hostHold;
        yield kit.call("host_call", { action: "list", input: {} });
      })();
    if (tools.includes("host_call")) return say(`HK-ANSWER ${user.slice(0, 40)}`);
    if (role === "coordinator") {
      if (user.includes("KEYS-SPAWN") && !results.length)
        return kit.call("agents", {
          action: "spawn",
          role: "worker",
          title: "KEYS-WORKER",
          brief: "KEYS-WORKTASK hold then answer",
          acceptance: ["done"],
          requestId: crypto.randomUUID(),
        });
      return say("Noted.");
    }
    if (role === "worker") {
      if (user.includes("KEYS-WORKTASK") && !results.length)
        return (async function* () {
          await workerHold;
          yield kit.call("bash", { command: "echo KEYS-STEP" });
        })();
      return say(`W-ANSWER ${user.slice(0, 40)}`);
    }
    return undefined;
  },
});

await kit.run(async () => {
  const { rpc, check, eventually } = kit;
  kit.initRepo();
  const id = await kit.createProject("Agent keys");
  const page = await kit.openPage(await kit.webUrl(id));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  const key = async (name, code, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await page.cdp("Input.dispatchKeyEvent", { type, key: name, code, windowsVirtualKeyCode, modifiers });
  };
  const type = (selector, text) =>
    page.evaluate(
      `(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.focus(); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
  const ENTER = () => key("Enter", "Enter", 13),
    ALT_ENTER = () => key("Enter", "Enter", 13, 1),
    ALT_UP = () => key("ArrowUp", "ArrowUp", 38, 1);

  const uuid = () => crypto.randomUUID();
  const rowsOf = (scope) =>
    page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${scope} .pending-row`)})].map((row) => row.textContent)`);
  // The drawer holds its composer while a send is in flight, so a second Enter goes in only after the first settled.
  const hostFree = async () => {
    await free(hbox);
    await page.waitFor(`!document.querySelector("#ha-composer").dataset.sending`, "host send settled");
  };
  let worker;
  const threadState = async () => (await rpc({ action: "jobs-snapshot", id })).jobs.find((job) => job.id === worker.id);
  const workerCalls = () => kit.result.calls.filter((call) => call.role === "worker").map((call) => call.user);
  const count = (list, text) => list.filter((user) => user.includes(text)).length;
  const free = (selector) => page.waitFor(`document.querySelector(${JSON.stringify(selector)}).value === ""`, "composer cleared");

  // Spawn one held worker through the Coordinator, then open it in the browser.
  await rpc({ action: "message", id, text: "KEYS-SPAWN" });
  worker = await eventually(
    async () => (await rpc({ action: "jobs-snapshot", id })).agents?.find((agent) => agent.title === "KEYS-WORKER" && agent.working),
    "worker running",
  );
  workerId = worker.id;
  await page.evaluate(`document.querySelector('[data-open-worker="${worker.id}"]').click()`);
  const box = `#focus-view .worker-send textarea`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(box)})`, "worker composer");

  // 15: Enter on a running worker steers; Alt+Enter queues a follow-up.
  await page.waitFor(
    `!!document.querySelector("#focus-view .focus-head .badge.t-busy, #focus-view [data-stop-worker]")`,
    "page shows the worker working",
  );
  await type(box, "W-STEER now");
  await ENTER();
  await page.waitFor(`document.body.innerText.includes("Steer sent.")`, "steer toast");
  await type(box, "W-FOLLOW later");
  await ALT_ENTER();
  await page.waitFor(`document.body.innerText.includes("Queued as a follow-up.")`, "follow-up toast");
  check(
    "15 the worker composer clears after the keys",
    (await page.evaluate(`document.querySelector(${JSON.stringify(box)}).value`)) === "",
  );
  await page.shot("01-worker-keys", { force: true });

  // 16: released, the worker sees the steer inside the running turn and the follow-up as its own turn after it.
  releaseWorker();
  await eventually(() => kit.result.calls.some((call) => call.role === "worker" && call.user.includes("W-FOLLOW")), "follow-up delivered");
  const workerUsers = kit.result.calls.filter((call) => call.role === "worker").map((call) => call.user);
  const steerAt = workerUsers.findIndex((text) => text.includes("W-STEER")),
    followAt = workerUsers.findIndex((text) => text.includes("W-FOLLOW"));
  check("16 the worker saw the steer before the follow-up", steerAt >= 0 && followAt > steerAt, workerUsers);

  // 17: the same keys in the Host agent drawer.
  await page.evaluate(`document.querySelector('[data-cmd="host-agent"]').click()`);
  const hbox = `#ha-composer textarea`;
  await page.waitFor(
    `!!document.querySelector(${JSON.stringify(hbox)}) && document.querySelector("#host-agent").dataset.open === "1" && document.querySelector("#host-agent").dataset.available === "1"`,
    "drawer",
  );
  await kit.delay(500); // the drawer finishes opening before keys go in
  await type(hbox, "HK-HOLD start");
  await ENTER();
  await hostFree();
  await eventually(async () => kit.result.calls.some((call) => call.user.includes("HK-HOLD")), "host busy");
  await page.waitFor(`!document.querySelector("#ha-composer").dataset.sending`, "host composer free");
  await type(hbox, "HK-STEER now");
  await ENTER();
  await page.waitFor(`!document.querySelector("#ha-composer").dataset.sending`, "host composer free");
  await type(hbox, "HK-FOLLOW later");
  await ALT_ENTER();
  await page.shot("02-host-agent-keys", { force: true });
  releaseHost();
  await eventually(
    () => kit.result.calls.some((call) => call.tools.includes("host_call") && call.user.includes("HK-FOLLOW")),
    "host follow-up delivered",
  );
  const hostUsers = kit.result.calls.filter((call) => call.tools.includes("host_call")).map((call) => call.user);
  const hs = hostUsers.findIndex((text) => text.includes("HK-STEER")),
    hf = hostUsers.findIndex((text) => text.includes("HK-FOLLOW"));
  check("17 the Host agent saw the steer, then the follow-up", hs >= 0 && hf > hs, hostUsers);

  // ---- Alt+Up and the pending list: the Worker composer ----
  await eventually(async () => (await threadState()).status !== "running", "worker 1 settled");
  await page.waitFor(`!document.querySelector("#focus-view [data-stop-worker]")`, "page shows the worker idle");
  await type(box, "W-GATE go");
  await ENTER();
  await eventually(() => workerCalls().some((user) => user.includes("W-GATE")), "gated turn started");
  await page.waitFor(`!!document.querySelector("#focus-view [data-stop-worker]")`, "page shows the gated worker working");
  await type(box, "W-Q-FOLLOW one");
  await ALT_ENTER();
  await free(box);
  await type(box, "W-Q-STEER two");
  await ENTER();
  await free(box);
  await page.waitFor(`document.querySelectorAll("#focus-view .pending-row").length === 2`, "two pending rows");
  const wRows = await rowsOf("#focus-view");
  check(
    "W1 the worker lists steering before follow-up, one row per queued input",
    /^Steering:.*W-Q-STEER two/.test(wRows[0]) && /^Follow-up:.*W-Q-FOLLOW one/.test(wRows[1]),
    wRows,
  );
  await page.shot("03-worker-pending", { force: true });
  await page.viewport(390, 844, true);
  await page.shot("03n-worker-pending-narrow-390", { force: true });
  await page.viewport(1440, 1000);

  // W3/W4: the response can be lost; the withdrawn text is offered again until it is acknowledged; acknowledgments are idempotent and exact.
  const first = await rpc({ action: "thread-dequeue", id, threadId: worker.id });
  const again = await rpc({ action: "thread-dequeue", id, threadId: worker.id });
  check(
    "W3 a withdrawal whose response was lost returns the same inputs again, steering first",
    first.restored.length === 2 &&
      first.restored[0].text === "W-Q-STEER two" &&
      JSON.stringify(first.restored) === JSON.stringify(again.restored),
    [first, again],
  );
  await rpc({ action: "thread-dequeue-ack", id, threadId: worker.id, requestIds: [uuid()] });
  check(
    "W4 an acknowledgment for an unknown id removes nothing",
    (await rpc({ action: "thread-dequeue", id, threadId: worker.id })).restored.length === 2,
  );
  const ids = first.restored.map((item) => item.id);
  await rpc({ action: "thread-dequeue-ack", id, threadId: worker.id, requestIds: ids });
  await rpc({ action: "thread-dequeue-ack", id, threadId: worker.id, requestIds: ids });
  const empty = await rpc({ action: "thread-dequeue", id, threadId: worker.id });
  check(
    "W4 a repeated acknowledgment is harmless and the ledger is empty after it",
    empty.restored.length === 0 && empty.kept.length === 0,
    empty,
  );
  await page.waitFor(`document.querySelectorAll("#focus-view .pending-row").length === 0`, "pending cleared by the acknowledgment");

  // W7: the Coordinator's own send is not the owner's to withdraw.
  await rpc({ action: "message", id, text: "KEYS-NUDGE" });
  await eventually(async () => (await rpc({ action: "jobs-snapshot", id })).agents.some((agent) => agent.id === worker.id), "nudge sent");
  await kit.delay(800);
  check(
    "W7 an input the Coordinator sent is not listed or withdrawn",
    (await rpc({ action: "thread-dequeue", id, threadId: worker.id })).restored.length === 0,
  );

  // W2: Alt+Up in the composer brings every queued input back, steering first, then the draft.
  await type(box, "W-Q-FOLLOW one");
  await ALT_ENTER();
  await free(box);
  await type(box, "W-Q-STEER two");
  await ENTER();
  await free(box);
  await page.waitFor(`document.querySelectorAll("#focus-view .pending-row").length === 2`, "two pending rows again");
  await type(box, "draft");
  await ALT_UP();
  await page.waitFor(`document.querySelector(${JSON.stringify(box)}).value.includes("W-Q-FOLLOW one")`, "restored into the editor");
  const restored = await page.evaluate(`document.querySelector(${JSON.stringify(box)}).value`);
  check("W2 Alt+Up restores steering, then follow-up, then the draft", restored === "W-Q-STEER two\n\nW-Q-FOLLOW one\n\ndraft", restored);
  await page.waitFor(`document.querySelectorAll("#focus-view .pending-row").length === 0`, "pending list empty");
  check(
    "W2 the host ledger is empty after the page acknowledged",
    (await rpc({ action: "thread-dequeue", id, threadId: worker.id })).restored.length === 0,
  );
  await page.shot("04-worker-restored", { force: true });
  await ENTER(); // resend what was restored: it is delivered once
  await free(box);
  gateW.open();
  await eventually(
    () => count(workerCalls(), "W-Q-STEER two") >= 1 && count(workerCalls(), "C-NUDGE") >= 1,
    "resent text and the nudge delivered",
  );
  await eventually(async () => (await threadState()).status !== "running", "worker settled after the withdrawal");
  await kit.delay(1000);
  const users = workerCalls();
  check(
    "W2 the withdrawn inputs were delivered once, as the one resent message",
    count(users, "W-Q-FOLLOW one") === 1 && count(users, "W-Q-STEER two") === 1,
    users,
  );
  check("W6 the worker's Job settled after the withdrawal", (await threadState()).status !== "running", await threadState());

  // W5: an input the worker already took is kept and answered once, never restored.
  gateW = deferred();
  await type(box, "W-GATE again");
  await ENTER();
  await eventually(() => count(workerCalls(), "W-GATE again") >= 1, "second gated turn");
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: uuid(), text: "W-KEEP me" });
  gateW.open();
  await eventually(() => count(workerCalls(), "W-KEEP me") >= 1, "kept input taken");
  const late = await rpc({ action: "thread-dequeue", id, threadId: worker.id });
  await eventually(async () => (await threadState()).status !== "running", "worker settled again");
  check("W5 a taken input is not restored and was answered once", late.restored.length === 0 && count(workerCalls(), "W-KEEP me") === 1, [
    late,
    workerCalls(),
  ]);
  // W8: a message to an idle worker starts a turn at once; it is never queued.
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: uuid(), text: "W-IDLE start" });
  check(
    "W8 a send to an idle worker is not a queued input",
    (await rpc({ action: "thread-dequeue", id, threadId: worker.id })).restored.length === 0,
  );
  await eventually(async () => (await threadState()).status !== "running", "worker settled after the idle send");

  // W12: the page always sends the key's mode; the host decides what it means. A page that thinks the worker is idle still steers a working one.
  gateW = deferred();
  await type(box, "W-GATE third");
  await ENTER();
  await eventually(() => count(workerCalls(), "W-GATE third") >= 1, "third gated turn");
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: uuid(), text: "W-MODE steer", delivery: "steer" });
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: uuid(), text: "W-MODE follow", delivery: "followUp" });
  const modeRows = await eventually(async () => {
    const rows = (await rpc({ action: "thread-dequeue", id, threadId: worker.id })).restored;
    return rows.length === 2 ? rows : null;
  }, "both modes queued");
  check(
    "W12 thread-send carries the mode: a steer is queued as steering, a follow-up as a follow-up",
    modeRows[0].text === "W-MODE steer" && modeRows[0].delivery === "steer" && modeRows[1].delivery === "followUp",
    modeRows,
  );
  await rpc({ action: "thread-dequeue-ack", id, threadId: worker.id, requestIds: modeRows.map((item) => item.id) });

  // W9/W16: Alt+Up right after a send, before the worker's delivery task submitted it: an input is either given back (and then never delivered)
  // or kept because its producer may still submit it (and then delivered exactly once); it is never both. A later Alt+Up may give back an
  // earlier input once the runtime holds it, so what counts is each input's final outcome.
  const sentRace = [],
    givenBack = new Set();
  for (let n = 0; n < 3; n++) {
    const text = `W-RACE ${n}`;
    await rpc({ action: "thread-send", id, threadId: worker.id, requestId: uuid(), text, delivery: "followUp" });
    sentRace.push(text);
    const taken = await rpc({ action: "thread-dequeue", id, threadId: worker.id });
    if (taken.restored.length)
      await rpc({ action: "thread-dequeue-ack", id, threadId: worker.id, requestIds: taken.restored.map((item) => item.id) });
    for (const item of taken.restored) givenBack.add(item.text);
  }
  gateW.open();
  await eventually(async () => (await threadState()).status !== "running", "worker settled after the race");
  await kit.delay(1200);
  const history = await rpc({ action: "thread-history", id, threadId: worker.id, limit: 200, messageText: "full" });
  const delivered = (text) =>
    history.items.filter((entry) => entry.kind === "message" && entry.role === "user" && entry.text === text).length;
  check(
    "W9 an input is given back and never delivered, or kept and delivered once; never both",
    sentRace.every((text) => delivered(text) === (givenBack.has(text) ? 0 : 1)),
    { givenBack: [...givenBack], delivered: sentRace.map((text) => [text, delivered(text)]) },
  );

  // ---- Alt+Up and the pending list: the Host agent drawer ----
  await type(hbox, "HK-GATE go");
  await ENTER();
  await eventually(() => kit.result.calls.some((call) => call.user.includes("HK-GATE")), "host gated turn started");
  await page.waitFor(`!document.querySelector("#ha-composer").dataset.sending`, "host composer free");
  await type(hbox, "HK-Q-FOLLOW one");
  await ALT_ENTER();
  await hostFree();
  await type(hbox, "HK-Q-STEER two");
  await ENTER();
  await hostFree();
  await page.waitFor(`document.querySelectorAll("#host-agent .pending-row").length === 2`, "two host pending rows");
  const hRows = await rowsOf("#host-agent");
  check(
    "W1 the Host agent lists steering before follow-up",
    /^Steering:.*HK-Q-STEER two/.test(hRows[0]) && /^Follow-up:.*HK-Q-FOLLOW one/.test(hRows[1]),
    hRows,
  );
  await page.shot("05-host-pending", { force: true });
  const hFirst = await rpc({ action: "host-agent-dequeue" });
  const hAgain = await rpc({ action: "host-agent-dequeue" });
  check(
    "W3 the Host agent offers a withdrawn input again until it is acknowledged",
    hFirst.restored.length === 2 && JSON.stringify(hFirst.restored) === JSON.stringify(hAgain.restored),
    [hFirst, hAgain],
  );
  await rpc({ action: "host-agent-dequeue-ack", requestIds: [uuid()] });
  check(
    "W4 the Host agent ignores an acknowledgment for an unknown id",
    (await rpc({ action: "host-agent-dequeue" })).restored.length === 2,
  );
  const hIds = hFirst.restored.map((item) => item.id);
  await rpc({ action: "host-agent-dequeue-ack", requestIds: hIds });
  await rpc({ action: "host-agent-dequeue-ack", requestIds: hIds });
  check(
    "W4 the Host agent's ledger is empty after a repeated acknowledgment",
    (await rpc({ action: "host-agent-dequeue" })).restored.length === 0,
  );
  await type(hbox, "HK-Q-FOLLOW one");
  await ALT_ENTER();
  await hostFree();
  await type(hbox, "HK-Q-STEER two");
  await ENTER();
  await hostFree();
  await page.waitFor(`document.querySelectorAll("#host-agent .pending-row").length === 2`, "two host pending rows again");
  await type(hbox, "draft");
  await ALT_UP();
  await page.waitFor(`document.querySelector(${JSON.stringify(hbox)}).value.includes("HK-Q-FOLLOW one")`, "host restored");
  const hRestored = await page.evaluate(`document.querySelector(${JSON.stringify(hbox)}).value`);
  check(
    "W2 Alt+Up in the drawer restores steering, then follow-up, then the draft",
    hRestored === "HK-Q-STEER two\n\nHK-Q-FOLLOW one\n\ndraft",
    hRestored,
  );
  await page.waitFor(`document.querySelectorAll("#host-agent .pending-row").length === 0`, "host pending empty");
  await page.shot("06-host-restored", { force: true });
  await ENTER();
  await hostFree();
  gateH.open();
  await eventually(
    () => kit.result.calls.some((call) => call.tools.includes("host_call") && call.user.includes("HK-Q-STEER two")),
    "host resend delivered",
  );
  await kit.delay(1000);
  const hUsers = kit.result.calls.filter((call) => call.tools.includes("host_call")).map((call) => call.user);
  check(
    "W2 the Host agent saw the withdrawn inputs once, as the resent message",
    count(hUsers, "HK-Q-FOLLOW one") === 1 && count(hUsers, "HK-Q-STEER two") === 1,
    hUsers,
  );
  gateH = deferred();
  await type(hbox, "HK-GATE again");
  await ENTER();
  await eventually(
    () =>
      count(
        kit.result.calls.map((call) => call.user),
        "HK-GATE again",
      ) >= 1,
    "host second gated turn",
  );
  await page.waitFor(`!document.querySelector("#ha-composer").dataset.sending`, "host composer free");
  await type(hbox, "HK-KEEP me");
  await ALT_ENTER();
  await hostFree();
  gateH.open();
  await eventually(
    () => kit.result.calls.some((call) => call.tools.includes("host_call") && call.user.includes("HK-KEEP me")),
    "host kept input taken",
  );
  const hLate = await rpc({ action: "host-agent-dequeue" });
  await kit.delay(800);
  const hFinal = kit.result.calls.filter((call) => call.tools.includes("host_call")).map((call) => call.user);
  check(
    "W5 a Host input already taken is not restored and was answered once",
    hLate.restored.length === 0 && count(hFinal, "HK-KEEP me") === 1,
    [hLate, hFinal],
  );

  // W16: the Host agent's send writes its ledger entry, then submits; an Alt+Up in between must not give the input back while the send may still
  // submit it. Each input is given back and never delivered, or kept and delivered once.
  await eventually(async () => !(await rpc({ action: "host-agent-history" })).items.some((item) => item.running), "host agent idle");
  gateH = deferred();
  await type(hbox, "HK-GATE race");
  await ENTER();
  await eventually(
    () =>
      count(
        kit.result.calls.map((call) => call.user),
        "HK-GATE race",
      ) >= 1,
    "host race turn started",
  );
  const hostRace = [],
    hostGivenBack = new Set();
  for (let n = 0; n < 3; n++) {
    const text = `HK-RACE ${n}`;
    await rpc({ action: "host-agent-send", requestId: uuid(), text, delivery: "followUp" });
    hostRace.push(text);
    const taken = await rpc({ action: "host-agent-dequeue" });
    if (taken.restored.length) await rpc({ action: "host-agent-dequeue-ack", requestIds: taken.restored.map((item) => item.id) });
    for (const item of taken.restored) hostGivenBack.add(item.text);
  }
  gateH.open();
  await kit.delay(2500);
  const hostHistory = (await rpc({ action: "host-agent-history" })).items;
  const hostDelivered = (text) =>
    hostHistory.filter((entry) => entry.kind === "message" && entry.role === "user" && entry.text === text).length;
  check(
    "W16 a Host input is given back and never delivered, or kept and delivered once; never both",
    hostRace.every((text) => hostDelivered(text) === (hostGivenBack.has(text) ? 0 : 1)),
    { hostGivenBack: [...hostGivenBack], delivered: hostRace.map((text) => [text, hostDelivered(text)]) },
  );

  // Third pass (scripts/chat-queue-failures.md W23, W26, W27): the same request protocol on a worker and on the Host agent.
  const web = new URL((await rpc({ action: "web" })).url);
  const raw = async (body) =>
    (
      await fetch(`${web.origin}/api`, {
        method: "POST",
        headers: { authorization: `Bearer ${web.hash.slice("#token=".length)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const w23 = uuid();
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: w23, text: "W23-FIRST", delivery: "followUp" });
  const clash = await raw({ action: "thread-send", id, threadId: worker.id, requestId: w23, text: "W23-OTHER", delivery: "followUp" });
  check("W23 a worker refuses the same id with other text", clash.ok === false && clash.refused === true, clash);
  const clashMode = await raw({ action: "thread-send", id, threadId: worker.id, requestId: w23, text: "W23-FIRST", delivery: "steer" });
  check("W23 a worker refuses the same id with another delivery", clashMode.ok === false && clashMode.refused === true, clashMode);
  const sameAgain = await raw({ action: "thread-send", id, threadId: worker.id, requestId: w23, text: "W23-FIRST", delivery: "followUp" });
  check("W23 the same payload is accepted again", sameAgain.ok === true, sameAgain);
  await eventually(async () => (await threadState()).status !== "running", "worker settled after W23");
  const h23 = uuid();
  await rpc({ action: "host-agent-send", requestId: h23, text: "HK-W23 first", delivery: "followUp" });
  const hostClash = await raw({ action: "host-agent-send", requestId: h23, text: "HK-W23 other", delivery: "followUp" });
  check("W23 the Host agent refuses the same id with other text", hostClash.ok === false && hostClash.refused === true, hostClash);
  await eventually(
    async () => !(await rpc({ action: "host-agent-history" })).items.some((item) => item.running),
    "host agent idle after W23",
  );

  // W26: the owner sent a message while the worker worked; the delivery task passed its check and waits (seam) before it submits. Stop ends the
  // agent in between. The text is given back and never delivered, or kept and delivered once; `endedAt` is not proof that nobody will submit.
  gateW = deferred();
  await type(box, "W-GATE w26");
  await ENTER();
  await eventually(() => count(workerCalls(), "W-GATE w26") >= 1, "w26 gated turn");
  const w26 = uuid();
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: w26, text: "W26-TEXT SLOW-SUBMIT", delivery: "followUp" });
  await kit.delay(700);
  await rpc({ action: "thread-stop", id, threadId: worker.id });
  const w26back = await rpc({ action: "thread-dequeue", id, threadId: worker.id });
  gateW.open();
  await kit.delay(3000);
  const w26history = await rpc({ action: "thread-history", id, threadId: worker.id, limit: 200, messageText: "full" });
  const w26delivered = w26history.items.filter(
    (entry) => entry.kind === "message" && entry.role === "user" && entry.text.includes("W26-TEXT"),
  ).length;
  const w26offered = w26back.restored.filter((item) => item.id === w26).length;
  check(
    "W26 a stopped worker's input is given back and never delivered, or kept and delivered once; never both",
    (w26offered === 1 && w26delivered === 0) || (w26offered === 0 && w26delivered === 1),
    { w26offered, w26delivered, w26back },
  );

  // W27: a Host agent send whose outcome is unknown (the runtime took the input, the call failed). The ledger keeps the entry, so Alt+Up can still take
  // the input back while it waits.
  gateH = deferred();
  await type(hbox, "HK-GATE w27");
  await ENTER();
  await eventually(
    () =>
      count(
        kit.result.calls.map((call) => call.user),
        "HK-GATE w27",
      ) >= 1,
    "host w27 turn started",
  );
  const w27 = uuid();
  const lost = await raw({ action: "host-agent-send", requestId: w27, text: "HK-W27 LOST-OUTCOME", delivery: "followUp" });
  check("W27 an unknown outcome is not marked refused", lost.ok === false && lost.refused !== true, lost);
  const w27back = await rpc({ action: "host-agent-dequeue" });
  check(
    "W27 the Host agent still offers the input of an unknown send",
    w27back.restored.some((item) => item.id === w27 && item.text === "HK-W27 LOST-OUTCOME"),
    w27back,
  );
  await rpc({ action: "host-agent-dequeue-ack", requestIds: w27back.restored.map((item) => item.id) });
  gateH.open();
});
