# PROTOTYPE: PR / diff viewer inside pi-prjcts

Throwaway. Delete this folder once a variant is chosen.

Question: how should the owner read and comment on a worker's PR without leaving pi-prjcts, and what do GitHub and Arcanum allow?

Run: `node ui-prototype-diff/serve.mjs` and open `http://127.0.0.1:4747/?variant=review`. The bar at the top switches variants (or `←` / `→`), provider (GitHub / Arc), theme, and opens the API map.

The diff is the real PR #66 (`data-diff.js`, generated from git). Threads, review map and chat are invented (`data.js`). Nothing is persisted or sent.

## Variants

- `combo` (owner's pick): Review room by default. The Guided tour button asks a scout for a review map; then a Files / Tour switch turns the same room into steps. Approving a step marks its files viewed.
  - The scout works for any PR, including a colleague's. For our own PR it also reads the worker's Ready report. Bar toggle: Our PR / Colleague's.
  - After a new push the map is kept: steps whose files changed get a ↻ mark and a banner offers Rebuild map. Bar button Sim push shows it.
- `review`: Review room. The center turns into a full review: file tree with viewed progress, whole diff, threads inline, iterations and "since you looked" interdiff, a bottom bar with drafts, Publish review and Ask worker to fix. Keys `j` `k` `v` `s` `c`.
- `sheet`: Diff beside chat. The chat stays; the diff opens as a wide right sheet. Code refs in coordinator messages open the line. Selected lines go into the composer as a quote.
- `walk`: Guided walkthrough. The worker's review map orders files by risk; each step has why, checks and the real diff; ends with a verdict.
- `feed`: Card in the chat. The PR card shows a change map and expandable files; a later push shows only the interdiff.

## Comment destinations

Each draft goes either to the worker (a brief for a fresh worker on the PR branch) or to the provider. Publishing to GitHub or Arcanum only happens after an explicit owner action with a confirmation.

## API findings

See the API map dialog (`API_MAP` in `data.js`). Main points: the diff text comes from the local checkout (`VcsProvider.diff`) for both providers; GitHub has no iterations, so pushes and the "since you looked" head are stored by the host; Arcanum has diff-sets and an inter-diff, but no viewed-state API.
