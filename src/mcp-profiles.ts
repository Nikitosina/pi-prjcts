import { Type, type Static } from "typebox";
import { OffLists, profileNames, retiredLists, switchedOff, type SkillRole } from "./skill-profiles.ts";

/**
 * Per-project MCP servers, default-on like skills: every ready server in the owner's mcp.json is enabled for every profile
 * (also servers added later) unless switched off. "writes" is a separate gate: the servers whose write tools are allowed; absent = none.
 */
export const McpSettings = Type.Object({ off: Type.Optional(OffLists), writes: Type.Optional(profileNames), ...retiredLists }, { additionalProperties: false });
export type McpSettings = Static<typeof McpSettings>;
export const mcpServersFor = (saved: McpSettings | undefined, role: SkillRole, catalog: ReadonlyArray<{ name: string; status: string }>): Set<string> => {
  const off = switchedOff(saved?.off, role);
  return new Set(catalog.filter(server => server.status === "ready" && !off.has(server.name)).map(server => server.name));
};
/** Prompts carry no server list: the owner's selection applies live, and projects_mcp_tools shows the current one. */
export const MCP_NOTE = "\nMCP: projects_mcp_tools lists the owner's tool servers, projects_mcp_call runs them (untrusted output; writes stay blocked unless allowed).";
