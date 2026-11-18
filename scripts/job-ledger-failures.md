# Job ledger read failures

Measured at 6d6847f: `show` and every ledger consumer (`settleProject`, `durableHostActivity`, `host-health`) call `jobs(id)`, which read and schema-checked every file in the project's `inbox/` on each call. The folder holds one file per message ever sent and is never pruned, so a chat switch costs about 55 µs per file on the host's single thread (4000 files: 220 ms per `show`, and a cheap call issued meanwhile waits about 160 ms).

- L1 A repeated `jobs(id)` re-reads and re-validates files that did not change, so chat switches and every other host call slow down with the age of the project.
- L2 A cached ledger shows a job written by `saveJob` late, or keeps showing its old state or error.
- L3 A cached ledger keeps a job whose file was removed, or misses a file added to the folder.
- L4 A caller that edits a returned job (the settle loop does) changes what the next read returns without a save.
- L5 One project's ledger is shown for another project.
