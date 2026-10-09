# Worker artifacts browser: failure modes (written before the UI)

Scope: Activity panel = workers list | worker chat | artifact browser (folder tree + preview).

- F1 Layout: the panel stays two columns, or the browser column is missing/overlaps; columns do not scroll independently.
- F2 Tree: nested paths render flat or lose their folders; folders cannot collapse/expand; collapse state resets on refresh.
- F3 Sort/filter: newest-first / by-name toggle does nothing; filter hides nothing or hides folders of matching files; empty filter result has no message.
- F4 Counts: file count, total size, over-cap note missing or wrong.
- F5 Preview kinds: image/video do not render; markdown shows raw source; JSON is not pretty-printed; log is not monospace; other binaries try to render instead of metadata + download.
- F6 Large text: a 700 KB log is loaded fully into the page (no 512 KB cap, no "download full" hint) or the cap hint is missing.
- F7 XSS: markdown/html/filename content executes (window.__xss set), a script/iframe element appears in the preview, an HTML artifact is rendered instead of shown as text.
- F8 Download / open: Download saves wrong bytes or wrong (unicode/space) file name; "Open in new tab" opens nothing.
- F9 Refresh: the 4 s listing refresh drops the selection, closes the preview, refetches the preview bytes, resets the filter, or a newly written file is not shown / not highlighted.
- F10 Chat link: clicking an `artifact:` link in the worker chat downloads instead of selecting the file in the browser; inline media vanish from chat.
- F11 Switching: selecting another worker keeps the previous worker's files/selection; stale listing from the first worker overwrites the second.
- F12 Empty states: no worker selected, closed worker, or worker without artifacts shows a broken or stale browser.
- F13 Responsive (<1200 px): the browser still takes a column (squeezing the chat) or cannot be reached; no toggle; drawer does not close. At 390 px the single-column layout breaks.
- F14 Hostile names: a file named `<img src=x onerror=...>.txt`, spaces, unicode, deep nesting break the tree or inject markup.
- F15 Regressions: existing worker chat / workers card / coordinator workers UI / artifacts / ui-polish E2Es fail; browser console errors or unexpected HTTP errors.
