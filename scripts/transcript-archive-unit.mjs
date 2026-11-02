// Contracts of the transcript reader, the read-only archive and binary results, on a tiny fixture archive (no real host state).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listArchiveProjects, openArchiveProject } from "../src/archive-reader.ts";
import { binaryResult } from "../src/binary-results.ts";
import { parse, Request } from "../src/state.ts";

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
console.log("transcript-archive-unit: ok");
