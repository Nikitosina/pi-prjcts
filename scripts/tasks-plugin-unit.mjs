// Unit: the tasks plugin's store, tools and RPC without a host (plugins/tasks/FAILURES.md, numbers in check labels). Temp state dir only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as durable from "@earendil-works/pi-durable";
import * as typebox from "typebox";
import * as value from "typebox/value";
import plugin from "../plugins/tasks/index.ts";

const projectA = "00000000-0000-4000-8000-00000000000a";
const projectB = "00000000-0000-4000-8000-00000000000b";
const chatOne = "11111111-1111-4111-8111-111111111111";
const chatTwo = "22222222-2222-4222-8222-222222222222";
const stateDir = mkdtempSync(join(tmpdir(), "tasks-unit-"));
const provided = {};
await plugin.register({
  name: plugin.name,
  stateDir,
  lib: { durable, typebox, value },
  provide: (caps) => Object.assign(provided, caps),
  projects: { load: (id) => ({ id }) },
});

const conversations = new Map([
  [1, "main"],
  [2, chatOne],
  [3, chatTwo],
]);
const make = (projectId) =>
  Object.fromEntries(
    provided.coordinatorTools
      .create({
        projectId,
        root: () => undefined,
        isCoordinator: (id) => conversations.has(Number(id)),
        chatIdOf: (id) => conversations.get(Number(id)),
      })
      .tools.map((tool) => [tool.name, tool]),
  );
const tools = make(projectA);
// The harness validates arguments against the schema before execute; do the same here.
const call = async (name, args, conversationId = 1, set = tools) => {
  if (!value.Value.Check(set[name].parameters, args)) throw new Error(`Invalid arguments (schema) for ${name}`);
  return JSON.parse((await set[name].execute(args, { conversationId })).output[0].text);
};
const list = (conversationId = 1, set = tools) => call("tasks_list", {}, conversationId, set);
const GH = { provider: "github", repository: "acme/mari", number: "7" };

try {
  assert.deepEqual(Object.keys(tools).sort(), ["tasks_add", "tasks_attach_pr", "tasks_finish", "tasks_list", "tasks_update"]);
  assert.deepEqual(provided.rpcPolicy, { list: "read" });
  assert.deepEqual(Object.keys(provided.rpc), ["list"]);
  assert.equal(provided.web.sidebar.title, "Tasks");

  // 8 17: a task without a Job, a PR or a link is a task
  const first = await call("tasks_add", { title: "Write the parser" });
  assert.equal(first.stage, "planned");
  assert.equal(first.pr, undefined);
  assert.match(first.id, /^[a-z0-9-]{4,}$/);
  const second = await call("tasks_add", { title: "Write the parser", stage: "in-progress", note: "parallel", job: "job-9" });
  assert.notEqual(first.id, second.id, "11 same title makes a second task");
  assert.equal((await list()).tasks.length, 2);

  // 9 11 stage rules, parallel updates touch one task
  await call("tasks_update", { id: second.id, stage: "in-review" });
  assert.deepEqual(
    (await list()).tasks.map((task) => task.stage),
    ["planned", "in-review"],
  );
  await assert.rejects(call("tasks_update", { id: first.id, stage: "waiting" }), /stage|Expected|schema/i);
  await assert.rejects(call("tasks_update", { id: first.id, stage: "done" }), /stage|Expected|schema|tasks_finish/i);
  // 10 unknown ids
  await assert.rejects(call("tasks_update", { id: "nope", stage: "blocked" }), /Unknown task/);
  await assert.rejects(call("tasks_finish", { id: "nope" }), /Unknown task/);

  // 1: no chatId in any schema, and unknown arguments are refused by the harness schema
  for (const tool of Object.values(tools)) {
    const schema = JSON.stringify(tool.parameters);
    assert.ok(!/chat/i.test(schema), `1 ${tool.name} has no chat argument`);
    assert.equal(tool.parameters.additionalProperties, false, `1 ${tool.name} refuses unknown arguments`);
  }

  // 5: lists are per chat and per project
  assert.deepEqual((await list(2)).tasks, [], "5 another chat starts empty");
  const other = await call("tasks_add", { title: "Chat one task" }, 2);
  assert.deepEqual(
    (await list(2)).tasks.map((task) => task.id),
    [other.id],
  );
  assert.equal((await list()).tasks.length, 2, "5 main list unchanged");
  assert.deepEqual((await list(1, make(projectB))).tasks, [], "5 another project starts empty");
  await assert.rejects(
    call("tasks_update", { id: first.id, stage: "blocked" }, 2),
    /Unknown task/,
    "10 a task of another chat cannot be changed",
  );
  await assert.rejects(call("tasks_finish", { id: first.id }, 2), /Unknown task/);

  // 2: a caller that is not a Coordinator conversation
  await assert.rejects(list(99), /coordinator/i);
  await assert.rejects(call("tasks_add", { title: "x" }, 99), /coordinator/i);

  // 12 13 14 15 pull requests
  for (const bad of [
    { id: first.id, repository: "acme/mari", number: "7" },
    { id: first.id, provider: "github", number: "7" },
    { id: first.id, provider: "github", repository: "acme/mari" },
    { id: first.id, provider: "GitHub!", repository: "acme/mari", number: "7" },
    { id: first.id, ...GH, repository: "acme mari" },
    { id: first.id, ...GH, url: "javascript:alert(1)" },
    { id: first.id, ...GH, url: "not a url" },
  ])
    await assert.rejects(call("tasks_attach_pr", bad), /./, `12 15 refused: ${JSON.stringify(bad)}`);
  assert.equal((await list()).tasks[0].pr, undefined, "12 nothing attached by the refusals");
  const attached = await call("tasks_attach_pr", { id: first.id, ...GH, url: "https://github.com/acme/mari/pull/7" });
  assert.deepEqual(attached.pr, { ...GH, url: "https://github.com/acme/mari/pull/7" });
  assert.deepEqual(
    await call("tasks_attach_pr", { id: first.id, ...GH, url: "https://github.com/acme/mari/pull/7" }),
    attached,
    "14 identical attach is a no-op",
  );
  await assert.rejects(call("tasks_attach_pr", { id: first.id, ...GH, number: "8" }), /replace/, "14 a different PR needs replace");
  assert.equal((await call("tasks_attach_pr", { id: first.id, ...GH, number: "8", replace: true })).pr.number, "8");
  await assert.rejects(call("tasks_attach_pr", { id: second.id, ...GH, number: "8" }), /already/, "14 one PR, one task");
  const arc = await call("tasks_attach_pr", { id: second.id, provider: "arc", repository: "arcadia", number: "8" });
  assert.equal(arc.pr.provider, "arc", "13 same number, other provider and repository, is another PR");
  const sameRepoOtherProvider = await call(
    "tasks_attach_pr",
    { id: other.id, provider: "gitlab", repository: "acme/mari", number: "8" },
    2,
  );
  assert.equal(sameRepoOtherProvider.pr.provider, "gitlab", "13 uniqueness is per chat list anyway");

  // 9 finish
  const done = await call("tasks_finish", { id: first.id, note: "merged" });
  assert.equal(done.stage, "done");
  assert.ok(done.finishedAt);
  assert.deepEqual(await call("tasks_finish", { id: first.id }), done, "finish is idempotent");
  await assert.rejects(call("tasks_update", { id: first.id, stage: "blocked" }), /finished/i);
  await assert.rejects(call("tasks_attach_pr", { id: first.id, ...GH, number: "9", replace: true }), /finished/i);

  // RPC list: reads one chat, validates ids (3 4)
  const rpcList = (params, projectId = projectA) => provided.rpc.list({ projectId, params });
  assert.deepEqual(
    (await rpcList({ chatId: chatOne })).tasks.map((task) => task.id),
    [other.id],
  );
  assert.equal((await rpcList({ chatId: "main" })).tasks.length, 2);
  for (const params of [{ chatId: "../x" }, { chatId: "" }, {}, undefined, { chatId: "main", extra: 1 }])
    await assert.rejects(rpcList(params), /chat/i, `4 ${JSON.stringify(params)}`);
  await assert.rejects(rpcList({ chatId: "main" }, "../escape"), /project/i);
  await assert.rejects(provided.rpc.list({ projectId: undefined, params: { chatId: "main" } }), /project/i);

  // 6 durable: a new plugin instance over the same directory sees the lists; files hold only valid JSON; no temp leftovers
  const reloaded = {};
  await plugin.register({
    name: plugin.name,
    stateDir,
    lib: { durable, typebox, value },
    provide: (caps) => Object.assign(reloaded, caps),
    projects: { load: (id) => ({ id }) },
  });
  assert.equal((await reloaded.rpc.list({ projectId: projectA, params: { chatId: "main" } })).tasks.length, 2);
  assert.deepEqual(readdirSync(stateDir).sort(), [`${projectA}.json`], "6 only the project file stays (project B never wrote)");
  const file = join(stateDir, `${projectA}.json`);
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before.slice(0, 20));
  await assert.rejects(list(), /unreadable/i, "6 a corrupt file is reported");
  await assert.rejects(call("tasks_add", { title: "must not overwrite" }), /unreadable/i);
  await assert.rejects(rpcList({ chatId: "main" }), /unreadable/i);
  assert.equal(readFileSync(file, "utf8"), before.slice(0, 20), "6 the corrupt file is never overwritten");
  writeFileSync(file, before);

  // 7 caps
  const caps = make(projectB);
  for (let i = 0; i < 50; i++) await call("tasks_add", { title: `open ${i}` }, 1, caps);
  await assert.rejects(call("tasks_add", { title: "one too many" }, 1, caps), /open tasks/i, "7 open tasks are capped");
  await assert.rejects(call("tasks_add", { title: "x".repeat(201) }, 1, caps), /./, "7 titles are capped");
  const open = (await list(1, caps)).tasks;
  for (const task of open.slice(0, 45)) await call("tasks_finish", { id: task.id }, 1, caps);
  for (let i = 0; i < 45; i++) await call("tasks_add", { title: `again ${i}` }, 1, caps);
  const listed = (await list(1, caps)).tasks;
  assert.ok(listed.length <= 100, `7 the oldest finished tasks are dropped: ${listed.length}`);
  assert.equal(listed.filter((task) => task.stage !== "done").length, 50, "7 open tasks are never dropped");
  // 7: finishing the oldest task after 50 newer ones are finished keeps it, and drops the oldest completion instead
  const cap = make("00000000-0000-4000-8000-00000000000c");
  const early = await call("tasks_add", { title: "early" }, 1, cap);
  const later = [];
  for (let i = 0; i < 50; i++) {
    later.push(await call("tasks_add", { title: `later ${i}` }, 1, cap));
    await call("tasks_finish", { id: later[i].id }, 1, cap);
  }
  await call("tasks_finish", { id: early.id, note: "last note" }, 1, cap);
  const kept = (await list(1, cap)).tasks;
  assert.equal(kept.length, 50, "7 finished tasks are capped");
  assert.equal(kept.at(-1).note, "last note", "7 the task just finished is kept");
  assert.ok(!kept.some((task) => task.id === later[0].id), "7 the oldest completion is dropped");

  // 12 14: attaching the same PR without a link keeps the known link
  const linked = await call("tasks_add", { title: "linked" });
  await call("tasks_attach_pr", { id: linked.id, provider: "arc", repository: "arcadia", number: "99", url: "https://example.test/99" });
  assert.equal(
    (await call("tasks_attach_pr", { id: linked.id, provider: "arc", repository: "arcadia", number: "99" })).pr.url,
    "https://example.test/99",
  );

  // 6: a file whose tasks have the wrong shape is unreadable too
  const shapeFile = join(stateDir, `${projectA}.json`);
  const good = readFileSync(shapeFile, "utf8");
  writeFileSync(shapeFile, JSON.stringify({ main: [{}] }));
  await assert.rejects(call("tasks_add", { title: "must not overwrite" }), /unreadable/i);
  assert.equal(readFileSync(shapeFile, "utf8"), JSON.stringify({ main: [{}] }));
  writeFileSync(shapeFile, good);

  console.log("tasks-plugin-unit: ok");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
