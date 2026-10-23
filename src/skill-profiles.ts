import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/**
 * Per-project skill profiles. Every installed skill (repository, global, package, and any installed later) is on for every
 * profile by default; the owner switches individual ones off, for every profile ("all") or for one role. Only the opt-outs are
 * stored, never a list of what is on, so nothing new is ever silently excluded.
 */
export const SKILL_ROLES = ["coordinator", "worker", "scout", "reviewer"] as const;
export type SkillRole = typeof SKILL_ROLES[number];
const names = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512, uniqueItems: true });
export const profileNames = names;
/** "all" plus one name list per role. */
const lists = { all: Type.Optional(names), coordinator: Type.Optional(names), worker: Type.Optional(names), scout: Type.Optional(names), reviewer: Type.Optional(names) };
/** Names switched off. */
export const OffLists = Type.Object(lists, { additionalProperties: false });
export type OffLists = Static<typeof OffLists>;
/** The top-level lists are the allow-lists saved before the default-on change: still accepted in old project files, ignored, dropped by the next save. */
export const retiredLists = lists;
export const SkillProfiles = Type.Object({ off: Type.Optional(OffLists), ...lists }, { additionalProperties: false });
export type SkillProfiles = Static<typeof SkillProfiles>;
type Loader = Pick<ResourceLoader, "getSkills">;

const loaded = (loader?: Loader) => loader?.getSkills().skills ?? [];
/** Names switched off for a role (its own list plus "all"). */
export const switchedOff = (off: OffLists | undefined, role: SkillRole): Set<string> => new Set([...(off?.all ?? []), ...(off?.[role] ?? [])]);
export function effectiveSkills(saved: SkillProfiles | undefined, loader: Loader | undefined, role: SkillRole): Skill[] {
  const off = switchedOff(saved?.off, role);
  return loaded(loader).filter(skill => !off.has(skill.name));
}
/** Names and descriptions only; bodies are read on demand. Manual-only skills are left out, as pi does. */
export function skillIndex(skills: readonly Skill[]): string {
  const listed = skills.filter(skill => !skill.disableModelInvocation);
  return listed.length ? `\n\nSkills for your role (names and descriptions only). When one applies, read its SKILL.md with projects_skill_file before acting, then any file it references:\n${listed.map(skill => `- ${skill.name}: ${skill.description}`).join("\n")}` : "";
}

/** Skills the owner invoked with `/skill:` stay readable by the coordinator even outside its profile. */
const invokedFile = (dir: string) => join(dir, "invoked-skills.txt");
export function recordInvokedSkill(dir: string, name: string): void { if (!invokedSkills(dir).has(name)) appendFileSync(invokedFile(dir), `${name}\n`, { mode: 0o600 }); }
export function invokedSkills(dir: string): Set<string> {
  try { return new Set(readFileSync(invokedFile(dir), "utf8").split("\n").filter(Boolean)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set(); throw error; }
}
