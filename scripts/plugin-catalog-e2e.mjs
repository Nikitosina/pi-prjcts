// E2E: the bundled plugin catalog in Settings → Plugins (scripts/plugin-catalog-failures.md, numbers in check labels) together with the
// per-project switches (plugin-enable-failures.md). Fake model, private HOME with two external plugins already configured, headless Chrome on
// the inbox at `/`, desktop and mobile, a real host restart, and two projects.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";

const kit = await createKit("plugin-catalog");
const external = join(process.cwd(), "scripts/fixtures/second-plugin");
const gated = join(process.cwd(), "scripts/fixtures/gated-plugin");
const slow = join(kit.root, "startup-delay.mjs");
writeFileSync(slow, 'await new Promise(r => setTimeout(r, 2500)); export default {name:"delay", register(){}};');
const configFile = join(kit.home, "plugins.json");
mkdirSync(kit.home, { recursive: true });
writeFileSync(configFile, JSON.stringify({ plugins: [external, gated, slow], keep: "me" }, null, 2) + "\n");
const tasksDir = join(process.cwd(), "plugins/tasks");

await kit.run(async () => {
  const { check, rpc } = kit;
  kit.initRepo();
  const alpha = await kit.createProject("Alpha");
  const beta = await kit.createProject("Beta");
  const page = await kit.openPage(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  const js = (value) => JSON.stringify(value);
  const shot = (label) => page.shot(label, { force: true });
  const click = async (selector) => {
    const point = await page.evaluate(
      `(() => { const node = document.querySelector(${js(selector)}); if (!node) return null; node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    );
    if (!point) throw Error(`nothing to click: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const row = (id) => `#settings .catalog-row[data-catalog="${id}"]`;
  const rowState = (id) => page.evaluate(`document.querySelector(${js(row(id))})?.dataset.state ?? null`);
  const config = () => JSON.parse(readFileSync(configFile, "utf8"));
  const openPlugins = async () => {
    if (!(await page.evaluate(`document.querySelector("#settings").open`))) await click(`[data-cmd="settings"]`);
    await page.waitFor(`document.querySelector("#settings").open`, "settings open");
    await click(`#settings nav [data-section="plugins"]`);
    await page.waitFor(`document.querySelector(${js(row("tasks"))})`, "catalog drawn");
  };

  // 2: before anything is loaded, both bundled plugins are listed with their description.
  const first = await rpc({ action: "plugin-catalog" });
  check(
    "2 both listed as available",
    first.entries.map((item) => `${item.id}:${item.state}`).join() === "tasks:available,simulator:available",
    first,
  );
  check("14 the private host's config is the temp one", kit.home.startsWith(kit.root) && config().keep === "me");
  await openPlugins();
  check(
    "2 the UI lists tasks and simulator as available",
    (await rowState("tasks")) === "available" && (await rowState("simulator")) === "available",
  );
  check(
    "17 the external plugin's card is still below the catalog",
    await page.evaluate(
      `!!document.querySelector('#settings .plugin-card[data-plugin="second"]') && document.querySelector("#settings .plugin-catalog").compareDocumentPosition(document.querySelector('#settings .plugin-card')) & Node.DOCUMENT_POSITION_FOLLOWING`,
    ),
  );
  await shot("01-catalog-desktop-available");

  // 16/7: one click activates; the button is gone after, and repeated requests change nothing.
  await click(`${row("tasks")} [data-catalog-activate]`);
  await page.waitFor(`document.querySelector(${js(row("tasks"))})?.dataset.state === "configured"`, "tasks configured");
  check("16 no activate button after", await page.evaluate(`!document.querySelector(${js(`${row("tasks")} [data-catalog-activate]`)})`));
  const restart = `${row("tasks")} [data-catalog-restart]`;
  const confirm = `${row("tasks")} [data-confirm-restart]`;
  check("restart offered", await page.evaluate(`!!document.querySelector(${js(restart)})`));
  const afterClick = readFileSync(configFile, "utf8");
  check(
    "6 the external entry, its order and the extra key are kept",
    config().plugins[0] === external &&
      config().plugins[1] === gated &&
      config().plugins[3] === tasksDir &&
      config().keep === "me" &&
      config().plugins.length === 4,
    config(),
  );
  await Promise.all([rpc({ action: "plugin-activate", plugin: "tasks" }), rpc({ action: "plugin-activate", plugin: "tasks" })]);
  check("7 duplicate requests leave the file byte for byte", readFileSync(configFile, "utf8") === afterClick);
  const running = await rpc({ action: "plugins" });
  check(
    "12/13 the running host did not load it",
    !running.plugins.some((item) => item.name === "tasks") &&
      running.plugins.some((item) => item.name === "second" && item.state === "loaded"),
    running.plugins,
  );
  check("12 the catalog says configured", (await rpc({ action: "plugin-catalog" })).entries[0].state === "configured");
  await shot("02-catalog-desktop-configured");

  // 3: ids outside the catalog are refused by the schema.
  for (const plugin of ["../tasks", tasksDir, "github", "https://example.invalid/x"])
    check(`3 refused: ${plugin}`, (await kit.rejects({ action: "plugin-activate", plugin })) !== null);
  check("3 the file did not change", readFileSync(configFile, "utf8") === afterClick);

  const before = await rpc({ action: "plugin-catalog" });
  await click(restart);
  check(
    "confirmation warns of interruption",
    await page.evaluate(`/interrupt/i.test(document.querySelector(${js(row("tasks"))}).innerText)`),
  );
  await shot("03-confirm-restart");
  await click(`${row("tasks")} [data-cancel-restart]`);
  check(
    "cancel kept the instance and config",
    (await rpc({ action: "plugin-catalog" })).instance === before.instance && readFileSync(configFile, "utf8") === afterClick,
  );
  const replay = { action: "plugin-restart", plugin: "tasks", instance: before.instance };
  check("arbitrary command refused", !!(await kit.rejects({ ...replay, command: "invalid" })));
  // 18: phone width.
  await page.viewport(390, 844, true);
  await page.waitFor(`document.querySelector(${js(row("simulator"))})`, "mobile layout");
  const fits = await page.evaluate(
    `(() => { const box = document.querySelector(${js(row("simulator"))}).getBoundingClientRect(); const button = document.querySelector(${js(`${row("simulator")} [data-catalog-activate]`)}).getBoundingClientRect(); return box.right <= innerWidth && button.right <= innerWidth && button.left >= 0 && document.documentElement.scrollWidth <= innerWidth; })()`,
  );
  check("18 rows and buttons fit a 390 px phone", fits);
  await shot("04-catalog-mobile-configured");
  await page.viewport(1440, 1000);

  // The original tab confirms, reconnects and shows the loader’s result without navigating.
  await click(restart);
  await click(confirm);
  await page.waitFor(
    `document.querySelector(${js(row("tasks"))})?.dataset.state === "loaded"`,
    "same tab reconnected to loaded tasks",
    600,
  );
  const after = await rpc({ action: "plugin-catalog" });
  const head = kit.git(kit.core, "rev-parse", "HEAD");
  check(
    "same revision, replacement instance",
    before.sha === head && after.sha === head && after.instance !== before.instance && after.previous === before.instance,
  );
  check("old confirmation cannot restart the replacement", /instance/i.test(await kit.rejects(replay)));
  const health = await rpc();
  check("replacement owns the private home", health.home === kit.home);
  writeFileSync(join(kit.artifacts, "restart.json"), JSON.stringify({ home: health.home, pid: health.pid, before, after }, null, 2));
  const reloaded = await rpc({ action: "plugins" });
  check(
    "12 after the restart tasks and the external plugin are loaded",
    ["tasks", "second", "gated"].every((name) => reloaded.plugins.find((item) => item.name === name)?.state === "loaded"),
    reloaded.plugins,
  );
  check(
    "12 the catalog says loaded with a version",
    (await rpc({ action: "plugin-catalog" })).entries[0].state === "loaded" &&
      (await rpc({ action: "plugin-catalog" })).entries[0].version === "1.0.0",
  );
  check(
    "7 activating a loaded plugin changes nothing",
    (await rpc({ action: "plugin-activate", plugin: "tasks" })) && readFileSync(configFile, "utf8") === afterClick,
  );
  await page.navigate(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready after restart");
  await openPlugins();
  await page.waitFor(`document.querySelector(${js(row("tasks"))})?.dataset.state === "loaded"`, "tasks loaded in the UI");
  await shot("05-catalog-desktop-loaded");

  // Catalog and project switches together: the plugin the catalog activated is switched per project, the catalog stays host-wide.
  const entry = async (id, name) => (await rpc({ action: "plugins", id })).plugins.find((item) => item.name === name);
  const set = (id, plugin, enabled) => rpc({ action: "project-plugin", id, plugin, enabled });
  const toggle = (name) => `#settings [data-plugin-toggle="${name}"]`;
  const catalogState = async () => (await rpc({ action: "plugin-catalog" })).entries.find((item) => item.id === "tasks").state;
  check(
    "C1 a plugin activated from the catalog and loaded after the restart is on in every project",
    (await entry(alpha, "tasks"))?.enabled === true && (await entry(beta, "tasks"))?.enabled === true,
  );
  await page.evaluate(`document.querySelector("#settings").open || document.querySelector('[data-cmd="settings"]').click()`);
  await page.waitFor(`document.querySelector(${js(toggle("tasks"))})?.checked`, "tasks switch on in Alpha");
  check("C2 the catalog row and the project switch show side by side", (await rowState("tasks")) === "loaded");
  await shot("06-combined-tasks-on");
  await click(toggle("tasks"));
  await page.waitFor(`!document.querySelector(${js(toggle("tasks"))})?.checked`, "tasks switched off in Alpha");
  check(
    "C3 the switch turns the plugin off in Alpha only",
    (await entry(alpha, "tasks")).enabled === false && (await entry(beta, "tasks")).enabled === true,
  );
  check(
    "C4 the host-wide catalog still says loaded and keeps its row",
    (await catalogState()) === "loaded" && (await rowState("tasks")) === "loaded",
  );
  check(
    "C5 the catalog offers no activate button for a plugin a project turned off",
    await page.evaluate(`!document.querySelector(${js(`${row("tasks")} [data-catalog-activate]`)})`),
  );
  await shot("07-combined-tasks-off-in-alpha");
  check("C6 the project's switch change did not touch plugins.json", readFileSync(configFile, "utf8") === afterClick);

  // An unresolved write of a plugin refuses its switch in the UI; the catalog block stays drawn and the plugin stays on.
  await rpc({ action: "plugin", plugin: "gated", method: "mark-uncertain", params: { projectId: alpha, mode: "yes" } });
  await click(toggle("gated"));
  await page.waitFor(`/unknown outcome/.test(document.body.innerText)`, "unresolved write refusal shown");
  await page.waitFor(`document.querySelector(${js(toggle("gated"))})?.checked`, "the refused switch redrawn on");
  check(
    "C7 the refused switch stays on and the plugin is still enabled",
    (await entry(alpha, "gated")).enabled === true && (await page.evaluate(`document.querySelector(${js(toggle("gated"))}).checked`)),
  );
  check("C8 the catalog block survives the refusal redraw", (await rowState("tasks")) === "loaded");
  await shot("08-combined-unresolved-write");
  const refused = await rpc({ action: "project-plugin", id: alpha, plugin: "gated", enabled: false }).then(
    () => "",
    (error) => error.message,
  );
  check("C9 the host refuses the same disable by RPC", /unknown outcome/.test(refused), refused);
  await rpc({ action: "plugin", plugin: "gated", method: "mark-uncertain", params: { projectId: alpha, mode: "no" } });
  check(
    "C10 once resolved, the disable goes through",
    (await set(alpha, "gated", false)).enabled === false && (await entry(beta, "gated")).enabled === true,
  );

  // The catalog is read when Settings → Plugins draws, never by chat sends or project switches.
  await page.evaluate(`document.querySelector("#settings").close()`);
  await page.evaluate(
    `(() => { window.__catalogCalls = 0; const original = window.fetch; window.fetch = (input, init) => { if (typeof init?.body === "string" && /"action":"plugin-catalog"/.test(init.body)) window.__catalogCalls++; return original(input, init); }; })()`,
  );
  await page.evaluate(`document.querySelector('#composer-input').focus()`);
  await page.cdp("Input.insertText", { text: "hello catalog" });
  await page.evaluate(`document.querySelector('#composer').requestSubmit()`);
  await kit.eventually(
    async () => (await rpc({ action: "show", id: alpha })).messages.some((m) => m.text === "hello catalog"),
    "message sent",
  );
  await click(`.tree-head[data-project="${beta}"]`);
  await click(`.tree-head[data-project="${alpha}"]`);
  await kit.delay(1500);
  check("C11 chat sends and project switches never read the catalog", (await page.evaluate("window.__catalogCalls")) === 0);

  // C12: with Settings → Plugins open, selecting another project keeps the host-scoped catalog without reading it again.
  const select = async (id) => {
    await page.evaluate(`import('/state.js').then((m) => m.emit('select-request', { projectId: ${js(id)}, chatId: 'main' }))`);
    await page.waitFor(`location.search.includes(${js(id)})`, "project selected");
  };
  await openPlugins();
  await page.waitFor(`!!document.querySelector(${js(toggle("second"))})`, "second switch");
  await page.evaluate("window.__catalogCalls = 0");
  await select(beta);
  await page.waitFor(
    `document.querySelector("#settings .plugin-catalog") && !!document.querySelector(${js(toggle("second"))})`,
    "beta redraw",
  );
  await select(alpha);
  await kit.delay(1000);
  check("C12 selecting projects with Settings open does not read the catalog again", (await page.evaluate("window.__catalogCalls")) === 0);
  check("C12 the catalog rows stay drawn", (await rowState("tasks")) === "loaded" && (await rowState("simulator")) === "available");

  // C13: the answer of a switch clicked in one project says nothing in another project after a selection.
  await page.evaluate(
    `(() => { const original = window.fetch; window.__fetchOriginal = original; window.__held = new Promise((resolve) => (window.__release = resolve)); window.fetch = async (input, init) => { if (typeof init?.body === "string" && /"action":"project-plugin"/.test(init.body)) await window.__held; return original(input, init); }; })()`,
  );
  await click(toggle("second"));
  await select(beta);
  await page.waitFor(`!!document.querySelector(${js(toggle("second"))})`, "beta switches");
  await page.evaluate("window.__release()");
  await kit.eventually(async () => (await entry(alpha, "second")).enabled === false, "the held switch reached the host");
  await kit.delay(500);
  check(
    "C13 no success toast or status for the other project",
    await page.evaluate(
      `!/second (on|off) in this project/.test(document.querySelector("#toasts").innerText + document.querySelector("#settings .settings-status").innerText)`,
    ),
  );
  check("C13 the project that was selected keeps its own switch", (await entry(beta, "second")).enabled === true);
  await page.evaluate("window.fetch = window.__fetchOriginal");
  await set(alpha, "second", true);

  // C14: a refused activation keeps every catalog row and the button, so the owner can retry.
  await select(alpha);
  await page.waitFor(`document.querySelector(${js(row("simulator"))})`, "rows after selection");
  await page.evaluate(
    `(() => { const original = window.fetch; window.__fetchOriginal = original; window.fetch = async (input, init) => typeof init?.body === "string" && /"action":"plugin-activate"/.test(init.body) ? new Response(JSON.stringify({ ok: false, error: "disk full" }), { status: 500 }) : original(input, init); })()`,
  );
  await click(`${row("simulator")} [data-catalog-activate]`);
  await page.waitFor(`/disk full/.test(document.querySelector("#settings .plugin-catalog").innerText)`, "activation error shown");
  check("C14 both rows stay after the refusal", (await rowState("tasks")) === "loaded" && (await rowState("simulator")) === "available");
  check(
    "C14 the button is usable again",
    await page.evaluate(`document.querySelector(${js(`${row("simulator")} [data-catalog-activate]`)})?.disabled === false`),
  );
  await shot("09-activation-refused");
  await page.evaluate("window.fetch = window.__fetchOriginal");
  await click(`${row("simulator")} [data-catalog-activate]`);
  await page.waitFor(`document.querySelector(${js(row("simulator"))})?.dataset.state === "configured"`, "retry configured it");
  check(
    "C14 the retry works and clears the error",
    await page.evaluate(`!/disk full/.test(document.querySelector("#settings .plugin-catalog").innerText)`),
  );
});
