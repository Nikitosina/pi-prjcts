# Web search tool: failure cases

Written before `src/web-search.ts`. `scripts/web-search-unit.mjs` covers W1–W8 against a local fake search endpoint; W9 runs in `scripts/coordinator-workers-ui-e2e.mjs`.

- W1 A search without `openai-codex` credentials sends a request, or fails with a raw provider error instead of saying how to connect (`/login openai-codex`).
- W2 The request misses the bearer token or the account id taken from the token, or sends the query anywhere but the configured endpoint.
- W3 An empty or oversized query reaches the endpoint.
- W4 An HTTP 401/403 is reported as a generic failure instead of an authentication failure; another non-2xx status is reported as success.
- W5 A response over the size limit is read whole, or a response without structured results is presented as results. The raw `output` dump, which repeats the results, reaches the model.
- W6 A source URL that is not http(s) reaches the model, or more than 10 sources are listed.
- W7 An aborted call keeps waiting for the endpoint.
- W8 The tool is not its own switchable group (`group:web`) that a profile can turn off, by name or by group.
- W9 A role is offered `web_search` but its agent lacks the tool's extension, so the call does not resolve (`scripts/coordinator-workers-ui-e2e.mjs`, coordinator and scout).
