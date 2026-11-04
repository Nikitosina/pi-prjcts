// Browser regression for transcript anchoring and the mobile shell in the inbox at `/`. Isolated host, deterministic local fake model
// and real Chrome/CDP input. Mobile metrics are not Safari proof. Failure cases: streaming-scroll-viewport-failures.md (the classic
// client's paint cadence, refresh button and in-place history paging were retired with it on 2026-11-04).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createKit, delay } from "./lib/e2e-kit.mjs";

const burstText = Array.from({ length: 24 }, (_, i) => `Burst paragraph ${i}: ${"readable text ".repeat(8)}`).join("\n\n");
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const k = await createKit("streaming-scroll-viewport", {
  handler: async ({ role, user }) => {
    if (role !== "coordinator") return undefined;
    if (user.includes("MARK-BURST"))
      // The entire reply as one bursty HTTP response.
      return (
        chunk({ role: "assistant", content: "" }) +
        burstText
          .split(/(?<= )/)
          .map((content) => chunk({ content }))
          .join("") +
        chunk({}, "stop") +
        "data: [DONE]\n\n"
      );
    return undefined;
  },
});
const { result } = k;
// Markdown paragraphs as rendered: trailing spaces of a paragraph are not text.
const paragraphs = (text) =>
  text
    .split(/\n\n/)
    .map((part) => part.trim())
    .join("\n\n");
// The first transcript turn visible in the feed, its offset from the feed's top, and the distance to the bottom.
const anchored = (page) =>
  page.evaluate(`(() => {
  const t = document.querySelector('#feed'), box = t.getBoundingClientRect();
  const row = [...t.querySelectorAll('.turn[data-key]')].find(n => { const r = n.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
  return { key: row?.dataset.key ?? null, offset: row ? row.getBoundingClientRect().top - box.top : null, top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight };
})()`);
const wheel = async (page, deltaY) => {
  const box = await page.evaluate(
    `(() => { const r = document.querySelector('#feed').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...box, deltaX: 0, deltaY });
  await delay(250);
};

await k.run(async () => {
  const id = await k.createProject("Streaming and viewport", { grant: false });
  for (let i = 0; i < 34; i++) await k.ask(id, `MARK-FILL ${i}`);
  const otherDir = join(k.root, "other-workspace");
  mkdirSync(otherDir);
  k.initRepo(otherDir);
  const other = await k.createProject("Other long project", { grant: false, cwd: otherDir });
  for (let i = 0; i < 34; i++) await k.ask(other, `MARK-FILL other ${i} ${"long conversation text ".repeat(20)}`);
  const page = await k.openPage(await k.webUrl(id));
  await page.waitFor(`document.body.dataset.ready === "1" && document.querySelectorAll('#feed .turn').length >= 10`, "seeded transcript");
  await page.shot("01-desktop", { force: true });
  result.measurements = {};
  await page.evaluate(`(() => {
    window.__historyRequests = [];
    const fetchOriginal = window.fetch;
    window.fetch = function(input, init) {
      try { const body = JSON.parse(init?.body); if (body.action === 'chat-history') window.__historyRequests.push(body); } catch {}
      return fetchOriginal.apply(this, arguments);
    };
  })()`);
  const selectProject = async (project, marker) => {
    const point = await page.evaluate(
      `(() => { const r = document.querySelector('#tree .tree-head[data-project="${project}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await page.waitFor(`document.querySelector('#feed').innerText.includes(${JSON.stringify(marker)})`, marker);
    await delay(300);
  };

  // R0: switching projects shows the newest messages and loads no older pages by itself.
  await selectProject(other, "MARK-FILL other 33");
  await selectProject(id, "MARK-FILL 33");
  await selectProject(other, "MARK-FILL other 33");
  const switched = await anchored(page);
  const requestsAfterSwitch = await page.evaluate(`window.__historyRequests.length`);
  result.measurements.projectSwitch = { switched, requestsAfterSwitch };
  k.check("R0 switching long projects follows newest without loading older pages", switched.gap < 2 && requestsAfterSwitch === 0, {
    switched,
    requestsAfterSwitch,
  });

  // R0A/R4: Show earlier loads one older page on request and does not jump to the newest.
  k.check("R4 history paging is offered in the long fixture", await page.evaluate(`!!document.querySelector('#feed [data-earlier]')`));
  await page.evaluate(`document.querySelector('#feed [data-earlier]').click()`);
  await page.waitFor(`window.__historyRequests.length === 1`, "older page requested");
  await delay(300);
  const afterEarlier = await anchored(page);
  k.check("R0A Show earlier loads one older page without jumping to newest", afterEarlier.gap > 100, afterEarlier);
  await page.shot("02-show-earlier", { force: true });
  await selectProject(id, "MARK-FILL 33");

  // R1/R2: while the owner reads older messages, a new exchange arriving keeps their place and their selection.
  await wheel(page, -600);
  const beforeArrival = await anchored(page);
  const selection = await page.evaluate(`(() => {
    const box = document.querySelector('#feed').getBoundingClientRect();
    const text = [...document.querySelectorAll('#feed .msg.agent .prose p')].find(n => { const r = n.getBoundingClientRect(); return r.top > box.top && r.bottom < box.bottom; });
    const range = document.createRange(); range.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(range); return s.toString();
  })()`);
  await k.ask(id, "MARK-ARRIVAL while reading");
  await page.waitFor(`document.querySelector('#feed').innerText.includes('MARK-ARRIVAL')`, "new exchange rendered");
  await delay(400);
  const afterArrival = await anchored(page);
  result.measurements.arrival = { beforeArrival, afterArrival };
  k.check(
    "R1 a new exchange keeps the reading anchor instead of jumping to the newest",
    beforeArrival.gap > 100 && beforeArrival.key === afterArrival.key && Math.abs(beforeArrival.offset - afterArrival.offset) < 2,
    result.measurements.arrival,
  );
  k.check(
    "R2 a re-render keeps the text selection and its DOM range",
    selection.length > 0 &&
      (await page.evaluate(`getSelection().toString()`)) === selection &&
      (await page.evaluate(`getSelection().anchorNode.isConnected`)),
    selection.slice(0, 100),
  );
  await page.evaluate(`getSelection().removeAllRanges()`);

  // R8S/R8: sending from a scrolled-up position opts back into following; the final text matches the host.
  const beforeSend = await anchored(page);
  k.check("R5S send starts from a genuinely unfollowed reading position", beforeSend.gap > 100, beforeSend);
  await page.evaluate(`document.querySelector('#composer-input').focus()`);
  await page.cdp("Input.insertText", { text: "MARK-BURST" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor(
    `!document.querySelector('#live-turn .streaming') && [...document.querySelectorAll('#feed .msg.agent')].at(-1)?.innerText.includes('Burst paragraph 23')`,
    "final burst text",
  );
  await k.settle(id);
  await delay(400);
  const afterSend = await anchored(page);
  k.check("R8S sending from a scrolled-up position resumes following", afterSend.gap < 3, afterSend);
  const host = (await k.rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text ?? "";
  const shown = await page.evaluate(
    `[...[...document.querySelectorAll('#feed .msg.agent')].at(-1).querySelectorAll('.prose p')].map(p => p.textContent).join('\\n\\n')`,
  );
  k.check("R8 the browser's final text matches the host transcript", host.trim() === burstText.trim() && shown === paragraphs(host), {
    host: host.length,
    shown: shown.length,
  });

  // R9/R9S: switching chats follows the newest message of the chosen chat and never keeps the old chat's messages.
  const side = await k.rpc({ action: "chat-create", id, title: "Side" });
  await page.waitFor(`!!document.querySelector('#tree [data-chat="${side.id}"]')`, "side chat in the tree");
  await page.evaluate(`document.querySelector('#tree [data-chat="${side.id}"]').click()`);
  await page.waitFor(`!document.querySelector('#feed').innerText.includes('MARK-FILL')`, "side chat open");
  k.check(
    "R9S a chat switch never keeps the old chat's messages",
    !(await page.evaluate(`document.querySelector('#feed').innerText.includes('Burst paragraph')`)),
  );
  await wheel(page, -400);
  // Both projects have a Main chat; the tree orders projects by activity, so pick the selected project's.
  await page.evaluate(`document.querySelector('#tree .tree-project.selected [data-chat="main"]').click()`);
  await page.waitFor(`document.querySelector('#feed').innerText.includes('Burst paragraph 23')`, "main chat again");
  await delay(300);
  const back = await anchored(page);
  k.check("R9 a chat switch follows the newest message", back.gap < 3, back);

  // Mobile shell: the composer stays on screen and nothing scrolls sideways.
  await page.viewport(390, 844, true);
  await delay(500);
  const mobile = await page.evaluate(`(() => {
    const c = document.querySelector('#composer').getBoundingClientRect(), send = document.querySelector('#composer button[type="submit"]')?.getBoundingClientRect();
    return { height: innerHeight, composerBottom: c.bottom, composerTop: c.top, sendInside: !send || (send.right <= c.right + 1 && send.bottom <= c.bottom + 1),
      bodyScroll: document.scrollingElement.scrollTop, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  result.measurements.mobile = mobile;
  await page.shot("03-mobile", { force: true });
  k.check(
    "M1 390 px: the composer is on screen, the page does not scroll and nothing overflows sideways",
    mobile.composerTop >= 0 &&
      mobile.composerBottom <= mobile.height + 1 &&
      mobile.sendInside &&
      mobile.bodyScroll === 0 &&
      !mobile.horizontalOverflow,
    mobile,
  );
});
