# Durable runtime failures

## Quiet coordinator handoffs

Test seam: actual model requests emitted by `openDurableProject`, using the existing private fake provider in `durable-runtime-e2e.mjs`.

- A coordinator request omits the rule to end after asking for an owner decision and sends acknowledgment-only messages that reopen workers.
- A coordinator receives compact handbacks without instructions for retrieving full evidence before accepting work.
- An independent worker has no checkpoint instruction and labels an unfinished stage Ready to avoid failure.
- A worker repeats its structured report in its closing answer rather than leaving full evidence available on demand.

These checks prove instruction delivery, not compliance by a real model. Jobs engine and browser tests cover deterministic delivery, checkpoint approval refusal and presentation separately.

## Deployment quiescence and failed follow-ups

- A paused helper retains its running Job and agent identity for resume, but blocks deployment after all owned tasks and submissions drain.
- Paused=true alone admits deployment while an abort handler or agent preparation is still draining.
- Queued owner input is mistaken for idle because the selected coordinator has no placed input.
- A terminal model failure leaves a queued owner follow-up parked forever rather than advancing it; the failed input must remain failed, not replayed.
- R1 A Durable report says only the error text. The host log cannot tell a faulted or parked task from a hook or host-callback error, or name the extension, task kind, task or conversation, so a stuck chat cannot be traced. Each report must carry that metadata from Durable's `ReportInfo`, and nothing else: no prompts, tool arguments or outputs.
- R2 There is no local record of how long Durable phases take or how often they back off, so slow turns and retry storms cannot be told apart. The runtime must keep Durable's own metrics (phase duration by task, phase and outcome; reports by type; active tasks) in memory, bounded by a fixed number of series, with metadata only: no prompts, arguments, outputs or error text, no exporter and no network.
- R3 When a chat or worker seems stuck, nothing shows which Durable tasks are live, which task owns which, what each waits on, or which are parked or blocked, so the owner must read SQLite. `host-health` must include a read-only, bounded view of Durable's task graph (id, kind, conversation, owner, status, phase, what it waits on, blocked reason) and the recent report metadata from R1, without prompts, arguments, outputs or error text. It adds no retry, abort or other action. R1 to R3 are verified by `durable-runtime-e2e.mjs`; R2 and R3 also through the host API by `observability-backend-e2e.mjs` and `observability-host-e2e.mjs`.

Seams: real Harness in jobs-e2e (held abort/prepare and helper identity), private fake provider in durable-runtime-e2e (failed request and queued follow-up). No live home or provider.
