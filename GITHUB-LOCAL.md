# Locally pushed Git task heads

Implementation scope: explicitly enabled fixed worker profiles may perform Git work in their allocated checkout. A separate opt-in `localPublication` inspection bridge verifies a pushed head before PR tools can use it. The bridge performs fixed read-only Git commands and GitHub GETs only: no commit, fetch, push, merge or force update. Existing grants gain no bridge permission. provider plugin remains deferred/read-only.

## Failure cases recorded before implementation

- Missing explicit bridge permission, wrong worker/provider/repository/branch or inactive work denies verification.
- Nonempty NODE_OPTIONS/PI_PACKAGE_DIR, missing local commit/base, detached/wrong local branch, dirty assigned paths or changing local HEAD denies verification.
- Local HEAD and exact remote task ref must match the requested immutable SHA.
- Commit changes outside assigned paths, symlink/submodule modes, invalid UTF-8, oversized files or aggregate content deny verification.
- Unresolved command or branch-publication intents block adoption; missing markers never permit replay.
- Authority, local snapshot or remote ref changes during inspection deny a receipt.
- Read-only Git uses helper-free forensic configuration and optional locks disabled; metadata failures are sanitized.
- Native identity records the verification call, not an invented commit/push call. A same-head retry reuses the first verification receipt.
- File/API publication and locally verified heads share the existing task-branch lane. PR/approval code consumes only verified heads.

### Authorized-base integration failure cases (recorded before implementation)

- An explicit expected base must equal the live authorized base-branch ref before/after inspection, not another commit or branch.
- The frozen base must be an ancestor of the expected live base; that base and the previous verified task head must be ancestors of the task head.
- Changes relative to the expected live base must still be confined to assigned files; inherited upstream changes are not authored task changes.
- Base/ref/authority changes deny admission; no merge, rebase or forced update is performed by verification.

## Status

Implemented, unverified. `github-authorize` accepts explicit `localPublication: true`; omission preserves a previous setting and `false` removes permission. The generated scoped `_verify_local_publication` tool accepts an expected task SHA and an optional immutable expected base SHA; neither supplies executable arguments. It checks the local task branch, helper-free Git metadata, regular bounded UTF-8 blobs, clean assigned paths, frozen-base ancestry and non-rewind from the previous verified head, then rechecks repository authority and the remote task ref. Verification records are labelled `verify-local-publication`/`local-git-verification`, with the actual inspection task/call identity and manifest hash. They do not claim that the inspector committed or pushed, nor that its journal marker appears remotely. Existing PR and merge-approval head checks consume the verified branch lane; unknown command/publication outcomes still block it. No Git commands, network requests, E2Es or typechecks run. Fixed profile commands remain owner-trusted code, not an OS sandbox. This does not prove actual conflict resolution. Without `expectedBase`, changed paths are compared against the frozen authorized base. With it, the bridge verifies the live authorized base ref before/after inspection, frozen-base ancestry and incorporation of that base into the task graph. Changed paths are compared against that pinned base, so upstream-owned changes may be inherited but no unassigned task changes are accepted. The original frozen base remains in the receipt. The bridge never performs merge, rebase, fetch or push.

## Whole-repository scopes (one-click)

`github-quick-authorize {id, confirm, expectedRevision}` authorizes the origin repository with `pi/`, `reviewReplies` and `localPublication`, reading the numeric id and default branch with `gh`. `owner-setup-snapshot.githubQuick` is the offline preview or blocker. One-click authorizations (`oneClick: true`) follow later workspace grant/revoke changes; advanced ones still need re-authorization.

Whole-repository workers commit and push their own `pi/durable-<id>` branch with bash. `projects_github_<key>_open_draft_pr {expectedHead, title, body}` checks that the worktree is on that branch at `expectedHead` and that the remote branch points at the same SHA (before and after inspection), that the head descends from the thread base and from the last verified head, then records a `verify-local-publication` receipt with the base..head name-status list (deletions included) and creates the draft PR, or updates the title/body of the PR it already opened. It never merges, and it writes nothing to GitHub except creating or updating that PR. Folder-limited scopes keep `_publish`, `_pr`, `_update_pr` and `_verify_local_publication` unchanged.

Offline E2E: `scripts/github-quick-e2e.mjs` and `scripts/github-quick-ui-e2e.mjs` use `scripts/fake-gh.mjs` via `PI_PROJECTS_GH_CLI` and a local bare remote set as `remote.origin.pushurl`.
