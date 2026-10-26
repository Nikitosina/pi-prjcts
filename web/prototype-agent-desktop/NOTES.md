# THROWAWAY — agent desktop coordinator layouts

## Question

How could the existing Pi Projects coordinator feel more like the Pi coding-agent TUI or Hermes Agent desktop, without losing project context, worker state, tool activity, compaction, and owner decisions?

Three structurally different renderings live on the existing coordinator route (`/`) under `?variant=terminal|desktop|dispatch`. The normal app and production host do not load these files. Only the explicit isolated prototype command serves them; there is no production default or production switcher.

## Run

```sh
npm run prototype:agent-desktop
```

Open <http://127.0.0.1:4179/?variant=terminal>. `PORT=4180 npm run prototype:agent-desktop` chooses another port. Stop with Ctrl+C, or `kill <pid>` for the recorded background process.

Current review instance: loopback port **4179**, background task `bg-d5d7f9db`, wrapper PID **48542**. It stays available for this review; clean it up with `kill 48542` (or stop background task `bg-d5d7f9db`). This process is only the prototype server, never the owner's Pi host.

The server binds to loopback and serves only static files. It reuses the real `web/index.html` shell and `web/styles.css`, but replaces `app.js` with the prototype script. Content Security Policy sets `connect-src 'none'` and `form-action 'none'`. There is no token, host socket, persistence, backend dispatch, real mutation, or model call. Message forms and decisions update memory only; all other controls are stubs. Reload resets in-memory changes while `?variant=` remains stable.

## Variants

### A — Pi terminal workbench

A dense, monospaced event stream: user/coordinator turns, tool calls and output, compaction, live command progress, and an owner question share one transcript. A process-tree rail shows workers, context, branch, lease, and latest output. The composer and status line echo coding-agent terminal ergonomics.

**Tradeoff:** strongest operational density and scanability; weakest separation between narrative and machine output. The narrow worker rail disappears on small screens, so mobile relies on the transcript rather than exposing every process detail.

### B — Hermes-inspired desktop

Chat remains primary, with session tabs, a quiet flat transcript, attached Changes/Activity/Context working pane, compact composer, model/token footer, and worker list. It borrows information architecture rather than claiming an exact visual reproduction.

**Tradeoff:** calmer reading and useful chat-plus-preview workflow; more navigation and less status visible at once than A. The working pane disappears on small screens.

### C — Decision-first dispatch

A daily release brief leads. The left agenda ranks owner decisions and work in motion; the center gives one decision room for evidence and choices, with coordinator notes secondary; the right pulse summarizes objective, phase, context, and results. This changes hierarchy rather than re-skinning a chat.

**Tradeoff:** best for owners who supervise rather than pair-program; weakest for following a long technical conversation. The decision detail can hide useful chronology.

## References and assumptions

Researched 2026-11-02 from public upstream files:

- Pi coding-agent / Pi TUI, installed package identity in this repository: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 1.0.2. A uses known terminal conventions from that environment: dense turn/tool stream, command/output lines, compaction marker, token/context/cost footer, and steering composer. It is an interpretation, not a terminal emulator or pixel match.
- Official Hermes desktop: <https://github.com/NousResearch/hermes-agent/tree/main/apps/desktop>. Its `README.md` describes streaming chat, side-by-side previews, file browser, and shared sessions. Its `DESIGN.md` says “Chat is the home surface,” panes are working context, and “Flat, not boxed.” The official `pr-assets/session-source-folders.png` shows the airy light shell, session sidebar, quiet composer, and compact status footer.
- Community Hermes One desktop: <https://github.com/fathah/hermes-desktop>. `previews/chat.png` and `previews/sessions.png` were checked for session tabs, grouped sessions, tool progress, and model/token composer treatment. B does not reproduce its brand or claim exact parity.

Assumptions: the owner wants coordinator supervision more than a general-purpose chat client; decisions, compaction and worker/tool state deserve first-class visibility; the existing project sidebar/header should remain recognizable. Every person, project, timestamp, token count, tool result, diff, worker and status in this prototype is mock content, not runtime evidence.

## Visual inspection

Headless Chrome used a fresh temporary profile against the isolated host. Captures cover all three variants at 1440×1000 and A/B at 800×1100 and 390×844. Browser checks confirmed previous/next switching, arrow-key switching, arrow exclusion in a textarea, URL reload stability, in-memory messages resetting on reload, no production `app.js`, and no API/live/change requests. There were no browser runtime errors. `npm run check` passed. These are mock-layout screenshots, not host-state or real-model proof.

## Verdict

**Pending owner selection.** No variant has been promoted or merged into production. Useful feedback can mix parts (for example A’s tool density with B’s working pane).

## Cleanup plan

After the owner picks a direction, rewrite the chosen ideas in the real coordinator with production data, permissions, streaming and tests. Then delete `web/prototype-agent-desktop/` and the `prototype:agent-desktop` package script. Do not promote these throwaway components directly. Stop the private server before deletion.
