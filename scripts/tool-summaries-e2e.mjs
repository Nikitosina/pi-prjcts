// E2E: tool summaries and thinking visibility (scripts/tool-summaries-failures.md) on a private host with the fake provider, through
// the RPCs, a host restart and the browser: Coordinator chat, worker transcript and the Host agent.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
/** One assistant message that thinks, then makes these calls: historical thinking and a summary in the same turn. */
const thinkThenCall = (thinking, ...list) => chunk({ role: "assistant", reasoning_content: thinking }, null) + calls(...list);
// Agent requests by role, to show each keeps its own model and thinking while summaries use the light model.
const agentRequests = [];
// The Host agent's held turn: it streams its thinking, then waits for `release` (live thinking in the drawer).
const hostHold = { on: false, release: () => {} };
// The owner's example (TS-GROUPS): thinking, three calls from three messages, thinking, two calls, the final text. The Coordinator
// waits before the steps in `at`; `step` is the step it waits at, until `release`.
const groupHold = { at: new Set(), step: null, release: () => {} };
const GROUP_STEPS = [
  () => thinkThenCall("TS-G1-THOUGHT gather the facts first", ["read", { path: "missing-TS-G1-report.json" }]),
  () => calls(["bash", { command: "echo TS-G1-LOG" }]),
  () => calls(["bash", { command: "ls" }]),
  () => thinkThenCall("TS-G2-THOUGHT now check the fix", ["bash", { command: "echo TS-G2-CHECK" }]),
  () => calls(["bash", { command: "pwd" }]),
  () => say("Found it and checked the fix."),
];

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
          yield chunk({ role: "assistant", content: "Read the report, the log and the folder; the report is missing." }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n";
        })();
      const marker = /TS-[A-Z0-9-]+/.exec(user)?.[0] ?? "";
      return say(`SUMMARY ${marker} read the files and listed the folder. Nothing else changed. A third sentence that must be cut.`);
    }
    agentRequests.push({
      role,
      model: request.model,
      reasoning: request.reasoning_effort ?? request.reasoning ?? null,
      user: user.slice(0, 80),
    });
    // Role tasks: each thinks, makes calls (one of them fails, for the error mark) and answers.
    const task = /TS-(?:SCOUT|REVIEW|NEST|NSCOUT|NREVIEW)TASK/.exec(user)?.[0];
    if (task === "TS-NESTTASK") {
      if (results.length === 0) return calls(["subagent", { role: "scout", task: "TS-NSCOUTTASK look" }]);
      if (results.length === 1) return calls(["subagent", { role: "reviewer", kind: "full", task: "TS-NREVIEWTASK check" }]);
      return say("Nested done.");
    }
    if (task && role !== "coordinator")
      return results.length
        ? say(`${task} answered.`)
        : thinkThenCall(`${task}-THOUGHT weighing`, ["code_ls", { path: "." }], ["code_read", { path: `missing-${task}.md` }]);
    if (role === "coordinator") {
      const marker = /TS-[A-Z0-9]+/.exec(user)?.[0];
      const spawn = { "TS-SCOUT": "scout", "TS-REVIEW": "reviewer", "TS-NEST": "worker" }[marker];
      if (spawn && !results.length)
        return calls([
          "agents",
          {
            action: "spawn",
            role: spawn,
            title: `${marker}TASK`,
            brief: `${marker}TASK go`,
            ...(spawn === "worker" ? { acceptance: ["done"] } : {}),
            requestId: randomUUID(),
          },
        ]);
      if (marker === "TS-GROUPS") {
        const step = results.length;
        if (groupHold.at.delete(step)) {
          groupHold.step = step;
          await new Promise((resolve) => (groupHold.release = resolve));
          groupHold.step = null;
        }
        return GROUP_STEPS[step]?.();
      }
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
    if (role === "worker" && user.includes("TS-WORKTASK"))
      return results.length
        ? say("Listed.")
        : thinkThenCall("TS-WTHOUGHT which folder", ["bash", { command: "ls" }], ["bash", { command: "exit 3" }]);
    if (tools.includes("host_call") && user.includes("TS-HOSTAGENT"))
      return results.length
        ? say("Checked the machine.")
        : thinkThenCall(
            "TS-HTHOUGHT what to check",
            ["host_call", { action: "machine-status" }],
            ["host_call", { action: "no-such-action" }],
          );
    if (tools.includes("host_call") && user.includes("TS-HOSTLIVE"))
      return (async function* () {
        yield chunk({ role: "assistant", reasoning_content: "TS-HLIVE thinking now" }, null);
        await new Promise((resolve) => (hostHold.release = resolve));
        yield chunk({ content: "Live done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
      })();
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
  const MEMORY = /^projects_knowledge_/;
  const toolCalls = (items) => items.filter((item) => item.kind === "tool-call" && !MEMORY.test(item.name));
  const turnCalls = (items, marker) => {
    const start = items.findLastIndex((item) => item.kind === "message" && item.role === "user" && item.text.includes(marker));
    return toolCalls(items.slice(start));
  };
  const groupId = (page, call) => page.toolGroups?.calls[`${call.entryId}:${call.callId}`];
  /** The groups of these calls in order, each once; a call in no group is `undefined`. */
  const groupsOf = (page, list) => {
    const found = new Map();
    for (const call of list) {
      const key = groupId(page, call);
      found.set(key ?? `none-${call.callId}`, key ? { id: key, ...page.toolGroups.groups[key] } : undefined);
    }
    return [...found.values()];
  };
  const allReady = (page) => {
    const found = groupsOf(page, toolCalls(page.items));
    return found.length > 0 && found.every((group) => group?.status === "ready");
  };
  const summariesOf = async (marker) => {
    const view = await show();
    return groupsOf(view, turnCalls(view.messages, marker));
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
  check("G5 no backfill: the earlier turn has no groups", off.length === 3 && off.every((item) => item === undefined), off);
  check("G6 reading the chat asks the summary model nothing", summary.requests.length === 0, summary.requests);

  // G1 G2 Q6: consecutive calls of two assistant messages are one group, summarized once after the final text closed it.
  await kit.ask(id, "TS-TWO second run");
  const ready = await waitFor(async () => {
    const found = await summariesOf("TS-TWO second run");
    return found.length === 1 && found[0]?.status === "ready" && found;
  }, "one group summary");
  check("G1 two assistant messages without text between, one summary", summary.requests.length === 1, summary.requests);
  check("G1 the group counts the calls of both messages", ready[0].calls === 3, ready);
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
    "the summary covers the calls of both messages and their results",
    summary.requests[0].user.includes("TS-ARG-ONE") &&
      summary.requests[0].user.includes("README.md") &&
      /Result:\nTS-README-CONTENT/.test(summary.requests[0].user) &&
      summary.requests[0].user.includes("TS-MISSING"),
    summary.requests[0].user,
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
    usage.toolSummaries?.requests === 2 && usage.toolSummaries.summaries === 2 && usage.toolSummaries.interrupted === 0,
    usage.toolSummaries,
  );
  const totals = await rpc({ action: "tool-summaries-usage" });
  check(
    "U1 host-wide totals list the project",
    totals.scopes.some((item) => item.scope === id && item.requests === 2),
    totals,
  );

  // Browser: the quiet line, its calls, the error mark, keyboard access.
  const page = await kit.openPage(await kit.webUrl(id), { video: "segment" });
  await page.waitFor(`document.body.dataset.ready === "1"`, "page ready");
  await page.waitFor(`document.querySelectorAll('#feed .tool-summary[data-status="ready"]').length >= 2`, "summary lines");
  const lines = await page.evaluate(
    `[...document.querySelectorAll('#feed .turn')].filter((turn) => turn.innerText.includes('TS-TWO second run')).flatMap((turn) => [...turn.querySelectorAll('.tool-summary')].map((node) => ({ status: node.dataset.status, errors: node.dataset.errors ?? '', text: node.querySelector('.ts-text')?.innerText ?? '', rows: node.querySelectorAll('.tool-row').length, meta: node.querySelector('.ts-meta')?.innerText ?? '' })))`,
  );
  check("D1 the summarized turn shows one line and no loose rows", lines.length === 1 && lines[0].rows === 0, lines);
  check(
    "D1 the line shows the summary, the call count and the time",
    /SUMMARY/.test(lines[0].text) && /3 calls/.test(lines[0].meta),
    lines,
  );
  check("D1 a failed call stays marked on its summary", lines[0].errors === "1" && /1 failed/.test(lines[0].meta), lines);
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
  check("D2 D9 Enter opens the original calls and keeps focus", opened.rows === 3 && opened.focused && opened.expanded === "true", opened);
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

  // G1 G2 G8 G9 D3: the owner's example. Thinking, three calls from three messages, thinking, two calls, the final text: two groups
  // of three and two calls, each one quiet line while collecting, then pending, then its summary; hiding thinking keeps them.
  const lineOf = (index) =>
    `[...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-GROUPS go'))?.querySelectorAll('.tool-summary')[${index}]`;
  const linesNow = () =>
    page.evaluate(
      `[...([...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-GROUPS go'))?.querySelectorAll('.tool-summary') ?? [])].map((node) => ({ status: node.dataset.status, key: node.querySelector('.ts-line').dataset.toggle, text: node.querySelector('.ts-text').innerText, meta: node.querySelector('.ts-meta').innerText, spin: !!node.querySelector('.ts-line .spin'), rows: node.querySelectorAll('.ts-body .tool-row').length, loose: node.closest('.turn').querySelectorAll(':scope > .tool-row, :scope > .tool-group').length }))`,
    );
  // Screenshots show the example turn; the reader scrolls there like the owner would.
  const showTurn = () =>
    page.evaluate(
      `[...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-GROUPS go'))?.scrollIntoView({ block: 'start' })`,
    );
  summary.mode = "hold";
  groupHold.at = new Set([3, 5]);
  const groupsFrom = summary.requests.length;
  await page.screencast(true);
  await rpc({ action: "message", id, text: "TS-GROUPS go" });
  await waitFor(() => groupHold.step === 3, "the Coordinator waits after three calls", { timeout: 60000 });
  await page.waitFor(`${lineOf(0)}?.querySelector('.ts-meta')?.innerText.includes('3 calls')`, "collecting line with 3 calls");
  const collecting = await linesNow();
  check(
    "D3 a group collecting calls is one quiet line with a spinner, running… and its count",
    collecting.length === 1 &&
      collecting[0].status === "collecting" &&
      collecting[0].spin &&
      /running…/.test(collecting[0].text) &&
      /3 calls/.test(collecting[0].meta) &&
      collecting[0].loose === 0,
    collecting,
  );
  check("G2 G9 nothing is asked while the group may still grow", summary.requests.length === groupsFrom, summary.requests.length);
  await showTurn();
  await page.shot("groups-01-collecting-3-calls", { force: true });
  await page.evaluate(`${lineOf(0)}.querySelector('.ts-line').click()`);
  await page.waitFor(`${lineOf(0)}?.querySelectorAll('.ts-body .tool-row').length === 3`, "the group's three calls open");
  await showTurn();
  await page.shot("groups-02-collecting-expanded", { force: true });
  await page.evaluate(`${lineOf(0)}.querySelector('.ts-line').click()`);
  groupHold.release();
  await waitFor(() => summary.requests.length > groupsFrom, "thinking closed the first group", { timeout: 60000 });
  await waitFor(() => groupHold.step === 5, "the Coordinator waits after the second group's calls", { timeout: 60000 });
  await page.waitFor(
    `${lineOf(0)}?.dataset.status === 'pending' && ${lineOf(1)}?.querySelector('.ts-meta')?.innerText.includes('2 calls')`,
    "first pending, second collecting",
  );
  const second = await linesNow();
  check("the second group is its own collecting line", second[1]?.status === "collecting" && second[1].key !== second[0].key, second);
  check("D3 the closed group waits with the pending glyph", second[0].status === "pending" && !second[0].spin, second);
  await showTurn();
  await page.shot("groups-03-first-pending-second-collecting", { force: true });
  summary.mode = "ok";
  summary.release();
  await page.waitFor(`${lineOf(0)}?.dataset.status === 'ready'`, "first summary");
  await showTurn();
  await page.shot("groups-04-first-ready", { force: true });
  groupHold.release();
  await page.waitFor(`${lineOf(1)}?.dataset.status === 'ready'`, "second summary");
  await kit.settle(id);
  const done = await linesNow();
  check(
    "G1 exactly two lines, of three calls and of two",
    done.length === 2 && /3 calls/.test(done[0].meta) && /2 calls/.test(done[1].meta) && done.every((line) => line.status === "ready"),
    done,
  );
  const groupRequests = summary.requests.slice(groupsFrom);
  check("G9 exactly two summary requests", groupRequests.length === 2, groupRequests.length);
  check(
    "G1 the first summary covers the first group only, the second the second",
    groupRequests[0].user.includes("TS-G1-LOG") &&
      !groupRequests[0].user.includes("TS-G2-CHECK") &&
      groupRequests[1].user.includes("TS-G2-CHECK") &&
      !groupRequests[1].user.includes("TS-G1-LOG"),
    groupRequests.map((item) => item.user.slice(0, 400)),
  );
  check("the agent's thinking is never sent to the summary model", !groupRequests.some((item) => /TS-G[12]-THOUGHT/.test(item.user)));
  const hostGroups = await summariesOf("TS-GROUPS go");
  check("the host forms the two groups", hostGroups.length === 2 && hostGroups[0].calls === 3 && hostGroups[1].calls === 2, hostGroups);
  await showTurn();
  await page.shot("groups-05-final-thinking-shown", { force: true });
  await setUi({ showThinking: false });
  await page.waitFor(
    `![...document.querySelectorAll('#feed .turn')].find((turn) => turn.innerText.includes('TS-GROUPS go'))?.querySelector('.thinking')`,
    "thinking hidden",
  );
  const hidden = await linesNow();
  check(
    "G8 hiding thinking keeps the same two lines",
    JSON.stringify(hidden.map((line) => [line.key, line.meta])) === JSON.stringify(done.map((line) => [line.key, line.meta])),
    { done, hidden },
  );
  check("G8 hiding thinking keeps the host's groups", JSON.stringify(await summariesOf("TS-GROUPS go")) === JSON.stringify(hostGroups));
  await showTurn();
  await page.shot("groups-06-final-thinking-hidden", { force: true });
  await setUi({ showThinking: true });
  await page.waitFor(`${lineOf(0)}?.closest('.turn').querySelector('.thinking')`, "thinking back");
  await page.screencast(false);

  // D10: a history page holding only the later calls of a group reads the group's whole count; loading the older page joins them.
  const latest = await show();
  check(
    "G10 every call of the turn is in one of the two groups",
    turnCalls(latest.messages, "TS-GROUPS go").every((call) => [hostGroups[0].id, hostGroups[1].id].includes(groupId(latest, call))),
  );
  const firstGroup = hostGroups[0].id;
  let partial;
  for (let limit = 1; limit < 40 && !partial; limit++) {
    const newest = await rpc({ action: "chat-history", id, limit, messageText: "full" });
    const present = toolCalls(newest.items).filter((call) => groupId(newest, call) === firstGroup).length;
    if (present > 0 && present < 3) partial = newest;
  }
  check("D10 a page holds only part of the first group", !!partial);
  check("D10 the partial page reads the group's whole count", partial.toolGroups.groups[firstGroup].calls === 3, partial.toolGroups);
  const olderPage = await rpc({ action: "chat-history", id, before: partial.before, limit: 100, messageText: "full" });
  // The production renderer draws both pages: one line for the group, with its earlier calls counted until they load.
  const drawn = await page.evaluate(`(async () => {
    const { transcriptHtml, mergeGroups } = await import('/chat.js');
    const draw = (items, groups) => {
      const box = document.createElement('div');
      box.innerHTML = transcriptHtml(items, false, 'Coordinator', { groups });
      const lines = [...box.querySelectorAll('.tool-summary')].filter((node) => node.querySelector('.ts-line').dataset.toggle === 's${firstGroup}');
      return { lines: lines.length, meta: lines[0]?.querySelector('.ts-meta').innerText ?? '' };
    };
    const newest = ${JSON.stringify({ items: partial.items, groups: partial.toolGroups })};
    const older = ${JSON.stringify({ items: olderPage.items, groups: olderPage.toolGroups ?? null })};
    return { partial: draw(newest.items, newest.groups), joined: draw([...older.items, ...newest.items], mergeGroups(older.groups, newest.groups)) };
  })()`);
  check(
    "D10 a partial page draws one line that counts the calls on earlier pages",
    drawn.partial.lines === 1 && /3 calls/.test(drawn.partial.meta) && /on earlier pages/.test(drawn.partial.meta),
    drawn,
  );
  check(
    "D10 loading the older page joins them into the same line",
    drawn.joined.lines === 1 && /3 calls/.test(drawn.joined.meta) && !/earlier/.test(drawn.joined.meta),
    drawn,
  );
  // A message shows its thinking before its calls, though a call came first: `[call B, thinking]` after `[call A]` is still one
  // group of A and B. A failure on an earlier page stays marked, and pages merge by the group's progress, not by their order.
  const edge = await page.evaluate(`(async () => {
    const { transcriptHtml, mergeGroups } = await import('/chat.js');
    const call = (entryId, callId) => ({ kind: 'tool-call', entryId, at: entryId, callId, name: 'bash', argsPreview: '{}' });
    const done = (entryId, callId) => ({ kind: 'tool-result', entryId, at: entryId, callId, isError: false, preview: 'ok' });
    const items = [
      { kind: 'message', role: 'user', entryId: 1, at: 1, text: 'go', images: [] },
      call(2, 'a'), done(3, 'a'),
      { kind: 'message', role: 'assistant', entryId: 4, at: 4, text: '', thinking: 'later thought', images: [] },
      call(4, 'b'), done(5, 'b'),
    ];
    const view = { status: 'ready', text: 'EDGE-SUMMARY', calls: 3, failed: 1, model: null };
    const groups = { groups: { gx: view }, calls: { '2:a': 'gx', '4:b': 'gx' } };
    const box = document.createElement('div');
    box.innerHTML = transcriptHtml(items, false, 'Coordinator', { groups });
    const lines = [...box.querySelectorAll('.tool-summary')];
    const pending = { groups: { gx: { status: 'pending', calls: 3, failed: 1, model: null } }, calls: {} };
    const ready = { groups: { gx: view }, calls: {} };
    return {
      lines: lines.length,
      errors: lines[0]?.dataset.errors,
      meta: lines[0]?.querySelector('.ts-meta').innerText,
      order: [...box.querySelector('.turn').children].map((node) => node.className.split(' ')[0]),
      merged: [mergeGroups(ready, pending).groups.gx.status, mergeGroups(pending, ready).groups.gx.status],
    };
  })()`);
  check("D1 a group whose message shows thinking before a joined call is still one line", edge.lines === 1, edge);
  check("D10 a failure on an earlier page stays marked", edge.errors === "1" && /1 failed/.test(edge.meta), edge);
  check(
    "D10 merged pages keep the group's later state",
    edge.merged.every((status) => status === "ready"),
    edge,
  );

  // D9 narrow: the group lines fit, scroll with the wheel and the keyboard, and open with Enter.
  await page.viewport(390, 844, true);
  await page.waitFor(`${lineOf(1)}`, "narrow lines");
  const narrowFit = await page.evaluate(
    `[...document.querySelectorAll('#feed .tool-summary')].every((node) => node.getBoundingClientRect().right <= document.documentElement.clientWidth + 1)`,
  );
  check("D9 group lines fit 390 px", narrowFit);
  const scroller = await page.evaluate(`(() => {
    let node = document.querySelector('#feed');
    while (node && !(node.scrollHeight > node.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
    const r = (node ?? document.querySelector('#feed')).getBoundingClientRect();
    return { id: node?.id ?? null, top: node?.scrollTop ?? null, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check("the chat scrolls on a narrow screen", scroller.id !== null, scroller);
  await page.evaluate(`document.getElementById('${scroller.id}').scrollTop = 0`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: scroller.x, y: scroller.y, deltaX: 0, deltaY: 600 });
  await page.waitFor(`document.getElementById('${scroller.id}').scrollTop > 0`, "wheel scrolled down");
  await page.evaluate(`${lineOf(0)}.querySelector('.ts-line').scrollIntoView({ block: 'center' })`);
  await page.evaluate(`${lineOf(0)}.querySelector('.ts-line').focus()`);
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(`${lineOf(0)}?.querySelectorAll('.ts-body .tool-row').length === 3`, "narrow Enter opens the group");
  const beforeKeys = await page.evaluate(`document.getElementById('${scroller.id}').scrollTop`);
  for (const key of ["PageUp", "PageUp"]) {
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: 33 });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 33 });
  }
  await page.waitFor(`document.getElementById('${scroller.id}').scrollTop < ${beforeKeys}`, "keyboard scrolled up");
  check("D6 the open group line keeps its state while the reader scrolls", await page.evaluate(`${lineOf(0)}.classList.contains('open')`));
  await page.evaluate(`${lineOf(0)}.scrollIntoView({ block: 'start' })`);
  await page.shot("groups-07-narrow-expanded", { force: true });
  await page.evaluate(`${lineOf(0)}.querySelector('.ts-line').click()`);
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
  // Q11: groups of conversations with no running turn (a turn that ended while the host was down) are dropped when each store opens.
  const summariesDb = join(kit.home, "tool-summaries.sqlite");
  // The running host writes this file too: wait for its lock like the host does instead of failing at once.
  const BUSY = { timeout: 5000 };
  const orphan = (scope, entry) =>
    `INSERT INTO tool_groups (scope, conversation, first_entry, first_call, last_entry, status, size, waiting, calls, created, updated) VALUES ('${scope}', 999999, ${entry}, 'gone', ${entry}, 'open', 1, '["gone"]', '{"calls":[{"id":"gone","name":"bash","args":"TS-ORPHAN","result":null}],"more":0}', 0, 0)`;
  {
    const db = new DatabaseSync(summariesDb, BUSY);
    db.exec(`${orphan(id, 999999)}; ${orphan("host-agent", 999998)}`);
    db.close();
  }
  await kit.restartHost();
  await waitFor(() => {
    const db = new DatabaseSync(summariesDb, { readOnly: true, ...BUSY });
    const rows = db.prepare("SELECT status, calls FROM tool_groups WHERE conversation = 999999").all();
    db.close();
    return rows.length === 2 && rows.every((row) => row.status === "cancelled" && row.calls === null);
  }, "Q11 orphaned groups of the project and the Host agent dropped after a restart");
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
  await page.shot("desktop-thinking-shown");
  const reasoningBefore = kit.result.calls.filter((item) => item.role === "coordinator").at(-1).reasoning;
  await setUi({ showThinking: false });
  await page.waitFor(`!document.querySelector('#feed .thinking')`, "thinking hidden");
  await page.shot("desktop-thinking-hidden");
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
      return allReady(history) && history;
    },
    "D8 worker summary",
    { timeout: 60000 },
  );
  check("D8 worker transcripts get summaries", Object.keys(workerPage.toolGroups.groups).length >= 1);
  await page.evaluate(`document.querySelector('[data-open-worker="${worker.id}"]')?.click()`);
  await page.waitFor(`document.querySelector('#worker-feed .tool-summary[data-status="ready"]')`, "worker summary line");
  await page.shot("worker-summary", { force: true });

  // D6 in the worker transcript: a summary arriving keeps unchanged turns, the open line, focus and a reader's scroll place.
  summary.mode = "hold";
  const heldFrom = summary.requests.length;
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: randomUUID(), text: "TS-WORKTASK again" });
  await page.waitFor(`document.querySelector('#worker-feed .tool-summary[data-status="pending"]')`, "worker pending summary");
  await page.evaluate(`document.querySelector('#worker-feed .tool-summary[data-status="ready"] .ts-line').click()`);
  await page.waitFor(`document.querySelector('#worker-feed .tool-summary.open')`, "worker summary opened");
  const before = await page.evaluate(`(() => {
    const feed = document.querySelector('#worker-feed');
    feed.style.height = '140px';
    feed.style.flex = 'none';
    for (const turn of feed.querySelectorAll(':scope > .turn')) turn.__kept = true;
    const line = feed.querySelector('.tool-summary[data-status="pending"] .ts-line');
    line.focus();
    return { focus: line.dataset.toggle, scrollable: feed.scrollHeight > feed.clientHeight + 40 };
  })()`);
  check("D6 the worker feed can scroll for this check", before.scrollable, before);
  // The reader scrolls to the top with the wheel, as only the owner's own input stops following.
  const feedPoint = await page.evaluate(
    `(() => { const r = document.querySelector('#worker-feed').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...feedPoint, deltaX: 0, deltaY: -100000 });
  await page.waitFor(`document.querySelector('#worker-feed').scrollTop === 0`, "worker reader at the top");
  await waitFor(() => summary.requests.length > heldFrom, "held worker summary request");
  summary.mode = "ok";
  summary.release();
  await page.waitFor(
    `!document.querySelector('#worker-feed .tool-summary[data-status="pending"]') && document.querySelectorAll('#worker-feed .tool-summary[data-status="ready"]').length >= 2`,
    "worker summary arrives",
  );
  const after = await page.evaluate(`(() => {
    const feed = document.querySelector('#worker-feed');
    const turns = [...feed.querySelectorAll(':scope > .turn')];
    return {
      firstKept: turns[0]?.__kept === true,
      replayed: turns.filter((turn) => !turn.__kept && !turn.classList.contains('no-enter')).length,
      open: !!feed.querySelector('.tool-summary.open'),
      focus: document.activeElement?.dataset?.toggle ?? null,
      scrollTop: feed.scrollTop,
    };
  })()`);
  check("D6 an unchanged worker turn keeps its node", after.firstKept, after);
  check("D6 no worker turn animates in again", after.replayed === 0, after);
  check("D6 the open worker summary stays open", after.open, after);
  check("D6 the focused worker summary line keeps focus", after.focus === before.focus, { before, after });
  check("D6 a reader who scrolled up stays in place", after.scrollTop === 0, after);
  // A reader of a reply keeps it in place when the turns above it change height, its own turn too (its thinking is hidden).
  const readKey = await page.evaluate(
    `[...document.querySelectorAll('#worker-feed > .turn')].findLast((turn) => turn.querySelector('.thinking ~ * p, .thinking ~ p'))?.dataset.key ?? null`,
  );
  const offsetOfReading = `(() => {
    const feed = document.querySelector('#worker-feed'), turn = feed.querySelector(':scope > .turn[data-key="${readKey}"]');
    const line = [...(turn?.querySelectorAll('p') ?? [])].findLast((p) => p.innerText === 'Listed.');
    return line ? line.getBoundingClientRect().top - feed.getBoundingClientRect().top : null;
  })()`;
  await page.evaluate(`document.querySelector('#worker-feed').scrollTop += ${offsetOfReading} - 10`);
  const place = await page.evaluate(`(() => {
    const feed = document.querySelector('#worker-feed'), turn = feed.querySelector(':scope > .turn[data-key="${readKey}"]');
    return { turn: turn.getBoundingClientRect().top - feed.getBoundingClientRect().top, gap: feed.scrollHeight - feed.scrollTop - feed.clientHeight, thinking: turn.querySelectorAll('.thinking').length };
  })()`);
  const reading = await page.evaluate(offsetOfReading);
  check(
    "D6 the reader reads a reply below its turn's thinking",
    Math.abs(reading - 10) < 2 && place.turn < 0 && place.gap > 2 && place.thinking > 0,
    {
      readKey,
      reading,
      place,
    },
  );
  await setUi({ showThinking: false });
  await page.waitFor(`!document.querySelector('#worker-feed .thinking')`, "worker thinking hidden");
  const kept = await page.evaluate(offsetOfReading);
  check("D6 the reply being read stays put when the turns above it shrink", Math.abs(kept - reading) < 2, { reading, kept });
  await setUi({ showThinking: true });
  await page.waitFor(`document.querySelector('#worker-feed .thinking')`, "worker thinking back");
  await page.evaluate(`document.querySelector('#worker-feed').removeAttribute('style')`);
  await page.shot("worker-summary-stable", { force: true });

  // D8: the Host agent.
  await rpc({ action: "host-agent-send", requestId: randomUUID(), text: "TS-HOSTAGENT check" });
  const hostPage = await waitFor(
    async () => {
      const history = await rpc({ action: "host-agent-history" });
      return allReady(history) && history;
    },
    "D8 host agent summary",
    { timeout: 60000 },
  );
  check("D8 the Host agent gets summaries", Object.keys(hostPage.toolGroups.groups).length >= 1);
  const scopes = (await rpc({ action: "tool-summaries-usage" })).scopes.map((item) => item.scope);
  check("the Host agent's usage is its own scope", scopes.includes("host-agent"), scopes);

  // Roles: each conversation type gets summaries, its thinking, the error mark, its original calls, and toggles without a restart.
  const matrix = {};
  const readyPage = (read, label) =>
    waitFor(
      async () => {
        const history = await read();
        return allReady(history) && history;
      },
      label,
      { timeout: 60000 },
    );
  const thoughtIn = (history, text) => history.items.some((item) => item.kind === "message" && item.thinking?.includes(text));
  /** The display checks in one transcript (`feed` is its selector), named `label` in the matrix and the screenshots. */
  const display = async (label, feed, thought) => {
    const row = (matrix[label] ??= {});
    await page.waitFor(
      `document.querySelector('${feed} .tool-summary[data-status="ready"][data-errors="1"]')`,
      `${label} summary with error mark`,
    );
    row.summaryLine = row.errorMark = true;
    await page.waitFor(
      `[...document.querySelectorAll('${feed} .thinking')].some((node) => node.innerText.includes('${thought}'))`,
      `${label} thinking`,
    );
    row.thinkingShown = true;
    await page.evaluate(`document.querySelector('${feed} .tool-summary[data-errors="1"]:not(.open) .ts-line')?.click()`);
    await page.waitFor(
      `[...document.querySelectorAll('${feed} .tool-summary.open[data-errors="1"]')].some((node) => node.querySelectorAll('.ts-body .tool-row').length === 2)`,
      `${label} original calls`,
    );
    row.originals = true;
    await page.shot(`role-${label}`, { force: true });
    await setUi({ showThinking: false });
    await page.waitFor(
      `!document.querySelector('${feed} .thinking') && document.querySelector('${feed} .tool-summary')`,
      `${label} thinking hidden live`,
    );
    await setUi({ toolSummaries: { enabled: false } });
    await page.waitFor(
      `!document.querySelector('${feed} .tool-summary') && document.querySelector('${feed} .tool-group, ${feed} .tool-row')`,
      `${label} summaries off live`,
    );
    await setUi({ showThinking: true, toolSummaries: { enabled: true } });
    await page.waitFor(
      `document.querySelector('${feed} .tool-summary[data-status="ready"]') && document.querySelector('${feed} .thinking')`,
      `${label} back on`,
    );
    row.togglesLive = true;
  };
  const openAgent = (agentId) =>
    page.waitFor(
      `(() => { const button = document.querySelector('[data-open-worker="${agentId}"]'); if (button) { button.click(); return true; } document.querySelector('[data-worker-history][aria-expanded="false"]')?.click(); return false; })()`,
      `open ${agentId}`,
    );
  const agentOf = (title) =>
    waitFor(async () => (await rpc({ action: "jobs-snapshot", id })).agents?.find((agent) => agent.title === title), title, {
      timeout: 60000,
    });

  // Coordinator: summaries and thinking were checked above in #feed.
  matrix.coordinator = { summaryLine: true, errorMark: true, thinkingShown: true, originals: true, togglesLive: true };
  // Worker: its first message thought and listed the folder.
  check("worker thinking is in its transcript", thoughtIn(workerPage, "TS-WTHOUGHT"));
  await page.evaluate(`document.querySelector('[data-cmd="leave-focus"]')?.click()`);
  await openAgent(worker.id);
  await display("worker", "#worker-feed", "TS-WTHOUGHT");
  for (const [marker, label] of [
    ["TS-SCOUT", "scout"],
    ["TS-REVIEW", "reviewer"],
  ]) {
    await kit.ask(id, `${marker} go`);
    const agent = await agentOf(`${marker}TASK`);
    const history = await readyPage(
      () => rpc({ action: "thread-history", id, threadId: agent.id, messageText: "full" }),
      `${label} summary`,
    );
    check(`${label} thinking is in its transcript`, thoughtIn(history, `${marker}TASK-THOUGHT`));
    await page.evaluate(`document.querySelector('[data-cmd="leave-focus"]')?.click()`);
    await openAgent(agent.id);
    await display(label, "#worker-feed", `${marker}TASK-THOUGHT`);
  }
  // N1: a worker's own scout and reviewer get no summaries; the worker that started them still does, and their thinking stays.
  await kit.ask(id, "TS-NEST go");
  const nester = await agentOf("TS-NESTTASK");
  const children = await waitFor(
    async () => {
      const job = (await rpc({ action: "jobs-snapshot", id })).jobs?.find((item) => item.id === nester.id);
      return job?.children?.length === 2 && job.children;
    },
    "nested scout and reviewer",
    { timeout: 60000 },
  );
  // The worker's calls that started them end after both answered, so every nested summary would have been asked by then.
  await readyPage(() => rpc({ action: "thread-history", id, threadId: nester.id, messageText: "full" }), "nesting worker summary");
  // Only the nested agents' own calls read `missing-<task>.md`; the worker's `subagent` calls name the task too.
  const nestedRequests = () => summary.requests.filter((item) => /missing-TS-N(?:SCOUT|REVIEW)TASK/.test(item.user)).length;
  check("N1 no summary request for a nested scout or reviewer", nestedRequests() === 0, nestedRequests());
  for (const child of children) {
    const label = `nested-${child.role}`;
    const history = await rpc({ action: "thread-history", id, threadId: `${nester.id}/${child.id}`, messageText: "full" });
    const ran = toolCalls(history.items).length >= 1 && history.items.some((item) => item.kind === "tool-result" && item.isError);
    check(`${label} made its calls, failing one included`, ran);
    check(`N1 ${label} has no summaries`, history.toolGroups === undefined, history.toolGroups);
    check(
      `${label} thinking is in its transcript`,
      thoughtIn(history, child.role === "scout" ? "TS-NSCOUTTASK-THOUGHT" : "TS-NREVIEWTASK-THOUGHT"),
    );
    matrix[label] = { summaryRequests: 0, toolSummaries: "none", thinkingRpc: true, browserView: "none" };
  }
  // N2: groups of nested conversations left over from before (queued, cut off while running, still collecting) send nothing
  // after a restart and drop their copy of the calls; a saved nested summary is kept.
  {
    const db = new DatabaseSync(summariesDb, BUSY);
    const insert = db.prepare(
      "INSERT INTO tool_groups (scope, conversation, first_entry, first_call, last_entry, status, size, waiting, calls, text, attempts, requests, created, updated) VALUES (?1, ?2, ?3, 'c', ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, 0, 0)",
    );
    const input = (marker, result) => JSON.stringify({ calls: [{ id: `c-${marker}`, name: "bash", args: marker, result }], more: 0 });
    const done = { text: "ok", isError: false, images: 0, nested: null };
    const [scout] = children;
    insert.run(id, scout.id, 990001, "pending", null, input("TS-NPENDING", done), null, 0, 0);
    insert.run(id, scout.id, 990002, "running", null, input("TS-NRUNNING", done), null, 1, 1);
    insert.run(id, scout.id, 990003, "collecting", '["c-TS-NCOLLECTING"]', input("TS-NCOLLECTING", null), null, 0, 0);
    insert.run(id, scout.id, 990004, "ready", null, null, "Saved nested summary.", 1, 1);
    db.close();
    await kit.restartHost();
    const rows = await waitFor(() => {
      const db = new DatabaseSync(summariesDb, { readOnly: true, ...BUSY });
      const found = db
        .prepare(
          "SELECT first_entry AS entry, status, calls FROM tool_groups WHERE first_entry >= 990001 AND first_entry <= 990004 ORDER BY first_entry",
        )
        .all();
      db.close();
      return found.slice(0, 3).every((row) => row.status === "cancelled" && row.calls === null) && found;
    }, "N2 recovered nested rows dropped");
    check("N2 a saved nested summary is kept", rows[3]?.status === "ready", rows);
    await delay(1000);
    check(
      "N2 recovered nested rows send no summary request",
      !summary.requests.some((item) => /TS-N(?:PENDING|RUNNING|COLLECTING)/.test(item.user)),
    );
    matrix["nested-recovered"] = { summaryRequests: 0, rowsDropped: 3, savedKept: true };
    await page.reload();
    await page.waitFor(`document.body.dataset.ready === "1"`, "page ready after the nested restart");
  }

  // Host agent: its summaries, thinking, error mark, original calls and toggles in the drawer, and its live thinking.
  await page.evaluate(`document.querySelector('[data-cmd="leave-focus"]')?.click()`);
  await page.evaluate(`document.querySelector('[data-cmd="host-agent"]').click()`);
  check("the Host agent's thinking is in its transcript", thoughtIn(await rpc({ action: "host-agent-history" }), "TS-HTHOUGHT"));
  await display("host-agent", "#host-agent .ha-body", "TS-HTHOUGHT");
  await rpc({ action: "host-agent-send", requestId: randomUUID(), text: "TS-HOSTLIVE now" });
  await page.waitFor(
    `[...document.querySelectorAll('#ha-live .thinking')].some((node) => node.innerText.includes('TS-HLIVE'))`,
    "Host agent live thinking",
  );
  matrix["host-agent"].liveThinking = true;
  await page.shot("role-host-agent-live", { force: true });
  await setUi({ showThinking: false });
  await page.waitFor(
    `!document.querySelector('#ha-live .thinking') && document.querySelector('#ha-live .live-status')`,
    "live thinking hidden",
  );
  await page.shot("role-host-agent-live-hidden");
  await setUi({ showThinking: true });
  hostHold.release();
  await page.viewport(390, 844, true);
  await page.waitFor(`document.querySelector('#host-agent .ha-body .tool-summary[data-status="ready"]')`, "narrow Host agent");
  await page.shot("narrow-host-agent");
  await page.evaluate(`document.querySelector('[data-cmd="host-agent"]').click()`);
  await page.waitFor(`document.querySelector('#host-agent').dataset.open !== '1'`, "drawer closed");
  await delay(400);
  await openAgent(worker.id);
  await page.waitFor(`document.querySelector('#worker-feed .tool-summary[data-status="ready"]')`, "narrow worker view");
  await page.shot("narrow-worker");
  await page.viewport(1440, 1000);

  // Every agent request used the agent's own model, never the summary model; summary requests used only the summary model.
  const roles = new Set(agentRequests.map((item) => item.role));
  check(
    "agent requests of every role ran",
    ["coordinator", "worker", "scout", "reviewer"].every((item) => roles.has(item)),
    [...roles],
  );
  check(
    "agents keep their own model",
    agentRequests.every((item) => item.model !== "fake-light"),
    agentRequests.slice(-5),
  );
  check(
    "summaries use only the summary model",
    summary.requests.every((item) => item.model === "fake-light" && item.tools.length === 0),
  );
  writeFileSync(
    join(kit.artifacts, "role-matrix.json"),
    JSON.stringify(
      { matrix, agentModels: [...new Set(agentRequests.map((item) => `${item.role}:${item.model}:reasoning=${item.reasoning}`))] },
      null,
      2,
    ),
  );
});
