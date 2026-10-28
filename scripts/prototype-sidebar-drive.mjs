// PROTOTYPE tooling (web/PROTOTYPE-SIDEBAR-VERIFY.md). Unscripted-style CDP drive of variant E against a verify SCRATCH host: real clicks/typing, host-side read-only proof through verify.mjs rpc.
// Usage: node scripts/prototype-sidebar-drive.mjs <scratch>/run.json <outdir> <ids.json>   (ids.json = stdout of prototype-sidebar-seed.mjs). Exit code 1 if any check fails.
import { execFileSync } from "node:child_process"; import { dirname } from "node:path"; import { spawn } from "node:child_process"; import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const [runFile, out, idsFile] = process.argv.slice(2); mkdirSync(out, { recursive: true });
const run = JSON.parse(readFileSync(runFile, "utf8")); const web = new URL(run.webUrl); const origin = web.origin, hash = web.hash;
const udd = mkdtempSync(join(tmpdir(), "pp-chrome-"));
const chrome = spawn(process.env.VERIFY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${udd}`, "--window-size=1440,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
console.log("chrome pid", chrome.pid);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let port; for (let i = 0; i < 100 && !port; i++) { await sleep(150); try { port = readFileSync(join(udd, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {} }
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? "")); else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error " + m.params.args.map(a => a.value ?? a.description).join(" ")); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const actions = new Map(); ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && /\/api/.test(m.params.request.url)) { try { const a = JSON.parse(m.params.request.postData).action; actions.set(a, (actions.get(a) ?? 0) + 1); } catch {} } });
const log = []; const check = (name, ok, extra = "") => { log.push({ name, ok: !!ok, extra }); console.log(ok ? "PASS" : "FAIL", name, extra); };
const shot = async name => { await ev(`document.querySelector("#side").scrollTo({ top: 0, behavior: "instant" })`); await sleep(200); const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(out, name + ".png"), Buffer.from(r.result.data, "base64")); };
async function goto(path) { await send("Page.navigate", { url: origin + path + hash }); await sleep(300); for (let i = 0; i < 80; i++) { if (await ev(`(document.querySelector('#title')?.textContent||'').length>0&&!/Opening/.test(document.querySelector('#title').textContent)`)) break; await sleep(250); } await sleep(600); }
// real pointer click on the element found by selector (+ optional text), after a hit test
async function click(sel, text) {
  const pos = await ev(`(() => { const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>!${JSON.stringify(text)}||e.textContent.includes(${JSON.stringify(text)})); const e=els[0]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); return {x,y,ok:e===hit||e.contains(hit)}; })()`);
  if (!pos?.ok) throw new Error(`cannot click ${sel} ${text ?? ""}: ${JSON.stringify(pos)}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  await sleep(250);
}
const key = async k => { for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: { ArrowRight: 39, Escape: 27, Enter: 13 }[k] ?? 37 }); await sleep(200); };


const WT = join(dirname(new URL(import.meta.url).pathname), ".."), SCRATCH = dirname(runFile);
const rpc = (action, args) => JSON.parse(execFileSync("node", [join(WT, ".agents/skills/verify-pi-prjcts/scripts/verify.mjs"), "rpc", "--run", SCRATCH, action, JSON.stringify(args)], { encoding: "utf8" }));
const ids = JSON.parse(readFileSync(idsFile, "utf8"));
const q = sel => `document.querySelector(${JSON.stringify(sel)})`;
const snap = () => ev(`({ url: location.search, title: ${q('#title')}.textContent, tabs: [...document.querySelectorAll('#proto-tabs .pp-tab')].map(t=>t.title+(t.classList.contains('on')?' *':'')), empty: document.body.classList.contains('proto-empty'), tree: [...document.querySelectorAll('#proto-nav .pp-node')].map(n=>({ p: n.querySelector('.pp-name').textContent, open: n.querySelector('.pp-proj').getAttribute('aria-expanded')==='true', kids: [...n.querySelectorAll('.pp-child')].map(c=>c.querySelector('.pp-t').textContent) })), msgs: ${q('#messages')}.innerText, stripVisible: getComputedStyle(${q('#chat-list')}).display !== 'none' })`);
const until = async (fn, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { if (await fn()) return true; await sleep(200); } return false; };
const msgsHave = async text => until(async () => (await snap()).msgs.includes(text));
const treeOf = (s, name) => s.tree.find(n => n.p === name);
const chatsOf = id => rpc("show", { id }).chats;
let s;
try {
  await goto("/");
  const plain = await ev(`({ nav: !!${q('#proto-nav')}, tabs: !!${q('#proto-tabs')}, quick: !!${q('#proto-quick-pill')}, v: document.body.dataset.protoVariant ?? null, strip: getComputedStyle(${q('#chat-list')}).display, scripts: [...document.scripts].map(x=>x.src).filter(x=>/prototype/.test(x)).length, list: getComputedStyle(${q('#project-list')}).display })`);
  check("plain app: no prototype nodes/scripts; real project list and all-coordinator strip as before", !plain.nav && !plain.tabs && !plain.quick && !plain.v && plain.strip !== "none" && plain.list !== "none" && !plain.scripts, JSON.stringify(plain));
  await shot("00-plain-default");
  await goto(`/?variant=D&keep=1`); check("retired keys (D, F, A...) mount nothing", !(await ev(`!!${q('#proto-tabs')}`)));

  // ---- E overview ----
  await goto(`/?variant=E&keep=1&project=${ids.seed}`);
  s = await snap();
  check("E: one tab for the open coordinator, all-coordinator strip hidden (replaced by tabs)", s.tabs.length === 1 && s.tabs[0].endsWith("*") && !s.stripVisible && /Main/.test(s.tabs[0]), JSON.stringify(s.tabs));
  check("E: three REAL projects listed from the host", s.tree.map(n => n.p).sort().join() === "Billing service,Docs site,Verify seed", JSON.stringify(s.tree.map(n => n.p)));
  for (const name of ["Billing service", "Docs site"]) { if (!treeOf(await snap(), name).open) await click(`#proto-nav .pp-proj[title="${name}"]`); }
  await until(async () => treeOf(await snap(), "Docs site").kids.length > 0);
  s = await snap();
  check("sidebar expansion is independent of tabs (3 projects expanded, still 1 tab)", s.tree.every(n => n.open) && s.tabs.length === 1, JSON.stringify(s.tree));
  const all = s.tree.flatMap(n => n.kids).join("|");
  const hostChats = { seed: chatsOf(ids.seed), billing: chatsOf(ids.billing), docs: chatsOf(ids.docs) };
  const archivedHost = Object.values(hostChats).flat().filter(c => c.archived).map(c => c.title);
  check("host has archived coordinators (Q2 dependency sweep, Old ledger spike); sidebar lists none of them", archivedHost.length === 2 && !archivedHost.some(t => all.includes(t)) && /Release 0.9 checklist/.test(all) && /Stripe webhook retries/.test(all), JSON.stringify({ archivedHost, all }));
  await click(`#proto-nav .pp-proj[title="Verify seed"]`); await click(`#proto-nav .pp-proj[title="Verify seed"]`); // collapse/expand again, still independent
  await shot("E-01-overview-three-projects-expanded");

  // ---- open real coordinators across two real projects ----
  const open = async (name, expectTitle, expectText) => { await click(`#proto-nav .pp-child[title="${name}"]`); const ok = await until(async () => (await snap()).title === expectTitle) && (expectText ? await msgsHave(expectText) : true); return ok; };
  check("open Release 0.9 (Verify seed): real transcript shown", await open("Release 0.9 checklist", "Verify seed", "List what is left before tagging v0.9.0."));
  check("open Stripe webhook retries (Billing service, another real project): real transcript shown", await open("Stripe webhook retries", "Billing service", "Are retries idempotent?"));
  check("open Tax table import (Billing service): real transcript shown", await open("Tax table import", "Billing service", "Diff the EU tax table against last quarter."));
  s = await snap();
  check("three coordinators across two real projects are 3 + 1 tabs, last active", s.tabs.length === 4 && s.tabs[3].includes("Tax table import") && s.tabs[3].endsWith("*"), JSON.stringify(s.tabs));
  await click(`#proto-nav .pp-child[title="Stripe webhook retries"]`); await msgsHave("Are retries idempotent?"); s = await snap();
  check("opening an already-open coordinator focuses the one tab (no duplicate)", s.tabs.length === 4 && s.tabs[2].endsWith("*") && s.title === "Billing service", JSON.stringify(s.tabs));
  await click("#proto-tabs .pp-tab", "Release 0.9"); await msgsHave("List what is left before tagging v0.9.0."); s = await snap();
  check("clicking a tab in the other real project switches the real page to it", s.tabs[1].endsWith("*") && s.title === "Verify seed", JSON.stringify(s.tabs));
  await shot("E-02-real-transcript-in-tab-verify-seed");
  await click("#proto-tabs .pp-tab", "Tax table"); await msgsHave("Diff the EU tax table"); await shot("E-03-billing-tax-table-tab");
  // close fallback
  await click("#proto-tabs .pp-tab.on .pp-x"); s = await snap();
  check("close active last tab: left neighbour (Stripe) active and its transcript shown", s.tabs.length === 3 && s.tabs[2].includes("Stripe") && s.tabs[2].endsWith("*") && await msgsHave("Are retries idempotent?"), JSON.stringify(s.tabs));
  await click("#proto-tabs .pp-tab", "Release 0.9"); await click("#proto-tabs .pp-tab.on .pp-x"); s = await snap();
  check("close active middle: right neighbour (Stripe) active", s.tabs.length === 2 && s.tabs[1].includes("Stripe") && s.tabs[1].endsWith("*"), JSON.stringify(s.tabs));
  await click("#proto-tabs .pp-tab", "Main"); await click("#proto-tabs .pp-tab:not(.on) .pp-x"); s = await snap();
  check("close an inactive tab: active unchanged", s.tabs.length === 1 && s.tabs[0].endsWith("*"), JSON.stringify(s.tabs));
  await click("#proto-tabs .pp-tab.on .pp-x"); s = await snap();
  check("close the last tab: empty state shown, real header/body hidden", s.empty && s.tabs.length === 0 && await ev(`getComputedStyle(${q('.phead')}).display === 'none' && getComputedStyle(${q('#proto-empty')}).display !== 'none'`), "");
  await shot("E-04-empty-tabs");
  // quick switcher
  for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "j", code: "KeyJ", windowsVirtualKeyCode: 74, modifiers: 2 }); await sleep(400);
  check("quick switcher opens (Ctrl/Cmd+J) and lists only non-archived coordinators of all projects", await ev(`!!${q('#proto-quick')}`) && !(await ev(`${q('#proto-quick')}.innerText`)).match(/Q2 dependency|Old ledger/) && /API reference regen/.test(await ev(`${q('#proto-quick')}.innerText`)));
  await shot("E-05-quick-switcher");
  await send("Input.insertText", { text: "api ref" }); await sleep(200); await key("Enter"); await sleep(300);
  check("quick switcher: filter + Enter opens the coordinator in a tab with its real transcript", await msgsHave("Regenerate the OpenAPI v3.2 pages.") && (await snap()).tabs.length === 1 && !(await snap()).empty, JSON.stringify((await snap()).tabs));

  // ---- current-app functionality inside E ----
  await click("#proto-nav .pp-child[title='Flaky e2e triage']"); await msgsHave("Which e2e tests are flaky this week?");
  await click("#compose textarea"); await send("Input.insertText", { text: "E-PROTO-PING from the composer" });
  await shot("E-06-composer-typed");
  await click("#compose button[type=submit]");
  check("real composer: message sent and the echo reply arrives in this coordinator", await msgsHave("VERIFY-FAKE-REPLY: E-PROTO-PING from the composer"));
  const flaky = rpc("show", { id: ids.seed, chatId: ids.flaky });
  check("host-side read-only proof: the message is stored in THAT chat only", JSON.stringify(flaky.messages).includes("E-PROTO-PING") && !JSON.stringify(rpc("show", { id: ids.seed, chatId: ids.release }).messages).includes("E-PROTO-PING"));
  // new chat via the real button (+ in tab bar)
  const before = chatsOf(ids.seed).length;
  await click("#proto-tabs [data-pp-new]"); await until(async () => (await snap()).tabs.length === 2 || true, 500);
  await until(async () => chatsOf(ids.seed).length === before + 1);
  s = await snap();
  check("new chat (real action via + button): host has one more chat, app opened it and a tab follows it", chatsOf(ids.seed).length === before + 1 && s.tabs.length === 3 && s.tabs[2].includes("New chat") && s.tabs[2].endsWith("*"), JSON.stringify(s.tabs));
  const newId = chatsOf(ids.seed).find(c => !Object.values(ids).includes(c.id) && c.id !== "main").id;
  await click("#chat-bar [data-action=chat-rename]"); await sleep(300);
  await ev(`${q('#dialog form[data-chat-rename] input')}.select()`); await send("Input.insertText", { text: "Hotfix 0.9.1" });
  await click("#dialog form[data-chat-rename] button[type=submit]");
  await until(async () => (await snap()).tabs.some(t => t.includes("Hotfix 0.9.1")));
  s = await snap();
  check("rename (real dialog): tab and sidebar show the new title; host agrees", s.tabs[2].includes("Hotfix 0.9.1") && treeOf(s, "Verify seed").kids.includes("Hotfix 0.9.1") && chatsOf(ids.seed).some(c => c.id === newId && c.title === "Hotfix 0.9.1"), JSON.stringify(s.tabs));
  await shot("E-07-new-chat-renamed");
  await click("#chat-bar [data-action=chat-archive]");
  await until(async () => !(await snap()).tabs.some(t => t.includes("Hotfix")));
  s = await snap();
  check("archive (real action): tab closed, coordinator gone from sidebar, app fell back to Main; host archived it", !s.tabs.some(t => t.includes("Hotfix")) && !treeOf(s, "Verify seed").kids.includes("Hotfix 0.9.1") && chatsOf(ids.seed).find(c => c.id === newId).archived === true && s.tabs.some(t => t.endsWith("*") && t.includes("Main")), JSON.stringify(s.tabs));
  await click("#chat-archived summary"); await sleep(300); await shot("E-08-archived-list-in-real-toolbar");
  await click("#chat-archived .archived-row button", "Restore"); await until(async () => (await snap()).tabs.some(t => /Hotfix|Q2 dependency/.test(t)));
  s = await snap(); check("restore from the real archived list: coordinator returns to the sidebar and opens as a tab", /Hotfix|Q2 dependency/.test(s.tabs.join()) && treeOf(s, "Verify seed").kids.length >= 4, JSON.stringify(s.tabs));
  // sections
  for (const [name, panel] of [["Knowledge", "knowledge"], ["Observability", "observability"], ["Settings", "settings"]]) {
    await click(`.phead .tabs [data-tab=${panel}]`); await sleep(1200);
    check(`section ${name} reachable and rendered in the canvas`, await ev(`!${q(`[data-panel=${panel}]`)}.hidden && ${q(`[data-panel=${panel}]`)}.innerText.length > 40`));
    await shot(`E-09-section-${panel}`);
  }
  await click("#proto-nav .pp-child[title='Stripe webhook retries']"); await sleep(800);
  check("opening a coordinator from another section returns to the Coordinator panel", await ev(`!${q('[data-panel=coordinator]')}.hidden && ${q('[data-panel=knowledge]')}.hidden`));
  await click("#search-button"); await sleep(500); check("real search dialog opens", await ev(`${q('#dialog')}.open`)); await shot("E-10-search-dialog"); await key("Escape"); await sleep(300); check("search dialog closes with Escape", !(await ev(`${q('#dialog')}.open`)));
  if (await ev(`${q('#dialog')}.open`)) await ev(`${q('#dialog')}.close()`);
  // sidebar: collapse + resize
  for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 }); await sleep(500); check("app's own sidebar collapse works with the tree (glyph rail)", await ev(`${q('.app')}.classList.contains('side-collapsed')`)); await shot("E-11-sidebar-collapsed"); for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 }); await sleep(500);
  const gx = await ev(`(() => { const r = ${q('#proto-grip')}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 300 }; })()`);
  for (const [type, x] of [["mouseMoved", gx.x], ["mousePressed", gx.x], ["mouseMoved", gx.x + 60], ["mouseReleased", gx.x + 60]]) await send("Input.dispatchMouseEvent", { type, x, y: gx.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  await sleep(300); const w = await ev(`Math.round(${q('#side')}.getBoundingClientRect().width)`);
  check("sidebar resizes by dragging the grip", w > 300, `width ${w}`);
  await shot("E-12-sidebar-resized-wide");
  await ev(`document.documentElement.dataset.theme = 'light'`); await sleep(300); await shot("E-13-light-theme");
  await ev(`document.documentElement.dataset.theme = 'dark'`);
  // reload: location kept, tabs reset
  const cur = await snap(); await goto("/" + cur.url); s = await snap();
  check("reload keeps ?variant=E and the open coordinator; other tabs reset (memory-only)", /variant=E/.test(s.url) && /keep=1/.test(s.url) && s.tabs.length === 1 && s.tabs[0].endsWith("*"), JSON.stringify(s.tabs));
  const sent = [...actions].map(([a, n]) => `${a}×${n}`).join(", ");
  const mut = [...actions].filter(([a]) => ["message", "chat-create", "chat-update"].includes(a));
  const unknown = [...actions.keys()].filter(a => !/snapshot|^(list|show|plugins|prs|machine-status|knowledge-list|remote-status|event-log|host-health|schedule-history|coordinator-skills|mcp-catalog|message|chat-create|chat-update)$/.test(a));
  check("page API actions: the only writes are the ones I clicked (1 message, 1 chat-create, 3 chat-update); nothing from the prototype itself", (actions.get("message") ?? 0) === 1 && (actions.get("chat-create") ?? 0) === 1 && (actions.get("chat-update") ?? 0) === 3 && unknown.length === 0, sent + " | unknown: " + JSON.stringify(unknown));
} catch (e) { console.log("ERROR", e.stack); await shot("99-failure").catch(() => {}); check("no driver exception", false, e.message); }
check("no browser console errors", errors.length === 0, errors.join(" | "));
writeFileSync(join(out, "report.json"), JSON.stringify({ revision: execFileSync("git", ["-C", WT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), log, actions: [...actions], errors }, null, 2));
ws.close(); chrome.kill("SIGTERM"); await sleep(500);
console.log("failed:", log.filter(l => !l.ok).length); process.exit(log.some(l => !l.ok) ? 1 : 0);
