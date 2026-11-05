// Unit checks for src/web-search.ts against a local fake search endpoint (scripts/web-search-failures.md W1–W8). No real provider.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { searchWeb, WEB_SEARCH_TOOL, MAX_RESPONSE_BYTES } from "../src/web-search.ts";
import { toolDisabled, toolGroup } from "../src/profiles.ts";

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
const requests = [];
let reply = () => ({ status: 200, body: JSON.stringify({ output: "An answer.", results: [] }) });
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    requests.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : null });
    const { status, body: out, hang } = reply();
    if (hang) return;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(out);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/search`;
const search = (query, options = {}) => searchWeb(query, { auth: async () => token, endpoint, ...options });

try {
  // W1: no credentials, no request, and a way to connect.
  await assert.rejects(searchWeb("pi", { auth: async () => undefined, endpoint }), /\/login openai-codex/, "W1 missing credentials");
  assert.equal(requests.length, 0, "W1 nothing was sent");

  // W2: bearer, account id from the token, the configured endpoint, the query.
  reply = () => ({
    status: 200,
    body: JSON.stringify({
      output: "Pi 2 was released.",
      results: [
        { type: "text_result", url: "https://example.com/pi", title: "Pi release", snippet: "Version 2" },
        { type: "text_result", url: "javascript:alert(1)", title: "Bad" },
        ...Array.from({ length: 12 }, (_, n) => ({ type: "text_result", url: `https://example.com/${n}`, title: `R${n}` })),
      ],
    }),
  });
  const text = await search("latest pi release");
  const sent = requests.at(-1);
  assert.equal(sent.url, "/search", "W2 configured endpoint");
  assert.equal(sent.headers.authorization, `Bearer ${token}`, "W2 bearer token");
  assert.equal(sent.headers["chatgpt-account-id"], "acct-1", "W2 account id from the token");
  assert.equal(sent.body.commands.search_query[0].q, "latest pi release", "W2 the query");
  assert.match(text, /^1\. \[Pi release\]\(https:\/\/example\.com\/pi\)\n {3}Version 2\n2\. /, "W2 results as a list");
  assert.ok(!text.includes("Pi 2 was released"), "W2 the raw output dump is not repeated");

  // W6: unsafe URLs dropped, at most 10 sources.
  assert.ok(!text.includes("javascript:"), "W6 unsafe URL dropped");
  assert.equal(text.match(/^\d+\. /gm).length, 10, "W6 at most 10 sources");

  // W3: empty and oversized queries never leave the host.
  const before = requests.length;
  await assert.rejects(search("   "), /non-empty/, "W3 empty query");
  await assert.rejects(search("x".repeat(8 * 1024 + 1)), /8192/, "W3 oversized query");
  assert.equal(requests.length, before, "W3 nothing was sent");

  // W4: auth failures and other statuses.
  reply = () => ({ status: 401, body: "{}" });
  await assert.rejects(search("q"), /authentication failed.*\/login openai-codex/i, "W4 401");
  reply = () => ({ status: 500, body: "{}" });
  await assert.rejects(search("q"), /HTTP 500/, "W4 500");

  // W5: oversized and unstructured responses.
  reply = () => ({ status: 200, body: JSON.stringify({ output: "x".repeat(MAX_RESPONSE_BYTES) }) });
  await assert.rejects(search("q"), /exceeded/, "W5 oversized response");
  reply = () => ({ status: 200, body: JSON.stringify({ output: "No citations" }) });
  await assert.rejects(search("q"), /structured/, "W5 response without results");

  // W7: an abort ends a hanging call.
  reply = () => ({ hang: true });
  const controller = new AbortController();
  const pending = search("q", { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /aborted/i, "W7 abort");

  // W8: its own switchable group.
  assert.equal(toolGroup(WEB_SEARCH_TOOL), "web", "W8 web group");
  const off = (disabled) => toolDisabled({ profiles: { scout: { tools: { disabled } } } }, "scout", WEB_SEARCH_TOOL);
  assert.ok(off(["group:web"]) && off([WEB_SEARCH_TOOL]) && !off([]), "W8 switchable by group and by name");
} finally {
  server.closeAllConnections();
  server.close();
}
console.log("web-search-unit: ok");
