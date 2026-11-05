# Web search tool: failure cases

Written before `src/web-search.ts`. `scripts/web-search-unit.mjs` covers W1–W7 against a local fake search endpoint; W8 is covered by the tool listing in `scripts/web-search-unit.mjs` through `toolGroup` and `toolDisabled`.

- W1 A search without `openai-codex` credentials sends a request, or fails with a raw provider error instead of saying how to connect (`/login openai-codex`).
- W2 The request misses the bearer token or the account id taken from the token, or sends the query anywhere but the configured endpoint.
- W3 An empty or oversized query reaches the endpoint.
- W4 An HTTP 401/403 is reported as a generic failure instead of an authentication failure; another non-2xx status is reported as success.
- W5 A response over the size limit is read whole, or a response without structured results is presented as an answer with sources.
- W6 A source URL that is not http(s) reaches the model, or more than 10 sources are listed.
- W7 An aborted call keeps waiting for the endpoint.
- W8 The tool is not its own switchable group (`group:web`) that a profile can turn off, by name or by group.
