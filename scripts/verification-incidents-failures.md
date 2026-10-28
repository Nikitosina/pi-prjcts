# Verifier incidents: failure cases

Written after the fact: `scripts/verification-incidents-e2e.mjs` and `scripts/verification-exhausted-e2e.mjs` came before this file. The cases are the defects traced on the projects-dev host (Mari "Bugs impl #1", Y Keyboard "Redesign") and the Spec review of PR #22.

1. A steered worker is judged against the steer nudge instead of its brief, so the only criterion is the steer text.
2. A steer that brings its own `Acceptance criteria:` list is still judged against the older brief.
3. The verifier is not told where the worker's artifacts are, so it reports the evidence as missing.
4. Verification can be turned on for a non-git workspace provider (arc), and every worker turn then ends NOT VERIFIED with 0 attempts and no visible reason.
5. A project that already has verification on for such a provider shows no warning in Settings.
6. After three failed attempts, a follow-up, steer, retry or queued continuation on the same worker opens a fresh cycle with a new budget and replaces the frozen criteria, model, skill and attempts.
7. Turning verification off and on, or restarting the host, clears an exhausted cycle.
8. The exhausted guard locks out a new worker thread, which is new work and gets its own cycle.
