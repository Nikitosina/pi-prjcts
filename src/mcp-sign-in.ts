import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { McpAbortError, McpHttpError, McpTimeoutError } from "@earendil-works/pi-mcp";
import type { McpOAuthSettings } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js";

type PiOAuth = typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js");
const require = createRequire(import.meta.url);
let loaded: PiOAuth | undefined;
class OAuthAdapterError extends Error {}

/** Pi's private credential/refresh helpers are pinned together so its rotating-token lock stays shared with the CLI. */
function sdk(): PiOAuth {
  if (loaded) return loaded;
  const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const metadata: unknown = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
  if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || metadata.version !== "1.4.0")
    throw new OAuthAdapterError("Projects MCP OAuth requires Pi SDK 1.4.0; check the pinned OAuth adapter before upgrading");
  const candidate: PiOAuth = require(join(dist, "extensions", "mcp", "oauth.js"));
  if (
    typeof candidate.McpOAuthCredentialStore !== "function" ||
    typeof candidate.createMcpAuthProvider !== "function" ||
    typeof candidate.McpOAuthCredentialStore.prototype.forServer !== "function" ||
    typeof candidate.McpOAuthCredentialStore.prototype.tokens !== "function"
  )
    throw new OAuthAdapterError("Pi SDK OAuth helpers changed; check the pinned Projects OAuth adapter");
  loaded = candidate;
  return loaded;
}

/** Catalog reads must not create an empty credential file or take over legacy credentials. */
export function hasMcpOAuth(name: string, url: string): boolean {
  if (!existsSync(join(getAgentDir(), "mcp-auth.json"))) return false;
  try {
    return Boolean(new (sdk().McpOAuthCredentialStore)().tokens(name, url));
  } catch (error) {
    if (error instanceof OAuthAdapterError) throw error;
    throw new Error(`Pi MCP credentials are unreadable; run pi mcp login ${name}`);
  }
}

export function createMcpOAuth(name: string, url: string, settings: McpOAuthSettings = {}) {
  const pi = sdk();
  const serverUrl = new URL(url).href;
  const store = new pi.McpOAuthCredentialStore().forServer(name, serverUrl);
  const provider = pi.createMcpAuthProvider({
    serverUrl,
    store: {
      ...store,
      async load() {
        const state = await store.load();
        return state?.serverUrl === serverUrl ? state : undefined;
      },
    },
    settings: () => settings,
    onChallenge: () => {},
  });
  if (typeof provider.token !== "function" || typeof provider.onUnauthorized !== "function" || typeof provider.settled !== "function")
    throw new OAuthAdapterError("Pi SDK OAuth provider changed; check the pinned Projects OAuth adapter");
  const failed = () => mcpOAuthFailure(name);
  return {
    async token() {
      try {
        return await provider.token();
      } catch {
        throw failed();
      }
    },
    async onUnauthorized(context: Parameters<NonNullable<typeof provider.onUnauthorized>>[0]) {
      try {
        await provider.onUnauthorized?.(context);
      } catch {
        throw failed();
      }
    },
    settled: () => provider.settled(),
  };
}

/** Never forward an authenticated server's response body or an OAuth exception containing credentials. */
export function mcpOAuthFailure(name: string, error?: unknown): Error {
  if (error instanceof McpTimeoutError) return new Error(`MCP server ${name} request timed out`);
  if (error instanceof McpAbortError) return new Error(`MCP server ${name} request aborted`);
  if (error instanceof McpHttpError && error.status !== 401 && error.status !== 403)
    return new Error(`MCP server ${name} HTTP request failed (${error.status})`);
  return new Error(`MCP OAuth request failed; retry or run pi mcp login ${name} (Projects never opens a browser)`);
}
