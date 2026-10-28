# Coordinator lifecycle failure cases

- A terminal work result is left unhandled, repeatedly redispatched as new work, or called complete despite an unresolved blocker.
- A handled or superseded attempt remains visible indefinitely, or an unknown failure is archived without inspection and recorded disposition.
- A customized coordinator loses its owner prompt or misses the shared lifecycle rules when a new coordinator is configured.
- A frozen continuation is silently rewritten by a later prompt change.
