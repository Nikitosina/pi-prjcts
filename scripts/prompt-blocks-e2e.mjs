// E2E: prompt blocks (scripts/prompt-blocks-failures.md P1–P14) on a private host with the fake provider: the requests,
// what coordinators, new and existing agents and the Host agent run with, and when a saved change reaches them.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { createKit, call, say, randomUUID } from "./lib/e2e-kit.mjs";

const holds = new Map();
const hold = (key) => {
  let release;
  const gate = new Promise((ok) => (release = ok));
  holds.set(key, { gate, release, started: false });
};
const held = (key, answer) => {
  const entry = holds.get(key);
  if (!entry || entry.started) return undefined;
  entry.started = true;
  return (async function* () {
    await entry.gate;
    yield say(answer);
  })();
};
const directive = (user) => {
  const match = /HA-CALL (\S+) (\{.*\})/.exec(user);
  return match ? [match[1], JSON.parse(match[2])] : null;
};
const kit = await createKit("prompt-blocks", {
  handler: ({ role, user, results, tools }) => {
    if (tools.includes("host_call")) {
      const wanted = directive(user);
      if (wanted && !results.length) return call(...wanted);
      if (wanted) return say(`HA-RESULT ${results.at(-1)}`);
      return say("ok");
    }
    if (role === "coordinator") {
      if (user.startsWith("[Durable work")) return say("Noted report.");
      if (user.includes("HOLD-COORD")) return held("coordinator", "Held reply.");
      const mark = /MARK-(WORKER|SCOUT|REVIEWER) (\S+)/.exec(user);
      if (mark && !results.length) return call("projects_delegate", { role: mark[1].toLowerCase(), task: `TASK-${mark[1]} ${mark[2]}` });
      if (mark) return say("Noted.");
    }
    return undefined;
  },
});

/** Topics published on a change stream while `during` runs. */
async function topics(project, during) {
  const web = new URL((await kit.rpc({ action: "web" })).url);
  const token = new URLSearchParams(web.hash.slice(1)).get("token");
  const seen = [];
  const req = httpRequest({
    host: web.hostname,
    port: web.port,
    path: `/changes?project=${project}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const open = new Promise((ok, fail) => {
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (part) => {
        for (const line of part.split("\n")) if (line.startsWith("data: ")) seen.push(JSON.parse(line.slice(6)));
      });
      ok();
    });
    req.on("error", fail);
  });
  req.end();
  await open;
  await during();
  await kit.delay(300);
  req.destroy();
  return seen.filter((frame) => frame.t === "topic").map((frame) => frame.topic);
}

await kit.run(async () => {
  const { rpc, check, rejects } = kit;
  kit.initRepo();
  const id = await kit.createProject("Blocks");
  const stored = () => JSON.parse(readFileSync(join(kit.home, id, "project.json"), "utf8"));
  const get = (target, projectId = id) => rpc({ action: "prompt-blocks-get", ...(target === "host" ? {} : { projectId }), target });
  const set = async (target, blocks, revision) =>
    rpc({
      action: "prompt-blocks-set",
      ...(target === "host" ? {} : { projectId: id }),
      target,
      revision: revision ?? (await get(target)).revision,
      blocks,
    });
  const inputs = (view) =>
    view.blocks.map(({ id: blockId, kind, name, enabled, text, edited }) =>
      kind === "custom" ? { id: blockId, name, enabled, text } : { id: blockId, enabled, ...(edited ? { text } : {}) },
    );
  const role = (render) => render.sections.find((section) => section.id === "role").text;

  // P1: built-ins, uncustomized, and the render's role section is the assembled blocks.
  const fresh = await get("worker");
  check(
    "P1 a fresh project shows the built-in worker blocks",
    !fresh.customized &&
      !fresh.legacy &&
      fresh.blocks.length === 4 &&
      fresh.blocks.every((block) => block.kind === "builtin" && block.enabled && block.tokens > 0),
    fresh,
  );
  check("P1 application is per agent for workers", fresh.application.adopts === "next-turn-per-agent", fresh.application);
  const render = await rpc({ action: "prompt-render", projectId: id, profile: "worker" });
  check(
    "P1 render role text equals the blocks",
    role(render) === fresh.text && render.basis === "configured" && render.label === "Configured for next use",
  );

  // P2: refused lists and stale revisions change nothing.
  const before = readFileSync(join(kit.home, id, "project.json"), "utf8");
  const list = inputs(fresh);
  for (const [label, blocks, pattern] of [
    ["duplicate", [...list, list[0]], /duplicate/],
    ["unknown built-in", [...list, { id: "made-up", enabled: true }], /unknown built-in/],
    ["missing built-in", list.slice(1), /missing built-in/],
    ["custom without name", [...list, { id: "custom:x", enabled: true, text: "x" }], /name/],
  ])
    check(
      `P2 ${label} refused`,
      pattern.test(
        String(await rejects({ action: "prompt-blocks-set", projectId: id, target: "worker", revision: fresh.revision, blocks })),
      ),
    );
  check(
    "P2 stale revision refused",
    /Settings revision conflict/.test(
      String(await rejects({ action: "prompt-blocks-set", projectId: id, target: "worker", revision: "0".repeat(64), blocks: list })),
    ),
  );
  check("P2 refusals leave project.json unchanged", readFileSync(join(kit.home, id, "project.json"), "utf8") === before);

  // P3 + P14: custom, disabled and reordered coordinator blocks reach the next coordinator request; authority stays.
  const coordinator = await get("coordinator");
  const [first, second, ...rest] = inputs(coordinator);
  const custom = { id: "custom:tone", name: "Tone", enabled: true, text: "CUSTOM-COORD: answer in one short paragraph." };
  const published = await topics(id, () => set("coordinator", [custom, second, { ...first, enabled: false }, ...rest]));
  check("P14 an owner save publishes the settings topic", published.includes("settings"), published);
  const saved = await get("coordinator");
  check(
    "P3 the saved order is the resolved order",
    saved.blocks.map((block) => block.id).join() === [custom.id, second.id, first.id, ...rest.map((b) => b.id)].join(),
  );
  await kit.ask(id, "plain question one");
  const system = kit.result.calls.findLast((c) => c.role === "coordinator").system;
  check("P3 the coordinator request carries the saved behavior", system.includes(saved.text) && system.includes(custom.text));
  check("P3 a disabled block is gone", !system.includes(coordinator.blocks[0].text));
  check(
    "P3 the host contract keeps its authority rules",
    system.includes("Tie every claim to the exact commit") && system.includes("Every tool answer stays in this chat"),
  );

  // P13: a coordinator chat that is working keeps its prompt and reports it pending; it adopts before its next message.
  hold("coordinator");
  await rpc({ action: "message", id, text: "HOLD-COORD please" });
  await kit.eventually(() => holds.get("coordinator").started, "held coordinator turn");
  const second2 = { id: "custom:second", name: "Second", enabled: true, text: "CUSTOM-COORD-TWO: sign off with a dash." };
  await set("coordinator", [...inputs(saved), second2]);
  const busy = await rpc({ action: "prompt-render", projectId: id, profile: "coordinator", chatId: "main" });
  check(
    "P13 a working chat is not called current",
    busy.active.chatId === "main" && !busy.active.matchesConfigured && busy.active.pending,
    busy.active,
  );
  holds.get("coordinator").release();
  await kit.settle(id);
  await kit.ask(id, "plain question two");
  const after = kit.result.calls.findLast((c) => c.role === "coordinator" && c.user.includes("plain question two"));
  check("P13 the chat adopts the change before its next message", after.system.includes(second2.text));
  const idle = await rpc({ action: "prompt-render", projectId: id, profile: "coordinator", chatId: "main" });
  check("P13 an adopted chat matches its configured prompt", idle.active.matchesConfigured && !idle.active.pending, idle.active);

  // P4: new agents start with the saved blocks.
  const worker = await get("worker");
  const workerCustom = { id: "custom:style", name: "Style", enabled: true, text: "CUSTOM-WORKER: prefer small commits." };
  await set("worker", [workerCustom, ...inputs(worker).map((block) => (block.id === "review" ? { ...block, enabled: false } : block))]);
  const scout = await get("scout");
  await set("scout", [{ id: "answer", enabled: true, text: "CUSTOM-SCOUT: answer with file paths only." }]);
  await kit.ask(id, "MARK-WORKER alpha");
  await kit.ask(id, "MARK-SCOUT alpha");
  const workerCall = kit.lastCall("worker", "TASK-WORKER alpha");
  check(
    "P4 a new worker starts with the saved blocks",
    workerCall?.system.includes((await get("worker")).text) &&
      !workerCall.system.includes(worker.blocks.find((b) => b.id === "review").text),
  );
  check(
    "P4 a new scout starts with its edited built-in",
    kit.lastCall("scout", "TASK-SCOUT alpha")?.system.includes("CUSTOM-SCOUT") &&
      !kit.lastCall("scout", "TASK-SCOUT alpha").system.includes(scout.blocks[0].text),
  );
  check(
    "P4 an edited built-in is stored as an edit, not a custom block",
    stored().promptBlocks.scout[0].text.startsWith("CUSTOM-SCOUT") && !stored().promptBlocks.scout[0].name,
  );

  // P9 + P10: one source per target.
  await set("scout", null);
  check("P9 null restores the built-ins and stores nothing", !stored().promptBlocks?.scout && !(await get("scout")).customized);
  await kit.updateSettings(id, { prompts: { reviewer: "LEGACY-REVIEWER text" } });
  const legacyReviewer = await get("reviewer");
  check("P10 a legacy override shows as legacy", legacyReviewer.legacy && legacyReviewer.text === "LEGACY-REVIEWER text", legacyReviewer);
  await set(
    "reviewer",
    inputs(legacyReviewer).map((block) => (block.kind === "builtin" ? { ...block, enabled: true } : block)),
  );
  check(
    "P10 saving blocks replaces the legacy override",
    !stored().prompts?.reviewer && stored().promptBlocks.reviewer && !(await get("reviewer")).legacy,
  );
  await kit.updateSettings(id, { prompts: { reviewer: "LEGACY-REVIEWER again" } });
  check(
    "P10 a later legacy write replaces the blocks",
    !stored().promptBlocks?.reviewer && (await get("reviewer")).text === "LEGACY-REVIEWER again",
  );
  await set("reviewer", null);
  check("P9 null also drops a legacy override", !stored().prompts?.reviewer && !(await get("reviewer")).customized);

  // P11 + P12 + P14: the Host agent's own prompt.
  const hostCalls = () => kit.result.calls.filter((c) => c.tools.includes("host_call"));
  const history = async () => (await rpc({ action: "host-agent-history" })).items;
  // History is a bounded page, so a newer entry id marks the answer; then the turn's end lets a saved prompt apply.
  const hostSend = async (text) => {
    const before = (await history()).at(-1)?.entryId ?? -1;
    await rpc({ action: "host-agent-send", requestId: randomUUID(), text });
    await kit.eventually(async () => {
      const items = await history(),
        last = items.at(-1);
      return (
        items.some((item) => item.kind === "message" && item.role === "user" && item.entryId > before) &&
        last.kind === "message" &&
        last.role === "assistant" &&
        last.text
      );
    }, `host agent answered: ${text}`);
    await kit.delay(300);
  };
  const host = await get("host");
  check(
    "P11 the host target starts at the built-in prompt",
    !host.customized && host.application.adopts === "next-turn" && !host.application.pending,
    host,
  );
  const hostTopics = await topics("host", () =>
    set("host", [...inputs(host), { id: "custom:one", name: "One", enabled: true, text: "HOST-CUSTOM-ONE" }]),
  );
  check("P14 a host save publishes the host-agent topic", hostTopics.includes("host-agent"), hostTopics);
  await hostSend("Reply exactly hello");
  check("P11 the Host agent's next turn carries its saved blocks", hostCalls().at(-1).system.includes("HOST-CUSTOM-ONE"));
  const toolsBefore = (await rpc({ action: "host-agent-settings" })).tools.map((tool) => tool.name).join();
  const current = await get("host");
  const selfEdit = {
    action: "prompt-blocks-set",
    input: {
      target: "host",
      revision: current.revision,
      blocks: [
        ...inputs(current).filter((b) => b.id !== "custom:one"),
        { id: "custom:two", name: "Two", enabled: true, text: "HOST-CUSTOM-TWO" },
      ],
    },
  };
  await hostSend(`HA-CALL host_call ${JSON.stringify(selfEdit)}`);
  const turn = hostCalls().filter((c) => c.user.includes("HA-CALL host_call"));
  check(
    "P11 the self-edit ran",
    turn.length === 2 && /HOST-CUSTOM-TWO/.test(turn[1].results.at(-1)),
    turn.map((c) => c.results),
  );
  check(
    "P11 the turn that edited keeps its instructions",
    turn[1].system.includes("HOST-CUSTOM-ONE") && !turn[1].system.includes("HOST-CUSTOM-TWO"),
  );
  await hostSend("Reply exactly again");
  check(
    "P11 the next turn adopts the self-edit",
    hostCalls().at(-1).system.includes("HOST-CUSTOM-TWO") && !hostCalls().at(-1).system.includes("HOST-CUSTOM-ONE"),
  );
  const hostRender = await rpc({ action: "prompt-render", profile: "host" });
  check(
    "P11 host render matches and is not pending",
    hostRender.active.matchesConfigured && !hostRender.active.pending && role(hostRender).includes("HOST-CUSTOM-TWO"),
  );
  const noActions = (await get("host")).blocks.map((b) =>
    b.id === "actions"
      ? { id: b.id, enabled: false }
      : b.kind === "custom"
        ? { id: b.id, name: b.name, enabled: b.enabled, text: b.text }
        : { id: b.id, enabled: b.enabled },
  );
  await set("host", noActions);
  check("P12 the owner can turn off the actions block", !(await get("host")).text.includes("host_call files an owner approval"));
  check(
    "P12 the Host agent's tools do not change with its prompt",
    (await rpc({ action: "host-agent-settings" })).tools.map((tool) => tool.name).join() === toolsBefore,
  );
  const gated = { action: "archive", input: { id }, summary: "Archive" };
  await hostSend(`HA-CALL host_call ${JSON.stringify(gated)}`);
  check(
    "P12 a dangerous action still files an approval",
    /approval/i.test(
      hostCalls()
        .findLast((c) => c.user.includes('"action":"archive"'))
        .results.at(-1),
    ) && !(await rpc({ action: "list" })).find((p) => p.id === id).archived,
  );
  await set("host", null);
  check("P9 the host target restores its built-in prompt", !(await get("host")).customized);
});
