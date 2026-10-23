# Context bounds (default tool responses of at most 8 KiB, paged expansion): failure modes

Written before code. Covered by `scripts/context-bounds-check.mjs` (direct tool calls, no host) and the budget checks E17 to E24 in `scripts/coordinator-efficiency-e2e.mjs`.

Limit: a default response, including its next-page metadata, is at most 8192 bytes. An explicit `limit`, `textLimit`, `offset` or `path` argument reaches everything the tool could reach before.

1. `code_grep` with 3000 matching lines returns about 50 KB by default. It must return at most 8192 bytes and say how to continue (a larger `limit`, or a narrower `path`/`glob`).
2. `code_read` of a 5000-line file returns about 50 KB by default. It must return at most 8192 bytes and the continuation offset, and paging with that offset must visit every line once, with no gap and no overlap.
3. `code_find` and `code_ls` over thousands of entries return up to 1000 and 500 entries. Default at most 8192 bytes with a continuation hint.
4. A clip splits a multi-byte character or a surrogate pair, or the continuation note is cut off because the clip ignored the note's own size.
5. An image read through `code_read` loses its image block, or a text clip is applied to binary content.
6. An explicit `limit` is clipped by the default budget, so the expansion path no longer reaches the full result.
7. `code_diff` returns 46 KB by default. It must return the changed-file list and the first diff page within 8192 bytes, with `nextOffset`; paging with `offset` must rebuild the exact `git diff` text, and `path` must return only that file's diff.
8. `code_diff` `path` escapes the checkout (`..`, absolute, a leading `-` read as a git option) or runs for a non-git provider that cannot honor it.
9. `projects_worker_diff` returns 46 KB by default. Same paging contract as `code_diff` (`offset`, `nextOffset`).
10. `projects_workers` returns 30 rows by default and can pass 8192 bytes; `projects_worker_read` returns 30 messages of 4000 characters. Defaults must fit 8192 bytes as valid JSON with a correct `nextOffset` that counts only the rows kept, so a caller following `nextOffset` loses nothing.
11. `projects_worker_plan` echoes the whole worker snapshot (about 41 KB in a real session). It must return a receipt of the admitted items only.
12. `projects_work_result` (and the child variant) default page of 8000 characters passes 8192 bytes once JSON escaping is counted. The default page must be sized by serialized bytes; an explicit `limit` keeps its exact character meaning.
13. `projects_knowledge_read`, `projects_knowledge_list`, `projects_notes`, `projects_search`, `projects_artifacts_list` and `projects_upload_read` defaults pass 8192 bytes. Each must keep valid JSON, report `nextOffset`, and honor explicit limits.
14. A fit loop that drops rows returns zero rows when one row alone is larger than the budget, or reports a `nextOffset` that skips the dropped rows.
15. The 8192-byte default leaks into the owner's browser views: `thread-history` and `workers` over HTTP keep their old defaults.
16. A single row or message alone is larger than 8192 bytes (UTF-8 and JSON escapes expand 1000 characters of history or note text several times), and the fit loop returns it whole. A default response must never exceed the limit: when the first row does not fit, the response is a small metadata-only row that names the index and how to read it with an explicit `limit` (which stays unbounded), and `nextOffset` still advances by one row, never stalling at zero rows.
17. `workerChanges`/`code_diff` page 0 is led by text that already passes 8192 bytes (a 40-line status list of 300-character paths, a long untracked-file list, a long changed-file list), so the page has no room, makes no progress, or exceeds the limit. Each lead part must be bounded so a diff page always fits and `offset` always advances.
18. `fitJson` called with a lone row (`max <= min`) skips the fit and returns the oversized text.
