// E2E: plugin panels in Settings → Plugins (web/plugins.js). Fake model, private HOME, headless Chrome on the inbox at `/`.
// Plugins: the example `notes` (docs/plugins/examples/notes), the fixtures in scripts/fixtures/panels/, a plugin without browser files
// and one that fails to load. Failure cases written first: plugin-panels-failures.md (numbers in check labels).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createKit, delay } from "./lib/e2e-kit.mjs";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const panelFixtures = ["probe", "broken", "throws", "silent", "impostor", "retired", "late-throw", "no-style"].map((name) =>
  join(fixtures, "panels", `${name}.mjs`),
);
const plugins = [
  join(process.cwd(), "docs/plugins/examples/notes"),
  ...panelFixtures,
  join(fixtures, "policy-plugin"),
  join(fixtures, "throws-in-register.mjs"),
];
const kit = await createKit("plugin-panels", { env: { PI_PROJECTS_PLUGINS: plugins.join(":") } });
// Errors the broken fixtures raise on purpose, and the 401 of the unauthenticated route probe (16).
const EXPECTED_ERRORS = [/broken at load/, /registered as "notes"/, /retired context-panel hooks/, /thrown after register/, /panel-no-style\/ui\.css/];

await kit.run(async () => {
  const { check, rpc, result } = kit;
  kit.initRepo();
  const second = join(kit.root, "workspace-b");
  mkdirSync(second);
  kit.initRepo(second);
  const alpha = await kit.createProject("Alpha");
  const beta = await kit.createProject("Beta", { cwd: second });
  const page = await kit.openPage(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");

  const js = (value) => JSON.stringify(value);
  const shot = (label) => page.shot(label, { force: true });
  // A trusted pointer click in the middle of the element.
  const click = async (selector) => {
    const point = await page.evaluate(
      `(() => { const node = document.querySelector(${js(selector)}); if (!node) return null; node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    );
    if (!point) throw Error(`nothing to click: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const panel = (name) => `#settings .plugin-panel[data-plugin="${name}"]`;
  const panelState = (name) =>
    page.evaluate(
      `(() => { const node = document.querySelector(${js(panel(name))}); return node && { state: node.dataset.state, error: node.querySelector(".plugin-error")?.hidden ? "" : node.querySelector(".plugin-error")?.textContent, slot: node.querySelector(".plugin-slot")?.innerText ?? "" }; })()`,
    );
  const probe = () => page.evaluate(`window.__probe ? JSON.parse(JSON.stringify(window.__probe)) : null`);
  const probeText = (field) =>
    page.evaluate(`document.querySelector(${js(`${panel("panel-probe")} [data-probe-${field}]`)})?.textContent ?? ""`);
  const openPlugins = async () => {
    if (!(await page.evaluate(`document.querySelector("#settings").open`))) await click(`[data-cmd="settings"]`);
    await page.waitFor(`document.querySelector("#settings").open`, "settings open");
    await click(`#settings nav [data-section="plugins"]`);
    await page.waitFor(
      `document.querySelector(${js(panel("notes"))})?.dataset.state === "ready" && document.querySelector(${js(panel("panel-probe"))})?.dataset.state === "ready"`,
      "notes and probe panels ready",
    );
  };
  const closeSettings = async () => {
    await click(`#settings .settings-head [data-cmd="settings"]`);
    await page.waitFor(`!document.querySelector("#settings").open`, "settings closed");
  };
  const select = (projectId) =>
    page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(projectId)} }))`);
  const notesOf = async (id) => (await rpc({ action: "plugin", plugin: "notes", method: "list", id })).notes.map((note) => note.text);

  // ---- First open
  await openPlugins();
  await page.waitFor(
    `/^\\d+ /.test(document.querySelector(${js(`${panel("panel-probe")} [data-probe-echo]`)})?.textContent ?? "")`,
    "probe echo",
  );
  await page.waitFor(
    `["panel-broken", "panel-throws", "panel-silent", "panel-impostor", "panel-retired", "panel-late-throw"].every((name) => document.querySelector('#settings .plugin-panel[data-plugin="' + name + '"]')?.dataset.state === "failed")`,
    "broken panels failed",
  );
  await shot("01-settings-plugins");
  const cards = await page.evaluate(
    `[...document.querySelectorAll("#settings .plugin-card")].map((card) => ({ name: card.dataset.plugin, state: card.dataset.state, panel: !!card.querySelector(".plugin-panel"), text: card.innerText }))`,
  );
  const card = (name) => cards.find((item) => item.name === name);
  check(
    "1 every declared script and style of a loaded plugin is loaded and its panel is mounted in its own card",
    card("notes")?.panel &&
      card("panel-probe")?.panel &&
      (await page.evaluate(`document.querySelectorAll('script[src="/plugins/notes/ui.js"]').length === 1`)) &&
      (await page.evaluate(`document.querySelectorAll('link[href="/plugins/panel-probe/ui.css"]').length === 1`)) &&
      (await page.evaluate(`getComputedStyle(document.querySelector(".probe-box")).outlineColor`)) === "rgb(1, 2, 3)",
    cards,
  );
  check(
    "3 a plugin without browser files and a failed plugin stay listed without a panel",
    card("policy")?.state === "loaded" &&
      !card("policy").panel &&
      /rpc/.test(card("policy").text) &&
      card("throws")?.state === "failed" &&
      !card("throws").panel &&
      /boom in register/.test(card("throws").text),
    cards,
  );
  check(
    "4 plugin names, versions and errors are shown as text",
    /<i>0\.1<\/i>/.test(card("panel-broken")?.text) &&
      (await page.evaluate(
        `window.__pwned === undefined && !document.querySelector("#settings .plugin-card img, #settings .plugin-card i, #settings .plugin-error b")`,
      )),
    card("panel-broken"),
  );
  const broken = await panelState("panel-broken");
  check("5 a script that throws while it loads shows its error in its card", /<img src=x[^>]*> broken at load/.test(broken?.error), broken);
  const silent = await panelState("panel-silent");
  check("6 a script that never registers says so", /did not register/.test(silent?.error), silent);
  const thrown = await panelState("panel-throws");
  check(
    "7 a mount that throws shows its error and leaves no half-mounted panel",
    /mount failed <b>here<\/b>/.test(thrown?.error) && !/half mounted/.test(thrown?.slot),
    thrown,
  );
  const impostor = await panelState("panel-impostor"),
    retired = await panelState("panel-retired");
  const late = await page.evaluate(
    `(() => { try { window.piProjects.register({ name: "panel-probe", mount() {} }); return "accepted"; } catch (error) { return error.message; } })()`,
  );
  check(
    "9 registrations under another name, late, twice or with the retired hooks are refused with a reason",
    /registered as "notes"/.test(impostor?.error) &&
      /retired context-panel hooks/.test(retired?.error) &&
      !/retired mounted/.test(retired?.slot) &&
      /while its ui\.js runs/.test(late) &&
      /already registered/.test((await probe()).duplicate) &&
      /Add note/.test((await panelState("notes")).slot) &&
      !/impostor/.test((await panelState("notes")).slot),
    { impostor, retired, late, probe: await probe() },
  );
  const lateThrow = await panelState("panel-late-throw"),
    noStyle = await panelState("panel-no-style");
  check(
    "19 a script that registers and then throws while it loads fails its panel with the error",
    /thrown after register/.test(lateThrow?.error) && !/late throw mounted/.test(lateThrow?.slot),
    lateThrow,
  );
  check(
    "20 a stylesheet that cannot be loaded is reported in the card; the panel still mounts",
    noStyle?.state === "ready" && /ui\.css could not be loaded/.test(noStyle.error) && /unstyled panel/.test(noStyle.slot),
    noStyle,
  );
  check(
    "2 the browser API hands out only register and esc",
    await page.evaluate(`Object.isFrozen(window.piProjects) && Object.keys(window.piProjects).sort().join() === "esc,register"`),
  );
  check(
    "15 16 panel.rpc and panel.fetch reach the plugin's own methods and routes for the panel's project, with the token",
    (await probeText("project")) === alpha &&
      (await probeText("echo")) === `200 ${alpha}:hi` &&
      (await page.evaluate(`fetch("/plugins/panel-probe/echo?project=${alpha}&q=hi").then((answer) => answer.status)`)) === 401,
    { project: await probeText("project"), echo: await probeText("echo") },
  );

  // ---- Interaction and failures inside a mounted panel
  const mountsBefore = (await probe()).mounts;
  await click(`${panel("panel-probe")} [data-profile]`);
  await delay(300);
  check(
    "2 a click inside a panel never reaches core handlers (data-cmd, data-profile)",
    (await page.evaluate(
      `document.querySelector("#settings").open && document.querySelector("#settings").dataset.section === "plugins"`,
    )) && (await probe()).mounts === mountsBefore,
    await probe(),
  );
  await click(`${panel("panel-probe")} [data-action="panel-probe-boom"]`);
  await page.waitFor(
    `/boom in action/.test(document.querySelector(${js(`${panel("panel-probe")} .plugin-error`)})?.textContent ?? "")`,
    "action error",
  );
  await click(`${panel("panel-probe")} [data-action="panel-probe-click"]`);
  await page.waitFor(
    `/clicks 1/.test(document.querySelector(${js(`${panel("panel-probe")} [data-probe-clicks]`)})?.textContent ?? "")`,
    "first click",
  );
  const afterBoom = await panelState("panel-probe");
  check(
    "8 an action that throws shows its error; the panel stays mounted and usable",
    afterBoom.state === "ready" &&
      /<img src=x[^>]*> boom in action/.test(afterBoom.error) &&
      (await page.evaluate(`window.__pwned === undefined`)),
    afterBoom,
  );
  await shot("02-action-error");

  const hostile = "<b>ship</b> on Friday";
  await click(`${panel("notes")} [data-notes-text]`);
  await page.cdp("Input.insertText", { text: hostile });
  await click(`${panel("notes")} [data-action="notes-add"]`);
  await page.waitFor(
    `/ship<\\/b> on Friday/.test(document.querySelector(${js(`${panel("notes")} [data-notes-list]`)})?.innerText ?? "")`,
    "note listed",
  );
  check(
    "17 adding a note through the panel saves it for this project, escaped",
    (await notesOf(alpha)).includes(hostile) &&
      (await notesOf(beta)).length === 0 &&
      !(await page.evaluate(`!!document.querySelector(${js(`${panel("notes")} b`)})`)),
    await notesOf(alpha),
  );
  await shot("03-note-added");

  await click(`#settings nav [data-section="general"]`);
  await page.waitFor(
    `document.querySelector("#settings").dataset.section === "general" && !document.querySelector("#settings .settings-body .loading-line, #settings .settings-body .error-line") && document.querySelector("#settings .settings-body").children.length > 0`,
    "General section",
  );
  const left = await probe();
  check("10 another section opens and works while broken plugin cards exist", true);
  check("12 leaving the section aborts every mount", left.aborts === left.mounts, left);

  // ---- Close and reopen
  await openPlugins();
  await closeSettings();
  await openPlugins();
  await closeSettings();
  const closed = await probe();
  check("12 closing Settings aborts every mount", closed.aborts === closed.mounts && closed.mounts >= 3, closed);
  const clicksBefore = (await rpc({ action: "plugin", plugin: "panel-probe", method: "stats", id: alpha })).click;
  await openPlugins();
  await click(`${panel("panel-probe")} [data-action="panel-probe-late"]`);
  await closeSettings();
  await page.waitFor(`window.__probe.lateAttempted === true`, "late write attempted");
  await delay(500);
  check(
    "18 a write an action starts after its panel went away is never sent",
    (await rpc({ action: "plugin", plugin: "panel-probe", method: "stats", id: alpha })).click === clicksBefore &&
      (await probe()).lateError === "AbortError",
    await probe(),
  );
  await openPlugins();
  await page.waitFor(
    `/ship<\\/b> on Friday/.test(document.querySelector(${js(`${panel("notes")} [data-notes-list]`)})?.innerText ?? "")`,
    "note after reopen",
  );
  await click(`${panel("panel-probe")} [data-action="panel-probe-click"]`);
  await page.waitFor(
    `/clicks 2/.test(document.querySelector(${js(`${panel("panel-probe")} [data-probe-clicks]`)})?.textContent ?? "")`,
    "second click",
  );
  await delay(300);
  const stats = await rpc({ action: "plugin", plugin: "panel-probe", method: "stats", id: alpha });
  check(
    "11 reopening never loads a script twice or stacks handlers",
    (await page.evaluate(
      `["notes", "panel-probe", "panel-broken"].every((name) => document.querySelectorAll('script[src="/plugins/' + name + '/ui.js"]').length === 1) && document.querySelectorAll('link[href="/plugins/notes/ui.css"]').length === 1`,
    )) &&
      (await probe()).evaluations === 1 &&
      stats.click === 2,
    { stats, probe: await probe() },
  );
  check("17 the saved note shows again after Settings is reopened", true);
  await shot("04-reopened");

  // ---- Project change while Settings is open, with Alpha's answer still in flight
  await closeSettings();
  await page.evaluate(`window.__probe.slowProject = ${js(alpha)}`);
  const whoBefore = (await rpc({ action: "plugin", plugin: "panel-probe", method: "stats", id: alpha })).who;
  await click(`[data-cmd="settings"]`);
  await page.waitFor(`document.querySelector("#settings").open`, "settings open");
  await click(`#settings nav [data-section="plugins"]`);
  await kit.waitFor(
    async () => (await rpc({ action: "plugin", plugin: "panel-probe", method: "stats", id: alpha })).who > whoBefore,
    "Alpha's slow answer requested",
  );
  await select(beta);
  await page.waitFor(
    `(document.querySelector(${js(`${panel("panel-probe")} [data-probe-project]`)})?.textContent ?? "") === ${js(beta)}`,
    "Beta in probe",
  );
  await delay(2000);
  const switched = await probe();
  check(
    "13 14 a project change remounts every panel for the new project and Alpha's late answer never renders",
    (await probeText("project")) === beta &&
      switched.projects.at(-1) === beta &&
      !switched.projects.slice(switched.projects.lastIndexOf(beta)).includes(alpha) &&
      (await page.evaluate(`/Beta/.test(document.querySelector("#settings .settings-head").innerText)`)) &&
      /No notes yet/.test((await panelState("notes")).slot) &&
      switched.aborts === switched.mounts - 1,
    switched,
  );
  await shot("05-project-beta");
  await select(alpha);
  await page.waitFor(
    `/ship<\\/b> on Friday/.test(document.querySelector(${js(`${panel("notes")} [data-notes-list]`)})?.innerText ?? "")`,
    "Alpha notes again",
  );
  await shot("06-project-alpha-again");

  // ---- No project selected
  await closeSettings();
  await page.evaluate(`import("/state.js").then((bus) => { bus.state.projectId = null; })`);
  await click(`[data-cmd="settings"]`);
  await page.waitFor(`document.querySelector("#settings").open`, "settings open");
  await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(`!!document.querySelector(${js(panel("notes"))})`, "plugin cards without a project");
  await delay(500);
  const unselected = await page.evaluate(
    `[...document.querySelectorAll("#settings .plugin-panel")].map((node) => ({ name: node.dataset.plugin, state: node.dataset.state, text: node.innerText }))`,
  );
  check(
    "21 without a selected project every panel says it needs one instead of loading forever",
    unselected.length > 0 && unselected.every((item) => item.state === "idle" && /Select a project/.test(item.text)),
    unselected,
  );

  result.errors = result.errors.filter((error) => !EXPECTED_ERRORS.some((pattern) => pattern.test(error)));
  result.httpErrors = result.httpErrors.filter(
    (error) =>
      !(error.url.endsWith("/plugins/panel-probe/echo") && error.status === 401) && !error.url.endsWith("/plugins/panel-no-style/ui.css"),
  );
});
