// Browser E2E: UI2 subscription limits are manual only (scripts/limits-manual-failures.md M1, M2, M4, M6, M8-M13). Private host, fake
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
window.fetch = function (url, options) {
  try { const action = JSON.parse(options?.body ?? "{}").action; if (/^limits-/.test(action)) window.__limitCalls.push(action); } catch {}
  return realFetch.apply(this, arguments);
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
    await page.evaluate(`document.querySelector('dialog[open] [data-cmd="settings"]').click()`);

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
