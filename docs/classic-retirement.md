# Classic inbox retirement (2026-11-04)

Owner decision: the classic inbox (`web/` before this change) is removed and the UI 2.0 client is the only inbox, served at `/`.
Old `/ui2/` links answer `308` to the same place at the root (`/ui2/?q` → `/?q`, `/ui2/<asset>` → `/<asset>`, `/ui2/boot.js` →
`/theme.js`); anything else under `/ui2/` is `404`. Serving rules and their tests: `scripts/ui2-web-failures.md` S1–S8.

## Flows that only the classic inbox had

| Flow | Now |
| --- | --- |
| Cursor sign-in | Settings → Providers, **Connect Cursor** (`scripts/limits-manual-failures.md` M26–M29). |
| Telegram bot token, pairing, unpair, remove | Settings → Notifications (`scripts/telegram-failures.md` 43–45). |
| New project | Host agent (`\`) or `npm run projects -- create <name> <workspace>`. No form yet. |
| Webhook URL, secret, Rotate, event chat | `automation-snapshot` / `automation-update` / `webhook-rotate` through the Host agent (a rotate asks the owner) or the CLI RPC. The Automations card only switches it on and off. |
| Remote access: pairing a new device, rename, revoke, remote-app host label and Hosts link | Settings → Remote access and the top bar (`scripts/remote-settings-failures.md` R1–R10). |
| Deploy button, deploy window edit | `npm run projects -- deploy`; the Host agent prepares it (Deploy needs the owner's approval). Settings → Deploy is read only. |
| Desktop notifications while the tab is hidden | Not available (UI2 only asks for permission). |
| Composer uploads, upload viewer | Not available in the browser; the `upload-*` RPCs and the coordinator's search tools are unchanged. |
| Per-project worker quota fallback picker, Coordinator `gh` access select, verification settings | Not in the browser; `settings-update` or the Host agent. |
| MCP per-profile picker and probe button | Not in the browser; `settings-update` (`mcp`) and `mcp-probe`. |
| Plugin web UI (script/style a plugin registers) | Not loaded by the new client. |

## Tests

Scripts that drove the classic DOM were sorted by contract: the backend contract is kept (the UI step becomes the RPC it called,
or the check moves to the inbox at `/`); checks of classic-only presentation are dropped. Deleted scripts tested only classic
presentation whose behaviour is covered elsewhere.

| Script | Disposition |
| --- | --- |
| `coordinator-gh-ui-e2e` | Kept: default and saved value through `settings-update`; the classic select is gone. |
| `worker-quota-settings-ui-e2e` | Deleted: classic fallback picker only; `worker-quota-e2e` covers the backend. |
| `webhook-e2e` | Kept: W1–W13 unchanged, W3 through `webhook-rotate`, W15 on the inbox at `/`; W14 (classic card) retired. |
| Verify journeys `message-coordinator`, `jobs` | Ported to the inbox at `/`. |
| Verify journeys `verification-settings`, `quota-settings` | Deleted with their feature files (classic settings dialog). |
| `codemode-native-tools-e2e` | Kept: N13 reads the live codemode row of the inbox at `/`. |
| `mcp-e2e` | Kept: profiles saved through `settings-update`; F21's classic picker checks retired. |
| `chat-questions-e2e` | Ported to the inbox at `/`; classic-only cases listed in `chat-questions-failures.md`. Known: primary-button contrast (Q15). |
| `scoped-models-e2e` | Kept: S15 over `settings-update`; S14 (composer model button, Ctrl+P) retired. |
| `settings-dialogs-e2e` | Kept as host contracts (picker catalog, only-changed writes, stale revision, unconfigured model). Dialog checks retired. |
| `settings-polish-e2e` | Deleted: classic Settings presentation only (section nav, bulk pickers). |
| `vcs-plugins-e2e` | Kept; the browser step checks the inbox's Pull requests panel. Classic PR card, `#` menu and banners retired. |
| `scoped-model-environment-e2e` | Kept: host checks; classic model picker steps retired. |
| `streaming-follow-intent-e2e` | Ported to the inbox at `/`; found and fixed a follow-intent regression (F2). |
| `streaming-reveal-e2e` | Ported (S6, S7, S9, S10); classic paced fade-in (S1-S5, S8) retired. |
| `streaming-scroll-viewport-e2e` | Rewritten for the inbox at `/`; found and fixed two anchoring defects (R1 sliding window, R2 selection). |
| `theme-e2e` | Rewritten for the inbox at `/` (host ui document); known shell low contrast recorded. |
| `browser-notify-e2e` | Kept as host notify-feed checks; classic page notifications retired (gap: the new client asks for permission but never notifies). |
| `context-settings-e2e` | Ported to Settings → Context; classic card summary and context ring retired. |
| `transcript-compaction-e2e` | Ported; found and fixed a chat-switch empty-transcript bug (T13). |
| `github-quick-ui-e2e` | Kept over RPC (U0, U4, U7); classic Owner setup stepper/dialog (U1-U3, U5, U6) retired. Gap: no browser control to reconnect GitHub after a revoke. |
| `projects-chat-md-e2e` | Ported: render at /, token stripped, fresh tab stays signed in, NEW no-token/wrong-token sign-in checks, tree switch, / hotkey, Enter/Shift+Enter, Markdown XSS. Classic tabs/Owner setup retired. |
| `artifacts-e2e` | Ported chat media to /; A16 inline video player and A21 artifact browser retired (gaps); listing over RPC. |
| `coordinator-github-skills-e2e` | Ported (was failing at base); G7 human labels retired for terminal rows; skill menu retired. |
| `github-pr-watch-e2e` | Browser part reduced to #prs list + escaping; watch-by-URL over RPC; classic toggles/hide/# menu/contrast retired (gaps). |
| `worktree-lifecycle-e2e` | RPC only now (W5/K7/C9 over settings-update, worktrees-snapshot, worktrees-cleanup); classic Settings worktree card retired (gap). |
| `follow-prs-e2e` | Opt-in via Settings→Automations Follow PRs switch; F11 on #feed; event chat/cadence/autofix/Check now/fix list over RPC (gaps). |
| `skills-scale-chats-e2e` | Ported: F17 tree needs-dot, F18 tree at 390px; F6 skills picker and Observability tab retired (catalog/usage over RPC). GAP: no skill-profile picker in UI2. |
| `coordinator-workers-ui-e2e` | Ported to #workers/#feed/#live-turn; dismiss over RPC (gap: no Dismiss button); S3 via scroll, no Jump to latest. |
| `coordinator-live-e2e` | Ported to #live-turn/#feed/tree/Memory node; FIXED: agent knowledge writes now publish the knowledge topic (open Memory went stale). |
| `coordinator-stability-e2e` | Ported; FIXED gap: UI2 showed no failed-turn error or Retry; added .turn-failure row with Retry (S4-S6, S10); S9/S11 dismiss retired; S7/S8 status line ctx. |
| `live-chain-e2e` | Ported (was failing at base): #feed/#live-turn/status bar activity; KT4 via Memory; O1/KT1-3 rail tree and LC6 retired. |
| `multi-chat-e2e` | Ported: #tree chats, #feed/#live-turn, /name rename; archive via RPC; drafts and tab strip retired; gap: tree working dot lags for streaming background chat. |
| `search-ui-e2e` | Ported to the ⌘K palette (#palette): S4/S6/S11/S12/S13 in browser, search over RPC; gap: hits do not navigate (S7-S10 retired until built). |
| `settings-prompts-refresh-e2e` | Ported: F1 on Settings → Prompt blocks after restart; F4-F6/S8 over RPC; classic per-role editor races F2/F3/F7-F11 retired. |
| `skill-profiles-e2e` | Ported: profiles via settings-update; S19 on #slash-menu; classic picker S17/S20 retired (gap: no picker). |
| `status-dots-e2e` | Ported (was failing at base): #tree dots/unread/head dots, #workers → worker view, 390px; D3/S3/W1/V2b/V3 retired; limits bar → ui2-limits-e2e; gaps: worker deep link, machine status. |
| `ui-polish-e2e` | Ported: C1-C5, L1-L3, H2, R2, R3/A1/A2, M1 on #feed/#workers/#focus-view; H1, R1, K1/K2 and worker deep link retired. |
| `uploads-search-e2e` | Ported (was failing at base) to HTTP /upload + RPC; browser removed; K1/K2/K4/C1/C6 retired; gap: no uploads/attachments UI. |
| `worker-artifacts-browser-e2e` | Ported: listing via artifacts-list, worker view inline media/open buttons/XSS/390px; artifact browser F1-F8 and lightbox V1-V9 retired (gap). |
| `worker-chat-ui-e2e` | Ported to #focus-view worker view; fixed UI2 pending worker tool status (red/green); C9/C10-C13/C16/C18 retired. |
| `workspace-defaults-e2e` | Ported: W8 on Settings → General; prompts via settings-update; H1-H4 popover, P2 editor and P9 pointer input retired. |
| `remote-settings-e2e` | New: Settings → Remote access ports classic pairing, rename, revoke and the remote-app Hosts link (R1-R10, fake TLS relay). |

## Gaps found while porting

Left for a later change, each recorded in its script's failures doc: ⌘K palette hits do not navigate; a background chat's tree
working dot waits for the next list read; no worker deep link or history entry; no machine status; no chat archive control; no
artifact browser, inline video or image viewer; no skill-profile picker; no Job Dismiss button; no Jump to latest.
