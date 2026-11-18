// E2E: plugin sections in the chat's right panel (web/sidebar.js, web/plugins.js). Fake model, private HOME, headless Chrome on the inbox at `/`.
// Plugins: the example `notes`, the fixtures in scripts/fixtures/sidebar/, a settings-only panel and a plugin without browser files.
// Failure cases written first: plugin-sidebar-failures.md (numbers in check labels).
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createKit, delay } from "./lib/e2e-kit.mjs";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const plugins = [
  join(process.cwd(), "docs/plugins/examples/notes"),
  ...["side-a", "side-b", "side-broken", "side-silent"].map((name) => join(fixtures, "sidebar", `${name}.mjs`)),
  join(fixtures, "panels", "probe.mjs"),
  join(fixtures, "policy-plugin"),
];
const kit = await createKit("plugin-sidebar", { env: { PI_PROJECTS_PLUGINS: plugins.join(":") } });
const EXPECTED_ERRORS = [/section failed/, /registered none/];

await kit.run(async () => {
  const { check, rpc, result } = kit;
  kit.initRepo();
  const second = join(kit.root, "workspace-b");
  mkdirSync(second);
  kit.initRepo(second);
  const alpha = await kit.createProject("Alpha");
  const beta = await kit.createProject("Beta", { cwd: second });
  const one = (await rpc({ action: "chat-create", id: alpha, title: "One" })).id;
  const two = (await rpc({ action: "chat-create", id: alpha, title: "Two" })).id;
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
  const select = (projectId, chatId = "main") =>
    page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(projectId)}, chatId: ${js(chatId)} }))`);
  const sections = () =>
    page.evaluate(
      `[...document.querySelectorAll("#plugin-sections > .plugin-section")].map((node) => ({ name: node.dataset.plugin, state: node.dataset.state, title: node.querySelector("h2").textContent, error: node.querySelector(".plugin-error").hidden ? "" : node.querySelector(".plugin-error").textContent, slot: node.querySelector(".plugin-slot").innerText }))`,
    );
  const section = async (name) => (await sections()).find((item) => item.name === name);
  const log = () => page.evaluate(`JSON.parse(JSON.stringify(window.__side ?? null))`);
  const settled = (name, state = "ready") =>
    page.waitFor(`document.querySelector('#plugin-sections [data-plugin="${name}"]')?.dataset.state === ${js(state)}`, `${name} ${state}`);

  // ---- First selection (main chat of Alpha)
  for (const name of ["notes", "side-a", "side-b"]) await settled(name);
  for (const name of ["side-broken", "side-silent"]) await settled(name, "failed");
  await page.waitFor(
    `/alpha|${alpha}/.test(document.querySelector('#plugin-sections [data-plugin="side-a"] [data-side-echo]')?.textContent ?? "")`,
    "echo",
  );
  await shot("01-desktop-sections");
  const first = await sections();
  check(
    "1 2 only opted-in plugins get a section, in load order, each in its own section; settings-only and no-web plugins get nothing",
    first.map((item) => item.name).join() === "notes,side-a,side-b,side-broken,side-silent" &&
      !(await page.evaluate(`/panel-probe|policy/.test(document.querySelector("#context").innerText)`)),
    first,
  );
  const a = await section("side-a");
  check(
    "2 8 12 a section reads its own plugin for the selected project and chat; the title is text",
    a.slot.includes(`${alpha}/main`) &&
      a.slot.includes(`${alpha}:main`) &&
      a.title === "Side A <i>one</i>" &&
      (await section("side-b")).slot === "main",
    a,
  );
  check(
    "10 failing sections show their error in their own section and the others, Workers and Pull requests stay",
    /section failed <b>here<\/b>/.test((await section("side-broken")).error) &&
      !/half/.test((await section("side-broken")).slot) &&
      /registered none/.test((await section("side-silent")).error) &&
      (await page.evaluate(
        `!!document.querySelector("#workers") && !!document.querySelector("#prs") && !document.querySelector("#context img, #context i b")`,
      )),
    await sections(),
  );
  check(
    "4 Workers and Pull requests come first in the panel",
    await page.evaluate(
      `(() => { const ids = [...document.querySelector("#context").children].map((node) => node.id || node.querySelector("[id]")?.id); return ids.join() === "workers-h,prs-h,plugin-sections"; })()`,
    ),
  );

  // ---- 5 6: stale reads across chats
  await page.evaluate(`window.__side.slowChat = ${js(one)}`);
  await select(alpha, one);
  await page.waitFor(`window.__side.mounts.some((mount) => mount.chatId === ${js(one)})`, "chat one mounted");
  await select(alpha, two);
  await settled("side-a");
  await page.waitFor(
    `document.querySelector('#plugin-sections [data-plugin="side-a"] [data-side-chat]')?.textContent === ${js(`${alpha}/${two}`)}`,
    "chat two content",
  );
  await delay(2000);
  const switched = await log();
  check(
    "5 6 selecting a chat remounts every section with the new chat and the slow answer of the previous chat never renders",
    (await section("side-a")).slot.includes(`${alpha}/${two}`) &&
      !(await section("side-a")).slot.includes(one) &&
      (await section("side-b")).slot === two &&
      switched.mounts.map((mount) => mount.chatId).join() === ["main", one, two].join() &&
      switched.aborts.includes(one) &&
      switched.aborts.includes("main"),
    switched,
  );
  await shot("02-chat-two");

  // ---- 6: a stale rejection is an AbortError too
  await page.evaluate(`window.__side.failChat = ${js(one)}; window.__side.slowChat = ${js(one)}`);
  await select(alpha, one);
  await page.waitFor(`window.__side.mounts.filter((mount) => mount.chatId === ${js(one)}).length === 2`, "chat one failing read mounted");
  await select(alpha, two);
  await settled("side-a");
  await delay(2000);
  check(
    "6 a read that rejects after the selection changed rejects as AbortError, never as the stale read error",
    (await log()).staleError === "AbortError",
    await log(),
  );

  // ---- 7: normal refresh does not remount
  await page.evaluate(`window.__side.failChat = null; window.__side.slowChat = null`);
  const mountsBefore = (await log()).mounts.length;
  await rpc({ action: "chat-create", id: alpha, title: "Three" });
  await page.evaluate(`import("/workers.js").then((workers) => Promise.all([workers.loadJobs(), workers.loadSide()]))`);
  await select(alpha, two);
  await delay(1500);
  check(
    "7 a refresh, a new chat elsewhere and re-selecting the same chat mount nothing again",
    (await log()).mounts.length === mountsBefore,
    await log(),
  );
  await page.evaluate(
    `import("/state.js").then((bus) => { bus.state.view = null; bus.emit("select-request", { projectId: ${js(alpha)}, chatId: ${js(two)} }); })`,
  );
  await delay(500);
  check(
    "7 re-selecting the same chat while its view is still loading does not mount again",
    (await log()).mounts.length === mountsBefore,
    await log(),
  );
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("plugins-changed"))`);
  await delay(500);
  check(
    "7 a plugin status refresh with the same enabled set mounts nothing again",
    (await log()).mounts.length === mountsBefore,
    await log(),
  );

  // ---- 9 11: clicks stay inside, late calls are never sent
  await click(`#plugin-sections [data-plugin="side-a"] [data-profile]`);
  await click(`#plugin-sections [data-plugin="side-a"] [data-action="side-a-late"]`);
  await select(alpha, one);
  await page.waitFor(`window.__side.lateAttempted === true`, "late action ran");
  await delay(300);
  const stats = await rpc({ action: "plugin", plugin: "side-a", method: "stats", id: alpha });
  check(
    "9 11 a click in a section never reaches core handlers; a call after the section went away is not sent and rejects with AbortError",
    (await log()).lateError === "AbortError" &&
      stats.pings === 0 &&
      (await page.evaluate(`document.querySelector("#settings").open === false`)),
    { log: await log(), stats },
  );

  // ---- Per-project enablement (on hosts that have it; this base does not)
  const scoped = await rpc({ action: "plugins", id: alpha });
  if (scoped.plugins.some((plugin) => plugin.enabled !== undefined)) {
    await rpc({ action: "project-plugin", id: beta, plugin: "side-b", enabled: false });
    await select(beta);
    await settled("side-a");
    check(
      "1 a plugin disabled in a project gets no section there",
      !(await section("side-b")) && (await section("side-a"))?.state === "ready",
      await sections(),
    );
    await select(alpha, two);
    await settled("side-b");
    const abortsBeforeDisable = (await log()).aborts.length;
    await rpc({ action: "project-plugin", id: alpha, plugin: "side-b", enabled: false });
    await page.waitFor(`!document.querySelector('#plugin-sections [data-plugin="side-b"]')`, "disabled section removed");
    await delay(300);
    check(
      "5 disabling a plugin in the selected project removes its section and aborts the other sections' old mounts without affecting other projects",
      (await log()).aborts.length > abortsBeforeDisable && (await section("side-a"))?.state === "ready",
      await log(),
    );
    await rpc({ action: "project-plugin", id: alpha, plugin: "side-b", enabled: true });
    await settled("side-b");
    await rpc({ action: "project-plugin", id: beta, plugin: "side-b", enabled: true });
  }

  // ---- Project switch
  await select(beta);
  await page.waitFor(
    `document.querySelector('#plugin-sections [data-plugin="side-a"] [data-side-chat]')?.textContent === ${js(`${beta}/main`)}`,
    "beta content",
  );
  check(
    "5 a project change mounts every section for the new project",
    (await section("side-a")).slot.includes(`${beta}:main`),
    await sections(),
  );

  // ---- Settings and sidebar together (3 13)
  await click(`[data-cmd="settings"]`);
  await page.waitFor(`document.querySelector("#settings").open`, "settings open");
  await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(
    `document.querySelector('#settings .plugin-panel[data-plugin="side-a"]')?.dataset.state === "ready"`,
    "side-a settings panel",
  );
  await delay(500);
  const cards = await page.evaluate(
    `[...document.querySelectorAll("#settings .plugin-card")].map((card) => ({ name: card.dataset.plugin, panel: !!card.querySelector(".plugin-panel"), text: card.querySelector(".plugin-panel")?.innerText ?? "" }))`,
  );
  check(
    "3 13 a plugin with both mounts once in Settings and once in the panel from one script; a sidebar-only plugin has no Settings panel; settings-only plugins are unchanged",
    cards.find((card) => card.name === "side-a")?.text === "side-a settings" &&
      !cards.find((card) => card.name === "side-b")?.panel &&
      cards.find((card) => card.name === "panel-probe")?.panel &&
      (await page.evaluate(`document.querySelectorAll('script[src="/plugins/side-a/ui.js"]').length === 1`)) &&
      (await log()).evaluations === 1,
    cards,
  );
  await shot("03-settings-with-sidebar");
  await click(`#settings .settings-head [data-cmd="settings"]`);

  // ---- Mobile
  await select(alpha, two);
  await page.viewport(390, 844, true);
  await settled("side-a");
  await click(`[data-cmd="toggle-context"]`);
  await page.waitFor(`document.querySelector("#app").dataset.sheet === "context"`, "context sheet");
  await delay(500);
  const mobile = await page.evaluate(
    `(() => { const box = document.querySelector("#plugin-sections").getBoundingClientRect(); const sheet = document.querySelector("#context").getBoundingClientRect(); return { visible: getComputedStyle(document.querySelector("#context")).visibility, inside: box.right <= sheet.right + 1 && box.left >= sheet.left - 1, workers: !!document.querySelector("#workers"), sections: document.querySelectorAll("#plugin-sections > .plugin-section").length }; })()`,
  );
  await shot("04-mobile-sheet");
  check(
    "4 the mobile sheet shows the sections inside it next to Workers and Pull requests",
    mobile.visible === "visible" && mobile.inside && mobile.workers && mobile.sections === 5,
    mobile,
  );
  await page.viewport(1440, 1000);

  result.errors = result.errors.filter((error) => !EXPECTED_ERRORS.some((pattern) => pattern.test(error)));
});
