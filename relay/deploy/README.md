# Home Mac relay (owner-run)

The relay is a small Node process behind your existing nginx. It listens only on `127.0.0.1:8790`; nginx exposes HTTPS and WebSocket upgrades on the existing public port 443. Hosts and devices connect out to it. The relay forwards ciphertext and holds no Pi state, device keys, transcripts or repositories. It does hold a VAPID key to deliver host-encrypted Web Push.

These are instructions, not an installer. Nothing here has been deployed or verified on your home Mac. Use an approved disposable Pi Projects home for the first end-to-end checks in `REMOTE_SPEC.md`. Do not restart a production host to try it.

## 1. Prepare an isolated account

Use a dedicated account `_pirelay`, with a primary group of the same name, no login shell and `/var/empty` as its home. In the commands below **399 is a placeholder UID/GID**. First inspect the account directory and choose an unused number for both:

```sh
dscl . -list /Users UniqueID
dscl . -list /Groups PrimaryGroupID
# Only after choosing an unused ID (replace 399 below):
sudo dscl . -create /Groups/_pirelay
sudo dscl . -create /Groups/_pirelay PrimaryGroupID 399
sudo dscl . -create /Users/_pirelay
sudo dscl . -create /Users/_pirelay UniqueID 399
sudo dscl . -create /Users/_pirelay PrimaryGroupID 399
sudo dscl . -create /Users/_pirelay UserShell /usr/bin/false
sudo dscl . -create /Users/_pirelay NFSHomeDirectory /var/empty
sudo dscl . -create /Users/_pirelay IsHidden 1
```

A separate user is not an OS sandbox. A world-readable home or repository remains readable unless permissions deny it. Protect the owner's home explicitly (review existing ACLs first, do not blindly rewrite them):

```sh
ls -lde "$HOME"
chmod +a "user:_pirelay deny read,write,execute" "$HOME"
# This must fail with Permission denied:
sudo -u _pirelay /bin/ls "$HOME/.pi"
```

Repeat the denial for work trees or sensitive directories outside the owner's home. Store the relay code outside every denied directory. Do not give `_pirelay` a password, sudo privileges or membership in the owner's groups. For stronger isolation use a separate machine or VM; this deployment only provides Unix-account isolation.

## 2. Install the relay copy

Use a Node version supporting native TypeScript stripping (Node 22.19+; development uses Node 26). The sample plist uses `/opt/homebrew/bin/node`; replace it with the installed absolute path if different, and check that `_pirelay` can execute it.

From a checkout of the intended revision (set `CHECKOUT` to it):

```sh
CHECKOUT=/absolute/path/to/pi-prjcts
sudo mkdir -p /usr/local/lib/pi-relay
sudo cp -R "$CHECKOUT/relay" /usr/local/lib/pi-relay/
# Do not copy a developer's installed node_modules; dependency installation below is locked.
sudo rm -rf /usr/local/lib/pi-relay/relay/node_modules
cd /usr/local/lib/pi-relay/relay
sudo /opt/homebrew/bin/npm ci --omit=dev --ignore-scripts
sudo chown -R root:wheel /usr/local/lib/pi-relay
sudo chmod -R go-w /usr/local/lib/pi-relay
sudo install -d -o _pirelay -g _pirelay -m 700 /var/db/pi-relay /var/log/pi-relay
```

The copy need only contain `relay/`; it does not need the root package's dependencies. The only relay dependency is `ws`. Bootstrap assets are read into memory at start. Deploy a new revision by replacing the code copy while the relay is stopped, then restart it; otherwise `fingerprint` would describe new files while the process serves old ones.

## 3. DNS and certificate

In beget's DNS settings create an **A record** `relay` pointing at the home Mac's existing public IPv4 address. If your existing domain uses dynamic DNS, make this a CNAME to that record instead. Do not add an AAAA record unless IPv6 routing to nginx actually works.

Obtain a trusted TLS certificate for `relay.your-domain` using your existing certificate renewal setup. DNS-01 validation works without adding a public HTTP listener; HTTP-01 uses the existing nginx port 80 if you already expose it. Preserve automatic renewal. Do not use a self-signed certificate on the phone.

This assumes nginx's public port 443 already reaches the home Mac, as it does for the owner's pet projects. No other public port is needed. A changed home IP, home power loss or a sleeping Mac makes every relayed host unreachable. Keep this relay Mac awake on AC using an owner-approved power setting.

## 4. nginx

Copy `nginx-relay.conf` into nginx's included configuration. Its `limit_*_zone` lines belong in `http {}`, not inside a `server {}`. Replace the domain and certificate paths. Keep any existing projects' server blocks unchanged.

`/ws` forwards WebSocket upgrades, overwrites `X-Forwarded-For` with nginx's actual client IP, disables buffering, and allows idle connections up to one hour (relay pings are sent every 25 seconds). The other location serves bootstrap assets and `/vapid`. All proxying is to loopback. Connection and handshake rate limits apply per IP; several devices behind one VPN exit share these limits.

Run your usual nginx configuration check and reload procedure **only when you approve deployment**. The sample disables access logging and logs only critical nginx errors; check that a global nginx/syslog/APM configuration does not separately capture WebSocket frames or request bodies. Neither pairing secrets (URL fragments) nor ciphertext bodies should be logged. The relay itself logs only connection events, hashed IDs and close codes.

## 5. LaunchDaemon

Edit `dev.pi-projects.relay.plist`: domain, Node path and installed code path. `RELAY_DATA` is private to `_pirelay`; it holds `hosts.json` and `vapid.json` (0600). Keep and protect backups of the VAPID key: replacing it requires renewing each browser push subscription.

```sh
sudo install -o root -g wheel -m 644 dev.pi-projects.relay.plist /Library/LaunchDaemons/dev.pi-projects.relay.plist
# Owner-authorized deployment only:
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.pi-projects.relay.plist
```

The relay binds to loopback, has a 10-second throttle on failed launches, and exits cleanly on SIGTERM. To stop/remove it (owner approval required):

```sh
sudo launchctl bootout system /Library/LaunchDaemons/dev.pi-projects.relay.plist
sudo rm /Library/LaunchDaemons/dev.pi-projects.relay.plist
```

Rotate `/var/log/pi-relay/*.log` using the home Mac's log rotation policy. Do not make the data directory or logs readable by nginx or other users.

## 6. Allowlist each host

On each Pi Projects host, `projects remote enable https://relay.your-domain --name "Home Mac"` prints its host ID (the Ed25519 public key) and allowlist command. Run the latter on the relay Mac using its data directory and dedicated user:

```sh
cd /usr/local/lib/pi-relay/relay
sudo -u _pirelay env RELAY_DATA=/var/db/pi-relay /opt/homebrew/bin/node relay.ts allow HOST_ID "Home Mac"
sudo -u _pirelay env RELAY_DATA=/var/db/pi-relay /opt/homebrew/bin/node relay.ts hosts
# Remove a host:
sudo -u _pirelay env RELAY_DATA=/var/db/pi-relay /opt/homebrew/bin/node relay.ts deny HOST_ID
```

The running relay reads the file at authentication, so new hosts need no restart. Removing an online host closes its session at the next heartbeat (at most 25 seconds), and immediately refuses new authentication. Device revocation instead comes from that host's signed device list and takes effect immediately.

CLI updates to the allowlist are intended for one administrator at a time. Do not run concurrent `allow`/`deny` commands. Pair phones with the QR shown in that host's local inbox. Treat the QR as a credential: it carries a ten-minute, single-use pairing code. The relay forwards binary frames opaquely, including the plaintext, signed handshake messages; it cannot decrypt the subsequent HTTP payloads.

## 7. Fingerprint and first checks

```sh
/opt/homebrew/bin/node /usr/local/lib/pi-relay/relay/relay.ts fingerprint
```

Compare this with the PWA switcher and host's Remote access settings. The algorithm is SHA-256 hex over every regular, non-dot bootstrap file except `*.d.ts`, sorted by served URL. Each contributes its URL, a single LF, then raw file bytes. `index.html` is `/`; `sw.js` and `manifest.webmanifest` stay at root; every other file is `/boot/<name>`. There is no delimiter after the bytes.

This fingerprint is a manual change detector, not code signing: an actively compromised relay could replace both the bootstrap and its displayed fingerprint. The native-client threat is out of scope.

For the owner-approved disposable-home checks, follow `REMOTE_SPEC.md` stage 2 criteria: phone on cellular plus its VPN, pairing, answering, streaming, revocation, checking logs, then the work Mac on its corporate VPN. Deployment success is not proof that the company's network permits WSS, or that exposing work-agent content complies with company policy.
