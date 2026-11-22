# Can a recovered submission stay parked?

Run the block below from the checkout root. This is a dependency diagnostic, not a test of a working network gate. It uses a fresh home, SQLite and an in-process fake provider. Boot 1 closes the Harness during a request. Boot 2 withholds `resume()`, including from `onWake`. The host reacquires the same submission and waits for its receipt, as a reporter would. The closed-gate invariant is zero calls on boot 2.

```sh
scratch=$(mktemp -d) || exit 1
trap 'rm -rf "$scratch"' EXIT
HOME="$scratch" PI_PROJECTS_HOME="$scratch/project" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const home = process.env.PI_PROJECTS_HOME;
mkdirSync(home);
const timeout = setTimeout(() => { console.error('scheduler diagnostic timed out'); process.exit(2); }, 10000);
async function open(response) {
  const models = createModels(), fake = fauxProvider();
  models.setProvider(fake.provider);
  fake.setResponses([response]);
  const h = await Harness.open(await openNodeSqliteStorage(join(home, 'durable.sqlite')),
    { models, registry: createRegistry(), onWake() {}, settings: { retry: { maxRetries: 0 } } }, ctx);
  return { h, fake };
}
const entered = Promise.withResolvers();
let boot = await open(async (_request, { signal }) => {
  entered.resolve();
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  return fauxAssistantMessage('interrupted');
});
let id;
try {
  const chat = await boot.h.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  id = (await chat.submit({ type: 'input', requestId: 'network-gate-restart', content: 'test' }, ctx)).id;
  await entered.promise;
} finally { await boot.h.close(ctx); }
boot = await open(fauxAssistantMessage('received during hold'));
try {
  const recovered = await boot.h.submission(id, ctx);
  assert.ok(recovered);
  const { scheduling, tasks } = await boot.h.inspect(ctx);
  console.log({ id, scheduling, tasks: tasks.map(t => [t.record.id, t.state.kind]) });
  assert.equal(scheduling, 'paused');
  assert.equal(boot.fake.state.callCount, 0);
  const settled = await recovered.wait(ctx);
  console.log({ id, status: settled.status, providerCalls: boot.fake.state.callCount });
  assert.equal(boot.fake.state.callCount, 0, 'closed gate: waiting for an existing receipt must not start a provider call');
} finally { await boot.h.close(ctx); clearTimeout(timeout); }
JS
```

## Result on pi-durable 1.4.0

After reopening, `inspect()` showed scheduling `paused` but task 9 `ready`. Waiting for submission 8 ran that task: `status: 'done', providerCalls: 1`. The assertion fails. The test did not call `resume()` or submit another input on boot 2.

`Submissions.wait` and `Submissions.submit` in `dist/harness/submissions.js` enable scheduling. `Scheduler.#reserve` in `dist/harness/scheduler.js` reserves eligible tasks in a commit without a host admission decision. The public `Harness` has no matching `pause(key)`; its `blocked` reasons describe registry incompatibility and restart limits, not a host hold. Waiting in `beforeRequest` would keep a reserved task running, not park it. `afterResponse` returns no scheduling decision. Blocking model dispatch alone would hide the provider call but still start the turn.

## Minimum upstream contract

Add an optional host gate to `Harness.open`, installed before recovery. In run mode, test it before placing an input that would start a run (including draining the inbox), and before reserving work that can start or resume a turn. A hold leaves the input queued or task unreserved, addressable by its existing conversation, submission and task IDs. Report the hold through `inspect`; a gate change wakes the scheduler. No waiting promise inside the commit. All progress paths, including `wait`, obey the same gate. Abort, tool completion and close must still drain.

For an already-running generation, allow the provider outcome classifier to return that same hold keyed by generation and attempt, before retry or terminal settlement. Persist the interrupted step in that commit without advancing the inbox. Reopen starts closed; release resumes the same pending step once. No VPN-specific policy or second submission needed in Durable.

Upstream acceptance: reopen on a closed gate, attach the waiter above, wait for the scheduler to report the keyed hold and assert no provider calls. Release it twice; the original waiter must settle with exactly one call. Repeat with a queued follow-up and a committed tool result to check order and no replay. Only then wire the host plugin.
