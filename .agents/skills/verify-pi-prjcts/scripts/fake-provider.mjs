// Fake OpenAI-completions provider for verification runs. Usage: node fake-provider.mjs <port-file> <request-log>
// Ordinary messages receive `VERIFY-FAKE-REPLY: <last user message>` and appends one JSON line per call to <request-log>.
// A message containing VERIFY-JOB scripts a Job: the coordinator spawns a worker, which plans and reports Ready with a PR and candidate.
// VERIFY-MEMORY scripts a knowledge read and write; VERIFY-HOST scripts the Host agent (host_call list, ui_focus, a gated archive);
// VERIFY-HOST-APPROVE <id> asks the Host agent to archive that project, for an Approve; VERIFY-HOST-STATUS reorders the status line
// through ui_set and points at its settings; VERIFY-COORD-APPROVAL <id> has the coordinator file the same request through
// owner_approval_request. VERIFY-TABLE answers (any agent) with Markdown that mixes a table, nested and numbered lists, a quote and
// hostile HTML and links, for the chat renderers. VERIFY-IMAGE has the coordinator read the seeded screen.png (a tool result with an
// image) and cite its artifact reference plus a missing one.
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [portFile, requestLog] = process.argv.slice(2);
if (!portFile || !requestLog) {
  console.error("usage: node fake-provider.mjs <port-file> <request-log>");
  process.exit(2);
}
const text = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const TABLE_REPLY = [
  "Role summary:",
  "",
  "| Role | Model | Cost |",
  "|:-----|:-----:|-----:|",
  "| Coordinator | `**sol**` | $0.10 |",
  '| Worker <img src=x onerror="window.__xss=1"> | [bad](javascript:window.__xss=2) | ~~old~~ new |',
  "",
  "- outer",
  "  - nested",
  "",
  "3. three",
  "4. four",
  "",
  "> quoted **text**",
  "",
  "See https://example.com/docs. and ![pic](https://example.com/p.png)",
].join("\n");
let failNextSummary = false;
const server = createServer((req, res) => {
  if (req.method === "POST" && (req.url === "/fail-next-summary" || req.url === "/allow-summary")) {
    failNextSummary = req.url === "/fail-next-summary";
    res.writeHead(204).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", () => {
    const input = JSON.parse(body || "{}"),
      messages = input.messages ?? [];
    const user = text(messages.findLast((m) => m.role === "user")?.content);
    appendFileSync(
      requestLog,
      JSON.stringify({ at: new Date().toISOString(), model: input.model, tools: (input.tools ?? []).map((t) => t.function?.name), user }) +
        "\n",
    );
    const names = (input.tools ?? []).map((t) => t.function?.name);
    const stage = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "tool").length;
    const call = (name, args) =>
      chunk(
        {
          role: "assistant",
          tool_calls: [{ index: 0, id: `call-${stage}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        null,
      ) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n";
    const say = (content) => chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
    const title = "VERIFY-JOB greet the world";
    let reply;
    const uuidIn = (role) =>
      messages
        .filter((m) => m.role === role)
        .map((m) => text(m.content))
        .join(" ")
        .match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0];
    if (user.includes("VERIFY-TABLE")) {
      // The Host agent also cites an artifact, which its drawer cannot show (no project image route).
      reply = say(
        names.includes("host_call")
          ? `${TABLE_REPLY}\n\n![chart](artifact:00000000-0000-4000-8000-000000000000/binary/chart.png)`
          : TABLE_REPLY,
      );
    } else if (user.includes("VERIFY-IMAGE") && names.includes("read")) {
      const ref = messages
        .filter((m) => m.role === "tool")
        .map((m) => text(m.content))
        .join(" ")
        .match(/artifact:([a-f0-9-]{36})\/binary\/[\w.]+/);
      reply =
        stage === 0
          ? call("read", { path: "screen.png" })
          : say(
              ref
                ? `Screenshot:\n\n![screen](${ref[0]})\n\n![gone](artifact:${ref[1]}/binary/missing.png)`
                : "No artifact reference came back.",
            );
    } else if (names.includes("host_call") && user.startsWith("[approval ")) {
      reply = say(/denied/i.test(user) ? "Understood, nothing was archived." : "Done as approved.");
    } else if (names.includes("owner_approval_request") && user.includes("VERIFY-COORD-APPROVAL")) {
      reply =
        stage === 0
          ? call("owner_approval_request", {
              action: "archive",
              input: { id: user.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0] },
              summary: "Archive the second spare project",
            })
          : say("I asked you to approve archiving the second spare project.");
    } else if (names.includes("host_call") && user.includes("VERIFY-HOST-APPROVE")) {
      reply =
        stage === 0
          ? call("host_call", {
              action: "archive",
              input: { id: user.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0] },
              summary: "Archive the spare project",
            })
          : say("Archiving the spare project waits for your approval.");
    } else if (names.includes("ui_set") && user.includes("VERIFY-HOST-STATUS")) {
      // Host agent: reorder the status line (Connection first, Chat cost hidden), then point the browser at its settings.
      const order = ["connection", "activity", "model", "thinking", "context", "cost", "limits", "spacer", "hints"];
      reply =
        stage === 0
          ? call("ui_set", { patch: { statusItems: order.map((id) => ({ id, enabled: id !== "cost" })) } })
          : stage === 1
            ? call("ui_focus", { view: "settings", section: "statusline" })
            : say("Status line updated.");
    } else if (names.includes("host_call") && user.includes("VERIFY-HOST")) {
      // Host agent: list projects, point the browser at Memory, then ask to archive the first project (gated by an approval).
      reply =
        stage === 0
          ? call("host_call", { action: "list", input: {} })
          : stage === 1
            ? call("ui_focus", { view: "memory" })
            : stage === 2
              ? call("host_call", { action: "archive", input: { id: uuidIn("tool") }, summary: "Archive the Verify seed project" })
              : say("Archiving Verify seed waits for your approval.");
    } else if (names.includes("agents") && user.startsWith("[worker")) {
      reply = say(
        user.includes(" checkpoint:")
          ? "The intermediate result needs your decision."
          : "The work is ready. Proof is available in the task details.",
      );
    } else if (user.includes("VERIFY-CHECKPOINT") && names.includes("agents")) {
      reply =
        stage === 0
          ? call("agents", {
              action: "spawn",
              role: "worker",
              title: "VERIFY-CHECKPOINT intermediate work",
              brief: "VERIFY-CHECKPOINT preserve the intermediate result and return for an owner decision.",
              acceptance: ["Preserve the intermediate result for an owner decision."],
              requestId: "verify-checkpoint",
            })
          : say("Preparing the intermediate result.");
    } else if (user.includes("VERIFY-CHECKPOINT") && names.includes("job")) {
      reply =
        stage === 0
          ? call("job", {
              action: "checkpoint",
              summary: "Preserved the intermediate changes.",
              proof: ["checkpoint-evidence"],
              gaps: ["Owner decision needed before continuing."],
            })
          : say("Checkpoint recorded.");
    } else if (user.includes("VERIFY-JOB") && names.includes("agents") && !user.startsWith("[worker")) {
      reply =
        stage === 0
          ? call("agents", {
              action: "spawn",
              role: "worker",
              title,
              brief: `${title}: add a greeting.`,
              acceptance: ["It greets."],
              requestId: "verify-job",
            })
          : say("Started the Job.");
    } else if (user.includes("VERIFY-CODEMODE") && names.includes("codemode")) {
      reply =
        stage === 0
          ? call("codemode", {
              code: `try { await tools.read({ path: "missing-ui2.txt" }); } catch {}\nconst nested = await tools.bash({ command: "sleep 2; printf nested-ok" });\nconsole.log(nested.output);`,
            })
          : say("Nested codemode finished.");
    } else if (user.includes("VERIFY-MEMORY") && names.includes("projects_knowledge_write")) {
      // Memory rows: the coordinator reads the preferences, then records a decision.
      reply =
        stage === 0
          ? call("projects_knowledge_read", { path: "preferences.md" })
          : stage === 1
            ? call("projects_knowledge_write", {
                path: "decisions/greeting-style.md",
                text: "# Greeting style\n\nGreet in one short line, no emoji.\n",
                expectedRevision: null,
              })
            : say("Remembered the greeting style.");
    } else if (user.includes("VERIFY-JOB") && names.includes("job")) {
      const steps = (done) => [
        { title: "Write the greeting", status: done ? "done" : "doing", estimateMin: 5 },
        { title: "Check it", status: done ? "done" : "todo", estimateMin: 3 },
      ];
      reply =
        stage === 0
          ? call("job", { action: "plan", steps: steps(false) })
          : stage === 1
            ? call("job", { action: "plan", steps: steps(true) })
            : stage === 2
              ? call("job", {
                  action: "ready",
                  summary: "Added the greeting.",
                  pr: "12",
                  candidate: "a".repeat(40),
                  proof: ["greeting printed"],
                })
              : say("Done.");
    }
    if (/conversation to summarize/.test(user) && failNextSummary) {
      res.writeHead(500, { "content-type": "text/plain" }).end("UI2-SUMMARY-FAIL scripted");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (user.includes("VERIFY-STOP") && names.includes("agents") && stage === 0) {
      // The provider tail stays pending; Stop must abort it instead of waiting for the provider.
      res.write(chunk({ role: "assistant", content: "working" }, null));
      void delay(60000).then(() => {
        if (!res.destroyed && !res.writableEnded) res.end(chunk({}, "stop") + "data: [DONE]\n\n");
      });
      return;
    }
    res.end(
      reply ??
        chunk({ role: "assistant", content: `VERIFY-FAKE-REPLY: ${user.slice(0, 200)}` }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
    );
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
