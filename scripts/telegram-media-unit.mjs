import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
  openSync,
  ftruncateSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTelegram, TelegramRequestNotSentError, redactTelegramError } from "../src/telegram.ts";
import { loadTelegramMedia, extractTelegramMedia, telegramAlbumForm } from "../src/telegram-media.ts";
import { image, video } from "./telegram-media-fixtures.mjs";
import { htmlToPlain, splitTelegramCaption, splitTelegramHtml } from "../src/telegram-html.ts";

const root = mkdtempSync(join(tmpdir(), "telegram-media-"));
process.env.PI_PROJECTS_HOME = root;
process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = "60000";
const project = randomUUID(),
  thread = randomUUID(),
  other = randomUUID();
const dir = join(root, project, "artifacts", thread);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(root, project, "project.json"),
  JSON.stringify({
    version: 1,
    id: project,
    name: "Test",
    runtime: "durable",
    cwd: root,
    objective: "",
    createdAt: new Date().toISOString(),
    model: "test",
    models: {},
    phase: "ready",
    problem: null,
  }),
);
writeFileSync(join(dir, "demo.png"), image);
writeFileSync(join(dir, "Screenshot (1 (copy)).png"), image);
writeFileSync(join(dir, "demo.mp4"), video);
writeFileSync(join(dir, "demo.webm"), video);
writeFileSync(join(dir, "PLAN.html"), "<!doctype html><title>Plan</title>");
mkdirSync(join(root, project, "artifacts", other));
writeFileSync(join(root, project, "artifacts", other, "demo.png"), image);
symlinkSync(join(dir, "demo.png"), join(dir, "link.png"));
const large = openSync(join(dir, "large.png"), "w");
ftruncateSync(large, 50_000_001);
closeSync(large);
const medium = openSync(join(dir, "medium.png"), "w");
ftruncateSync(medium, 10_000_001);
closeSync(medium);
const ref = (path) => `artifact:${thread}/${path}`;
const chatScope = randomUUID(),
  jobScope = randomUUID(),
  foreignScope = randomUUID();
for (const scope of [chatScope, jobScope, foreignScope]) {
  mkdirSync(join(root, project, "artifacts", scope));
  writeFileSync(join(root, project, "artifacts", scope, "shot.png"), image);
}
writeFileSync(join(root, project, "artifacts", jobScope, "plan.html"), "<!doctype html><title>Job</title>");
mkdirSync(join(dir, "batch"));
writeFileSync(join(dir, "empty.png"), "");
const scopedRef = (scope, path) => `artifact:${scope}/${path}`;
assert.equal(loadTelegramMedia(join(root, project), ref("medium.png")).method, "sendDocument");
for (const path of ["../project.json", "missing.png", "link.png", "large.png", "%2e%2e/no", "/etc/passwd", "a\\b"])
  assert.throws(() => loadTelegramMedia(join(root, project), ref(path)));
assert.equal(extractTelegramMedia("`![example](x)`\n```\n![code](y)\n```").media.length, 0);
assert.equal(extractTelegramMedia("\uE0000\uE001").markdown, "0");
for (const fence of ["```", "~~~"]) assert.equal(extractTelegramMedia(`${fence}\n![example](${ref("demo.png")})`).media.length, 0);
const documentLink = `[Plan](${ref("PLAN.html")})`;
assert.equal(extractTelegramMedia(`Before ${documentLink} after`).media.length, 1);
assert.equal(extractTelegramMedia(`[Copy](${ref("Screenshot (1 (copy)).png")})`).media[0].ref, ref("Screenshot (1 (copy)).png"));
for (const text of [
  `\`${documentLink}\``,
  "```\n" + documentLink + "\n```",
  "~~~\n" + documentLink,
  "[External](https://example.com/report.pdf)",
  "[Local](/etc/passwd)",
])
  assert.equal(extractTelegramMedia(text).media.length, 0);
const fakeCredential = "999999999:FAKE_CREDENTIAL_FOR_REDACTION_ONLY";
assert.equal(
  redactTelegramError(
    `offset 17; https://api.telegram.org/bot${fakeCredential}/sendMediaGroup; encoded=${encodeURIComponent(fakeCredential)}; destination 1234567890; "chat_id":-1009876543210`,
    fakeCredential,
    [1234567890],
  ),
  'offset 17; https://api.telegram.org/bot[token]/sendMediaGroup; encoded=[token]; destination [chat]; "chat_id":[chat]',
);
let fault = null,
  gate = null,
  updates = [],
  sends = [],
  attempts = [],
  id = 0,
  topicId = 900,
  chatList = [],
  dispatchHook = null,
  chatsHook = null,
  meTopics = null,
  topicNames = new Map();
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const method = req.url.split("/").at(-1);
  const bytes = Buffer.concat(chunks);
  const multipart = req.headers["content-type"]?.startsWith("multipart/form-data");
  let input;
  if (multipart) {
    const data = await new Response(bytes, { headers: { "content-type": req.headers["content-type"] } }).formData();
    input = Object.fromEntries(data);
    if (input.caption) {
      input.caption = input.caption.replaceAll("\r\n", "\n");
      assert(Array.from(htmlToPlain(input.caption)).length <= 1024);
    }
    if (method === "sendMediaGroup") {
      input.media = JSON.parse(input.media);
      input.files = await Promise.all(
        input.media.map(async (item) => {
          const file = input[item.media.slice("attach://".length)];
          return { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name };
        }),
      );
    } else {
      const file = input.photo ?? input.video ?? input.document;
      input.file = { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name };
    }
  } else input = JSON.parse(bytes.toString());
  const reply = (value) => {
    res.writeHead(value.ok ? 200 : (value.error_code ?? 500), { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (method === "getUpdates") {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return reply({ ok: true, result: updates.splice(0) });
  }
  if (method === "getMe" && meTopics !== null) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return reply({ ok: true, result: { id: 1, has_topics_enabled: meTopics } });
  }
  attempts.push({ method, input });
  // TDLib check_message_group_message_contents requires uniform placement even on items without captions.
  if (method === "sendMediaGroup" && new Set(input.media.map((item) => item.show_caption_above_media ?? false)).size > 1)
    return reply({
      ok: false,
      error_code: 400,
      description: "Bad Request: parameter show_caption_above_media must be the same for all messages",
    });
  if (fault?.method === method) {
    const { code, description = "test rejection", next = null, run } = fault;
    fault = next;
    await run?.();
    if (code === 0) return req.socket.destroy();
    if (code === 200) return reply({ ok: true, result: [] });
    return reply({ ok: false, error_code: code, description });
  }
  if (gate?.method === method) {
    const { run } = gate;
    gate = null;
    await run();
  }
  if (method === "createForumTopic") {
    topicNames.set(topicId + 1, input.name);
    return reply({ ok: true, result: { message_thread_id: ++topicId } });
  }
  if (method === "editForumTopic") {
    topicNames.set(input.message_thread_id, input.name);
    return reply({ ok: true, result: true });
  }
  const message_ids = Array.from({ length: method === "sendMediaGroup" ? input.media.length : 1 }, () => ++id);
  sends.push({ method, input, message_id: message_ids[0], message_ids });
  reply({
    ok: true,
    result: method === "sendMediaGroup" ? message_ids.map((message_id) => ({ message_id })) : { message_id: message_ids[0] },
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.PI_PROJECTS_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
const statePath = join(root, "telegram.json");
const seed = () =>
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      token: null,
      bot: null,
      owner: { chatId: 1, name: "Test" },
      pairing: null,
      offset: 0,
      sentSeq: 0,
      route: null,
      keys: {},
      messages: {},
      lastError: null,
      lastPollAt: null,
    }),
  );
let notices = [],
  bridge;
function start(receiveUpdates = false) {
  const state = JSON.parse(readFileSync(statePath));
  state.token = "fake-test-only";
  writeFileSync(statePath, JSON.stringify(state));
  bridge = startTelegram({
    receiveUpdates,
    dispatch: async () => ({}),
    artifactScopes: async (projectId) => {
      assert.equal(projectId, project);
      await dispatchHook?.();
      return new Set([thread, chatScope, jobScope]);
    },
    chats: async () => {
      await chatsHook?.();
      return chatList.map((chat) => ({ ...chat }));
    },
    notifier: { seq: () => notices.length, feed: (after) => ({ items: notices.filter((n) => n.seq > after) }) },
    report: () => {},
  });
}
const notice = (seq, text) => ({
  seq,
  at: 0,
  projectId: project,
  project: "Test",
  chatId: "main",
  chat: "Main",
  kind: "result",
  title: "Finished",
  text,
});
const reset = (text) => {
  bridge?.close();
  seed();
  sends = [];
  attempts = [];
  fault = null;
  gate = null;
  updates = [];
  chatList = [];
  dispatchHook = null;
  chatsHook = null;
  meTopics = null;
  topicNames = new Map();
  notices = [notice(1, text)];
};
const mapped = (expected = { projectId: project, chatId: "main" }) => {
  const mappings = JSON.parse(readFileSync(statePath)).messages;
  for (const send of sends) for (const id of send.message_ids) assert.deepEqual(mappings[id], expected);
};
try {
  const mixedPlacementForm = telegramAlbumForm(
    [loadTelegramMedia(join(root, project), ref("demo.png")), loadTelegramMedia(join(root, project), ref("demo.mp4"))],
    1,
    "<b>Test · Main</b>\nDemo",
  );
  const mixedPlacementItems = JSON.parse(mixedPlacementForm.body.get("media"));
  delete mixedPlacementItems[1].show_caption_above_media;
  mixedPlacementForm.body.set("media", JSON.stringify(mixedPlacementItems));
  const rejected = await fetch(`${process.env.PI_PROJECTS_TELEGRAM_API}/botfake-contract-only/sendMediaGroup`, {
    method: "POST",
    body: mixedPlacementForm.body,
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).description, "Bad Request: parameter show_caption_above_media must be the same for all messages");
  assert.equal(sends.length, 0);

  reset(`Before **bold** ![Image caption](${ref("demo.png")}) after`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto"],
  );
  assert.match(sends[0].input.caption, /^<b>Test · Main<\/b>\nFinished\n\nBefore <b>bold<\/b> Image caption after/);
  assert.match(sends[0].input.caption, /Reply to this message to write to this chat/);
  assert.equal(sends[0].input.parse_mode, "HTML");
  assert.equal(sends[0].input.show_caption_above_media, "true");
  assert.equal(sends[0].input.reply_parameters, undefined);
  assert.deepEqual(sends[0].input.file.bytes, image);
  assert.equal(sends[0].input.file.mime, "image/png");
  mapped();
  await bridge.flush();
  assert.equal(sends.length, 1);
  bridge.close();
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);

  reset(`Before ![Video caption](${ref("demo.mp4")}) after`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendVideo"],
  );
  assert.deepEqual(sends[0].input.file.bytes, video);
  assert.equal(sends[0].input.file.mime, "video/mp4");
  mapped();

  reset(`Question ![Image](${ref("demo.png")})`);
  notices[0] = { ...notices[0], kind: "question", entryId: "question-id", choices: ["yes", "no"] };
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert.equal(JSON.parse(sends[0].input.reply_markup).inline_keyboard.length, 2);
  assert.match(sends[0].input.caption, /Tap an answer/);
  mapped({ projectId: project, chatId: "main", entryId: "question-id" });

  reset(`Approval ![Attachment](${ref("Screenshot (1 (copy)).png")})`);
  notices[0] = { ...notices[0], kind: "approval", operationId: randomUUID(), fingerprint: "a".repeat(64) };
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto"],
  );
  assert.equal(sends[0].input.reply_markup, undefined);
  mapped();

  reset(`![Fallback](${ref("demo.png")})`);
  fault = { method: "sendPhoto", code: 400 };
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendDocument"],
  );
  assert(sends[0].input.file.bytes.equals(image));
  assert.match(sends[0].input.caption, /Fallback/);

  reset(`Before ![Photo](${ref("demo.png")}) between ![Video](${ref("demo.mp4")}) after`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup"],
  );
  assert.deepEqual(
    sends[0].input.media.map((m) => m.type),
    ["photo", "video"],
  );
  assert.match(sends[0].input.media[0].caption, /Before Photo between Video after/);
  assert(sends[0].input.media.every((item) => item.show_caption_above_media === true));
  assert.equal(sends[0].input.media[0].parse_mode, "HTML");
  assert.equal(sends[0].input.media[1].caption, undefined);
  assert.deepEqual(
    sends[0].input.files.map((f) => f.bytes),
    [image, video],
  );
  assert.deepEqual(
    sends[0].input.files.map((f) => f.mime),
    ["image/png", "video/mp4"],
  );
  mapped();

  reset(Array.from({ length: 11 }, (_, i) => `![${i}](${ref("demo.png")})`).join(" "));
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup", "sendPhoto"],
  );
  assert.equal(sends[0].input.media.length, 10);
  assert.equal(sends[1].input.caption, "");
  mapped();

  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  fault = { method: "sendMediaGroup", code: 400 };
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup"],
  );
  assert(sends[0].input.media.every((m) => m.type === "document" && m.show_caption_above_media === undefined));
  mapped();

  const apiDescription =
    "Bad Request: parameter show_caption_above_media must be the same for all messages; token=fake-test-only; chat_id=1; chat_id=-1009876543210; byte offset 17";
  const sanitizedDescription =
    "Bad Request: parameter show_caption_above_media must be the same for all messages; token=[token]; chat_id=[chat]; chat_id=[chat]; byte offset 17";
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  fault = {
    method: "sendMediaGroup",
    code: 400,
    description: apiDescription,
    next: { method: "sendMediaGroup", code: 400, description: "Bad Request: second rejection" },
  };
  start();
  await bridge.flush();
  bridge.close();
  const savedErrors = JSON.parse(readFileSync(statePath)).deliveryErrors;
  assert.equal(savedErrors.length, 2);
  assert.equal(savedErrors[0].description, sanitizedDescription);
  assert.deepEqual(
    savedErrors.map((e) => [e.kind, e.method, e.httpStatus, e.code, e.descriptionProvided]),
    [
      ["api", "sendMediaGroup", 400, 400, true],
      ["api", "sendMediaGroup", 400, 400, true],
    ],
  );
  assert.equal(savedErrors[1].description, "Bad Request: second rejection");
  assert(!JSON.stringify(savedErrors).includes("fake-test-only"));
  assert(!JSON.stringify(savedErrors).includes("-1009876543210"));
  start();
  assert.deepEqual((await bridge.snapshot()).deliveryErrors, savedErrors);

  reset(`Before ![Photo](${ref("demo.png")}) middle ![WebM](${ref("demo.webm")}) after`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto", "sendDocument"],
  );
  assert.match(sends[0].input.caption, /Before Photo middle WebM after/);
  assert.equal(sends[1].input.caption, "");
  mapped();

  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  notices[0] = { ...notices[0], kind: "approval", operationId: randomUUID(), fingerprint: "a".repeat(64) };
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup"],
  );
  mapped();

  reset("Metadata marker test");
  notices[0].project = "\uE0000\uE001";
  notices[0].chat = "\uE00099\uE001";
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);

  reset(
    `[Traversal](${ref("../project.json")}) [Unknown](artifact:${other}/demo.png) [Missing](${ref("missing.png")}) [Large](${ref("large.png")}) ![URL](http://127.0.0.1/private)`,
  );
  start();
  await bridge.flush();
  assert.equal(sends.length, 5);
  assert(sends.every((s) => s.method === "sendMessage" && /Attachment not sent: /.test(s.input.text)));
  assert(sends.every((s) => !s.input.text.includes("!Traversal")));

  // 85-88: scopes of the project's chats and Jobs are sent; refusals say why, typed, with no path.
  reset(`![Chat shot](${scopedRef(chatScope, "shot.png")}) ![Job shot](${scopedRef(jobScope, "shot.png")})`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup"],
    "85/86 chat and Job scope attachments are sent as media",
  );
  assert.equal(sends[0].input.files.length, 2);
  reset(`[Job plan](${scopedRef(jobScope, "plan.html")})`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendDocument"],
    "86 a Job-scoped file is sent",
  );

  reset(
    [
      `[Foreign](${scopedRef(foreignScope, "shot.png")})`,
      `[Dir](${ref("batch")})`,
      `[Missing](${ref("missing.png")})`,
      `[Empty](${ref("empty.png")})`,
      `[Large](${ref("large.png")})`,
      `[Bad](${ref("../project.json")})`,
    ].join(" "),
  );
  start();
  await bridge.flush();
  const reasons = ["unauthorized", "not-a-file", "not-found", "empty", "too-large", "invalid"],
    wording = [/not part of this project/, /not a regular file/, /not found/, /empty/, /50 MB/, /invalid/];
  assert.equal(sends.length, 6);
  sends.forEach((s, i) => {
    assert.equal(s.method, "sendMessage");
    assert.match(s.input.text, wording[i], `88 reason text ${reasons[i]}`);
    assert(!s.input.text.includes(root) && !s.input.text.includes("/artifacts/"), "88 no file system path in the text");
  });
  const refused = JSON.parse(readFileSync(statePath)).deliveryErrors.filter((e) => e.kind === "attachment");
  assert.deepEqual(
    refused.map((e) => e.reason),
    reasons,
    "88 every refusal is recorded once with its typed reason",
  );
  assert(refused.every((e) => !JSON.stringify(e).includes(root)));

  // 89: an album with one refused item falls back to single files and records only the refused one.
  reset(`![A](${ref("demo.png")}) ![B](${ref("batch")}) ![C](${scopedRef(foreignScope, "shot.png")})`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto", "sendMessage", "sendMessage"],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(statePath))
      .deliveryErrors.filter((e) => e.kind === "attachment")
      .map((e) => e.reason),
    ["not-a-file", "unauthorized"],
  );

  reset(`${"x".repeat(960)} ![](${ref("demo.png")})`);
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert(sends[0].input.caption.includes("x".repeat(960)));
  assert.match(sends[0].input.caption, /Reply to chat/);

  for (const body of ["🟦".repeat(600), "**" + "&".repeat(900) + "**"]) {
    reset(`${body} ![](${ref("demo.png")})`);
    start();
    await bridge.flush();
    assert.deepEqual(
      sends.map((s) => s.method),
      ["sendPhoto"],
    );
  }

  const exactBody = "x".repeat(1024 - Array.from("Test · Main\nFinished\n\n \n\nReply to this message to write to this chat.").length);
  reset(`${exactBody} ![](${ref("demo.png")})`);
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert.equal(Array.from(htmlToPlain(sends[0].input.caption)).length, 1024);

  const body = "long text ".repeat(700) + "🟦" + "Z".repeat(76);
  reset(`${body} ![Image](${ref("demo.png")}) tail`);
  start();
  await bridge.flush();
  assert.equal(sends[0].method, "sendPhoto");
  const all = [sends[0].input.caption, ...sends.slice(1).map((s) => s.input.text)];
  assert.equal(all.map(htmlToPlain).join(""), `Test · Main\nFinished\n\n${body} Image tail\n\nReply to chat.`);
  assert(Array.from(htmlToPlain(all[0])).length <= 1024);
  assert(all.slice(1).every((t) => htmlToPlain(t).length <= 4096));
  assert.equal(sends.length, 1 + Math.ceil((all.map(htmlToPlain).join("").length - 1024) / 4096));
  for (const send of sends.slice(1)) assert.equal(send.input.reply_parameters.message_id, sends[0].message_id);
  mapped();
  const unicode = splitTelegramCaption("<b>" + "x".repeat(1023) + "🟦&amp;</b>");
  assert.equal(Array.from(htmlToPlain(unicode[0])).length, 1024);
  assert.equal(unicode.map(htmlToPlain).join(""), "x".repeat(1023) + "🟦&");
  assert.equal(splitTelegramCaption("<b>" + "&amp;".repeat(1024) + "</b>").length, 1);
  // A text part never cuts an emoji in half.
  for (const pad of [0, 1]) {
    const line = "x".repeat(pad) + "🟦".repeat(3000),
      parts = splitTelegramHtml(line);
    assert(parts.length > 1 && parts.every((part) => part.length <= 4096 && part.isWellFormed()));
    assert.equal(parts.join(""), line);
  }
  // One code unit of room left before a long emoji line.
  const tight = splitTelegramHtml("x".repeat(4088) + "<b>" + "🟦".repeat(3000) + "</b>");
  assert(tight.every((part) => part.length <= 4096 && part.isWellFormed()));
  assert.equal(tight.map(htmlToPlain).join(""), "x".repeat(4088) + "🟦".repeat(3000));
  assert(splitTelegramHtml("\n".repeat(4096) + "🟦".repeat(3000)).every((part) => part.length <= 4096 && part.isWellFormed()));

  reset(`${"a".repeat(1800)} ![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")}) end`);
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup", "sendMessage"],
  );
  assert.equal((sends[0].input.media[0].caption + sends[1].input.text).match(/<b>Test · Main/g).length, 1);
  mapped();

  reset(`First ${documentLink} Last`);
  notices.push(notice(2, "Next notice"));
  fault = { method: "sendDocument", code: 429 };
  start();
  await bridge.flush();
  assert.equal(sends.length, 0);
  bridge.close();
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendDocument", "sendMessage"],
  );
  assert.equal(sends[0].input.file.name, "PLAN.html");
  assert.deepEqual(sends[0].input.file.bytes, readFileSync(join(dir, "PLAN.html")));
  assert.equal(sends.at(-1).input.reply_parameters, undefined);

  reset(`${"long ".repeat(500)} ![](${ref("demo.png")}) end`);
  fault = { method: "sendMessage", code: 429 };
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);
  bridge.close();
  start();
  await bridge.flush();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].input.reply_parameters.message_id, sends[0].message_id);

  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  notices.push(notice(2, "Next notice"));
  fault = { method: "sendMediaGroup", code: 429 };
  start();
  await bridge.flush();
  assert.equal(sends.length, 0);
  bridge.close();
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup", "sendMessage"],
  );
  mapped();

  writeFileSync(join(dir, "gone.png"), image);
  reset(`Before ![First](${ref("demo.png")}) ![Gone](${ref("gone.png")}) ![Last](${ref("demo.mp4")}) after`);
  fault = { method: "sendMediaGroup", code: 429 };
  start();
  await bridge.flush();
  assert.equal(sends.length, 0);
  bridge.close();
  unlinkSync(join(dir, "gone.png"));
  fault = { method: "sendVideo", code: 429 };
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto", "sendMessage"],
  );
  assert.match(sends[1].input.text, /not found/);
  bridge.close();
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto", "sendMessage", "sendVideo"],
  );
  assert.deepEqual(sends[2].input.file.bytes, video);
  assert.match(sends[0].input.caption, /Before First Gone Last after/);
  mapped();

  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  fault = { method: "sendMediaGroup", code: 400 };
  const forward = globalThis.fetch;
  let forwarded = false,
    guardedCalls = 0;
  const oldBackoff = process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS;
  process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = "1";
  globalThis.fetch = async (url, init) => {
    guardedCalls++;
    if (forwarded)
      throw new TelegramRequestNotSentError("One-write guard: follow-up NOT transmitted after confirmed 400 rejection; fake-test-only");
    forwarded = true;
    return forward(url, init);
  };
  try {
    start();
    await bridge.flush();
    const state = JSON.parse(readFileSync(statePath));
    assert.equal(attempts.length, 1);
    assert.equal(sends.length, 0);
    assert.equal(state.sentPart.pendingMedia, undefined);
    assert.match(state.lastError, /NOT transmitted after confirmed 400/);
    assert.deepEqual(
      state.deliveryErrors.map((e) => e.kind),
      ["api", "not-sent"],
    );
    assert.equal(state.deliveryErrors[0].description, "test rejection");
    assert(!state.lastError.includes("delivery is uncertain"));
    assert.equal(state.sentSeq, 0);
    assert(!state.lastError.includes("fake-test-only"));
    assert(state.lastError.includes("[token]"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(guardedCalls, 2);
  } finally {
    bridge.close();
    globalThis.fetch = forward;
    process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = oldBackoff;
  }

  for (const code of [0, 200]) {
    reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
    notices.push(notice(2, "Must not wait"));
    fault = { method: "sendMediaGroup", code };
    start();
    await bridge.flush();
    assert.deepEqual(
      sends.map((s) => s.method),
      ["sendMessage"],
    );
    assert.match(sends[0].input.text, /Must not wait/);
    const before = attempts.length;
    let state = JSON.parse(readFileSync(statePath));
    assert.equal(state.sentSeq, 2);
    assert.equal(state.sentPart, undefined);
    assert.equal(state.held.length, 1);
    assert.equal(state.held[0].seq, 1);
    assert.equal(state.held[0].sentPart.parts, 0);
    assert.equal(state.held[0].sentPart.plan[0].kind, "album");
    assert.equal(state.deliveryErrors.at(-1).kind, code === 0 ? "network" : "incomplete-response");
    assert.deepEqual(
      (await bridge.snapshot()).held.map((item) => ({ seq: item.seq, remainingParts: item.remainingParts })),
      [{ seq: 1, remainingParts: 1 }],
    );
    await bridge.flush();
    bridge.close();
    start();
    await bridge.flush();
    assert.equal(attempts.length, before);
    assert.equal(JSON.parse(readFileSync(statePath)).held.length, 1);
    notices.push(notice(3, "Later notice"));
    await bridge.flush();
    assert.deepEqual(
      sends.map((s) => s.method),
      ["sendMessage", "sendMessage"],
    );
    assert.match(sends[1].input.text, /Later notice/);
    await assert.rejects(bridge.resolveHeld(9, "resend"), /No held/);
    // The notice left the rolling feed, and a newer one arrives while recovery runs.
    notices = notices.filter((n) => n.seq > 1);
    notices.push(notice(4, "During recovery"));
    await bridge.resolveHeld(1, "resend");
    await bridge.flush();
    assert.deepEqual(
      sends.map((s) => s.method),
      ["sendMessage", "sendMessage", "sendMediaGroup", "sendMessage"],
    );
    assert.match(sends[3].input.text, /During recovery/);
    state = JSON.parse(readFileSync(statePath));
    assert.deepEqual(state.held, []);
    assert.equal(state.sentSeq, 4);
    assert.equal(state.sentPart, undefined);
    mapped();
    await bridge.flush();
    assert.equal(sends.length, 4);
  }

  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  fault = { method: "sendMediaGroup", code: 0 };
  start();
  await bridge.flush();
  await bridge.resolveHeld(1, "delivered");
  assert.deepEqual(JSON.parse(readFileSync(statePath)).held, []);
  assert.equal(sends.length, 0);

  // The confirmed first part is never resent; a resend lost again stays held.
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  let partial = JSON.parse(readFileSync(statePath));
  partial.sentPart = {
    seq: 1,
    parts: 1,
    pendingMedia: true,
    anchorMessageId: 77,
    plan: [
      { kind: "media", ref: ref("demo.png"), caption: "<b>Test · Main</b>" },
      { kind: "media", ref: ref("demo.mp4"), caption: "" },
    ],
  };
  writeFileSync(statePath, JSON.stringify(partial));
  start();
  await bridge.flush();
  assert.equal(attempts.length, 0);
  assert.equal(JSON.parse(readFileSync(statePath)).held[0].sentPart.parts, 1);
  fault = { method: "sendVideo", code: 0 };
  await assert.rejects(bridge.resolveHeld(1, "resend"));
  assert.equal(JSON.parse(readFileSync(statePath)).held.length, 1);
  await bridge.resolveHeld(1, "resend");
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendVideo"],
  );
  assert.equal(JSON.parse(sends[0].input.reply_parameters).message_id, 77);
  assert.deepEqual(JSON.parse(readFileSync(statePath)).held, []);

  // Delivered confirms only the part in flight; the part after it is still sent, once.
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  partial = JSON.parse(readFileSync(statePath));
  partial.sentPart = {
    seq: 1,
    parts: 0,
    pendingMedia: true,
    plan: [
      { kind: "media", ref: ref("demo.png"), caption: "<b>Test · Main</b>" },
      { kind: "media", ref: ref("demo.mp4"), caption: "" },
    ],
  };
  writeFileSync(statePath, JSON.stringify(partial));
  start();
  await bridge.flush();
  await bridge.resolveHeld(1, "delivered");
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendVideo"],
  );
  assert.deepEqual(JSON.parse(readFileSync(statePath)).held, []);

  // After a clean rejection nothing is uncertain, so delivered must not skip the unsent part.
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  partial = JSON.parse(readFileSync(statePath));
  partial.sentPart = {
    seq: 1,
    parts: 0,
    pendingMedia: true,
    plan: [
      { kind: "media", ref: ref("demo.png"), caption: "<b>Test · Main</b>" },
      { kind: "media", ref: ref("demo.mp4"), caption: "" },
    ],
  };
  writeFileSync(statePath, JSON.stringify(partial));
  start();
  await bridge.flush();
  fault = { method: "sendPhoto", code: 429 };
  await assert.rejects(bridge.resolveHeld(1, "resend"));
  await assert.rejects(bridge.resolveHeld(1, "delivered"), /Nothing is uncertain/);
  await bridge.resolveHeld(1, "resend");
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendPhoto", "sendVideo"],
  );

  // A restart in the middle of a recovery keeps its progress in the held record, not in the outbox cursor.
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  notices.push(notice(2, "Next"));
  partial = JSON.parse(readFileSync(statePath));
  const midPlan = [
    { kind: "media", ref: ref("demo.png"), caption: "<b>Test · Main</b>" },
    { kind: "media", ref: ref("demo.mp4"), caption: "" },
  ];
  partial.sentSeq = 1;
  partial.held = [{ seq: 1, at: 0, ownerChatId: 1, sentPart: { seq: 1, parts: 0, plan: midPlan } }];
  partial.sentPart = { seq: 1, parts: 1, plan: midPlan, anchorMessageId: 5 };
  writeFileSync(statePath, JSON.stringify(partial));
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMessage"],
  );
  partial = JSON.parse(readFileSync(statePath));
  assert.equal(partial.held[0].sentPart.parts, 1);
  assert.equal(partial.sentPart, undefined);
  assert.equal(partial.sentSeq, 2);

  // Incident shape: state persisted by the old release.
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  notices.push(notice(2, "After legacy"));
  let old = JSON.parse(readFileSync(statePath));
  old.sentPart = {
    seq: 1,
    parts: 0,
    pendingMedia: true,
    plan: [{ kind: "album", refs: [ref("demo.png"), ref("demo.mp4")], caption: "<b>Test · Main</b>" }],
  };
  writeFileSync(statePath, JSON.stringify(old));
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMessage"],
  );
  assert.match(sends[0].input.text, /After legacy/);
  old = JSON.parse(readFileSync(statePath));
  assert.equal(old.sentSeq, 2);
  assert.equal(old.held[0].seq, 1);
  assert.equal(attempts.length, 1);
  await bridge.resolveHeld(1, "resend");
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMessage", "sendMediaGroup"],
  );
  assert.equal(sends[1].input.media.length, 2);
  mapped();

  // Another owner never receives a held attachment.
  reset(`![Photo](${ref("demo.png")}) ![Video](${ref("demo.mp4")})`);
  fault = { method: "sendMediaGroup", code: 0 };
  start();
  await bridge.flush();
  old = JSON.parse(readFileSync(statePath));
  old.owner = { chatId: 2, name: "Other" };
  bridge.close();
  writeFileSync(statePath, JSON.stringify(old));
  start();
  await assert.rejects(bridge.resolveHeld(1, "resend"), /different Telegram account/);
  assert.equal(sends.length, 0);

  // A held notice goes only to the account it was held for, even when the owner is replaced while a part is in flight.
  reset("unused");
  const heldPlan = [
    { kind: "media", ref: ref("demo.png"), caption: "Held caption" },
    { kind: "text", text: "Held follow-up" },
  ];
  const seeded = JSON.parse(readFileSync(statePath));
  seeded.sentSeq = 1;
  seeded.held = [
    { seq: 1, at: 0, ownerChatId: 1, notice: notices[0], sentPart: { seq: 1, chatId: 1, parts: 0, pendingMedia: true, plan: heldPlan } },
  ];
  writeFileSync(statePath, JSON.stringify(seeded));
  start(true);
  let updateId = 0;
  gate = {
    method: "sendPhoto",
    run: async () => {
      bridge.unpair();
      const { code } = (await bridge.pair()).pairing;
      updates.push({
        update_id: ++updateId,
        message: { message_id: 1, chat: { id: 2, type: "private", first_name: "Other" }, from: { id: 2 }, text: `/start ${code}` },
      });
      for (let i = 0; i < 100 && (await bridge.snapshot()).owner !== "Other"; i++) await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
  await assert.rejects(bridge.resolveHeld(1, "resend"), /recipient changed/);
  const rebound = JSON.parse(readFileSync(statePath));
  assert.equal(rebound.owner.chatId, 2);
  assert.deepEqual(
    sends.filter((s) => s.method !== "sendMessage").map((s) => s.method),
    ["sendPhoto"],
  );
  assert(!attempts.some((a) => JSON.stringify(a.input).includes("Held follow-up")), "the follow-up never reaches the replacement");
  assert(!attempts.slice(1).some((a) => a.method !== "sendMessage" || !/^Paired/.test(a.input.text)), "only the pairing reply follows");
  assert.equal(rebound.held.length, 1);
  assert.equal(rebound.held[0].ownerChatId, 1);
  assert.equal(rebound.held[0].sentPart.chatId, 1);
  assert.equal(rebound.held[0].sentPart.parts, 1, "the part that reached the first chat stays confirmed");
  assert.equal(rebound.held[0].sentPart.pendingMedia, undefined);
  assert.deepEqual(rebound.messages[sends[0].message_id], undefined, "its message id is not routed for the new account");
  await assert.rejects(bridge.resolveHeld(1, "resend"), /different Telegram account/);
  assert(!attempts.some((a) => JSON.stringify(a.input).includes("Held follow-up")));

  reset(`Start ![Uncertain](${ref("demo.mp4")}) Stop`);
  fault = { method: "sendVideo", code: 0 };
  start();
  await bridge.flush();
  const before = attempts.length;
  bridge.close();
  start();
  await bridge.flush();
  assert.equal(attempts.length, before);
  assert.equal(JSON.parse(readFileSync(statePath)).held.length, 1);
  reset(`Legacy partial ![Image](${ref("demo.png")})`);
  let legacy = JSON.parse(readFileSync(statePath));
  legacy.sentPart = { seq: 1, parts: 1 };
  writeFileSync(statePath, JSON.stringify(legacy));
  start();
  await bridge.flush();
  assert.equal(sends.length, 0);
  assert.equal(JSON.parse(readFileSync(statePath)).held[0].sentPart.pendingMedia, true);
  await assert.rejects(bridge.resolveHeld(1, "resend"), /no saved plan/);
  assert.equal(sends.length, 0);
  reset("text-only ".repeat(700));
  legacy = JSON.parse(readFileSync(statePath));
  legacy.sentPart = { seq: 1, parts: 1 };
  writeFileSync(statePath, JSON.stringify(legacy));
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].method, "sendMessage");
  assert(!sends[0].input.text.includes("Test · Main"));

  // 62/65: with topics on, one media and an album go to the chat's topic; a topic that is gone is recreated and the upload repeated once.
  const topicsOn = (topics = []) => {
    const state = JSON.parse(readFileSync(statePath));
    writeFileSync(statePath, JSON.stringify({ ...state, bot: { id: 1, username: "b", topics: true }, topics }));
  };
  reset(`Before ![Image](${ref("demo.png")}) after`);
  topicsOn();
  start();
  await bridge.flush();
  assert.deepEqual(
    attempts.map((a) => a.method),
    ["createForumTopic", "sendPhoto"],
  );
  assert.equal(attempts[0].input.name, "Test · Main");
  assert.equal(sends[0].input.message_thread_id, String(topicId));
  mapped();
  reset(`![One](${ref("demo.png")}) ![Two](${ref("Screenshot (1 (copy)).png")})`);
  topicsOn();
  start();
  await bridge.flush();
  assert.deepEqual(
    sends.map((s) => s.method),
    ["sendMediaGroup"],
  );
  assert.equal(sends[0].input.message_thread_id, String(topicId));
  mapped();
  reset(`![Image](${ref("demo.png")})`);
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  fault = { method: "sendPhoto", code: 400, description: "Bad Request: message thread not found" };
  start();
  await bridge.flush();
  assert.deepEqual(
    attempts.map((a) => a.method),
    ["sendPhoto", "createForumTopic", "sendPhoto"],
  );
  assert.equal(sends.length, 1);
  assert.equal(sends[0].input.message_thread_id, String(topicId));
  assert.deepEqual(JSON.parse(readFileSync(statePath)).topics, [{ projectId: project, chatId: "main", thread: topicId }]);
  mapped();
  reset("A thread kept from before topics were turned off is dropped. ".repeat(2));
  const stale = JSON.parse(readFileSync(statePath));
  writeFileSync(statePath, JSON.stringify({ ...stale, sentPart: { seq: 1, chatId: 1, parts: 0, thread: 500 } }));
  start();
  await bridge.flush();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].input.message_thread_id, undefined);
  reset(`![Image](${ref("demo.png")})`);
  topicsOn();
  fault = { method: "createForumTopic", code: 500 };
  start();
  await bridge.flush();
  assert.equal(sends.length, 1, "a failing topic creation sends the upload to the general thread");
  assert.equal(sends[0].input.message_thread_id, undefined);

  // 71: the owner is replaced while the artifact is being authorized; the first send of the part must not reach the former owner.
  reset(`![Image](${ref("demo.png")})`);
  dispatchHook = async () => bridge.unpair();
  start();
  await bridge.flush().catch(() => {});
  assert(
    !attempts.some((a) => a.method !== "getUpdates" && a.input.chat_id !== undefined) && sends.length === 0,
    "71 nothing is sent after the owner changed during authorization",
  );

  // 74: the topic is created with the archived prefix when the chat is already archived, and when it is archived during the creation.
  const mainChat = (archived) => ({ id: "main", title: "Main", archived });
  reset("Archived before its first notice. ".repeat(2));
  topicsOn();
  chatList = [mainChat(true)];
  start();
  await bridge.flush();
  assert.equal(attempts[0].input.name, "📦 Test · Main", "74 created with the prefix");
  reset("Archived while its topic is created. ".repeat(2));
  topicsOn();
  chatList = [mainChat(false)];
  let archivedDuring;
  gate = {
    method: "createForumTopic",
    run: async () => {
      chatList = [mainChat(true)];
      archivedDuring = bridge.chatChanged(project, mainChat(true));
    },
  };
  start();
  await bridge.flush();
  await archivedDuring;
  assert.equal(topicNames.get(topicId), "📦 Test · Main", "74 the archive during creation is applied once the topic exists");
  reset("A topic recreated for an archived chat. ".repeat(2));
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  chatList = [mainChat(true)];
  fault = { method: "sendMessage", code: 400, description: "Bad Request: message thread not found" };
  start();
  await bridge.flush();
  assert.equal(attempts.find((a) => a.method === "createForumTopic").input.name, "📦 Test · Main", "74 the recreated topic has the prefix");

  // 75: a restore queued behind an archive edit that is still in flight is sent after it, so the last state wins.
  reset("unused");
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  topicNames.set(500, "Test · Main");
  chatList = [mainChat(true)];
  let held, reachedEdit;
  const reached = new Promise((resolve) => (reachedEdit = resolve));
  gate = { method: "editForumTopic", run: () => (reachedEdit(), new Promise((resolve) => (held = resolve))) };
  start();
  const archiving = bridge.chatChanged(project, mainChat(true));
  await reached;
  chatList = [mainChat(false)];
  const restoring = bridge.chatChanged(project, mainChat(false));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const edits = () => attempts.filter((a) => a.method === "editForumTopic").map((a) => a.input.name);
  assert.deepEqual(edits(), ["📦 Test · Main"], "75 the restore waits while the archive edit is in flight");
  held();
  await Promise.all([archiving, restoring]);
  assert.deepEqual(edits(), ["📦 Test · Main", "Test · Main"], "75 both names arrive in order");
  assert.equal(topicNames.get(500), "Test · Main", "75 the last edit wins");

  // 1: the owner is replaced during the chat-name lookup of a topic creation; the project and chat title never go to the former owner.
  reset("Owner replaced during the topic name lookup. ".repeat(2));
  topicsOn();
  chatsHook = async () => bridge.unpair();
  start();
  await bridge.flush().catch(() => {});
  assert(!attempts.some((a) => a.method === "createForumTopic"), "1 no topic is created for the former owner");
  assert.equal(sends.length, 0, "1 nothing is sent");

  // 2: the owner is replaced while the photo is rejected; the document fallback never reaches the former owner.
  reset(`![Image](${ref("demo.png")})`);
  fault = { method: "sendPhoto", code: 400, description: "Bad Request: wrong file", run: async () => bridge.unpair() };
  start();
  await bridge.flush().catch(() => {});
  assert(!attempts.some((a) => a.method === "sendDocument"), "2 no document fallback after the owner changed");
  assert.equal(sends.length, 0, "2 nothing is sent");

  // 3: a queued update waits for the startup topics refresh; a topics flag turned off in BotFather is not stale for it.
  reset("unused");
  topicsOn([{ projectId: project, chatId: "other", thread: 500 }]);
  meTopics = false;
  updates.push({
    update_id: 1,
    message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "hello", message_thread_id: 500 },
  });
  const reply = () => sends.find((s) => s.method === "sendMessage");
  start(true);
  for (let i = 0; i < 100 && !reply(); i++) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(reply()?.input.text ?? "", /Pick a project/, "3 the update is routed with topics off");
  assert.equal(reply().input.message_thread_id, undefined, "3 the reply carries no thread");

  // 4: the chat lookup fails during an archive edit; the archived state of the edit is kept.
  reset("unused");
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  topicNames.set(500, "Test · Main");
  chatsHook = async () => {
    throw new Error("lookup failed");
  };
  start();
  await bridge.chatChanged(project, mainChat(true));
  assert.equal(topicNames.get(500), "📦 Test · Main", "4 the archive prefix survives a failed lookup");
  await bridge.chatChanged(project, mainChat(false));
  assert.equal(topicNames.get(500), "Test · Main", "4 the restore removes it on a failed lookup");

  // 5: an edit whose result is unknown does not leave a cached name that hides the next needed edit.
  reset("unused");
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  topicNames.set(500, "Test · Main");
  chatList = [mainChat(true)];
  start();
  await bridge.chatChanged(project, mainChat(true));
  assert.equal(topicNames.get(500), "📦 Test · Main");
  chatList = [mainChat(false)];
  fault = { method: "editForumTopic", code: 0, run: () => topicNames.set(500, "Test · Main") };
  await bridge.chatChanged(project, mainChat(false));
  chatList = [mainChat(true)];
  await bridge.chatChanged(project, mainChat(true));
  assert.equal(topicNames.get(500), "📦 Test · Main", "5 the archive after an uncertain restore is not skipped");

  // 6: the owner is replaced while Telegram answers "topic gone"; no topic is created in the new owner's chat for the old notice.
  reset(`![Image](${ref("demo.png")})`);
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  let replacedUpdate = 0;
  fault = {
    method: "sendPhoto",
    code: 400,
    description: "Bad Request: message thread not found",
    run: async () => {
      bridge.unpair();
      const { code } = (await bridge.pair()).pairing;
      const pairing = {
        update_id: ++replacedUpdate,
        message: { message_id: 1, chat: { id: 2, type: "private", first_name: "Other" }, from: { id: 2 }, text: `/start ${code}` },
      };
      // An update pushed while a poll is in flight can be lost, so the pairing is offered again until it lands.
      for (let i = 0; i < 100 && (await bridge.snapshot()).owner !== "Other"; i++) {
        if (!updates.length) updates.push(pairing);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal((await bridge.snapshot()).owner, "Other", "6 the owner was replaced before the rejection is released");
    },
  };
  start(true);
  await bridge.flush().catch(() => {});
  assert(!attempts.some((a) => a.method === "createForumTopic"), "6 no topic is created for a notice of the former owner");
  assert(!attempts.some((a) => a.method === "sendPhoto" && a.input.chat_id === "2"), "6 the notice never reaches the new owner");

  // 7: an archive edit during the startup topics refresh waits for it instead of seeing the stale topics flag.
  reset("unused");
  topicsOn([{ projectId: project, chatId: "main", thread: 500 }]);
  const flagOff = JSON.parse(readFileSync(statePath));
  flagOff.bot.topics = false;
  writeFileSync(statePath, JSON.stringify(flagOff));
  topicNames.set(500, "Test · Main");
  meTopics = true;
  start(true);
  await bridge.chatChanged(project, mainChat(true));
  assert.equal(topicNames.get(500), "📦 Test · Main", "7 the archive edit waits for the topics refresh");

  console.log(
    "PASS one-message native caption/envelope/actions/routing; albums/overflow; byte/MIME/security/fallback; retry/order/restart/uncertainty",
  );
} finally {
  bridge?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
