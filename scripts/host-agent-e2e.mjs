// Host agent and owner approvals (scripts/host-agent-failures.md): send and reply, host_call, dangerous calls gated by approvals
// (approve, deny, exactly once, restart), the Coordinator approval tool, live and change streams, and the allow-list check.
import { request as httpRequest } from "node:http";
import { createKit } from "./lib/e2e-kit.mjs";
import { Request } from "../src/state.ts";
import { ACTION_POLICY, DANGEROUS_MINIMUM } from "../src/host-agent-tools.ts";

let releaseHold;
const hold = new Promise((ok) => (releaseHold = ok));
const directive = (user, name) => {
  const match = new RegExp(`${name} (\\S+) (\\{.*\\})`).exec(user);
  return match ? [match[1], JSON.parse(match[2])] : null;
};
const kit = await createKit("host-agent", {
  handler: async ({ tools, user, results }) => {
    if (tools.includes("host_call")) {
      if (user.includes("HA-HOLD"))
        return (async function* () {
          await hold;
        })();
      const wanted = directive(user, "HA-CALL");
      if (wanted && !results.length) return kit.call(...wanted);
      if (wanted) return kit.say(`HA-RESULT ${results.at(-1)}`);
      if (user.startsWith("[approval ")) return kit.say("Noted the owner's decision.");
      return kit.say(/Reply exactly (\S+)/.exec(user)?.[1] ?? "ok");
    }
    if (tools.includes("owner_approval_request")) {
      const wanted = directive(user, "CO-GATE");
      if (wanted && !results.length) return kit.call(...wanted);
      if (wanted) return kit.say(`CO-RESULT ${results.at(-1)}`);
      if (user.startsWith("[approval ")) return kit.say("Coordinator noted the decision.");
    }
    return undefined;
  },
});

/** Frames of a server-sent-events endpoint of the owned web server until `until` (a count or a predicate), then disconnect. */
async function frames(path, until, after = async () => {}) {
  const done = (seen) => (typeof until === "number" ? seen.length >= until : until(seen));
  const web = new URL((await kit.rpc({ action: "web" })).url);
  const token = new URLSearchParams(web.hash.slice(1)).get("token");
  return new Promise((resolve, reject) => {
    const seen = [];
    const req = httpRequest(
      { host: web.hostname, port: web.port, path, headers: { authorization: `Bearer ${token}` }, timeout: 30000 },
      (res) => {
        if (res.statusCode !== 200) return reject(Error(`${path}: HTTP ${res.statusCode}`));
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          buffer += part;
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!block.startsWith("data: ")) continue;
            seen.push(JSON.parse(block.slice(6)));
            if (seen.length === 1) void after().catch(reject);
            if (done(seen)) {
              req.destroy();
              resolve(seen);
            }
          }
        });
      },
    );
    req.on("error", (error) => (done(seen) ? undefined : reject(error)));
    req.end();
  });
}

await kit.run(async () => {
  const { rpc, check, eventually, rejects } = kit;

  // Allow-list completeness against the live Request union.
  const actions = Request.anyOf.map((member) => member.properties.action.const);
  const missing = actions.filter((action) => !ACTION_POLICY[action]),
    unknown = Object.keys(ACTION_POLICY).filter((action) => !actions.includes(action));
  check("every Request action has a policy", !missing.length && !unknown.length, { missing, unknown });
  check(
    "excluded actions name a reason",
    Object.values(ACTION_POLICY).every((policy) => policy.kind !== "exclude" || policy.reason.length > 10),
  );
  check(
    "contract dangerous actions are gated",
    DANGEROUS_MINIMUM.every((action) => !actions.includes(action) || ACTION_POLICY[action].kind === "dangerous"),
    DANGEROUS_MINIMUM.filter((action) => actions.includes(action) && ACTION_POLICY[action].kind !== "dangerous"),
  );
  check("the agent cannot decide approvals", ACTION_POLICY["approval-decide"]?.kind === "exclude");

  kit.initRepo();
  const id = await kit.createProject("Host agent fixture");

  // Settings: stale revision and unknown model are refused; a catalog model is saved.
  const initial = await rpc({ action: "host-agent-settings" });
  check(
    "settings expose the agent's tools",
    ["host_actions", "host_call", "ui_focus", "ui_set"].every((name) => initial.tools.some((tool) => tool.name === name)),
    initial.tools,
  );
  check(
    "settings list gated actions",
    initial.actions.some((action) => action.name === "delete" && action.dangerous),
    initial.actions?.slice(0, 5),
  );
  check(
    "unknown model is refused",
    /model/i.test((await rejects({ action: "host-agent-settings", revision: initial.revision, patch: { model: "nope/missing" } })) ?? ""),
  );
  const saved = await rpc({
    action: "host-agent-settings",
    revision: initial.revision,
    patch: { model: "fake/fake-model", thinking: "high" },
  });
  check("settings saved", saved.effectiveModel === "fake/fake-model" && saved.thinking === "high", saved);
  check(
    "stale settings revision is refused",
    /revision/i.test((await rejects({ action: "host-agent-settings", revision: initial.revision, patch: { thinking: "low" } })) ?? ""),
  );

  const history = async () => (await rpc({ action: "host-agent-history" })).items;
  const messages = async () => (await history()).filter((item) => item.kind === "message");
  const send = async (text) => {
    const before = (await messages()).length;
    await rpc({ action: "host-agent-send", requestId: crypto.randomUUID(), text });
    return eventually(async () => {
      const items = await history(),
        now = items.filter((item) => item.kind === "message"),
        last = items.at(-1);
      return now.length > before && last.kind === "message" && last.role === "assistant" && last.text ? now : null;
    }, `host agent answered: ${text}`);
  };

  // Send and reply; owner origin.
  const ponged = await send("Reply exactly PONG");
  check("reply", ponged.at(-1).text === "PONG", ponged.slice(-2));
  check("owner origin", ponged.at(-2).origin === "owner", ponged.at(-2));

  // An allowed call runs through dispatch.
  const listed = await send(`HA-CALL host_call {"action":"list","input":{}}`);
  check("allowed host_call runs", listed.at(-1).text.includes("Host agent fixture"), listed.at(-1).text.slice(0, 400));
  check(
    "unknown action is refused",
    /not available|unknown/i.test((await send(`HA-CALL host_call {"action":"nope","input":{}}`)).at(-1).text),
  );

  // A dangerous call becomes a pending approval and does not run.
  const gated = await send(`HA-CALL host_call {"action":"archive","input":{"id":"${id}"},"summary":"Archive the fixture"}`);
  check("dangerous call answers pending", /pending/i.test(gated.at(-1).text), gated.at(-1).text);
  const pending = await eventually(
    async () => (await rpc({ action: "approvals-list" })).approvals.find((a) => a.action === "archive" && a.state === "pending"),
    "pending archive approval",
  );
  check(
    "approval stores the exact request",
    pending.input.action === "archive" && pending.input.id === id && pending.requestedBy.kind === "host-agent",
    pending,
  );
  check("project not archived yet", !(await rpc({ action: "list" })).find((p) => p.id === id).archived);

  // Live and change streams for the host.
  const live = await frames("/live?project=host", 1);
  check("host live frame", typeof live[0].entries === "number" && live[0].running === false, live[0]);
  const changes = await frames(
    "/changes?project=host",
    (seen) => seen.some((frame) => frame.type === "focus"),
    () => send(`HA-CALL ui_focus {"view":"project","projectId":"${id}"}`),
  );
  const focus = changes.find((frame) => frame.topic === "host-agent" && frame.type === "focus");
  check("ui_focus frame on the host change feed", focus?.view === "project" && focus.projectId === id, changes);

  // Restart keeps history and the pending approval.
  await kit.restartHost();
  check(
    "history survives restart",
    (await messages()).some((item) => item.text === "PONG"),
  );
  check(
    "pending approval survives restart",
    (await rpc({ action: "approvals-list" })).approvals.some((a) => a.id === pending.id && a.state === "pending"),
  );

  // Approve: runs once, posts the outcome; a second decision is refused.
  const decided = await rpc({ action: "approval-decide", id: pending.id, decision: "approve" });
  check("approved and done", decided.approval.state === "done", decided);
  check("project archived", (await rpc({ action: "list" })).find((p) => p.id === id).archived === true);
  check(
    "second decision refused",
    /already|not pending/i.test((await rejects({ action: "approval-decide", id: pending.id, decision: "approve" })) ?? ""),
  );
  await eventually(
    async () => (await messages()).some((m) => m.origin === "internal" && m.text.includes(pending.id) && /approved/i.test(m.text)),
    "approve outcome posted to the Host agent",
  );

  // Deny: never runs, posts the denial.
  await send(`HA-CALL host_call {"action":"delete","input":{"id":"${id}","confirm":"${id}"},"summary":"Delete the fixture"}`);
  const deletion = (await rpc({ action: "approvals-list" })).approvals.find((a) => a.action === "delete" && a.state === "pending");
  const denied = await rpc({ action: "approval-decide", id: deletion.id, decision: "deny", note: "keep it" });
  check("denied", denied.approval.state === "denied", denied);
  check(
    "denied project kept",
    (await rpc({ action: "list" })).some((p) => p.id === id && !p.deleted),
  );
  await eventually(
    async () => (await messages()).some((m) => m.origin === "internal" && m.text.includes(deletion.id) && /denied/i.test(m.text)),
    "deny outcome posted",
  );

  // Coordinator gate: the project is active again through allowed calls.
  await send(`HA-CALL host_call {"action":"restore","input":{"id":"${id}"}}`);
  check("restored through host_call", !(await rpc({ action: "list" })).find((p) => p.id === id).archived);
  // Archiving paused the plan; restore keeps it paused until resumed.
  await send(`HA-CALL host_call {"action":"resume","input":{"id":"${id}"}}`);
  const target = await kit.createProject("Approval target", { grant: false });
  await kit.ask(id, `CO-GATE owner_approval_request {"action":"list","input":{},"summary":"List"}`);
  check("only dangerous actions can be requested", !(await rpc({ action: "approvals-list" })).approvals.some((a) => a.action === "list"));
  check(
    "coordinator told why",
    /needs no approval/.test(kit.toolResult("coordinator", "CO-GATE")),
    kit.toolResult("coordinator", "CO-GATE"),
  );
  await kit.ask(id, `CO-GATE owner_approval_request {"action":"archive","input":{"id":"${target}"},"summary":"Archive the target"}`);
  const gate = (await rpc({ action: "approvals-list" })).approvals.find((a) => a.action === "archive" && a.state === "pending");
  check(
    "coordinator approval pending",
    gate?.requestedBy.kind === "coordinator" && gate.requestedBy.projectId === id && gate.requestedBy.chatId === "main",
    gate,
  );
  check("target not archived before approval", !(await rpc({ action: "list" })).find((p) => p.id === target).archived);
  const gateDone = await rpc({ action: "approval-decide", id: gate.id, decision: "approve" });
  check("coordinator approval done", gateDone.approval.state === "done", gateDone);
  check("target archived", (await rpc({ action: "list" })).find((p) => p.id === target).archived === true);
  await eventually(async () => {
    const page = await rpc({ action: "chat-history", id });
    return page.items.some((item) => item.kind === "message" && item.origin === "internal" && item.text.includes(gate.id));
  }, "outcome posted to the coordinator chat");

  // Reset keeps history; stop clears a busy turn.
  await rpc({ action: "host-agent-reset" });
  const afterReset = await history(),
    resetItem = afterReset.find((item) => item.kind === "reset");
  check(
    "reset keeps history",
    resetItem && afterReset.some((item) => item.kind === "message" && item.entryId < resetItem.entryId),
    afterReset.slice(-3),
  );
  await rpc({ action: "host-agent-send", requestId: crypto.randomUUID(), text: "HA-HOLD" });
  await eventually(async () => (await frames("/live?project=host", 1))[0].running, "host agent busy");
  check("stop", (await rpc({ action: "host-agent-stop" })).stopped === true);
  releaseHold();
  await eventually(async () => !(await frames("/live?project=host", 1))[0].running, "host agent idle after stop");
});
releaseHold();
