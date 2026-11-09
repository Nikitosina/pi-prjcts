// Contracts of the transcript reader, the read-only archive and binary results, on a tiny fixture archive (no real host state).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listArchiveProjects, openArchiveProject } from "../src/archive-reader.ts";
import { binaryResult } from "../src/binary-results.ts";
import { parse, Request } from "../src/state.ts";
import { coordinatorStorageSource, readTranscriptPage, readTranscriptText } from "../src/transcript-reader.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

// Exact submission attribution, not text matching. The source reads one bounded submission page.
{
  const rows = [
    { id: 50, kind: "projects.owner-input", model: [{ role: "user", content: "[Owner-local event example]\nquoted owner text" }] },
    { id: 45, kind: "projects.internal-input", model: [{ role: "user", content: "native event" }] },
    { id: 40, kind: "pi.user", model: [{ role: "user", content: "legacy owner" }] },
    { id: 30, kind: "pi.user", model: [{ role: "user", content: "automated input" }] },
    { id: 20, kind: "pi.user", model: [{ role: "user", content: "unknown old input" }] },
    { id: 10, kind: "pi.assistant", model: [{ role: "assistant", content: "answer" }] },
  ];
  const scans = [];
  const storage = {
    scanEntries: async () => ({ items: rows }),
    entry: async () => undefined,
    scanSubmissions: async (query, limit, cursor) => {
      scans.push({ query, limit, cursor });
      return {
        items: [
          { id: 39, conversationId: 7, type: "input", status: "done", entry: 40, answer: 41 },
          { id: 29, conversationId: 7, type: "input", status: "done", entry: 30, answer: 31, requestId: "report:9" },
          { id: 19, conversationId: 8, type: "input", status: "done", entry: 20, answer: 21 },
        ],
        next: { after: 19, order: "descending" },
      };
    },
  };
  const page = await readTranscriptPage(coordinatorStorageSource(storage, BACKGROUND_CONTEXT, [39]), 7);
  assert.deepEqual(
    page.items.map((item) => [item.entryId, item.origin]),
    [
      [10, undefined],
      [20, undefined],
      [30, "internal"],
      [40, "owner"],
      [45, "internal"],
      [50, "owner"],
    ],
  );
  const native = await readTranscriptPage(
    { newest: () => rows.filter((row) => row.kind.startsWith("projects.")), entry: () => undefined },
    7,
    { display: (_role, text) => `display:${text}` },
  );
  assert.deepEqual(
    native.items.map((item) => item.origin),
    ["internal", "owner"],
  );
  assert.ok(
    native.items.every((item) => item.text.startsWith("display:")),
    "display rewriting preserves native origins",
  );
  assert.equal(scans.length, 1, "no whole-history provenance scans");
  assert.equal(scans[0].query.conversationId, 7);
  assert.equal(scans[0].limit, 200);
  assert.equal(scans[0].cursor, undefined, "backend-owned cursors are never synthesized from entry IDs");
}

// Report archives are non-model entries but remain readable through the normal transcript interfaces.
{
  const text = `[worker 11111111-1111-4111-8111-111111111111 checkpoint: Held]\n${"evidence ".repeat(1000)}END-PROOF`;
  const row = { id: 60, kind: "projects.agent-report", data: { text, at: 1700000000000 } };
  const source = { newest: () => [row], entry: (_conversation, id) => (id === row.id ? row : undefined) };
  const page = await readTranscriptPage(source, 7);
  assert.equal(page.items.length, 1, "retained reports remain visible in worker history");
  const item = page.items[0];
  assert.equal(item.origin, "internal");
  assert.equal(item.at, 1700000000000);
  assert.ok(item.truncated && item.text.length <= 4000);
  const full = await readTranscriptText(source, 7, item.ref, { limit: 20000 });
  assert.equal(full.text, text, "full evidence survives the bounded preview");
  await assert.rejects(readTranscriptText(source, 7, "60.1"), /not found/);
  assert.deepEqual((await readTranscriptPage({ ...source, newest: () => [{ ...row, data: { text: 42 } }] }, 7)).items, []);
}

// Owner views read whole messages; agent reads keep the bounded preview.
{
  const long = `ANSWER-START ${"word ".repeat(2000)}ANSWER-END`;
  const rows = [{ id: 70, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: long }] }] }];
  const source = { newest: () => rows, entry: () => undefined };
  const [preview] = (await readTranscriptPage(source, 7)).items;
  assert.ok(preview.truncated && preview.text.length <= 4000, "agent pages stay bounded");
  const [full] = (await readTranscriptPage(source, 7, { messageText: "full" })).items;
  assert.equal(full.text, long, "owner pages carry the whole answer");
  assert.equal(full.truncated, false);
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const home = mkdtempSync(join(tmpdir(), "archive-"));
const project = "11111111-1111-4111-8111-111111111111";
mkdirSync(join(home, project));
writeFileSync(join(home, project, "project.json"), JSON.stringify({ name: "Old" }));
const childThread = `${project}/2`;
for (const action of ["thread-history", "transcript-text", "transcript-image"]) {
  const request = { action, id: project, threadId: childThread };
  if (action === "transcript-text") request.ref = "1.1";
  if (action === "transcript-image") request.ref = "1.1.0";
  assert.equal(parse(Request, request).threadId, childThread, `${action} accepts a Job child reference`);
}

const db = new DatabaseSync(join(home, project, "durable.sqlite"));
db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_id INTEGER NOT NULL);
CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL)`);
const add = (id, conversation, record) =>
  db.prepare("INSERT INTO entries VALUES (?, ?, NULL, 1, ?)").run(id, conversation, JSON.stringify({ id, ...record }));
for (let i = 1; i <= 9; i++)
  add(i, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: `message ${i}` }], timestamp: i }] });
add(10, 1, { kind: "pi.compaction", head: 8, model: [{ role: "user", content: "summary", timestamp: 10 }] });
add(11, 1, {
  kind: "pi.tool-result",
  model: [
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "shot",
      content: [
        { type: "text", text: "x".repeat(50_000) },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    },
  ],
});
// The side chat: 40 long messages, so an explicit limit of 100 entries is larger than one bounded page.
const long = (i) => `long ${i} ${"y".repeat(3000)}`;
for (let i = 100; i < 140; i++)
  add(i, 2, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: long(i) }], timestamp: i }] });
db.prepare("INSERT INTO documents VALUES (1, ?, 1)").run(JSON.stringify("projects.chats"));
db.prepare("INSERT INTO document_revisions VALUES (1, 1, 'base', ?)").run(
  JSON.stringify({ mainTitle: "Start", chats: [{ id: "c", conversationId: 2, title: "Side" }] }),
);
db.close();

assert.deepEqual(listArchiveProjects(home), [{ projectId: project, name: "Old", bytes: listArchiveProjects(home)[0].bytes }]);
const archive = openArchiveProject(home, project);
assert.deepEqual(
  archive.chats().map((chat) => [chat.title, chat.conversationId]),
  [
    ["Start", 1],
    ["Side", 2],
  ],
);

// Newest page first with a cursor; the compaction marker is an item; the huge text and the image are bounded or by reference.
const first = await archive.page(1, { limit: 4 });
assert.deepEqual(
  first.items.map((item) => item.kind),
  ["message", "message", "compaction", "tool-result"],
);
assert.equal(first.before, 8);
const result = first.items.at(-1);
assert.ok(result.truncated && result.preview.length < 5000 && result.textChars === 50_000);
assert.ok(!JSON.stringify(first).includes(png.toString("base64")));
assert.deepEqual((await archive.image(1, result.images[0].ref)).bytes, png);
const older = await archive.page(1, { before: first.before, limit: 50 });
assert.deepEqual([older.items.length, older.before], [7, null]);

// Reading leaves the archive folder as it was: no journal, WAL or shm files appear.
assert.deepEqual(readdirSync(join(home, project)).sort(), ["durable.sqlite", "project.json"]);
archive.close();

// A binary result keeps the full bytes as an artifact and returns a reference plus a model copy that is not the original.
const scope = { controlRoot: home, scope: project };
const blocks = await binaryResult(scope, { bytes: png, label: "shot" });
assert.match(blocks[0].text, /artifact:11111111-1111-4111-8111-111111111111\/binary\/[a-f0-9]{24}\.png/);
assert.equal(readdirSync(join(home, "artifacts", project, "binary")).length, 1);
await binaryResult(scope, { bytes: png, label: "again" });
assert.equal(readdirSync(join(home, "artifacts", project, "binary")).length, 1);

// The coordinator tools read this project's archive only, refuse workers, other conversations, and answer plainly without an archive.
const live = mkdtempSync(join(tmpdir(), "archive-live-"));
process.env.PI_PROJECTS_HOME = live;
writeFileSync(join(live, "archive.json"), JSON.stringify({ home }));
const { coordinatorArchiveTools } = await import("../src/archive-tools.ts");
const tools = (projectId) => coordinatorArchiveTools({ projectId, isCoordinator: (id) => id === 1 }).tools;
const call = async (set, name, args, conversationId = 1) =>
  (await set.find((tool) => tool.name === name).execute(args, { conversationId })).output[0].text;
const mine = tools(project);
const listed = JSON.parse(await call(mine, "projects_archive_list", { query: "side" }));
assert.deepEqual(
  listed.items.map((item) => item.conversationId),
  [2],
);
const read = JSON.parse(await call(mine, "projects_archive_read", { conversationId: 1 }));
assert.match(read.note, /Untrusted/);
assert.ok(read.items.length && read.before);
await assert.rejects(call(mine, "projects_archive_read", { conversationId: 99 }), /Unknown archived conversation/);
await assert.rejects(call(mine, "projects_archive_list", {}, 7), /coordinator-only/);
assert.equal(await call(tools("22222222-2222-4222-8222-222222222222"), "projects_archive_list", {}), "No archive for this project.");
// An explicit limit reads more entries per page, yet each answer stays within the expanded budget, and following `before` visits every entry once.
const EXPANDED = 16 * 1024;
const pagesOf = async (read) => {
  const seen = [];
  let before,
    pages = 0;
  do {
    const text = await read(before);
    assert.ok(Buffer.byteLength(text) <= EXPANDED, `explicit-limit page is ${Buffer.byteLength(text)} bytes`);
    const page = JSON.parse(text);
    seen.push(...new Set(page.items.map((item) => item.entryId)));
    before = page.before;
    pages++;
  } while (before);
  return { seen: seen.sort((a, b) => a - b), pages };
};
const all = Array.from({ length: 40 }, (_, i) => 100 + i);
const archived = await pagesOf((before) =>
  call(mine, "projects_archive_read", { conversationId: 2, limit: 100, ...(before ? { before } : {}) }),
);
assert.deepEqual(archived.seen, all);
assert.ok(archived.pages > 1);
const { coordinatorJobReadTools } = await import("../src/job-read-tools.ts");
const rows = all.map((id) => ({ id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: long(id) }] }] })).reverse();
const source = {
  newest: (_c, before, limit) => rows.filter((row) => before === undefined || row.id < before).slice(0, limit),
  entry: () => undefined,
};
const jobTools = coordinatorJobReadTools({
  projectId: project,
  root: () => ({}),
  runtime: () => ({ workerRead: (_thread, options) => readTranscriptPage(source, 5, options) }),
  isCoordinator: () => true,
  catalog: () => [],
}).tools;
const thread = "33333333-3333-4333-8333-333333333333";
const worker = await pagesOf((before) =>
  call(jobTools, "projects_worker_read", { threadId: thread, limit: 100, ...(before ? { before } : {}) }),
);
assert.deepEqual(worker.seen, all);
assert.ok(worker.pages > 1);
// N11 Scripts get the value the model reads, and it matches the declared schema.
const { Compile } = await import("typebox/compile");
const typed = async (set, name, args) => {
  const tool = set.find((item) => item.name === name),
    result = await tool.execute(args, { conversationId: 1 });
  assert.ok(tool.structuredOutputSchema, `${name} declares no structuredOutputSchema`);
  assert.deepEqual(result.structuredOutput, JSON.parse(result.output[0].text), `${name} structuredOutput differs from its text`);
  assert.ok(Compile(tool.structuredOutputSchema).Check(result.structuredOutput), `${name} structuredOutput breaks its schema`);
};
await typed(mine, "projects_archive_read", { conversationId: 2 });
await typed(mine, "projects_archive_read", { conversationId: 1, ref: read.items.find((item) => item.ref).ref });
await typed(jobTools, "projects_worker_read", { threadId: thread });
console.log("transcript-archive-unit: ok");
