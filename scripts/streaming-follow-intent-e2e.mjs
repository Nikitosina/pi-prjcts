// Isolated Chrome regression for follow intent at streaming completion, in the inbox at `/`.
// The fake provider gates completion so each scroll is exercised before the final commit.
import { createKit, delay, say } from "./lib/e2e-kit.mjs";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const prefix = Array.from({ length: 24 }, (_, i) => `Paragraph ${i}: ${"streaming content ".repeat(8)}\n\n`).join("");
const suffix = "\n\nCompletion marker: the answer is complete.";
let release;
const paragraphs = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label} ${i}: ${"transcript content ".repeat(10)}`).join("\n\n");
// The journeys' reply streams one paragraph per `more()`, so each input lands between two known chunks.
const journey = { allowed: 0, done: false, wake: null };
const toolCall = (name, args) => ({ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } });
const calls = (name, args) =>
  chunk({ role: "assistant", tool_calls: [toolCall(name, args)] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
const k = await createKit("streaming-follow-intent", {
  handler: ({ role, user, results }) => {
    if (role === "coordinator" && user.includes("JOURNEY-SEED")) return say(paragraphs("Seed para", 20));
    if (role === "coordinator" && user.includes("JOURNEY-TOOLS")) {
      if (results.length === 0) return calls("bash", { command: "ls" });
      if (results.length === 1) return calls("bash", { command: "pwd" });
      if (results.length === 2) {
        const brief = { action: "spawn", role: "worker", title: "JOURNEY-WORKER", brief: "JOURNEY-WORK read", acceptance: ["done"] };
        return calls("agents", { ...brief, requestId: randomUUID() });
      }
      return say("Tools done.");
    }
    if (role === "coordinator" && user.includes("JOURNEY-STREAM"))
      return (async function* () {
        for (let sent = 0; ;) {
          while (sent < journey.allowed) {
            yield chunk({
              ...(sent === 0 ? { role: "assistant" } : {}),
              content: `${sent ? "\n\n" : ""}J${sent}: ${"streamed words ".repeat(14)}`,
            });
            sent++;
          }
          if (journey.done) break;
          await new Promise((resolve) => (journey.wake = resolve));
        }
        yield chunk({}, "stop") + "data: [DONE]\n\n";
      })();
    if (role === "worker" && user.includes("JOURNEY-WORK"))
      return results.length
        ? say("W-DONE")
        : chunk({ role: "assistant", content: paragraphs("W-START", 20) }) +
            chunk({ tool_calls: [toolCall("bash", { command: "ls" })] }) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n";
    const reply = /JOURNEY-W (\d+)/.exec(user);
    if (role === "worker" && reply) return say(`W-REPLY ${reply[1]}\n\n${paragraphs(`W-REPLY ${reply[1]} part`, 4)}`);
    if (role !== "coordinator" || !user.includes("FOLLOW-CASE")) return undefined;
    return (async function* () {
      for (let at = 0; at < prefix.length; at += 350) {
        yield chunk({ ...(at === 0 ? { role: "assistant" } : {}), content: prefix.slice(at, at + 350) });
        await delay(80);
      }
      await new Promise((resolve) => {
        release = resolve;
      });
      yield chunk({ content: suffix });
      yield chunk({}, "stop") + "data: [DONE]\n\n";
    })();
  },
});
const gap = (page) =>
  page.evaluate(
    `(() => { const t = document.querySelector('#feed'); return { top: t.scrollTop, gap: t.scrollHeight - t.clientHeight - t.scrollTop, height: t.scrollHeight }; })()`,
  );

await k.run(async () => {
  const id = await k.createProject("Follow intent", { grant: false });
  await k.ask(id, "Seed transcript");
  const page = await k.openPage(await k.webUrl(id));
  await page.waitFor(
    `document.body.dataset.ready === "1" && document.querySelector('#feed').innerText.includes('Seed transcript')`,
    "composer ready",
  );
  const failures = [];
  for (const scenario of ["pinned", "near-bottom-up", "programmatic"]) {
    release = undefined;
    const frames = join(k.artifacts, `frames-${scenario}`);
    mkdirSync(frames);
    const timestamps = [];
    let recording = true;
    const capture = (async () => {
      while (recording) {
        const started = Date.now();
        const measurement = await gap(page);
        const image = await page.cdp("Page.captureScreenshot", { format: "jpeg", quality: 75 });
        const name = `${String(timestamps.length).padStart(5, "0")}.jpg`;
        writeFileSync(join(frames, name), Buffer.from(image.data, "base64"));
        timestamps.push({ name, at: started, ...measurement });
        await delay(Math.max(0, 100 - (Date.now() - started)));
      }
    })();
    await page.evaluate(`document.querySelector('#composer-input').focus()`);
    await page.cdp("Input.insertText", { text: `FOLLOW-CASE ${scenario}` });
    await page.evaluate(`document.querySelector('#composer').requestSubmit()`);
    await page.waitFor(`document.querySelector('#live-turn')?.innerText.includes('Paragraph 23')`, `${scenario} stream`);
    await k.waitFor(() => release, "provider gate", { interval: 100 });
    await delay(300);
    let programmaticGap = null;
    if (scenario === "near-bottom-up") {
      const point = await page.evaluate(
        `(() => { const r = document.querySelector('#feed').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -20 });
      await delay(300);
    } else if (scenario === "programmatic") {
      programmaticGap = await page.evaluate(
        `(() => { const t = document.querySelector('#feed'); t.scrollTop -= 20; return t.scrollHeight - t.clientHeight - t.scrollTop; })()`,
      );
      await delay(300);
    }
    const before = await gap(page);
    await delay(600);
    release();
    await page.waitFor(
      `!document.querySelector('#live-turn .streaming') && [...document.querySelectorAll('#feed .msg.agent')].at(-1)?.innerText.includes('Completion marker:')`,
      `${scenario} completion`,
    );
    await delay(1000);
    const after = await gap(page);
    if (scenario === "pinned") {
      await page.evaluate(
        `(() => { const image = document.createElement('img'); image.alt = 'late layout fixture'; image.style.cssText = 'display:block;width:120px;height:1px'; document.querySelector('#feed .msg.agent').prepend(image); requestAnimationFrame(() => { image.style.height = '180px'; }); })()`,
      );
      await delay(300);
    }
    const afterLayout = await gap(page);
    recording = false;
    await capture;
    writeFileSync(join(k.artifacts, `${scenario}-trace.json`), JSON.stringify(timestamps, null, 2));
    const concat =
      timestamps
        .map((f, i) => `file '${join(frames, f.name)}'\nduration ${((timestamps[i + 1]?.at ?? Date.now()) - f.at) / 1000}\n`)
        .join("") + `file '${join(frames, timestamps.at(-1).name)}'\n`;
    const list = join(k.artifacts, `${scenario}.concat`);
    writeFileSync(list, concat);
    const video = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vsync",
        "vfr",
        "-pix_fmt",
        "yuv420p",
        join(k.artifacts, `${scenario}.mp4`),
      ],
      { encoding: "utf8" },
    );
    if (video.status !== 0) throw Error(`ffmpeg: ${video.stderr}`);
    const host = (await k.rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text;
    const expected = prefix + suffix;
    const browserMatches = await page.evaluate(
      `(() => { const text = [...document.querySelectorAll('#feed .msg.agent')].at(-1).innerText; return text.includes('Paragraph 0:') && text.includes('Paragraph 23:') && text.includes('Completion marker: the answer is complete.'); })()`,
    );
    const fixture =
      scenario === "pinned"
        ? before.gap < 2
        : scenario === "programmatic"
          ? programmaticGap > 5 && programmaticGap < 40
          : before.gap > 5 && before.gap < 40;
    const follows = scenario === "near-bottom-up" ? after.gap > 5 && Math.abs(after.top - before.top) < 3 : after.gap < 3;
    const ok = fixture && follows && (scenario !== "pinned" || afterLayout.gap < 3) && host === expected && browserMatches;
    k.result.measurements ??= {};
    k.result.measurements[scenario] = {
      before,
      after,
      afterLayout,
      programmaticGap,
      fixture,
      follows,
      hostMatches: host === expected,
      browserMatches,
      video: `${scenario}.mp4`,
    };
    if (!ok) failures.push(scenario);
    else k.result.checks.push(`${scenario}: completion and follow intent`);
  }
  k.check("all follow intent cases", failures.length === 0, { failures, measurements: k.result.measurements });

  // Journeys F5-F10: trusted wheel, mouse and key input on the Coordinator and worker transcripts while a gated reply streams.
  k.initRepo();
  const journeyId = await k.createProject("Follow journeys");
  await k.ask(journeyId, "JOURNEY-SEED");
  await k.settle(journeyId);
  await k.ask(journeyId, "JOURNEY-TOOLS");
  await k.settle(journeyId);
  const worker = await k.eventually(
    async () => (await k.rpc({ action: "jobs-snapshot", id: journeyId })).agents?.find((agent) => agent.title === "JOURNEY-WORKER"),
    "journey worker",
  );
  await k.settle(journeyId);
  await page.navigate(await k.webUrl(journeyId));
  await page.waitFor(
    `document.body.dataset.ready === "1" && document.querySelector('#feed').innerText.includes('Tools done.') && document.querySelector('#feed').innerText.includes('Seed para 19')`,
    "journey transcript",
  );
  const json = JSON.stringify;
  const frames = () => page.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
  const at = (selector) =>
    page.evaluate(
      `(() => { const t = document.querySelector(${json(selector)}); return { top: Math.round(t.scrollTop), gap: Math.round(t.scrollHeight - t.clientHeight - t.scrollTop), height: t.scrollHeight }; })()`,
    );
  // A scroll started by input has ended once its position holds for five frames.
  const rest = (selector) =>
    page.evaluate(
      `new Promise((done) => { const t = document.querySelector(${json(selector)}); let last = -1, same = 0; const tick = () => { same = t.scrollTop === last ? same + 1 : 0; last = t.scrollTop; same >= 5 ? done() : requestAnimationFrame(tick); }; tick(); })`,
    );
  const center = (selector) =>
    page.evaluate(
      `(() => { const r = document.querySelector(${json(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 200)) }; })()`,
    );
  const wheel = async (selector, deltaY) => {
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...(await center(selector)), deltaX: 0, deltaY });
    await rest(selector);
  };
  const mouse = (type, point, extra = {}) =>
    page.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  const clickAt = async (point) => {
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await mouse("mousePressed", point);
    await mouse("mouseReleased", point);
  };
  const key = async (name, code, keyCode) => {
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: keyCode });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode });
  };
  const more = async (count = 1) => {
    journey.allowed += count;
    journey.wake?.();
    await page.waitFor(
      `document.querySelector('#live-turn')?.innerText.includes('J${journey.allowed - 1}:')`,
      `chunk ${journey.allowed - 1}`,
    );
    await frames();
  };
  // The first turn crossing the top edge of a transcript and its offset there: the place a reader keeps.
  const reading = (selector) =>
    page.evaluate(
      `(() => { const t = document.querySelector(${json(selector)}), top = t.getBoundingClientRect().top; const turn = [...t.querySelectorAll(':scope > .turn[data-key]')].find((node) => node.getBoundingClientRect().bottom > top + 1); return { key: turn?.dataset.key, offset: Math.round(turn.getBoundingClientRect().top - top) }; })()`,
    );
  const visibleToggle = (selector) =>
    page.evaluate(
      `(() => { const t = document.querySelector(${json(selector)}), box = t.getBoundingClientRect(); const line = [...t.querySelectorAll('[data-toggle]')].filter((node) => !node.closest('#live-turn')).findLast((node) => { const r = node.getBoundingClientRect(); return r.top > box.top + 4 && r.bottom < box.bottom - 4; }); if (!line) return null; const r = line.getBoundingClientRect(); return { key: line.dataset.toggle, x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) }; })()`,
    );
  const toggleTop = (selector, key) =>
    page.evaluate(
      `Math.round(document.querySelector(${json(selector)}).querySelector('[data-toggle="' + CSS.escape(${json(key)}) + '"]').getBoundingClientRect().top)`,
    );
  // Fixture checks stop the run; contract checks are collected, so a red run lists every broken contract.
  const broken = [];
  const journeyCheck = (name, ok, details) => (ok ? k.result.checks.push(name) : broken.push({ name, details }));

  await page.evaluate(`document.querySelector('#composer-input').focus()`);
  await page.cdp("Input.insertText", { text: "JOURNEY-STREAM go" });
  await key("Enter", "Enter", 13);
  await more(1);
  journeyCheck("F at the bottom the stream is followed", (await at("#feed")).gap < 3, await at("#feed"));

  // F8: opening a detail keeps its line under the pointer and stops following.
  const detail = await visibleToggle("#feed");
  k.check("F8 fixture: a detail line is on screen at the bottom", !!detail, detail);
  const closed = await toggleTop("#feed", detail.key);
  await clickAt(detail);
  await page.waitFor(
    `document.querySelector('#feed [data-toggle="' + CSS.escape(${json(detail.key)}) + '"]')?.getAttribute('aria-expanded') === 'true'`,
    "detail open",
  );
  await frames();
  const opened = await toggleTop("#feed", detail.key);
  await more(1);
  const afterChunk = await toggleTop("#feed", detail.key);
  journeyCheck("F8 the opened line stays under the pointer", Math.abs(opened - closed) < 2 && Math.abs(afterChunk - opened) < 2, {
    detail,
    closed,
    opened,
    afterChunk,
  });

  // F7: scrolling back down to the end resumes following.
  await wheel("#feed", 100000);
  k.check("F7 fixture: the wheel reached the bottom", (await at("#feed")).gap < 2, await at("#feed"));
  await more(1);
  journeyCheck("F7 back at the bottom the stream is followed again", (await at("#feed")).gap < 3, await at("#feed"));

  // F5: the draft grows in the same frame a chunk is pinned, so the pin's scroll event arrives after the layout changed.
  await page.evaluate(`(() => {
    const box = document.querySelector('#composer-input');
    const once = new MutationObserver(() => { once.disconnect(); box.value = 'draft line\\n'.repeat(8); box.dispatchEvent(new Event('input')); });
    once.observe(document.querySelector('#feed'), { childList: true, subtree: true, characterData: true });
  })()`);
  await more(1);
  await frames();
  const grown = await at("#feed");
  await more(1);
  journeyCheck("F5 a transcript that shrinks while followed stays at the newest line", grown.gap < 3, grown);
  journeyCheck("F5 the late scroll event does not stop following", (await at("#feed")).gap < 3, await at("#feed"));
  await page.evaluate(
    `(() => { const box = document.querySelector('#composer-input'); box.value = ''; box.dispatchEvent(new Event('input')); })()`,
  );
  await page.viewport(900, 1000);
  await frames();
  const narrowed = await at("#feed");
  await more(1);
  journeyCheck("F5 a narrower window keeps following", narrowed.gap < 3 && (await at("#feed")).gap < 3, {
    narrowed,
    after: await at("#feed"),
  });
  await page.viewport(1440, 1000);
  await frames();
  await more(1);

  // F6: a drag up stops following. Headless Chrome on macOS has overlay scrollbars, so this drags a text selection past the top
  // edge, which scrolls the transcript up while the button is held.
  const edge = await page.evaluate(
    `(() => { const r = document.querySelector('#feed').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60), above: Math.round(r.top - 20) }; })()`,
  );
  const beforeDrag = await at("#feed");
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: edge.x, y: edge.y });
  await mouse("mousePressed", edge);
  for (let y = edge.y - 20; y >= edge.above; y -= 20) await mouse("mouseMoved", { x: edge.x, y });
  await mouse("mouseMoved", { x: edge.x, y: edge.above });
  await page.waitFor(`document.querySelector('#feed').scrollTop < ${beforeDrag.top - 80}`, "selection drag scrolls up");
  await mouse("mouseReleased", { x: edge.x, y: edge.above });
  await rest("#feed");
  const dragged = await at("#feed");
  k.check("F6 fixture: the drag moved the transcript up", dragged.top < beforeDrag.top - 40, { beforeDrag, dragged });
  await more(1);
  journeyCheck("F6 the next chunk leaves the dragged position", Math.abs((await at("#feed")).top - dragged.top) < 2, {
    dragged,
    after: await at("#feed"),
  });
  await wheel("#feed", 100000);
  await more(1);

  // F12: a scroll the browser makes far up on the reader's behalf (find in page, a link into the transcript) stops following.
  const found = await page.evaluate(
    `(() => { const t = document.querySelector('#feed'), line = [...t.querySelectorAll('.msg.agent p')].find((node) => node.innerText.startsWith('Seed para 12:')); const was = Math.round(line.getBoundingClientRect().top - t.getBoundingClientRect().top); line.scrollIntoView({ block: 'start' }); return { was, top: Math.round(t.scrollTop), gap: Math.round(t.scrollHeight - t.clientHeight - t.scrollTop) }; })()`,
  );
  k.check("F12 fixture: the found line took the view far up", found.gap > 300, found);
  await rest("#feed");
  await more(1);
  journeyCheck("F12 the next chunk leaves the found line in view", Math.abs((await at("#feed")).top - found.top) < 2, {
    found,
    after: await at("#feed"),
  });
  await wheel("#feed", 100000);
  await more(1);

  // F9: a worker visit leaves the Coordinator transcript as it was, following or read.
  const openWorker = async () => {
    await page.waitFor(
      `(document.querySelector('#workers [data-worker-history][aria-expanded="false"]')?.click(), !!document.querySelector('#workers [data-open-worker="${worker.id}"]'))`,
      "worker listed",
    );
    await clickAt(await center(`#workers [data-open-worker="${worker.id}"]`));
    await page.waitFor(`document.querySelector('#worker-feed')?.innerText.includes('W-START 19')`, "worker transcript");
    await frames();
  };
  const back = async () => {
    await key("Escape", "Escape", 27);
    await page.waitFor(`!document.querySelector('#chat-view').hidden`, "back to chat");
    await frames();
  };
  journeyCheck("F9 following before the visit", (await at("#feed")).gap < 3, await at("#feed"));
  await openWorker();
  await more(2);
  const workerDetail = await visibleToggle("#worker-feed");
  k.check("F9 fixture: a worker detail line is on screen", !!workerDetail, workerDetail);
  await clickAt(workerDetail);
  await page.waitFor(
    `document.querySelector('#worker-feed [data-toggle="' + CSS.escape(${json(workerDetail.key)}) + '"]')?.getAttribute('aria-expanded') === 'true'`,
    "worker detail open",
  );
  await back();
  const returned = await at("#feed");
  await more(1);
  journeyCheck("F9 back from a worker the reply that arrived meanwhile is in view", returned.gap < 3, returned);
  journeyCheck("F9 a worker detail does not stop the Coordinator's following", (await at("#feed")).gap < 3, await at("#feed"));
  await wheel("#feed", -700);
  const read = await reading("#feed");
  k.check("F9 fixture: the reader left the bottom", (await at("#feed")).gap > 300, await at("#feed"));
  await openWorker();
  await more(2);
  await back();
  journeyCheck(
    "F9 a reader returns to the same place",
    (await reading("#feed")).key === read.key && Math.abs((await reading("#feed")).offset - read.offset) < 2,
    {
      read,
      after: await reading("#feed"),
    },
  );
  journey.done = true;
  journey.wake?.();
  await k.settle(journeyId);

  // F10: the worker transcript follows its new turns at the bottom and leaves a reader who scrolled up a little. The detail opened in
  // F9 stopped its following, and the view returns there (F14), so the reader first goes to the bottom.
  await openWorker();
  await wheel("#worker-feed", 100000);
  const workerTurn = async (n) => {
    await k.rpc({ action: "thread-send", id: journeyId, threadId: worker.id, requestId: randomUUID(), text: `JOURNEY-W ${n}` });
    await page.waitFor(`document.querySelector('#worker-feed').innerText.includes('W-REPLY ${n} part 3')`, `worker reply ${n}`);
    await frames();
    return at("#worker-feed");
  };
  journeyCheck("F10 the worker transcript follows a new turn at the bottom", (await workerTurn(1)).gap < 3, await at("#worker-feed"));
  await wheel("#worker-feed", -20);
  const nudged = await at("#worker-feed");
  k.check("F10 fixture: the reader is a little above the bottom", nudged.gap > 5 && nudged.gap < 40, nudged);
  const kept = await workerTurn(2);
  journeyCheck("F10 a reader a little above the bottom stays in place", Math.abs(kept.top - nudged.top) < 2, { nudged, kept });
  await wheel("#worker-feed", 100000);
  journeyCheck("F10 back at the bottom the worker transcript follows again", (await workerTurn(3)).gap < 3, await at("#worker-feed"));
  // F14: a reader of the worker transcript returns to the same place after a visit to the Coordinator.
  await wheel("#worker-feed", -700);
  const workerRead = await reading("#worker-feed");
  k.check("F14 fixture: the worker reader left the bottom", (await at("#worker-feed")).gap > 300, await at("#worker-feed"));
  await back();
  await openWorker();
  journeyCheck(
    "F14 a worker reader returns to the same place",
    (await reading("#worker-feed")).key === workerRead.key && Math.abs((await reading("#worker-feed")).offset - workerRead.offset) < 2,
    { workerRead, after: await reading("#worker-feed") },
  );
  await page.shot("journey-worker", { force: true });
  k.check("journeys keep their follow contracts", broken.length === 0, broken);
});
