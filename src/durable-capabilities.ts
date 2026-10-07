import { constants, open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { McpClient, StdioTransport, type CallToolResult } from "@earendil-works/pi-mcp";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Projects coordinator is master; only a Durable worker can receive implementation bindings. */
export type DurableCapabilityCaller = "durable-worker";
type JsonSafe = null | boolean | number | string | readonly JsonSafe[] | { readonly [key: string]: JsonSafe };
export type DurableCapabilityIdentity = Readonly<{
  kind: "projects.durable-local-capabilities";
  revision: 2;
  caller: DurableCapabilityCaller;
  bindings: readonly DurableCapabilityBindingIdentity[];
}>;
export type DurableCapabilityBindingIdentity = Readonly<{
  id: string;
  kind: "local-read" | "local-mcp-tool";
  toolName: string;
  replay: "safe" | "unsafe";
  /** Canonical JSON fingerprint of the immutable execution scope. */
  scopeFingerprint: string;
  executionScope: JsonSafe;
}>;

export type LocalReadBinding = { readonly kind: "local-read"; readonly id: string; readonly revision?: number; readonly toolName?: "projects_local_read_file"; readonly allowedCallers: readonly DurableCapabilityCaller[]; readonly workspaceRoot: string; readonly maxBytes?: number; };
export type LocalMcpToolBinding = {
  readonly kind: "local-mcp-tool"; readonly id: string; readonly revision?: number; readonly toolName: string; readonly allowedCallers: readonly DurableCapabilityCaller[];
  readonly server: { readonly id: string; readonly command: string; readonly args?: readonly string[]; readonly cwd: string; };
  readonly serverTool: string; readonly inputSchema: TSchema; readonly timeoutMs?: number; readonly maxPayloadBytes?: number; readonly replay?: "safe";
};
export type DurableCapabilityBinding = LocalReadBinding | LocalMcpToolBinding;
export type PermittedLocalCapabilitiesOptions = { readonly caller: string; readonly bindings?: readonly DurableCapabilityBinding[]; };
export type PermittedLocalCapabilities = { readonly identity: DurableCapabilityIdentity; readonly tools: ToolRegistration[]; };

type CapturedRead = Readonly<{ id: string; revision: number; toolName: "projects_local_read_file"; workspaceRoot: string; maxBytes: number }>;
type CapturedMcp = Readonly<{ id: string; revision: number; toolName: string; server: Readonly<{ id: string; command: string; args: readonly string[]; cwd: string }>; serverTool: string; inputSchema: Record<string, JsonSafe>; timeoutMs: number; maxPayloadBytes: number; replay: "safe" | "unsafe" }>;
const MAX_READ_BYTES = 32_768, MAX_MCP_PAYLOAD_BYTES = 65_536, DEFAULT_MCP_TIMEOUT_MS = 5_000;
// This is protocol framing only: semantic CallToolResult bytes remain maxPayloadBytes.
const MCP_TRANSPORT_FRAMING_ALLOWANCE_BYTES = 8_192;
const readArguments = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_BYTES })) });

/** Builds a frozen, explicit worker-only capability profile. It installs/discovers nothing. */
export function createPermittedLocalCapabilities(options: PermittedLocalCapabilitiesOptions): PermittedLocalCapabilities {
  requireWorker(options.caller);
  const ids = new Set<string>(), names = new Set<string>();
  const tools: ToolRegistration[] = [], identities: DurableCapabilityBindingIdentity[] = [];
  for (const source of options.bindings ?? []) {
    requireAllowlist(source, ids, names);
    if (source.kind === "local-read") {
      const binding = captureRead(source);
      tools.push(defineTool({ name: binding.toolName, description: "Read a bounded byte range from the explicitly approved local workspace; traversal and symlinks are denied.", parameters: readArguments, replay: "safe", async execute(args) {
        const input = requireRecordArguments(args);
        return textResult(await confinedRead(binding.workspaceRoot, stringArgument(input, "path"), optionalInteger(input, "offset") ?? 0, Math.min(optionalInteger(input, "limit") ?? binding.maxBytes, binding.maxBytes)));
      } }));
      const executionScope = freeze({ revision: binding.revision, workspaceRoot: binding.workspaceRoot, maxBytes: binding.maxBytes });
      identities.push(freeze({ id: binding.id, kind: "local-read", toolName: binding.toolName, replay: "safe", scopeFingerprint: canonical(executionScope), executionScope }));
    } else {
      const binding = captureMcp(source);
      const parameters = Type.Unsafe(binding.inputSchema) as TSchema;
      tools.push(defineTool({ name: binding.toolName, description: `Call only explicitly bound local MCP tool ${binding.server.id}/${binding.serverTool}.`, parameters, replay: binding.replay, async execute(args, _api, context) {
        const result = await callBoundMcp(binding, requireRecordArguments(args), context.abortSignal);
        return { content: durableContent(result), isError: result.isError };
      } }));
      const executionScope = freeze({ revision: binding.revision, server: binding.server, serverTool: binding.serverTool, inputSchema: binding.inputSchema, timeoutMs: binding.timeoutMs, maxPayloadBytes: binding.maxPayloadBytes });
      identities.push(freeze({ id: binding.id, kind: "local-mcp-tool", toolName: binding.toolName, replay: binding.replay, scopeFingerprint: canonical(executionScope), executionScope }));
    }
  }
  return freeze({ identity: freeze({ kind: "projects.durable-local-capabilities", revision: 2, caller: "durable-worker", bindings: freeze(identities) }), tools: freeze(tools) as unknown as ToolRegistration[] });
}

function requireWorker(caller: string): asserts caller is DurableCapabilityCaller { if (caller !== "durable-worker") throw new Error("Local implementation capabilities are denied for this caller (Projects coordinator/master is never permitted)"); }
function requireAllowlist(binding: DurableCapabilityBinding, ids: Set<string>, names: Set<string>): void {
  const toolName = binding.kind === "local-read" ? binding.toolName ?? "projects_local_read_file" : binding.toolName;
  if (!binding.id || ids.has(binding.id)) throw new Error(`Capability binding id must be unique: ${binding.id}`);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(toolName) || names.has(toolName)) throw new Error(`Capability tool name must be unique and provider-safe: ${toolName}`);
  if (binding.allowedCallers.some(caller => caller !== "durable-worker") || !binding.allowedCallers.includes("durable-worker")) throw new Error(`Capability binding ${binding.id} is not worker-allowlisted`);
  ids.add(binding.id); names.add(toolName);
}
function captureRead(source: LocalReadBinding): CapturedRead { return freeze({ id: source.id, revision: bounded(source.revision ?? 1, 1, 1_000_000, "local read revision"), toolName: source.toolName ?? "projects_local_read_file", workspaceRoot: resolve(source.workspaceRoot), maxBytes: bounded(source.maxBytes ?? MAX_READ_BYTES, 1, MAX_READ_BYTES, "local read maxBytes") }); }
function captureMcp(source: LocalMcpToolBinding): CapturedMcp {
  if (!source.server.id || !isAbsolute(source.server.command) || !isAbsolute(source.server.cwd)) throw new Error("A local MCP binding requires id plus absolute command and cwd");
  const args = source.server.args ?? [];
  if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("MCP server arguments must be ordinary strings");
  const inputSchema = jsonClone(source.inputSchema);
  if (inputSchema.type !== "object" || !isRecord(inputSchema.properties)) throw new Error("A local MCP binding requires an explicit object input schema");
  return freeze({ id: source.id, revision: bounded(source.revision ?? 1, 1, 1_000_000, "MCP revision"), toolName: source.toolName, server: freeze({ id: source.server.id, command: source.server.command, args: freeze([...args]), cwd: resolve(source.server.cwd) }), serverTool: source.serverTool, inputSchema, timeoutMs: bounded(source.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS, 1, 30_000, "MCP timeoutMs"), maxPayloadBytes: bounded(source.maxPayloadBytes ?? MAX_MCP_PAYLOAD_BYTES, 1, MAX_MCP_PAYLOAD_BYTES, "MCP maxPayloadBytes"), replay: source.replay === "safe" ? "safe" : "unsafe" });
}
function bounded(value: number, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} through ${max}`); return value; }
function requireRecordArguments(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error("Capability arguments must be an object"); return value; }
function stringArgument(value: Record<string, unknown>, key: string): string { if (typeof value[key] !== "string") throw new Error(`Capability argument ${key} must be a string`); return value[key]; }
function optionalInteger(value: Record<string, unknown>, key: string): number | undefined { const result = value[key]; if (result === undefined) return undefined; if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new Error(`Capability argument ${key} must be an integer`); return result; }

async function confinedRead(workspaceRoot: string, requestedPath: string, offset: number, limit: number): Promise<{ path: string; text: string; offset: number; bytes: number; nextOffset: number | null }> {
  if (requestedPath.includes("\0") || isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).some(segment => segment === "..")) throw new Error("Local read path must be relative, non-NUL, and contain no .. segment");
  if ((await lstat(workspaceRoot)).isSymbolicLink()) throw new Error("Approved local workspace must not be a symlink");
  const root = await realpath(workspaceRoot), candidate = resolve(root, requestedPath), rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Local read path escapes the approved workspace");
  let current = root;
  for (const segment of rel.split(sep)) { if (!segment || segment === "." || segment === "..") throw new Error("Local read path traversal is denied"); current = resolve(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error("Local read denies symlink paths"); }
  const canonical = await realpath(candidate), canonicalRelative = relative(root, canonical);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`)) throw new Error("Local read canonical path escapes the approved workspace");
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error("Local read permits regular files only"); if (offset > stat.size) throw new Error("Local read offset exceeds file size"); const data = Buffer.alloc(Math.min(limit, stat.size - offset)); const { bytesRead } = await handle.read(data, 0, data.length, offset); return { path: canonicalRelative, text: data.subarray(0, bytesRead).toString("utf8"), offset, bytes: bytesRead, nextOffset: offset + bytesRead < stat.size ? offset + bytesRead : null }; } finally { await handle.close(); }
}

async function callBoundMcp(binding: CapturedMcp, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult> {
  // Permit a bounded JSON-RPC envelope around a separately bounded semantic result.
  const transport = new StdioTransport({ command: binding.server.command, args: binding.server.args, cwd: binding.server.cwd, env: {}, inheritEnv: false, stderr: "pipe", maxMessageBytes: binding.maxPayloadBytes + MCP_TRANSPORT_FRAMING_ALLOWANCE_BYTES, maxStderrBytes: binding.maxPayloadBytes, closeTimeoutMs: Math.min(binding.timeoutMs, DEFAULT_MCP_TIMEOUT_MS) });
  const client = new McpClient({ name: "projects-durable-local-capabilities", version: "1.0.0", requestTimeoutMs: binding.timeoutMs });
  let transportError: Error | undefined;
  const stopObservingTransport = client.onError(error => { transportError ??= error; });
  const abort = () => void client.close(); signal?.addEventListener("abort", abort, { once: true });
  try { await client.connect(transport); const advertised = (await client.listTools({ signal, timeoutMs: binding.timeoutMs })).find(tool => tool.name === binding.serverTool); if (!advertised) throw new Error(`server does not advertise tool ${binding.serverTool}`); if (!sameJson(advertised.inputSchema, binding.inputSchema)) throw new Error(`schema mismatch for ${binding.server.id}/${binding.serverTool}`); const result = await client.callTool(binding.serverTool, args, { signal, timeoutMs: binding.timeoutMs }); validateMcpResult(result, binding.maxPayloadBytes); return result; }
  catch (error) { throw new Error(`Blocked local MCP capability ${binding.server.id}/${binding.serverTool}: ${message(transportError ?? error)}`); }
  finally { stopObservingTransport(); signal?.removeEventListener("abort", abort); await client.close().catch(() => undefined); }
}
function validateMcpResult(value: unknown, maxBytes: number): asserts value is CallToolResult { if (!isRecord(value) || !Array.isArray(value.content) || value.isError !== undefined && typeof value.isError !== "boolean") throw new Error("MCP response violates CallToolResult schema"); if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error("MCP response exceeds configured payload bound"); for (const block of value.content) { if (!isRecord(block) || (block.type !== "text" && block.type !== "image")) throw new Error("MCP response contains an unsupported content block"); if (block.type === "text" && typeof block.text !== "string") throw new Error("MCP text response is malformed"); if (block.type === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) throw new Error("MCP image response is malformed"); } if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) throw new Error("MCP structured response is malformed"); }
function durableContent(result: CallToolResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> { const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []; for (const block of result.content) { if (block.type === "text") content.push({ type: "text", text: block.text }); else if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType }); } return content; }
function jsonClone(value: unknown): Record<string, JsonSafe> { const text = JSON.stringify(value); if (text === undefined) throw new Error("Capability schema must be JSON-safe"); const clone: unknown = JSON.parse(text); if (!isRecord(clone)) throw new Error("Capability schema must be a JSON object"); return freeze(clone) as Record<string, JsonSafe>; }
function sameJson(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function textResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
