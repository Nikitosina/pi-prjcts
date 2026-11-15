// E2E: per-project plugin enable and disable (failure cases: plugin-enable-failures.md, numbers in check labels). Fake model, private HOME.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const gated = join(fixtures, "gated-plugin"),
  fakeVcs = join(fixtures, "fake-vcs-plugin");
writeFileSync(join(tmpdir(), `plugin-enable-fake-${process.pid}.json`), JSON.stringify({ prs: [] }));
const kit = await createKit("plugin-enable", {
  env: {
    PI_PROJECTS_FOLLOW_TICK_MS: "200",
    PI_PROJECTS_PLUGINS: `${gated}:${fakeVcs}`,
    FAKE_PLUGIN_DATA: join(tmpdir(), `plugin-enable-fake-${process.pid}.json`),
  },
  handler: ({ role, user, results }) =>
    role === "coordinator" && user.includes("GATED-CALL") && !results.length ? kit.call("gated_ping", {}) : undefined,
});

await kit.run(async () => {
  const { check, rpc } = kit;
  kit.initRepo();
  const second = join(kit.root, "workspace-b");
  mkdirSync(second);
  kit.initRepo(second);
  const alpha = await kit.createProject("Alpha");
  const beta = await kit.createProject("Beta", { cwd: second });
  const entry = async (id, name) => (await rpc({ action: "plugins", id })).plugins.find((plugin) => plugin.name === name);
  const set = (id, plugin, enabled) => rpc({ action: "project-plugin", id, plugin, enabled });
  const call = (id, method) => rpc({ action: "plugin", plugin: "gated", method, id });
  const refused = async (work) => {
    try {
      await work();
      return "";
    } catch (error) {
      return error.message;
    }
  };

  check(
    "12 the snapshot says enabled and not locked",
    (await entry(alpha, "gated"))?.enabled === true && (await entry(alpha, "gated")).lock === null,
  );
  check(
    "12 the github plugin is locked by the checkout",
    /checkout/.test((await entry(alpha, "github"))?.lock ?? ""),
    await entry(alpha, "github"),
  );
  check(
    "2 disabling the plugin the checkout needs is refused",
    /required by this project's checkout/.test(await refused(() => set(alpha, "github", false))),
  );
  // 2: the checkout decides, by what the folder really is, before any grant exists and after one is revoked.
  const third = join(kit.root, "workspace-c");
  mkdirSync(join(third, ".fakevcs"), { recursive: true });
  const gamma = await kit.createProject("Gamma", { cwd: third, grant: false });
  check(
    "2 a project without a grant: the plugin of its checkout kind is locked",
    /checkout/.test((await entry(gamma, "fake"))?.lock ?? ""),
    await entry(gamma, "fake"),
  );
  check(
    "2 the plugin of the checkout kind cannot be disabled without a grant either",
    /required by this project's checkout/.test(await refused(() => set(gamma, "fake", false))),
  );
  check("2 a plugin the checkout does not use can be turned off", (await set(alpha, "fake", false)).enabled === false);
  await set(alpha, "fake", true);
  check("4 an unknown plugin is refused", /not loaded/.test(await refused(() => set(alpha, "nope", false))));

  // 1/3: a held RPC blocks the disable; releasing it allows it.
  const held = call(alpha, "hold");
  await kit.eventually(async () => (await call(alpha, "waiting")).count === 1, "hold did not start");
  check("1 disable is refused while an RPC runs", /active work/.test(await refused(() => set(alpha, "gated", false))));
  check("1 the refusal changed nothing", (await entry(alpha, "gated")).enabled === true && (await call(alpha, "ping")).pong === alpha);
  await call(alpha, "release");
  await held;
  check("11 enabling an enabled plugin is a no-op", (await set(alpha, "gated", true)).enabled === true);

  // 5: an existing coordinator chat keeps the plugin's registered tool; after a disable the same call is refused at execution (the plugin's own
  // `extension` registration, not only the offered tool list) and the plugin code does not run.
  // Read through the other project: the disabled one refuses its RPCs.
  const counters = async () => call(beta, "counters");
  await rpc({ action: "message", id: alpha, text: "GATED-CALL one" });
  await kit.eventually(async () => (await counters()).toolRuns === 1, "tool ran while enabled");
  await kit.eventually(async () => !(await rpc({ action: "show", id: alpha })).chats.find((chat) => chat.id === "main")?.busy, "idle");
  const prsOf = async (id) => (await rpc({ action: "prs", id, refresh: true })).providers.filter((item) => item.provider === "gatedprs");
  check(
    "8 the plugin's PR provider serves the project while enabled",
    (await prsOf(alpha)).length === 1 && (await counters()).listCalls > 0,
  );

  // Disable: RPC and route refuse, the other project is unaffected, data stays.
  const off = await set(alpha, "gated", false);
  check("5 disabled", off.enabled === false && (await entry(alpha, "gated")).enabled === false);
  check("6 an RPC for the disabled project is refused", /disabled in this project/.test(await refused(() => call(alpha, "ping"))));
  await rpc({ action: "message", id: alpha, text: "GATED-CALL two" });
  await kit.eventually(
    async () => !(await rpc({ action: "show", id: alpha })).chats.find((chat) => chat.id === "main")?.busy,
    "idle again",
  );
  check("5 a recorded tool call of an existing chat is refused after the disable", (await counters()).toolRuns === 1, await counters());
  check(
    "5 the refusal is the model's tool result",
    /disabled in this project/.test(kit.toolResult("coordinator", "GATED-CALL two")),
    kit.toolResult("coordinator", "GATED-CALL two"),
  );
  // 7/8: the PR provider no longer serves the disabled project, and none of its methods runs for it.
  const listed = (await counters()).listCalls;
  check("8 the PR provider is gone from the disabled project's PR list", (await prsOf(alpha)).length === 0);
  check("8 the disabled plugin's PR code did not run", (await counters()).listCalls === listed, await counters());
  // 16: the PR monitor and follow ticks (every 200 ms here) run none of the disabled plugin's code.
  await kit.delay(1000);
  check("16 a PR monitor tick ran no disabled plugin code", (await counters()).listCalls === listed, await counters());
  // 14/15: the lifecycle pause taken for the disable stays held for this project only, and the enable releases it.
  check("14 the plugin's pause stays held while it is off", (await counters()).paused.includes(alpha), await counters());
  check("15 the pause is only this project's", !(await counters()).paused.includes(beta), await counters());
  check("9 the other project's PR list still has the provider", (await prsOf(beta)).length === 1);
  check("9 the other project still answers", (await call(beta, "ping")).pong === beta && (await entry(beta, "gated")).enabled === true);
  const page = await kit.openPage(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  const route = (id) =>
    page.evaluate(
      `import("/api.js").then((api) => api.authorizedFetch("/plugins/gated/data?project=${id}").then(async (answer) => answer.status + ":" + (await answer.text())))`,
    );
  check(
    "6 the web route refuses the disabled project",
    (await route(alpha)).startsWith("4") || (await route(alpha)).startsWith("5"),
    await route(alpha),
  );
  check("9 the route answers the other project", (await route(beta)) === `200:data:${beta}`, await route(beta));
  check("11 a disabled plugin disabled again is a no-op", (await set(alpha, "gated", false)).enabled === false);

  // 10: re-enable restores behavior.
  await set(alpha, "gated", true);
  check("15 the enable released the pause once", !(await counters()).paused.includes(alpha), await counters());
  check("10 re-enabled", (await call(alpha, "ping")).pong === alpha && (await route(alpha)) === `200:data:${alpha}`);
  // The Settings → Plugins switches: a locked plugin is on and disabled with its reason; a busy one refuses with a message.
  const js = JSON.stringify;
  const toggle = (name) => `#settings [data-plugin-toggle="${name}"]`;
  const click = (selector) => page.evaluate(`document.querySelector(${js(selector)}).click()`);
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await page.waitFor(`document.querySelector("#settings").open`, "settings open");
  await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(`!!document.querySelector(${js(toggle("gated"))})`, "plugin switches");
  check(
    "12 the switch of a locked plugin is on, disabled and explained",
    await page.evaluate(
      `(() => { const input = document.querySelector(${js(toggle("github"))}); return input.checked && input.disabled && /checkout/.test(input.closest(".plugin-row").querySelector("[data-plugin-lock]")?.textContent ?? ""); })()`,
    ),
  );
  const heldAgain = call(alpha, "hold");
  await kit.eventually(async () => (await call(alpha, "waiting")).count === 1, "hold did not start");
  await click(toggle("gated"));
  await page.waitFor(`/active work/.test(document.body.innerText)`, "refusal shown");
  check(
    "1 the busy plugin stays on after the refused click",
    await page.evaluate(`document.querySelector(${js(toggle("gated"))}).checked`),
  );
  await page.shot("01-refused", { force: true });
  await call(alpha, "release");
  await heldAgain;
  // The section showed the lock while the call ran; reopening it reads the state again.
  await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(
    `document.querySelector(${js(toggle("gated"))}) && !document.querySelector(${js(toggle("gated"))}).disabled`,
    "switch free again",
  );
  await click(toggle("gated"));
  await page.waitFor(`!document.querySelector(${js(toggle("gated"))}).checked`, "switch off");
  check(
    "5 the switch turns the plugin off for this project",
    (await entry(alpha, "gated")).enabled === false && (await entry(beta, "gated")).enabled === true,
  );
  await page.shot("02-off", { force: true });
  await click(toggle("gated"));
  await page.waitFor(`document.querySelector(${js(toggle("gated"))}).checked`, "switch on");
  check("10 the switch turns it back on", (await entry(alpha, "gated")).enabled === true);
  // 14b: a disable whose project save fails changes nothing and does not leave the lifecycle pause held (the plugin is still on).
  const projectFolder = join(kit.home, alpha);
  chmodSync(projectFolder, 0o555);
  const saveFailure = await refused(() => set(alpha, "gated", false));
  chmodSync(projectFolder, 0o700);
  check("14b a failed save refuses the disable", saveFailure !== "", saveFailure);
  check("14b the plugin is still enabled", (await entry(alpha, "gated")).enabled === true);
  check("14b the failed disable released the pause", !(await counters()).paused.includes(alpha), await counters());
  check("14b the still-enabled plugin answers", (await call(alpha, "ping")).pong === alpha);
  check(
    "14b a later disable works and holds the pause again",
    (await set(alpha, "gated", false)).enabled === false && (await counters()).paused.includes(alpha),
  );
  // 14c: after a host restart the flag is persistent: the disabled plugin runs nothing for the project (no tick, RPC or pause needed).
  await kit.restartHost();
  await kit.delay(1200);
  check("14c the flag survives the restart", (await entry(alpha, "gated")).enabled === false);
  check("14c no PR monitor or follow tick ran the disabled plugin", (await counters()).listCalls === 0, await counters());
  check("14c its RPC is still refused", /disabled in this project/.test(await refused(() => call(alpha, "ping"))));
  // The refused route probes of 6 are the only expected HTTP errors.
  kit.result.httpErrors = kit.result.httpErrors.filter((error) => !(error.url.endsWith("/plugins/gated/data") && error.status === 409));
});
