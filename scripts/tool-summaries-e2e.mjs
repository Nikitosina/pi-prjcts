// E2E: tool summaries and thinking visibility (scripts/tool-summaries-failures.md) on a private host with the fake provider, through
// the RPCs, a host restart and the browser: Coordinator chat, worker transcript and the Host agent.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, delay, randomUUID, say } from "./lib/e2e-kit.mjs";

const SUMMARY_SYSTEM = "You summarize what an AI agent's tool calls did";
const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
/** One assistant message with several tool calls. */
const calls = (...list) =>
  chunk(
    {
      role: "assistant",
      tool_calls: list.map(([name, args], index) => ({
        index,
        id: `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      })),
    },
    null,
  ) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";
const thinkThenSay = (thinking, text) =>
  chunk({ role: "assistant", reasoning_content: thinking }, null) + chunk({ content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

// The summary model's behaviour: "ok" answers, "fail" refuses, "hold" waits for `release`.
const summary = { mode: "ok", requests: [], release: () => {} };
const kit = await createKit("tool-summaries", {
  handler: async ({ role, user, results, system, tools, request }) => {
    if (system.startsWith(SUMMARY_SYSTEM)) {
      summary.requests.push({ model: request.model, user, tools, maxTokens: request.max_tokens ?? request.max_completion_tokens });
      if (summary.mode === "fail")
        return { status: 400, body: { error: { message: "scripted summary failure", type: "invalid_request_error" } } };
      if (summary.mode === "hold")
        return (async function* () {
          await new Promise((resolve) => (summary.release = resolve));
          yield chunk({ role: "assistant", content: "Held summary." }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
        })();
      const marker = /TS-[A-Z0-9-]+/.exec(user)?.[0] ?? "";
      return say(`SUMMARY ${marker} read the files and listed the folder. Nothing else changed. A third sentence that must be cut.`);
    }
    if (role === "coordinator") {
      const marker = /TS-[A-Z0-9]+/.exec(user)?.[0];
      if (marker === "TS-TWO") {
        if (results.length === 0)
          return calls(["read", { path: "README.md", note: "TS-ARG-ONE" }], ["bash", { command: "echo TS-README-CONTENT" }]);
        if (results.length === 2) return calls(["read", { path: "missing-TS-MISSING.md" }]);
        return say("Two steps done.");
      }
      if (marker === "TS-ONE") return results.length ? say("One step done.") : calls(["bash", { command: "ls" }]);
      if (marker === "TS-MEM")
        return results.length
          ? say("Memory step done.")
          : calls(["projects_knowledge_read", { path: "preferences.md" }], ["bash", { command: "ls" }]);
      if (marker === "TS-THINK") return thinkThenSay("TS-THOUGHT weighing the options", "Thought it through.");
      if (marker === "TS-WORKER" && !results.length)
        return calls([
          "agents",
          {
            action: "spawn",
            role: "worker",
            title: "TS-WORKTASK",
            brief: "TS-WORKTASK list files",
            acceptance: ["done"],
            requestId: randomUUID(),
          },
        ]);
      return say("Noted.");
    }
    if (role === "worker" && user.includes("TS-WORKTASK")) return results.length ? say("Listed.") : calls(["bash", { command: "ls" }]);
    if (tools.includes("host_call") && user.includes("TS-HOSTAGENT"))
      return results.length ? say("Checked the machine.") : calls(["host_call", { action: "machine-status" }]);
    return undefined;
  },
});
// A light model for summaries next to the agents' model; built-in providers stay without credentials.
const modelsPath = join(kit.agentDir, "models.json"),
  models = JSON.parse(readFileSync(modelsPath, "utf8"));
models.providers.fake.models.push({
  id: "fake-light",
  name: "Fake light",
  reasoning: false,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 1024,
});
writeFileSync(modelsPath, JSON.stringify(models));
for (const key of Object.keys(kit.hostEnv)) if (/(API_KEY|_TOKEN|SECRET)/i.test(key)) delete kit.hostEnv[key];

await kit.run(async () => {
  const { rpc, check, rejects, waitFor } = kit;
  kit.initRepo();
  const id = await kit.createProject("Summaries");
  const ui = () => rpc({ action: "ui-get" });
  const setUi = async (patch) => rpc({ action: "ui-set", revision: (await ui()).revision, patch });
  const show = () => rpc({ action: "show", id, messageText: "full" });
  const toolEntries = (items) => [...new Set(items.filter((item) => item.kind === "tool-call").map((item) => item.entryId))];
  const turnEntries = (items, marker) => {
    const start = items.findLastIndex((item) => item.kind === "message" && item.role === "user" && item.text.includes(marker));
    return toolEntries(items.slice(start));
  };
  const summariesOf = async (marker) => {
    const view = await show();
    return turnEntries(view.messages, marker).map((entry) => view.toolSummaries?.[entry]);
  };

  // Defaults.
  const initial = await ui();
  check("defaults: thinking shown, summaries off", initial.ui.showThinking === true && initial.ui.toolSummaries.enabled === false);

  // S1: a summary model must be installed and have credentials; a refused change saves nothing.
  const catalog = (await rpc({ action: "tiers-get" })).catalog;
  const unconfigured = catalog.find((item) => !item.available)?.ref;
  check("an installed model without credentials exists in the fixture", !!unconfigured);
  check(
    "S1 enabling without a model is refused",
    /model/i.test((await rejects({ action: "ui-set", revision: initial.revision, patch: { toolSummaries: { enabled: true } } })) ?? ""),
  );
  check(
    "S1 a model outside the catalog is refused",
    /not installed/.test(
      (await rejects({
        action: "ui-set",
        revision: initial.revision,
        patch: { toolSummaries: { enabled: true, model: "fake/missing" } },
      })) ?? "",
    ),
  );
  check(
    "S1 a model without credentials is refused",
    /credentials/.test(
      (await rejects({ action: "ui-set", revision: initial.revision, patch: { toolSummaries: { enabled: true, model: unconfigured } } })) ??
        "",
    ),
  );
  check("S1 refused changes leave the settings as they were", (await ui()).revision === initial.revision);

  // G5: calls made while summaries are off are never summarized, also after turning them on.
  await kit.ask(id, "TS-TWO first run");
  await setUi({ toolSummaries: { enabled: true, model: "fake/fake-light" } });
  await delay(500);
  const off = await summariesOf("TS-TWO first run");
  check("G5 no backfill: the earlier turn has no summaries", off.length === 2 && off.every((item) => item === undefined), off);
  check("G6 reading the chat asks the summary model nothing", summary.requests.length === 0, summary.requests);

  // G1 G2 Q6: one summary per assistant message, after its results; bounded, untrusted, no tools.
  await kit.ask(id, "TS-TWO second run");
  const ready = await waitFor(async () => {
    const found = await summariesOf("TS-TWO second run");
    return found.length === 2 && found.every((item) => item?.status === "ready") && found;
  }, "two summaries");
  check("G1 two assistant messages, two summaries", summary.requests.length === 2, summary.requests);
  check(
    "summaries use the chosen model",
    summary.requests.every((item) => item.model === "fake-light"),
    summary.requests,
  );
  check(
    "Q6 the summary model is offered no tools",
    summary.requests.every((item) => !item.tools.length),
  );
  check(
    "the first summary covers both calls of its message and their results",
    summary.requests[0].user.includes("TS-ARG-ONE") &&
      summary.requests[0].user.includes("README.md") &&
      /Result:\nTS-README-CONTENT/.test(summary.requests[0].user),
    summary.requests[0].user,
  );
  check(
    "G1 the second summary covers only its own call",
    !summary.requests[1].user.includes("TS-ARG-ONE") && summary.requests[1].user.includes("TS-MISSING"),
  );
  check(
    "Q5 output is bounded",
    summary.requests.every((item) => item.maxTokens > 0 && item.maxTokens <= 300),
    summary.requests,
  );
  check(
    "Q6 cut to two sentences",
    ready.every((item) => /Nothing else changed\.$/.test(item.text)),
    ready,
  );

  // Q7: summaries stay out of the agent's own conversation and context.
  const coordinatorAfter = kit.result.calls.filter((item) => item.role === "coordinator").at(-1);
  check("Q7 the Coordinator never sees a summary", !JSON.stringify(coordinatorAfter).includes("SUMMARY TS-"));
  const view = await show();
  check("Q7 no summary text in the transcript items", !JSON.stringify(view.messages).includes("SUMMARY TS-"));

  // G4: memory calls keep their rows.
  await kit.ask(id, "TS-MEM run");
  await waitFor(async () => (await summariesOf("TS-MEM run"))[0]?.status === "ready", "memory turn summary");
  check("G4 the memory call is not summarized", !summary.requests.at(-1).user.includes("preferences.md"), summary.requests.at(-1).user);

  // U1: usage is kept apart and reported.
  const usage = await rpc({ action: "usage-snapshot", id, limit: 1 });
  check(
    "U1 summary usage is reported apart from the agents'",
    usage.toolSummaries?.requests === 3 && usage.toolSummaries.summaries === 3 && usage.toolSummaries.interrupted === 0,
    usage.toolSummaries,
  );
  const totals = await rpc({ action: "tool-summaries-usage" });
  check(
    "U1 host-wide totals list the project",
    totals.scopes.some((item) => item.scope === id && item.requests === 3),
    totals,
  );

  // Browser: the quiet line, its calls, the error mark, keyboard access.
  const page = await kit.openPage(await kit.webUrl(id));
  await page.waitFor(`document.body.dataset.ready === "1"`, "page ready");
  await page.waitFor(`document.querySelectorAll('#feed .tool-summary[data-status="ready"]').length >= 3`, "summary lines");
  const lines = await page.evaluate(
    `[...document.querySelectorAll('#feed .turn')].filter((turn) => turn.innerText.includes('TS-TWO second run')).flatMap((turn) => [...turn.querySelectorAll('.tool-summary')].map((node) => ({ status: node.dataset.status, errors: node.dataset.errors ?? '', text: node.querySelector('.ts-text')?.innerText ?? '', rows: node.querySelectorAll('.tool-row').length, meta: node.querySelector('.ts-meta')?.innerText ?? '' })))`,
  );
  check("D1 the summarized turn shows two lines and no loose rows", lines.length === 2 && lines.every((line) => line.rows === 0), lines);
  check(
    "D1 the line shows the summary, the call count and the time",
    /SUMMARY/.test(lines[0].text) && /2 calls/.test(lines[0].meta),
    lines,
  );
  check("D1 a failed call stays marked on its summary", lines[1].errors === "1" && /1 failed/.test(lines[1].meta), lines);
  const earlier = await page.evaluate(
    `[...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-TWO first run'))?.querySelectorAll('.tool-summary').length`,
  );
  check("G5 the turn from before shows its original calls", earlier === 0, earlier);
  const memoryRows = await page.evaluate(
    `[...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-MEM run'))?.querySelectorAll('.memory-row').length`,
  );
  check("G4 the memory row stays visible next to the summary", memoryRows === 1, memoryRows);
  await page.shot("desktop-ready", { force: true });
  // D2 D9: keyboard opens the original calls.
  await page.evaluate(
    `[...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-TWO second run')).querySelector('.tool-summary .ts-line').focus()`,
  );
  // The text makes Chrome activate the focused button, as a real Enter does.
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('#feed .tool-summary.open .tool-row')`, "expanded calls");
  const opened = await page.evaluate(
    `(() => { const node = document.querySelector('#feed .tool-summary.open'); return { rows: node.querySelectorAll('.tool-row').length, focused: document.activeElement?.classList.contains('ts-line'), expanded: node.querySelector('.ts-line').getAttribute('aria-expanded'), by: node.querySelector('.ts-by')?.innerText ?? '' }; })()`,
  );
  check("D2 D9 Enter opens the original calls and keeps focus", opened.rows === 2 && opened.focused && opened.expanded === "true", opened);
  check("the open line names the summary model", /fake-light/.test(opened.by), opened);
  await page.shot("desktop-open", { force: true });
  await page.viewport(390, 844, true);
  await delay(300);
  const overflow = await page.evaluate(
    `[...document.querySelectorAll('#feed .tool-summary')].some((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1)`,
  );
  check("D9 lines fit a narrow screen", overflow === false);
  await page.shot("narrow-open", { force: true });
  await page.viewport(1440, 1000);

  // D3 Q1 Q2: a pending summary looks unlike a running call, and survives a restart.
  summary.mode = "hold";
  const held = summary.requests.length;
  await kit.ask(id, "TS-ONE pending");
  await waitFor(() => summary.requests.length > held, "held summary request");
  await page.waitFor(`document.querySelector('#feed .tool-summary[data-status="pending"]')`, "pending line");
  const pending = await page.evaluate(
    `(() => { const node = document.querySelector('#feed .tool-summary[data-status="pending"]'); return { spin: !!node.querySelector('.spin'), glyph: !!node.querySelector('.ts-pending'), text: node.querySelector('.ts-text').innerText }; })()`,
  );
  check(
    "D3 a pending summary has its own glyph, not the running spinner",
    !pending.spin && pending.glyph && /summar/i.test(pending.text),
    pending,
  );
  await page.shot("desktop-pending", { force: true });
  summary.mode = "ok";
  await kit.restartHost();
  await waitFor(async () => (await summariesOf("TS-ONE pending"))[0]?.status === "ready", "Q1 summary after restart", { timeout: 60000 });
  const afterRestart = await rpc({ action: "usage-snapshot", id, limit: 1 });
  check("Q2 the cut-off request is counted with an unknown cost", afterRestart.toolSummaries.interrupted >= 1, afterRestart.toolSummaries);
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "page ready after restart");

  // Q3 D4: a failing model is retried a bounded number of times, then the calls show with a quiet note.
  summary.mode = "fail";
  const beforeFail = summary.requests.length;
  await kit.ask(id, "TS-ONE failing");
  await waitFor(async () => (await summariesOf("TS-ONE failing"))[0]?.status === "failed", "failed summary", { timeout: 60000 });
  await delay(500);
  check("Q3 three attempts, then it stops", summary.requests.length - beforeFail === 3, summary.requests.length - beforeFail);
  await page.waitFor(`document.querySelector('#feed .tool-summary[data-status="failed"]')`, "failed line");
  const failed = await page.evaluate(
    `(() => { const node = document.querySelector('#feed .tool-summary[data-status="failed"]'); return { text: node.innerText, alert: !!node.querySelector('[role="alert"]') }; })()`,
  );
  check(
    "D4 a failed summary names the calls with a quiet note",
    /bash/.test(failed.text) && /no summary/i.test(failed.text) && !failed.alert,
    failed,
  );
  await page.shot("desktop-failed", { force: true });
  summary.mode = "ok";

  // D7: hiding thinking hides it everywhere and changes nothing for the model.
  await kit.ask(id, "TS-THINK one");
  await page.waitFor(
    `[...document.querySelectorAll('#feed .thinking')].some((node) => node.innerText.includes('TS-THOUGHT'))`,
    "thinking shown",
  );
  const reasoningBefore = kit.result.calls.filter((item) => item.role === "coordinator").at(-1).reasoning;
  await setUi({ showThinking: false });
  await page.waitFor(`!document.querySelector('#feed .thinking')`, "thinking hidden");
  await kit.ask(id, "TS-THINK two");
  const coordinatorCall = kit.result.calls.filter((item) => item.role === "coordinator").at(-1);
  check("D7 hiding thinking does not change the model request", coordinatorCall.reasoning === reasoningBefore);
  check("D7 the model still sees its context", coordinatorCall.user.includes("TS-THINK two"));
  check(
    "D7 no thinking in the chat after the new turn",
    (await page.evaluate(`document.querySelectorAll('#feed .thinking').length`)) === 0,
  );
  await setUi({ showThinking: true });
  await page.waitFor(`document.querySelector('#feed .thinking')`, "thinking back");

  // D5 S3: turning summaries off shows the calls again and starts nothing; turning on shows the cached summaries.
  await setUi({ toolSummaries: { enabled: false } });
  await page.waitFor(`!document.querySelector('#feed .tool-summary')`, "summaries gone");
  const requestsOff = summary.requests.length;
  await kit.ask(id, "TS-ONE while off");
  await delay(800);
  check("S3 nothing is summarized while off", summary.requests.length === requestsOff);
  check(
    "D5 the calls show as rows again",
    (await page.evaluate(`document.querySelectorAll('#feed .tool-row, #feed .tool-group').length`)) > 0,
  );
  await setUi({ toolSummaries: { enabled: true } });
  await page.waitFor(`document.querySelectorAll('#feed .tool-summary[data-status="ready"]').length >= 3`, "cached summaries back");
  check("S3 re-enabling does not summarize what ran while off", (await summariesOf("TS-ONE while off"))[0] === undefined);

  // Settings → Chat display.
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await page.waitFor(`document.querySelector('#settings').open`, "settings open");
  await page.evaluate(`document.querySelector('nav [data-section="display"]').click()`);
  await page.waitFor(`document.querySelector('#summary-model')`, "chat display section");
  const section = await page.evaluate(
    `(() => ({ thinking: document.querySelector('#show-thinking').checked, summaries: document.querySelector('#tool-summaries').checked, model: document.querySelector('#summary-model').value, options: [...document.querySelectorAll('#summary-model option')].map((o) => ({ value: o.value, disabled: o.disabled })), note: document.querySelector('.ts-data-note')?.innerText ?? '' }))()`,
  );
  check("the section shows the saved settings", section.thinking && section.summaries && section.model === "fake/fake-light", section);
  check(
    "models without credentials cannot be picked",
    section.options.some((item) => item.value === unconfigured && item.disabled),
    section.options.slice(0, 5),
  );
  check("the section says what is sent to the model", /arguments/i.test(section.note) && /results/i.test(section.note), section.note);
  await page.shot("settings-display", { force: true });
  await page.evaluate(`document.querySelector('#show-thinking').click()`);
  await waitFor(async () => (await ui()).ui.showThinking === false, "thinking switch saved");
  await page.evaluate(`document.querySelector('#show-thinking').click()`);
  await waitFor(async () => (await ui()).ui.showThinking === true, "thinking switch restored");
  await page.evaluate(`document.querySelector('#settings').close()`);

  // D8: worker transcripts.
  await kit.ask(id, "TS-WORKER go");
  const worker = await waitFor(
    async () => (await rpc({ action: "jobs-snapshot", id })).agents?.find((agent) => agent.title === "TS-WORKTASK"),
    "worker",
  );
  const workerPage = await waitFor(
    async () => {
      const history = await rpc({ action: "thread-history", id, threadId: worker.id, messageText: "full" });
      const entries = toolEntries(history.items);
      return entries.length && entries.every((entry) => history.toolSummaries?.[entry]?.status === "ready") && history;
    },
    "D8 worker summary",
    { timeout: 60000 },
  );
  check("D8 worker transcripts get summaries", Object.keys(workerPage.toolSummaries).length >= 1);
  await page.evaluate(`document.querySelector('[data-open-worker="${worker.id}"]')?.click()`);
  await page.waitFor(`document.querySelector('#worker-feed .tool-summary[data-status="ready"]')`, "worker summary line");
  await page.shot("worker-summary", { force: true });

  // D8: the Host agent.
  await rpc({ action: "host-agent-send", requestId: randomUUID(), text: "TS-HOSTAGENT check" });
  const hostPage = await waitFor(
    async () => {
      const history = await rpc({ action: "host-agent-history" });
      const entries = toolEntries(history.items);
      return entries.length && entries.every((entry) => history.toolSummaries?.[entry]?.status === "ready") && history;
    },
    "D8 host agent summary",
    { timeout: 60000 },
  );
  check("D8 the Host agent gets summaries", Object.keys(hostPage.toolSummaries).length >= 1);
  const scopes = (await rpc({ action: "tool-summaries-usage" })).scopes.map((item) => item.scope);
  check("the Host agent's usage is its own scope", scopes.includes("host-agent"), scopes);
});
