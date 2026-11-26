# Failure modes: remote hosts in the local inbox (stage 1, host-aware client)

Written before the code. Design: `REMOTE_SPEC.md`, section Multi-host inbox. E2E: `scripts/remote-hosts-e2e.mjs` (two private hosts in temporary homes, a local relay from `relay/` on loopback, the fake provider, headless Chrome on the client host's inbox; no live host, relay or provider). Later stages add their own sections to this file.

Security
1. The local inbox executes code that came from the relay or a remote host: a script, a stylesheet, an inline handler or an HTML fragment from a remote answer. Every script comes from the local `web/`; remote text is escaped, and the CSP stays `script-src 'self'`.
2. A remote answer reaches the local host's `/api`, or a request meant for one remote host goes to another host or to the local host. Each call carries exactly one host, and the tunnel for host A never sends a request for host B.
3. The welcome of a remote host is verified against a key from the relay or from the answer itself instead of the host ID pinned at pairing. A relay that swaps the host key is refused.
4. The device key is extractable, is stored in `localStorage`, or appears in a URL, a log or the local host's home. It is a non-extractable `CryptoKey` in IndexedDB of the inbox origin.
5. The pairing link or code stays in the address bar, history or the local home after Add host finished or failed.
6. The CSP admits any WebSocket origin. `connect-src` adds only the `wss:` hosts of configured relay origins.

Origin and identity
7. A host restart changes the inbox port, so the origin and the device key are lost and every remote host needs pairing again. The port is fixed and survives restarts; a taken port is reported, not silently replaced.
8. The remote host list is lost on restart, stores secrets, or is edited by a request from a remote host. It lives in the local home, holds only host ID, name and relay origin, and changes only through local owner actions. Known limitation: a lost Add receipt and failed list read can leave an orphan key in IndexedDB. Lost receipts are rare because the local host answers over loopback.
9. Forget host leaves its tunnel open, its list entry or its device key usable for that host. Known limitation: a lost Forget receipt can skip session closure and key deletion; the receipt comes over loopback, so loss is rare. A revoked or incompatible tab has closed its broadcast channel and may miss even a confirmed Forget.

Version
10. A remote host is used before its API version is checked. The first request on each authenticated tunnel is the read-only version action. Only an exact match enables streams, project reads and writes. If the action or version is missing or the version differs, the client closes the tunnel and shows "needs update" without ever showing the host online.
11. A host from before this change (no version reported) is treated as compatible.

Tunnel
12. A dropped relay connection or a remote host restart leaves the host shown online, or stops reconnecting. The state turns offline at once and reconnects with backoff; a revoked device stops retrying and says it was revoked.
13. A read that failed because the connection dropped is shown as a failure without a retry, or a write is retried. Reads retry once the tunnel is back; a write says its result is unknown and is never resent.
14. Images, media and downloads of a remote project are requested by URL from the local origin. They go through that host's tunnel and show as `blob:` URLs.
15. A large artifact download starves `/changes` or `/api` of the same host. Flow control of the tunnel keeps other requests answering.

Settings and Host agent
16. The host switcher in Settings or the Host agent sends a change to a host other than the one shown. After a switch, every read and write goes to the newly selected host, and a late answer from the previous host is dropped.
17. Pairing, renaming or revoking devices is offered for a remote host. It stays local to each host.
18. A dropped local path is attached to a remote project's message. It is refused with a clear note.

20. A taken inbox port prevents the backend, its socket or workers from starting, or starts remote transport against another process's listener. The host logs and reports the occupied port to inbox launch requests, retries only that port about every 30 seconds, and starts remote transport only after binding it.

No remote hosts
19. A host with no remote hosts configured behaves and looks exactly as before: no tunnel, no relay connection, no new sidebar rows.
