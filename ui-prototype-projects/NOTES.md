# PROTOTYPE — Projects layouts with observability

Question: what should replace the single-column decision inbox, moving toward a
Claude/Cursor "Projects" feel with observability tabs?

Sample data only (`data.js`). No host, token, socket or model calls. Approve
buttons open a consent dialog (Cancel default, unchecked acknowledgement) and
mutate in-memory state only. Reload resets.

```bash
open /Users/nikitarat/.pi/agent/projects-mvp/ui-prototype-projects/index.html
```

`?variant=claude|cursor|mission`, bottom switcher, or ←/→.

- **A claude** — project sidebar, project header, tabs Chats · Knowledge · Activity · Observability · Settings. Chats tab = big composer, "Needs you", chat list, knowledge side card.
- **B cursor** — dark three-pane: agents grouped by state, transcript with collapsible tool calls + steer composer, inspector (Changes/Evidence/Approvals/Context), bottom dock (Events/Timeline/Trace/Usage/Health).
- **C mission** — top tabs Overview · Threads · Knowledge · Observability · Automations · Setup. Overview = KPIs, needs-you, Gantt, pipeline, usage, health.

Owner setup as a guided stepper (replacing JSON editors) appears in A Settings and C Setup.

`shots/` = headless Chrome renders of the initial state, not runtime evidence.

## Verdict

Owner picked **A (Claude-style project home)** with changes:
- Coordinator conversation is the default project view (tab "Coordinator").
  Side column: Needs you, Workers (click → worker chat), knowledge summary.
- Worker chat: transcript + steer composer, right panel Changes/Evidence (from B).
- Observability adds the trace tree (from B).
- Settings → Automations shows a per-routine run-history strip (from C).
Backend for chat: `message` + `thread-history`; steering via `control` with confirmation.

## Folded into web/ (2026-10-06)

`web/` now uses layout A on existing APIs only. Previous inbox kept in `web-legacy-inbox/` (not served) until owner approval.
Not yet built (needs backend): worker timeline, event log, tool calls in thread history, usage over time, per-worker diff panel, guided owner-setup forms (still opens existing JSON dialog).
Startup + browser check: `artifacts/projects-home-ui-20261006T111406-retry-3/` (attempts 0-2 retained with their failures).
