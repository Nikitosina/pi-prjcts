# PROTOTYPE — Workers card: conversations versus tasks

Throwaway. Delete this folder and the `prototype:workers` script once a variant is chosen.

## Question

The Workers card lists work items but keys context by thread, so one worker conversation with a running task, two
queued follow-ups and two blocked tasks shows five rows at the same 67%. How should the card separate a worker
conversation (one identity, one live context reading, child verifiers or reviewers) from its running, queued and
settled tasks?

## Run

```bash
PI_PROTOTYPE=workers node ui-prototype-workers/serve.mjs   # or: npm run prototype:workers (npm itself hung in the worker sandbox)
open http://127.0.0.1:4799/?variant=A  # or B, C; PORT=… to change the port
```

Loopback only. The page uses the real `web/index.html` and `web/styles.css`, but `app.js` is replaced by `proto.js`
with a fixed anonymized fixture, so the surrounding chrome is static. Loading the real app with a stubbed host API would
take far longer than the variants themselves. Without `PI_PROTOTYPE=workers` the server refuses to start. The production
host serves only its own `web/` asset list, so nothing here can reach production. Switch variants with the bottom bar or
←/→; arrow keys inside inputs, textareas and contenteditable elements are not intercepted.

Fixture: fictional, in memory, reset on reload. Every conversation name, task title, failure reason and chat line is
invented; none comes from a real project, incident or commit. Thread IDs are fake. The structure mirrors the reported
case: W1 "Checkout refactor" (worker, 67%, 1 running, 2 queued, 2 blocked), its fresh child verifier V1 (11%), W2
"Search filters" (worker, 31%, 1 running, 1 done) and S1 "Chart library research" (scout, 88%, idle, 1 done).

## Verification status

The first verification attempt of this prototype's work item ended NOT VERIFIED. The worker could not read that persisted
verifier result; the coordinator relayed that the first fixture copied real incident task titles, a real PR number and a commit-like reference. The fixture was
then made fictional. Worker browser proof (screenshots and receipts) lives outside the repository in the worker's
artifacts folder; it is not independent verification.

## Variants

- **A — Conversation tree.** One node per conversation with its identity chip, role, thread and the only context ring.
  Below it are Now, Up next (numbered, dashed) and a collapsible History with blocked counts. The verifier is a nested
  node with its own ring.
- **B — Queue lanes.** Task-first: Running, Up next, Needs attention and Done lanes across all conversations. Each card
  carries a colored conversation chip. Context appears only in a strip of conversation chips at the top.
- **C — Conversation summary + timeline.** One compact line per conversation showing its current task, counts and ring.
  Expanding a line shows a vertical timeline with history above, the running task highlighted and the queue (dashed)
  below.

Every variant also needs readable task titles. The fixture uses hand-written titles. A real version would need to
derive a title rather than clip `## Goal …` text.

## Verdict

Awaiting owner choice.
