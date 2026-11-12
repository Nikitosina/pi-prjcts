// E2E: the simulator plugin's panel in Settings → Plugins (plugins/simulator/web/ui.js). Fake model, private HOME, headless Chrome on the
// inbox at `/`, and fixture devices: a fake simslim and a fake XcodeBuildMCP (scripts/fixtures/simulator/) answer from a JSON device list,
// so no real simulator is listed or changed. Failure cases written first: plugins/simulator/FAILURES.md, "Settings panel" (S1-S18).
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { createKit, delay } from "./lib/e2e-kit.mjs";

const fixtures = new URL("./fixtures/simulator/", import.meta.url).pathname;
const bin = join(process.env.TMPDIR ?? "/tmp", `simulator-panel-${randomUUID()}`);
mkdirSync(bin, { recursive: true, mode: 0o700 });
const fakeState = join(bin, "devices.json"),
  fakeLog = join(bin, "calls.jsonl"),
  png = join(bin, "screen.png");
for (const [name, file] of [
  ["simslim", "fake-simslim.mjs"],
  ["xcodebuildmcp", "fake-xcodebuildmcp.mjs"],
]) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fixtures, file))} "$@"\n`);
  chmodSync(join(bin, name), 0o755);
}
writeFileSync(fakeLog, "");
writeFileSync(png, phonePng(180, 390));

const kit = await createKit("simulator-panel", {
  env: {
    PI_PROJECTS_PLUGINS: join(process.cwd(), "plugins/simulator"),
    PI_PROJECTS_SIMSLIM: join(bin, "simslim"),
    PI_PROJECTS_XCODEBUILDMCP: join(bin, "xcodebuildmcp"),
    SIMULATOR_FAKE_STATE: fakeState,
    SIMULATOR_FAKE_LOG: fakeLog,
    SIMULATOR_FAKE_PNG: png,
  },
});

const udid = () => randomUUID().toUpperCase();
const SOURCE = udid(),
  RUNNING_SOURCE = udid(),
  CLONE_A = udid(),
  CLONE_B = udid();
const HOSTILE = `iPad <b>Air</b> <img src=x onerror="window.__pwned=1">`;

await kit.run(async () => {
  const { check, result } = kit;
  kit.initRepo();
  const second = join(kit.root, "workspace-b");
  mkdirSync(second);
  kit.initRepo(second);
  const alpha = await kit.createProject("Alpha");
  const beta = await kit.createProject("Beta", { cwd: second });

  // Alpha owns two clones (one booted); Beta owns none. The ownership receipts match the clone folders under the private HOME.
  const devicesRoot = join(kit.userHome, "Library/Developer/CoreSimulator/Devices");
  const owned = [CLONE_A, CLONE_B].map((id, index) => {
    const dir = join(devicesRoot, id);
    mkdirSync(dir, { recursive: true });
    const facts = lstatSync(dir);
    return {
      udid: id,
      name: `pi-projects ${alpha.slice(0, 8)} clone-${index}`,
      sourceUdid: SOURCE,
      directory: realpathSync(dir),
      device: facts.dev,
      inode: facts.ino,
      born: facts.birthtimeMs,
    };
  });
  writeFileSync(
    fakeState,
    JSON.stringify({
      devices: [
        { udid: SOURCE, name: "iPhone 16 Pro", state: "Shutdown", osVersion: "18.2", set: "default" },
        { udid: RUNNING_SOURCE, name: HOSTILE, state: "Booted", osVersion: "18.2", set: "default" },
        { udid: CLONE_A, name: owned[0].name, state: "Booted", osVersion: "18.2", set: "default" },
        { udid: CLONE_B, name: owned[1].name, state: "Shutdown", osVersion: "18.2", set: "default" },
      ],
    }),
  );
  const storeFile = (id) => join(kit.home, id, "simulator.json");
  writeFileSync(
    storeFile(alpha),
    JSON.stringify({ version: 2, projectId: alpha, enabled: true, sourceUdid: null, owned, pending: null, uncertain: null, receipts: {} }),
  );
  const store = (id = alpha) => (existsSync(storeFile(id)) ? JSON.parse(readFileSync(storeFile(id), "utf8")) : null);
  const devices = () => JSON.parse(readFileSync(fakeState, "utf8")).devices;
  const deviceState = (id) => devices().find((item) => item.udid === id)?.state;
  const setFail = (fail) => {
    const state = JSON.parse(readFileSync(fakeState, "utf8"));
    writeFileSync(fakeState, JSON.stringify({ ...state, fail }));
  };
  const fakeCalls = () =>
    readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const settled = () => kit.eventually(() => !store()?.pending, "simulator operation settled");

  const page = await kit.openPage(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  await page.viewport(1440, 1400);
  // Records every simulator request the page sends; __simFail(entry) fails matching ones as if the network dropped them (S6, S8),
  // and only the first match when it answers "once".
  await page.evaluate(`(() => {
    window.__sim = [];
    window.__blobs = { made: [], revoked: [] };
    const send = window.fetch;
    window.fetch = function (input, init) {
      const url = String(input?.url ?? input);
      let entry = null;
      if (url.endsWith("/api") && init?.body) {
        const body = JSON.parse(init.body);
        if (body.action === "plugin" && body.plugin === "simulator") entry = { kind: body.method, id: body.id, params: body.params };
      } else if (url.includes("/plugins/simulator/frame")) entry = { kind: "frame", url };
      if (entry) {
        entry.at = Date.now();
        window.__sim.push(entry);
        const fail = window.__simFail?.(entry);
        if (fail) {
          if (fail === "once") window.__simFail = null;
          entry.dropped = true;
          return Promise.reject(new TypeError("Failed to fetch"));
        }
      }
      const answer = send.apply(this, arguments);
      if (entry) answer.then((response) => { entry.status = response.status; }, () => {});
      // __simHold(entry) returns milliseconds to hold a sent request's answer (S12, S13).
      const hold = (entry && window.__simHold?.(entry)) || 0;
      return hold ? new Promise((resolve) => setTimeout(() => resolve(answer), hold)) : answer;
    };
    const make = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { const url = make(blob); if (blob.type.startsWith("image/")) window.__blobs.made.push(url); return url; };
    URL.revokeObjectURL = (url) => { window.__blobs.revoked.push(url); return revoke(url); };
  })()`);

  const js = (value) => JSON.stringify(value);
  // Proof shots show the panel's controls and messages, which sit below the screenshot in the scrolling Settings body.
  const shot = async (label, at = "[data-simulator-actions]") => {
    await page.evaluate(`document.querySelector(${js(`${PANEL} .plugin-slot ${at}`)})?.scrollIntoView({ block: "center" })`);
    await page.shot(label, { force: true });
  };
  const click = async (selector) => {
    const point = await page.evaluate(
      `(() => { const node = document.querySelector(${js(selector)}); if (!node || node.disabled) return null; node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    );
    if (!point) throw Error(`nothing to click: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const PANEL = `#settings .plugin-panel[data-plugin="simulator"]`;
  const inPanel = (selector) => `${PANEL} .plugin-slot ${selector}`;
  const text = (selector) => page.evaluate(`document.querySelector(${js(inPanel(selector))})?.innerText ?? ""`);
  const status = () => text("[data-simulator-status]");
  const sim = () => page.evaluate(`window.__sim.slice()`);
  const since = async (count) => (await sim()).slice(count);
  const waitStatus = (pattern, label) =>
    page.waitFor(`${pattern}.test(document.querySelector(${js(inPanel("[data-simulator-status]"))})?.innerText ?? "")`, label);
  const waitPanel = (expression, label) =>
    page.waitFor(
      `(() => { const slot = document.querySelector(${js(`${PANEL} .plugin-slot`)}); return !!slot && (${expression}); })()`,
      label,
    );
  const select = (projectId) =>
    page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(projectId)} }))`);
  const openPlugins = async ({ settled = ["ready"] } = {}) => {
    if (!(await page.evaluate(`document.querySelector("#settings").open`))) await click(`[data-cmd="settings"]`);
    await page.waitFor(`document.querySelector("#settings").open`, "settings open");
    await click(`#settings nav [data-section="plugins"]`);
    await page.waitFor(`${js(settled)}.includes(document.querySelector(${js(PANEL)})?.dataset.state)`, "simulator panel settled");
  };
  const closeSettings = async () => {
    await click(`#settings .settings-head [data-cmd="settings"]`);
    await page.waitFor(`!document.querySelector("#settings").open`, "settings closed");
  };
  const selectTab = async (id) => {
    await click(inPanel(`[data-action="simulator-select"][data-udid="${id}"]`));
    await waitPanel(`slot.querySelector('[data-action="simulator-select"][data-udid="${id}"]')?.classList.contains("on")`, `tab ${id}`);
  };
  const actions = async (count, kind) => (await since(count)).filter((entry) => entry.kind === kind && !entry.dropped);
  const MORE = "[data-simulator-more]";
  const menuOpen = () => page.evaluate(`!!document.querySelector(${js(inPanel(MORE))})?.open`);
  // Reset, delete and turning management off live in the More actions menu (S15): open it with a click, then choose.
  const menu = async (name) => {
    if (!(await menuOpen())) await click(inPanel(`${MORE} > summary`));
    await waitPanel(`slot.querySelector(${js(MORE)}).open`, "menu open");
    await click(inPanel(`${MORE} [data-action="simulator-${name}"]`));
  };
  const key = async (key, code, keyCode, text) => {
    for (const type of ["keyDown", "keyUp"])
      await page.cdp("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        ...(type === "keyDown" && text ? { text } : {}),
      });
  };
  // Visible (rendered, outside any closed disclosure) and not inside the Details disclosure or the menu (S17).
  const primary = (selector) =>
    page.evaluate(
      `(() => { const node = document.querySelector(${js(inPanel(selector))}); return !!node && node.checkVisibility() && !node.closest("details"); })()`,
    );
  // Icon-only controls and their names (S16); an empty list means a control without a name.
  const unnamed = () =>
    page.evaluate(
      `[...document.querySelectorAll(${js(inPanel("button, summary"))})].filter((node) => node.checkVisibility() && !node.innerText.trim() && !(node.getAttribute("aria-label") && node.getAttribute("aria-label") === node.title)).map((node) => node.outerHTML.slice(0, 120))`,
    );

  // ---- S1 S2 S9 listing
  await openPlugins({ settled: ["ready", "failed"] });
  await shot("00-first-open");
  const panelInfo = await page.evaluate(
    `(() => { const node = document.querySelector(${js(PANEL)}); return { state: node.dataset.state, error: node.querySelector(".plugin-error").hidden ? "" : node.querySelector(".plugin-error").textContent, scripts: document.querySelectorAll('script[src="/plugins/simulator/ui.js"]').length, outside: document.querySelectorAll(".simulator-panel").length }; })()`,
  );
  check(
    "S1 the simulator panel mounts as ready through mount(slot, panel), only inside its slot",
    panelInfo.state === "ready" && !panelInfo.error && panelInfo.scripts === 1 && panelInfo.outside === 1,
    panelInfo,
  );
  await waitStatus(/^1\/2 running$/, "two clones listed");
  await waitPanel(`slot.querySelector("[data-simulator-screen] img")?.naturalWidth > 0`, "first screenshot");
  const overview = await page.evaluate(
    `(() => { const slot = document.querySelector(${js(`${PANEL} .plugin-slot`)}); return { text: slot.innerText, facts: slot.querySelector("[data-simulator-facts]").open, menu: slot.querySelector(${js(MORE)}).open, badges: [...slot.querySelectorAll("[data-simulator-status]")].filter((node) => node.checkVisibility()).length }; })()`,
  );
  check(
    "S14 the primary view shows the clones, one status and Shut down; UDID, slimming, clone limit and the view-only note stay in closed Details",
    !overview.facts &&
      !overview.menu &&
      overview.badges === 1 &&
      (await primary(`[data-action="simulator-shutdown"]`)) &&
      (await primary("[data-simulator-screen] img")) &&
      ![CLONE_A, CLONE_B, "services disabled", "up to 4 clones", "View only", "iOS 18.2"].some((part) => overview.text.includes(part)),
    overview,
  );
  const nameless = await unnamed();
  check("S16 every icon-only button has an aria-label with a matching title", nameless.length === 0, nameless);
  await shot("01-primary");
  await click(inPanel("[data-simulator-facts] > summary"));
  await waitPanel(`slot.querySelector("[data-simulator-facts]").open`, "details open");
  const listing = await page.evaluate(
    `(() => { const slot = document.querySelector(${js(`${PANEL} .plugin-slot`)}); return { tabs: [...slot.querySelectorAll('[data-action="simulator-select"]')].map((node) => node.dataset.udid + " " + node.getAttribute("aria-pressed") + " " + node.innerText.replace(/\\s+/g, " ").trim()), text: slot.innerText, html: !!slot.querySelector(".simulator-panel b, .simulator-panel img:not([data-simulator-frame])"), pwned: window.__pwned }; })()`,
  );
  check(
    "S2 the listing shows status, a tab per clone with its state in text, its source, UDID, slimming and the clone limit",
    listing.tabs.length === 2 &&
      listing.tabs.some((tab) => tab.startsWith(`${CLONE_A} true `) && /running$/.test(tab)) &&
      listing.tabs.some((tab) => tab.startsWith(`${CLONE_B} false `) && /shut down$/.test(tab)) &&
      /iPhone 16 Pro/.test(listing.text) &&
      listing.text.includes(CLONE_A) &&
      /3\/5 services disabled, persistent/.test(listing.text) &&
      /up to 4 clones/.test(listing.text),
    listing,
  );
  const frames = (await sim()).filter((entry) => entry.kind === "frame");
  check(
    "S9 a booted clone shows its screenshot through panel.fetch with the token, for its own project",
    frames.length >= 1 &&
      frames.every((entry) => entry.url.includes(`project=${alpha}`) && entry.url.includes(`udid=${CLONE_A}`)) &&
      fakeCalls().some((call) => call.args[0] === "screenshot" && call.args[1] === CLONE_A),
    frames,
  );
  await shot("01-listing", "[data-simulator-facts]");

  // ---- S3 boot and shut down
  await selectTab(CLONE_B);
  check(
    "S9 a shut-down clone shows no screenshot",
    await page.evaluate(`document.querySelector(${js(inPanel("[data-simulator-screen]"))}).hidden`),
  );
  let mark = (await sim()).length;
  await click(inPanel(`[data-action="simulator-boot"]`));
  await kit.eventually(() => deviceState(CLONE_B) === "Booted", "clone B booted by simslim");
  await settled();
  await waitStatus(/^2\/2 running$/, "both clones running");
  const boots = await actions(mark, "action");
  check(
    "S3 Boot sends one action with a fresh request id for the panel's project, and simslim boots the clone",
    boots.length === 1 &&
      boots[0].id === alpha &&
      boots[0].params.operation === "boot" &&
      boots[0].params.udid === CLONE_B &&
      store().receipts[boots[0].params.requestId]?.status === "done",
    { boots, receipts: store().receipts },
  );
  await shot("02-booted");
  mark = (await sim()).length;
  await click(inPanel(`[data-action="simulator-shutdown"]`));
  await kit.eventually(() => deviceState(CLONE_B) === "Shutdown", "clone B shut down");
  await settled();
  await waitStatus(/^1\/2 running$/, "one clone running again");
  const shutdowns = await actions(mark, "action");
  check(
    "S3 Shut down sends one action with another request id",
    shutdowns.length === 1 &&
      shutdowns[0].params.operation === "shutdown" &&
      shutdowns[0].params.requestId !== boots[0].params.requestId &&
      shutdowns[0].params.udid === CLONE_B,
    shutdowns,
  );

  // ---- S15 the More actions menu: keyboard, polls, a press outside, a choice
  check("S15 the menu items are hidden until the menu opens", !(await primary(`[data-action="simulator-delete"]`)) && !(await menuOpen()));
  await page.evaluate(`document.querySelector(${js(inPanel(`${MORE} > summary`))}).focus()`);
  await key("Enter", "Enter", 13, "\r");
  await waitPanel(`slot.querySelector(${js(MORE)}).open`, "menu opened by Enter");
  await shot("03-menu", MORE);
  await delay(4000);
  check(
    "S15 Enter opens the menu and it stays open across a poll",
    (await menuOpen()) &&
      (await page.evaluate(`document.querySelector(${js(inPanel(`${MORE} [data-action="simulator-delete"]`))}).checkVisibility()`)),
  );
  await click(inPanel("[data-simulator-status]"));
  await waitPanel(`!slot.querySelector(${js(MORE)}).open`, "menu closed by a press outside");
  check("S15 a press outside closes the menu", !(await menuOpen()));
  mark = (await sim()).length;
  await menu("disable");
  await waitPanel(`!!slot.querySelector('[data-simulator-confirm]:not([hidden]) [data-operation="disable"]')`, "turn off confirmation");
  check(
    "S15 choosing Turn off closes the menu and opens its inline confirmation",
    !(await menuOpen()) && /Turn off simulator management/.test(await text("[data-simulator-confirm]")),
    await text("[data-simulator-confirm]"),
  );
  await click(inPanel(`[data-action="simulator-cancel"]`));
  await waitPanel(`slot.querySelector("[data-simulator-confirm]").hidden`, "turn off cancelled");
  await delay(400);
  check("S15 cancelling Turn off sends nothing", (await actions(mark, "configure")).length === 0, await since(mark));

  // ---- S4 inline confirmation for delete
  mark = (await sim()).length;
  await menu("delete");
  await waitPanel(
    `!!slot.querySelector('[data-simulator-confirm]:not([hidden]) [data-action="simulator-confirm"]')`,
    "delete confirmation",
  );
  check(
    "S4 the delete confirmation is inline in the slot and names the clone",
    (await text("[data-simulator-confirm]")).includes(CLONE_B) &&
      !(await page.evaluate(`document.querySelector("dialog[open]:not(#settings)")`)),
    await text("[data-simulator-confirm]"),
  );
  await shot("03-delete-confirmation", "[data-simulator-confirm]");
  await click(inPanel(`[data-action="simulator-cancel"]`));
  await waitPanel(`slot.querySelector("[data-simulator-confirm]").hidden`, "confirmation closed");
  await delay(400);
  check("S4 Cancel sends nothing", (await actions(mark, "action")).length === 0, await since(mark));
  await menu("delete");
  await click(inPanel(`[data-action="simulator-confirm"]`));
  await kit.eventually(() => store().owned.length === 1 && !deviceState(CLONE_B), "clone B deleted");
  await settled();
  await waitPanel(
    `!slot.querySelector('[data-action="simulator-select"]') && /^Running$/.test(slot.querySelector("[data-simulator-status]").innerText)`,
    "one clone left",
  );
  const deletes = await actions(mark, "action");
  check(
    "S4 confirming sends exactly one delete for the named clone; the owned clone and its folder are gone",
    deletes.length === 1 &&
      deletes[0].params.operation === "delete" &&
      deletes[0].params.udid === CLONE_B &&
      !existsSync(join(devicesRoot, CLONE_B)) &&
      store().owned.every((item) => item.udid === CLONE_A),
    deletes,
  );
  await shot("04-deleted");

  // ---- S5 create a clone from a shut-down source
  mark = (await sim()).length;
  await click(inPanel(`[data-action="simulator-new"]`));
  await waitPanel(`!!slot.querySelector("[data-simulator-source]")`, "source picker");
  const options = await page.evaluate(
    `[...document.querySelector(${js(inPanel("[data-simulator-source]"))}).options].map((option) => ({ value: option.value, disabled: option.disabled, text: option.textContent }))`,
  );
  check(
    "S5 only shut-down sources can be chosen; a running source is listed disabled, its name as text",
    options.length === 2 &&
      options.find((option) => option.value === SOURCE)?.disabled === false &&
      options.find((option) => option.value === RUNNING_SOURCE)?.disabled === true &&
      options.find((option) => option.value === RUNNING_SOURCE)?.text.includes("<b>Air</b>") &&
      (await page.evaluate(`document.querySelector(${js(inPanel("[data-simulator-source]"))}).value`)) === SOURCE,
    options,
  );
  await shot("05-new-clone", "[data-simulator-confirm]");
  await click(inPanel(`[data-action="simulator-enable"]`));
  await kit.eventually(() => store().owned.length === 2, "clone created");
  await settled();
  await waitStatus(/^2\/2 running$/, "new clone running");
  const created = store().owned.find((item) => item.udid !== CLONE_A);
  const creates = await actions(mark, "action");
  check(
    "S5 Create clone sends one create for the chosen source; the new clone is owned, booted and listed",
    creates.length === 1 &&
      creates[0].params.operation === "create" &&
      creates[0].params.sourceUdid === SOURCE &&
      created?.sourceUdid === SOURCE &&
      deviceState(created.udid) === "Booted" &&
      fakeCalls().some((call) => call.args[0] === "clone" && call.args[1] === SOURCE) &&
      (await page.evaluate(`!!document.querySelector(${js(inPanel(`[data-action="simulator-select"][data-udid="${created.udid}"]`))})`)),
    { creates, owned: store().owned },
  );
  await shot("06-created");

  // ---- S7 an unknown outcome, acknowledged inline
  setFail({ erase: "simslim: erase failed (fixture)" });
  await selectTab(created.udid);
  mark = (await sim()).length;
  await menu("reset");
  await click(inPanel(`[data-action="simulator-confirm"]`));
  await kit.eventually(() => store().uncertain, "reset left an unknown outcome");
  setFail({});
  await waitStatus(/^Needs inspection$/, "needs inspection");
  await waitPanel(`/erase failed \\(fixture\\)/.test(slot.querySelector("[data-simulator-error]").innerText)`, "uncertain reason shown");
  check(
    "S17 the unknown outcome and its acknowledgement stay in the primary view",
    (await primary("[data-simulator-error]")) && (await primary(`[data-action="simulator-recover"]`)),
  );
  await shot("07-needs-inspection");
  await click(inPanel(`[data-action="simulator-recover"]`));
  await waitPanel(`!!slot.querySelector('[data-action="simulator-recover-confirm"]')`, "acknowledgement");
  await click(inPanel(`[data-action="simulator-recover-confirm"]`));
  await kit.eventually(() => !store().uncertain, "outcome acknowledged");
  await waitPanel(`!/^Needs inspection$/.test(slot.querySelector("[data-simulator-status]").innerText)`, "settled after acknowledgement");
  const recovers = await actions(mark, "recover"),
    afterReset = await actions(mark, "action");
  check(
    "S7 the acknowledgement sends one recover with the project id and never retries the reset",
    recovers.length === 1 &&
      recovers[0].params.confirm === alpha &&
      afterReset.length === 1 &&
      afterReset[0].params.operation === "reset" &&
      fakeCalls().filter((call) => call.args[0] === "erase").length === 1 &&
      store().owned.length === 2,
    { recovers, afterReset },
  );
  await shot("08-acknowledged");

  // ---- S8 an unconfirmed request keeps its id across a reopening
  await waitPanel(`!!slot.querySelector('[data-action="simulator-boot"]:not(:disabled)')`, "boot available");
  await page.evaluate(`window.__simFail = (entry) => entry.kind === "action" && entry.params.operation === "boot" && "once"`);
  mark = (await sim()).length;
  await click(inPanel(`[data-action="simulator-boot"]`));
  await waitPanel(`!!slot.querySelector('[data-action="simulator-retry"]')`, "retry exact request");
  const dropped = (await since(mark)).find((entry) => entry.dropped);
  check(
    "S8 a request without an answer says the outcome is unconfirmed and offers Retry exact request",
    dropped && /unconfirmed/i.test(await text("[data-simulator-error]")) && !store().receipts[dropped.params.requestId],
    { dropped, error: await text("[data-simulator-error]") },
  );
  check(
    "S17 an unconfirmed request and Retry exact request stay in the primary view",
    (await primary("[data-simulator-error]")) && (await primary(`[data-action="simulator-retry"]`)),
  );
  await shot("09-unconfirmed");
  await closeSettings();
  await openPlugins();
  await waitPanel(`!!slot.querySelector('[data-action="simulator-retry"]')`, "retry after reopen");
  await click(inPanel(`[data-action="simulator-retry"]`));
  await kit.eventually(() => store().receipts[dropped.params.requestId]?.status === "done", "retried boot done");
  const retried = await actions(mark, "action");
  check(
    "S8 Retry exact request resends the same request id after Settings is reopened",
    retried.length === 1 && retried[0].params.requestId === dropped.params.requestId && deviceState(created.udid) === "Booted",
    retried,
  );
  await waitPanel(`!slot.querySelector('[data-action="simulator-retry"]')`, "retry cleared");

  // ---- S13 a slow screenshot does not hold up another clone's capture
  await waitStatus(/^2\/2 running$/, "both clones running for S13");
  await page.evaluate(`window.__simHold = (entry) => entry.kind === "frame" && entry.url.includes(${js(CLONE_A)}) ? 8000 : 0`);
  await selectTab(CLONE_A);
  await page.waitFor(
    `window.__sim.some((entry) => entry.kind === "frame" && entry.url.includes(${js(CLONE_A)}) && !entry.status)`,
    "held capture of A",
  );
  mark = (await sim()).length;
  await selectTab(created.udid);
  await page.waitFor(
    `window.__sim.slice(${mark}).some((entry) => entry.kind === "frame" && entry.url.includes(${js(created.udid)}))`,
    "capture of the selected clone while A's answer is held",
    12,
  );
  check("S13 selecting another clone captures it at once while a slow capture is outstanding", true);
  await page.evaluate(`window.__simHold = null`);

  // ---- S12 a request outstanding at unmount does not lock the next mount
  await page.evaluate(`window.__simHold = (entry) => entry.kind === "action" && entry.params.operation === "shutdown" ? 8000 : 0`);
  mark = (await sim()).length;
  const shutdownsBefore = fakeCalls().filter((call) => call.args[0] === "shutdown").length;
  await click(inPanel(`[data-action="simulator-shutdown"]`));
  await page.waitFor(`window.__sim.slice(${mark}).some((entry) => entry.kind === "action")`, "held shutdown sent");
  await closeSettings();
  await openPlugins();
  await page.waitFor(
    `!!document.querySelector(${js(inPanel('[data-action="simulator-retry"]'))})`,
    "Retry exact request offered at once after reopening",
    12,
  );
  const held = (await actions(mark, "action"))[0];
  await page.evaluate(`window.__simHold = null`);
  await click(inPanel(`[data-action="simulator-retry"]`));
  await kit.eventually(() => store().receipts[held.params.requestId]?.status === "done", "held shutdown done");
  await settled();
  const resent = await actions(mark, "action");
  check(
    "S12 the next mount offers Retry exact request at once; the retry resends the same id and the shutdown runs once",
    resent.length === 2 &&
      resent.every((entry) => entry.params.requestId === held.params.requestId) &&
      fakeCalls().filter((call) => call.args[0] === "shutdown").length === shutdownsBefore + 1 &&
      deviceState(created.udid) === "Shutdown",
    { resent, calls: fakeCalls().slice(-6) },
  );
  await waitPanel(`!slot.querySelector('[data-action="simulator-retry"]')`, "retry cleared after S12");
  await waitStatus(/^1\/2 running$/, "one clone running after S12");

  // ---- S6 errors: simslim failing, then the snapshot itself failing
  setFail({ list: "simslim: CoreSimulator is not available (fixture)" });
  await waitStatus(/^Error$/, "simslim error shown");
  await waitPanel(
    `/CoreSimulator is not available \\(fixture\\)/.test(slot.querySelector("[data-simulator-error]").innerText)`,
    "simslim reason",
  );
  await shot("10-simslim-error");
  setFail({});
  await waitStatus(/^1\/2 running$/, "recovered after simslim answers");
  await page.evaluate(`window.__simFail = (entry) => entry.kind === "snapshot"`);
  await waitStatus(/^Unavailable$/, "snapshot failure shown");
  check(
    "S6 a failed snapshot says unavailable, shows the reason and offers Retry",
    /Failed to fetch/.test(await text("[data-simulator-error]")) &&
      (await page.evaluate(`!!document.querySelector(${js(inPanel('[data-action="simulator-refresh"]'))})`)),
    await text("[data-simulator-error]"),
  );
  await shot("11-unavailable");
  await page.evaluate(`window.__simFail = null`);
  mark = (await sim()).length;
  await click(inPanel(`[data-action="simulator-refresh"]`));
  await waitStatus(/^1\/2 running$/, "retry recovers");
  check(
    "S6 Retry asks for a snapshot at once",
    (await since(mark)).some((entry) => entry.kind === "snapshot"),
    await since(mark),
  );
  check("S6 a simslim failure shows the error, and both recover", true);

  // ---- S10 S11 project change, leaving, closing and reopening
  mark = (await sim()).length;
  await select(beta);
  await waitStatus(/^No simulator$/, "Beta has no simulator");
  await delay(3500);
  const betaRequests = await since(mark);
  check(
    "S11 a project change shows only the new project's state",
    betaRequests.length > 0 &&
      betaRequests.every((entry) => (entry.kind === "snapshot" ? entry.id === beta : !entry.url?.includes(alpha))) &&
      !(await page.evaluate(`!!document.querySelector(${js(inPanel('[data-action="simulator-select"]'))})`)) &&
      !(await page.evaluate(`!!document.querySelector(${js(inPanel("[data-simulator-screen] img[src]"))})`)),
    betaRequests,
  );
  await shot("12-project-beta");
  await select(alpha);
  await waitStatus(/^1\/2 running$/, "Alpha again");
  await waitPanel(`slot.querySelector("[data-simulator-screen] img")?.naturalWidth > 0`, "Alpha screenshot again");
  const quiet = async (label) => {
    await delay(300);
    const before = (await sim()).length,
      calls = fakeCalls().length;
    await delay(9000);
    const after = await since(before);
    check(label, after.length === 0 && fakeCalls().length === calls, { after, calls: fakeCalls().slice(calls) });
  };
  await click(`#settings nav [data-section="general"]`);
  await page.waitFor(`document.querySelector("#settings").dataset.section === "general"`, "General section");
  await quiet("S10 leaving the section stops polling and captures");
  await openPlugins();
  await waitStatus(/^1\/2 running$/, "Alpha after returning");
  await closeSettings();
  await quiet("S10 closing Settings stops polling and captures");
  const blobs = await page.evaluate(`window.__blobs`);
  check(
    "S10 every screenshot object URL is revoked once its panel went away",
    blobs.made.length > 0 && blobs.made.every((url) => blobs.revoked.includes(url)),
    blobs,
  );
  for (let i = 0; i < 3; i++) {
    await openPlugins();
    await closeSettings();
  }
  await openPlugins();
  await waitStatus(/^1\/2 running$/, "Alpha after reopenings");
  await selectTab(created.udid);
  mark = (await sim()).length;
  await click(inPanel(`[data-action="simulator-boot"]`));
  await kit.eventually(() => deviceState(created.udid) === "Booted", "booted after reopenings");
  await settled();
  await delay(1000);
  const once = await actions(mark, "action");
  check(
    "S11 after several reopenings one click sends one request",
    once.length === 1 && Object.values(store().receipts).length === new Set(Object.keys(store().receipts)).size,
    once,
  );
  await waitStatus(/^2\/2 running$/, "both running after the boot");
  await shot("13-after-reopenings");

  // ---- S18 a narrow window
  await page.viewport(390, 844, true);
  await waitPanel(`slot.querySelector("[data-simulator-screen] img")?.naturalWidth > 0`, "narrow screenshot");
  await delay(300);
  const fits = () =>
    page.evaluate(
      `(() => { const slot = document.querySelector(${js(`${PANEL} .plugin-slot`)}), box = slot.getBoundingClientRect(); const out = [...slot.querySelectorAll("button, summary")].filter((node) => node.checkVisibility()).map((node) => [node, node.getBoundingClientRect()]).filter(([, rect]) => rect.left < box.left - 1 || rect.right > box.right + 1 || rect.right > innerWidth).map(([node]) => node.outerHTML.slice(0, 100)); return { out, wide: slot.scrollWidth > slot.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth }; })()`,
    );
  const narrow = await fits();
  check(
    "S18 at 390 px the panel fits its card and every control stays on screen",
    !narrow.out.length && !narrow.wide && !narrow.page,
    narrow,
  );
  await shot("14-narrow");
  await menu("reset");
  await waitPanel(`!!slot.querySelector('[data-simulator-confirm]:not([hidden]) [data-operation="reset"]')`, "narrow reset confirmation");
  const narrowConfirm = await fits();
  check("S18 at 390 px the reset confirmation fits too", !narrowConfirm.out.length && !narrowConfirm.wide, narrowConfirm);
  await shot("15-narrow-reset", "[data-simulator-confirm]");
  await click(inPanel(`[data-action="simulator-cancel"]`));
  await click(inPanel(`${MORE} > summary`));
  await waitPanel(`slot.querySelector(${js(MORE)}).open`, "narrow menu open");
  check("S18 at 390 px the open menu stays on screen", !(await fits()).out.length && !(await unnamed()).length);
  await shot("16-narrow-menu", MORE);
  await click(inPanel(`${MORE} > summary`));
  await click(inPanel("[data-simulator-facts] > summary"));
  await waitPanel(`slot.querySelector("[data-simulator-facts]").open`, "narrow details");
  await shot("17-narrow-details", "[data-simulator-facts]");
  await page.viewport(1440, 1400);
  check(
    "S11 no script or stylesheet was inserted twice",
    await page.evaluate(
      `document.querySelectorAll('script[src="/plugins/simulator/ui.js"]').length === 1 && document.querySelectorAll('link[href="/plugins/simulator/ui.css"]').length === 1`,
    ),
  );
  check("S2 no host text ran as HTML", await page.evaluate(`window.__pwned === undefined`));

  // Host state for the report: Alpha's ownership record, the fixture devices and every fake command the plugin ran.
  writeFileSync(join(kit.artifacts, "host-simulator-alpha.json"), JSON.stringify(store(), null, 2));
  writeFileSync(join(kit.artifacts, "host-simulator-beta.json"), JSON.stringify(store(beta), null, 2));
  copyFileSync(fakeState, join(kit.artifacts, "fixture-devices.json"));
  copyFileSync(fakeLog, join(kit.artifacts, "fixture-calls.jsonl"));
  writeFileSync(join(kit.artifacts, "browser-requests.json"), JSON.stringify(await sim(), null, 2));
  // The failed snapshot (S6) and the dropped boot (S8) are simulated network failures in the page.
  result.errors = result.errors.filter((error) => !/Failed to fetch/.test(error));
  // A tab click starts a capture at once; a reset or shutdown clicked right after makes the host refuse it while the operation runs.
  result.httpErrors = result.httpErrors.filter((error) => !(error.url.endsWith("/plugins/simulator/frame") && error.status === 409));
});

/** A small RGB PNG that looks like a phone screen: a dark status bar and a few app tiles. */
function phonePng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const tile = y > 40 && x % 45 > 10 && (y - 40) % 55 > 12 && (y - 40) % 55 < 50;
      const [r, g, b] = y < 24 ? [30, 30, 36] : tile ? [217, 119, 87] : [60 + (y / height) * 80, 90, 160];
      row.set([r, g, b], 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
