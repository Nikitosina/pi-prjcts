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
13. A read or a write that failed because the connection dropped waits for the reconnect and runs again, or a write is retried. Since the owner's decision of 2026-11-27 (REMOTE_SPEC.md, decision 14) nothing is replayed: a read fails at once with a connection error (stage 4 answers it from the offline copy), a write says its result is unknown and is never resent, and the view reads again after the reconnect.
14. Images, media and downloads of a remote project are requested by URL from the local origin. They go through that host's tunnel and show as `blob:` URLs.
15. A large artifact download starves `/changes` or `/api` of the same host. Flow control of the tunnel keeps other requests answering.

Settings and Host agent
16. The host switcher in Settings or the Host agent sends a change to a host other than the one shown. After a switch, every read and write goes to the newly selected host, and a late answer from the previous host is dropped.
17. Pairing, renaming or revoking devices is offered for a remote host. It stays local to each host.
18. A dropped local path is attached to a remote project's message. It is refused with a clear note.

20. A taken inbox port prevents the backend, its socket or workers from starting, or starts remote transport against another process's listener. The host logs and reports the occupied port to inbox launch requests, retries only that port about every 30 seconds, and starts remote transport only after binding it.

No remote hosts
19. A host with no remote hosts configured behaves and looks exactly as before: no tunnel, no relay connection, no new sidebar rows.

# Stage 3: one sidebar grouped by host and a shared Decision inbox

Written before the code. Design: `REMOTE_SPEC.md`, Multi-host inbox, decisions 5 to 7. E2E: `scripts/multi-host-e2e.mjs` (the client host, two remote private hosts in temporary homes, a third paired identity served by `scripts/lib/inbox-version-peer.mjs` for "needs update", a local relay from `relay/`, the fake provider, headless Chrome on the client host's inbox).

Selection and routing
21. A project or chat listed under one host opens bound to another host's client: a read or write for a remote project reaches the local host, or the reverse. Every project read and write goes to the host that listed the project, chosen by the project, never by whichever host was selected last.
22. Selecting a project of another host keeps the previous host's `/changes` or `/live` stream feeding the view, redirects a request already in flight, or renders a late answer from the previous host. The old streams stop, an in-flight request finishes on its own host, and the selection generation drops its answer.
23. Settings or the Host agent act on the selected project's host instead of the host chosen in their own header, or project sections of Settings act on the Settings host instead of the project's host.

Sidebar groups
24. Groups come in the wrong order, mix projects of two hosts, or one host's failing list hides another host's group. The local host comes first, remote hosts follow in their saved order, and each group loads and fails on its own.
25. A slow or offline remote host delays the local group or the first selection. The local group draws at once; a remote group shows "connecting" until its first tunnel attempt ends.
26. An offline, revoked, "not paired" or "needs update" host shows its last projects as usable, or blocks the page. It collapses to one row with its state; its projects and Decision inbox items leave the page until it is online again (stage 4: an offline host shows its read cache).
27. A host going offline or coming back shows only after a page reload. Its state change redraws its group; when it comes back, its projects, approvals and questions reload, its host stream reopens, and a selected project of that host reloads its view.
28. Remote names, project names or chat titles render as markup in a group header, a row or a menu. They are escaped text.

Decision inbox
29. A question or approval of host B is answered or decided on host A, or an approval decision is sent twice. Each item carries its host; its answer or decision goes to that host only, once.
30. Items show without their host, so two hosts with the same project name cannot be told apart.
31. A new question or approval on a remote host appears only after a reload or the 15 s list poll. The `notices`, `approvals` and `projects` frames of each host's own change stream reload that host's items.
32. Items or counts of an offline host still show in the Decision inbox or the status pill.
33. A remote host whose `list` answer has no question titles (an older host of the same API version) breaks the Decision inbox. Its questions show as a count for the project.

Switchers and Forget
34. The global top-bar switcher stays, or Forget host overlaps the host selector. Settings and the Host agent have a switcher in their own header; Forget host lives in that host's group menu.
35. Forget host leaves its group, its items or the selection on the forgotten host in this tab or another open tab. The group and its items go without a reload, and a selected project of that host gives way to the first local project.

No remote hosts
36. With no remote hosts the sidebar shows group headers or a Decision inbox, the top bar changes, or a tunnel opens. It looks the same as before (the stored pre-stage screenshot) and opens no relay connection.

New project
37. With remote hosts the top "New project" button creates on an unclear host, or the group menu creates on the selected project's host. Each group's menu says "New project on <host>" and creates through that host's client only; the top button is hidden only while remote hosts exist.

# Stage 4: offline read cache

Written before the code. Design: `REMOTE_SPEC.md`, Multi-host inbox, decision 13. E2E: `scripts/offline-cache-e2e.mjs` (the client host, one remote private host in a temporary home, a local relay from `relay/`, the fake provider, headless Chrome on the client host's inbox at 1440 px and 390 px). The cache is `web/host-cache.js` (IndexedDB `pi-host-cache` of the local origin) and is used only by remote host clients in `web/api.js`.

Browsing
38. An offline host's group collapses to one empty row, or its open chat goes blank, although its projects, chats and transcripts were loaded before. They stay browsable from the cache: the group lists its cached projects, a chat shows its cached transcript.
39. Cached data looks live. Every offline view says "Offline copy" and "data from HH:MM" (the time the shown read was saved), in the group and above the chat.
40. A view that was never loaded shows an empty chat, an endless spinner or only a toast. It says it was never loaded while the host was online.
41. The cache answers for a host whose state is not "offline" (revoked, "not paired", "needs update", forgotten), or while it is online, so stale data hides live data.
42. Cached projects count as live: the status pill, Decision inbox or palette show the offline host's questions, approvals or working state. They stay out of every count and the Decision inbox, as in stage 3.

Writes
43. A write works while the host is offline: send, answer, approve, archive, New chat, New project, plugin buttons, Stop, memory edits. Each control is disabled with a short reason; the client also refuses any write without sending a request.
44. A refused write is queued and sent when the host returns, or the draft is lost. Nothing is queued; the host receives no request of it after the reconnect.
45. A write's answer or an action that is not a read is cached, or a read of `approvals-list` shows pending approvals of an offline host.

Reconnect
46. The host comes back and the page keeps the old copy until a reload, or a late cache write overwrites newer live data. Live reads replace the cache on their own, the offline marker goes away and the writes are enabled again, without a reload.

Isolation and limits
47. Two hosts list a project with the same id and one shows the other's transcript. Every entry belongs to one host ID and is read back only with that ID.
48. The cache grows without bound, or eviction removes the newest data or other hosts' data. Each host has a size limit; going over it removes that host's oldest saved reads first.
49. Forget host or a revoked device leaves the host's cache behind, or an answer that arrives after the wipe fills it again. Forget (this tab or another) and revocation delete every entry of that host and nothing of the others; a closed cache stores nothing.
50. IndexedDB is unavailable or fails: live use is unaffected, and offline views say they were never loaded.

Local host and no remote hosts
51. The local host's reads are cached, or the cache database is opened with no remote hosts. The local host is not cached (it serves the inbox itself). A page with no remote hosts never opens the database and looks and behaves exactly as before.

Review repairs of stage 4
52. A revoked, not paired or "needs update" host keeps its projects, and its transcript stays on screen as if it were current, without a warning. Such a host gives up its projects and an open view of it closes.
53. The wipe only holds in the tab that ran it: another tab (revocation is not announced to other tabs) commits a pending save afterwards, a failed deletion is reported as success, and entries that survive it read back after a reload. A wipe leaves a tombstone in IndexedDB: a save whose read began before it is dropped, an entry saved before it is never read back, a failed deletion is reported, and every tab learns of a revocation.
54. The cache answers a read while the host comes back or is revoked during the cache read, and the caller shows the copy as live. The state is checked again after the cache read and the read then goes to the host.
55. After a reconnect an open Memory document, worker view or review keeps its cached text with the banner gone and Edit enabled. The views are read again when the host is back, and a view stays marked as a copy, with its controls disabled, until its own read returned live data.
56. A read that was in flight when the host dropped waits for the reconnect, and later reads queue behind it, so a cached chat cannot open while the host is away. A read of a host that goes offline falls back to the cache at once. A read with no saved copy fails at once as never loaded and is not replayed (69).
57. The size limit counts string length, not bytes, and leaves out the keys. It counts the UTF-8 bytes of the stored text and of the keys in both stores.
58. A control rendered in the transcript feed (a failed turn's Retry, starters, undo) stays enabled while the host is offline and starts the send flow. Every control of the feed that writes is disabled with the reason.
59. The banner's time is the time of another read than the one on screen (a Memory document shows the time of the memory list). The banner shows the time of the read that is displayed.

Second review of stage 4
60. A reconnect replaces a view that has unsaved input: the Memory editor shows "Loading…" and the typed text is lost. A view with a draft (a Memory edit, a review comment, a worker message) is not replaced by the refresh when the host is back; its draft stays and it is usable again.
61. Revoking, un-pairing or "needs update" of the host of Settings and the Host agent leaves the panel on screen with the old data and enabled controls. Like Forget, those states return the page to the local host.
62. A wipe on a page whose database does not exist yet writes no tombstone, so another tab's first in-flight save lands after it. A wipe always writes the tombstone, and the database never blocks its own deletion (`versionchange` closes it).
63. The offline marker and "data from" time belong to an action, not to the answer on screen: a losing live read of another chat can turn a cached chat live, or give it another chat's time. Origin (live or a copy) and time belong to the answer object itself (`provenance`); a view is live only when the data it rendered came from a live read.
64. A chat read that never gets an answer (an uncached chat in flight when the host dropped) holds up every later selection, even of a cached chat or a local one. A selection of another chat or host never waits for another read.
65. A write flow that first awaits a read (Archive's check that the chat is idle) runs its write after a reconnect, replayed from a read that was stuck. A read that gates a write never answers from a copy, and fails at once when the host goes offline, so the write never runs; 72 extends this to a host that went offline and came back.
66. Pending sends, their saved recovery handles and restored drafts are keyed by project and chat only: a failed send of one host shows under another host's chat with the same ids, and Retry goes through the selected host. They carry the host ID, are shown only in that host's chat, and Retry goes to the host that owns the message.
67. A slower, older answer of one read replaces a newer saved answer of the same read. A save keeps the newest read.
68. A page with no remote hosts installs the offline banner and a mutation observer. Neither exists until a remote host or a remote Settings host does.

Third review of stage 4: reads are no longer replayed (REMOTE_SPEC.md decision 14, owner decision of 2026-11-27)
69. A read in flight when a remote host drops waits for the reconnect and is replayed, and its continuation then writes, renders or unlocks something without a new owner action. Every unfinished read of an offline host settles at once, from the offline copy or with an error, and is never resent.
70. The reads after a reconnect replace a view that has unsaved input, or a late or second answer overwrites an editor the owner started typing in (a view that was still Loading at the drop included). Each view reads again through one path, a view with unsaved input is refreshed only in the background, and every render has a token so only the newest read draws it.
71. Controls unlock when the host is back, not when the view's own live read returned: Settings and the Host agent show an offline copy as live, and the banner ignores the panel on screen. A panel stays locked until its own repaint after the reconnect read live data, and the banner follows the visible view.
72. A read that gates a write (Settings tool toggle `profiles-get` before `profiles-set`, Settings update, the UI revision retry `ui-get` before `ui-set`, Archive) continues into its write after an offline period. The read fails at once when the host drops and the write is refused when the host went offline since the flow began, even if it is back.
73. Opening a PR review offline sends `pr-review-open` with `seen: true` (a write), or a reconnect sends it without a click. Offline shows the cached review and marks nothing; reconnect reads with `seen: false`.
74. The composer draft is one text for the whole page and follows every switch of chat, project or host, or is lost on reload. A draft belongs to one host, project and chat, comes back when its chat returns, survives a reload, is cleared by sending, archiving or deleting the chat, Forget host and revocation; the Host agent composer keeps one draft per host; empty drafts are not stored and the total is capped.
75. A recovery handle of an unsent message without a host ID is treated as local although it may belong to a remote host. It is quarantined and never routed.
76. A host that was already revoked, not paired or needs update when the page starts still opens its Settings or Host agent. The page redirects to the local host as it does for a later revocation.
77. Two reads of one host that start in the same millisecond tie and an older answer replaces a newer one. Reads, saves and the tombstone use one monotonic sequence.

## Fourth review of stage 4 (input loss; checked by `input-loss-e2e`, red on fa82619 before the fixes)

78. Rule A: an idle tab erases another tab's draft. Two tabs show the same empty composer; the one that never edited it saved its empty field on chat switch, reload or `pagehide`, deleting the stored draft. A tab now writes a draft only after it changed it in this tab (an `input` event or an authoritative restore), for the chat composer and the Host agent composer.
79. An offline chat snapshot deletes a newer chat's draft. The cached `show` chat list lacks a later sibling, which was treated as archived and emitted `chat-gone`. Only a live list or a confirmed archive removes a draft; a copy neither deletes nor replaces the remembered list.
80. A late Memory read replaces a worker editor. Only Memory renders claimed the focus root. Every focus switch (`renderFocus`, `showChat`) now claims it, so an earlier render is discarded whatever the view.
81. A focus switch to a review or worker view while a read of the previous view is pending shows the old answer (same token as 80).
82. An interrupted read is replayed. A call interrupted while waiting for the cache (a drop and reconnect inside the wait) was still sent after the host returned. It now settles at once with the copy or an offline error; only the view's new read reaches the host.
83. A PR review opened online has no offline copy. The online open uses `seen: true`, which bypassed the cache, and the offline open asks `seen: false`, which had no entry. The answer of an online open is now saved under the read-only key.
84. Rule B: a reconnect discards unsaved Settings fields. Only tier edits were tracked. Every Settings section now marks its body dirty on `input`; a dirty body is never redrawn, and a late read only unlocks the panel. The focus view works the same way.
85. Controls unlock before the view's own live refresh. A chat shown when the connection dropped kept `live: true` from the previous connection. An answer counts as fresh only for the connection period (`epoch`) it was read in.
86. A save that began before another tab's wipe lands after it. The tab-local counter cannot order across tabs. The order is a per-host counter in IndexedDB, advanced in the same transaction that begins a read, saves or wipes (with a wipe generation).
87. Two tabs tie on the same stamp and the strict comparison accepted it. The shared counter gives each read a distinct order, so the older read never replaces the newer.

## Fifth review of stage 4 (simplified: drafts write on input and send only; the host is read-only as one unit)

88. A tab that sent, then closed, erased a newer draft typed in another tab, and a sent text could come back. Drafts are written only by an `input` event and removed after a send only while the stored text still equals the sent text; nothing is written on `pagehide`, chat switch or reload.
89. A new worker, review or Memory view of a reconnected host is writable before its own read. The host unlocks as one unit, only when every open view (chat, focus view, Settings, Host agent) has a successful live read in the current connection period; a render or a `finally` proves nothing.
90. A queued write crosses a disconnect (settings `ui-set`, Host agent settings, review mark-seen). Each write takes the connection epoch at the click and is refused when it changed.
91. The dirty mark stays after Cancel in Memory, so a quiet read never reaches the displayed entry and its edit revision.
92. A late Memory save answer repaints the shared focus root over another view. The continuation checks the focus token too.
93. An event handler that throws is swallowed by the event bus; it now rethrows so page error checks see it.
94. A PR open that marks seen takes its cache-order token after the response; it now takes it before the request.

## Sixth review of stage 4 (one lock for every write; no draft deleted by navigation)

95. A refused message loses its last durable copy: its recovery handle goes when the text returns to the composer, and leaving the chat then deleted the stored draft. The text is saved as a stored draft when it returns, and a chat switch deletes nothing; only a successful send, Dismiss, an emptied field, a confirmed archive or delete, Forget host or a revocation deletes a draft (`scripts/chat-pending-e2e.mjs`, P11).
96. The sidebar (New chat, Archive, Needs-you Approve and Deny) wrote while the host was read-only. The host client refuses every write while the host is locked (`host.locked()`), whatever control sent it, and the sidebar and decision rows freeze with the host.
97. A read retry control (Host agent Try again, Memory Retry) was disabled with the host, so a failed read could never recover. Read retries and Settings profile tabs are on the read allowlist.
98. The Prompt section on its Host agent tab was credited to, and locked by, the project's host. It follows the Settings host.
99. General Settings stayed marked unsaved after a successful save. A confirmed save clears the mark in every section.
100. An HTTP error from the host counted as a live read and unlocked a view that had no fresh data. Only a successful live answer counts.
101. A PR open or Providers visibility save waited for the cache token across a disconnect and then sent on the new connection. The epoch and the lock are rechecked right before sending, and the Providers queue captures the epoch at the click (the Providers capture has no E2E: that section is Settings-host data and the test page's Settings host is local).
102. Reserved.
103. A send removed a draft that differed only in whitespace. The comparison is exact; the handle keeps the composer's exact value.
