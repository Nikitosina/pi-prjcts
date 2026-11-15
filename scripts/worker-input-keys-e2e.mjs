// E2E: Pi input keys in the Worker composer and the Host agent drawer (scripts/chat-queue-failures.md, cases 15-17). Real key events in headless
// Chrome on a private host with the fake provider: Enter steers a running agent, Alt+Enter queues a follow-up delivered after its turn.
import { createKit, say } from "./lib/e2e-kit.mjs";

let releaseWorker, releaseHost;
const workerHold = new Promise((ok) => (releaseWorker = ok));
const hostHold = new Promise((ok) => (releaseHost = ok));
const kit = await createKit("worker-input-keys", {
  handler: ({ role, user, results, tools }) => {
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
    if (tools.includes("host_call") && user.includes("HK-HOLD"))
      return (async function* () {
        await hostHold;
        yield say("HK-FIRST");
      })();
    if (tools.includes("host_call")) return say(`HK-ANSWER ${user.slice(0, 40)}`);
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
    ALT_ENTER = () => key("Enter", "Enter", 13, 1);

  // Spawn one held worker through the Coordinator, then open it in the browser.
  await rpc({ action: "message", id, text: "KEYS-SPAWN" });
  const worker = await eventually(
    async () => (await rpc({ action: "jobs-snapshot", id })).agents?.find((agent) => agent.title === "KEYS-WORKER" && agent.working),
    "worker running",
  );
  await page.evaluate(`document.querySelector('[data-open-worker="${worker.id}"]').click()`);
  const box = `#focus-view .worker-send textarea`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(box)})`, "worker composer");

  // 15: Enter on a running worker steers; Alt+Enter queues a follow-up.
  await type(box, "W-STEER now");
  await ENTER();
  await kit.delay(1500);
  await page.shot("dbg", { force: true });
  console.log("DBG", await page.evaluate(`document.body.innerText.slice(-600) + " | VAL=" + document.querySelector(${JSON.stringify(box)})?.value`));
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
    `!!document.querySelector(${JSON.stringify(hbox)}) && document.querySelector("#host-agent").offsetParent !== null`,
    "drawer",
  );
  await type(hbox, "HK-HOLD start");
  await ENTER();
  await eventually(async () => kit.result.calls.some((call) => call.user.includes("HK-HOLD")), "host busy");
  await type(hbox, "HK-STEER now");
  await ENTER();
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
});
