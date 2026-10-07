#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

let activeE2e;
if (process.argv[2] === "--local-mcp-server") await runServer(process.argv[3], process.argv[4] ?? "normal", process.argv[5]);
else await runE2e().catch(async error => {
  if (activeE2e) await writeFile(join(activeE2e.reportDir, "failure-report.json"), `${JSON.stringify({ passed: false, expectedDenials: activeE2e.failures, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  throw error;
});

async function runE2e() {
  const { createPermittedLocalCapabilities } = await import("../src/durable-capabilities.ts");
  const root = await mkdtemp(join(tmpdir(), "durable-capabilities-e2e-")), otherRoot = await mkdtemp(join(tmpdir(), "durable-capabilities-other-"));
  const fixture = join(root, "fixture.txt"), outside = join(otherRoot, "outside.txt"), reportDir = resolve("artifacts", `durable-capabilities-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`), phasesFile = join(reportDir, "server-phases.jsonl");
  await mkdir(reportDir, { recursive: true }); activeE2e = { reportDir, failures: [] }; await writeFile(fixture, "actual local MCP fixture read\n"); await writeFile(outside, "outside\n"); await symlink(outside, join(root, "fixture-link.txt"));
  const freshSchema = () => ({ type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 128 } } });
  const mcpBinding = (mode = "normal", extra = {}) => ({ kind: "local-mcp-tool", id: `fixture-mcp-${mode}`, revision: 1, toolName: `projects_fixture_mcp_${mode}`, allowedCallers: ["durable-worker"], server: { id: `owned-fixture-${mode}`, command: process.execPath, args: [resolve(process.argv[1]), "--local-mcp-server", fixture, mode, phasesFile], cwd: root }, serverTool: "read_fixture", inputSchema: freshSchema(), ...extra });
  const options = { caller: "durable-worker", bindings: [{ kind: "local-read", id: "fixture-read", revision: 1, allowedCallers: ["durable-worker"], workspaceRoot: root }, mcpBinding()] };
  const registered = createPermittedLocalCapabilities(options), read = tool(registered, "projects_local_read_file"), mcp = tool(registered, "projects_fixture_mcp_normal");
  const local = await read.execute({ path: "fixture.txt", limit: 64 }, {}, { abortSignal: undefined });
  const mcpResult = await mcp.execute({ path: "fixture.txt" }, {}, { abortSignal: undefined });
  const failures = activeE2e.failures;
  await expectRejected("master-denied", () => createPermittedLocalCapabilities({ caller: "master", bindings: options.bindings }), /denied/i, failures);
  await expectRejected("coordinator-denied", () => createPermittedLocalCapabilities({ caller: "durable-coordinator", bindings: options.bindings }), /denied/i, failures);
  await expectRejected("dotdot-denied", () => read.execute({ path: "a/../fixture.txt" }, {}, { abortSignal: undefined }), /no \.\. segment/i, failures);
  await expectRejected("symlink-denied", () => read.execute({ path: "fixture-link.txt" }, {}, { abortSignal: undefined }), /symlink/i, failures);
  // Mutate source only after construction. Later test bindings are all fresh/pristine objects.
  const identityBefore = JSON.stringify(registered.identity); options.bindings[0].workspaceRoot = otherRoot; options.bindings[1].server.args[3] = "malformed"; options.bindings[1].inputSchema.properties.path.maxLength = 1;
  const preserved = await read.execute({ path: "fixture.txt" }, {}, { abortSignal: undefined });
  assert.ok(preserved.content[0].text.includes("actual local MCP fixture read")); assert.equal(JSON.stringify(registered.identity), identityBefore, "mutable source binding broadened a captured scope");
  const rootIdentity = createPermittedLocalCapabilities({ caller: "durable-worker", bindings: [{ kind: "local-read", id: "other-root", revision: 1, allowedCallers: ["durable-worker"], workspaceRoot: otherRoot }] }).identity;
  const schemaIdentity = createPermittedLocalCapabilities({ caller: "durable-worker", bindings: [mcpBinding("normal", { id: "schema-change", inputSchema: { ...freshSchema(), properties: { path: { type: "string", minLength: 1, maxLength: 64 } } } })] }).identity;
  const revisionIdentity = createPermittedLocalCapabilities({ caller: "durable-worker", bindings: [mcpBinding("normal", { id: "revision-change", revision: 2 })] }).identity;
  assert.equal(registered.identity.revision, 2); assert.notEqual(registered.identity.bindings[0].scopeFingerprint, rootIdentity.bindings[0].scopeFingerprint); assert.notEqual(registered.identity.bindings[1].scopeFingerprint, schemaIdentity.bindings[0].scopeFingerprint); assert.notEqual(registered.identity.bindings[1].scopeFingerprint, revisionIdentity.bindings[0].scopeFingerprint);
  await expectMcpRejected("missing-tool", mcpBinding("missing"), /does not advertise tool read_fixture/, phasesFile, failures);
  await expectMcpRejected("malformed-response", mcpBinding("malformed"), /MCP text response is malformed|MCP response violates CallToolResult schema/, phasesFile, failures, true);
  await expectMcpRejected("payload-bound", mcpBinding("payload", { maxPayloadBytes: 1000 }), /MCP response exceeds configured payload bound/, phasesFile, failures, true);
  await expectMcpRejected("timeout", mcpBinding("timeout", { timeoutMs: 500 }), /timed out|timeout/i, phasesFile, failures, true);
  // Abort only after the owned server has recorded that tools/call arrived.
  const abortProfile = createPermittedLocalCapabilities({ caller: "durable-worker", bindings: [mcpBinding("abort")] }), controller = new AbortController();
  const abortCall = executeBinding(abortProfile, controller.signal); await waitForPhase(phasesFile, "abort", "tools/call");
  controller.abort(); await expectRejected("durable-context-abort", () => abortCall, /abort|closed|cancel/i, failures);
  const phases = await phaseRecords(phasesFile);
  const transcript = { transport: "@earendil-works/pi-mcp McpClient + StdioTransport", identity: registered.identity, localResult: JSON.parse(local.content[0].text), mcpResult: mcpResult.content, failures, serverPhases: phases };
  const report = { passed: true, expectedFailures: failures, fixture: "fixture.txt", scopeFrozen: true, actualToolCallModes: [...new Set(phases.filter(item => item.phase === "tools/call").map(item => item.mode))] };
  await writeFile(join(reportDir, "fixture.txt"), await readFile(fixture)); await writeFile(join(reportDir, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`); await writeFile(join(reportDir, "failure-report.json"), `${JSON.stringify({ expectedDenials: failures }, null, 2)}\n`); await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(failures.length, 9, "E2E failure coverage incomplete"); console.log(JSON.stringify({ passed: true, reportDir, expectedFailures: failures.length }));
}
function tool(profile, name) { const selected = profile.tools.find(candidate => candidate.name === name); if (!selected) throw new Error(`missing registered tool ${name}`); return selected; }
function executeBinding(profile, abortSignal = undefined) { return tool(profile, profile.identity.bindings[0].toolName).execute({ path: "fixture.txt" }, {}, { abortSignal }); }
async function expectRejected(label, operation, expected, failures) { let observed = ""; await assert.rejects(Promise.resolve().then(operation), error => { observed = error instanceof Error ? error.message : String(error); return expected.test(observed); }, `${label} must reject with ${expected}`); failures.push(`${label}: ${observed}`); }
async function expectMcpRejected(label, binding, expected, phasesFile, failures, needsToolCall = false) { const profile = (await import("../src/durable-capabilities.ts")).createPermittedLocalCapabilities({ caller: "durable-worker", bindings: [binding] }); await expectRejected(label, () => executeBinding(profile), expected, failures); if (needsToolCall) await waitForPhase(phasesFile, binding.server.args[3], "tools/call"); }
async function phaseRecords(file) { try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
async function waitForPhase(file, mode, phase) { for (let attempt = 0; attempt < 100; attempt++) { if ((await phaseRecords(file)).some(item => item.mode === mode && item.phase === phase)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`server never recorded ${mode}/${phase}`); }

async function runServer(fixture, mode, phasesFile) {
  let buffer = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\n"); if (newline < 0) return; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; const request = JSON.parse(line); await appendFile(phasesFile, `${JSON.stringify({ mode, phase: request.method })}\n`);
    if (request.method === "initialize") respond(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "owned-fixture-server", version: "1.0.0" } });
    else if (request.method === "tools/list") respond(request.id, { tools: [{ name: mode === "missing" ? "other_tool" : "read_fixture", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 128 } } } }] });
    else if (request.method === "tools/call") { if (mode === "timeout" || mode === "abort") continue; if (mode === "malformed") respond(request.id, { content: [{ type: "text", nope: true }] }); else if (mode === "payload") respond(request.id, { content: [{ type: "text", text: "x".repeat(2000) }] }); else { const path = request.params.arguments?.path; respond(request.id, { content: [{ type: "text", text: path === basename(fixture) ? await readFile(resolve(dirname(fixture), path), "utf8") : "blocked fixture path" }], isError: path !== basename(fixture) }); } }
  } });
}
function respond(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
