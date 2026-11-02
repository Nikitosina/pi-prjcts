# Durable runtime failures

## Quiet coordinator handoffs

Test seam: actual model requests emitted by `openDurableProject`, using the existing private fake provider in `durable-runtime-e2e.mjs`.

- A coordinator request omits the rule to end after asking for an owner decision and sends acknowledgment-only messages that reopen workers.
- A coordinator receives compact handbacks without instructions for retrieving full evidence before accepting work.
- An independent worker has no checkpoint instruction and labels an unfinished stage Ready to avoid failure.
- A worker repeats its structured report in its closing answer rather than leaving full evidence available on demand.

These checks prove instruction delivery, not compliance by a real model. Jobs engine and browser tests cover deterministic delivery, checkpoint approval refusal and presentation separately.
