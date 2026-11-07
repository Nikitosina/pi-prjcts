# Live deploy failures

Deploy no longer waits for idle projects: it gives running tool calls a short window, stops the host, and lets Pi Durable continue the work after the start.

- A deploy started while a project works is queued instead of running, so the owner or an agent waits for an idle moment that may never come.
- A tool call that ends inside the window is cut off anyway: the model gets an `interrupted` result for a call that would have finished.
- A tool call longer than the window holds the host past it, so one long build blocks every deploy.
- The window ignores its own caller: a `projects_redeploy` call (directly or inside codemode) counts as running work and always uses the whole window.
- After the restart the cut-off coordinator turn does not continue: the chat stays working forever, or the Job fails instead of resuming.
- A process killed by the stop keeps running as an orphan and writes into the worktree while the resumed call runs it again.
- `projects_redeploy` returns before the restart, so the agent reports a deploy it has not seen finish; or after the restart it starts a second deploy instead of reading the first one's result.
- `projects_redeploy` waits forever when the deploy child dies without writing a result.
- A failed preparation (`npm ci`, `npm run check`) stops the host anyway, or `projects_redeploy` reports it as deployed.
- A rollback leaves `projects_redeploy` without an answer, or reports success.
- A coordinator of another project gets `projects_redeploy`, or the pi-prjcts Coordinator still asks the owner to approve a deploy.
- A checkout change during preparation is silently deployed, or requeued forever; it must fail the deploy and say so.

## Following a branch

With the deploy setting `branch` (e.g. `main`), a deploy ships the newest `origin/<branch>`, so a merged PR deploys without anyone pulling the owner checkout by hand. Proof: `deploy-e2e.mjs` step 6 (B1-B5).

- B1 A deploy with a branch set builds the checkout's current HEAD instead of a freshly fetched `origin/<branch>`, so merged work never ships.
- B2 The checkout moves before the check passes, so a commit that fails `npm run check` lands in the running host's files, or a failed check leaves the checkout moved.
- B3 A checkout on another branch, with local commits not on `origin/<branch>`, or with uncommitted changes, is switched, merged or reset; it must be refused with the reason and left as it was.
- B4 The nightly trigger compares only the local HEAD, so new commits on `origin/<branch>` never deploy at night; or a failed fetch counts as new code.
- B5 Without a branch set, a deploy fetches anything or behaves differently from before.

