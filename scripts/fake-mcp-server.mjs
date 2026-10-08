#!/usr/bin/env node
// Fake MCP server (stdio, newline-delimited JSON-RPC) for offline E2Es. Logs connections and tool calls to FAKE_MCP_CALLS.
// Tools: whoami (cwd/tag/pid), launch_status, get_settings, slow, crash, big (reads); ChangeIssueStatus (no annotations, name heuristic);
// start_launch (readOnlyHint:false) and purge (destructiveHint:true) are writes by annotation; list_hints (readOnlyHint:true named like a write) is a read by annotation.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const tag = process.env.FAKE_MCP_TAG ?? "none", calls = process.env.FAKE_MCP_CALLS;
const log = entry => calls && appendFileSync(calls, JSON.stringify({ at: Date.now(), tag, pid: process.pid, cwd: process.cwd(), ...entry }) + "\n");
const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const text = value => ({ content: [{ type: "text", text: value }] });
const tools = [
  { name: "whoami", description: "Reports the server's working directory, tag and pid.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "launch_status", description: "Status of a CI launch.", inputSchema: object({ id: { type: "string" } }, ["id"]), annotations: { readOnlyHint: true } },
  { name: "get_settings", description: "Reads settings (name contains a write-looking word only as a noun).", inputSchema: object() },
  { name: "slow", description: "Sleeps for ms.", inputSchema: object({ ms: { type: "number" } }), annotations: { readOnlyHint: true } },
  { name: "crash", description: "Exits mid-call.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "big", description: "Returns 200 KB of text.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "ChangeIssueStatus", description: "Moves a ticket to a new status.", inputSchema: object({ key: { type: "string" }, status: { type: "string" } }, ["key", "status"]) },
  { name: "start_launch", description: "Starts a launch.", inputSchema: object({ id: { type: "string" } }), annotations: { readOnlyHint: false } },
  { name: "purge", description: "Deletes things.", inputSchema: object(), annotations: { destructiveHint: true } },
  { name: "list_hints", description: "Read by annotation although the name has no write word.", inputSchema: object(), annotations: { readOnlyHint: true } },
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
log({ event: "start", secretSeen: Boolean(process.env.FAKE_MCP_SECRET) });
createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return;
  const message = JSON.parse(line), { id, method, params } = message;
  if (method === "initialize") return reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `fake-mcp-${tag}`, version: "1.0.0" } });
  if (method === "tools/list") return reply(id, { tools });
  if (method === "ping") return reply(id, {});
  if (method !== "tools/call") { if (id !== undefined) fail(id, -32601, "Method not found"); return; }
  const { name, arguments: args = {} } = params;
  log({ event: "call", tool: name, args });
  if (name === "crash") process.exit(1);
  if (name === "slow") await new Promise(done => setTimeout(done, args.ms ?? 10000));
  if (name === "big") return reply(id, text("x".repeat(200_000)));
  if (name === "launch_status") return reply(id, text(`launch ${args.id}: PASSED`));
  if (name === "whoami") return reply(id, text(`cwd=${process.cwd()} tag=${tag} pid=${process.pid}`));
  if (tools.some(tool => tool.name === name)) return reply(id, text(`${name} ok`));
  fail(id, -32602, `Unknown tool ${name}`);
});
