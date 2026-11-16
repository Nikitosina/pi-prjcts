// E2E: Pi input semantics for the Coordinator chat. Failure cases Q1-Q10 in scripts/chat-queue-failures.md. Private host, fake model.
import { createKit, say } from "./lib/e2e-kit.mjs";

let release, releaseWorker;
const hold = new Promise((ok) => (release = ok));
const workerHold = new Promise((ok) => (releaseWorker = ok));
const seen = [];
// Every message the Coordinator's model was given: a steering turn carries the queued report with it, so the last message alone does not show it.
const given = [];
const kit = await createKit("chat-queue", {
  handler: ({ role, user, results, msgs }) => {
    // The worker answers only when released, so its report reaches the Coordinator while the Coordinator is busy: an internal queued input.
    if (role === "worker" && user.includes("Q11-TASK"))
      return (async function* () {
        await workerHold;
        yield say("Q11 answered");
      })();
    if (role !== "coordinator") return undefined;
    seen.push(user);
    given.push(JSON.stringify(msgs));
    if (user.includes("SPAWN-W") && !results.length)
      return kit.call("agents", {
        action: "spawn",
        role: "worker",
        title: "Q11-WORKER",
        brief: "Q11-TASK answer at once",
        acceptance: ["done"],
        requestId: crypto.randomUUID(),
      });
    if (user.includes("HOLD"))
      return (async function* () {
        await hold;
        yield say("released");
      })();
    return say(`ACK ${/(STEER|FOLLOW)-\w+/.exec(user)?.[0] ?? "other"}`);
  },
});

await kit.run(async () => {
  const { rpc, check, rejects, eventually } = kit;
  kit.initRepo();
  const id = await kit.createProject("Chat queue");
  const other = (await rpc({ action: "chat-create", id, title: "Other" })).id;
  const busy = async () => (await rpc({ action: "show", id })).chats.find((item) => item.id === "main")?.busy;
  const ledger = async (chatId = "main") => (await rpc({ action: "show", id, ...(chatId === "main" ? {} : { chatId }) })).jobs;
  const send = (text, delivery, requestId = crypto.randomUUID(), chatId) =>
    rpc({ action: "message", id, text, requestId, ...(delivery ? { delivery } : {}), ...(chatId ? { chatId } : {}) });

  check(
    "Q6 dequeue on an idle chat returns nothing",
    JSON.stringify(await rpc({ action: "chat-dequeue", projectId: id })) === '{"restored":[],"kept":[]}',
  );
  check(
    "Q10 an unknown chat is refused",
    /chat/i.test((await rejects({ action: "chat-dequeue", projectId: id, chatId: crypto.randomUUID() })) ?? ""),
  );

  // A worker that answers while the Coordinator is busy: its report is queued as an internal input (Q11).
  await send("SPAWN-W now");
  await eventually(
    async () => (await rpc({ action: "jobs-snapshot", id })).agents?.find((agent) => agent.title === "Q11-WORKER" && agent.working),
    "worker running",
  );
  await eventually(async () => !(await busy()), "idle after the spawn");
  await send("HOLD first turn");
  await eventually(busy, "main is running");
  releaseWorker();
  await eventually(
    async () => !(await rpc({ action: "jobs-snapshot", id })).agents?.find((agent) => agent.title === "Q11-WORKER")?.working,
    "worker answered",
  );
  await kit.delay(1000); // the report is queued behind the held turn
  const f1 = await send("FOLLOW-A one", "followUp"),
    s1 = await send("STEER-A one", "steer"),
    f2 = await send("FOLLOW-B two", "followUp");
  const otherJob = await send("FOLLOW-OTHER elsewhere", "followUp", crypto.randomUUID(), other);
  check(
    "Q1 the ledger keeps each delivery mode",
    (await ledger())
      .filter((job) => job.state === "queued")
      .map((job) => `${job.id === s1.id ? "steer" : "followUp"}:${job.delivery}`)
      .join() === "followUp:followUp,steer:steer,followUp:followUp",
    await ledger(),
  );
  const again = await send("FOLLOW-A one", "followUp", f1.id);
  check(
    "Q2 a repeated request id returns the admitted job and queues nothing new",
    again.id === f1.id && (await ledger()).filter((job) => job.text.startsWith("FOLLOW-A")).length === 1,
  );

  // Withdraw only what is asked for: Q9.
  const some = await rpc({ action: "chat-dequeue", projectId: id, requestIds: [f2.id] });
  check(
    "Q9 dequeue by id withdraws only that input",
    some.restored.length === 1 && some.restored[0].id === f2.id && some.restored[0].text === "FOLLOW-B two",
    some,
  );
  await rpc({ action: "chat-dequeue-ack", projectId: id, requestIds: [f2.id] });
  check(
    "Q9 another chat's queue is untouched",
    (await ledger(other)).some((job) => job.id === otherJob.id),
  );

  const all = await rpc({ action: "chat-dequeue", projectId: id });
  check(
    "Q4 Alt+Up returns steering first, then follow-up, with the typed text",
    all.restored.map((item) => `${item.delivery}:${item.text}`).join("|") === "steer:STEER-A one|followUp:FOLLOW-A one",
    all,
  );
  check(
    "Q11 Alt+Up never lists an internal input",
    all.restored.every((item) => /^(STEER|FOLLOW)-/.test(item.text)),
    all,
  );
  check("Q3 withdrawn messages are not queued any more", !(await ledger()).some((job) => job.state === "queued"), await ledger());
  // Q12: the page never saw the response above; asking again returns the same text, and only an acknowledgement drops it.
  const again2 = await rpc({ action: "chat-dequeue", projectId: id });
  check("Q12 an unacknowledged restore is offered again", JSON.stringify(again2.restored) === JSON.stringify(all.restored), again2);
  await rpc({ action: "chat-dequeue-ack", projectId: id, requestIds: all.restored.map((item) => item.id) });
  check("Q12 an acknowledged restore leaves the ledger", !(await ledger()).some((job) => ["queued", "withdrawn"].includes(job.state)));
  check("Q6 a second dequeue returns nothing", (await rpc({ action: "chat-dequeue", projectId: id })).restored.length === 0);

  // Q13: a queued Telegram-origin message with an upload comes back with both, so sending it again is the same message.
  const web = new URL((await rpc({ action: "web" })).url);
  const uploaded = await (
    await fetch(`${web.origin}/upload?project=${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${web.hash.slice("#token=".length)}`, "x-filename": "notes.txt" },
      body: "attached text\n",
    })
  ).json();
  const withFile = await rpc({
    action: "message",
    id,
    text: "FOLLOW-F with a file",
    requestId: crypto.randomUUID(),
    delivery: "followUp",
    origin: "telegram",
    attachments: [uploaded.data.id],
  });
  const back = (await rpc({ action: "chat-dequeue", projectId: id, requestIds: [withFile.id] })).restored[0];
  check(
    "Q13 a restored message keeps its attachments and origin",
    back?.attachments?.join() === uploaded.data.id && back.origin === "telegram",
    back,
  );
  await rpc({ action: "chat-dequeue-ack", projectId: id, requestIds: [withFile.id] });

  // Two follow-ups and a steer go through one at a time; the withdrawn ones never reach the model (Q7, Q8).
  const f3 = await send("FOLLOW-C three", "followUp"),
    f4 = await send("FOLLOW-D four", "followUp"),
    s2 = await send("STEER-B two", "steer");
  release();
  await eventually(
    async () => !(await busy()) && (await ledger()).every((job) => job.state !== "queued" && job.state !== "running"),
    "queue drained",
    60000,
  );
  const transcript = async () => JSON.stringify(await rpc({ action: "chat-history", id, limit: 100, messageText: "full" }));
  const text = await transcript();
  const turns = [...text.matchAll(/"role":"(user|assistant)"[^}]*?"text":"([^"]*)"/g)].map((m) => `${m[1]}: ${m[2]}`);
  const at = (needle) => turns.findIndex((turn) => turn.includes(needle));
  check("Q7 withdrawn inputs were never delivered", !seen.some((user) => /STEER-A|FOLLOW-A|FOLLOW-B/.test(user)), seen);
  check(
    "Q8 each queued input is answered in its own turn",
    at("user: FOLLOW-D") > at("assistant: ACK STEER-B") && at("assistant: ACK FOLLOW-D") > at("user: FOLLOW-D"),
    turns,
  );

  // Q5 race: a delivered input is kept, never restored.
  const late = await send("FOLLOW-E five", "followUp");
  await eventually(async () => !(await busy()), "idle again");
  const raced = await rpc({ action: "chat-dequeue", projectId: id, requestIds: [late.id, f3.id] });
  check(
    "Q5 delivered inputs are kept, not restored",
    raced.restored.length === 0 && raced.kept.includes(late.id) && raced.kept.includes(f3.id),
    raced,
  );
  check("Q5 a delivered input appears once", ((await transcript()).match(/FOLLOW-E five/g) ?? []).length === 1);
  await eventually(
    async () => (await busy()) === false && given.some((request) => request.includes("[worker ") && request.includes("Q11 answered")),
    "Q11 the worker's report was not withdrawn: the Coordinator still answered it",
    80,
  ).catch((error) => check(error.message, false, seen));

  // Third pass (scripts/chat-queue-failures.md W23-W25, W27, W33): one request protocol.
  const token = web.hash.slice("#token=".length);
  const raw = async (body) =>
    (
      await fetch(`${web.origin}/api`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const idle = () => eventually(async () => !(await busy()), "idle", 120);
  await idle();
  const w23 = crypto.randomUUID();
  await send("W23 first text", "followUp", w23);
  const clash = await raw({ action: "message", id, text: "W23 other text", requestId: w23, delivery: "followUp" });
  check(
    "W23 the same id with other text is refused as a refusal",
    clash.ok === false && clash.refused === true && /request/i.test(clash.error),
    clash,
  );
  const clashMode = await raw({ action: "message", id, text: "W23 first text", requestId: w23, delivery: "steer" });
  check("W23 the same id with another delivery is refused too", clashMode.ok === false && clashMode.refused === true, clashMode);
  const same = await raw({ action: "message", id, text: "W23 first text", requestId: w23, delivery: "followUp" });
  check("W23 the same id with the same payload returns the admitted job", same.ok === true && same.data.id === w23, same);
  const unknownChat = await raw({ action: "message", id, text: "W33 refused", chatId: crypto.randomUUID() });
  check(
    "W33 a validation failure before any write is marked refused",
    unknownChat.ok === false && unknownChat.refused === true,
    unknownChat,
  );
  await idle();

  // W24: the host died after the ledger write and before the runtime submission. The retry of the id runs the message; it is not returned as if it ran.
  const w24 = crypto.randomUUID();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    `${kit.home}/${id}/inbox/${w24}.json`,
    JSON.stringify({
      id: w24,
      text: "W24-TEXT crashed before submit",
      at: new Date().toISOString(),
      state: "queued",
      error: null,
      delivery: "followUp",
    }),
  );
  await send("W24-TEXT crashed before submit", "followUp", w24);
  await eventually(async () => seen.some((user) => user.includes("W24-TEXT")), "W24 the retried message ran", 120).catch((error) =>
    check(error.message, false, seen),
  );
  await idle();
  check("W24 the retried message settled in the ledger", (await ledger()).find((job) => job.id === w24)?.state === "done", await ledger());

  // W25: two overlapping Alt+Up while the message handler is between its ledger write and its submission. The text is given back and never
  // delivered, or kept and delivered once; never both.
  const w25 = crypto.randomUUID();
  const slow = send("W25-TEXT", "followUp", w25);
  const [d1, d2] = await Promise.all([rpc({ action: "chat-dequeue", projectId: id }), rpc({ action: "chat-dequeue", projectId: id })]);
  await slow;
  await idle();
  const offered = [...d1.restored, ...d2.restored].filter((item) => item.id === w25);
  const delivered = seen.filter((user) => user.includes("W25-TEXT")).length;
  check(
    "W25 given back and never delivered, or kept and delivered once; never both",
    (offered.length > 0 && delivered === 0) || (offered.length === 0 && delivered === 1),
    {
      offered,
      delivered,
    },
  );
  await rpc({ action: "chat-dequeue-ack", projectId: id, requestIds: offered.map((item) => item.id) }).catch(() => {});
  check(
    "Q10 an archived project is refused",
    await (async () => {
      await rpc({ action: "archive", id });
      return /inactive|archived/i.test((await rejects({ action: "chat-dequeue", projectId: id })) ?? "");
    })(),
  );
  void f4;
  void s2;
});
