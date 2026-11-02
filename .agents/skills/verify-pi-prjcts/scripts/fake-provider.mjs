// Fake OpenAI-completions provider for verification runs. Usage: node fake-provider.mjs <port-file> <request-log>
// Ordinary messages receive `VERIFY-FAKE-REPLY: <last user message>` and appends one JSON line per call to <request-log>.
// A message containing VERIFY-JOB scripts a Job: the coordinator spawns a worker, which plans and reports Ready with a PR and candidate.
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const [portFile, requestLog] = process.argv.slice(2);
if (!portFile || !requestLog) {
  console.error("usage: node fake-provider.mjs <port-file> <request-log>");
  process.exit(2);
}
const text = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
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
    if (names.includes("agents") && user.startsWith("[worker")) {
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
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      reply ??
        chunk({ role: "assistant", content: `VERIFY-FAKE-REPLY: ${user.slice(0, 200)}` }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
    );
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
