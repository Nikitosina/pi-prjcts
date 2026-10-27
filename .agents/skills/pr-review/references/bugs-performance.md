# Bugs and performance review

Read the complete pinned diff and relevant call sites. Review statically and report only issues introduced or exposed by this PR. Keep code unchanged.

Cover edge cases, index and state errors, races, resource lifetime, swallowed failures, authorization, input validation, and sensitive-data exposure. Trace the reachable call chain and state assumptions for each finding.

For performance, inspect per-keystroke, per-frame, per-request, and collection-processing paths for:

- Repeated allocations or lookups, loop-invariant work, and quadratic growth.
- Blocking I/O or heavy computation on UI/input threads.
- N+1 requests, missing bounds, unbounded caches, retained observers, and closures.
- Repeated layout/render work and launch-time work.
- Large images, models, and buffers loaded into memory-constrained extensions.

Each finding includes severity, new-side `path:line`, the triggering path, evidence, and consequence. For performance, state the cost scale and why the path is hot; do not invent measurements or memory thresholds. Distinguish demonstrated code defects from risks dependent on unknown runtime facts. Omit unsupported suspicions and cosmetic issues. Report no findings when appropriate. Keep the report under 600 words.
