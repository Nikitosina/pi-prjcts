// Unit: Follow PRs delivery through the real followRuntime with a fake durable root and a fake scheduler (scripts/plugin-enable-failures.md 48-53).
// Two synthetic provider plugins (alpha, beta) stand for the providers; admission is delayed by the test through `sink.hook`. No host, no model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = realpathSync(mkdtempSync(join(tmpdir(), "follow-delivery-unit-")));
process.env.PI_PROJECTS_HOME = join(home, "home");
const fixtures = new URL("./fixtures/follow-twins/", import.meta.url).pathname;
const dataFile = (name) => join(home, `${name}.json`);
process.env.TWIN_ALPHA_DATA = dataFile("alpha");
process.env.TWIN_BETA_DATA = dataFile("beta");
const gh = join(home, "fake-gh");
writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${new URL("./fake-gh.mjs", import.meta.url).pathname}" "$@"\n`, { mode: 0o755 });
writeFileSync(join(home, "gh-state.json"), JSON.stringify({ repo: { id: 4242, full_name: "acme/mari", default_branch: "main" }, issues: [], checks: {}, pulls: [] }));
writeFileSync(join(home, "gh-calls.jsonl"), "");
process.env.PI_PROJECTS_GH_CLI = gh;
process.env.FAKE_GH_STATE = join(home, "gh-state.json");
process.env.FAKE_GH_BARE = join(home, "none.git");
process.env.FAKE_GH_CALLS = join(home, "gh-calls.jsonl");
process.env.PI_PROJECTS_PLUGINS = [join(fixtures, "alpha.mjs"), join(fixtures, "beta.mjs")].join(":");
const set = (name, value) => writeFileSync(dataFile(name), JSON.stringify(value));
const pr = (number, head, ci = null) => ({ number, title: `PR ${number}`, head, ci });

const { loadPlugins, plugins } = await import("../src/plugins.ts");
const { saveProject, loadProject, projectDir } = await import("../src/state.ts");
const { updateAutomations } = await import("../src/project-automations.ts");
const { followRuntime } = await import("../src/durable-follow.ts");
assert.ok((await loadPlugins()).every((item) => item.state === "loaded"));

const make = () => {
  const project = {
    version: 1,
    id: randomUUID(),
    name: "p",
    cwd: home,
    objective: "",
    runtime: "durable",
    createdAt: new Date().toISOString(),
    model: "fake/fake",
    models: {},
    phase: "ready",
    problem: null,
  };
  mkdirSync(projectDir(project.id), { recursive: true });
  saveProject(project);
  updateAutomations(project.id, { follow: { enabled: true } });
  return project;
};
const off = (id, name) => saveProject({ ...loadProject(id), disabledPlugins: [name] });
const on = (id) => {
  const { disabledPlugins: _, ...rest } = loadProject(id);
  saveProject(rest);
};

/** A durable root that keeps its documents across runtimes (a restart builds a new runtime on the same store). */
const store = (id) => {
  const docs = new Map();
  return {
    id: 1,
    docs,
    commit: async (work) =>
      work({
        doc: async (token) => {
          const kind = token.definition.kind;
          if (!docs.has(kind)) docs.set(kind, token.definition.initial());
          return docs.get(kind);
        },
      }),
  };
};
const doc = (root) => root.docs.get("projects.pr-follow");

/**
 * The delivered events by project and chat; `hook(phase, input)` runs inside an admission and may hold or fail it. Like the scheduler, an
 * event id is recorded once: asking again returns the recorded intent as it is now (`sink.resolve` stands for a restart that found a receipt).
 */
const sink = { delivered: [], hook: async () => {}, intents: new Map(), status: "submitted", pulls: [], submissions: 0 };
const outcomeOf = { interrupted: "Project paused", uncertain: "Admission failed; fingerprint x", failed: "unanswered" };
const land = (key, intent) => {
  intent.submissionId = ++sink.submissions;
  intent.outcome = null;
  sink.delivered.push({ ...intent.record });
  sink.landed.add(key);
};
sink.landed = new Set();
sink.archived = new Set();
sink.resolve = (project, eventId, status) => {
  const key = `${project.id}\0${eventId}`,
    intent = sink.intents.get(key);
  intent.status = status;
  if (status === "submitted" && !sink.landed.has(key)) land(key, intent);
};
const runtime = (project, root, { jobs = [] } = {}) => {
  const schedules = {
    ingest: async (input, live, _record, options) => {
      const authorized = async (phase) => {
        await sink.hook(phase, input, project.id);
        if (!(await live())) throw new Error("Event admission is no longer authorized");
      };
      await authorized("admit");
      const key = `${project.id}\0${input.eventId}`,
        prior = sink.intents.get(key);
      if (prior) {
        if (prior.record.payload !== input.payload) throw new Error("Conflicting event ID");
        return { status: prior.status, submissionId: prior.submissionId, outcome: prior.outcome, duplicate: true };
      }
      await authorized("submit");
      const asked = typeof sink.status === "function" ? sink.status(input) : sink.status;
      // "aborted" and "failed" are submissions that reached the chat and ended badly; "interrupted" never called the chat.
      const reached = asked === "aborted" || asked === "failed",
        status = asked === "aborted" ? "interrupted" : asked;
      const intent = {
        status,
        submissionId: null,
        outcome: outcomeOf[status] ?? null,
        record: { project: project.id, chat: Number(options.target.id), eventId: input.eventId, payload: input.payload },
      };
      sink.intents.set(key, intent);
      if (status === "submitted" || reached) land(key, intent);
      return { status, submissionId: intent.submissionId, outcome: intent.outcome };
    },
  };
  const fixer = {
    target: async () => ({ id: 100 }),
    chatConversation: async (chat) => (await sink.hook("chat", { chat }, project.id), sink.archived.has(chat) ? null : { id: chat }),
    threads: async () => jobs,
    workStatus: async () => null,
    planWork: async () => "w",
    followUp: async () => "w",
    pullMain: async (input) => (sink.pulls.push(input), { pulled: false, reason: "test" }),
  };
  return followRuntime(root, project.id, schedules, fixer, () => false);
};
const delivered = (project, chat) =>
  sink.delivered.filter((item) => item.project === project.id && (chat === undefined || item.chat === chat));
const reset = () => {
  sink.delivered.length = 0;
  sink.intents.clear();
  sink.landed.clear();
  sink.archived.clear();
  sink.pulls.length = 0;
  sink.status = "submitted";
  sink.hook = async () => {};
};
const failures = [];
const scenario = async (name, work) => {
  try {
    await work();
  } catch (error) {
    failures.push({ name });
    console.error(`${name}: ${error.message.split("\n")[0]}`);
  }
};
const attempt = async (work) => {
  try {
    await work();
    return "";
  } catch (error) {
    return error.message;
  }
};
const disable = (project, name, root) => plugins.disable(() => loadProject(project.id), name, root, saveProject);

// F1 outstanding delivery holds the plugin on: a disable that arrives while the event is between admission and submit is refused, not applied.
await scenario("F1", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "a".repeat(40))], published: [{ number: 7, conversationId: 5 }] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "b".repeat(40))], published: [] });
  const jobs = [{ threadId: "t5", conversationId: 5, chat: 11, pr: null }];
  const follow = runtime(project, root, { jobs });
  await follow.poll(true);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "a".repeat(40), "passed")], published: [{ number: 7, conversationId: 5 }] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "b".repeat(40), "passed")], published: [] });
  let refused = "not asked";
  sink.hook = async (phase, input) => {
    if (phase === "submit" && input.kind === "alpha.follow") refused = await attempt(() => disable(project, "alpha", root));
  };
  await follow.poll(true);
  assert.match(refused, /active work/, "F1 the disable during the outstanding delivery is refused");
  assert.equal(loadProject(project.id).disabledPlugins, undefined, "F1 alpha stays on");
  assert.equal(delivered(project, 11).length, 1, "F1 the alpha event reached its owner chat once");
  assert.equal(delivered(project, 100).length, 1, "F1 the beta event reached the event chat once");
  assert.equal(plugins.gate.active(project.id, "alpha"), 0, "F1 nothing is left counted after the delivery");
  assert.match((await disable(project, "alpha", root)).disabledPlugins.join(), /alpha/, "F1 once delivered the disable goes through");
});

// F2 a frozen batch of the older format (groups without a provider tag): never delivered for a recorded provider that is off, also when
// the provider is switched off between two of its groups.
await scenario("F2", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  const tagged = { baselined: true, prs: {}, provider: "alpha" };
  const group = (chat) => ({ input: { eventId: `legacy-${chat}`, kind: "github.follow", payload: `legacy ${chat}` }, chat });
  const legacy = () => ({
    repos: { "alpha/repo": tagged, "beta/repo": { ...tagged, provider: "beta" } },
    notices: [],
    count: 2,
    groups: [group(11), group(12)],
    switchedOff: [],
  });
  const follow = runtime(project, root);
  root.docs.set("projects.pr-follow", {
    repos: {},
    fixes: {},
    lastPollAtMs: null,
    lastError: null,
    polls: 0,
    events: 0,
    lastEventAtMs: null,
    pending: legacy(),
  });
  let refused = "not asked";
  sink.hook = async (phase, input) => {
    if (phase === "admit" && input.eventId === "legacy-11") refused = await attempt(() => disable(project, "alpha", root));
  };
  await follow.poll(true);
  assert.match(refused, /active work/, "F2 a recorded provider cannot be switched off while a legacy group is delivering");
  assert.deepEqual(
    delivered(project).map((item) => item.chat),
    [11, 12],
    "F2 both legacy groups were delivered while nothing was off",
  );

  reset();
  root.docs.set("projects.pr-follow", { ...doc(root), pending: legacy() });
  sink.hook = async (phase, input) => {
    if (phase === "chat" && input.chat === 12) await disable(project, "alpha", root);
  };
  await runtime(project, root).poll(true);
  assert.deepEqual(
    delivered(project).map((item) => item.chat),
    [11],
    "F2 a provider switched off between two groups: the second legacy group is held back",
  );
  on(project.id);
  reset();
  off(project.id, "alpha");
  root.docs.set("projects.pr-follow", { ...doc(root), pending: legacy() });
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 0, "F2 a legacy batch whose recorded provider is already off delivers nothing");
  on(project.id);
});

// F3 two providers that report the same repository id and PR number, same head, same chat: both events are delivered, neither poll fails,
// and the next poll announces nothing again.
await scenario("F3", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  const head = "c".repeat(40);
  set("alpha", { repositoryId: "acme/mari", prs: [pr(7, head)], published: [] });
  set("beta", { repositoryId: "acme/mari", prs: [pr(7, head)], published: [] });
  const follow = runtime(project, root);
  await follow.poll(true);
  assert.deepEqual(Object.keys(doc(root).repos).length, 2, "F3 each provider has its own record for the shared repository id");
  set("alpha", { repositoryId: "acme/mari", prs: [pr(7, head, "passed")], published: [] });
  set("beta", { repositoryId: "acme/mari", prs: [pr(7, head, "passed")], published: [] });
  await follow.poll(true);
  assert.equal(doc(root).lastError, null, "F3 the poll did not fail");
  const events = delivered(project, 100);
  assert.equal(events.length, 2, "F3 both providers' events were delivered");
  assert.equal(new Set(events.map((item) => item.eventId)).size, 2, "F3 with different event ids");
  assert.ok(events.some((item) => item.payload.includes("[alpha]")) && events.some((item) => item.payload.includes("[beta]")));
  await follow.poll(true);
  assert.equal(delivered(project).length, 2, "F3 a later poll announces nothing again");
  assert.equal(Object.keys(doc(root).repos).length, 2);
});

// F4 a record written by the older host under the bare repository id belongs to the provider that tagged it: that provider continues from
// it, the other provider with the same id starts its own baseline silently, and the old key is gone afterwards.
await scenario("F4", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  const head = "d".repeat(40);
  set("alpha", { repositoryId: "acme/mari", prs: [pr(7, head, "passed")], published: [] });
  set("beta", { repositoryId: "acme/mari", prs: [pr(7, head, "passed")], published: [] });
  const old = {
    baselined: true,
    prs: {
      7: { state: "open", head, ref: "alpha/7", title: "PR 7", updatedAt: "", ci: null, lastReview: 0, lastComment: 0, lastLineComment: 0 },
    },
    provider: "alpha",
  };
  root.docs.set("projects.pr-follow", {
    repos: { "acme/mari": old },
    fixes: {},
    lastPollAtMs: null,
    lastError: null,
    polls: 0,
    events: 0,
    lastEventAtMs: null,
  });
  await runtime(project, root).poll(true);
  const events = delivered(project);
  assert.equal(events.length, 1, "F4 only the tagged provider continued from the old record");
  assert.match(events[0].payload, /\[alpha\]/, "F4 and it is alpha");
  assert.ok(!("acme/mari" in doc(root).repos), "F4 the old key was consumed");
  assert.equal(Object.keys(doc(root).repos).length, 2);
});

// F5 restart: a batch whose delivery stopped halfway is finished by a new runtime on the same store; every event reaches its chat once.
await scenario("F5", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "1".repeat(40))], published: [{ number: 7, conversationId: 5 }] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "2".repeat(40))], published: [] });
  const jobs = [{ threadId: "t5", conversationId: 5, chat: 11, pr: null }];
  await runtime(project, root, { jobs }).poll(true);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "1".repeat(40), "passed")], published: [{ number: 7, conversationId: 5 }] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "2".repeat(40), "passed")], published: [] });
  let crashed = false;
  sink.hook = async (phase, input) => {
    if (phase === "admit" && input.kind === "beta.follow" && !crashed) {
      crashed = true;
      throw new Error("host stopped");
    }
  };
  await assert.rejects(() => runtime(project, root, { jobs }).poll(true), /host stopped/);
  assert.ok(doc(root).pending, "F5 the frozen batch is still pending");
  sink.hook = async () => {};
  await runtime(project, root, { jobs }).poll(true);
  assert.equal(delivered(project, 11).length, 1, "F5 alpha's event once in its chat");
  assert.equal(delivered(project, 100).length, 1, "F5 beta's event once in the event chat");
  assert.equal(doc(root).pending, undefined);
  await runtime(project, root, { jobs }).poll(true);
  assert.equal(delivered(project).length, 2, "F5 nothing again after another poll");
});

// F6 two projects: a provider off in one project delivers nothing there, keeps its place, and is announced after the enable; the other
// project is unaffected.
await scenario("F6", async () => {
  reset();
  const first = make(),
    second = make(),
    roots = [store(first.id), store(second.id)];
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "3".repeat(40))], published: [] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "4".repeat(40))], published: [] });
  const runs = [runtime(first, roots[0]), runtime(second, roots[1])];
  await Promise.all(runs.map((run) => run.poll(true)));
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "3".repeat(40), "passed")], published: [] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "4".repeat(40), "passed")], published: [] });
  let crashed = false;
  sink.hook = async (phase, input, id) => {
    if (id === second.id && phase === "admit" && input.kind === "alpha.follow" && !crashed) {
      crashed = true;
      throw new Error("host stopped");
    }
  };
  await runs[0].poll(true);
  await assert.rejects(() => runs[1].poll(true), /host stopped/);
  sink.hook = async () => {};
  off(second.id, "alpha");
  await runtime(second, roots[1]).poll(true);
  assert.equal(delivered(first).length, 2, "F6 the project with alpha on got both events");
  assert.ok(!delivered(second).some((item) => item.payload.includes("[alpha]")), "F6 the project with alpha off got none of alpha's");
  assert.equal(delivered(second).length, 1, "F6 and still beta's once");
  on(second.id);
  await runtime(second, roots[1]).poll(true);
  assert.equal(
    delivered(second).filter((item) => item.payload.includes("[alpha]")).length,
    1,
    "F6 alpha's skipped event is announced after the enable",
  );
  assert.equal(delivered(first).length, 2, "F6 the other project saw nothing new");
});

// F7 a provider switched off while its group is skipped and back on before the batch is recorded: its event is not counted or claimed, its
// record (one an older host stored under the bare id moved to its own key) stays, and the next poll announces the event once.
await scenario("F7", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  const head = "e".repeat(40);
  const old = {
    baselined: true,
    prs: {
      7: { state: "open", head, ref: "alpha/7", title: "PR 7", updatedAt: "", ci: null, lastReview: 0, lastComment: 0, lastLineComment: 0 },
    },
    provider: "alpha",
  };
  root.docs.set("projects.pr-follow", {
    repos: { "acme/mari": old, [`beta::beta/repo`]: { baselined: true, prs: {}, provider: "beta", repositoryId: "beta/repo" } },
    fixes: {},
    lastPollAtMs: null,
    lastError: null,
    polls: 0,
    events: 0,
    lastEventAtMs: null,
  });
  set("alpha", { repositoryId: "acme/mari", prs: [pr(7, head, "passed")], published: [] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(8, "f".repeat(40), "passed")], published: [] });
  sink.hook = async (phase, input) => {
    if (phase === "chat" && input.chat === 100 && !off.done) {
      off.done = true;
      await disable(project, "alpha", root);
    }
    if (phase === "admit" && input.kind === "beta.follow") on(project.id);
  };
  await runtime(project, root).poll(true);
  assert.equal(
    delivered(project).filter((item) => item.payload.includes("[alpha]")).length,
    0,
    "F7 alpha's event was not delivered while it was off",
  );
  assert.equal(doc(root).events, delivered(project).length, "F7 only what was delivered is counted");
  assert.ok("alpha::acme/mari" in doc(root).repos && !("acme/mari" in doc(root).repos), "F7 alpha's record survives under its own key");
  sink.hook = async () => {};
  await runtime(project, root).poll(true);
  assert.equal(
    delivered(project).filter((item) => item.payload.includes("[alpha]")).length,
    1,
    "F7 the next poll announces alpha's event once",
  );
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).filter((item) => item.payload.includes("[alpha]")).length, 1, "F7 and not again");
});

// F8 auto-fix attempts: a plugin never inherits another provider's attempts stored under the same bare name; attempts an older host stored
// for the plugin move with its repository record, so the cap and the same-head rule still see them.
await scenario("F8", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  updateAutomations(project.id, { follow: { enabled: true, autoFix: true, fixCap: 3 } });
  const head = "9".repeat(40),
    other = "8".repeat(40);
  const record = (provider) => ({ baselined: true, prs: {}, provider, repositoryId: "acme/mari" });
  const attemptOf = (sha) => ({ sha, at: 1, mode: "follow-up", workId: "w0", threadId: "t5", error: null });
  const jobs = [{ threadId: "t5", conversationId: 5, chat: 11, pr: null }];
  root.docs.set("projects.pr-follow", {
    repos: { [`alpha::acme/mari`]: record("alpha") },
    fixes: { "acme/mari#7": [attemptOf(head)] },
    lastPollAtMs: null,
    lastError: null,
    polls: 0,
    events: 0,
    lastEventAtMs: null,
  });
  set("alpha", { repositoryId: "acme/mari", prs: [pr(7, head, "failed")], published: [{ number: 7, conversationId: 5 }] });
  await runtime(project, root, { jobs }).poll(true);
  assert.equal(
    doc(root).fixes["alpha:acme/mari#7"]?.length,
    1,
    "F8 GitHub's attempt for the same head does not suppress the plugin's first fix",
  );
  assert.equal(doc(root).fixes["acme/mari#7"]?.length, 1, "F8 and GitHub's own attempts stay where they are");

  reset();
  const second = make(),
    secondRoot = store(second.id);
  updateAutomations(second.id, { follow: { enabled: true, autoFix: true, fixCap: 3 } });
  secondRoot.docs.set("projects.pr-follow", {
    repos: { "acme/mari": { baselined: true, prs: {}, provider: "alpha" } },
    fixes: { "acme/mari#7": [attemptOf(other)] },
    lastPollAtMs: null,
    lastError: null,
    polls: 0,
    events: 0,
    lastEventAtMs: null,
  });
  await runtime(second, secondRoot, { jobs }).poll(true);
  const moved = doc(secondRoot).fixes["alpha:acme/mari#7"];
  assert.deepEqual(
    moved?.map((item) => item.sha),
    [other, head],
    "F8 the plugin's older attempts moved with its record and the new one follows",
  );
  assert.ok(!("acme/mari#7" in doc(secondRoot).fixes), "F8 the bare list is gone");
  await runtime(second, secondRoot, { jobs }).poll(true);
  assert.equal(doc(secondRoot).fixes["alpha:acme/mari#7"].length, 2, "F8 the same head is not fixed twice");
});

// F9 an event the scheduler refused before it called the chat (interrupted, no submission) is not announced, not counted and not forgotten:
// the batch and the record wait, the event goes out once as a new attempt of the same identity, and the poll reports the id it submitted.
await scenario("F9", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "5".repeat(40))], published: [] });
  const follow = runtime(project, root);
  await follow.poll(true);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "5".repeat(40), "passed")], published: [] });
  sink.status = "interrupted";
  const refused = await follow.poll(true);
  assert.equal(doc(root).events, 0, "F9 nothing is counted for an event that was not submitted");
  assert.equal(delivered(project).length, 0, "F9 nothing reached the chat");
  assert.equal(refused.eventId, undefined, "F9 no event id is reported as submitted");
  assert.equal(doc(root).pending?.groups.length, 1, "F9 the refused group stays pending");
  assert.equal(doc(root).repos["alpha::alpha/repo"].prs[7].ci, null, "F9 the record did not advance past the event");
  const [first] = [...sink.intents.values()];
  sink.status = "submitted";
  const retried = await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 1, "F9 the next poll delivers it");
  assert.equal(delivered(project)[0].eventId, `${first.record.eventId}~1`, "F9 as a new attempt of the same identity");
  assert.equal(delivered(project)[0].payload, first.record.payload, "F9 with the frozen payload");
  assert.equal(retried.eventId, delivered(project)[0].eventId, "F9 the poll reports the submitted id");
  assert.equal(doc(root).pending, undefined, "F9 nothing is pending afterwards");
  assert.equal(doc(root).events, 1, "F9 counted once");
  assert.equal(doc(root).repos["alpha::alpha/repo"].prs[7].ci?.result, "passed", "F9 the record advanced");
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 1, "F9 and nothing again");
});

// F10 an uncertain submission (it may have reached the chat) is never replayed under another id: the group waits with its record, other
// providers go on, and a restart that finds the receipt confirms it once.
await scenario("F10", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "6".repeat(40))], published: [] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "7".repeat(40))], published: [] });
  await runtime(project, root).poll(true);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "6".repeat(40), "passed")], published: [] });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "7".repeat(40), "passed")], published: [] });
  sink.status = (input) => (input.kind === "alpha.follow" ? "uncertain" : "submitted");
  await runtime(project, root).poll(true);
  const uncertain = [...sink.intents.values()].find((item) => item.record.payload.includes("[alpha]"));
  assert.equal(delivered(project).length, 1, "F10 beta's event went out");
  assert.ok(delivered(project)[0].payload.includes("[beta]"), "F10 and only beta's");
  assert.match(doc(root).lastError ?? "", /uncertain/, "F10 the uncertain delivery is reported");
  assert.equal(doc(root).events, 1, "F10 only the confirmed event is counted");
  assert.equal(doc(root).repos["beta::beta/repo"].prs[7].ci?.result, "passed", "F10 beta's record advanced");
  assert.equal(doc(root).repos["alpha::alpha/repo"].prs[7].ci, null, "F10 alpha's did not");
  sink.status = "submitted";
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "8".repeat(40), "passed")], published: [] });
  await runtime(project, root).poll(true);
  assert.equal(sink.intents.size, 3, "F10 the uncertain event was not replayed under another id; a later beta event went out");
  assert.equal(delivered(project).filter((item) => item.payload.includes("[alpha]")).length, 0, "F10 alpha's is still not announced");
  assert.ok(doc(root).pending, "F10 and still held");
  sink.resolve(project, uncertain.record.eventId, "submitted");
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).filter((item) => item.payload.includes("[alpha]")).length, 1, "F10 the receipt confirmed it once");
  assert.equal(doc(root).pending, undefined, "F10 nothing is pending afterwards");
  assert.equal(doc(root).repos["alpha::alpha/repo"].prs[7].ci?.result, "passed", "F10 alpha's record advanced after the receipt");
  assert.equal(doc(root).events, 3, "F10 each event counted once");
  assert.equal(doc(root).lastError, null, "F10 the problem is cleared");
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 3, "F10 and nothing again");
});

// F11 a record an older host stored under the bare id and tagged by a provider that is off is not replaced by GitHub's record for the same
// owner/name, whatever providers are connected; its attempts are kept for both sides when GitHub follows the repository too.
await scenario("F11", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  saveProject({
    ...loadProject(project.id),
    githubAuthorization: [
      { repositoryId: "acme/mari", numericId: 4242, branchPrefix: "pi/", baseBranch: "main", owner: "o", workspaceRevision: "0".repeat(64), at: "" },
    ],
  });
  const head = "a1".repeat(20);
  const stored = {
    baselined: true,
    prs: { 7: { state: "open", head, ref: "alpha/7", title: "PR 7", updatedAt: "", ci: null, lastReview: 0, lastComment: 0, lastLineComment: 0 } },
    provider: "alpha",
  };
  const attemptOf = { sha: head, at: 1, mode: "follow-up", workId: "w0", threadId: "t5", error: null };
  root.docs.set("projects.pr-follow", {
    repos: { "acme/mari": stored },
    fixes: { "acme/mari#7": [attemptOf] },
    lastPollAtMs: null,
    lastError: null,
    polls: 0,
    events: 0,
    lastEventAtMs: null,
  });
  off(project.id, "alpha");
  await runtime(project, root).poll(true);
  assert.equal(doc(root).repos["alpha::acme/mari"]?.prs[7]?.head, head, "F11 alpha's record is kept under its own key");
  assert.equal(doc(root).repos["alpha::acme/mari"]?.provider, "alpha");
  assert.equal(doc(root).repos["acme/mari"]?.provider, "github", "F11 GitHub has its own record under the bare key");
  assert.equal(doc(root).fixes["alpha:acme/mari#7"]?.length, 1, "F11 the attempt is kept for alpha too");
  assert.equal(doc(root).fixes["acme/mari#7"]?.length, 1, "F11 and GitHub keeps the list it had");
  on(project.id);
  set("alpha", { repositoryId: "acme/mari", prs: [pr(7, head, "passed")], published: [] });
  await runtime(project, root).poll(true);
  assert.equal(
    delivered(project).filter((item) => item.payload.includes("[alpha]")).length,
    1,
    "F11 alpha continues from its own record after the enable",
  );
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 1, "F11 and not again");
});

// F12 one provider's groups for two chats, one submitted and one skipped (the plugin went off between them): the submitted one is confirmed
// at once, the skipped one keeps its frozen chat and id, other providers go on, and the enable delivers it once with no repeat in any chat.
await scenario("F12", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  const jobs = [
    { threadId: "t5", conversationId: 5, chat: 11, pr: null },
    { threadId: "t6", conversationId: 6, chat: 12, pr: null },
  ];
  const published = [
    { number: 7, conversationId: 5 },
    { number: 8, conversationId: 6 },
  ];
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "1a".repeat(20)), pr(8, "1b".repeat(20))], published });
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "1c".repeat(20))], published: [] });
  await runtime(project, root, { jobs }).poll(true);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "1a".repeat(20), "passed"), pr(8, "1b".repeat(20), "passed")], published });
  let switched = false;
  sink.hook = async (phase, input) => {
    if (phase === "chat" && input.chat === 12 && doc(root).pending && !switched) {
      switched = true;
      await disable(project, "alpha", root);
    }
  };
  await runtime(project, root, { jobs }).poll(true);
  const alphaEvents = () => delivered(project).filter((item) => item.payload.includes("[alpha]"));
  assert.deepEqual(
    alphaEvents().map((item) => item.chat),
    [11],
    "F12 the first chat got its event",
  );
  assert.equal(doc(root).pending?.groups.length, 1, "F12 the skipped group is pending with its chat");
  assert.equal(doc(root).pending.groups[0].chat, 12);
  assert.equal(doc(root).events, 1, "F12 only the delivered event is counted");
  sink.hook = async () => {};
  jobs.shift();
  sink.archived.add(11);
  set("beta", { repositoryId: "beta/repo", prs: [pr(7, "1c".repeat(20), "passed")], published: [] });
  await runtime(project, root, { jobs }).poll(true);
  assert.equal(
    delivered(project, 100).filter((item) => item.payload.includes("[beta]")).length,
    1,
    "F12 beta is still followed while alpha waits",
  );
  on(project.id);
  await runtime(project, root, { jobs }).poll(true);
  assert.deepEqual(
    alphaEvents().map((item) => item.chat),
    [11, 12],
    "F12 after the enable the second chat gets its event and the first one nothing again",
  );
  assert.equal(doc(root).pending, undefined, "F12 nothing is pending afterwards");
  assert.equal(doc(root).repos["alpha::alpha/repo"].prs[8].ci?.result, "passed", "F12 the record advanced once its last group was confirmed");
  await runtime(project, root, { jobs }).poll(true);
  assert.equal(alphaEvents().length, 2, "F12 and later polls announce nothing again");
});

// F13 a submission that reached the chat but ended badly (failed, aborted) is delivered: it is confirmed and never sent again.
await scenario("F13", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "2a".repeat(20))], published: [] });
  await runtime(project, root).poll(true);
  set("alpha", { repositoryId: "alpha/repo", prs: [pr(7, "2a".repeat(20), "passed")], published: [] });
  sink.status = "aborted";
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 1, "F13 it reached the chat");
  assert.equal(doc(root).pending, undefined, "F13 it is confirmed");
  sink.status = "submitted";
  await runtime(project, root).poll(true);
  assert.equal(delivered(project).length, 1, "F13 and it is not sent again");
});

// F14 two providers that report the same repository id and PR number both merged: the main-checkout pull is asked per provider, with its own
// repository id, and each event carries its own note.
await scenario("F14", async () => {
  reset();
  const project = make(),
    root = store(project.id);
  const one = (provider) => ({ repositoryId: "acme/mari", prs: [{ ...pr(7, "3a".repeat(20)), base: "main" }], published: [], provider });
  set("alpha", one("alpha"));
  set("beta", one("beta"));
  await runtime(project, root).poll(true);
  for (const name of ["alpha", "beta"]) set(name, { ...one(name), prs: [{ ...pr(7, "3a".repeat(20)), base: "main", state: "merged" }] });
  await runtime(project, root).poll(true);
  assert.deepEqual(
    sink.pulls.map((item) => [item.provider, item.repositoryId, item.pr]).sort(),
    [
      ["alpha", "acme/mari", 7],
      ["beta", "acme/mari", 7],
    ],
    "F14 each provider's merge asks its own pull",
  );
  assert.equal(delivered(project).length, 2, "F14 both events arrived");
  assert.ok(delivered(project).every((item) => item.payload.includes("main checkout not pulled: test")), "F14 each with the pull note");
});

if (failures.length) {
  console.error(`follow-delivery-unit: FAILED ${failures.map((item) => item.name).join(", ")}`);
  process.exit(1);
}
console.log("follow-delivery-unit: ok");
