// E2E: `chat-stop` (docs/ui2-contract.md): stop one chat's running Coordinator turn, keep the other chat's, keep history,
// answer the next message, publish the chat topic. Failure cases S1-S4 in scripts/ui2-backend-failures.md. Private host, fake model.
import { request as httpRequest } from "node:http";
import { createKit, say } from "./lib/e2e-kit.mjs";

let release;
const hold = new Promise((ok) => (release = ok));
const kit = await createKit("chat-stop", {
  handler: ({ role, user }) => {
    if (role !== "coordinator") return undefined;
    if (user.includes("HOLD"))
      return (async function* () {
        await hold;
        yield say("released");
      })();
    return say(/Reply exactly (\S+)/.exec(user)?.[1] ?? "ok");
  },
});

/** Topic frames of `/changes?project=<id>` until `until(frames)` holds. */
async function changes(id, until, after) {
  const web = new URL((await kit.rpc({ action: "web" })).url);
  const token = new URLSearchParams(web.hash.slice(1)).get("token");
  return new Promise((resolve, reject) => {
    const seen = [];
    const req = httpRequest(
      { host: web.hostname, port: web.port, path: `/changes?project=${id}`, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          buffer += part;
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!block.startsWith("data: ")) continue;
            const frame = JSON.parse(block.slice(6));
            seen.push(frame);
            if (frame.t === "sync") void after().catch(reject);
            if (until(seen)) {
              req.destroy();
              resolve(seen);
            }
          }
        });
      },
    );
    req.on("error", (error) => (until(seen) ? undefined : reject(error)));
    req.setTimeout(30000, () => reject(Error("no matching change frame")));
    req.end();
  });
}

await kit.run(async () => {
  const { rpc, check, rejects, eventually } = kit;
  kit.initRepo();
  const id = await kit.createProject("Chat stop");
  const other = (await rpc({ action: "chat-create", id, title: "Other" })).id;
  const busy = async (chat) => (await rpc({ action: "show", id })).chats.find((item) => item.id === chat)?.busy;

  check("S3 an idle chat is not stopped", (await rpc({ action: "chat-stop", projectId: id, chatId: "main" })).stopped === false);
  check(
    "S3 an unknown chat is refused",
    /chat/i.test((await rejects({ action: "chat-stop", projectId: id, chatId: crypto.randomUUID() })) ?? ""),
  );

  await rpc({ action: "message", id, text: "HOLD main turn" });
  await rpc({ action: "message", id, chatId: other, text: "HOLD other turn" });
  await eventually(async () => (await busy("main")) && (await busy(other)), "both chats running");

  let stopped;
  const frames = await changes(
    id,
    (seen) => !!stopped && seen.some((frame) => frame.t === "topic" && frame.topic === "chat" && frame.chat === "main"),
    async () => {
      stopped = await rpc({ action: "chat-stop", projectId: id, chatId: "main", reason: "owner pressed stop" });
    },
  );
  check("S1 the running turn is stopped", stopped.stopped === true, stopped);
  check("S1 Main is idle after the stop", (await busy("main")) === false);
  check("S1 the other chat keeps running", (await busy(other)) === true);
  check(
    "S4 the chat topic is published",
    frames.some((frame) => frame.topic === "chat"),
    frames.slice(-5),
  );
  check("S2 history is kept", JSON.stringify(await rpc({ action: "show", id })).includes("HOLD main turn"));

  // kit.ask waits for the whole project to go idle, so the other chat is released first.
  release();
  await eventually(async () => (await busy(other)) === false, "other chat finished");
  await kit.ask(id, "Reply exactly AFTERSTOP");
  check("S2 the chat answers the next message", JSON.stringify(await rpc({ action: "show", id })).includes("AFTERSTOP"));
  check(
    "S3 an archived project is refused",
    await (async () => {
      await rpc({ action: "archive", id });
      return /inactive|archived/i.test((await rejects({ action: "chat-stop", projectId: id, chatId: "main" })) ?? "");
    })(),
  );
});
