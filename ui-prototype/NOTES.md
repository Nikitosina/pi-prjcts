# Projects UI trial

Question: which interaction should replace slash commands and raw worker JSON?

Three standalone, throwaway browser variants. They share an in-memory simulated
project. No host requests, files, model calls, or real workers. Reload resets
everything. Switching layouts preserves the scenario so you can compare the
same state. These are interaction prototypes, not implemented Pi screens.

## Open

```bash
open /Users/nikitarat/.pi/agent/projects-mvp/ui-prototype/index.html
```

Use the bottom switcher or left/right arrows outside a text field or dialog.
The URL keeps the variant: `?variant=desk`, `?variant=board`, or
`?variant=inbox`.

## Try the same workflow in each

1. Read the pending locale-scope decision and answer it.
2. Inspect the running worker's transcript. Send a steering message.
3. Inspect the sample E2E evidence. Accept it or request changes.
4. Create a task through the coordinator message box.
5. Click "Finish demo run" to simulate completion. Watch the queued writer start.
6. Open "Scenario state" to see what changed. Reset to compare from the start.

Only one writer runs at a time. Any paths, logs, models, outputs, and timestamps
shown in the page are sample data. Review means accepting a result, not merging
or publishing. No variant implies automatic worktree allocation.

## Different working styles

- **Command desk:** a terminal-shaped workspace with a task list, inspector,
  and pinned coordinator prompt. Control workers without memorizing run IDs.
  Best fit for a full-screen Pi TUI. Dense, but nothing scrolls into chat history.
- **Work board:** tasks in columns, with a side sheet for decisions, evidence,
  and worker control. Drag a task to Running to queue or resume it. Move one to
  Planned to pause it. Other lane changes require their explicit actions.
  Best fit for a browser companion. It makes concurrent work easiest to scan.
- **Decision inbox:** unanswered questions and review requests take priority.
  A compact activity summary replaces constant worker output. Writing a new
  goal remains available, but completed results and decisions drive the page.
  Best fit for a lightweight Pi overlay or browser inbox. Less useful for
  watching every tool call.

The designs deliberately differ in structure, not just colors. A production
implementation would use host events and real artifact links, and validate
actions on the host. Prototype-only controls disappear.

## Verdict

The owner chose Decision inbox. The live implementation is in `web/` and
`src/project-screen.ts`, not this simulated app. It keeps arbitrary coordinator
messaging available, with questions and evidence reviews in the inbox and
conversation available on demand. The master delegates execution and can steer
existing workers. pi-goal-x integration remains deferred.

This directory is the original comparison reference only. Open the live client
through `/projects-inbox` in Pi or `/projects-ui` in the browser.
