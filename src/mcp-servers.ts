import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { McpAbortError, McpClient, McpTimeoutError, StdioTransport, StreamableHttpTransport, type CallToolResult, type Tool } from "@earendil-works/pi-mcp";

/** The owner's MCP servers (pi's `mcp.json`), owned by the host: one lazy connection per server and working directory. */
export type McpStatus = "ready" | "disabled" | "needs-sign-in" | "invalid";
export type McpServerInfo = { name: string; transport: "stdio" | "http"; description: string; status: McpStatus; detail?: string };
type Config = McpServerInfo & { command?: string; args: string[]; env: Record<string, string>; cwd?: string; url?: string; headers: Record<string, string>; timeoutMs: number };

const DEFAULT_TIMEOUT_MS = 60_000, IDLE_MS = 10 * 60_000, SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** Test seam: PI_PROJECTS_MCP_CONFIG replaces the owner's file. */
export const mcpConfigPath = () => process.env.PI_PROJECTS_MCP_CONFIG || join(getAgentDir(), "mcp.json");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): Record<string, string> | null => isRecord(value) && Object.values(value).every(item => typeof item === "string") ? value as Record<string, string> : null;
/** `${VAR}` reads the host environment. `!command` values are never executed: the server is marked invalid instead. */
const resolveValue = (value: string): string | null => value.startsWith("!") ? null : value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
function resolveAll(values: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) { const resolved = resolveValue(value); if (resolved === null) return null; out[key] = resolved; }
  return out;
}

function parseServer(name: string, raw: unknown): Config {
  const base = { name, args: [] as string[], env: {} as Record<string, string>, headers: {} as Record<string, string>, timeoutMs: DEFAULT_TIMEOUT_MS };
  const invalid = (detail: string, transport: "stdio" | "http" = "stdio"): Config => ({ ...base, transport, description: "", status: "invalid", detail });
  if (!SERVER_NAME.test(name)) return invalid("invalid server name");
  if (!isRecord(raw)) return invalid("not an object");
  const timeoutMs = typeof raw.timeout === "number" && raw.timeout > 0 ? Math.min(raw.timeout * 1000, 600_000) : DEFAULT_TIMEOUT_MS;
  const describe = (fallback: string) => typeof raw.description === "string" && raw.description ? raw.description.slice(0, 300) : fallback;
  const state = (needsSignIn: boolean): McpStatus => raw.enabled === false ? "disabled" : needsSignIn ? "needs-sign-in" : "ready";
  if (typeof raw.url === "string") {
    const headers = strings(raw.headers ?? {}), url = URL.canParse(raw.url) ? new URL(raw.url) : null;
    if (!url || !/^https?:$/.test(url.protocol) || !headers) return invalid("bad url or headers", "http");
    const resolved = resolveAll(headers);
    if (!resolved) return invalid("headers use !command values (unsupported)", "http");
    return { ...base, timeoutMs, transport: "http", url: raw.url, headers: resolved, description: describe(`http: ${url.origin}`), status: state(raw.oauth !== undefined || raw.auth !== undefined), ...(raw.oauth !== undefined || raw.auth !== undefined ? { detail: "Needs an interactive sign-in, which Projects does not run" } : {}) };
  }
  if (typeof raw.command === "string") {
    const env = strings(raw.env ?? {}), args = Array.isArray(raw.args) && raw.args.every(item => typeof item === "string") ? raw.args as string[] : raw.args === undefined ? [] : null;
    if (!env || !args) return invalid("bad args or env");
    const resolvedEnv = resolveAll(env), resolvedArgs = args.map(resolveValue);
    if (!resolvedEnv || resolvedArgs.includes(null)) return invalid("uses !command values (unsupported)");
    return { ...base, timeoutMs, transport: "stdio", command: raw.command, args: resolvedArgs as string[], env: resolvedEnv, ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}), description: describe(`stdio: ${basename(raw.command)}`), status: state(false) };
  }
  return invalid("needs a command or a url");
}

function readConfigs(): { path: string; configs: Config[]; error?: string } {
  const path = mcpConfigPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { return { path, configs: [], ...(error instanceof Error && "code" in error && error.code === "ENOENT" ? {} : { error: "mcp.json is unreadable" }) }; }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return { path, configs: [], error: "mcp.json has no mcpServers object" };
    return { path, configs: Object.entries(parsed.mcpServers).map(([name, raw]) => parseServer(name, raw)).sort((a, b) => a.name.localeCompare(b.name)) };
  } catch { return { path, configs: [], error: "mcp.json is not valid JSON" }; }
}
/** Names, descriptions and status only; env, headers and arguments never leave the host. */
export function mcpCatalog(): { path: string; servers: McpServerInfo[]; error?: string } {
  const { path, configs, error } = readConfigs();
  return { path, servers: configs.map(({ name, transport, description, status, detail }) => ({ name, transport, description, status, ...(detail ? { detail } : {}) })), ...(error ? { error } : {}) };
}

/** Write classification: tool annotations when present, else the name's words. */
const WRITE_WORDS = new Set(["create", "update", "delete", "start", "cancel", "interrupt", "force", "transition", "merge", "publish", "set", "add", "move", "bulk", "change", "remove", "write", "edit", "send", "post", "close", "reopen", "assign", "link", "unlink", "approve", "retry", "rerun", "restart", "stop", "kill", "purge", "drop", "run", "execute", "deploy", "trigger", "upload", "install", "patch", "put", "rename", "reset"]);
export function isWriteTool(tool: Pick<Tool, "name" | "annotations">): boolean {
  const hints = tool.annotations;
  if (hints?.readOnlyHint === true) return false;
  if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return true;
  return tool.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).some(word => WRITE_WORDS.has(word));
}

type Entry = { client: McpClient; tools?: Promise<Tool[]>; timer?: ReturnType<typeof setTimeout>; config: Config };
export class McpUnavailableError extends Error {}
export function createMcpPool() {
  const entries = new Map<string, Promise<Entry>>();
  const config = (server: string): Config => {
    const found = readConfigs().configs.find(item => item.name === server);
    if (!found) throw new McpUnavailableError(`MCP server ${server} is unknown: it is not in the owner's mcp.json`);
    if (found.status === "disabled") throw new McpUnavailableError(`MCP server ${server} is disabled in mcp.json`);
    if (found.status === "needs-sign-in") throw new McpUnavailableError(`MCP server ${server} needs an interactive sign-in, which is not supported here (needs-sign-in)`);
    if (found.status === "invalid") throw new McpUnavailableError(`MCP server ${server} has an invalid configuration (${found.detail ?? "invalid"})`);
    return found;
  };
  const forget = (key: string, entry: Promise<Entry>) => { if (entries.get(key) === entry) entries.delete(key); };
  const drop = async (key: string, entry: Promise<Entry>) => { forget(key, entry); const value = await entry.catch(() => undefined); if (value) { clearTimeout(value.timer); await value.client.close().catch(() => undefined); } };
  function open(key: string, cfg: Config, cwd: string): Promise<Entry> {
    const present = entries.get(key);
    if (present) {
      const reopen = () => { forget(key, present); return open(key, cfg, cwd); };
      return present.then(value => value.client.connectionState === "connected" ? value : reopen(), reopen);
    }
    const entry = (async (): Promise<Entry> => {
      const client = new McpClient({ name: "pi-projects", version: "1.0.0", requestTimeoutMs: cfg.timeoutMs });
      const transport = cfg.transport === "stdio"
        ? new StdioTransport({ command: cfg.command!, args: cfg.args, cwd: cfg.cwd ?? cwd, env: cfg.env, inheritEnv: true, stderr: "pipe" })
        : new StreamableHttpTransport({ url: cfg.url!, headers: cfg.headers });
      await client.connect(transport);
      const made: Entry = { client, config: cfg };
      client.onClose(() => { clearTimeout(made.timer); forget(key, entry); });
      return made;
    })();
    entries.set(key, entry);
    entry.catch(() => forget(key, entry));
    return entry;
  }
  /** One connection per server and cwd (XcodeBuildMCP reads its config from the cwd). Idle connections close. */
  async function use<T>(server: string, cwd: string, run: (entry: Entry) => Promise<T>): Promise<T> {
    const cfg = config(server), key = `${server}\0${cfg.cwd ?? cwd}`;
    const pending = open(key, cfg, cwd);
    let entry: Entry;
    try { entry = await pending; }
    catch (error) { throw new Error(`MCP server ${server} could not start: ${(error as Error).message}`); }
    clearTimeout(entry.timer);
    try { return await run(entry); }
    catch (error) {
      // A timed-out, crashed or closed connection is discarded; the next call reconnects.
      if (error instanceof McpTimeoutError || error instanceof McpAbortError || entry.client.connectionState !== "connected") await drop(key, pending);
      throw error;
    }
    finally { entry.timer = setTimeout(() => { void drop(key, pending); }, IDLE_MS); entry.timer.unref?.(); }
  }
  return {
    tools: (server: string, cwd: string): Promise<Tool[]> => use(server, cwd, entry => entry.tools ??= entry.client.listTools({ timeoutMs: entry.config.timeoutMs }).catch(error => { entry.tools = undefined; throw error; })),
    call: (server: string, cwd: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> => use(server, cwd, entry => entry.client.callTool(tool, args, { signal, timeoutMs: entry.config.timeoutMs })),
    async close() { await Promise.allSettled([...entries].map(([key, entry]) => drop(key, entry))); },
  };
}
export type McpPool = ReturnType<typeof createMcpPool>;
export const mcpPool: McpPool = createMcpPool();
