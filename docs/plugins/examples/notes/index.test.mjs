// Runs without a host: register gets a stand-in api with the libraries the host would pass in api.lib (same versions as the host).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import * as durable from "@earendil-works/pi-durable";
import * as typebox from "typebox";
import * as value from "typebox/value";
import plugin from "./index.mjs";

const projectId = "00000000-0000-4000-8000-000000000001";

async function load() {
  const stateDir = mkdtempSync(join(tmpdir(), "notes-"));
  const provided = {};
  await plugin.register({
    name: plugin.name,
    stateDir,
    lib: { durable, typebox, value },
    provide: (caps) => Object.assign(provided, caps),
  });
  return { provided, done: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test("RPC methods keep notes per project, with an agent policy for each", async () => {
  const { provided, done } = await load();
  try {
    assert.deepEqual(provided.rpcPolicy, { list: "read", add: "write", clear: "dangerous" });
    await provided.rpc.add({ projectId, params: { text: "ship on Friday" } });
    assert.equal((await provided.rpc.list({ projectId })).notes[0].text, "ship on Friday");
    await assert.rejects(provided.rpc.add({ projectId, params: { text: "" } }), /1 to 500/);
    await assert.rejects(provided.rpc.list({ projectId: undefined }), /project id/);
    assert.deepEqual(await provided.rpc.clear({ projectId }), { notes: [] });
    // The Settings panel's files: the host serves them as /plugins/notes/ui.js and ui.css.
    for (const path of [provided.web.script, provided.web.style]) assert.ok(isAbsolute(path) && existsSync(path), path);
  } finally {
    done();
  }
});

test("coordinator and worker tools read the same notes and refuse other conversations", async () => {
  const { provided, done } = await load();
  try {
    await provided.rpc.add({ projectId, params: { text: "use the staging bucket" } });
    const { tools, extension } = provided.coordinatorTools.create({ projectId, root: () => undefined, isCoordinator: (id) => id === 1 });
    assert.equal(extension.name, "projects.notes");
    const read = tools.find((tool) => tool.name === "notes_read");
    assert.match((await read.execute({}, { conversationId: 1 })).output[0].text, /staging bucket/);
    await assert.rejects(read.execute({}, { conversationId: 2 }), /coordinator-only/);

    const [workerRead] = provided.workerTools.create({ projectId, threadId: "thread-1", conversationId: 7 });
    assert.match((await workerRead.execute({}, { conversationId: 7 })).output[0].text, /staging bucket/);
    await assert.rejects(workerRead.execute({}, { conversationId: 8 }), /another worker/);
  } finally {
    done();
  }
});
