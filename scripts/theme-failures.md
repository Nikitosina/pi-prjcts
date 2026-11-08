# Dark / light / system theme: failure cases

Owner decision: dark theme with the Claude-like style; Appearance setting System / Light / Dark, per browser (localStorage), applied before first paint. `scripts/theme-e2e.mjs` checks these in headless Chrome with a fake model.

1. Flash of the wrong theme on load (theme applied after first paint, or the pre-paint script is inline and blocked by the CSP `script-src 'self'`).
2. System does not follow `prefers-color-scheme` live (only read once), or Light/Dark are overridden by the OS scheme.
3. The choice is not persisted across reload, leaks to another key, or an invalid stored value breaks the page (must fall back to System).
4. Light look changed (tokens must resolve to the previous colors).
5. A hardcoded light color stays in dark: white/cream card, input, code block, table, modal, toast, search row, skills picker, activity tree, artifact viewer showing a light box on a dark page.
6. Low contrast in dark: body, muted text, links, chips/badges (pale tinted pill with dark text turned unreadable), primary button text, error/warning banners.
7. Native widgets stay light in dark: scrollbars, checkboxes, select popups, date inputs (`color-scheme` missing).
8. Dialog backdrop or `<dialog>` inherits the wrong scheme (dialog is rendered in the top layer).
9. The Settings control shows the wrong value after reload or does not apply instantly.
10. Screenshots/regression selectors break: the new card must not change existing ids.

## The inbox at `/` (classic inbox retired 2026-11-04)

The theme is now a host `ui` document setting (Claude, Midnight, Light, System), cached per browser for the first paint by
`/theme.js`. `theme-e2e.mjs` drives the new client: T1 (decided before `<body>`, from a same-origin blocking script), T2 (System
follows the OS live both ways; an explicit theme ignores it), T5/T7 (dark themes: no bright surfaces apart from accent-filled
buttons, Markdown code/table/quote dark, `color-scheme: dark`), T6 (transcript text at least 4.5:1 in Claude, Midnight and Light)
and T9 (a theme picked in Settings applies at once, is saved on the host, and is in place before `<body>` on reload).
Host validation of the document (unknown theme, stale revision) is in `ui2-settings-e2e.mjs` (U1-U8).

Retired: the per-browser localStorage control and its invalid-value fallback (3, 9 as written), the classic palette lock (4), the
classic overlays and selectors (8, 10).

Known, not fixed (palette decision): outside the transcript the shell's faint tokens measure under 4.5:1: timestamps, separators,
tree chevrons and "New chat", panel headings, composer key hints (3.1-3.9:1), and white on the accent of Send/primary buttons
(3.1-4.0:1). The report's `knownLowContrast` lists them per theme.
