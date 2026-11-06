// Browser E2E: the chat keeps every stored message across compactions (newest-first transcript pages, the inbox at `/`).
// Isolated host, local fake model, headless Chrome; no provider calls. Failure cases: scripts/transcript-compaction-failures.md.
import { kit, delay } from "./notify-kit.mjs";

const brain = { summaries: [], failSummary: false };
const respond = async ({ coordinator, marker, userText, say }) => {
  if (/conversation to summarize/.test(userText) && brain.failSummary) return { error: "SUMMARY-FAIL scripted" };
  if (/conversation to summarize/.test(userText)) {
    brain.summaries.push(userText);
    return say(`SUMMARY-${brain.summaries.length} of the earlier conversation.`);
  }
  if (coordinator && marker === "MARK-FILL") return say(`ok ${/FILL-\d+/.exec(userText)?.[0] ?? ""}`);
  return undefined;
};
const k = await kit("transcript-compaction", {}, respond);
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`);
  result.checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
};

try {
  await k.startHost();
  const id = await k.setup("Hist");
  const show = (chatId) => rpc({ action: "show", id, ...(chatId ? { chatId } : {}) });
  const rev = async () => (await rpc({ action: "settings-snapshot", id })).revision;
  // Manual compaction only (auto off), keeping about the newest message.
  await rpc({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: await rev(),
    changes: { context: { autoCompact: false, contextWindow: 20000, keepRecentTokens: 2000 } },
  });
  const fill = (n) => `MARK-FILL FILL-${n} ${"lorem ipsum dolor sit amet ".repeat(480)}`;
  const compact = async (chatId, count) => {
    await rpc({ action: "compact", id, ...(chatId ? { chatId } : {}) });
    await eventually(
      async () => brain.summaries.length === count && !(await show(chatId)).context.compacting,
      `compaction ${count} did not finish`,
    );
  };
  // Compact after FILL-4 and after FILL-7; FILL-8 arrives after the second compaction.
  for (let n = 1; n <= 4; n++) await k.ask(id, "main", fill(n));
  await compact(undefined, 1);
  for (let n = 5; n <= 7; n++) await k.ask(id, "main", fill(n));
  await compact(undefined, 2);
  await k.ask(id, "main", fill(8));

  // Host API: each stored message once, in order, a divider per compaction, no summary shown as a message.
  const sequence = (list) =>
    list.flatMap((m) => (m.kind === "compaction" ? ["C"] : /FILL-\d+/.test(m.text) ? [`${m.role[0]}${/FILL-\d+/.exec(m.text)[0]}`] : []));
  const expected = [...Array(8).keys()].flatMap((i) => [`uFILL-${i + 1}`, `aFILL-${i + 1}`]);
  let view = await show();
  const seq = sequence(view.messages),
    plain = seq.filter((x) => x !== "C");
  check(
    "T1 every message from before both compactions is in the transcript, once, in order",
    JSON.stringify(plain) === JSON.stringify(expected),
    seq,
  );
  check(
    "T2 a divider per compaction, not at the start: after the summarized turns, before the later ones",
    seq.filter((x) => x === "C").length === 2 &&
      seq[0] !== "C" &&
      seq.indexOf("C") > seq.indexOf("aFILL-1") &&
      seq.indexOf("C") < seq.indexOf("uFILL-5") + 1 &&
      seq.lastIndexOf("C") > seq.indexOf("aFILL-6") &&
      seq.lastIndexOf("C") < seq.indexOf("uFILL-8"),
    seq,
  );
  check("T3 summaries are not shown as messages", !view.messages.some((m) => /SUMMARY-\d|earlier conversation/.test(m.text ?? "")), seq);
  check(
    "T4 the model context is still compacted (display history only)",
    brain.summaries.length === 2 && view.context.tokens < 18000,
    view.context,
  );
  check(
    "T4 the summaries cover the early turns, the second builds on the first summary, not on the stored history",
    /FILL-1\b/.test(brain.summaries[0]) && /SUMMARY-1/.test(brain.summaries[1]) && !/FILL-1\b/.test(brain.summaries[1]),
    brain.summaries.map((text) => text.slice(0, 120)),
  );
  check(
    "T5 entry ids ascend",
    view.messages.every((m, i) => i === 0 || m.entryId >= view.messages[i - 1].entryId),
    view.messages.map((m) => m.entryId),
  );

  // Browser (inbox at `/`): reload and chat switch show the same history with dividers; the divider is understated.
  const web = await rpc({ action: "web" }),
    url = new URL(web.url);
  url.searchParams.set("project", id);
  const s = await openPage(url.toString());
  const dom = `[...document.querySelectorAll('#feed .msg, #feed .divider')].map(n => n.classList.contains('divider') ? 'C' : (n.classList.contains('owner') ? 'u' : 'a') + (/FILL-\\d+/.exec(n.innerText) ?? [''])[0]).filter(x => x === 'C' || x.length > 1)`;
  const dividers = `document.querySelectorAll('#feed .divider').length`;
  await waitFor(`document.body.dataset.ready === "1" && ${dividers} === 2`, s, "dividers after load");
  check(
    "T6 the browser shows the original messages and both dividers in order",
    JSON.stringify(await evaluate(dom, s)) === JSON.stringify(seq),
    await evaluate(dom, s),
  );
  const style = await evaluate(
    `(() => { const d = document.querySelector('#feed .divider'); const r = d.getBoundingClientRect(); return { text: d.innerText.trim(), height: r.height, font: parseFloat(getComputedStyle(d).fontSize), role: d.getAttribute('role') }; })()`,
    s,
  );
  check(
    'T6 the divider reads "Context compacted", is a separator and stays small',
    style.text === "Context compacted" && style.role === "separator" && style.height < 40 && style.font <= 13,
    style,
  );
  await evaluate(`document.querySelectorAll('#feed .divider')[0].scrollIntoView({ block: 'center' })`, s);
  await delay(300);
  await shot("01-history-across-compaction", s);
  await send("Page.reload", {}, s);
  await waitFor(`document.body.dataset.ready === "1" && ${dividers} === 2`, s, "dividers after reload");
  check("T7 a page reload keeps the history", JSON.stringify(await evaluate(dom, s)) === JSON.stringify(seq));
  const side = await rpc({ action: "chat-create", id, title: "Side" });
  await waitFor(`!!document.querySelector('#tree [data-chat="${side.id}"]')`, s, "side chat in the tree");
  await evaluate(`document.querySelector('#tree [data-chat="${side.id}"]').click()`, s);
  await waitFor(
    `${dividers} === 0 && !/FILL-/.test(document.querySelector('#feed').innerText)`,
    s,
    "side chat shows none of the main history",
  );
  await evaluate(`document.querySelector('#tree [data-chat="main"]').click()`, s);
  await waitFor(`${dividers} === 2`, s, "dividers after switching back");
  check("T7 switching chats away and back keeps the history", JSON.stringify(await evaluate(dom, s)) === JSON.stringify(seq));

  // A new message after a reload appears below the dividers without duplicating anything.
  await k.ask(id, "main", fill(9));
  await waitFor(`(${dom}).includes('aFILL-9')`, s, "new message and its answer shown");
  const live = await evaluate(dom, s);
  check(
    "T8 a newer message appears once, after the dividers",
    JSON.stringify(live) === JSON.stringify([...seq, "uFILL-9", "aFILL-9"]),
    live,
  );

  // Past the window the older messages sit behind "Show earlier"; showing them keeps order and dividers.
  for (let n = 10; n <= 20; n++) await k.ask(id, "main", `MARK-FILL FILL-${n} short`);
  view = await show();
  check(
    "T9 the window leaves the oldest messages out and counts them",
    view.before !== null && !sequence(view.messages).includes("uFILL-1") && view.messages.some((m) => m.kind === "compaction"),
    { before: view.before },
  );
  const contextBefore = view.context.tokens;
  await send("Page.reload", {}, s);
  await waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#feed [data-earlier]')`, s, "show earlier button");
  await evaluate(`document.querySelector('#feed [data-earlier]').click()`, s);
  await waitFor(`(${dom}).includes('uFILL-1')`, s, "earlier messages shown");
  const all = await evaluate(dom, s),
    shown = all.filter((x) => x !== "C");
  check(
    "T9 Show earlier reveals the first message and both dividers, in order, once",
    shown[0] === "uFILL-1" &&
      shown.at(-1) === "aFILL-20" &&
      all.filter((x) => x === "C").length === 2 &&
      new Set(shown).size === shown.length,
    all,
  );
  view = await show();
  check("T10 showing history does not change the model context", brain.summaries.length === 2 && view.context.tokens === contextBefore, {
    summaries: brain.summaries.length,
    context: view.context,
  });

  // A failed compaction shows in the status line in words, with its error, and survives a restart; the next summary clears it.
  brain.failSummary = true;
  await rpc({ action: "compact", id });
  await eventually(async () => (await show()).context.compactionFailure, "compaction failure in the snapshot");
  const failure = (await show()).context.compactionFailure;
  const flag = `[...document.querySelectorAll('.sl-item[data-item="context"]')].find(n => /compaction failed/.test(n.innerText))`;
  await waitFor(`!!${flag}`, s, "status line flag");
  const meter = await evaluate(`(() => { const n = ${flag}; return { text: n.innerText, title: n.getAttribute('title') }; })()`, s);
  check(
    "T12 a failed compaction is in the snapshot and the status line says so in text, with its error",
    /SUMMARY-FAIL/.test(failure.error) &&
      /compaction failed/.test(meter.text) &&
      /SUMMARY-FAIL/.test(meter.title ?? "") &&
      brain.summaries.length === 2,
    { failure, meter },
  );
  await shot("02-compaction-failed", s);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(300);
  await shot("03-compaction-failed-390", s);
  await send("Emulation.clearDeviceMetricsOverride", {}, s);
  brain.failSummary = false;

  // A restart keeps the stored history.
  await k.stopHost();
  await k.startHost();
  const items = [];
  for (let page = await show(), before; ; page = await rpc({ action: "chat-history", id, before })) {
    items.unshift(...(page.items ?? page.messages));
    before = page.before;
    if (before === null) break;
  }
  check(
    "T11 after a host restart paging back reaches the whole history and both dividers",
    items.filter((m) => m.kind === "compaction").length === 2 && sequence(items).filter((x) => x !== "C").length === 40,
    sequence(items),
  );
  check("T12 the compaction failure survives a restart", /SUMMARY-FAIL/.test((await show()).context.compactionFailure?.error ?? ""));
  await compact(undefined, 3);
  check("T12 a compaction that produces a summary clears the failure", !(await show()).context.compactionFailure, (await show()).context);
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
