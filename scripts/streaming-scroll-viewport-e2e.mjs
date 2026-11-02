// Browser regression for streaming paint cadence, transcript anchoring and the mobile viewport shell.
// Isolated host, deterministic local fake model and real Chrome/CDP input. Mobile metrics are not Safari proof.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, delay, say } from "./lib/e2e-kit.mjs";

const mediaThread = "11111111-1111-4111-8111-111111111111";

const burstText = Array.from({ length: 24 }, (_, i) => `Burst paragraph ${i}: ${"readable text ".repeat(8)}`).join("\n\n");
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
let finishSelectionStream;
const selectionGate = new Promise((resolve) => {
  finishSelectionStream = resolve;
});
const selectionText = "Select this live paragraph while the reply is still running.";
const longBlock = (i) =>
  `## Stable section ${i}\n\nReading marker ${i}. ${"Keep this paragraph readable while later output arrives. ".repeat(8)}\n\n\`\`\`sh\nprintf 'stable code ${i}\\n'\nnpm run check\n\`\`\`\n\n`;
const longPrefix = Array.from({ length: 10 }, (_, i) => longBlock(i)).join("");
const longMiddle =
  Array.from({ length: 20 }, (_, i) => longBlock(i + 10)).join("") + "```text\n" + "growing code line ".repeat(2200) + "\n```\n\n";
const longExtra = Array.from({ length: 20 }, (_, i) => longBlock(i + 70)).join("");
const longText = longPrefix + longMiddle + longExtra;
let continueLong, extendLong, finishLong;
const longGates = [
  new Promise((r) => {
    continueLong = r;
  }),
  new Promise((r) => {
    extendLong = r;
  }),
  new Promise((r) => {
    finishLong = r;
  }),
];
const k = await createKit("streaming-scroll-viewport", {
  handler: async ({ role, user }) => {
    if (role !== "coordinator") return undefined;
    if (user.includes("MARK-LONG"))
      return (async function* () {
        yield chunk({ role: "assistant", content: longPrefix });
        await longGates[0];
        for (let at = 0; at < longMiddle.length; at += 2000) {
          yield chunk({ content: longMiddle.slice(at, at + 2000) });
          await delay(120);
        }
        await longGates[1];
        yield chunk({ content: longExtra });
        await longGates[2];
        yield chunk({}, "stop") + "data: [DONE]\n\n";
      })();
    if (user.includes("MARK-SELECTION"))
      return (async function* () {
        yield chunk({ role: "assistant", content: selectionText });
        await selectionGate;
        yield chunk({ content: " The final paragraph arrived." });
        yield chunk({}, "stop") + "data: [DONE]\n\n";
      })();
    if (user.includes("MARK-BURST")) {
      // Deliberately deliver the entire sequence as one bursty HTTP response.
      return (
        chunk({ role: "assistant", content: "" }) +
        burstText
          .split(/(?<= )/)
          .map((content) => chunk({ content }))
          .join("") +
        chunk({}, "stop") +
        "data: [DONE]\n\n"
      );
    }
    if (user.includes("MARK-NAMED"))
      return say(
        `## Rich reply\n\n${"Long readable reply with **emphasis** and a [link](https://example.invalid). ".repeat(15)}\n\n\`\`\`text\nworker result\n\`\`\`\n\n${user.endsWith(" 79") ? `![Demo](artifact:${mediaThread}/demo.webm)` : ""}`,
      );
    if (user.includes("MARK-FILL")) return undefined;
    return undefined;
  },
});
const { result } = k;
const metrics = async (page) =>
  page.evaluate(`(() => {
  const v = visualViewport, composer = document.querySelector('#compose').getBoundingClientRect();
  const status = document.querySelector('#limits-bar').getBoundingClientRect();
  const send = document.querySelector('#compose button[type="submit"]').getBoundingClientRect();
  return { width: innerWidth, height: innerHeight, visualWidth: v?.width, visualHeight: v?.height,
    visualTop: v?.offsetTop, composerBottom: composer.bottom, sendInside: send.right <= composer.right + 1 && send.bottom <= composer.bottom + 1, statusTop: status.top, statusBottom: status.bottom,
    bodyScroll: document.scrollingElement.scrollTop, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
})()`);
const anchored = async (page) =>
  page.evaluate(`(() => {
  const t = document.querySelector('#transcript'), box = t.getBoundingClientRect();
  const row = [...t.querySelectorAll('[data-index]')].find(n => { const r = n.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
  return row ? { index: row.dataset.index, offset: row.getBoundingClientRect().top - box.top, top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight } : null;
})()`);
const readOlder = async (page) => {
  const box = await page.evaluate(
    `(() => { const t = document.querySelector('#transcript'), r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, deltaY: Math.min(180, t.scrollHeight - t.clientHeight - 80) - t.scrollTop }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...box, deltaX: 0 });
  await delay(150);
  return anchored(page);
};

await k.run(async () => {
  const id = await k.createProject("Streaming and viewport", { grant: false });
  for (let i = 0; i < 34; i++) await k.ask(id, `MARK-FILL ${i}`);
  const otherDir = join(k.root, "other-workspace");
  mkdirSync(otherDir);
  k.initRepo(otherDir);
  const other = await k.createProject("Other long project", { grant: false, cwd: otherDir });
  const longDir = join(k.root, "long-workspace");
  mkdirSync(longDir);
  k.initRepo(longDir);
  const long = await k.createProject("Long project", { grant: false, cwd: longDir });
  for (let i = 0; i < 34; i++) {
    await k.ask(other, `MARK-FILL other ${i} ${"long conversation text ".repeat(20)}`);
    await k.ask(long, `MARK-FILL long ${i} ${"long conversation text ".repeat(20)}`);
  }
  const namedLong = await k.rpc({ action: "chat-create", id: long, title: "Bugs wave 1" });
  const namedOther = await k.rpc({ action: "chat-create", id: other, title: "iPad layout" });
  for (const [project, chat] of [
    [long, namedLong.id],
    [other, namedOther.id],
  ]) {
    for (let i = 0; i < 80; i++) {
      const job = await k.rpc({ action: "message", id: project, chatId: chat, text: `MARK-NAMED ${chat} ${i}` });
      await k.eventually(
        async () => {
          const view = await k.rpc({ action: "show", id: project, chatId: chat });
          return view.jobs.some((item) => item.id === job.id && item.state === "done");
        },
        "named turn settled",
        1200,
      );
    }
  }
  const url = new URL(await k.webUrl(id, "coordinator"));
  url.searchParams.set("e2e", "1");
  const page = await k.openPage(url.toString());
  const video = await page.evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#243056'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText('Demo video', 85, 90);
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' }), parts = [];
    recorder.ondataavailable = event => parts.push(event.data);
    const done = new Promise(resolve => recorder.onstop = resolve); recorder.start();
    await new Promise(resolve => setTimeout(resolve, 200)); recorder.stop(); await done;
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer()); return btoa(String.fromCharCode(...bytes));
  })()`);
  for (const project of [long, other]) {
    const mediaDir = join(k.home, project, "artifacts", mediaThread);
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, "demo.webm"), Buffer.from(video, "base64"));
  }
  await page.waitFor(`document.querySelectorAll('#messages .msg').length >= 20`, "seeded transcript");
  await page.shot("01-desktop", { force: true });
  result.measurements = {};
  const click = async (selector) => {
    const point = await page.evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const openNamed = async (project, chat) => {
    await click(`[data-select-project="${project}"]`);
    await page.waitFor(`!!document.querySelector('[data-action="chat-select"][data-chat="${chat}"]')`, "named chat listed");
    await click(`[data-action="chat-select"][data-chat="${chat}"]`);
    await page.waitFor(
      `document.querySelector('#chat-list .chat.on')?.dataset.chat === '${chat}' && document.querySelector('#messages').innerText.includes('MARK-NAMED ${chat} 79')`,
      "named chat opened",
    );
    await page.waitFor(`!!document.querySelector('#messages video')`, "named chat video hydrated");
    k.check("named fixture has older history", await page.evaluate(`!!document.querySelector('#messages .earlier-messages')`), {
      project,
      chat,
    });
    const count = await page.evaluate(`document.querySelectorAll('#messages [data-index]').length`);
    await page.evaluate(`document.querySelector('#messages .earlier-messages').click()`);
    await page.waitFor(`document.querySelectorAll('#messages [data-index]').length > ${count}`, "older page cached");
    k.check("named fixture retains older history", await page.evaluate(`!!document.querySelector('#messages .earlier-messages')`), {
      project,
      chat,
    });
    await page.evaluate(`document.querySelector('#transcript').scrollTop = document.querySelector('#transcript').scrollHeight`);
    await delay(300);
  };
  await openNamed(long, namedLong.id);
  await openNamed(other, namedOther.id);
  await page.cdp("Network.enable");
  await page.cdp("Network.emulateNetworkConditions", { offline: false, latency: 250, downloadThroughput: -1, uploadThroughput: -1 });
  const switchTab = async (title, chat, shot) => {
    await click(`#tab-strip [data-action="tab-select"][title="${title}"]`);
    await page.waitFor(
      `document.querySelector('#chat-list .chat.on')?.dataset.chat === '${chat}' && document.querySelector('#messages').innerText.includes('MARK-NAMED ${chat} 79')`,
      "top tab selected",
    );
    await delay(300);
    const position = await anchored(page);
    const visible = await page.evaluate(
      `(() => { const t = document.querySelector('#transcript'), box = t.getBoundingClientRect(); const last = [...t.querySelectorAll('[data-index]')].at(-1), r = last.getBoundingClientRect(); return { lastIndex: last.dataset.index, lastTop: r.top, lastBottom: r.bottom, viewportTop: box.top, viewportBottom: box.bottom, text: last.innerText.slice(-120), markers: [...t.querySelectorAll('[data-index]')].filter(n => n.innerText.includes('MARK-NAMED')).slice(-15).map(n => ({ index: n.dataset.index, text: n.innerText.slice(-8) })), bodyScroll: document.scrollingElement.scrollTop }; })()`,
    );
    await page.evaluate(`new Promise(requestAnimationFrame)`);
    const image = await page.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(k.artifacts, `${shot}.png`), Buffer.from(image.data, "base64"));
    return { ...position, visible };
  };
  const tabBack = await switchTab("Long project · Bugs wave 1", namedLong.id, "named-tab-long");
  const tabOther = await switchTab("Other long project · iPad layout", namedOther.id, "named-tab-other");
  result.measurements.namedTabs = { tabBack, tabOther };
  k.check(
    "R0T top-strip named chats in both projects follow newest",
    tabBack.gap < 2 &&
      tabOther.gap < 2 &&
      Math.abs(tabBack.visible.lastBottom - tabBack.visible.viewportBottom) < 2 &&
      Math.abs(tabOther.visible.lastBottom - tabOther.visible.viewportBottom) < 2,
    result.measurements.namedTabs,
  );
  await page.evaluate(`(() => {
    window.__namedHistoryRequests = [];
    window.__namedScrollEvents = [];
    const transcript = document.querySelector('#transcript');
    transcript.addEventListener('scroll', () => window.__namedScrollEvents.push({ top: transcript.scrollTop, height: transcript.clientHeight, total: transcript.scrollHeight, chat: new URL(location.href).searchParams.get('chat'), count: transcript.querySelectorAll('[data-index]').length }));
    const original = window.fetch;
    window.fetch = function(input, init) {
      try { const body = JSON.parse(init?.body); if (body.action === 'chat-history' && body.before != null) window.__namedHistoryRequests.push(body); } catch {}
      return original.apply(this, arguments);
    };
  })()`);
  const tracedBack = await switchTab("Long project · Bugs wave 1", namedLong.id, "named-tab-long-traced");
  const tracedOther = await switchTab("Other long project · iPad layout", namedOther.id, "named-tab-other-traced");
  const namedRequests = await page.evaluate(`window.__namedHistoryRequests`);
  const namedScrollEvents = await page.evaluate(`window.__namedScrollEvents`);
  result.measurements.namedTabsTraced = { tracedBack, tracedOther, namedRequests, namedScrollEvents };
  k.check(
    "R0TN named tab switches do not load older history",
    tracedBack.gap < 2 && tracedOther.gap < 2 && namedRequests.length === 0,
    result.measurements.namedTabsTraced,
  );
  await delay(1000);
  const namedCount = await page.evaluate(`document.querySelectorAll('#messages [data-index]').length`);
  const wheelTarget = await page.evaluate(
    `(() => { const t = document.querySelector('#transcript'), r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, deltaY: -t.scrollTop - 100 }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheelTarget, deltaX: 0 });
  await page.waitFor(`window.__namedHistoryRequests.length === 1`, "intentional wheel requests older history");
  const beforeNamedPage = await anchored(page);
  await page.waitFor(`document.querySelectorAll('#messages [data-index]').length > ${namedCount}`, "wheel older page rendered");
  await delay(150);
  const afterNamedPage = await page.evaluate(
    `(() => { const t = document.querySelector('#transcript'), row = t.querySelector('[data-index="${beforeNamedPage.index}"]'); return { index: row?.dataset.index, offset: row?.getBoundingClientRect().top - t.getBoundingClientRect().top, gap: t.scrollHeight - t.scrollTop - t.clientHeight }; })()`,
  );
  result.measurements.namedWheel = { beforeNamedPage, afterNamedPage, requests: await page.evaluate(`window.__namedHistoryRequests`) };
  await page.shot("named-wheel-anchor", { force: true });
  k.check(
    "R0TW wheel pagination preserves the exact visible message and offset",
    beforeNamedPage.index === afterNamedPage.index &&
      Math.abs(beforeNamedPage.offset - afterNamedPage.offset) < 2 &&
      afterNamedPage.gap > 100,
    result.measurements.namedWheel,
  );
  await page.cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click(`[data-select-project="${id}"]`);
  await page.waitFor(`document.querySelector('#messages').innerText.includes('MARK-FILL 33')`, "original project selected");
  await page.evaluate(`(() => {
    window.__historyRequests = [];
    const fetchOriginal = window.fetch;
    window.fetch = function(input, init) {
      try { const body = JSON.parse(init?.body); if (body.action === 'chat-history') window.__historyRequests.push(body); } catch {}
      return fetchOriginal.apply(this, arguments);
    };
  })()`);
  const selectProject = async (project, title) => {
    const point = await page.evaluate(
      `(() => { const r = document.querySelector('[data-select-project="${project}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    const marker = project === id ? "MARK-FILL 33" : project === long ? "MARK-FILL long 33" : "MARK-FILL other 33";
    await page.waitFor(
      `document.querySelector('#title').textContent === ${JSON.stringify(title)} && document.querySelector('#messages').innerText.includes(${JSON.stringify(marker)})`,
      title,
    );
    await delay(300);
  };
  await selectProject(long, "Long project");
  await selectProject(other, "Other long project");
  await selectProject(long, "Long project");
  const switchBack = await anchored(page);
  const requestsAfterSwitch = await page.evaluate(`window.__historyRequests`);
  result.measurements.projectSwitch = { switchBack, requestsAfterSwitch };
  await page.shot("02-project-switch", { force: true });
  k.check(
    "R0 switching cached long projects follows newest without loading older pages",
    switchBack.gap < 2 && requestsAfterSwitch.length === 0,
    result.measurements.projectSwitch,
  );
  await selectProject(other, "Other long project");
  const otherBottom = await anchored(page);
  const target = await page.evaluate(
    `(() => { const r = document.querySelector('#transcript').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...target, deltaX: 0, deltaY: -otherBottom.top - 100 });
  await page.waitFor(`!document.querySelector('#messages .earlier-messages')`, "scroll loads older history");
  await delay(200);
  const afterScroll = await anchored(page);
  const requestsAfterScroll = await page.evaluate(`window.__historyRequests`);
  result.measurements.scrollOlder = { otherBottom, afterScroll, requestsAfterScroll };
  await page.shot("03-scroll-older", { force: true });
  k.check(
    "R0A scrolling to top loads older history without jumping to newest",
    requestsAfterScroll.length === 1 && afterScroll.gap > 100,
    result.measurements.scrollOlder,
  );
  await selectProject(id, "Streaming and viewport");

  // A trailing user message used to re-enable following on every refresh. Real polling must not do that.
  const beforePoll = await readOlder(page);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: 20, y: 20 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: 20, y: 20 });
  await page.evaluate(`document.querySelector('#refresh').click()`);
  await delay(400);
  const afterPoll = await anchored(page);
  k.check(
    "R1 polling preserves the older-message anchor instead of jumping to a trailing user message",
    beforePoll.index === afterPoll.index && Math.abs(beforePoll.offset - afterPoll.offset) < 2 && afterPoll.gap > 100,
    { beforePoll, afterPoll },
  );
  result.measurements.polling = { beforePoll, afterPoll };

  // Selection is content, not a disposable side effect of a polling render.
  const selection = await page.evaluate(`(() => {
    const text = [...document.querySelectorAll('#messages .msg.them .text p')].find(n => n.getBoundingClientRect().bottom > document.querySelector('#transcript').getBoundingClientRect().top);
    const range = document.createRange(); range.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(range); return s.toString();
  })()`);
  await page.evaluate(`document.querySelector('#refresh').click()`);
  await delay(400);
  k.check(
    "R2 polling preserves text selection and its DOM range",
    (await page.evaluate(`getSelection().toString()`)) === selection && (await page.evaluate(`getSelection().anchorNode.isConnected`)),
    selection.slice(0, 100),
  );
  await page.evaluate(`getSelection().removeAllRanges()`);

  // Late image/markdown growth above the reader must retain the same visible message and offset.
  const beforeMedia = await anchored(page);
  await page.evaluate(`(() => {
    const first = document.querySelector('#messages .msg .text'); const img = document.createElement('img');
    img.alt = 'late deterministic media'; img.style.cssText = 'display:block;width:120px;height:1px'; first.prepend(img);
    requestAnimationFrame(() => { img.style.height = '220px'; });
  })()`);
  await delay(250);
  const afterMedia = await anchored(page);
  k.check(
    "R3 late media sizing preserves the reading anchor",
    beforeMedia.index === afterMedia.index && Math.abs(beforeMedia.offset - afterMedia.offset) < 2,
    { beforeMedia, afterMedia },
  );
  result.measurements.lateMedia = { beforeMedia, afterMedia };

  // Compaction/history pagination inserts above the reader and must retain the same message too.
  const firstText = await page.evaluate(`document.querySelector('#messages .earlier-messages')?.textContent ?? ''`);
  k.check("R4 history pagination is available in the long fixture", /Show earlier/.test(firstText), firstText);
  const beforePage = await anchored(page);
  await page.evaluate(`document.querySelector('#messages .earlier-messages').click()`);
  await page.waitFor(`!document.querySelector('#messages .earlier-messages')`, "older page inserted");
  await delay(150);
  const afterPage = await anchored(page);
  k.check(
    "R5 history pagination preserves the reading anchor",
    beforePage.index === afterPage.index && Math.abs(beforePage.offset - afterPage.offset) < 2,
    { beforePage, afterPage },
  );
  result.measurements.pagination = { beforePage, afterPage };

  // Send through real input/click from an unfollowed reading position. Sending, not scrolling first,
  // must opt back into following. The response is a burst, not a slowed-down fake stream.
  const beforeSend = await anchored(page);
  k.check("R5S send starts from a genuinely unfollowed reading position", beforeSend.gap > 100, beforeSend);
  const composer = await page.evaluate(
    `(() => { const r = document.querySelector('#compose textarea').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...composer });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...composer });
  await page.cdp("Input.insertText", { text: "MARK-BURST" });
  await page.evaluate(`(() => {
    window.__paintBursts = 0; window.__paintObserver = new MutationObserver(() => { window.__paintBursts++; });
    window.__paintObserver.observe(document.querySelector('#live-reply'), { childList: true, subtree: true });
    window.__burstStarted = performance.now();
  })()`);
  const send = await page.evaluate(
    `(() => { const r = document.querySelector('#compose button[type="submit"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...send });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...send });
  await page.waitFor(
    `document.querySelector('#messages').innerText.includes('Burst paragraph 23') && document.querySelector('#live-reply').hidden`,
    "immediate final burst text",
  );
  const burst = await page.evaluate(
    `(() => { window.__paintObserver.disconnect(); const last = [...document.querySelectorAll('#messages .msg.them')].at(-1); return { renders: window.__paintBursts, elapsed: performance.now() - window.__burstStarted, text: last.innerText, bodyText: last.querySelector('.text').innerText }; })()`,
  );
  k.check(
    "R6 bursty SSE is frame-batched rather than one full markdown replacement per delta",
    burst.renders > 0 && burst.renders <= 8,
    burst,
  );
  k.check(
    "R7 final text is committed immediately, without added streaming latency",
    burst.elapsed < 5000 && /Burst paragraph 23/.test(burst.text),
    burst,
  );
  const finalHost = await k.rpc({ action: "show", id });
  const hostText = finalHost.messages.findLast((m) => m.role === "assistant")?.text;
  k.check("R8 browser final exactly matches host transcript", hostText === burstText && burst.bodyText === hostText, {
    elapsed: burst.elapsed,
    hostLength: hostText?.length,
    browserLength: burst.bodyText.length,
  });
  const afterSend = await anchored(page);
  k.check("R8S sending from scrolled-up state resumes following", afterSend.gap < 40, { beforeSend, afterSend });
  result.measurements.burst = burst;

  // Hold only this test stream open so selection happens before the real SSE completion.
  await page.evaluate(`document.querySelector('#compose textarea').focus()`);
  await page.cdp("Input.insertText", { text: "MARK-SELECTION" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(
    `!document.querySelector('#live-reply').hidden && document.querySelector('#live-reply .text p')?.textContent === ${JSON.stringify(selectionText)}`,
    "live selection paragraph",
  );
  await page.evaluate(`(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#live-reply .text p'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  })()`);
  finishSelectionStream();
  await page.waitFor(
    `document.querySelector('#live-reply').hidden && document.querySelector('#messages').innerText.includes('The final paragraph arrived.')`,
    "selected stream commits",
  );
  const settledSelection = await page.evaluate(`(() => {
    const s = getSelection();
    return { expected: ${JSON.stringify(selectionText)}, hidden: document.querySelector('#live-reply').hidden, selected: s.toString(), connected: s.anchorNode?.isConnected === true, inFinal: document.querySelector('#messages').contains(s.anchorNode) };
  })()`);
  const selectedHost = (await k.rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text;
  const selectedBrowser = await page.evaluate(`[...document.querySelectorAll('#messages .msg.them .text')].at(-1).innerText`);
  k.check(
    "R8T selected stream final browser text exactly matches host",
    selectedHost === selectionText + " The final paragraph arrived." && selectedBrowser === selectedHost,
    { selectedHost, selectedBrowser },
  );
  k.check(
    "R8L streaming completion moves selection into the matching committed message",
    settledSelection.hidden &&
      settledSelection.selected === settledSelection.expected &&
      settledSelection.connected &&
      settledSelection.inFinal,
    { ...settledSelection, expected: settledSelection.expected.slice(0, 100), selected: settledSelection.selected.slice(0, 100) },
  );
  await page.evaluate(`getSelection().removeAllRanges()`);

  // Read an early code block while a >4,000-character reply grows past the bounded preview.
  await page.evaluate(`(() => {
    const probe = window.__projectsProbe;
    probe.live.length = 0; probe.markdown.length = 0;
    Object.defineProperty(window, '__liveBudget', { configurable: true, get: () => ({
      frames: probe.live.length,
      maxText: Math.max(0, ...probe.live.map(frame => frame.text.length)),
      maxBytes: Math.max(0, ...probe.live.map(frame => new TextEncoder().encode(JSON.stringify(frame)).length)),
      parses: probe.markdown.filter(call => call.text.startsWith('## Stable section 0')).length,
      maxParseMs: Math.max(0, ...probe.markdown.filter(call => call.text.startsWith('## Stable section 0')).map(call => call.ms)),
    }) });
    document.querySelector('#compose textarea').focus();
  })()`);
  await page.cdp("Input.insertText", { text: "MARK-LONG" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('#live-reply .text')?.innerText.includes('Stable section 9')`, "long prefix visible");
  const longWheel = await page.evaluate(
    `(() => { const t = document.querySelector('#transcript'), r = t.getBoundingClientRect(), code = document.querySelector('#live-reply pre'); window.__readingCode = code; return { x: r.x + r.width / 2, y: r.y + r.height / 2, deltaY: code.getBoundingClientRect().top - r.top - 35 }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...longWheel, deltaX: 0 });
  // Under load the wheel can land late or overshoot: wait for the scroll to settle, then aim the code 35px under the viewport top.
  const codeTop = () =>
    page.evaluate(`window.__readingCode.getBoundingClientRect().top - document.querySelector('#transcript').getBoundingClientRect().top`);
  for (let settled = 0, last = null; settled < 3; await delay(100)) {
    const top = await codeTop();
    settled = top === last ? settled + 1 : 0;
    last = top;
  }
  const missed = (await codeTop()) - 35;
  if (Math.abs(missed) > 1) {
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...longWheel, deltaY: missed, deltaX: 0 });
    await delay(300);
  }
  const beforeLong = await page.evaluate(
    `(() => { const t = document.querySelector('#transcript'), code = window.__readingCode; return { text: code.textContent, top: code.getBoundingClientRect().top, gap: t.scrollHeight - t.scrollTop - t.clientHeight }; })()`,
  );
  k.check(
    "L1 reading starts inside a >4000-character live reply and is unfollowed",
    longPrefix.length > 4000 && beforeLong.gap > 100,
    beforeLong,
  );
  continueLong();
  await page.waitFor(`!document.querySelector('#live-reply .live-limit')?.hidden`, "bounded preview reached");
  const duringLong = await page.evaluate(`(() => {
    const code = window.__readingCode;
    return { text: code.textContent, top: code.getBoundingClientRect().top, connected: code.isConnected, stillFirst: document.querySelector('#live-reply pre') === code, budget: { ...window.__liveBudget }, visible: code.getBoundingClientRect().top >= document.querySelector('#transcript').getBoundingClientRect().top };
  })()`);
  k.check(
    "L2 long stream keeps the same visible code text, DOM node and position, not just scrollTop",
    duringLong.connected &&
      duringLong.stillFirst &&
      duringLong.visible &&
      duringLong.text === beforeLong.text &&
      Math.abs(duringLong.top - beforeLong.top) < 2,
    { beforeLong, duringLong },
  );
  extendLong();
  await delay(1000);
  const capped = await page.evaluate(`({ ...window.__liveBudget })`);
  k.check(
    "L3 preview bounds transport and skips markdown parsing after the cap",
    capped.maxText === 32768 && capped.maxBytes < 40000 && capped.parses === duringLong.budget.parses && capped.maxParseMs < 100,
    { during: duringLong.budget, capped },
  );
  const cappedSelection = await page.evaluate(`(() => {
    const range = document.createRange(); range.selectNodeContents(window.__readingCode);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    return { selected: s.toString(), lastCode: document.querySelector('#live-reply .text pre:last-child')?.textContent.slice(-40) };
  })()`);
  k.check(
    "L3C fixture caps the preview inside an unfinished code line",
    cappedSelection.lastCode && !cappedSelection.lastCode.endsWith("\\n"),
    cappedSelection,
  );
  finishLong();
  await page.waitFor(
    `document.querySelector('#live-reply').hidden && [...document.querySelectorAll('#messages .msg.them')].at(-1)?.innerText.includes('Stable section 0')`,
    "full long reply committed",
  );
  const restoredCode = await page.evaluate(
    `(() => { const s = getSelection(), root = [...document.querySelectorAll('#messages .msg.them .text')].at(-1); return { selected: s.toString(), inFinal: root.contains(s.anchorNode) }; })()`,
  );
  k.check(
    "L3S selected early code survives completion when the preview cap cuts a later code line",
    restoredCode.selected === cappedSelection.selected && restoredCode.inFinal,
    { cappedSelection, restoredCode },
  );
  await page.evaluate(`getSelection().removeAllRanges()`);
  const longHost = (await k.rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text;
  const finalLong = await page.evaluate(
    `(() => { const last = [...document.querySelectorAll('#messages .msg.them .text')].at(-1), expected = document.createElement('div'); expected.innerHTML = window.__projectsRenderMarkdown(${JSON.stringify(longHost)}); return { html: last.innerHTML, expected: expected.innerHTML, text: last.textContent }; })()`,
  );
  k.check(
    "L4 a long reply is stored as its 4000-character preview and the browser matches the rendered host markdown",
    longText.startsWith(longHost.slice(0, -1)) &&
      longHost.length > 3000 &&
      finalLong.html === finalLong.expected &&
      finalLong.text.includes("Stable section 0"),
    { hostLength: longHost?.length, expectedLength: longText.length, browserLength: finalLong.text.length },
  );
  result.measurements.longStream = { beforeLong, duringLong, capped, hostLength: longHost.length };

  // Explicit chat switches intentionally open at newest and must replace selected old-chat content.
  await page.evaluate(
    `(() => { const text = [...document.querySelectorAll('#messages .msg.them .text p')].at(-1); const r = document.createRange(); r.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`,
  );
  const side = await k.rpc({ action: "chat-create", id, title: "Side" });
  await page.waitFor(`!!document.querySelector('[data-action="chat-select"][data-chat="${side.id}"]')`, "side chat");
  await page.evaluate(`document.querySelector('[data-action="chat-select"][data-chat="${side.id}"]').click()`);
  await page.waitFor(`document.querySelector('#chat-list .chat.on')?.dataset.chat === '${side.id}'`, "side selected");
  await page.waitFor(
    `getSelection().isCollapsed && !document.querySelector('#messages').innerText.includes('Burst paragraph 23')`,
    "old selected transcript replaced",
  );
  k.check(
    "R9S explicit chat switch clears selection and never retains old-chat messages",
    await page.evaluate(`getSelection().isCollapsed && !document.querySelector('#messages').innerText.includes('Burst paragraph 23')`),
  );
  await page.evaluate(`document.querySelector('#compose textarea').focus()`);
  await page.cdp("Input.insertText", { text: "MARK-SIDE-DESTINATION" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('#messages').innerText.includes('DONE coordinator')`, "side reply");
  const sideHost = await k.rpc({ action: "show", id, chatId: side.id });
  const mainHost = await k.rpc({ action: "show", id, chatId: "main" });
  k.check(
    "R9D selected chat and send destination agree after switching selected text",
    sideHost.messages.some((m) => m.text === "MARK-SIDE-DESTINATION") &&
      !mainHost.messages.some((m) => m.text === "MARK-SIDE-DESTINATION") &&
      (await page.evaluate(`document.querySelector('#chat-list .chat.on')?.textContent.includes('Side')`)),
    { sideChat: sideHost.chatId, mainChat: mainHost.chatId },
  );
  await page.evaluate(`document.querySelector('[data-action="chat-select"][data-chat="main"]').click()`);
  await page.waitFor(`document.querySelector('#messages').innerText.includes('Burst paragraph 23')`, "main selected");
  const switched = await anchored(page);
  k.check("R9 chat switches follow newest intentionally", switched.gap < 40, switched);

  // Chrome viewport regressions: composer and the separate limits bar both stay in the visual viewport.
  await page.viewport(390, 844, true);
  await delay(150);
  const phone = await metrics(page);
  k.check(
    "V1 phone composer and status bar fit the visual viewport",
    phone.composerBottom <= phone.visualTop + phone.visualHeight - 27 &&
      Math.abs(phone.statusBottom - (phone.visualTop + phone.visualHeight)) < 2 &&
      !phone.horizontalOverflow,
    phone,
  );
  await page.shot("02-phone", { force: true });
  await page.viewport(390, 500, true);
  await delay(150);
  const keyboardSized = await metrics(page);
  k.check(
    "V2 keyboard-sized viewport reanchors both bottom surfaces",
    keyboardSized.composerBottom <= keyboardSized.visualTop + keyboardSized.visualHeight - 27 &&
      Math.abs(keyboardSized.statusBottom - (keyboardSized.visualTop + keyboardSized.visualHeight)) < 2,
    keyboardSized,
  );
  await page.viewport(844, 390, true);
  await delay(150);
  const landscape = await metrics(page);
  k.check(
    "V3 orientation-sized viewport keeps both bars anchored without overflow",
    landscape.composerBottom <= landscape.visualTop + landscape.visualHeight - 27 &&
      landscape.sendInside &&
      Math.abs(landscape.statusBottom - (landscape.visualTop + landscape.visualHeight)) < 2 &&
      !landscape.horizontalOverflow,
    landscape,
  );
  await page.shot("03-landscape", { force: true });
  await page.viewport(1024, 768, true);
  await delay(150);
  const tablet = await metrics(page);
  k.check(
    "V4 tablet viewport shell remains anchored",
    tablet.composerBottom <= tablet.visualTop + tablet.visualHeight - 27 &&
      Math.abs(tablet.statusBottom - (tablet.visualTop + tablet.visualHeight)) < 2,
    tablet,
  );
  await page.shot("04-tablet", { force: true });

  // Override only VisualViewport geometry and dispatch its real resize event. The layout viewport
  // deliberately stays unchanged, reproducing keyboard shrink independently of window resize.
  await page.viewport(900, 768, true);
  await delay(100);
  const independent = await page.evaluate(`(async () => {
    const before = { width: innerWidth, height: innerHeight }; const v = visualViewport;
    Object.defineProperties(v, { height: { configurable: true, value: 430 }, offsetTop: { configurable: true, value: 40 } });
    v.dispatchEvent(new Event('resize')); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const composer = document.querySelector('#compose').getBoundingClientRect(), status = document.querySelector('#limits-bar').getBoundingClientRect();
    return { before, after: { width: innerWidth, height: innerHeight }, visualBottom: v.offsetTop + v.height, composerBottom: composer.bottom, statusBottom: status.bottom };
  })()`);
  k.check(
    "V5 independent visual viewport shrink keeps tablet composer visible without layout resize",
    independent.before.width === independent.after.width &&
      independent.before.height === independent.after.height &&
      independent.composerBottom <= independent.visualBottom - 27 &&
      Math.abs(independent.statusBottom - independent.visualBottom) < 2,
    independent,
  );
  await page.evaluate(`(() => { const v = visualViewport; delete v.height; delete v.offsetTop; v.dispatchEvent(new Event('resize')); })()`);

  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.viewport(1180, 820, true);
  await delay(150);
  const wideTablet = await page.evaluate(
    `(() => { const v = visualViewport; Object.defineProperty(v, 'height', { configurable: true, value: 500 }); v.dispatchEvent(new Event('resize')); return { coarse: matchMedia('(pointer: coarse)').matches, layoutWidth: innerWidth }; })()`,
  );
  await delay(100);
  const wideMetrics = await metrics(page);
  k.check(
    "V6 coarse-pointer landscape tablet above 1024px follows visual viewport",
    wideTablet.coarse &&
      wideTablet.layoutWidth === 1180 &&
      wideMetrics.composerBottom <= wideMetrics.visualTop + wideMetrics.visualHeight - 27 &&
      Math.abs(wideMetrics.statusBottom - (wideMetrics.visualTop + wideMetrics.visualHeight)) < 2,
    { wideTablet, wideMetrics },
  );
  await page.shot("05-wide-tablet", { force: true });
  await page.evaluate(`delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize'))`);
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1440, 1000, false);
  await delay(150);
  const desktop = await metrics(page);
  k.check(
    "V7 fine-pointer desktop retains its layout and visible composer",
    (await page.evaluate(
      `!matchMedia('(pointer: coarse)').matches && getComputedStyle(document.querySelector('.app')).position !== 'fixed'`,
    )) &&
      desktop.composerBottom <= 973 &&
      !desktop.horizontalOverflow,
    desktop,
  );
  result.measurements.viewports = {
    phone,
    keyboardSized,
    landscape,
    tablet,
    independent,
    wideTablet: { ...wideTablet, ...wideMetrics },
    desktop,
  };

  await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  k.check(
    "A1 reduced motion disables live and layout animation",
    await page.evaluate(
      `getComputedStyle(document.querySelector('.live-dot')).animationName === 'none' && getComputedStyle(document.querySelector('.app')).transitionDuration === '0s'`,
    ),
  );
  result.browser = "Chrome with CDP device metrics; this is not iOS Safari verification";
});
