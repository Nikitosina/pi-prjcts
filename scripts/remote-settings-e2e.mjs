// Browser E2E for Settings → Remote access (cases in scripts/remote-settings-failures.md): isolated host, fake model, and a local fake
// relay over TLS with a throwaway certificate the host trusts through NODE_EXTRA_CA_CERTS. Never a real relay.
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { kit, delay, randomUUID } from "./notify-kit.mjs";

const certs = join(realpathSync(tmpdir()), `remote-settings-certs-${randomUUID()}`);
mkdirSync(certs, { mode: 0o700 });
execFileSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "ec",
  "-pkeyopt",
  "ec_paramgen_curve:prime256v1",
  "-nodes",
  "-keyout",
  join(certs, "key.pem"),
  "-out",
  join(certs, "cert.pem"),
  "-days",
  "1",
  "-subj",
  "/CN=127.0.0.1",
  "-addext",
  "subjectAltName=IP:127.0.0.1",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
]);

// Fake relay: the challenge/ready handshake only; records the signed device lists the host sends. A minimal WebSocket (text
// frames under 64 KiB, no fragmentation) is enough for that and needs no package.
const relay = { lists: [], sockets: new Set(), up: true };
const tls = createServer({ key: readFileSync(join(certs, "key.pem")), cert: readFileSync(join(certs, "cert.pem")) });
const frame = (text) => {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
};
tls.on("upgrade", (req, socket) => {
  if (!relay.up || req.url !== "/ws") return socket.destroy();
  const accept = createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  relay.sockets.add(socket);
  socket.on("close", () => relay.sockets.delete(socket));
  socket.on("error", () => {});
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const op = buffer[0] & 15;
      let length = buffer[1] & 127,
        at = 2;
      if (length === 126) [length, at] = [buffer.readUInt16BE(2), 4];
      else if (length === 127) [length, at] = [Number(buffer.readBigUInt64BE(2)), 10];
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4),
        data = Buffer.from(buffer.subarray(at + 4, at + 4 + length)).map((byte, i) => byte ^ mask[i % 4]);
      buffer = buffer.subarray(at + 4 + length);
      if (op === 8) return socket.destroy();
      if (op !== 1) continue;
      const message = JSON.parse(data.toString());
      if (message.t === "host") socket.write(frame(JSON.stringify({ t: "ready" })));
      else if (message.t === "devices") relay.lists.push(message.list);
    }
  });
  socket.write(
    frame(JSON.stringify({ t: "challenge", nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") })),
  );
});
await new Promise((ok) => tls.listen(0, "127.0.0.1", ok));
const relayOrigin = `https://127.0.0.1:${tls.address().port}`;

const k = await kit("remote-settings", { NODE_EXTRA_CA_CERTS: join(certs, "cert.pem") });
const { result, rpc, eventually, evaluate, waitFor, shot, send } = k;
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 800)}`}`);
  result.checks.push(name);
};
const id43 = (c) => c.repeat(43);
const PHONE = id43("P"),
  TABLET = id43("T"),
  GONE = id43("G");
const XSS = `<img src=x onerror="window.__xss=1">Phone`;
const section = `document.querySelector('dialog[open] #remote-access')`;
const text = () => evaluate(`${section}?.innerText ?? ""`, s);
// Count the page's own remote reads: the section reads when it opens and when the host says something changed, never on a timer.
const COUNT = `(() => { window.__remoteReads = 0; const real = window.fetch; window.fetch = function (url, options) { try { if (/^remote-(status|devices)$/.test(JSON.parse(options?.body ?? "{}").action)) window.__remoteReads++; } catch {} return real.apply(this, arguments); }; })()`;
let s;
const openRemote = async (session) => {
  await waitFor(`document.body?.dataset.ready === "1"`, session, "inbox ready");
  await evaluate(`document.querySelector('[data-cmd="settings"]').click()`, session);
  await waitFor(`!!document.querySelector('dialog#settings[open] nav [data-section="remote"]')`, session, "settings open");
  await evaluate(`document.querySelector('dialog#settings nav [data-section="remote"]').click()`, session);
  await waitFor(`!!document.querySelector('dialog[open] #remote-access [data-remote-state]')`, session, "remote section");
};
const key = async (session, keyName, code, vk) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk }, session);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk }, session);
};
const devices = async () => rpc({ action: "remote-devices" });

try {
  await k.startHost();
  const id = await k.setup("Alpha", k.gitRepo);
  const url = new URL((await rpc({ action: "web" })).url);
  url.searchParams.set("project", id);
  s = await k.openPage(url.toString(), COUNT);
  await openRemote(s);

  // R1: off.
  const off = await text();
  check(
    "R1 remote off says how to turn it on and offers no Pair button",
    /remote enable/.test(off) && !(await evaluate(`!!${section}.querySelector('[data-remote-pair]')`, s)),
    off,
  );

  // R2: turned on while the section is open; the state arrives on the host topic.
  const now = Date.now();
  mkdirSync(join(k.home, "remote"), { recursive: true, mode: 0o700 });
  writeFileSync(join(k.home, "remote", "config.json"), JSON.stringify({ enabled: true, relay: relayOrigin, hostName: "Home Mac" }));
  writeFileSync(
    join(k.home, "remote", "devices.json"),
    JSON.stringify({
      seq: 0,
      devices: [
        { id: PHONE, name: XSS, pairedAt: now - 86_400_000, lastSeenAt: now - 60_000 },
        { id: TABLET, name: "Tablet", pairedAt: now - 3_600_000, lastSeenAt: now - 120_000 },
        { id: GONE, name: "Lost phone", pairedAt: now - 7_200_000, lastSeenAt: now - 7_000_000, revokedAt: now - 3_000_000 },
      ],
    }),
  );
  await evaluate(`window.__remoteReads = 0`, s);
  await rpc({ action: "remote-reload" });
  await waitFor(`${section}.querySelector('[data-remote-state]').dataset.remoteState === "connected"`, s, "connected without a reload");
  check("R2 turning remote on reaches the open section through the host topic", (await text()).includes(relayOrigin), await text());

  // R3: devices.
  const listed = await evaluate(`[...${section}.querySelectorAll('[data-remote-device]')].map((n) => n.dataset.remoteDevice)`, s);
  check(
    "R3 paired devices are listed by name with last seen; revoked ones are not; names are text",
    listed.join() === [PHONE, TABLET].join() &&
      (await text()).includes(XSS) &&
      /seen/.test(await text()) &&
      !(await text()).includes("Lost phone") &&
      !(await evaluate(`!!window.__xss || !!${section}.querySelector('img')`, s)),
    { listed, text: await text() },
  );
  await shot("01-remote-devices", s);

  // R4: pair, then cancel.
  await evaluate(`${section}.querySelector('[data-remote-pair]').click()`, s);
  await waitFor(`!!${section}.querySelector('[data-remote-qr] svg') && !!${section}.querySelector('[data-remote-link]')`, s, "pairing QR");
  const link = await evaluate(`${section}.querySelector('[data-remote-link]').textContent`, s);
  check(
    "R4 Pair a device shows the QR and the one-time link with its expiry",
    link.startsWith(relayOrigin) &&
      /until/.test(await text()) &&
      !(await evaluate(`!!${section}.querySelector('[data-remote-qr] script, [data-remote-qr] [onload]')`, s)),
    { link, text: await text() },
  );
  await shot("02-remote-pairing", s);
  await evaluate(`${section}.querySelector('[data-remote-pair-cancel]').click()`, s);
  await waitFor(
    `!${section}.querySelector('[data-remote-qr]') && !!${section}.querySelector('[data-remote-pair]') && !${section}.querySelector('[aria-disabled]')`,
    s,
    "pairing cancelled",
  );
  check("R4 Cancel ends the pairing on the host", !(await rpc({ action: "remote-status" })).pairing);

  // R5: rename in place.
  const row = (device) => `${section}.querySelector('[data-remote-device="${device}"]')`;
  await evaluate(`${row(TABLET)}.querySelector('[data-remote-rename]').click()`, s);
  await waitFor(`document.activeElement?.id === "remote-rename"`, s, "rename field focused");
  await evaluate(`document.activeElement.value = ""`, s);
  await key(s, "Enter", "Enter", 13);
  await waitFor(`!!${section}.querySelector('[data-remote-error]')`, s, "empty name refused");
  check("R5 an empty name is refused in place", (await devices()).find((d) => d.id === TABLET).name === "Tablet");
  await evaluate(`document.querySelector('#remote-rename').focus(); document.querySelector('#remote-rename').value = "Kitchen iPad"`, s);
  await key(s, "Enter", "Enter", 13);
  await eventually(async () => (await devices()).find((d) => d.id === TABLET).name === "Kitchen iPad", "rename saved", 100);
  await waitFor(`${row(TABLET)}.innerText.includes("Kitchen iPad") && !document.querySelector('#remote-rename')`, s, "renamed row");
  await evaluate(`${row(TABLET)}.querySelector('[data-remote-rename]').click()`, s);
  await waitFor(`document.activeElement?.id === "remote-rename"`, s, "rename field again");
  await evaluate(`document.activeElement.value = "Nope"`, s);
  await key(s, "Escape", "Escape", 27);
  await waitFor(`!document.querySelector('#remote-rename')`, s, "rename cancelled");
  check(
    "R5 Rename edits in place: Enter saves, Esc cancels and keeps Settings open",
    (await devices()).find((d) => d.id === TABLET).name === "Kitchen iPad" &&
      (await evaluate(`document.querySelector('dialog#settings').open`, s)),
  );

  // R6: revoke needs a second press.
  await evaluate(`${row(PHONE)}.querySelector('[data-remote-revoke]').click()`, s);
  await waitFor(`/Revoke now/.test(${row(PHONE)}.querySelector('[data-remote-revoke]').innerText)`, s, "armed revoke");
  check("R6 the first Revoke press changes nothing on the host", !(await devices()).find((d) => d.id === PHONE).revokedAt);
  await evaluate(`${row(PHONE)}.querySelector('[data-remote-revoke]').click()`, s);
  await eventually(async () => !!(await devices()).find((d) => d.id === PHONE).revokedAt, "revoked on the host", 100);
  await waitFor(`!${row(PHONE)}`, s, "revoked device leaves the list");
  const lastList = () => JSON.parse(Buffer.from(relay.lists.at(-1) ?? "", "base64url").toString() || "{}");
  await eventually(async () => lastList().devices && !lastList().devices.includes(PHONE), "relay told of the revoke", 100);
  check(
    "R6 the second press revokes the device, it leaves the list and the relay gets the new signed list",
    lastList().devices.includes(TABLET),
  );

  // R7: changes from elsewhere arrive on the topic; no polling in between.
  await delay(500);
  await evaluate(`window.__remoteReads = 0`, s);
  await delay(12_000);
  const idle = await evaluate(`window.__remoteReads`, s);
  await rpc({ action: "remote-rename", deviceId: TABLET, name: "Renamed elsewhere" });
  await waitFor(`${row(TABLET)}?.innerText.includes("Renamed elsewhere")`, s, "rename from elsewhere");
  await evaluate(`${section}.querySelector('[data-remote-pair]').click()`, s);
  await waitFor(`!!${section}.querySelector('[data-remote-qr]')`, s, "pairing again");
  await rpc({ action: "remote-pair-cancel" });
  await waitFor(`!${section}.querySelector('[data-remote-qr]')`, s, "pairing ended elsewhere");
  check("R7 changes made elsewhere reach the open section through the host topic, without polling", idle === 0, { idle });

  // R9: relay down.
  relay.up = false;
  for (const socket of relay.sockets) socket.destroy();
  await waitFor(`${section}.querySelector('[data-remote-state]').dataset.remoteState !== "connected"`, s, "relay down shown");
  await evaluate(`${section}.querySelector('[data-remote-pair]').click()`, s);
  await waitFor(
    `/relay before pairing/i.test(${section}.querySelector('[data-remote-error]')?.innerText ?? "")`,
    s,
    "pair refused in place",
  );
  check("R9 relay down: the state says so and Pair shows the host's refusal in place", true);
  await shot("03-relay-down", s);

  // R10: narrow.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(300);
  const overflow = await evaluate(
    `[...document.querySelectorAll('dialog[open] #remote-access *')].filter((n) => n.getBoundingClientRect().right > innerWidth + 1).map((n) => n.tagName + "." + n.className).slice(0, 5)`,
    s,
  );
  check("R10 the section fits 390px", !overflow.length, overflow);
  await shot("04-remote-mobile", s);
  relay.up = true;
  check("R8 the local inbox shows no Hosts link", !(await evaluate(`!!document.querySelector('#remote-hosts')?.offsetParent`, s)));

  // R8: inside the remote app. The relay bootstrap labels the page with its host before the app reads it.
  // One tab at a time: a second inbox tab on the same origin can starve on connections (a known, separate issue).
  const LABEL = `new MutationObserver((_, o) => { if (document.documentElement) { document.documentElement.dataset.remoteHost = "Home Mac"; o.disconnect(); } }).observe(document, { childList: true })`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: LABEL }, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  url.searchParams.set("open", "remote-app");
  await send("Page.navigate", { url: url.toString() }, s);
  const r = s;
  await openRemote(r);
  const remoteText = await evaluate(`${section}.innerText`, r);
  check(
    "R8 a paired device is not offered pairing, rename or revoke",
    !(await evaluate(`!!${section}.querySelector('[data-remote-pair], [data-remote-rename], [data-remote-revoke]')`, r)) &&
      /on this host/i.test(remoteText),
    remoteText,
  );
  await evaluate(`document.querySelector('dialog#settings').close()`, r);
  const hosts = await evaluate(
    `(() => { const a = document.querySelector('#remote-hosts'); return a && !a.hidden && a.offsetParent ? { href: a.getAttribute('href'), text: a.innerText } : null; })()`,
    r,
  );
  check("R8 the top bar names the host and links back to the host list", hosts?.href === "/" && hosts.text.includes("Home Mac"), hosts);
  await shot("05-remote-app", r);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, r);
  await delay(300);
  const top = await evaluate(
    `(() => { const bar = document.querySelector('#topbar'), link = document.querySelector('#remote-hosts').getBoundingClientRect(); const pill = document.querySelector('#status-pill'); return { wide: bar.scrollWidth > bar.clientWidth + 1, link: link.width > 0 && link.right <= innerWidth + 1 && link.height <= 36, pill: pill.scrollWidth <= pill.clientWidth + 1 }; })()`,
    r,
  );
  check(
    "R10 the Hosts link fits the top bar at 390px on one line and leaves the status pill whole",
    !top.wide && top.link && top.pill,
    top,
  );
  await shot("06-remote-app-mobile", r);
  result.relayLists = relay.lists.length;
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = String(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(
      `document.querySelector('dialog[open]')?.innerText.slice(0, 1500) ?? document.body.innerText.slice(0, 800)`,
      s,
    );
    await shot("failure", s);
  } catch {}
} finally {
  for (const socket of relay.sockets) socket.destroy();
  tls.close();
  await k.finish(result.status);
}
