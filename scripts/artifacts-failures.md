# Worker artifacts folder + inline media in chat (C7): failure cases, written before implementation

Verified by `scripts/artifacts-e2e.mjs` unless marked (inspection).

## Folder
- A1 Workers get no artifacts directory, or it lives inside the worktree and disappears with worktree cleanup.
- A2 The path is not in the worker's instructions or its shell environment (`PI_ARTIFACTS_DIR`), so evidence lands in random places (`e2e-results/` in the worktree).
- A3 Two threads share one folder, or a follow-up on the same thread gets a new empty folder (evidence of earlier turns lost from view).
- A4 Child workers write into the parent's folder or get none.
- A5 The dangling "must use projects_evidence" instruction remains for durable workers that do not have that tool.
- A6 Workers are not told to list their artifacts in their result.
- A7 Building capture tools instead of a folder (out of scope: repos ship their own verification skill).

## Listing and reading
- A8 The coordinator cannot list or read artifacts (no tool), so its final report cannot reference them.
- A9 The list tool or HTTP route follows a symlink planted in the folder (e.g. to `~/.ssh/id_rsa` or another project) and serves its content.
- A10 Path traversal (`..`, absolute paths, encoded `%2e%2e`, NUL) in a list/read/HTTP request escapes the thread folder.
- A11 An unknown or other project's thread ID reads another project's files.
- A12 Artifacts are served without the web token, or with a guessable URL.
- A13 Large folders: listing walks unbounded trees (thousands of files) or reads whole files to size them.
- A23 A thread listing returns every file (up to 300) in one answer, tens of KiB, so one call fills the coordinator's context. It must fit 8 KiB by default with a `nextOffset`, report counts by kind and folder so nothing is hidden, accept `path` and `kind` filters, and keep each file's ref. An explicit `limit` stays within 16 KiB.
- A14 No size cap: a runaway worker fills the disk; or the cap silently deletes evidence. (Decision: 500 MB/thread soft cap, reported to worker/coordinator/owner, no deletion.)

## Report and chat
- A15 The settled-work report does not mention the artifacts, so the coordinator never looks.
- A16 Chat renders `artifact:` references as plain text or broken links; images are not inline; videos (webm/mp4) have no player.
- A17 The CSP blocks media (`media-src` missing), so `<video>` fails.
- A18 A reference to a missing file or another project's thread breaks the page (uncaught error) instead of showing "missing".
- A19 Re-rendering the transcript refetches every image each refresh (flicker, bandwidth), or leaks blob URLs without bound.
- A20 Untrusted markdown can craft an `artifact:` link that triggers a non-GET request or script execution (`javascript:`), or HTML injection through file names.
- A24 A chat image stays thumbnail-sized with no way to see it larger; or the viewer does not fit the viewport (upscale or overflow), cannot be closed with Escape, the backdrop or a labelled close button, does not trap focus or return it to the image, animates when the owner asks for reduced motion, or reopens with the previous image.

## Owner browsing
- A21 The Activity thread pane does not show the thread's artifacts (names, sizes, inline previews).
- A22 Artifacts of a stopped/failed/archived thread become invisible.

## The inbox at `/` (classic inbox retired 2026-11-04)
The chat checks run in the new client: images are inline `.media-img` slots; videos and other files are download buttons fetched
through the authenticated `/artifacts/` route only on click (A16 inline `<video>` player retired: the new client has none, a gap);
a missing file shows "missing file" (A18). A21 (the classic Activity artifact browser) is retired; its data stays covered over
`artifacts-list`. Gap: no browser view of a thread's artifact folder.
