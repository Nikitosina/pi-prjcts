# Composer: full file path from Finder drops and pastes: failure modes (recorded before implementation)

Verify through a private host, fake model, headless Chrome. Chrome cannot be given a real Finder drag, so the browser script feeds synthetic `DataTransfer` objects and says so; only the unit script's transfer shapes describe what real browsers may send.

- P1 A drop or paste carrying a `file:` URL (`text/uri-list`, or `text/plain` made only of `file:` URLs) inserts the URL, a percent-encoded path, or only the basename instead of the decoded plain path.
- P2 A path with spaces, `#`, `%` or Unicode is mangled: left percent-encoded, decoded twice, or normalized to another Unicode form.
- P3 A `file:` URL with a remote host (`file://server/share/a`), a non-file link (`https://…`), a malformed escape, or a NUL byte is turned into a path anyway.
- P4 A transfer with only a `File` (Chrome's normal Finder drag) gets a guessed path built from `file.name`, or the browser navigates to the file and the draft is lost, or nothing tells the owner why nothing happened.
- P5 A paste of a Finder-copied file inserts its basename from `text/plain` next to a `File` item.
- P6 A plain-text paste, including a path from Finder's "Copy as Pathname", no longer takes the browser's default path (undo, selection replace).
- P7 The insertion lands at the start or end of the draft instead of the caret, replaces the draft, drops the selection on paste, or leaves the caret before the inserted text.
- P8 The insertion sends the message, or skips the `input` event so the textarea height and the slash menu stay stale.
- P9 File contents are read, uploaded or kept (`FileReader`, `arrayBuffer`, `text()`, a fetch) to resolve a path.
- P10 The handlers reach beyond the composer: a page-wide drop handler, or the Host agent composer changes.
- P11 Several dropped files are joined with a space, so a path with spaces becomes ambiguous.
- P12 An insertion over the textarea's `maxlength` is cut silently.
