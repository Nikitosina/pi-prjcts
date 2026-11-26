// E2E: declarative plugin sections (scripts/plugin-sections-failures.md, numbers in check labels). Two private hosts with a fake model, a local
// relay and headless Chrome: the local host and a paired remote host both load the tasks plugin, the network-gate fixture and the section
// probe (scripts/fixtures/sections/probe.mjs); the local host also loads a plugin with a retired `web` field and malformed declarations.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxRelay } from "./lib/inbox-relay.mjs";
import { call, createKit, delay, say } from "./lib/e2e-kit.mjs";

const fixture = (path) => join(process.cwd(), path);
const PLUGINS = [fixture("plugins/tasks"), fixture("scripts/fixtures/network-gate.mjs"), fixture("scripts/fixtures/sections/probe.mjs")];
const handler = ({ role, user, results }) => {
  const steps = /TASKS-STEPS (\[.*\])/s.exec(user)?.[1];
  if (role !== "coordinator" || user.startsWith("[Durable work") || !steps) return undefined;
  const plan = JSON.parse(steps);
  return results.length < plan.length ? call(...plan[results.length]) : say(`TASKS-DONE ${results.length}`);
};
const js = (value) => JSON.stringify(value);

// Plugins written for this run only: one keeps a retired `web` field, each other breaks one declaration rule.
function extraPlugins(root) {
  const dir = join(root, "extra-plugins");
  mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, `export default { name: ${js(name)}, register(api) { api.provide(${body}); } };\n`);
    return file;
  };
  const section = (patch) => `{ title: "Ok", place: "settings", read: async () => ({ rows: [] }), ...${patch} }`;
  const bad = {
    "bad-id": [`{ sections: { Bad_Id: ${section("{}")} } }`, /sections\.Bad_Id must have a kebab-case id/],
    "bad-title": [`{ sections: { one: ${section('{ title: "" }')} } }`, /sections\.one\.title must not be empty/],
    "long-title": [`{ sections: { one: ${section(`{ title: "${"t".repeat(61)}" }`)} } }`, /sections\.one\.title must be at most 60/],
    "bad-place": [`{ sections: { one: ${section('{ place: "sidebar" }')} } }`, /sections\.one\.place must be "settings" or "chat"/],
    "bad-refresh": [`{ sections: { one: ${section("{ refreshMs: 1000 }")} } }`, /sections\.one\.refreshMs must be an integer/],
    "float-refresh": [`{ sections: { one: ${section("{ refreshMs: 2500.5 }")} } }`, /sections\.one\.refreshMs must be an integer/],
    "bad-read": [`{ sections: { one: ${section('{ read: "rows" }')} } }`, /sections\.one\.read must be a function/],
    "too-many": [
      `{ sections: { a: ${section("{}")}, b: ${section("{}")}, c: ${section("{}")}, d: ${section("{}")}, e: ${section("{}")} } }`,
      /sections must declare at most 4/,
    ],
  };
  const retired = write(
    "retired",
    `{ rpc: { ping: async () => ({ pong: true }) }, rpcPolicy: { ping: "read" }, web: { script: "/nope/ui.js", style: "/nope/ui.css", sidebar: { title: "Old" }, routes: { frame: async () => ({ mime: "text/plain", bytes: Buffer.from("old") }) } } }`,
  );
  return { files: [retired, ...Object.entries(bad).map(([name, [body]]) => write(name, body))], bad };
}

const client = await createKit("plugin-sections", { handler });
const extra = extraPlugins(client.root);
client.hostEnv.PI_PROJECTS_PLUGINS = [...PLUGINS, ...extra.files].join(":");
// Chrome trusts the relay's certificate from its start, so the relay and the remote host exist before the page opens.
const relay = await inboxRelay();
const other = await createKit("plugin-sections-remote", {
  env: { NODE_EXTRA_CA_CERTS: relay.cert, PI_PROJECTS_PLUGINS: PLUGINS.join(":") },
  handler,
});
// The network-gate fixture reads the VPN state from this file; "up" keeps it from pausing projects until case 21 turns it down.
const vpn = (kit, up) => writeFileSync(join(kit.home, "fake-vpn"), up ? "up" : "disconnected");
vpn(client, true);
vpn(other, true);

await client.run(() => other.run(journey));
await relay.close();

async function journey() {
  const { check, rpc } = client;
  client.initRepo();
  const alpha = await client.createProject("Alpha");
  const betaDir = join(client.root, "beta");
  mkdirSync(betaDir);
  client.initRepo(betaDir);
  const beta = await client.createProject("Beta", { cwd: betaDir });
  const one = (await rpc({ action: "chat-create", id: alpha, title: "Release chat" })).id;
  const probe = (kit, id, method, params) => kit.rpc({ action: "plugin", plugin: "probe", method, id, ...(params ? { params } : {}) });
  const probeLog = (kit = client, id = alpha) => probe(kit, id, "log");
  const setMode = (params, kit = client, id = alpha) => probe(kit, id, "set-mode", params);
  let marker = 0;
  const drive = async (kit, id, steps) => {
    const tag = `SECTIONS-RUN-${++marker}`;
    await kit.rpc({ action: "message", id, text: `${tag} TASKS-STEPS ${js(steps)}` });
    await kit.eventually(
      () => kit.result.calls.some((c) => c.role === "coordinator" && c.user.includes(tag) && c.results.length === steps.length),
      `${tag} done`,
    );
  };

  // ---- Host side: declarations and retired fields (1 3 4 17 20)
  const status = await rpc({ action: "plugins", id: alpha });
  const byName = (name) => status.plugins.find((plugin) => plugin.name === name);
  for (const [name, [, rule]] of Object.entries(extra.bad))
    check(
      `3 ${name} fails to load with an error that names the field`,
      byName(name)?.state === "failed" && rule.test(byName(name).error),
      byName(name),
    );
  check(
    "3 the other plugins still load",
    ["tasks", "network-gate", "probe", "retired"].every((name) => byName(name)?.state === "loaded"),
    status.plugins,
  );
  check(
    "1 a retired web field is dropped while the plugin's RPC still loads",
    !byName("retired").provides.includes("web") &&
      (await rpc({ action: "plugin", plugin: "retired", method: "ping", id: alpha })).pong === true,
    byName("retired"),
  );
  check(
    "4 sections list only loaded plugins, in load order",
    status.sections.map((entry) => `${entry.plugin}.${entry.id}:${entry.place}`).join() ===
      "tasks.tasks:chat,network-gate.status:settings,probe.main:settings,probe.side:chat",
    status.sections,
  );
  check("20 the host answers API version 2", (await rpc({ action: "api-version" })).version === 2);
  const section = (input) => rpc({ action: "plugin-section", plugin: "probe", ...input });
  check(
    "17 a chat section is refused without a project and a chat",
    /needs a project and a chat/.test(await client.rejects({ action: "plugin-section", plugin: "probe", section: "side", id: alpha })) &&
      /needs a project and a chat/.test(
        await client.rejects({ action: "plugin-section", plugin: "probe", section: "side", chatId: "main" }),
      ),
  );
  check(
    "17 a settings section is refused with a chat",
    /has no chat/.test(await client.rejects({ action: "plugin-section", plugin: "probe", section: "main", id: alpha, chatId: "main" })),
  );
  check(
    "17 a section of a plugin that failed or does not exist is refused",
    /unavailable/.test(await client.rejects({ action: "plugin-section", plugin: "bad-id", section: "one", id: alpha })) &&
      /unavailable/.test(await client.rejects({ action: "plugin-section", plugin: "probe", section: "nope", id: alpha })),
  );

  // ---- Host side: views (6 7 8 9 12)
  const refusals = {
    badlink: [/rows\[0\]\.links\[0\]\.url must be an absolute http or https URL/, 6],
    datalink: [/rows\[0\]\.links\[0\]\.url must be an absolute http or https URL/, 6],
    relative: [/rows\[0\]\.links\[0\]\.url must be an absolute http or https URL/, 6],
    toomany: [/rows must have at most 50 items/, 7],
    longtext: [/rows\[0\]\.text must be at most 500 characters/, 7],
    badtone: [/rows\[0\]\.status\.tone must be one of/, 7],
    bigparams: [/rows\[0\]\.buttons\[0\]\.params must be at most 2048 bytes/, 7],
    notjson: [/rows\[0\]\.buttons\[0\]\.params must be JSON/, 7],
    nomethod: [/rows\[0\]\.buttons\[0\]\.method must name an rpc method of this plugin with an rpcPolicy entry/, 8],
    nopolicy: [/rows\[0\]\.buttons\[0\]\.method must name an rpc method of this plugin with an rpcPolicy entry/, 8],
    noconfirm: [/rows\[0\]\.buttons\[0\]\.confirm is required for a dangerous call/, 12],
  };
  for (const [mode, [rule, number]] of Object.entries(refusals)) {
    await setMode({ mode });
    const refused = await client.rejects({ action: "plugin-section", plugin: "probe", section: "main", id: alpha });
    check(
      `${number} the host refuses a ${mode} view and names the field`,
      /^Section probe\.main returned an invalid view: /.test(refused) && rule.test(refused),
      refused,
    );
  }
  await setMode({ mode: "hostile" });
  const hostileView = await section({ section: "main", id: alpha });
  check(
    "9 the host answers only the schema's fields",
    !/"(html|onclick|script)"/.test(js(hostileView)) && Object.keys(hostileView).sort().join() === "footer,rows",
    hostileView,
  );
  await setMode({ mode: "normal" });
  const normalView = await section({ section: "main", id: alpha });
  check(
    "12 the host attaches each button's kind, from a static or a function policy",
    normalView.rows.flatMap((row) => row.buttons.map((button) => `${button.label}:${button.kind}`)).join() ===
      "Bump:write,Wipe:dangerous,Hard:dangerous,Soft:write,Refuse:write,Lost:write",
    normalView,
  );

  // ---- Browser: no plugin code (1 2)
  const page = await client.openPage(await client.webUrl(alpha), { trustedSpki: relay.spki });
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");
  const shot = (label) => page.shot(label, { force: true });
  const click = async (selector) => {
    const point = await page.evaluate(
      `(() => { const node = document.querySelector(${js(selector)}); if (!node) return null; node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    );
    if (!point) throw Error(`nothing to click: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const noPluginCode = () =>
    page.evaluate(
      `(() => ({ api: typeof window.piProjects, plugins: performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname.startsWith("/plugins/")).map((entry) => entry.name), foreign: [...document.scripts, ...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.src || node.href).filter((src) => src && new URL(src).origin !== location.origin) }))()`,
    );
  const served = await page.evaluate(
    `import("/api.js").then((api) => Promise.all(["/plugins/retired/ui.js", "/plugins/retired/ui.css", "/plugins/retired/frame?project=${alpha}", "/plugins/tasks/ui.js", "/plugins/simulator/frame?project=${alpha}"].map((path) => api.localHost.authorizedFetch(path).then((answer) => answer.status)))) `,
  );
  check(
    "1 former plugin files and routes answer 404",
    served.every((code) => code === 404),
    served,
  );
  // These 404 probes are the only expected HTTP errors; Chrome reports them a little later.
  await delay(500);
  client.result.httpErrors = client.result.httpErrors.filter(
    (error) => !(new URL(error.url).pathname.startsWith("/plugins/") && error.status === 404),
  );
  const csp = (await fetch(new URL(await client.webUrl(alpha)).origin)).headers.get("content-security-policy");
  check("2 the CSP keeps script-src 'self'", /(^|; )script-src 'self'(;|$)/.test(csp), csp);

  // ---- Right panel: chat sections in load order with the selected chat (4 17)
  const sideSections = () =>
    page.evaluate(
      `[...document.querySelectorAll("#plugin-sections > .plugin-section")].map((node) => ({ plugin: node.dataset.plugin, section: node.dataset.section, state: node.dataset.state, title: node.querySelector(".section-title").textContent, error: node.querySelector(".plugin-error").hidden ? "" : node.querySelector(".plugin-error").textContent, rows: [...node.querySelectorAll(".section-row")].map((row) => row.innerText), empty: node.querySelector(".section-empty")?.textContent ?? "", footer: node.querySelector(".section-foot")?.textContent ?? "" }))`,
    );
  const side = async (plugin) => (await sideSections()).find((item) => item.plugin === plugin);
  await page.waitFor(
    `[...document.querySelectorAll("#plugin-sections > .plugin-section")].every((node) => node.dataset.state === "ready")`,
    "chat sections ready",
  );
  const first = await sideSections();
  check(
    "4 chat sections show under Workers and Pull requests in load order",
    first.map((item) => `${item.plugin}.${item.section}:${item.title}`).join() === "tasks.tasks:Tasks,probe.side:Probe chat",
    first,
  );
  check("4 the Tasks section says when the chat has no tasks", (await side("tasks")).empty === "No open tasks.", await side("tasks"));
  check(
    "17 a chat section reads the selected chat",
    /chat main/.test((await side("probe")).rows[0]) && (await side("probe")).rows[0].includes(alpha),
  );
  await drive(client, alpha, [
    ["tasks_add", { title: "Ship <b>sections</b>", note: "local note" }],
    ["tasks_add", { title: "Write docs", stage: "in-progress" }],
  ]);
  await page.waitFor(`document.querySelectorAll('#plugin-sections [data-plugin="tasks"] .section-row').length === 2`, "local tasks");
  check(
    "5 a task title with markup is text",
    (await side("tasks")).rows[0].includes("Ship <b>sections</b>") &&
      !(await page.evaluate(`!!document.querySelector("#plugin-sections b")`)),
    await side("tasks"),
  );
  await shot("01-local-chat-sections");

  // ---- Settings → Plugins: settings sections in their plugin's card (4 21)
  const openPlugins = async () => {
    if (!(await page.evaluate(`document.querySelector("#settings").open`))) await click(`[data-cmd="settings"]`);
    await page.waitFor(`document.querySelector("#settings").open`, "settings open");
    await click(`#settings nav [data-section="plugins"]`);
    await page.waitFor(
      `!!document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-section[data-state="ready"]')`,
      "probe section",
    );
  };
  const closeSettings = async () => {
    await page.evaluate(`document.querySelector("#settings").close()`);
    await page.waitFor(`!document.querySelector("#settings").open`, "settings closed");
  };
  const card = (plugin) =>
    page.evaluate(
      `(() => { const node = document.querySelector('#settings .plugin-card[data-plugin="${plugin}"] .plugin-section'); if (!node) return null; return { state: node.dataset.state, title: node.querySelector(".section-title").textContent, error: node.querySelector(".plugin-error").hidden ? "" : node.querySelector(".plugin-error").textContent, rows: [...node.querySelectorAll(".section-row")].map((row) => ({ label: row.querySelector(".section-label")?.textContent ?? "", text: row.querySelector(".section-text").textContent, status: row.querySelector(".section-status")?.textContent ?? "", tone: row.querySelector(".section-status")?.dataset.tone ?? "", detail: [...row.querySelectorAll(".section-detail")].map((line) => line.textContent), links: [...row.querySelectorAll(".section-links a")].map((a) => ({ label: a.textContent, href: a.getAttribute("href"), target: a.target, rel: a.rel })), buttons: [...row.querySelectorAll("button")].map((button) => ({ label: button.textContent, kind: button.dataset.kind, disabled: button.disabled })), confirm: row.querySelector(".section-confirm p")?.textContent ?? null })), empty: node.querySelector(".section-empty")?.textContent ?? "", footer: node.querySelector(".section-foot")?.textContent ?? "" }; })()`,
    );
  await openPlugins();
  await page.waitFor(
    `!!document.querySelector('#settings .plugin-card[data-plugin="network-gate"] .plugin-section[data-state="ready"]')`,
    "gate section",
  );
  const gate = await card("network-gate");
  check(
    "21 the VPN gate section shows phase, VPN state, samples, attempts out of 3, last repair and paused projects",
    gate.title === "VPN gate" &&
      gate.rows.map((row) => row.label).join() === "VPN gate,Failed samples,Repair attempts,Last repair,Paused projects" &&
      gate.rows[0].text === "CONNECTED" &&
      gate.rows[0].status === "ready" &&
      gate.rows[0].tone === "good" &&
      /^\d+\/3$/.test(gate.rows[2].text) &&
      gate.rows[4].text === "none",
    gate,
  );
  check("4 a plugin without settings sections has none in its card", (await card("tasks")) === null && (await card("retired")) === null);
  const probeCard = await card("probe");
  check(
    "4 the settings section reads the selected project and no chat",
    probeCard.title === "Probe settings" && probeCard.rows[0].text === alpha && probeCard.footer === "mode normal",
    probeCard,
  );
  const mainReads = (await probeLog()).reads.filter((read) => read.section === "main");
  check(
    "17 settings sections get no chatId",
    mainReads.length > 0 && mainReads.every((read) => read.chatId === undefined && read.projectId === alpha),
    mainReads,
  );
  check(
    "6 links open in a new tab with noopener noreferrer",
    js(probeCard.rows[0].links) ===
      js([{ label: "Docs", href: "https://example.test/docs", target: "_blank", rel: "noopener noreferrer" }]),
    probeCard.rows[0].links,
  );
  check(
    "1 2 the page loaded no plugin code",
    js(await noPluginCode()) === js({ api: "undefined", plugins: [], foreign: [] }),
    await noPluginCode(),
  );
  await shot("02-local-settings-sections");

  // ---- Buttons (11 12 13 14)
  const buttons = `#settings .plugin-card[data-plugin="probe"] .section-row button[data-kind]`;
  const pressButton = async (label) => {
    const found = `[...document.querySelectorAll(${js(buttons)})].find((node) => node.textContent === ${js(label)})`;
    await page.waitFor(`${found}?.disabled === false`, `button ${label}`);
    await page.evaluate(`(() => { const node = ${found}; node.focus(); node.click(); })()`);
  };
  const callsOf = async (method, kit = client, id = alpha) => (await probeLog(kit, id)).calls.filter((item) => item.method === method);
  await pressButton("Bump");
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-status')?.textContent === "bumped 1"`,
    "bump drawn",
  );
  const bumps = await callsOf("bump");
  check(
    "11 one click sends exactly one call with the section's plugin, project and params, and the section is read again",
    bumps.length === 1 && bumps[0].projectId === alpha && js(bumps[0].params) === js({ by: 1 }),
    bumps,
  );
  const confirmBox = `#settings .plugin-card[data-plugin="probe"] .section-confirm`;
  await pressButton("Wipe");
  await page.waitFor(`!!document.querySelector(${js(confirmBox)})`, "wipe confirmation");
  check(
    "12 a dangerous button asks inline with the plugin's text, focused on Cancel",
    (await page.evaluate(`document.querySelector(${js(`${confirmBox} p`)}).textContent`)) === "Wipe all probe data?" &&
      (await page.evaluate(`document.activeElement?.hasAttribute("data-cancel")`)) &&
      (await callsOf("wipe")).length === 0,
  );
  // 14: views keep changing while the confirmation is open; it stays, and the newest view is drawn after Cancel.
  await setMode({ mode: "changed" });
  await delay(4500);
  check(
    "14 a refresh while a confirmation is open keeps it and its rows",
    (await page.evaluate(`!!document.querySelector(${js(confirmBox)})`)) && (await card("probe")).footer === "mode normal",
    await card("probe"),
  );
  await click(`${confirmBox} [data-cancel]`);
  await page.waitFor(`!document.querySelector(${js(confirmBox)})`, "cancelled");
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-foot')?.textContent === "mode changed"`,
    "newer view after cancel",
  );
  check("12 14 Cancel sends nothing and the newer view is drawn", (await callsOf("wipe")).length === 0);
  await setMode({ mode: "normal" });
  await pressButton("Wipe");
  await page.waitFor(`!!document.querySelector(${js(confirmBox)})`, "wipe confirmation again");
  await click(`${confirmBox} [data-confirm]`);
  await client.eventually(async () => (await callsOf("wipe")).length === 1, "wipe sent");
  await delay(1000);
  check("12 Confirm sends the dangerous call once", (await callsOf("wipe")).length === 1, await callsOf("wipe"));
  await pressButton("Hard");
  await page.waitFor(`!!document.querySelector(${js(confirmBox)})`, "function-policy confirmation");
  check("12 a function policy that answers dangerous for these params asks first", (await callsOf("maybe")).length === 0);
  await click(`${confirmBox} [data-confirm]`);
  await client.eventually(async () => (await callsOf("maybe")).length === 1, "hard sent");
  await pressButton("Soft");
  await client.eventually(async () => (await callsOf("maybe")).length === 2, "soft sent");
  check(
    "12 the same method with write params runs without confirmation",
    js((await callsOf("maybe")).map((item) => item.params.hard)) === js([true, false]),
    await callsOf("maybe"),
  );
  await pressButton("Refuse");
  await page.waitFor(
    `/Refuse failed: probe refused <b>this<\\/b>/.test(document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-error').textContent)`,
    "refusal shown",
  );
  check(
    "13 5 an answered refusal shows its error as text",
    !(await page.evaluate(`!!document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-error b')`)),
  );
  // A lost answer: the host acts, then the page's request fails as if the connection broke.
  await page.evaluate(
    `(() => { const real = window.fetch; window.fetch = async (url, init) => { const answer = await real(url, init); if (typeof init?.body === "string" && init.body.includes('"method":"lost"')) throw new TypeError("Failed to fetch"); return answer; }; })()`,
  );
  await pressButton("Lost");
  await page.waitFor(
    `/Lost: result unknown, check after reconnecting/.test(document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-error').textContent)`,
    "unknown result shown",
  );
  await delay(4500);
  check(
    "13 a lost answer says the result is unknown and the write is never sent again",
    (await callsOf("lost")).length === 1,
    await callsOf("lost"),
  );
  await shot("03-local-buttons");

  // ---- Views in the browser (5 6 7 10)
  await setMode({ mode: "hostile" });
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-foot')?.textContent.startsWith("F<img")`,
    "hostile view",
  );
  await pressButton("B<img src=x onerror=sectionsHacked=1>");
  await page.waitFor(`!!document.querySelector(${js(confirmBox)})`, "hostile confirmation");
  const hostileCard = await card("probe");
  check(
    "5 every plugin text renders literally and no markup runs",
    hostileCard.rows[0].label.startsWith("L<img") &&
      hostileCard.rows[0].text.startsWith("T<img") &&
      hostileCard.rows[0].status.startsWith("S<img") &&
      hostileCard.rows[0].detail[0].startsWith("D<img") &&
      hostileCard.rows[0].links[0].label.startsWith("K<img") &&
      hostileCard.rows[0].buttons[0].label.startsWith("B<img") &&
      hostileCard.rows[0].confirm.startsWith("C<img") &&
      (await page.evaluate(
        `!document.querySelector("#settings .plugin-section img, #plugin-sections img, #extra") && window.sectionsHacked === undefined`,
      )),
    hostileCard,
  );
  await click(`${confirmBox} [data-cancel]`);
  await setMode({ mode: "empty" });
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-empty')?.textContent.startsWith("E<img")`,
    "empty text",
  );
  check("5 empty text is literal", await page.evaluate(`window.sectionsHacked === undefined`));
  await setMode({ mode: "toomany" });
  await page.waitFor(
    `/Could not refresh: Section probe\\.main returned an invalid view: rows must have at most 50 items/.test(document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-error').textContent)`,
    "refused view shown",
  );
  check(
    "7 a refused view shows the error, keeps the last rows, and other sections keep working",
    (await card("probe")).empty.startsWith("E<img") &&
      (await card("network-gate")).state === "ready" &&
      !(await card("network-gate")).error,
  );
  await setMode({ mode: "normal" });
  // The earlier lost answer's notice stays until the next press; only the refresh error goes away.
  await page.waitFor(
    `!/Could not refresh/.test(document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-error').textContent)`,
    "refresh error cleared",
  );
  // 6: the browser checks the protocol again, whatever a host answered.
  const browserLinks = await page.evaluate(
    `(async () => { const { mountSection, sectionNode } = await import("/sections.js"); const entry = { plugin: "probe", id: "main", title: "Fake", place: "settings", refreshMs: null }; const node = sectionNode(entry); document.body.append(node); const view = { rows: [{ text: "x", links: [{ label: "js", url: "javascript:window.sectionsHacked=4" }, { label: "data", url: "data:text/html,x" }, { label: "ok", url: "https://example.test/" }] }] }; const stop = mountSection({ call: async () => view }, node, entry, { projectId: ${js(alpha)} }); await new Promise((ok) => setTimeout(ok, 200)); const out = [...node.querySelectorAll(".section-links > *")].map((item) => item.tagName + ":" + (item.getAttribute("href") ?? "")); stop(); node.remove(); return out; })()`,
  );
  check(
    "6 the browser sets an href only for http and https",
    js(browserLinks) === js(["SPAN:", "SPAN:", "A:https://example.test/"]),
    browserLinks,
  );
  // 10: a first read that throws shows the error, and a later read replaces it; a failed refresh keeps the rows.
  await closeSettings();
  await setMode({ failNext: 1 });
  await click(`[data-cmd="settings"]`);
  await page.waitFor(`document.querySelector("#settings").open`, "settings open");
  // Settings reopens on Plugins; clicking it again would mount a second time and read past the failure.
  if ((await page.evaluate(`document.querySelector("#settings").dataset.section`)) !== "plugins")
    await click(`#settings nav [data-section="plugins"]`);
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-section')?.dataset.state === "failed"`,
    "first read failed",
  );
  check(
    "10 5 a read that throws shows its error as text",
    /probe read failed <b><img/.test((await card("probe")).error) && (await page.evaluate(`window.sectionsHacked === undefined`)),
    await card("probe"),
  );
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-section')?.dataset.state === "ready"`,
    "later read",
  );
  check("10 a later successful read replaces the error", !(await card("probe")).error && (await card("probe")).rows.length === 3);
  await setMode({ failNext: 1 });
  await page.waitFor(
    `/Could not refresh: probe read failed/.test(document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-error').textContent)`,
    "refresh failed",
  );
  check("10 a failed refresh keeps the last rows", (await card("probe")).rows.length === 3);

  // ---- Lifecycle (15 16)
  const readsOf = async (section) => (await probeLog()).reads.filter((read) => read.section === section).length;
  for (let i = 0; i < 3; i++) {
    await closeSettings();
    await openPlugins();
  }
  await setMode({ slowMs: 2500, resetCounts: true });
  const before = await readsOf("main");
  await delay(6500);
  const during = (await readsOf("main")) - before;
  const log = await probeLog();
  check("16 reopening does not stack polling and only one read runs at a time", during >= 1 && during <= 3 && log.maxInFlight <= 2, {
    during,
    max: log.maxInFlight,
  });
  await setMode({ slowMs: 0 });
  await delay(2600);
  await closeSettings();
  await delay(300);
  const closed = await readsOf("main");
  await delay(4500);
  check("16 polling stops when Settings closes", (await readsOf("main")) === closed, { closed, now: await readsOf("main") });
  await page.evaluate(
    `Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"))`,
  );
  await delay(2500);
  const hiddenAt = await readsOf("side");
  await delay(4500);
  check("16 no reads while the page is hidden", (await readsOf("side")) === hiddenAt, { hiddenAt, now: await readsOf("side") });
  await page.evaluate(`delete document.hidden; document.dispatchEvent(new Event("visibilitychange"))`);
  await client.eventually(async () => (await readsOf("side")) > hiddenAt, "read when visible again");
  // 15: a slow answer for the previous chat never draws into the next one.
  await setMode({ slowMs: 1500 });
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(alpha)}, chatId: ${js(one)} }))`);
  await delay(200);
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(alpha)}, chatId: "main" }))`);
  await page.waitFor(`document.querySelector('#plugin-sections [data-plugin="probe"]')?.dataset.state === "ready"`, "main chat section");
  await delay(2500);
  check(
    "15 an answer for an older chat is discarded",
    /chat main/.test((await side("probe")).rows[0]) && !(await side("probe")).rows[0].includes(one),
    await side("probe"),
  );
  await setMode({ slowMs: 0 });
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(alpha)}, chatId: ${js(one)} }))`);
  await page.waitFor(
    `document.querySelector('#plugin-sections [data-plugin="probe"] .section-row')?.innerText.includes(${js(one)})`,
    "chat one section",
  );
  check("15 a chat change reads with the new chat", (await side("tasks")).empty === "No open tasks.");
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(beta)}, chatId: "main" }))`);
  await page.waitFor(
    `document.querySelector('#plugin-sections [data-plugin="probe"] .section-row')?.innerText.includes(${js(beta)})`,
    "beta section",
  );
  await openPlugins();
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-text')?.textContent === ${js(beta)}`,
    "beta settings",
  );
  check(
    "15 a project change reads with the new project",
    (await probeLog(client, beta)).reads.some((read) => read.projectId === beta && read.section === "main"),
  );

  // ---- Off for a project (4 16 17)
  await rpc({ action: "project-plugin", id: beta, plugin: "probe", enabled: false });
  await page.waitFor(
    `!document.querySelector('#plugin-sections [data-plugin="probe"]') && !document.querySelector('#settings .plugin-card[data-plugin="probe"] .plugin-section')`,
    "probe sections gone",
  );
  check(
    "4 turning a plugin off removes its sections at once, and the plugins action lists none of them",
    !(await rpc({ action: "plugins", id: beta })).sections.some((entry) => entry.plugin === "probe") && !!(await side("tasks")),
  );
  check(
    "17 a section read reaches no plugin that is off for the project",
    /disabled in this project/.test(await client.rejects({ action: "plugin-section", plugin: "probe", section: "main", id: beta })),
  );
  const offAt = (await probeLog(client, alpha)).reads.filter((read) => read.projectId === beta).length;
  await delay(4500);
  check(
    "16 no reads after the plugin is off",
    (await probeLog(client, alpha)).reads.filter((read) => read.projectId === beta).length === offAt,
  );
  await rpc({ action: "project-plugin", id: beta, plugin: "probe", enabled: true });
  await closeSettings();

  // ---- Network gate: the error row and paused projects (21)
  vpn(client, false);
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(alpha)}, chatId: "main" }))`);
  await openPlugins();
  await page.waitFor(
    `(() => { const rows = [...document.querySelectorAll('#settings .plugin-card[data-plugin="network-gate"] .section-row')]; return rows.some((row) => row.querySelector(".section-label")?.textContent === "Error") && rows[4]?.querySelector(".section-text").textContent !== "none"; })()`,
    "gate error row",
  );
  const failing = await card("network-gate");
  const errorRow = failing.rows.find((row) => row.label === "Error");
  check(
    "21 the error shows with tone bad, and the phase and failed samples follow the watcher",
    errorRow.tone === "bad" && failing.rows[0].status !== "ready" && Number(failing.rows[1].text) >= 2 && failing.rows[4].text !== "none",
    failing,
  );
  await shot("04-local-gate-error");
  await closeSettings();
  vpn(client, true);

  // ---- Remote host through its tunnel (18 19)
  mkdirSync(join(other.home, "remote"), { recursive: true });
  writeFileSync(join(other.home, "remote/config.json"), js({ enabled: true, relay: relay.origin, hostName: "Home Mac" }));
  const remoteStatus = await other.rpc({ action: "remote-reload" });
  relay.allow(remoteStatus.hostId);
  await other.waitFor(async () => (await other.rpc({ action: "remote-status" })).connection === "connected", "remote host connected");
  other.initRepo();
  const remote = await other.createProject("Only at home");
  await drive(other, remote, [["tasks_add", { title: "Remote <i>task</i>", stage: "blocked", note: "remote note" }]]);
  await setMode({ mode: "hostile" }, other, remote);
  await click(`#topbar [data-cmd="settings"]`);
  await click(`nav [data-section="remote"]`);
  await page.waitFor(`!!document.querySelector('[aria-label="Host pairing link"]')`, "Add host from link");
  await page.evaluate(`document.querySelector('[aria-label="Host pairing link"]').focus()`);
  await page.cdp("Input.insertText", { text: (await other.rpc({ action: "remote-pair-start" })).link });
  await click("[data-add-host]");
  await page.waitFor(`document.body.innerText.includes("Only at home")`, "remote project tree");
  await page.evaluate(`document.querySelector("#settings").open && document.querySelector("#settings").close()`);
  await page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(remote)}, chatId: "main" }))`);
  await page.waitFor(
    `document.querySelector('#plugin-sections [data-plugin="tasks"] .section-row')?.innerText.includes("Remote <i>task</i>") && document.querySelector('#plugin-sections [data-plugin="probe"]')?.dataset.state === "ready"`,
    "remote chat sections",
  );
  const remoteSide = await sideSections();
  check(
    "18 5 the remote host's chat sections show its own data, with its markup as text",
    remoteSide.map((item) => item.plugin).join() === "tasks,probe" &&
      /Blocked/.test(remoteSide[0].rows[0]) &&
      remoteSide[1].rows[0].includes(remote) &&
      remoteSide[1].footer.startsWith("F<img") &&
      (await page.evaluate(`!document.querySelector("#plugin-sections i, #plugin-sections img") && window.sectionsHacked === undefined`)),
    remoteSide,
  );
  check(
    "18 the sections were read from the remote host",
    (await probeLog(other, remote)).reads.some((read) => read.projectId === remote && read.section === "side") &&
      !(await probeLog()).reads.some((read) => read.projectId === remote),
  );
  await shot("05-remote-chat-sections");
  await openPlugins();
  await page.waitFor(
    `!!document.querySelector('#settings .plugin-card[data-plugin="network-gate"] .plugin-section[data-state="ready"]')`,
    "remote gate section",
  );
  const remoteGate = await card("network-gate");
  const remoteProbe = await card("probe");
  check(
    "18 21 Settings → Plugins shows the remote host's VPN gate and probe sections",
    remoteGate.rows[0].text === "CONNECTED" && remoteProbe.rows[0].text.startsWith("T<img") && remoteProbe.footer.startsWith("F<img"),
    { remoteGate, remoteProbe },
  );
  await shot("06-remote-settings-sections");
  await setMode({ mode: "normal" }, other, remote);
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-text')?.textContent === ${js(remote)}`,
    "remote normal view",
  );
  const localBumps = (await callsOf("bump")).length;
  await pressButton("Bump");
  await other.eventually(async () => (await callsOf("bump", other, remote)).length === 1, "remote bump");
  await page.waitFor(
    `document.querySelector('#settings .plugin-card[data-plugin="probe"] .section-status')?.textContent === "bumped 1"`,
    "remote bump drawn",
  );
  check(
    "19 a remote section's button reaches only the remote host, through the tunnel",
    (await callsOf("bump")).length === localBumps && (await callsOf("bump", other, remote))[0].projectId === remote,
  );
  check(
    "18 no plugin code from the remote host or the relay",
    js(await noPluginCode()) === js({ api: "undefined", plugins: [], foreign: [] }),
    await noPluginCode(),
  );
  await shot("07-remote-button");
  await closeSettings();
}
