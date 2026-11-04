// Browser E2E: UI2 subscription limits are manual only (scripts/limits-manual-failures.md M1, M2, M4, M6, M8-M25). Private host, fake
// model, PI_PROJECTS_LIMITS_FIXTURE for the non-Cursor providers and a local fake Cursor dashboard that counts every provider request.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";

let cursorHits = 0,
  cursorPercent = 75,
  cursorFail = false,
  hold = null;
const cursor = createServer(async (req, res) => {
  cursorHits++;
  await hold?.promise;
  if (cursorFail) {
    res.writeHead(500);
    return res.end("down");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      billingCycleEnd: "2030-01-01T00:00:00.000Z",
      individualUsage: { plan: { enabled: true, totalPercentUsed: cursorPercent } },
    }),
  );
});
await new Promise((ok) => cursor.listen(0, "127.0.0.1", ok));
const holdCursor = () => {
  let release;
  const promise = new Promise((ok) => (release = ok));
  hold = { promise, release };
};

const kit = await createKit("ui2-limits");
const fixture = join(kit.root, "limits.json");
const setClaude = (usedPercent) =>
  writeFileSync(fixture, JSON.stringify({ claude: [{ window: "5h", usedPercent, resetsAt: Date.now() + 2 * 3600e3 }] }));
setClaude(42);
Object.assign(kit.hostEnv, {
  PI_PROJECTS_LIMITS_FIXTURE: fixture,
  PI_PROJECTS_CURSOR_DASHBOARD: `http://127.0.0.1:${cursor.address().port}`,
});
const jwt = `x.${Buffer.from(JSON.stringify({ sub: "auth0|e2e", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
writeFileSync(
  join(kit.agentDir, "auth.json"),
  JSON.stringify({ cursor: { type: "oauth", access: jwt, refresh: "r", expires: Date.now() + 3600e3 } }),
);
// Every page fetch of a limits action, and every interval the page sets, so the test can fire them all.
const PROBE = `window.__limitCalls = []; window.__intervals = [];
const realFetch = window.fetch;
window.__visibilityInFlight = 0; window.__visibilityMax = 0; window.__failVisibility = false;
window.fetch = function (url, options) {
  let action;
  try { action = JSON.parse(options?.body ?? "{}").action; if (/^limits-/.test(action)) window.__limitCalls.push(action); } catch {}
  if (action !== "limits-visibility") return realFetch.apply(this, arguments);
  // Saves are counted in flight, and the test can make the next ones fail the way a host error does.
  window.__visibilityMax = Math.max(window.__visibilityMax, ++window.__visibilityInFlight);
  const sent = window.__failVisibility
    ? new Promise((ok) => setTimeout(() => ok(new Response(JSON.stringify({ ok: false, error: "disk full" }), { status: 500 })), 150))
    : realFetch.apply(this, arguments);
  return sent.finally(() => window.__visibilityInFlight--);
};
const realInterval = window.setInterval;
window.setInterval = function (fn, ms, ...rest) { window.__intervals.push(fn); return realInterval.call(this, fn, ms, ...rest); };`;
const COOLDOWN_MS = 15_000;

try {
  await kit.run(async () => {
    const { rpc, check } = kit;
    kit.initRepo();
    const id = await kit.createProject("Limits");
    const attempts = async () => (await rpc({ action: "limits-snapshot" })).providers.map((item) => item.lastAttemptAt);
    check("M1 a host read never contacts a provider", cursorHits === 0 && (await attempts()).every((at) => at === null));
    await rpc({ action: "limits-snapshot", visit: true });
    check("M2 an older page's visit read never contacts a provider", cursorHits === 0 && (await attempts()).every((at) => at === null));

    const web = new URL((await rpc({ action: "web" })).url);
    web.pathname = "/ui2/";
    web.searchParams.set("project", id);
    const page = await kit.openPage("about:blank");
    await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    await page.navigate(web.toString());
    await page.waitFor(`document.body.dataset.ready === "1"`, "UI2 ready");
    const button = `document.querySelector('#statusline [data-limits-refresh]')`;
    const calls = () => page.evaluate(`window.__limitCalls.join(",")`);
    const bar = () => page.evaluate(`document.querySelector('#statusline').innerText.replace(/\\s+/g, " ")`);
    const since = (count) => page.evaluate(`window.__limitCalls.slice(${count}).join(",")`);
    const callCount = () => page.evaluate(`window.__limitCalls.length`);
    const press = async (key, code, text) => {
      for (const type of ["keyDown", "keyUp"])
        await page.cdp("Input.dispatchKeyEvent", { type, key, code, ...(type === "keyDown" && text ? { text } : {}) });
    };
    // One provider's details: a single popup outside the bar, so the bar's sideways scroll cannot cut it.
    const item = (provider) => `document.querySelector('#statusline [data-limit-item="${provider}"]')`;
    const popOpen = `!!document.querySelector('#limit-detail:not([hidden])')`;
    const popText = () => page.evaluate(`document.querySelector('#limit-detail').innerText.replace(/\\s+/g, " ")`);
    await page.waitFor(`window.__limitCalls.length >= 1`, "the first limits read");
    const empty = await page.evaluate(
      `(() => { const b = ${button}; return b && { label: b.getAttribute("aria-label"), text: b.innerText.trim(), busy: b.getAttribute("aria-busy") }; })()`,
    );
    check(
      "M9 with no reading the status line still offers a named refresh button",
      empty?.label === "Refresh subscription limits" && empty.text === "limits",
      empty,
    );
    await page.shot("01-empty", { force: true });

    // Every interval the page set, a tab coming back and a reload: none asks for limits beyond the one read per load.
    await page.evaluate(
      `(window.__intervals.forEach((fn) => { try { fn(); } catch {} }), document.dispatchEvent(new Event("visibilitychange")))`,
    );
    await kit.delay(1500);
    check("M8 page load, timers and visibility read once and never refresh", (await calls()) === "limits-snapshot" && cursorHits === 0, {
      calls: await calls(),
      cursorHits,
    });
    await page.reload();
    await page.waitFor(`document.body.dataset.ready === "1" && window.__limitCalls.length >= 1`, "UI2 ready after reload");
    await kit.delay(1000);
    check("M8 a reload reads once and contacts no provider", (await calls()) === "limits-snapshot" && cursorHits === 0, await calls());

    // The keyboard path: focus the button, press Enter, a second Enter while busy sends nothing more.
    holdCursor();
    await page.evaluate(`${button}.focus()`);
    const enter = async () => {
      for (const type of ["keyDown", "keyUp"])
        await page.cdp("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r" } : {}),
        });
    };
    await enter();
    await page.waitFor(`${button}?.getAttribute("aria-busy") === "true"`, "busy refresh button");
    await enter();
    const busy = await page.evaluate(
      `(() => { const b = ${button}; return { disabled: b.getAttribute("aria-disabled"), label: b.getAttribute("aria-label"), focused: document.activeElement === b }; })()`,
    );
    check(
      "M10 while refreshing the button says so, refuses clicks and keeps focus",
      busy.disabled === "true" && /Refreshing/.test(busy.label) && busy.focused,
      busy,
    );
    await page.shot("02-refreshing", { force: true });
    hold.release();
    hold = null;
    await page.waitFor(
      `!${button}.hasAttribute("aria-busy") && /Cursor/.test(document.querySelector('#statusline').innerText)`,
      "refreshed bar",
    );
    const refreshed = await bar();
    check(
      "M4 one press refreshes once and shows the readings",
      (await calls()) === "limits-snapshot,limits-refresh" &&
        cursorHits === 1 &&
        /Claude 5h.*42%/.test(refreshed) &&
        /Cursor mo.*75%/.test(refreshed),
      { calls: await calls(), cursorHits, refreshed },
    );
    check("M10 after the refresh the keyboard is still on the button", await page.evaluate(`document.activeElement === ${button}`));
    await page.shot("03-refreshed", { force: true });

    // A failed refresh keeps the numbers, says so in the bar, opens nothing.
    await kit.delay(COOLDOWN_MS + 500);
    cursorFail = true;
    setClaude(61);
    await page.evaluate(`${button}.click()`);
    await page.waitFor(`!!document.querySelector('#statusline [data-limits-error]')`, "refresh failed note");
    const failed = await page.evaluate(
      `(() => { const n = document.querySelector('#statusline [data-limits-error]'); return { text: n.innerText, title: n.title, bar: document.querySelector('#statusline').innerText.replace(/\\s+/g, " "), dialogs: document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden])').length }; })()`,
    );
    check(
      "M6/M11 a failed refresh keeps the shown numbers and says so in place",
      /refresh failed/.test(failed.text) &&
        /Cursor/.test(failed.title) &&
        /Cursor mo.*75%/.test(failed.bar) &&
        /Claude 5h.*61%/.test(failed.bar) &&
        failed.dialogs === 0,
      failed,
    );
    await page.shot("04-failed", { force: true });
    let detailMark = await callCount();
    await page.evaluate(`${item("cursor")}.focus()`);
    await page.waitFor(popOpen, "Cursor details on focus");
    const failedDetail = await popText();
    check(
      "M22 the details keep the last numbers and say why the refresh failed",
      /Cursor/.test(failedDetail) &&
        /75% used/.test(failedDetail) &&
        /resets in \d+d \d+h/.test(failedDetail) &&
        /Last refresh failed/.test(failedDetail),
      failedDetail,
    );
    await page.shot("04b-failed-details", { force: true });
    await press("Escape", "Escape");
    await page.waitFor(`!${popOpen}`, "Escape closes the details");
    check("M21 opening the details asks nothing", (await since(detailMark)) === "", await since(detailMark));

    // Settings → Providers reads the same state, and its Refresh updates the status line too.
    await page.evaluate(`document.querySelector('#topbar [data-cmd="settings"], [data-cmd="settings"]').click()`);
    await page.waitFor(`!!document.querySelector('dialog[open] [data-section="providers"]')`, "settings open");
    await page.evaluate(`document.querySelector('dialog[open] [data-section="providers"]').click()`);
    await page.waitFor(`!!document.querySelector('dialog[open] [data-providers-refresh]')`, "providers section");
    const before = await calls();
    check(
      "M12 opening Providers only reads",
      before === "limits-snapshot,limits-refresh,limits-refresh,limits-snapshot" && cursorHits === 2,
      { before, cursorHits },
    );
    check(
      "M12 Providers shows the failure the status line shows",
      await page.evaluate(`/Cursor/.test(document.querySelector('dialog[open] [data-limits-error]')?.innerText ?? "")`),
    );
    await kit.delay(COOLDOWN_MS + 500);
    cursorFail = false;
    cursorPercent = 80;
    setClaude(70);
    await page.evaluate(`document.querySelector('dialog[open] [data-providers-refresh]').click()`);
    await page.waitFor(`/80% used/.test(document.querySelector('dialog[open] .provider-list').innerText)`, "providers refreshed");
    await page.shot("05-providers", { force: true });
    const after = await bar();
    check(
      "M12 the Providers refresh is the same path and updates the status line",
      cursorHits === 3 && /Cursor mo.*80%/.test(after) && /Claude 5h.*70%/.test(after) && !/refresh failed/.test(after),
      { cursorHits, after },
    );

    // Showing and hiding each provider: the host's saved limits-visibility, switched from Settings → Providers.
    const box = (provider) => `document.querySelector('dialog[open] [data-limit-visible="${provider}"]')`;
    const settled = `!document.querySelector('dialog[open] [data-limit-visible][aria-busy="true"]')`;
    const visibility = async () => (await rpc({ action: "limits-snapshot" })).visibility;
    const toggle = await page.evaluate(
      `(() => { const b = ${box("cursor")}; return b && { name: (b.labels?.[0]?.innerText ?? "").trim() || b.getAttribute("aria-label"), checked: b.checked, type: b.type }; })()`,
    );
    check("M20 each provider has a named show toggle", toggle?.type === "checkbox" && toggle.checked && /Cursor/.test(toggle.name), toggle);
    let mark = await callCount(),
      hits = cursorHits;
    await page.evaluate(`${box("cursor")}.focus()`);
    await press(" ", "Space", " ");
    await page.waitFor(`!/Cursor/.test(document.querySelector('#statusline').innerText) && ${settled}`, "Cursor hidden");
    let saved = await visibility();
    check("M14 Space hides Cursor in the status line and saves it on the host", saved.cursor === false && saved.claude === true, saved);
    check("M14 the other providers stay", /Claude 5h.*70%/.test(await bar()), await bar());
    check("M20 the keyboard stays on the Cursor toggle", await page.evaluate(`document.activeElement === ${box("cursor")}`));
    const row = await page.evaluate(
      `(() => { const b = ${box("cursor")}; return { checked: b.checked, text: b.closest("li").innerText.replace(/\\s+/g, " ") }; })()`,
    );
    check(
      "M17 a hidden provider keeps its Providers row and reading",
      !row.checked && /80% used/.test(row.text) && /hidden/.test(row.text),
      row,
    );
    let sent = await since(mark);
    check(
      "M15 a toggle saves and reads only, and reaches no provider",
      /limits-visibility/.test(sent) && !/refresh/.test(sent) && cursorHits === hits,
      {
        sent,
        cursorHits,
      },
    );
    await page.shot("06-cursor-hidden", { force: true });

    // A change saved elsewhere (another browser, the Host agent, the classic inbox) reaches this page without a reload. A second UI2
    // tab is not opened here: each tab holds several streams and Chrome's per-host connection cap would stall it.
    hits = cursorHits;
    await rpc({ action: "limits-visibility", provider: "claude", visible: false });
    await page.waitFor(
      `!/Claude/.test(document.querySelector('#statusline').innerText) && !${box("claude")}.checked`,
      "Claude hidden here",
    );
    check("M19 a change saved elsewhere reaches the open page and contacts no provider", cursorHits === hits);
    const allHidden = await page.evaluate(
      `(() => { const b = ${button}; return b && { label: b.getAttribute("aria-label"), text: b.innerText.trim(), rows: document.querySelectorAll('dialog[open] [data-limit-visible]').length }; })()`,
    );
    check(
      "M17 with every reading hidden the status line keeps its refresh button and Providers keeps every row",
      allHidden?.label === "Refresh subscription limits" && allHidden.text === "limits" && allHidden.rows === 5,
      allHidden,
    );
    await page.shot("07-all-hidden", { force: true });

    // A refresh still reads hidden providers, and they stay hidden.
    await kit.delay(COOLDOWN_MS + 500);
    cursorPercent = 90;
    setClaude(75);
    hits = cursorHits;
    await page.evaluate(`document.querySelector('dialog[open] [data-providers-refresh]').click()`);
    await page.waitFor(`/90% used/.test(${box("cursor")}.closest("li").innerText)`, "hidden Cursor refreshed");
    check("M16 a refresh reads hidden providers and keeps them hidden", cursorHits === hits + 1 && !/Cursor|Claude/.test(await bar()), {
      cursorHits,
      bar: await bar(),
    });

    // Rapid toggles of two providers are saved one at a time, and the page ends where the host ends.
    mark = await callCount();
    await page.evaluate(
      `["claude", "cursor", "cursor", "cursor"].forEach((p) => document.querySelector('dialog[open] [data-limit-visible="' + p + '"]').click())`,
    );
    await page.waitFor(
      `((t) => /Claude 5h.*75%/.test(t) && /Cursor mo.*90%/.test(t))(document.querySelector('#statusline').innerText.replace(/\\s+/g, " ")) && ${settled}`,
      "rapid toggles settled",
    );
    saved = await visibility();
    const boxes = await page.evaluate(
      `({ claude: ${box("claude")}.checked, cursor: ${box("cursor")}.checked, max: window.__visibilityMax })`,
    );
    sent = await since(mark);
    check(
      "M18 rapid toggles end with page and host agreeing, one save at a time",
      saved.claude &&
        saved.cursor &&
        boxes.claude &&
        boxes.cursor &&
        boxes.max === 1 &&
        (sent.match(/limits-visibility/g) ?? []).length === 4,
      { saved, boxes, sent },
    );

    // A failed save says so in place and shows the choice the host kept.
    await page.evaluate(`(window.__failVisibility = true, ${box("cursor")}.focus())`);
    await press(" ", "Space", " ");
    await page.waitFor(`!!document.querySelector('dialog[open] [data-visibility-error]') && ${settled}`, "save failure note");
    const failedSave = await page.evaluate(
      `({ checked: ${box("cursor")}.checked, note: document.querySelector('dialog[open] [data-visibility-error]').innerText, focused: document.activeElement === ${box("cursor")} })`,
    );
    saved = await visibility();
    check(
      "M18 a failed save keeps the host's choice on the toggle and in the status line",
      failedSave.checked && /disk full/.test(failedSave.note) && failedSave.focused && saved.cursor && /Cursor mo.*90%/.test(await bar()),
      { failedSave, saved },
    );
    await page.shot("08-save-failed", { force: true });
    await page.evaluate(`window.__failVisibility = false`);

    // The saved choice survives a reload, which still only reads.
    await press(" ", "Space", " ");
    await page.waitFor(`!/Cursor/.test(document.querySelector('#statusline').innerText) && ${settled}`, "Cursor hidden again");
    await page.reload();
    await page.waitFor(`document.body.dataset.ready === "1" && /Claude/.test(document.querySelector('#statusline').innerText)`, "reloaded");
    await kit.delay(1000);
    check("M14 the choice survives a reload, which only reads", !/Cursor/.test(await bar()) && (await calls()) === "limits-snapshot", {
      bar: await bar(),
      calls: await calls(),
    });

    // Narrow screen: the Providers rows and their toggles fit.
    await page.viewport(390, 844, true);
    await kit.delay(500); // the panes animate into the narrow layout
    await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
    await page.waitFor(`!!document.querySelector('dialog[open] [data-section="providers"]')`, "settings open (narrow)");
    await page.evaluate(`document.querySelector('dialog[open] [data-section="providers"]').click()`);
    await page.waitFor(`!!${box("cursor")}`, "providers (narrow)");
    const fit = await page.evaluate(
      `(() => { const list = document.querySelector('dialog[open] .provider-list'); const r = ${box("cursor")}.getBoundingClientRect(); return { over: list.scrollWidth - list.clientWidth, inView: r.left >= 0 && r.right <= innerWidth }; })()`,
    );
    check("M20 on a narrow screen the toggles fit", fit.over <= 1 && fit.inView, fit);
    await page.shot("09-providers-narrow", { force: true });
    await page.evaluate(`document.querySelector('dialog[open] [data-cmd="settings"]').click()`);
    await page.viewport(1440, 1000);

    // A provider's details come from the readings the page holds: hover, keyboard focus and tap open them, nothing is asked.
    mark = await callCount();
    hits = cursorHits;
    check("M23 a hidden provider has no item to open", await page.evaluate(`!${item("cursor")} && !!${item("claude")}`));
    const centre = (selector) =>
      page.evaluate(`(() => { const r = ${selector}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    let at = await centre(item("claude"));
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await page.waitFor(popOpen, "details on hover");
    const detail = await popText();
    check(
      "M22 hover shows each window's use, reset, the reading's age and its source",
      /Claude/.test(detail) &&
        /5h/.test(detail) &&
        /75% used/.test(detail) &&
        /resets in \d/.test(detail) &&
        /read (just now|\d+[mhd] ago)/.test(detail) &&
        /usage endpoint|response headers/.test(detail),
      detail,
    );
    await page.shot("10-details-hover", { force: true });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 300 });
    await page.waitFor(`!${popOpen}`, "details close when the pointer leaves");
    await page.evaluate(`${item("claude")}.focus()`);
    await page.waitFor(popOpen, "details on keyboard focus");
    check(
      "M24 the focused provider says its details are open",
      await page.evaluate(`${item("claude")}.getAttribute("aria-expanded") === "true"`),
    );
    await press("Escape", "Escape");
    await page.waitFor(`!${popOpen}`, "Escape closes");
    check(
      "M24 Escape closes the details and keeps the keyboard on the provider",
      await page.evaluate(`document.activeElement === ${item("claude")} && ${item("claude")}.getAttribute("aria-expanded") === "false"`),
    );
    // A tap on a narrow screen opens them inside the screen; a press elsewhere closes them.
    await page.evaluate(`document.activeElement.blur()`);
    await page.viewport(390, 844, true);
    await kit.delay(500); // the panes animate into the narrow layout
    // Only the bar scrolls sideways (scrollIntoView would also scroll the page's clipped panes).
    await page.evaluate(`(() => { const b = ${item("claude")}; b.parentElement.scrollLeft = b.offsetLeft - 120; })()`);
    at = await centre(item("claude"));
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    await page.waitFor(popOpen, "details on tap");
    const box2 = await page.evaluate(
      `(() => { const r = document.querySelector('#limit-detail').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, over: document.documentElement.scrollWidth - innerWidth }; })()`,
    );
    check(
      "M25 on a narrow screen the details stay inside the screen and the page does not scroll sideways",
      box2.left >= 0 && box2.right <= box2.w && box2.top >= 0 && box2.bottom <= box2.h && box2.over <= 0,
      box2,
    );
    await page.shot("11-details-narrow", { force: true });
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp("Input.dispatchMouseEvent", { type, x: 195, y: 120, button: "left", clickCount: 1 });
    await page.waitFor(`!${popOpen}`, "a press outside closes");
    await page.viewport(1440, 1000);
    check("M21 hover, focus and tap asked the host nothing and reached no provider", (await since(mark)) === "" && cursorHits === hits, {
      sent: await since(mark),
      cursorHits,
    });

    // Hiding the limits item hides its refresh button with it.
    const ui = await rpc({ action: "ui-get" });
    await rpc({
      action: "ui-set",
      revision: ui.revision,
      patch: { statusItems: ui.ui.statusItems.map((item) => (item.id === "limits" ? { ...item, enabled: false } : item)) },
    });
    await page.waitFor(`!document.querySelector('#statusline [data-item="limits"]')`, "limits hidden");
    check("M13 a hidden limits item has no refresh button", await page.evaluate(`!${button}`));
    writeFileSync(join(kit.artifacts, "limits-snapshot.json"), JSON.stringify(await rpc({ action: "limits-snapshot" }), null, 2));
    check("setup: the token never reached the snapshot", !readFileSync(join(kit.artifacts, "limits-snapshot.json"), "utf8").includes(jwt));
  });
} finally {
  hold?.release();
  cursor.close();
}
