# Remote access spec

Owner-approved design for reaching Pi Projects hosts from anywhere. The decisions below come from the owner's design interview on 2026-10-21. Items marked *proposal* are implementation choices made after it.

## Goal

The owner opens the full browser inbox of any of their hosts (home Mac, work Mac) from an iPhone, iPad or another laptop, wherever they are, and gets alerted when a host needs them. Every device already runs a different VPN (corporate full-tunnel or censorship bypass), so mesh VPNs such as Tailscale are out. Company rules forbid Cloudflare Tunnel.

## Owner decisions

1. Staged: remote browser inbox first, then several hosts, then HQ (merged inbox).
2. Outbound HTTPS/WSS only. No device needs a second VPN, an open inbound port, or a router change.
3. The relay runs on the owner's home Mac, behind its existing nginx, on a subdomain of a domain whose DNS is managed at beget. The relay runs as its own macOS user and cannot read `~/.pi`.
4. Orca-style relay: the host and the clients both dial out to the relay, which only joins connections. All traffic is end-to-end encrypted between device and host; the relay sees ciphertext.
5. The work Mac may send full content. Company policy is the owner's call, the same as with Orca today.
6. The client is a PWA bootstrap served by the relay, kept small and rarely changed. The inbox UI (`web/`) is fetched from the host through the encrypted tunnel and cached by hash.
7. The tunnel carries HTTP. `web.ts` stays the only gate, and it learns which paired device sent each request.
8. The host pushes change signals. UI polling drops from 2 s to a 30 s fallback.
9. Pairing uses a QR code shown by the host, carrying the host key and a single-use code. Approval from an already-paired device comes later.
10. A host switcher now (one host at a time). A merged inbox comes next.
11. The relay admits only allowlisted hosts and devices the host signed in a device list. Revoking a device takes effect immediately.
12. `remote enable` installs a LaunchAgent for the host and prevents sleep only while on AC power.
13. Code: `relay/` in this repo (its only dependency is `ws`), `src/remote.ts` inside the host, crypto through WebCrypto and `node:crypto` only.
14. Alerts: Web Push carrying no message text. Telegram remains optional per host.
15. Stage order and stage 2 done criteria as in [Stages](#stages).

## Failure cases recorded before implementation

Pairing and identity:
- The relay swaps the host key during pairing and stays in the middle of every later session.
- A captured pairing link is reused after first use or after it expires.
- A guessed or brute-forced pairing code adds a device.
- The relay replays an old signed device list after a revocation and readmits the revoked device.
- A device that was revoked keeps an open session or a cached ticket and goes on sending requests.
- A device key leaves the device because the bootstrap stored it as extractable.

Tunnel and crypto:
- The relay reorders, replays, truncates or injects frames, and either side accepts them.
- The same AES-GCM key and IV pair is used twice.
- Handshake transcripts are not bound to the host ID, so a session for one host is accepted by another.
- A request smuggles headers (`Host`, `Origin`, `Authorization`, `x-pi-device`) that `web.ts` trusts.
- One huge or stalled response (artifact download, `/live`) starves every other request in the session.
- An upload larger than the host limit is buffered in memory before it is refused.

Relay:
- Anyone registers as a host, or connects as a client to a host they were not paired with.
- An unauthenticated client holds sockets open, or floods the relay or nginx.
- The relay logs or stores payloads, device names or project names.
- A crash or restart of the relay leaves hosts disconnected without reconnecting.
- The relay process can read the owner's home directory or Pi state.

Browser client:
- Safari kills the service worker while it holds the only WebSocket, and the inbox goes dead.
- A host UI document reaches a different host's tunnel.
- The cached host UI goes stale after a host update and calls API actions that no longer exist.
- The relay ships a modified bootstrap and the owner is never told.
- Inbox tokens or device keys leak into URLs, logs or other origins.

Host:
- The LaunchAgent and the CLI-spawned host race for the host lock, and launchd restarts the host in a loop.
- `caffeinate` outlives a disabled remote mode, or keeps the Mac awake on battery.
- Change push misses a change, so a remote UI stays stale until the 30 s fallback poll.
- Server-side change detection costs more host CPU than the browser polling it replaces.
- Web Push sends message text, or a dead subscription is retried forever.
- Enabling remote mode changes behavior of a host that never enabled it.

## Architecture

```
iPhone/iPad/laptop (PWA)                 home Mac                                  host (home or work Mac)
───────────────────────                  ────────                                  ───────────────────────
host UI document  ──fetch──▶ service worker
     │  (tunnel.js owns WSS)             nginx :443 relay.<domain>
     └──────────── wss ─────────────▶   relay (own user, loopback port)  ◀── wss ──  src/remote.ts (in host process)
                                         joins client ↔ host channels                     │ loopback HTTP + remote token
                                         sees only ciphertext                              ▼
                                                                                   src/web.ts (only gate)
```

### Components and ownership

| Path | Role |
|---|---|
| `relay/bootstrap/wire.js` | Shared protocol module: encoding, key derivation, handshake, framing. Plain ES module using only WebCrypto, imported by the browser bootstrap and by `src/remote.ts`. |
| `relay/bootstrap/` | The PWA: `index.html` (host switcher, pairing), `sw.js`, `boot.js`, `tunnel.js`, `host.html` (first-load loader), `manifest.webmanifest`, icons, styles. Served by the relay as static files. |
| `relay/relay.ts`, `relay/package.json` | The relay server and its CLI (`allow`, `deny`, `hosts`, `fingerprint`). Dependency: `ws`. |
| `relay/deploy/` | nginx location snippet, LaunchDaemon plist for a dedicated user, deployment README. |
| `src/remote.ts` | Host side: host key, device registry, pairing, signed device list, tunnel sessions, forwarding to `web.ts`. |
| `src/web-push.ts` | RFC 8291 payload encryption for a subscription; hands the ciphertext to the relay and prunes dead subscriptions. |
| `src/web.ts` | Change stream, ETag and 304 for static assets, remote auth path, `/remote/*` device routes. |
| `src/cli.ts`, `src/client.ts` | `remote enable/disable/status`, LaunchAgent, `launchctl kickstart` when remote mode owns the host. |
| `web/` | Consumes the change stream; Remote access settings (status, pairing QR, devices, revoke). |

## Identities and keys

- **Host key.** Ed25519, created on first `remote enable`, stored as JWK in `<home>/remote/host-key.json` (0600). `hostId` is the base64url of the raw 32-byte public key.
- **Device key.** Ed25519, generated in the browser with `extractable: false`, stored as a `CryptoKey` in IndexedDB on that device. `deviceId` is the base64url of the raw public key.
- **Pairing code.** 16 random bytes, base64url, single use, valid 10 minutes, at most 5 failed attempts. `pairId` = base64url of the first 16 bytes of SHA-256(`"pi-pair-id\n" + code`). The relay learns `pairId` only, never the code.
- **VAPID key.** ECDSA P-256, held by the **relay** in `<RELAY_DATA>/vapid.json` (0600). A browser push subscription is bound to one VAPID key, so a PWA paired with several hosts can only receive pushes if one party signs all of them. Hosts never hold a VAPID key.
- **Remote token.** 32 random bytes, kept in host memory, given only to `src/remote.ts` for loopback requests to `web.ts`. It is never written to disk or sent to a device.

## Relay protocol

One WebSocket endpoint: `wss://relay.<domain>/ws`. Control messages are JSON text frames; data is binary.

1. On connect the relay sends `{"t":"challenge","nonce":<b64u 32 bytes>}`. A peer that does not authenticate within 10 s is closed.
2. **Host:** `{"t":"host","hostId","sig"}`, where `sig` is Ed25519 over `"pi-relay-host-v1\n" + nonce`. The relay requires `hostId` in its allowlist (`<RELAY_DATA>/hosts.json`, edited only through the relay CLI). A new host connection replaces the old one (close 4409). Reply `{"t":"ready"}`.
3. **Host device list:** after `ready` and on every change, the host sends `{"t":"devices","list":<b64u JSON>,"sig"}`. The JSON is `{"hostId","seq","devices":[deviceId…],"pairing":[pairId…]}`, and `sig` is Ed25519 over `"pi-relay-devices-v1\n" + list`. The relay accepts it only from the authenticated host connection, with `hostId` matching and `seq` greater than the last accepted one for that host (in memory; a host restart starts from a persisted counter in `<home>/remote/devices.json`). The relay immediately closes client channels whose device left the list (close 4403).
4. **Device client:** `{"t":"client","hostId","deviceId","sig"}`, where `sig` is Ed25519 over `"pi-relay-client-v1\n" + hostId + "\n" + nonce`.
5. **Pairing client:** `{"t":"pair","hostId","pairId"}`, admitted only while `pairId` is in the host's current list.
6. Host offline → close 4404. Unknown host, device or pair ID → close 4403 with the same reason text for all three.
7. Once admitted, the relay assigns a channel number (u32) and sends the host `{"t":"open","ch","deviceId"|null,"pair":bool}`, then sends the client `{"t":"ready"}`.
8. **Data.** After `ready`, every client↔host payload is a binary frame, the two plaintext handshake messages included; only relay control messages are text. A pair mode channel stays open when its `pairId` leaves the list, because the same session continues as the newly paired device; device mode channels close as soon as their device leaves. Client binary payload → host as `[ch u32 BE][payload]`. Host binary `[ch][payload]` → that client's payload. Host `{"t":"close","ch"}` closes a channel; the relay tells the host `{"t":"closed","ch"}` when a client goes away.
9. **Push.** The authenticated host may send `{"t":"push","id","endpoint","body","ttl","urgency"}`, where `body` is the base64url of an RFC 8291 `aes128gcm` payload the host already encrypted for that subscription. The relay accepts only `https` endpoints on known push services (`*.push.apple.com`, `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`), a body of at most 4096 bytes, `urgency` in `very-low|low|normal|high`, `ttl` of at most 86400, and 60 pushes per host per minute. It signs an RFC 8292 VAPID JWT (`aud` = endpoint origin, `sub` = `RELAY_ORIGIN`, 12 h expiry), POSTs it, and answers `{"t":"push-result","id","status"}`. `GET /vapid` returns the public key as base64url uncompressed P-256. The relay never sees push plaintext.
10. **Limits.** Frame size max 1 MiB; 64 channels per host; 4 pending (unauthenticated) sockets per IP and 30 connection attempts per IP per minute; WebSocket ping every 25 s, close after 2 missed pongs. The relay logs only connection events (role, short hash of the ID, close code), never payloads.

## End-to-end session

Runs inside a channel. The first two payloads are plaintext JSON (UTF-8); everything after them is encrypted.

**Hello, client → host:**
`{"v":1,"mode":"device"|"pair","deviceId","e","n","name"?,"sig","mac"?}`
- `e`: client ephemeral X25519 public key; `n`: 32 random bytes; `name`: device name (pair mode only).
- `T1 = "pi-remote-hello-v1\n" + hostId + "\n" + mode + "\n" + deviceId + "\n" + e + "\n" + n + "\n" + (name ?? "")`
- `sig`: device Ed25519 over T1, proving possession of the device key in both modes.
- `mac` (pair mode): HMAC-SHA256 with the pairing code as the key, over T1.

The host refuses a device mode hello from a device that is not active, and a pair mode hello whose code is unknown, used, expired, or out of attempts. A failed `mac` counts as an attempt. On a valid pair mode hello, the host adds the device, burns the code, sends the new signed device list, and the session continues as that device.

**Welcome, host → client:** `{"v":1,"e","n","sig"}`
- `T2 = "pi-remote-welcome-v1\n" + b64u(SHA-256(T1)) + "\n" + e + "\n" + n`
- `sig`: host Ed25519 over T2. The client verifies it against the `hostId` pinned at pairing, never against anything the relay supplies.

**Keys:** `shared = X25519(client e, host e)`; `salt = SHA-256(T1 + "\n" + T2)`; HKDF-SHA256 with info `"pi-remote c2h v1"` and `"pi-remote h2c v1"` gives two AES-256-GCM keys.

**Records:** `[8-byte counter BE][ciphertext+tag]`. IV = 4 zero bytes + the counter. AAD = `"c2h"` or `"h2c"`. Each direction starts at 0 and must match exactly the next expected counter; any mismatch, failed decryption or counter overflow closes the session. Keys live only for that session.

## HTTP over the tunnel

Decrypted record = `[u32 BE header length][header JSON][body bytes]`.

| Direction | Header | Body |
|---|---|---|
| C→H | `{"t":"req","id","method","path","headers","fin"}` | first chunk of request body |
| C→H | `{"t":"data","id","fin"}` | next chunk |
| C→H | `{"t":"cancel","id"}` | none |
| H→C | `{"t":"res","id","status","headers","fin"}` | first chunk of response body |
| H→C | `{"t":"data","id","fin"}` | next chunk |
| H→C | `{"t":"err","id","error"}` | none |

- `id` is a client-chosen integer, unique within the session. At most 32 requests in flight per session.
- Body chunks are at most 256 KiB. The host interleaves response chunks of concurrent requests round-robin and waits for the WebSocket to drain, so one download cannot starve `/live` or `/api`.
- Request headers passed to `web.ts`: only `content-type`, `x-filename`, `if-none-match`, `accept`. `src/remote.ts` sets `host`, `authorization: Bearer <remote token>` and `x-pi-device: <deviceId>` itself. Anything else the client sends is dropped.
- Response headers returned: `content-type`, `content-disposition`, `etag`, `cache-control`, `content-length`.
- Request bodies over 20 MiB are refused when the running total crosses the limit, without buffering the rest.

## Host changes

### `src/web.ts`
- **Auth.** A request is authenticated if it carries the inbox token (local, unchanged), or the remote token plus an `x-pi-device` that `remote.deviceActive()` confirms on every request. A revoked device fails on its next request even if its session is still open. The remote path is unavailable while remote mode is off.
- **Change stream.** `GET /changes?project=<id>&chat=<id>` returns SSE. It sends `{"t":"project"}` when anything the UI's refresh reads for that project and chat changes, and `{"t":"notices","seq"}` when the host notice feed advances. Comment heartbeats every 15 s. Detection is server-side and deduplicated: one watcher per (project, chat) however many subscribers. It must not miss a change the 2 s browser poll would have caught. *Proposal:* the baseline is a host-side 2 s fingerprint of the same snapshot inputs, run only while a subscriber exists; cheaper runtime signals may replace parts of it if they are provably complete.
- **Static assets.** `/`, `/app.js`, `/styles.css`, `/theme.js` and plugin UI files get a strong `ETag` (SHA-256) and answer `If-None-Match` with 304.
- **Device routes.** `POST /remote/push` saves or clears the calling device's Web Push subscription. `GET /remote/summary` returns `{hostName, needs}`, where `needs` counts pending questions and approvals across active projects.

### `src/remote.ts`
- Starts with the host when `<home>/remote/config.json` exists and has `enabled: true`. Otherwise it does nothing, and no remote file, route or connection exists.
- Keeps one WebSocket to the relay, reconnecting with backoff of 1 s doubling to a maximum of 60 s plus jitter. Exposes connection state.
- Device registry `<home>/remote/devices.json` (0600): `{seq, devices:[{id,name,pairedAt,lastSeenAt,revokedAt?,push?}]}`. Revoking a device sets `revokedAt`, drops its push subscription, closes its sessions, and sends a new signed list.
- Pairing: `pairStart()` returns `{link, expiresAt}`; `link = https://relay.<domain>/#pair=<b64u JSON {"h":hostId,"c":code,"n":hostName}>`. One open pairing at a time; starting a new one cancels the previous.
- Forwards requests to the local `web.ts` over loopback HTTP (see [HTTP over the tunnel](#http-over-the-tunnel)).
- Sends Web Push for each new notice to every active device with a subscription, through the relay (see Relay protocol, Push).

### `src/web-push.ts`
- RFC 8291 `aes128gcm` payload encryption with `node:crypto` only. No VAPID: the relay signs.
- Payload: `{"h":hostId,"hn":hostName,"p":projectId,"pn":projectName,"k":kind,"s":seq}`. No title, question, result or error text.
- TTL 24 h; urgency `high` for question and approval, `normal` otherwise. A `push-result` of 404 or 410 drops the subscription; other failures are logged and not retried. Pushes are skipped while the relay is disconnected.

### API actions (`/api`, owner UI)
`remote-status`, `remote-pair-start`, `remote-pair-cancel`, `remote-devices`, `remote-revoke` (`deviceId`, `confirm` equal to the device ID), `remote-rename` (`deviceId`, `name`). `remote-pair-start` also returns a QR code SVG of the link, generated on the host (*proposal:* the `qrcode-generator` npm package, no transitive dependencies).

### CLI (`src/cli.ts`)
- `remote enable <relay-origin> [--name <host name>]`: writes the config, creates the host and VAPID keys, prints `hostId` and the exact relay command to allowlist it, installs and bootstraps the LaunchAgent, and tells a running host to start remote mode.
- `remote disable`: stops remote mode in the running host, boots out and deletes the LaunchAgent. Keeps the keys and the device registry, so re-enabling needs no re-pairing.
- `remote status`: config, relay connection, devices, LaunchAgent state.
- When remote mode is enabled, `ensureHost()` starts the host with `launchctl kickstart gui/<uid>/<label>` instead of spawning it, so launchd owns the single instance.

### LaunchAgent and power
- Label `dev.pi-projects.host.<first 8 hex of SHA-256(home)>`, so separate `PI_PROJECTS_HOME`s never collide. `RunAtLoad` true, `KeepAlive` `{SuccessfulExit: false}`, output to `<home>/host.log`, environment `PI_PROJECTS_HOME` and `PI_PROJECTS_HOST=1`.
- While remote mode is on, the host runs `caffeinate -s -w <host pid>`. `-s` only holds while on AC power. It ends when remote mode is disabled or the host exits.

## Browser client (PWA)

- **Origin.** Everything is served from `https://relay.<domain>`. The bootstrap's own files live at `/`, `/sw.js` and `/boot/*`. A host's UI is opened at `/h/<hostId>/`.
- **Storage.** IndexedDB keeps the device key and the paired hosts (`hostId`, name, relay origin, paired time). Nothing secret goes into `localStorage`, URLs or logs. The pairing link's fragment is removed from the address bar immediately.
- **Tunnel owner.** The page, never the service worker. `tunnel.js` runs in each host UI document, opens the WebSocket, runs the handshake, and serves requests forwarded by the service worker. It reconnects when the page comes back to the foreground; requests in flight fail and the UI's own retry takes over.
- **Service worker.**
  - Caches the bootstrap files.
  - For a host UI navigation, serves the cached host `index.html` with `tunnel.js` injected before the host's scripts, plus a CSP that permits `wss:` to the relay origin.
  - For any other request from a host UI document, forwards it to that document's tunnel over a `MessageChannel` and streams the response back. The host is chosen by the requesting client's URL, so a document can only reach its own host.
  - Caches host static assets by ETag and revalidates them through the tunnel.
  - Handles Web Push and notification clicks (opens `/h/<hostId>/?project=<id>`).
- **First load of a host.** Without a cached host UI, the service worker serves `/boot/host.html`. It opens the tunnel, fetches `/` from the host, stores it, and reloads.
- **Host switcher (`/`).** Paired hosts with online/offline state and `needs` counts from `GET /remote/summary`, one short session per host. Also: Pair (handles `#pair=`), Enable notifications (a user gesture, needed by iOS: one subscription with the relay's `/vapid` key, sent to every paired host through `POST /remote/push`), Forget host.
- **Bootstrap integrity.** The switcher shows the bootstrap fingerprint (SHA-256 over the bootstrap files). The host's Remote access settings and `node relay/relay.ts fingerprint` show the expected value. When the active service worker changes after first install, the switcher shows a persistent warning to compare the fingerprint before using the app. Limitation: this detects a changed bootstrap on the next open; it does not stop a relay that serves malicious code. Only a native client would.

## Inbox UI changes (`web/`)

- Replace the 2 s `refresh()` interval with the `/changes` stream: refresh on `project`, poll notifications on `notices`, and fall back to a 30 s poll while the stream is down. Same behavior locally and remotely.
- Settings → **Remote access**: relay state, host ID, bootstrap fingerprint, **Pair a device** (QR, link, countdown, cancel), device list (name, paired, last seen, rename, revoke with confirmation).
- No other UI behavior changes. Inside the PWA, the UI runs unchanged; the inbox token is empty there, and `src/remote.ts` adds the authorization.

## Relay deployment (owner runs it, not automated)

`relay/deploy/README.md` covers:
1. Creating the `_pirelay` user with no shell or home access.
2. Installing the repo copy and `npm ci` in `relay/`.
3. Loading the LaunchDaemon with `RELAY_PORT` and `RELAY_DATA`.
4. Adding a DNS A record at beget.
5. Adding the nginx server block (TLS, `location /ws` with `Upgrade`/`Connection` headers and `proxy_read_timeout 3600s`, `limit_req`/`limit_conn`).
6. Getting the TLS certificate.
7. Allowlisting each host with `node relay/relay.ts allow <hostId> <name>`.

## Stages

1. **Change push.** `/changes`, static ETags, UI uses the stream with a 30 s fallback poll. Useful locally on its own.
2. **Relay and tunnel.** `relay/`, `src/remote.ts`, bootstrap PWA, QR pairing, device list with revoke, signed device list, HTTP over the tunnel.
3. **Remote host mode.** `remote enable/disable/status`, LaunchAgent, `caffeinate`, host switcher with online state.
4. **Web Push.** Telegram is already configured per host (`<home>/telegram.json`), so the per-host switch exists today and needs no new work.
5. **Later, not in this change.** Pairing approval from an existing device; merged inbox (first HQ step).

### Stage 2 done criteria (owner-run, in a disposable `PI_PROJECTS_HOME`, never the production home)
- An iPhone on cellular with its usual VPN on pairs the PWA with the home Mac host, answers a question, and watches the live stream.
- Revoking that device cuts it off on its next request, and the relay closes its channel.
- nginx and relay logs contain no plaintext payload, project name or device name.
- The same flow works with the work Mac as host, connecting through the corporate VPN.
- Each check is a local red/green run whose artifacts stay local; no new committed tests.

## Constraints

- Verification is suspended by the owner. Do not run the production host, E2E scripts, model or provider calls, or `launchctl` against the real home. Static checks (`npm run check`, `node --check`) and isolated pure-function runs under `/tmp` are allowed.
- No new committed tests (owner rule).
- No dependencies beyond `ws` in `relay/` and the QR encoder on the host.
- Remote mode is opt-in. A host that never ran `remote enable` behaves exactly as before.

## Out of scope

Native iOS app; Telegram changes; merged multi-host inbox; pairing approval from an existing device; running the relay on a VPS; protecting against an actively malicious relay serving a modified bootstrap (detected, not prevented).
