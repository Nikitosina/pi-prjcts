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

/** The delivered events by project and chat; `hook(phase, input)` runs inside an admission and may hold or fail it. */
const sink = { delivered: [], hook: async () => {}, seen: new Map() };
const runtime = (project, root, { jobs = [] } = {}) => {
  const schedules = {
    ingest: async (input, live, _record, options) => {
      const authorized = async (phase) => {
        await sink.hook(phase, input, project.id);
        if (!(await live())) throw new Error("Event admission is no longer authorized");
      };
      await authorized("admit");
      const prior = sink.seen.get(`${project.id}\0${input.eventId}`);
      if (prior) {
        if (prior.payload !== input.payload) throw new Error("Conflicting event ID");
        return { duplicate: true };
      }
      await authorized("submit");
      sink.seen.set(`${project.id}\0${input.eventId}`, input);
      sink.delivered.push({ project: project.id, chat: Number(options.target.id), eventId: input.eventId, payload: input.payload });
      return {};
    },
  };
  const fixer = {
    target: async () => ({ id: 100 }),
    chatConversation: async (chat) => (await sink.hook("chat", { chat }, project.id), { id: chat }),
    threads: async () => jobs,
    workStatus: async () => null,
    planWork: async () => "w",
    followUp: async () => "w",
    pullMain: async () => ({ pulled: false, reason: "test" }),
  };
  return followRuntime(root, project.id, schedules, fixer, () => false);
};
const delivered = (project, chat) =>
  sink.delivered.filter((item) => item.project === project.id && (chat === undefined || item.chat === chat));
const reset = () => {
  sink.delivered.length = 0;
  sink.seen.clear();
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

if (failures.length) {
  console.error(`follow-delivery-unit: FAILED ${failures.map((item) => item.name).join(", ")}`);
  process.exit(1);
}
console.log("follow-delivery-unit: ok");
