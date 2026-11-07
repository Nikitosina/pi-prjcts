// Browser E2E for Telegram two-way: isolated host, fake model, and a local fake Telegram Bot API server (PI_PROJECTS_TELEGRAM_API). Never real Telegram.
// Failure cases recorded in telegram-failures.md before implementation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kit, delay, randomUUID } from "./notify-kit.mjs";

// Fake Bot API: two bots, a retained update log (getUpdates returns updates with id >= offset, long-polling), recorded sends, fault injection.
const TOKEN = "123456:AAFakeTokenForE2E_" + randomUUID().replaceAll("-", "");
const TOKEN2 = "654321:AAOtherBotTokenE2E_" + randomUUID().replaceAll("-", "");
const bots = { [TOKEN]: { id: 123456, username: "pi_fake_bot" }, [TOKEN2]: { id: 654321, username: "pi_other_bot" } };
const tg = {
  updates: [],
  nextUpdate: 1000,
  sent: [],
  edits: [],
  answered: [],
  polls: [],
  waiters: new Set(),
  failPolls: 0,
  failSends: 0,
  revoked: new Set(),
  nextMessage: 1,
  refused: [],
};
// Telegram's HTML parse_mode: only these tags, properly nested, entities limited to &lt; &gt; &amp; &quot; and numeric. `PARSEFAIL` forces a refusal.
const TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "blockquote", "tg-spoiler", "span"]);
function htmlProblem(html) {
  if (html.includes("PARSEFAIL")) return "forced by test";
  const stack = [];
  for (const [tag, close, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (!TAGS.has(name)) return `unsupported tag ${name}`;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return `unmatched end tag ${name}`;
  }
  if (stack.length) return `unclosed ${stack.join(",")}`;
  if (/<(?![a-z/])/.test(html) || /&(?!lt;|gt;|amp;|quot;|#\d+;)/.test(html)) return "raw < or &";
  return null;
}
const visible = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
const MD = [
  "# Release notes",
  "",
  "This is **bold**, *italic*, _also italic_, ~~gone~~ and `a < b && c`. Keep snake_case_name and 2*3*4 as is.",
  "",
  "- first item",
  "- second **item**",
  "  - nested",
  "1. one",
  "2. two",
  "",
  "> quoted **line**",
  "> second",
  "",
  '[Docs](https://example.com/a?b=1&c="x") and [bad](javascript:alert(1))',
  "",
  "```ts",
  "const x = a < b && c > d;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "Tail <script>alert(1)</script> & done.",
].join("\n");
const BIG =
  "Intro **bold** BIGMD\n```js\n" +
  Array.from({ length: 300 }, (_, i) => `l${String(i).padStart(3, "0")} a<b && c>d;`).join("\n") +
  "\n```\nafter";
const respond = ({ coordinator, marker, say }) =>
  !coordinator
    ? undefined
    : marker === "MARK-MD"
      ? say(MD)
      : marker === "MARK-BIGMD"
        ? say(BIG)
        : marker === "MARK-PARSEFAIL"
          ? say("**PARSEFAIL** plain *fallback* text")
          : undefined;
const OWNER = { id: 777001, first_name: "Owner", type: "private" },
  STRANGER = { id: 888002, first_name: "Mallory", type: "private" },
  GROUP = { id: -100500, title: "Group", type: "group" };
const wake = () => {
  for (const fn of tg.waiters) fn();
};
function push(update) {
  const item = { update_id: tg.nextUpdate++, ...update };
  tg.updates.push(item);
  wake();
  return item;
}
const text = (chat, value, extra = {}) =>
  push({
    message: {
      message_id: tg.nextMessage++,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: chat.id > 0 ? chat.id : OWNER.id, is_bot: false, first_name: "x" },
      text: value,
      ...extra,
    },
  });
const press = (chat, message, data) =>
  push({
    callback_query: {
      id: randomUUID(),
      from: { id: chat.id, is_bot: false, first_name: "x" },
      message: { message_id: message.message_id, chat, date: 0, text: message.text },
      data,
    },
  });
const api = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const token = match?.[1],
      bot = bots[token],
      method = match?.[2],
      input = body ? JSON.parse(body) : {};
    if (!bot || tg.revoked.has(token)) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return reply(200, { ok: true, result: { id: bot.id, is_bot: true, first_name: "Pi", username: bot.username } });
    if (method === "getUpdates") {
      tg.polls.push({ at: Date.now(), token: token === TOKEN ? 1 : 2, offset: input.offset ?? 0, timeout: input.timeout });
      if (tg.failPolls > 0) {
        tg.failPolls--;
        return reply(502, { ok: false, error_code: 502, description: "Bad Gateway" });
      }
      const ready = () => (token === TOKEN ? tg.updates.filter((u) => u.update_id >= (input.offset ?? 0)) : []);
      if (!ready().length && input.timeout)
        await new Promise((ok) => {
          const done = () => {
            tg.waiters.delete(done);
            clearTimeout(timer);
            ok();
          };
          const timer = setTimeout(done, input.timeout * 1000);
          tg.waiters.add(done);
          req.on("close", done);
        });
      if (res.destroyed) return;
      return reply(200, { ok: true, result: ready().slice(0, 100) });
    }
    if (method === "sendMessage") {
      if (tg.failWhen?.(input)) {
        tg.failWhen = null;
        return reply(502, { ok: false, error_code: 502, description: "Bad Gateway" });
      }
      if (tg.failSends > 0) {
        tg.failSends--;
        return reply(502, { ok: false, error_code: 502, description: "Bad Gateway" });
      }
      if (String(input.text ?? "").length > 4096)
        return reply(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" });
      if (input.parse_mode === "HTML") {
        const problem = htmlProblem(input.text);
        if (problem) {
          tg.refused.push({ text: input.text, problem });
          return reply(400, { ok: false, error_code: 400, description: `Bad Request: can't parse entities: ${problem}` });
        }
      }
      const message = {
        message_id: tg.nextMessage++,
        chat: { id: input.chat_id },
        text: input.text,
        parse_mode: input.parse_mode,
        reply_markup: input.reply_markup,
        at: Date.now(),
        bot: bot.username,
      };
      tg.sent.push(message);
      return reply(200, { ok: true, result: message });
    }
    if (method === "answerCallbackQuery") {
      tg.answered.push(input);
      return reply(200, { ok: true, result: true });
    }
    if (method === "editMessageReplyMarkup" || method === "editMessageText") {
      tg.edits.push({ method, ...input });
      return reply(200, { ok: true, result: true });
    }
    return reply(404, { ok: false, error_code: 404, description: "Not Found: method" });
  });
});
await new Promise((ok) => api.listen(0, "127.0.0.1", ok));
// `/status` refreshes subscription limits: fixture readings, so no provider is contacted.
const limitsFixture = join(mkdtempSync(join(tmpdir(), "telegram-limits-")), "limits.json");
writeFileSync(limitsFixture, JSON.stringify({ claude: [{ window: "5h", usedPercent: 37, resetsAt: Date.now() + 3 * 3600e3 }] }));
const k = await kit(
  "telegram",
  {
    PI_PROJECTS_TELEGRAM_API: `http://127.0.0.1:${api.address().port}`,
    PI_PROJECTS_TELEGRAM_POLL_S: "20",
    PI_PROJECTS_TELEGRAM_BACKOFF_MS: "200",
    PI_PROJECTS_LIMITS_FIXTURE: limitsFixture,
  },
  respond,
);
k.secrets.push(TOKEN, TOKEN2);
const { result, rpc, eventually, evaluate, waitFor, shot, send } = k;
const toOwner = () => tg.sent.filter((m) => m.chat.id === OWNER.id);
const sentTo = (id) => tg.sent.filter((m) => m.chat.id === id);
const lastTo = async (pattern, label, from = 0) =>
  eventually(
    async () =>
      toOwner()
        .slice(from)
        .findLast((m) => pattern.test(m.text)),
    `no Telegram message: ${label}`,
    300,
  );
const buttons = (message) => (message.reply_markup?.inline_keyboard ?? []).flat();
let opens = 0;
const settingsUrl = async (id) => {
  const url = new URL((await rpc({ action: "web" })).url);
  url.searchParams.set("project", id);
  // The page drops the token from the address bar; a fresh query keeps the next open a full load, not a fragment change.
  url.searchParams.set("open", String(++opens));
  return url.toString();
};
// Settings → Notifications holds the Telegram card (scripts/telegram-failures.md 43-45).
const card = `document.querySelector('dialog[open] #telegram')`;
const openTelegram = async (s) => {
  await waitFor(`document.body.dataset.ready === "1"`, s, "page ready");
  await evaluate(`document.querySelector('[data-cmd="settings"]').click()`, s);
  await waitFor(`!!document.querySelector('dialog[open] [data-section="notifications"]')`, s, "settings open");
  await evaluate(`document.querySelector('dialog[open] [data-section="notifications"]').click()`, s);
  await waitFor(`!!document.querySelector('dialog[open] #telegram-token')`, s, "telegram card");
};
const jobs = async (id, chatId) => (await rpc({ action: "show", id, ...(chatId && chatId !== "main" ? { chatId } : {}) })).jobs;
try {
  await k.startHost();
  const a = await k.setup("Alpha", k.gitRepo),
    b = await k.setup("Beta");
  const two = await rpc({ action: "chat-create", id: a, title: "Two" });
  await k.ask(a, "main", "MARK-BEFORE history before pairing");

  // T1/T2: token in Settings; a wrong token is refused; the token never comes back.
  const s = await k.openPage(await settingsUrl(a));
  await openTelegram(s);
  const typeToken = (token) =>
    `(() => { const i = document.querySelector('dialog[open] #telegram-token'); i.value = ${JSON.stringify(token)}; i.dispatchEvent(new Event('input')); document.querySelector('dialog[open] [data-telegram-save]').click(); })()`;
  await evaluate(typeToken("999:WrongTokenWrongTokenWrongToken123"), s);
  await waitFor(`/rejected|unauthorized/i.test(${card}.innerText)`, s, "wrong token refused in place");
  if ((await rpc({ action: "telegram-snapshot" })).configured) throw Error("Wrong token saved");
  await evaluate(typeToken(TOKEN), s);
  await waitFor(`${card}.innerText.includes('@pi_fake_bot')`, s, "bot connected");
  if (await evaluate(`document.querySelector('dialog[open] #telegram-token').value`, s))
    throw Error("45 the saved token stayed in the field");
  const snap1 = await rpc({ action: "telegram-snapshot" });
  const file = join(k.home, "telegram.json");
  if (
    JSON.stringify(snap1).includes(TOKEN) ||
    (await evaluate(`document.documentElement.outerHTML`, s)).includes(TOKEN) ||
    (statSync(file).mode & 0o077) !== 0 ||
    !readFileSync(file, "utf8").includes(TOKEN)
  )
    throw Error("Token leaked or stored with wrong mode");
  result.checks.push(
    "T1/T2 a wrong token is refused via getMe; the right one is stored 0600 and never returned to the page or the snapshot",
  );

  // T4: before pairing nobody is heard.
  text(STRANGER, "MARK-STRANGER hello");
  text(OWNER, "MARK-EARLY hello");
  await delay(1500);
  if (tg.sent.length || (await jobs(a)).some((j) => /STRANGER|EARLY/.test(j.text))) throw Error("Unpaired chat was heard");
  result.checks.push("T4 before pairing, messages are ignored and nothing is admitted");

  // T5/T6: pairing code; wrong-code cap; private chats only; code not reusable.
  await evaluate(`document.querySelector('dialog[open] [data-telegram-pair]').click()`, s);
  await waitFor(`/\\/pair \\d{6}/.test(${card}.innerText)`, s, "pair code");
  let code = /\/pair (\d{6})/.exec(await evaluate(`${card}.innerText`, s))[1];
  for (let i = 0; i < 5; i++) text(STRANGER, `/pair ${String((Number(code) + 1 + i) % 1000000).padStart(6, "0")}`);
  await eventually(async () => !(await rpc({ action: "telegram-snapshot" })).pairing, "wrong-code cap did not cancel pairing", 100);
  text(STRANGER, `/pair ${code}`);
  await delay(1000);
  if ((await rpc({ action: "telegram-snapshot" })).paired) throw Error("Cancelled code paired");
  await evaluate(`document.querySelector('dialog[open] [data-telegram-pair]').click()`, s);
  await waitFor(`/\\/pair \\d{6}/.test(${card}.innerText) && !${card}.innerText.includes('/pair ${code}')`, s, "second pair code");
  code = /\/pair (\d{6})/.exec(await evaluate(`${card}.innerText`, s))[1];
  // Pairing ends in Telegram; the open page follows the host topic and never polls for it (44).
  await evaluate(
    `(window.__tgReads = 0, window.__realFetch ??= window.fetch, window.fetch = function (url, options) { try { if (JSON.parse(options?.body ?? "{}").action === "telegram-snapshot") window.__tgReads++; } catch {} return window.__realFetch.apply(this, arguments); })`,
    s,
  );
  await shot("01-settings-pairing", s);
  text(GROUP, `/pair ${code}`);
  await delay(1000);
  if ((await rpc({ action: "telegram-snapshot" })).paired) throw Error("Group chat paired");
  text(OWNER, `/pair ${code}`);
  await lastTo(/paired/i, "pair confirmation");
  text(STRANGER, `/pair ${code}`);
  await waitFor(`/paired/i.test(${card}.innerText) && ${card}.innerText.includes('Owner')`, s, "paired shown without a reload");
  await delay(2500);
  const reads = await evaluate(`window.__tgReads`, s);
  if (reads < 1 || reads > 3) throw Error(`44 the page read Telegram ${reads} times while pairing (polling, or no topic)`);
  result.checks.push("44 pairing finished in Telegram reaches the open Settings page through the host topic, without polling");
  // Remove bot asks for a second press (45); the first press changes nothing on the host.
  await evaluate(`document.querySelector('dialog[open] [data-telegram-remove]').click()`, s);
  await waitFor(`/Confirm: remove bot/.test(document.querySelector('dialog[open] [data-telegram-remove]').innerText)`, s, "armed remove");
  if (!(await rpc({ action: "telegram-snapshot" })).configured) throw Error("45 one press removed the bot");
  result.checks.push("45 Remove bot needs a second press");
  const paired = await rpc({ action: "telegram-snapshot" });
  if (!paired.paired || paired.pairing || sentTo(STRANGER.id).length || sentTo(GROUP.id).some((m) => /paired/i.test(m.text)))
    throw Error("Pairing wrong: " + JSON.stringify(paired));
  if (toOwner().some((m) => m.text.includes("MARK-BEFORE"))) throw Error("History flooded after pairing");
  result.checks.push(
    "T5/T6 a 6-digit code pairs the owner's private chat; 5 wrong codes cancel it; a group or a reused code does not pair; no history flood",
  );

  // T13/T14: routing.
  let mark = toOwner().length;
  text(OWNER, "MARK-NOROUTE hi");
  await lastTo(/\/projects?/, "no-route hint", mark);
  text(OWNER, "/models");
  await lastTo(/Pick a project first/, "models need a selected project", mark);
  text(OWNER, "/projects");
  const list = await lastTo(/Alpha/, "project list", mark);
  if (!list.text.includes("Beta") || !buttons(list).some((btn) => btn.text.includes("Alpha"))) throw Error("Project list wrong");
  text(OWNER, "/project Nope");
  await lastTo(/no project/i, "unknown project", mark);
  press(OWNER, list, buttons(list).find((btn) => btn.text.includes("Alpha")).callback_data);
  await lastTo(/Alpha.*Main/, "project selected", mark);
  text(OWNER, "/chats");
  const chats = await lastTo(/Two/, "chat list", mark);
  text(OWNER, "/chat Nope");
  await lastTo(/no chat/i, "unknown chat", mark);
  press(OWNER, chats, buttons(chats).find((btn) => btn.text.includes("Two")).callback_data);
  await lastTo(/Alpha.*Two/, "chat selected", mark);
  const tg1 = text(OWNER, "MARK-TGONE hello from Telegram");
  await lastTo(/Sent to Alpha · Two/, "sent ack", mark);
  const result1 = await lastTo(/Done MARK-TGONE\./, "result back", mark);
  if (!/Alpha · Two/.test(result1.text)) throw Error("Result header wrong: " + result1.text);
  if (
    (await jobs(a, two.id)).filter((j) => j.text.includes("MARK-TGONE")).length !== 1 ||
    (await jobs(a)).some((j) => /NOROUTE|TGONE/.test(j.text))
  )
    throw Error("Routing wrong");
  // Strangers after pairing.
  text(STRANGER, "MARK-STRANGER2 hi");
  press(STRANGER, list, buttons(list)[0].callback_data);
  await delay(1000);
  if (sentTo(STRANGER.id).length || (await jobs(a, two.id)).some((j) => j.text.includes("STRANGER")))
    throw Error("Stranger heard after pairing");
  result.checks.push(
    "T13/T14/T7 /projects and /chats pick a target by button; unknown names are refused; text goes to that chat and the result comes back; strangers are ignored",
  );

  // Model commands use the selected project's settings RPC, never the coordinator or a new task.
  {
    const modelFile = join(k.root, "agent", "models.json"),
      catalog = JSON.parse(readFileSync(modelFile, "utf8"));
    catalog.providers.fake.models.push(
      { ...catalog.providers.fake.models[0], id: "other-model", name: "Other" },
      ...Array.from({ length: 25 }, (_, i) => ({
        ...catalog.providers.fake.models[0],
        id: `catalog-${String(i).padStart(2, "0")}-${"x".repeat(170)}`,
      })),
    );
    writeFileSync(modelFile, JSON.stringify(catalog));
    const command = async (value, pattern) => {
      const from = toOwner().length;
      text(OWNER, value);
      return lastTo(pattern, value, from);
    };
    const settings = () => rpc({ action: "settings-snapshot", id: a });
    await rpc({
      action: "settings-update",
      id: a,
      confirm: a,
      expectedRevision: (await settings()).revision,
      changes: { models: { worker: null, scout: null, reviewer: null } },
    });
    const initial = await settings(),
      otherProject = await rpc({ action: "settings-snapshot", id: b }),
      route = JSON.parse(readFileSync(file, "utf8")).route;
    const view = await command("/models", /Models for Alpha/);
    assert.match(view.text, /coordinator: fake\/fake-model/);
    assert.match(view.text, /worker: fake\/fake-model.*inherited/);
    assert.match(view.text, /verifier: not configured/);
    assert.match(view.text, /\/models <query>/);
    assert.match((await command("/models OtHeR", /fake\/other-model/)).text, /configured/i);
    const many = await command("/models catalog", /fake\/catalog-/);
    assert.ok(many.text.length <= 4000 && /refine/i.test(many.text), "catalog output stays bounded and offers refinement");
    for (const line of many.text.split("\n").filter((line) => line.startsWith("fake/catalog-")))
      assert.ok(
        catalog.providers.fake.models.some((model) => `fake/${model.id}` === line),
        "catalog references are not clipped",
      );
    await command("/models no-such-model", /No configured models match/);
    for (const role of ["coordinator", "worker", "scout", "reviewer", "verifier"]) {
      await command(`/model ${role} fake/other-model`, /Saved.*Alpha/);
      const values = (await settings()).values;
      assert.equal(role === "coordinator" ? values.model : values.models[role], "fake/other-model");
    }
    for (const role of ["worker", "scout", "reviewer"]) {
      await command(`/model ${role} inherit`, /Saved.*Alpha/);
      assert.equal((await settings()).values.models[role], undefined);
    }
    await command("/model verifier none", /Saved.*Alpha/);
    assert.equal((await settings()).values.models.verifier, undefined);
    const beforeBad = await settings(),
      unconfigured = (await rpc({ action: "model-picker-snapshot", id: a })).items.find((item) => !item.configured);
    for (const [value, pattern] of [
      ["/model stranger fake/other-model", /Usage:/],
      ["/model worker fake/other-model extra", /Usage:/],
      ["/model coordinator inherit", /cannot inherit/i],
      ["/model verifier inherit", /verifier.*none/i],
      ["/model worker missing/model", /not changed/i],
      ...(unconfigured ? [[`/model worker ${unconfigured.reference}`, /not changed/i]] : []),
    ])
      await command(value, pattern);
    assert.equal((await settings()).revision, beforeBad.revision);
    text(STRANGER, "/model worker fake/other-model");
    text(GROUP, "/model worker fake/other-model");
    assert.match((await command("/status", /Alpha.*Two/)).text, /Subscription limits[^]*Claude: 5h 37% · resets in [23]h/);
    assert.equal((await settings()).revision, beforeBad.revision);
    assert.equal((await rpc({ action: "settings-snapshot", id: b })).revision, otherProject.revision);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).route, route);
    await command("/model coordinator fake/fake-model", /Saved.*Alpha/);
    assert.equal((await settings()).revision, initial.revision);

    // Scoped pickers remain tied to their original project, role and settings revision.
    const update = async (changes) =>
      rpc({ action: "settings-update", id: a, confirm: a, expectedRevision: (await settings()).revision, changes });
    const tap = async (message, pattern, reply) => {
      const from = toOwner().length,
        button = buttons(message).find((item) => pattern.test(item.text));
      assert.ok(button, `missing model button ${pattern}`);
      assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      press(OWNER, message, button.callback_data);
      return lastTo(reply, String(pattern), from);
    };
    await update({ scopedModels: ["fake/other-model", "fake/fake-model"] });
    const picker = await command("/model worker", /Choose worker.*Alpha/);
    assert.match(picker.text, /Current: fake\/fake-model.*inherited/);
    assert.equal(buttons(picker).length, 3);
    assert.ok(buttons(picker).some((item) => /Current.*fake\/fake-model/.test(item.text)));
    for (const role of ["coordinator", "scout", "reviewer", "verifier"]) {
      const menu = await command(`/model ${role}`, new RegExp(`Choose ${role}.*Alpha`));
      assert.equal(
        buttons(menu).some((item) => /Inherit coordinator/.test(item.text)),
        ["scout", "reviewer"].includes(role),
      );
      assert.equal(
        buttons(menu).some((item) => /No verifier/.test(item.text)),
        role === "verifier",
      );
    }
    press(STRANGER, picker, buttons(picker)[0].callback_data);
    await command("/status", /Alpha.*Two/);
    assert.equal((await settings()).values.models.worker, undefined);
    await command("/project Beta", /Beta.*Main/);
    await tap(picker, /fake\/other-model/, /Saved.*Alpha/);
    assert.equal((await settings()).values.models.worker, "fake/other-model");
    assert.equal((await rpc({ action: "settings-snapshot", id: b })).revision, otherProject.revision);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).route.projectId, b);
    assert.ok(
      tg.edits.some((item) => item.message_id === picker.message_id),
      "saved picker keyboard is cleared",
    );
    const savedRevision = (await settings()).revision;
    await tap(picker, /fake\/other-model/, /expired/i);
    assert.equal((await settings()).revision, savedRevision);
    await command("/project Alpha", /Alpha.*Main/);
    await command("/chat Two", /Alpha.*Two/);
    const stale = await command("/model reviewer", /Choose reviewer.*Alpha/);
    await update({ objective: initial.values.objective + " revised" });
    await tap(stale, /fake\/other-model/, /stale|revision conflict/i);
    assert.equal((await settings()).values.models.reviewer, undefined);

    // Pi's inherited scope can change without changing the project's revision.
    await update({ scopedModels: null });
    const piSettings = join(k.root, "agent", "settings.json");
    writeFileSync(piSettings, JSON.stringify({ enabledModels: ["fake/other-model"] }));
    const inherited = await command("/model worker", /Choose worker.*Alpha/);
    assert.equal(buttons(inherited).length, 2);
    writeFileSync(piSettings, JSON.stringify({ enabledModels: ["fake/fake-model"] }));
    const beforeScopeChange = (await settings()).revision;
    await tap(inherited, /fake\/other-model/, /scope|available|stale/i);
    assert.equal((await settings()).revision, beforeScopeChange);
    writeFileSync(piSettings, "{}");
    await update({ scopedModels: catalog.providers.fake.models.map((item) => `fake/${item.id}`) });
    const page = await command("/model worker", /Choose worker.*Alpha/);
    assert.ok(buttons(page).length <= 12, "scoped model pages stay bounded");
    const next = await tap(page, /Next/, /Page 2\//);
    assert.ok(buttons(next).some((item) => /Previous/.test(item.text)));
    await tap(next, /Inherit coordinator/, /Saved.*Alpha/);
    assert.equal((await settings()).values.models.worker, undefined);
    await update({ scopedModels: ["fake/other-model"] });
    writeFileSync(
      modelFile,
      JSON.stringify({
        providers: { ...catalog.providers, fake: { ...catalog.providers.fake, models: [catalog.providers.fake.models[0]] } },
      }),
    );
    const unavailable = await command("/model coordinator", /Choose coordinator.*Alpha/);
    assert.match(unavailable.text, /None.*scoped models.*usable/i);
    assert.equal(buttons(unavailable).length, 0);
    writeFileSync(modelFile, JSON.stringify(catalog));
    await update({ scopedModels: null, objective: initial.values.objective });
    const empty = await command("/model coordinator", /Choose coordinator.*Alpha/);
    assert.match(empty.text, /No scoped models/);
    assert.equal(buttons(empty).length, 0);
    assert.equal((await settings()).revision, initial.revision);
    result.checks.push(
      "Scoped model buttons mark current/inherited choices, paginate, reject stale settings or changed Pi scopes, stay bound after routing changes and expire after saving",
    );
    result.checks.push(
      "Telegram model inspection, bounded discovery, role settings and inheritance use the selected project's settings RPC; invalid and foreign commands cannot change settings or routing",
    );
  }

  // T17/T18/T40: question with buttons; a UI2 tab open on the asking chat drops the card when Telegram answers, without a reload.
  const ui2 = new URL((await rpc({ action: "web" })).url);
  ui2.searchParams.set("project", a);
  ui2.searchParams.set("chat", two.id);
  await send("Page.navigate", { url: ui2.toString() }, s);
  await waitFor(`document.body.dataset.ready === "1"`, s, "UI2 ready");
  await evaluate(`window.__noReload = true`, s);
  const cards = (pattern) =>
    `[...document.querySelectorAll('#questions form.question')].filter((n) => ${pattern}.test(n.innerText)).length`;
  mark = toOwner().length;
  text(OWNER, "MARK-ASK please ask");
  const question = await lastTo(/MARK-Q Pick a colour/, "question notice", mark);
  await waitFor(`${cards("/MARK-Q/")} === 1`, s, "UI2 question card");
  if (!buttons(question).some((btn) => btn.text === "red") || !buttons(question).some((btn) => btn.text === "blue"))
    throw Error("Question buttons missing");
  press(OWNER, question, buttons(question).find((btn) => btn.text === "blue").callback_data);
  await lastTo(/ANSWER-ACK blue/, "answer reached coordinator", mark);
  const entry = (await rpc({ action: "show", id: a, chatId: two.id })).inbox.find((item) => item.kind === "question");
  if (entry.result?.text !== "blue") throw Error("Answer not recorded: " + JSON.stringify(entry));
  press(OWNER, question, buttons(question).find((btn) => btn.text === "red").callback_data);
  await lastTo(/already answered/i, "stale button refused", mark);
  if ((await rpc({ action: "show", id: a, chatId: two.id })).inbox.find((item) => item.id === entry.id).result.text !== "blue")
    throw Error("Stale button changed the answer");
  if (!tg.edits.some((e) => e.message_id === question.message_id)) throw Error("Answered question buttons were not removed");
  await waitFor(`window.__noReload && ${cards("/MARK-Q/")} === 0`, s, "UI2 card gone after the Telegram button");
  result.checks.push(
    "T17/T18/T40 a needs-you question arrives with answer buttons; a press records the answer once, wakes the asking chat and drops the open UI2 card without a reload; a stale button is refused",
  );

  // T41/T42: ordinary text to a chat with an open question stays a message; a button answers only its own chat's question.
  await k.ask(a, "main", "MARK-ASK in Main");
  const mainQuestion = (await rpc({ action: "show", id: a })).inbox.find((item) => item.kind === "question" && !item.result);
  mark = toOwner().length;
  text(OWNER, "MARK-ASK again");
  const twoNotice = await lastTo(/Alpha · Two[\s\S]*MARK-Q Pick a colour/, "side chat question notice", mark);
  await waitFor(`${cards("/MARK-Q/")} === 1`, s, "UI2 side chat question card");
  const twoQuestion = (await rpc({ action: "show", id: a })).inbox.find(
    (item) => item.kind === "question" && !item.result && item.id !== mainQuestion.id,
  );
  const twoJobs = (await jobs(a, two.id)).length;
  text(OWNER, "MARK-PLAIN not an answer");
  await lastTo(/Done MARK-PLAIN\./, "plain text reached the chat as a message", mark);
  const stillOpen = (await rpc({ action: "show", id: a })).inbox
    .filter((item) => item.kind === "question" && !item.result)
    .map((item) => item.id);
  assert.deepEqual(stillOpen.sort(), [mainQuestion.id, twoQuestion.id].sort(), "plain text resolves no question");
  assert.equal((await jobs(a, two.id)).length, twoJobs + 1, "plain text admits one ordinary turn");
  assert.equal(await evaluate(cards("/MARK-Q/"), s), 1, "the UI2 card stays after plain text");
  mark = toOwner().length;
  press(OWNER, twoNotice, buttons(twoNotice).find((btn) => btn.text === "blue").callback_data);
  await lastTo(/ANSWER-ACK blue/, "side chat button answer reached its chat", mark);
  await waitFor(`window.__noReload && ${cards("/MARK-Q/")} === 0`, s, "UI2 side chat card gone after the button");
  const afterPress = (await rpc({ action: "show", id: a })).inbox;
  assert.equal(afterPress.find((item) => item.id === twoQuestion.id).result?.text, "blue");
  assert.equal(afterPress.find((item) => item.id === mainQuestion.id).result, null, "Main's question stays open");
  // A paused project defers waking the chat; the UI2 card still goes.
  ui2.searchParams.delete("chat");
  await send("Page.navigate", { url: ui2.toString() }, s);
  await waitFor(`document.body.dataset.ready === "1" && ${cards("/MARK-Q/")} === 1`, s, "UI2 Main question card");
  await evaluate(`window.__noReload = true`, s);
  await rpc({ action: "pause", id: a });
  const mainNotice = toOwner().findLast((m) => /Alpha · Main/.test(m.text) && /MARK-Q Pick a colour/.test(m.text));
  mark = toOwner().length;
  press(OWNER, mainNotice, buttons(mainNotice).find((btn) => btn.text === "red").callback_data);
  await lastTo(/Answered: red/, "Main answer while paused", mark);
  await waitFor(`window.__noReload && ${cards("/MARK-Q/")} === 0`, s, "UI2 Main card gone while paused");
  await rpc({ action: "resume", id: a, confirm: a });
  result.checks.push(
    "T41/T42 plain text to a chat with open questions stays an ordinary message and resolves none; a side chat button answers only its question and drops its UI2 card; a button answer to a paused project drops its card too",
  );

  // T19: a Job's plan arrives as one progress message edited in place; its Ready message offers Approve, which reaches the host.
  mark = toOwner().length;
  k.hold("plan2");
  k.hold("ready");
  text(OWNER, "MARK-SHIP via telegram");
  const progress = await lastTo(/Step 1/, "plan progress message", mark);
  // Owner replies must arrive while the worker is held, without making unrelated progress noisy.
  await k.ask(a, two.id, "MARK-QUIET unsolicited progress");
  await delay(1000);
  assert.ok(
    !toOwner()
      .slice(mark)
      .some((m) => /Done MARK-QUIET/.test(m.text)),
  );
  text(OWNER, "/project Beta");
  await lastTo(/Beta.*Main/, "changed route while worker runs", mark);
  const direct = text(OWNER, "MARK-DIRECT what is happening?", {
    reply_to_message: { message_id: progress.message_id, chat: OWNER, date: 0, text: progress.text },
  });
  const directReply = await lastTo(/Done MARK-DIRECT\./, "direct reply while worker runs", mark);
  assert.match(directReply.text, /Alpha · Two/);
  assert.equal(buttons(directReply).length, 0, "status replies do not offer an unrelated approval");
  tg.updates.push(direct);
  wake();
  text(OWNER, "MARK-ASK while worker runs", {
    reply_to_message: { message_id: progress.message_id, chat: OWNER, date: 0, text: progress.text },
  });
  const busyQuestion = await lastTo(/MARK-Q Pick a colour/, "question during work", toOwner().length - 1);
  const answerFrom = toOwner().length;
  press(OWNER, busyQuestion, buttons(busyQuestion).find((btn) => btn.text === "blue").callback_data);
  await lastTo(/ANSWER-ACK blue/, "question answer reply during work", answerFrom);
  text(OWNER, "MARK-FAIL explicit failure", {
    reply_to_message: { message_id: progress.message_id, chat: OWNER, date: 0, text: progress.text },
  });
  await lastTo(/Coordinator turn failed/, "direct request failure while worker runs", toOwner().length - 1);
  await delay(1000);
  assert.equal(
    toOwner()
      .slice(mark)
      .filter((m) => /Done MARK-DIRECT\./.test(m.text)).length,
    1,
  );
  text(OWNER, "/project Alpha");
  await lastTo(/Alpha.*Main/, "restore project route", mark);
  text(OWNER, "/chat Two");
  await lastTo(/Alpha.*Two/, "restore chat route", mark);
  result.checks.push(
    "Telegram owner replies arrive once during active work, including reply-to routing and errors, while unsolicited output stays quiet",
  );
  k.release("plan2");
  await eventually(
    async () => tg.edits.some((e) => e.message_id === progress.message_id && /Step 2/.test(e.text)),
    "progress message was not edited on the plan change",
  );
  if (
    toOwner()
      .slice(mark)
      .filter((m) => /Step 1/.test(m.text)).length !== 1
  )
    throw Error("Progress was sent more than once");
  k.release("ready");
  const readyMsg = await lastTo(/Done MARK-JOB\./, "final message", mark);
  await delay(1000);
  assert.equal(
    toOwner()
      .slice(mark)
      .filter((m) => /Done MARK-JOB\./.test(m.text)).length,
    1,
    "one final Job notice",
  );
  const approve = buttons(readyMsg).find((btn) => btn.text === "Approve");
  if (!approve) throw Error("Ready message has no Approve button: " + JSON.stringify(readyMsg));
  mark = toOwner().length;
  press(OWNER, readyMsg, approve.callback_data);
  await lastTo(/Approving/, "approve acknowledged", mark);
  await eventually(
    async () =>
      toOwner()
        .slice(mark)
        .some((m) => !/^Approving/.test(m.text)),
    "no approve outcome reached the owner",
    300,
  );
  result.checks.push(
    "T19 a Job's plan is one progress message edited on each plan change; its Ready message carries Approve and the press reaches the host's Approve",
  );

  // Errors, long results, reply-to routing, paused project.
  mark = toOwner().length;
  text(OWNER, "MARK-FAIL please");
  await lastTo(/error|failed/i, "error notice", mark);
  text(OWNER, "MARK-LONG please");
  const long = await lastTo(/LONG-START/, "long result", mark);
  if (long.text.length > 4096) throw Error("Long message not clipped");
  result.checks.push("T17/T20 a coordinator error is sent; a 6000-character result is clipped under the Telegram limit");
  await k.ask(b, "main", "MARK-BETA hello");
  const betaResult = await lastTo(/Done MARK-BETA\./, "beta result", mark);
  text(OWNER, "MARK-REPLY via reply", {
    reply_to_message: { message_id: betaResult.message_id, chat: OWNER, date: 0, text: betaResult.text },
  });
  await lastTo(/Done MARK-REPLY\./, "reply routed", mark);
  if (
    (await jobs(b)).filter((j) => j.text.includes("MARK-REPLY")).length !== 1 ||
    (await jobs(a, two.id)).some((j) => j.text.includes("MARK-REPLY"))
  )
    throw Error("Reply-to did not route to Beta");
  result.checks.push("T16 reply-to a result routes to that project/chat");

  // T23-T28: Markdown is rendered as Telegram HTML.
  mark = toOwner().length;
  text(OWNER, "MARK-MD render please");
  const md = await lastTo(/Release notes/, "markdown result", mark);
  if (md.parse_mode !== "HTML") throw Error("No parse_mode HTML: " + JSON.stringify(md));
  const want = [
    "<b>Release notes</b>",
    "<b>bold</b>",
    "<i>italic</i>",
    "<i>also italic</i>",
    "<s>gone</s>",
    "<code>a &lt; b &amp;&amp; c</code>",
    "snake_case_name",
    "2*3*4",
    "• first item",
    "• second <b>item</b>",
    "  • nested",
    "1. one",
    "<blockquote>quoted <b>line</b>\nsecond</blockquote>",
    '<a href="https://example.com/a?b=1&amp;c=%22x%22">Docs</a>',
    '<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>',
    "<pre>| a | b |",
    "Tail &lt;script&gt;alert(1)&lt;/script&gt; &amp; done.",
  ];
  const missing = want.filter((part) => !md.text.includes(part));
  if (missing.length || /href="javascript/i.test(md.text) || /\*\*|```|^#/m.test(md.text) || /<(h\d|ul|li|p|br)\b/.test(md.text))
    throw Error("Rendered HTML wrong, missing " + JSON.stringify(missing) + ": " + md.text);
  result.renderedHtml = md.text;
  result.checks.push(
    "T23-T28 a Markdown result is sent with parse_mode HTML: headings bold, bold/italic/strike/code, fenced code as <pre><code class>, lists as •/numbered lines, blockquote, safe links, tables in <pre>, <>& escaped, snake_case untouched",
  );

  // T26/T29/T30: a long code-heavy result is split under 4096 with balanced tags; reply-to on the second part routes.
  mark = toOwner().length;
  tg.failWhen = (input) => String(input.text).startsWith("<pre>"); // part two fails once: the retry must not resend part one
  text(OWNER, "MARK-BIGMD split please");
  await lastTo(/after|l\d{3}/, "big markdown result", mark);
  await delay(1500);
  const parts = toOwner()
    .slice(mark)
    .filter((m) => /BIGMD|l\d{3} a&lt;b/.test(m.text));
  const lines = parts.flatMap((m) => visible(m.text).match(/l\d{3} a<b && c>d;/g) ?? []);
  if (
    parts.length < 2 ||
    parts.some((m) => m.parse_mode !== "HTML" || m.text.length > 4096 || htmlProblem(m.text)) ||
    !parts.slice(1).every((m) => m.text.startsWith("<pre>"))
  )
    throw Error(
      "Split wrong: " + JSON.stringify(parts.map((m) => ({ len: m.text.length, start: m.text.slice(0, 40), mode: m.parse_mode }))),
    );
  if (new Set(lines).size !== lines.length || lines.length < 150) throw Error("Split lost or duplicated lines: " + lines.length);
  text(OWNER, "MARK-REPLY2 to part two", {
    reply_to_message: { message_id: parts[1].message_id, chat: OWNER, date: 0, text: parts[1].text },
  });
  await lastTo(/Done MARK-REPLY2\./, "reply to part two routed", mark);
  result.split = parts.map((m) => m.text.length);
  result.checks.push(
    `T26/T29/T30 a ${lines.length}-line escaped code result (clipped mid-fence by the feed) is split into ${parts.length} HTML parts under 4096 (${result.split.join(", ")}), each balanced, code reopened in <pre>, no line lost or repeated even though part two failed once and was retried; reply-to on part two routes`,
  );
  if (tg.failWhen) throw Error("Part-two failure was not exercised");

  // T31: Telegram refuses the HTML: plain-text fallback, outbox not stuck.
  mark = toOwner().length;
  text(OWNER, "MARK-PARSEFAIL please");
  const plain = await lastTo(/PARSEFAIL plain fallback text/, "plain fallback", mark);
  if (plain.parse_mode || /<\/?b>|\*\*/.test(plain.text) || !tg.refused.some((item) => item.problem === "forced by test"))
    throw Error("Fallback wrong: " + JSON.stringify(plain));
  text(OWNER, "MARK-AFTERFAIL next");
  await lastTo(/Done MARK-AFTERFAIL\./, "next notice after fallback", mark);
  result.checks.push('T31 a 400 "can\'t parse entities" falls back to plain text (markup stripped) once and the outbox moves on');
  const commands = toOwner().filter((m) => /^Now talking to|^Projects:|^Chats in/.test(m.text));
  if (!commands.length || commands.some((m) => m.parse_mode)) throw Error("Command replies must stay plain text");
  result.checks.push("T32 bot command replies stay plain text");

  // T21: outbox retries in order after Bot API failures.
  mark = toOwner().length;
  tg.failSends = 2;
  await k.ask(b, "main", "MARK-RETRY1 one");
  await k.ask(b, "main", "MARK-RETRY2 two");
  await lastTo(/Done MARK-RETRY2\./, "retried notices", mark);
  const order = toOwner()
    .slice(mark)
    .map((m) => m.text)
    .filter((t) => /MARK-RETRY/.test(t));
  if (order.length !== 2 || !order[0].includes("RETRY1")) throw Error("Outbox order/duplicates wrong: " + JSON.stringify(order));
  result.checks.push("T21 notices that fail to send are retried in order, once each");

  // T10: getUpdates failures back off and recover.
  tg.failPolls = 5;
  const pollMark = tg.polls.length;
  wake();
  await eventually(async () => tg.polls.length >= pollMark + 6, "polling did not retry", 300);
  const failing = await rpc({ action: "telegram-snapshot" });
  const gaps = tg.polls
    .slice(pollMark, pollMark + 6)
    .map((p, i, all) => (i ? p.at - all[i - 1].at : 0))
    .slice(1);
  if (!(gaps[3] > gaps[0] * 2) || gaps[0] < 150) throw Error("No backoff: " + JSON.stringify(gaps));
  mark = toOwner().length;
  text(OWNER, "MARK-RECOVER after outage");
  await lastTo(/Done MARK-RECOVER\./, "recovered", mark);
  result.backoffGaps = gaps;
  result.checks.push(
    `T10 a failing Bot API backs off (${gaps.join(", ")} ms) and polling recovers${failing.lastError ? "; the error was visible meanwhile" : ""}`,
  );

  // T8/T9/T17: restart with a rewound offset (crash before persist) replays updates without duplicate effects; no outbound duplicates.
  const before = { alpha: (await jobs(a, two.id)).length, beta: (await jobs(b)).length, sent: toOwner().length };
  const shutdownMs = await k.stopHost();
  if (shutdownMs > 8000) throw Error(`Shutdown waited on the long poll: ${shutdownMs} ms`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.offset = tg1.update_id;
  writeFileSync(file, JSON.stringify(saved, null, 2));
  text(OWNER, "MARK-WHILEDOWN sent while host down");
  await k.startHost();
  await lastTo(/Done MARK-WHILEDOWN\./, "update sent while down", before.sent);
  await delay(2500);
  const after = { alpha: (await jobs(a, two.id)).length, beta: (await jobs(b)).length };
  if (after.alpha !== before.alpha + 1 || after.beta !== before.beta)
    throw Error("Replayed updates admitted twice: " + JSON.stringify({ before, after }));
  const resultsOnce = ["Done MARK-TGONE.", "Done MARK-BETA.", "Done MARK-REPLY.", "Done MARK-WHILEDOWN."].map(
    (t) => toOwner().filter((m) => m.text.includes(t)).length,
  );
  if (resultsOnce.some((n) => n !== 1)) throw Error("Outbound duplicates across restart: " + JSON.stringify(resultsOnce));
  if ((await rpc({ action: "show", id: a, chatId: two.id })).inbox.find((item) => item.id === entry.id).result.text !== "blue")
    throw Error("Replay changed the answer");
  result.checks.push(
    `T8/T9/T11 shutdown does not wait for the long poll (${shutdownMs} ms); after a restart with a rewound offset, replayed updates admit nothing twice, the update sent while down arrives once, and no notice is sent twice`,
  );

  // T15: text to a paused project gets the error back (after the replay check, so the replayed updates do not include it).
  mark = toOwner().length;
  await rpc({ action: "pause", id: a });
  text(OWNER, "MARK-PAUSED while paused");
  await lastTo(/paused/i, "paused error back", mark);
  if ((await jobs(a, two.id)).some((j) => j.text.includes("MARK-PAUSED"))) throw Error("Paused project admitted text");
  await rpc({ action: "resume", id: a, confirm: a });
  result.checks.push("T15 text to a paused project is not admitted and the error comes back to Telegram");

  // T3/T2: switching bots resets pairing and offset; a revoked token stops polling with an error; removing the token stops polling.
  await evaluate(`window.__old = true`, s);
  await send("Page.navigate", { url: await settingsUrl(a) }, s);
  await waitFor(`!window.__old && document.readyState === 'complete'`, s, "page after restart");
  await openTelegram(s);
  // The page left open across the restart polled the new host with its old token (401) until it was reopened with the new address.
  result.httpErrors = result.httpErrors.filter((e) => e.status !== 401);
  await evaluate(`${card}.scrollIntoView()`, s);
  await shot("02-settings-paired", s);
  tg.revoked.add(TOKEN);
  wake();
  await eventually(
    async () => /rejected|unauthorized/i.test((await rpc({ action: "telegram-snapshot" })).lastError ?? ""),
    "revoked token not surfaced",
    300,
  );
  const stopped = tg.polls.filter((p) => p.token === 1).length;
  await delay(1500);
  if (tg.polls.filter((p) => p.token === 1).length > stopped + 1) throw Error("Polling continued with a revoked token");
  tg.revoked.delete(TOKEN);
  await rpc({ action: "telegram-token", token: TOKEN2 });
  const other = await rpc({ action: "telegram-snapshot" });
  if (other.paired || other.botUsername !== "pi_other_bot" || JSON.parse(readFileSync(file, "utf8")).offset !== 0)
    throw Error("Bot switch kept pairing or offset: " + JSON.stringify(other));
  await eventually(async () => tg.polls.some((p) => p.token === 2), "new bot not polled", 100);
  await rpc({ action: "telegram-remove", confirm: "remove" });
  const removedAt = tg.polls.length;
  await delay(1500);
  if (
    tg.polls.length > removedAt + 1 ||
    (await rpc({ action: "telegram-snapshot" })).configured ||
    readFileSync(file, "utf8").includes(TOKEN2)
  )
    throw Error("Polling continued or token kept after removal");
  result.checks.push(
    "T2/T3/T11 a revoked token stops polling with a visible error; another bot resets pairing and offset; removing the bot stops polling and deletes the token",
  );

  // T1: no token in logs; mobile layout.
  await k.stopHost();
  for (const log of k.logs) {
    const content = readFileSync(log, "utf8");
    if (content.includes(TOKEN) || content.includes(TOKEN2)) throw Error("Token in host log " + log);
  }
  await k.startHost();
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await evaluate(`window.__old = true`, s);
  await send("Page.navigate", { url: await settingsUrl(a) }, s);
  await waitFor(`!window.__old && document.readyState === 'complete'`, s, "mobile page");
  await openTelegram(s);
  result.httpErrors = result.httpErrors.filter((e) => e.status !== 401); // same restart window as above
  await evaluate(`${card}.scrollIntoView()`, s);
  if (!(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s))) throw Error("Telegram card overflows at 390px");
  await shot("03-settings-mobile", s);
  result.checks.push("T1/T22 no host log contains a token; the card fits a 390 px screen");
  result.telegram = {
    sent: tg.sent.map((m) => ({ to: m.chat.id, text: m.text.slice(0, 300), buttons: buttons(m).map((btn) => btn.text) })),
    polls: tg.polls.length,
  };
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = k.redact(error?.stack ?? error);
  result.telegram = { sent: tg.sent.map((m) => ({ to: m.chat.id, text: m.text.slice(0, 300) })), polls: tg.polls.length };
}
api.closeAllConnections();
api.close();
await k.finish(result.status);
