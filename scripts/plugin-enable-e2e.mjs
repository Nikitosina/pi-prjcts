// E2E: per-project plugin enable and disable (failure cases: plugin-enable-failures.md, numbers in check labels). Fake model, private HOME.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const gated = join(fixtures, "gated-plugin"),
  fakeVcs = join(fixtures, "fake-vcs-plugin");
const fakeData = join(tmpdir(), `plugin-enable-fake-${process.pid}.json`);
const writeFake = (extra = {}) => writeFileSync(fakeData, JSON.stringify({ prs: [], ...extra }));
writeFake();
const kit = await createKit("plugin-enable", {
  env: {
    PI_PROJECTS_FOLLOW_TICK_MS: "200",
    PI_PROJECTS_PLUGINS: `${gated}:${fakeVcs}`,
    FAKE_PLUGIN_DATA: fakeData,
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
  const callFor = (target, method) => rpc({ action: "plugin", plugin: "gated", method, params: { projectId: target } });
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
  // 24: a host-wide RPC without a project id works for a project it names (withRoot). That work is counted for the project, so a disable waits it
  // out, and once the project is off the plugin cannot reach it this way.
  const heldIn = callFor(alpha, "holdin");
  await kit.eventually(async () => (await call(alpha, "waiting")).count === 1, "holdin did not start");
  const disableRefusal = await Promise.race([
    refused(() => set(alpha, "gated", false)),
    kit.delay(8000).then(() => "the disable request is still waiting behind the running work after 8 s"),
  ]);
  await call(beta, "release");
  await heldIn;
  check("24 disable is refused while an id-less RPC works inside the project", /active work/.test(disableRefusal), disableRefusal);
  await set(alpha, "gated", true);
  check("11 enabling an enabled plugin is a no-op", (await set(alpha, "gated", true)).enabled === true);

  // 5: an existing coordinator chat keeps the plugin's registered tool; after a disable the same call is refused at execution (the plugin's own
  // `extension` registration, not only the offered tool list) and the plugin code does not run.
  // Read through the other project: the disabled one refuses its RPCs.
  const counters = async () => call(beta, "counters");
  // 16b: a real Follow PRs tick (every 200 ms) runs the plugin's follow provider for each project that has Follow PRs on.
  for (const id of [alpha, beta]) await rpc({ action: "automation-update", id, change: { follow: { enabled: true } } });
  await kit.eventually(async () => {
    const seen = (await counters()).observed;
    return seen[alpha] > 0 && seen[beta] > 0;
  }, "follow ticks did not reach the plugin's follow provider");
  check("16b follow ticks observe both projects while the plugin is on", true, await counters());
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
  check(
    "24 an id-less RPC cannot reach the disabled project",
    /disabled in this project/.test(await refused(() => callFor(alpha, "touch"))),
  );
  check("24 it still reaches the project that has the plugin on", (await callFor(beta, "touch")).touched === beta);
  check(
    "24 and did not run for the disabled one",
    !("touched" in {}) && !((await call(beta, "counters")).touched ?? {})[alpha],
    await call(beta, "counters"),
  );
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
  // The tick's per-project interval does not fire again inside this window, so poll by hand: the same Follow PRs poll the tick runs.
  const followed = (await counters()).observed,
    publishedBefore = (await counters()).published[alpha] ?? 0;
  const polled = await refused(() => rpc({ action: "follow-poll", id: alpha }));
  await rpc({ action: "follow-poll", id: beta });
  await kit.delay(1000);
  const followedLater = (await counters()).observed;
  check(
    "16b a follow poll of the disabled project is refused: no provider connected",
    /needs a GitHub authorization or a connected provider/.test(polled),
    polled,
  );
  check("16b the disabled project's follow provider never observed it", followedLater[alpha] === followed[alpha], {
    followed,
    followedLater,
  });
  check("16b the other project's follow poll still observes", followedLater[beta] > followed[beta], { followed, followedLater });
  check(
    "16b no follow published call ran for the disabled project",
    ((await counters()).published[alpha] ?? 0) === publishedBefore,
    await counters(),
  );
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
  // 30: a poll that another connected provider completes keeps the saved follow state of a provider the project turned off.
  await rpc({ action: "plugin", plugin: "fake", method: "connect", id: alpha, params: { confirm: alpha } });
  const followRepos = async () => (await rpc({ action: "follow-poll", id: alpha })).follow.repos.map((item) => item.repositoryId);
  check(
    "30 both providers are followed while the plugin is on",
    (await followRepos()).includes(`gated/${alpha}`) && (await followRepos()).includes("fake-repo"),
    await followRepos(),
  );
  await set(alpha, "gated", false);
  check(
    "30 a poll completed by the other provider keeps the disabled provider's saved state",
    (await followRepos()).includes(`gated/${alpha}`),
    await followRepos(),
  );
  await set(alpha, "gated", true);
  // 34: a poll that began while the plugin was off keeps its saved records when the plugin is turned on before the batch is built.
  await set(alpha, "gated", false);
  writeFake({ holdPublished: true });
  const heldPoll = rpc({ action: "follow-poll", id: alpha });
  await kit.delay(600);
  await set(alpha, "gated", true);
  writeFake();
  check(
    "34 a poll that began with the plugin off keeps its saved state after the plugin is turned on mid-poll",
    (await heldPoll).follow.repos.some((item) => item.repositoryId === `gated/${alpha}`),
    (await heldPoll).follow.repos,
  );
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
  await page.evaluate(`document.querySelector("#settings").close()`);
  await page.evaluate(`import('/state.js').then((m) => m.emit('select-request', { projectId: ${js(beta)}, chatId: 'main' }))`);
  await page.waitFor(
    `document.querySelector('#app')?.dataset.project === ${js(beta)} || location.search.includes(${js(beta)})`,
    "beta selected",
  );
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(`!!document.querySelector(${js(toggle("gated"))})`, "beta plugin switches");
  check(
    "9 the other project's switch is still on in the same UI",
    await page.evaluate(`document.querySelector(${js(toggle("gated"))}).checked`),
  );
  await page.shot("02b-other-project-on", { force: true });
  await page.evaluate(`document.querySelector("#settings").close()`);
  await page.evaluate(`import('/state.js').then((m) => m.emit('select-request', { projectId: ${js(alpha)}, chatId: 'main' }))`);
  await page.waitFor(`location.search.includes(${js(alpha)})`, "alpha selected");
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(`!!document.querySelector(${js(toggle("gated"))})`, "alpha plugin switches");
  await click(toggle("gated"));
  await page.waitFor(`document.querySelector(${js(toggle("gated"))}).checked`, "switch on");
  check("10 the switch turns it back on", (await entry(alpha, "gated")).enabled === true);
  // 31: a switch changed elsewhere (another tab) shows in the open Plugins list without reopening it.
  await set(alpha, "gated", false);
  await page.waitFor(`!document.querySelector(${js(toggle("gated"))})?.checked`, "open list shows the switch off");
  await set(alpha, "gated", true);
  await page.waitFor(`document.querySelector(${js(toggle("gated"))})?.checked`, "open list shows the switch on");
  // 32: an unresolved or unreadable write of the plugin refuses the disable; once resolved the disable works, and the plugin is never asked
  // about writes of a project that turned it off. The other project keeps its checks.
  const pluginCall = (method, params) => rpc({ action: "plugin", plugin: "gated", method, params });
  const rootA = (await pluginCall("root-of", { projectId: alpha })).root,
    rootB = (await pluginCall("root-of", { projectId: beta })).root;
  const mark = (root, mode) => pluginCall("set-uncertain", { root, mode });
  const blocker = async (id) => (await rpc({ action: "schedule-snapshot", id, includeHistory: false })).automaticAdmissionBlocker;
  const asked = async (root) => (await counters()).asked?.[root] ?? 0;
  await mark(rootA, "yes");
  await click(toggle("gated"));
  await page.waitFor(`/unknown outcome/.test(document.body.innerText)`, "unresolved write refusal shown");
  check(
    "32 the switch stays on after the refusal that names the unresolved write",
    await page.evaluate(`document.querySelector(${js(toggle("gated"))}).checked`),
  );
  await page.shot("03-unresolved-write", { force: true });
  check(
    "32 the refused disable changed nothing",
    (await entry(alpha, "gated")).enabled === true && !(await counters()).paused.includes(alpha),
  );
  check("32 the plugin still answers", (await call(alpha, "ping")).pong === alpha);
  await mark(rootA, "fail");
  const unreadable = await refused(() => set(alpha, "gated", false));
  check("32 a check that fails refuses the disable", /could not be checked/.test(unreadable), unreadable);
  check("32 the plugin is still on after a failed check", (await entry(alpha, "gated")).enabled === true);
  await mark(rootA, "hold");
  const racing = refused(() => set(alpha, "gated", false));
  await kit.eventually(async () => (await pluginCall("check-waiting")).count === 1, "check did not start");
  await call(alpha, "ping");
  await pluginCall("release-check");
  const raced = await racing;
  check("32 work that began during the check refuses the disable", /began while/.test(raced), raced);
  check("32 the plugin is still on after the race", (await entry(alpha, "gated")).enabled === true);
  await mark(rootA, "no");
  check("32 once the write is resolved the disable succeeds", (await set(alpha, "gated", false)).enabled === false);
  check("32 and holds the pause", (await counters()).paused.includes(alpha), await counters());
  await mark(rootA, "yes");
  await mark(rootB, "yes");
  const askedA = await asked(rootA);
  check("32 job admission ignores the disabled plugin's unresolved write", (await blocker(alpha)) === null);
  check("32 the disabled plugin is not asked", (await asked(rootA)) === askedA, await counters());
  check("32 the other project's check stays active", (await blocker(beta)) === "uncertain-provider-write");
  const betaRefused = await refused(() => set(beta, "gated", false));
  check("32 the other project cannot disable with its own unresolved write", /unknown outcome/.test(betaRefused), betaRefused);
  check("32 the other project stays enabled", (await entry(beta, "gated")).enabled === true);
  await mark(rootB, "no");
  await set(alpha, "gated", true);
  check("32 enabling asks the plugin again", (await blocker(alpha)) === "uncertain-provider-write" && (await asked(rootA)) > askedA);
  await mark(rootA, "no");
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
  // 14d: an enable whose save fails leaves the plugin off with its pause held; the retry enables it and releases the pause once.
  chmodSync(projectFolder, 0o555);
  const enableFailure = await refused(() => set(alpha, "gated", true));
  chmodSync(projectFolder, 0o700);
  check("14d a failed save refuses the enable", enableFailure !== "", enableFailure);
  check("14d the plugin is still off", (await entry(alpha, "gated")).enabled === false);
  check("14d the pause is still held", (await counters()).paused.includes(alpha), await counters());
  check("14d the still-off plugin refuses its RPC", /disabled in this project/.test(await refused(() => call(alpha, "ping"))));
  check("14d the retry enables it", (await set(alpha, "gated", true)).enabled === true);
  check("14d the retry released the pause", !(await counters()).paused.includes(alpha), await counters());
  check("14d the enabled plugin answers again", (await call(alpha, "ping")).pong === alpha);
  check("14d a second enable is a no-op", (await set(alpha, "gated", true)).enabled === true);
  check(
    "14d a disable after the retry holds the pause once",
    (await set(alpha, "gated", false)).enabled === false && (await counters()).paused.includes(alpha),
  );
  // 14c: after a host restart the flag is persistent: the disabled plugin runs nothing for the project (no tick, RPC or pause needed).
  await kit.restartHost();
  await kit.delay(1200);
  check("14c the flag survives the restart", (await entry(alpha, "gated")).enabled === false);
  check(
    "14c no PR monitor or follow tick ran the disabled plugin for its project",
    !(await counters()).listed[alpha] && !(await counters()).observed[alpha] && !(await counters()).published[alpha],
    await counters(),
  );
  check("19 the restarted host holds the disabled plugin's pause again", (await counters()).paused.includes(alpha), await counters());
  check("19 and not the enabled project's", !(await counters()).paused.includes(beta), await counters());
  check("14c its RPC is still refused", /disabled in this project/.test(await refused(() => call(alpha, "ping"))));
  // 32: a project disabled before a restart is not asked either.
  await mark(rootA, "yes");
  check("32 after a restart the disabled plugin's unresolved write does not block admission", (await blocker(alpha)) === null);
  check("32 and the plugin was not asked", (await asked(rootA)) === 0, await counters());
  // The refused route probes of 6 are the only expected HTTP errors.
  kit.result.httpErrors = kit.result.httpErrors.filter((error) => !(error.url.endsWith("/plugins/gated/data") && error.status === 409));
});
