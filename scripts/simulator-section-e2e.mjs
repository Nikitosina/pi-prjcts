// E2E: the simulator plugin's declarative section in Settings → Plugins (plugins/simulator/section.ts). Fake model, private HOME, headless
// Chrome on the inbox at `/`, and fixture devices: a fake simslim (scripts/fixtures/simulator/) answers from a JSON device list, so no real
// simulator is listed or changed. Failure cases written first: plugins/simulator/FAILURES.md, "Settings section".
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";
import { requestIds, simulatorView } from "../plugins/simulator/section.ts";

const fixtures = new URL("./fixtures/simulator/", import.meta.url).pathname;
const bin = join(process.env.TMPDIR ?? "/tmp", `simulator-section-${randomUUID()}`);
mkdirSync(bin, { recursive: true, mode: 0o700 });
const fakeState = join(bin, "devices.json"),
  fakeLog = join(bin, "calls.jsonl");
writeFileSync(
  join(bin, "simslim"),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fixtures, "fake-simslim.mjs"))} "$@"\n`,
);
chmodSync(join(bin, "simslim"), 0o755);
writeFileSync(fakeLog, "");

const kit = await createKit("simulator-section", {
  env: {
    PI_PROJECTS_PLUGINS: join(process.cwd(), "plugins/simulator"),
    PI_PROJECTS_SIMSLIM: join(bin, "simslim"),
    SIMULATOR_FAKE_STATE: fakeState,
    SIMULATOR_FAKE_LOG: fakeLog,
  },
});

const udid = () => randomUUID().toUpperCase();
const SOURCE = udid(),
  CLONE_A = udid(),
  CLONE_B = udid();
const HOSTILE = `erase <b>failed</b> <img src=x onerror="window.__pwned=1">`;

await kit.run(async () => {
  const { check, rpc } = kit;
  const js = (value) => JSON.stringify(value);
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
        { udid: CLONE_A, name: owned[0].name, state: "Booted", osVersion: "18.2", set: "default" },
        { udid: CLONE_B, name: owned[1].name, state: "Shutdown", osVersion: "18.2", set: "default" },
      ],
    }),
  );
  const storeFile = (id) => join(kit.home, id, "simulator.json");
  writeFileSync(
    storeFile(alpha),
    JSON.stringify({
      version: 2,
      projectId: alpha,
      enabled: true,
      sourceUdid: SOURCE,
      owned,
      pending: null,
      uncertain: null,
      receipts: {},
    }),
  );
  const store = (id = alpha) => (existsSync(storeFile(id)) ? JSON.parse(readFileSync(storeFile(id), "utf8")) : null);
  const setFail = (fail) => {
    const state = JSON.parse(readFileSync(fakeState, "utf8"));
    writeFileSync(fakeState, JSON.stringify({ ...state, fail }));
  };
  const fakeCalls = () =>
    readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  // ---- The RPC methods and their policies stay; the screenshot route is gone
  const snapshot = await rpc({ action: "plugin", plugin: "simulator", method: "snapshot", id: alpha });
  check(
    "rpc snapshot still answers the owned clones",
    snapshot.devices.map((item) => item.udid).join() === `${CLONE_A},${CLONE_B}`,
    snapshot,
  );
  const unconfirmed = await kit.rejects({
    action: "plugin",
    plugin: "simulator",
    method: "recover",
    id: alpha,
    params: { requestId: randomUUID() },
  });
  check("rpc recover still refuses a request without confirm", /Invalid simulator request/.test(unconfirmed), unconfirmed);
  const sections = (await rpc({ action: "plugins", id: alpha })).sections;
  check(
    "the plugin declares two settings sections",
    JSON.stringify(sections) ===
      JSON.stringify([
        { plugin: "simulator", id: "simulators", title: "iOS simulators", place: "settings", refreshMs: 3000 },
        { plugin: "simulator", id: "slimming", title: "Simulator slimming", place: "settings", refreshMs: 3000 },
      ]),
    sections,
  );
  // ---- C5 request ids: stable while nothing changes, new after a configure
  const read = (section) => rpc({ action: "plugin-section", plugin: "simulator", section, id: alpha });
  const ids = (view) => view.rows.flatMap((row) => (row.buttons ?? []).map((button) => button.params.requestId));
  const idsBefore = [...ids(await read("simulators")), ...ids(await read("slimming"))];
  check(
    "C5 two reads of an unchanged state carry the same request ids",
    js(idsBefore) === js([...ids(await read("simulators")), ...ids(await read("slimming"))]) &&
      new Set(idsBefore).size === idsBefore.length,
    idsBefore,
  );

  // ---- The lease holder: leases only exist while a worker runs, so the view is checked with a holder in the snapshot.
  const leased = simulatorView(
    alpha,
    {
      ...snapshot,
      devices: snapshot.devices.map((item, index) => ({ ...item, lease: index ? null : { threadId: "thread-7", projectId: alpha } })),
    },
    requestIds("seed"),
  );
  check(
    "a clone row names its lease holder, or says it is not in use",
    leased.rows
      .filter((row) => row.label === "Clone")
      .map((row) => row.detail[0])
      .join() === "In use by thread-7,Not in use",
    leased.rows,
  );

  const page = await kit.openPage(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  const shot = (label) => page.shot(label, { force: true });
  const frame = await page.evaluate(
    `import("/api.js").then((api) => api.localHost.authorizedFetch("/plugins/simulator/frame?project=${alpha}").then((answer) => answer.status))`,
  );
  check("the frame route is removed", frame === 404, frame);
  await page.evaluate("new Promise((ok) => setTimeout(ok, 300))");
  kit.result.httpErrors = kit.result.httpErrors.filter((error) => !error.url.endsWith("/plugins/simulator/frame"));

  const card = `#settings .plugin-card[data-plugin="simulator"]`;
  const at = (section) => `${card} .plugin-section[data-section="${section}"]`;
  const box = at("simulators");
  const view = (section = "simulators") =>
    page.evaluate(
      `(() => { const node = document.querySelector(${js(at(section))}); if (!node) return null; return { state: node.dataset.state, title: node.querySelector(".section-title").textContent, error: node.querySelector(".plugin-error").hidden ? "" : node.querySelector(".plugin-error").textContent, rows: [...node.querySelectorAll(".section-row")].map((row) => ({ label: row.querySelector(".section-label")?.textContent ?? "", text: row.querySelector(".section-text").textContent, status: row.querySelector(".section-status")?.textContent ?? "", detail: [...row.querySelectorAll(".section-detail")].map((line) => line.textContent), buttons: [...row.querySelectorAll("button")].map((button) => button.textContent + ":" + button.dataset.kind), confirm: row.querySelector(".section-confirm p")?.textContent ?? null })) }; })()`,
    );
  const press = (label, section = "simulators", row = 0) =>
    page.evaluate(
      `[...document.querySelectorAll(${js(`${at(section)} .section-row`)})].flatMap((item) => [...item.querySelectorAll("button")]).filter((node) => node.textContent === ${js(label)} && !node.disabled)[${row}].click()`,
    );
  const waitView = (test, label, section) => kit.eventually(async () => test(await view(section)), label);
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await page.waitFor(`document.querySelector("#settings").open`, "settings open");
  await page.evaluate(`document.querySelector('#settings nav [data-section="plugins"]').click()`);
  await waitView((v) => v?.state === "ready", "simulator section");

  // ---- Management and the owned clones
  const first = await view();
  check(
    "C1 C2 the section shows management on with its button, and one row per owned clone with name, state and holder",
    first.title === "iOS simulators" &&
      first.rows[0].label === "Management" &&
      /^On\./.test(first.rows[0].text) &&
      first.rows[0].buttons.join() === "Turn off:write" &&
      first.rows
        .filter((row) => row.label === "Clone")
        .map((row) => `${row.text}|${row.status}|${row.detail[0]}`)
        .join() === "iPhone 16 Pro 1|Running|Not in use,iPhone 16 Pro 2|Shut down|Not in use" &&
      first.rows.length === 3,
    first,
  );
  await shot("01-simulator-section");

  // ---- Turn off asks first, sends one configure; Turn on sends one configure without asking
  await press("Turn off");
  await waitView((v) => v.rows[0].confirm !== null, "turn off confirmation");
  check(
    "C1 turning management off asks first and names what is kept",
    /Owned clones and their data are kept/.test((await view()).rows[0].confirm),
  );
  await shot("02-turn-off-confirmation");
  await page.evaluate(`document.querySelector(${js(`${box} .section-confirm [data-cancel]`)}).click()`);
  check("C1 Cancel sends nothing", store().enabled === true);
  await press("Turn off");
  await waitView((v) => v.rows[0].confirm !== null, "turn off confirmation again");
  await page.evaluate(`document.querySelector(${js(`${box} .section-confirm [data-confirm]`)}).click()`);
  await kit.eventually(() => store().enabled === false, "management off");
  await waitView((v) => v.rows[0].status === "Off" && v.rows[0].buttons.join() === "Turn on:write", "off drawn");
  await press("Turn on");
  await kit.eventually(() => store().enabled === true, "management on");
  await waitView((v) => /^On\./.test(v.rows[0].text), "on drawn");
  check(
    "C1 each confirmed switch sent one configure with its own request id",
    Object.keys(store().receipts).length === 2,
    store().receipts,
  );

  // ---- C4 slimming: every category with one toggle, saved as the whole list and used by the next boot
  await waitView((v) => v?.state === "ready", "slimming section", "slimming");
  const slim = await view("slimming");
  check(
    "C4 the slimming section lists every category as slimmed with a Keep button",
    slim.title === "Simulator slimming" &&
      js(slim.rows.map((row) => row.text)) === js(snapshot.categories) &&
      slim.rows.every((row) => row.status === "Slimmed" && row.buttons.join() === "Keep:write"),
    slim,
  );
  const photos = snapshot.categories.indexOf("photos"),
    search = snapshot.categories.indexOf("search");
  const idsBeforeKeep = ids(await read("slimming"));
  await press("Keep", "slimming", photos);
  await kit.eventually(() => js(store().keepCategories) === js(["photos"]), "photos kept");
  await waitView((v) => v.rows[photos].status === "Kept", "photos drawn", "slimming");
  await press("Keep", "slimming", search - 1);
  await kit.eventually(() => js(store().keepCategories) === js(["photos", "search"]), "search kept");
  await waitView((v) => v.rows[search].status === "Kept" && v.rows[photos].buttons.join() === "Slim:write", "search drawn", "slimming");
  check("C5 request ids change after a configure", !ids(await read("slimming")).some((id) => idsBeforeKeep.includes(id)));
  await shot("02b-slimming");
  await rpc({
    action: "plugin",
    plugin: "simulator",
    method: "action",
    id: alpha,
    params: { operation: "boot", udid: CLONE_B, requestId: randomUUID() },
  });
  await kit.eventually(() => fakeCalls().some((call) => call.args[0] === "on" && call.args[1] === CLONE_B), "boot slimmed");
  check(
    "C4 the next boot uses the saved categories",
    js(fakeCalls().find((call) => call.args[0] === "on" && call.args[1] === CLONE_B).args) ===
      js(["on", CLONE_B, "--except", "photos,search"]),
    fakeCalls(),
  );
  await kit.eventually(() => !store().pending, "boot settled");

  // ---- An unknown outcome: the section shows it as text and acknowledges it with one recover, never retrying the effect
  setFail({ erase: HOSTILE });
  const erasesBefore = fakeCalls().filter((call) => call.args[0] === "erase").length;
  await kit
    .rpc({
      action: "plugin",
      plugin: "simulator",
      method: "action",
      id: alpha,
      params: { operation: "reset", udid: CLONE_B, requestId: randomUUID() },
    })
    .catch(() => {});
  await kit.eventually(() => store().uncertain, "reset left an unknown outcome");
  setFail({});
  await waitView((v) => v.rows.some((row) => row.label === "Unknown outcome"), "unknown outcome shown");
  const uncertain = await view();
  const unknownRow = uncertain.rows.find((row) => row.label === "Unknown outcome");
  check(
    "C3 the unknown outcome shows its reason as text, offers only the acknowledgement and hides the management button",
    unknownRow.text.includes(HOSTILE) &&
      unknownRow.status === "Needs inspection" &&
      unknownRow.buttons.join() === "I inspected; acknowledge:dangerous" &&
      uncertain.rows[0].buttons.length === 0 &&
      (await page.evaluate(
        `!document.querySelector("#settings .plugin-section img, #settings .plugin-section b") && window.__pwned === undefined`,
      )),
    uncertain,
  );
  await shot("03-unknown-outcome");
  await press("I inspected; acknowledge");
  await waitView((v) => v.rows.find((row) => row.label === "Unknown outcome")?.confirm, "acknowledgement confirmation");
  check(
    "C3 acknowledging asks first and says it never retries",
    /never retries the operation/.test((await view()).rows.find((row) => row.label === "Unknown outcome").confirm),
  );
  await page.evaluate(`document.querySelector(${js(`${box} .section-confirm [data-confirm]`)}).click()`);
  await kit.eventually(() => !store().uncertain, "outcome acknowledged");
  await waitView((v) => !v.rows.some((row) => row.label === "Unknown outcome"), "settled after acknowledgement");
  check(
    "C3 one recover with the project id settled it, the reset was not retried and both clones stay owned",
    fakeCalls().filter((call) => call.args[0] === "erase").length === erasesBefore + 1 && store().owned.length === 2,
    store(),
  );
  await shot("04-acknowledged");

  // ---- Another project shows its own state
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(beta)}, chatId: "main" }))`);
  await waitView((v) => v?.state === "ready" && v.rows[0].status === "No simulator", "beta section");
  const betaView = await view();
  check(
    "C2 another project shows its own state: management on by default and no clones",
    betaView.rows[0].buttons.join() === "Turn off:write" && !betaView.rows.some((row) => row.label === "Clone"),
    betaView,
  );
  await page.viewport(390, 844, true);
  await waitView((v) => v?.state === "ready", "mobile section");
  check(
    "C7 at 390 px the sections fit the screen",
    await page.evaluate(
      `[...document.querySelectorAll(${js(`${card} .plugin-section`)})].every((node) => node.getBoundingClientRect().right <= innerWidth) && document.documentElement.scrollWidth <= innerWidth`,
    ),
  );
  await shot("05-mobile");
  const idsBeforeRestart = [...ids(await read("simulators")), ...ids(await read("slimming"))];
  await kit.restartHost();
  const idsAfterRestart = [...ids(await read("simulators")), ...ids(await read("slimming"))];
  check("C5 request ids differ after a host restart", !idsAfterRestart.some((id) => idsBeforeRestart.includes(id)), idsAfterRestart);
});
