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
