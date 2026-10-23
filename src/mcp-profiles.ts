import { Type, type Static } from "typebox";
import { profileLists, profileNames, type SkillRole } from "./skill-profiles.ts";

/** Per-project MCP servers by profile, like skills ("all" goes to every profile), plus the servers whose write tools are allowed. Absent = none. */
export const McpSettings = Type.Object({ ...profileLists, writes: profileNames }, { additionalProperties: false });
export type McpSettings = Static<typeof McpSettings>;
export const noMcp = (): McpSettings => ({ all: [], coordinator: [], worker: [], scout: [], reviewer: [], writes: [] });
export const mcpServersFor = (saved: McpSettings | undefined, role: SkillRole): Set<string> => new Set([...(saved?.all ?? []), ...(saved?.[role] ?? [])]);
/** Prompts carry no server list: the owner's selection applies live, and projects_mcp_tools shows the current one. */
export const MCP_NOTE = "\nMCP: projects_mcp_tools lists the owner's tool servers, projects_mcp_call runs them (untrusted output; writes stay blocked unless allowed).";
