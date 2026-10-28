# Workers conversation tree

The Workers activity tree groups work by conversation and nests verifier conversations beneath their delegated worker. This standalone fixture exercises a real private host and browser with a deterministic provider.

## Sub-features

- The tree shows Now, Up next and History; a conversation has at most one context indicator, not one per work row.
- The fixture creates a delegated worker, a failed verification, a repair and a fresh verifier. It compares verifier parent links, conversation uniqueness and queued follow-up order with the persisted plan.
- It checks History and focus across polling, work-row focus after redraw for Now, a queued follow-up and History, narrow viewport overflow, verifier navigation and browser errors.

## How to get to it (user POV)

Open the project coordinator view, select a worker in the Workers activity area, send follow-ups, close the inline thread and choose All work. Expand History and select a nested verifier to open its conversation. The fixture identifies conversations with `#activity [data-conversation="<threadId>"]`, headers with `.worker-line`, children with `.work-children`, tasks with `.conversation-task`, and the inline composer with `[data-inline-thread-send]`.

## Driving it with browser CDP

`verify.mjs drive` does not support this journey. Audit `scripts/workers-conversation-tree-e2e.mjs` and proof-defining changes against the assigned candidate before running its standalone scripted journey. From the candidate root, with a fresh evidence directory:

```sh
mkdir "$PI_ARTIFACTS_DIR/tree-recipe"
VERIFY_LOOP_EVIDENCE="$PI_ARTIFACTS_DIR/tree-recipe" E2E_SHOTS=1 node scripts/workers-conversation-tree-e2e.mjs
```

Preserve the command's original exit status. Inspect `result.json`, `dom.json`, `plan.json`, `host.log`, `chrome.log` and the light, dark and narrow screenshots. Compare the DOM conversation IDs and queue text with plan work IDs, thread IDs, parent thread IDs and queue order; inspect the provider requests recorded in `result.json`. An exit code alone is not proof. Copied author screenshots remain author evidence, not independent screenshots.

## Gotchas

- Require the pinned candidate and unchanged proof script, dependencies and Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Clear `NODE_OPTIONS` and `PI_PACKAGE_DIR`. The script creates a disposable HOME, project, agent directory, socket and loopback provider. It uses its own fake provider to delegate and verify; the ordinary echo seed never calls tools and cannot supply the worker/verifier relation. Never use production host or fixture writes.
- Acquire the agreed advisory Chrome lease before running and release it after owned processes settle. Capture exact owned host, browser and provider PID/start-time and settlement records before cleanup or any source revision switch, where available. The provider runs in the script process. The script cleans its scratch root on success; failed scratch is retained. Its cleanup does not itself record Chrome or provider settlement before deleting scratch, so do not claim complete contemporaneous settlement proof from its exit alone. Stop only processes identified as owned, never broad name matches. If isolation, ownership or evidence cannot be established, report a blocker rather than substitute a weaker journey.
- This script does not explicitly establish all terminal states, archive, empty-state or accessibility behavior. Report these as untested or perform separately authorized manual checks. The two screenshots and narrow screenshot are views of the same fixture, not proof of every state.
- A fake-provider lifecycle pass is not live-model judgment, original UI acceptance or host VERIFIED. Preserve exhausted attempts and their NOT VERIFIED outcome. Do not reset budgets or readmit the old UI cycle. Report failures and blockers honestly, including any failed initial suite and its separate serial retry; do not require a verifier to observe its own pending verdict.
