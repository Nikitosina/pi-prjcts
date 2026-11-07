// Browser E2E for full-text search (chats, worker threads, knowledge, uploads; Cmd/Ctrl+K; jump + highlight; 390 px).
// Isolated host, fake model, headless Chrome.
// Failure cases recorded in search-ui-failures.md before implementation.
import { kit, delay } from "./notify-kit.mjs";

const respond = ({ coordinator, userText, results, say, call }) => {
  if (coordinator) {
    const owner = !userText.startsWith("[worker") && !userText.startsWith("[Owner-local event");
    const task = owner && results.length === 0 && /MARK-(WORK|WFAIL|WSTOP)\b/.exec(userText)?.[1];
    if (task)
      return call("agents", {
        action: "spawn",
        role: "worker",
        title: task,
        brief: `${task}-TASK please do it`,
        acceptance: ["done"],
        requestId: `req-${task}`,
      });
    return undefined;
  }
  // The worker's intermediate step says a word that only exists in its own thread.
  if (/WORK-TASK/.test(userText) && results.length === 0)
    return call("projects_knowledge_list", {}).replace(
      '"role":"assistant",',
      '"role":"assistant","content":"Looking around for ibexvortex first.",',
    );
  if (/WORK-TASK/.test(userText)) return say("Worker result: all good.");
  return undefined;
};
const k = await kit("search-ui", {}, respond);
const { result, rpc, eventually, evaluate, waitFor, shot, send } = k;
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`);
  result.checks.push(name);
};
const search = (id, query) => rpc({ action: "search", id, query });
const agents = async (id) => (await rpc({ action: "jobs-snapshot", id })).agents;
const ok = async (id, chatId, text) => {
  const job = await k.ask(id, chatId, text);
  if (job.state !== "done") throw Error(`${text}: ${job.state} ${job.error}`);
  return job;
};
const keyK = (s, target = "document.activeElement || document.body") =>
  evaluate(
    `(${target}).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: navigator.platform.includes('Mac'), ctrlKey: !navigator.platform.includes('Mac'), bubbles: true, cancelable: true }))`,
    s,
  );
const typeQuery = (s, value) =>
  evaluate(
    `(() => { const i = document.querySelector('#palette[open] input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    s,
  );
const key = (s, name) =>
  evaluate(
    `document.querySelector('#palette[open] input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`,
    s,
  );
const rowsExpr = `[...document.querySelectorAll('#palette li[data-index]')].map(n => ({ source: n.querySelector('.muted')?.innerText ?? '', text: n.innerText, on: n.classList.contains('on') })).filter(r => /^(chat|worker|knowledge|upload)$/.test(r.source))`;
const rows = (s) => evaluate(rowsExpr, s);
let s;
try {
  await k.startHost();
  const a = await k.setup("Alpha", k.gitRepo);
  await (async () => {
    const snap = await rpc({ action: "owner-setup-snapshot", id: a });
    await rpc({ action: "workspace-quick-grant", id: a, confirm: a, expectedRevision: snap.workspaceRevision });
  })();
  const two = await rpc({ action: "chat-create", id: a, title: "Two" });
  const three = await rpc({ action: "chat-create", id: a, title: "Three" });
  const webUrl = new URL((await rpc({ action: "web" })).url),
    token = new URLSearchParams(webUrl.hash.slice(1)).get("token");
  k.secrets.push(token);

  // Fixtures: an old turn in chat Two pushed out of the 30-message window, an archived chat, a worker thread, knowledge, a long upload, an HTML-ish message.
  await ok(a, two.id, "MARK-OLD remember the pangolinsaxophone plan");
  for (let n = 0; n < 20; n++) await ok(a, two.id, `MARK-FILL${n} routine update`);
  await ok(a, three.id, "MARK-ARCH note about archivedwombat");
  await rpc({ action: "chat-update", id: a, chatId: three.id, archived: true });
  await ok(a, "main", 'MARK-XSS <img src=x onerror="window.__xss=1"> xssmarmot');
  await ok(a, "main", "MARK-WORK delegate something");
  const worker = await eventually(async () => (await agents(a)).find((agent) => agent.title === "WORK"), "worker did not start");
  await eventually(
    async () =>
      (await rpc({ action: "thread-history", id: a, threadId: worker.id })).items.some((item) => /Worker result/.test(item.text ?? "")),
    "worker did not finish its turn",
  );
  const doc = `# Zoo\n\n${"Plain filler paragraph about nothing in particular.\n\n".repeat(60)}The narwhalcompass points north.\n`;
  await rpc({ action: "knowledge-write", id: a, path: "research/zoo.md", text: doc, expectedRevision: null });
  const big = "lorem ipsum dolor ".repeat(1400) + "capybaraorbit marks the spot " + "tail text ".repeat(200);
  const up = await fetch(`${webUrl.origin}/upload?project=${a}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-filename": "big.txt" },
    body: big,
  }).then((r) => r.json());
  check("fixture upload stored", up.ok, up);
  const bigOffset = big.indexOf("capybaraorbit");

  // S1/S2/S3/S5: one search finds each place, with its location.
  const old = await search(a, "routine pangolinsaxophone");
  check(
    "S1/S5 an old turn of a non-Main chat outside the window is found and outranks common words",
    old.results[0]?.source === "chat" &&
      old.results[0].chatId === two.id &&
      old.results[0].role === "user" &&
      old.results[0].snippet.includes("pangolinsaxophone") &&
      Number.isInteger(old.results[0].index) &&
      old.results.length <= 30,
    old.results.slice(0, 3),
  );
  const arch = await search(a, "archivedwombat");
  check(
    "S1 archived chats are searched",
    arch.results.some((r) => r.source === "chat" && r.chatId === three.id && r.archived === true),
    arch.results,
  );
  const ibex = await search(a, "ibexvortex");
  const workHit = ibex.results.find((r) => r.source === "worker");
  check(
    "S2 a word said only in a worker thread is found in that thread",
    workHit &&
      !ibex.results.some((r) => r.source === "chat") &&
      (await agents(a)).some((agent) => agent.id === workHit.threadId) &&
      workHit.role === "assistant" &&
      /worker/i.test(workHit.label),
    ibex.results,
  );
  const narwhal = await search(a, "narwhalcompass");
  check(
    "S3 knowledge documents are searched",
    narwhal.results[0]?.source === "knowledge" && narwhal.results[0].path === "research/zoo.md",
    narwhal.results,
  );
  const capy = await search(a, "capybaraorbit");
  check(
    "S3 upload text is searched",
    capy.results[0]?.source === "upload" && capy.results[0].uploadId === up.data.id && capy.results[0].filename === "big.txt",
    capy.results,
  );
  check(
    "S3 the upload hit offset is past 20 000 characters, near the word",
    bigOffset > 20000 && Math.abs(capy.results[0].offset - bigOffset) < 1300,
    { offset: capy.results[0].offset, bigOffset },
  );
  const stop = await search(a, "the and of").then(
    () => null,
    (error) => error.message,
  );
  check("S6 a stop-word-only query is refused with an explanation", /at least one word/.test(stop ?? ""), stop);
  check("S6 an unknown word gives an empty list", (await search(a, "nonexistentwordzz")).results.length === 0);
  await rpc({
    action: "knowledge-write",
    id: a,
    path: "research/zoo.md",
    text: "# Zoo\n\nEmptied.\n",
    expectedRevision: (await rpc({ action: "knowledge-read", id: a, path: "research/zoo.md" })).revision,
  });
  check("S3 an edited document stops matching at once", !(await search(a, "narwhalcompass")).results.length);
  await rpc({
    action: "knowledge-write",
    id: a,
    path: "research/zoo.md",
    text: doc,
    expectedRevision: (await rpc({ action: "knowledge-read", id: a, path: "research/zoo.md" })).revision,
  });

  // Browser: the inbox at `/` shows full-text hits in the ⌘K palette (classic search dialog retired 2026-11-04). Choosing a hit does
  // not navigate yet, so S7-S10 (jump to the turn, worker message, document or upload offset) have no browser check; see the failures doc.
  const web = new URL((await rpc({ action: "web" })).url);
  web.searchParams.set("project", a);
  s = await k.openPage(web.toString());
  await waitFor(
    `document.body.dataset.ready === "1" && document.querySelector('#feed')?.innerText.includes('MARK-WORK')`,
    s,
    "page loaded",
  );
  await evaluate(`document.querySelector('#composer-input').focus()`, s);
  await keyK(s);
  await waitFor(`document.querySelector('#palette[open] input') === document.activeElement`, s, "palette focused");
  check("S11 Cmd/Ctrl+K opens search even from the composer, input focused", true);
  await typeQuery(s, "xssmarmot");
  await waitFor(`(${rowsExpr}).length > 0`, s, "xss results");
  check(
    "S4 transcript HTML is shown as text, never run",
    await evaluate(
      `window.__xss === undefined && !document.querySelector('#palette img') && document.querySelector('#palette').innerText.includes('<img')`,
      s,
    ),
  );
  // S12: a later query wins over an earlier one.
  await typeQuery(s, "routine");
  await typeQuery(s, "pangolinsaxophone routine");
  await waitFor(`(${rowsExpr}).some(r => r.text.includes('pangolinsaxophone'))`, s, "old-turn results");
  await delay(800);
  check("S12 the latest query owns the list", (await rows(s))[0].text.includes("pangolinsaxophone"), await rows(s));
  check("S4 rows name their source", (await rows(s))[0].source === "chat", await rows(s));
  await shot("01-search-palette", s);
  const before = await evaluate(`[...document.querySelectorAll('#palette li[data-index]')].findIndex(n => n.classList.contains('on'))`, s);
  await key(s, "ArrowDown");
  const after = await evaluate(`[...document.querySelectorAll('#palette li[data-index]')].findIndex(n => n.classList.contains('on'))`, s);
  check("S11 arrows move the selection", after === before + 1, { before, after });
  await typeQuery(s, "nonexistentwordzz");
  await waitFor(`/Nothing found/.test(document.querySelector('#palette').innerText)`, s, "no matches");
  check("S6 the palette says when nothing matches", true);
  await key(s, "Escape");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`, s);
  await waitFor(`!document.querySelector('#palette[open]')`, s, "palette closed");
  check("S11 Escape closes the palette", true);

  // S13: 390 px.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await keyK(s, "document.body");
  await waitFor(`!!document.querySelector('#palette[open] input')`, s, "mobile palette");
  await typeQuery(s, "routine");
  await waitFor(`(${rowsExpr}).length > 0`, s, "mobile results");
  check(
    "S13 search fits 390 px",
    await evaluate(
      `document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('#palette li[data-index]')].every(n => n.getBoundingClientRect().right <= innerWidth + 1)`,
      s,
    ),
  );
  await shot("02-mobile-palette", s);

  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = k.redact(error?.stack ?? error);
  if (s) {
    try {
      await shot("failure", s);
      result.dom = await evaluate(
        `({ url: location.href, error: document.querySelector('#error')?.innerText, warning: document.querySelector('#warning')?.innerText, palette: document.querySelector('#palette')?.innerHTML.slice(0, 6000) })`,
        s,
      );
    } catch {}
  }
}
await k.finish(result.status);
