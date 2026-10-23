# Scoped models, inherited role models and default concurrency: failure cases, written before implementation

Verified by `scripts/scoped-models-e2e.mjs` (isolated host, local fake provider with three models, no real providers).

## Defaults and inheritance
- S1 A new project stores explicit scout/reviewer/worker models, so cycling the coordinator model never moves them.
- S2 `workerCap` defaults to 1, so a fresh project runs one worker at a time.
- S3 A role model cannot be reset to "inherit coordinator"; the schema demands a string.
- S4 A worker admitted after the coordinator model changed still gets the model captured when the project opened.
- S5 A worker thread admitted before the change keeps the model it was admitted with. Cycling must not move it.

## Scoped models
- S6 The picker's scope is only Pi's `enabledModels`; a project cannot narrow it.
- S7 A project scope naming an unknown model, or one without credentials, is saved, then fails later at open or cycle time.
- S8 Clearing the project scope (`null`) does not fall back to Pi's scope.

## Cycling
- S9 Changing the coordinator model requires an idle worker queue and closes and reopens the project runtime, so it aborts nothing but is refused while workers run.
- S10 A model change while a coordinator request is in flight is refused, interrupts or restarts that request, or fails to apply to the next request, including a queued follow-up in another existing chat. The held request must finish once with its original model; the new selection must survive restart.
- S11 After a model change the chats and Main disagree on the model (only the root is reconfigured).
- S12 The new model does not survive a host restart.

## Concurrency
- S13 `projects_worker_control` still offers `parallelism`, a second owner of the worker limit next to the project setting.

## UI
- S14 The coordinator panel has no model control; cycling means opening Settings. Ctrl+P must also work outside the composer, and repeated cycling must preserve the focused field, draft and selection. Open dialogs must not cycle the project model.
- S15 Settings has three always-explicit role pickers with no "inherit" choice and no scope editor.

## Review findings
- S16 The inherited scope is read with the host's working directory instead of the selected project's workspace, so another checkout's Pi settings decide what a project cycles through.
- S17 An empty scope override is accepted by the schema, dropped by the settings update and treated as "no models" by the picker: three meanings for one value.
- S18 A configured scope (project or Pi) whose models are all unavailable silently falls back to cycling every configured model, so the owner leaves the scope they set.
- S19 The worker limit can only change with an idle project (or through the agent-facing parallelism action that is gone), so the owner cannot raise or lower it while workers run.
