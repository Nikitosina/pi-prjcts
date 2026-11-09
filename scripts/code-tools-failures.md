# Read-only code tools: /tmp reads, code_diff path narrowing and file counts

Written before the code (retro 2026-11-09). Script: `scripts/code-tools-unit.mjs` (git checkouts, a fake plugin checkout kind, no host). The Arc side is in the plugin's `scripts/arc-review-target-e2e.mjs`.

## Reads under /tmp

Owner decision: every reader may read under `/tmp` (macOS: `/private/tmp`), read only.

1. A file under `/tmp`, given as `/tmp/...` or `/private/tmp/...`, is refused as outside the code root (the reviewer cannot read the `/pr-review` brief files).
2. A symlink under `/tmp` that points elsewhere (`/tmp/x -> /etc/hosts`, or a link to a directory outside) is followed and read. It must stay refused: both the lexical path and its real path must be under the code root or under `/tmp`.
3. A path outside both (`/etc/hosts`, `../outside`) becomes readable through the new rule. It stays refused.
4. Pi's read tools resolve the path their own way: a leading `@` is stripped and `file://` URLs become paths. A `@/etc/hosts` or `file:///etc/hosts` passes a check that only resolves the raw text against the root, and pi reads the outside file. The guard must check the path pi will open.
5. The new rule offers a write: code tools stay read, grep, find, ls and diff only.

## code_diff path narrowing

6. `path` is relative to the checkout root, so in a project in a subfolder (`mobile/nlp/ios/keyboard`) a path that works for `code_read` matches nothing, or the wrong file. Paths are relative to the project directory, the same root `code_read` uses.
7. A plugin checkout kind (Arc) refuses `path` ("git checkouts only") although its diff command takes paths. The host passes the validated path, relative to the checkout root, through the provider contract.
8. A plugin that predates the contract ignores the path and returns the whole diff under a "limited to path" header. The host must refuse narrowing for a provider that does not declare it, and must not advise it.
9. `path` escapes the project directory (`..`, absolute, `~`, a leading `-` read as an option, control characters). Refused before any command runs.
10. Untracked files outside the path are still listed or diffed.

## code_diff file counts (`mode: "stat"`)

11. There is no way to see which files changed with their size without paging the whole diff. `mode: "stat"` lists every changed file with `+added -removed` (binary files marked), committed and uncommitted together, untracked files counted as additions.
12. The list is larger than 8 KiB: it must page by file (`offset` is a file index), each page at most 8 KiB with a note naming the next offset, and paging must visit every file once.
13. Paths in the list cannot be passed back: they are relative to the checkout root while `path` is relative to the project directory. The list shows project-relative paths.
14. A content line that looks like a header (`+++ x`, `--- y`, `diff --git` inside a file) is miscounted or starts a new file. A file changed both in commits and uncommitted (two blocks for one path) is listed twice.
15. A plugin diff block for an untracked file without a hunk header is not counted.
16. `mode: "stat"` with `path` lists only files under it.

## Continuation advice

17. A note advises a call that is not supported (`pass path for one file` on a provider without narrowing). Every note names only calls that work for that checkout: `offset`, `path` where supported, `mode: "stat"`.
