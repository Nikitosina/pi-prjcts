import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Per-project skill profiles: "all" goes to every profile, each role adds its own. Children use their role's set. */
export const SKILL_ROLES = ["coordinator", "worker", "scout", "reviewer"] as const;
export type SkillRole = typeof SKILL_ROLES[number];
const names = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512, uniqueItems: true });
export const SkillProfiles = Type.Object({ all: names, coordinator: names, worker: names, scout: names, reviewer: names }, { additionalProperties: false });
export type SkillProfiles = Static<typeof SkillProfiles>;
type Loader = Pick<ResourceLoader, "getSkills">;

const loaded = (loader?: Loader) => loader?.getSkills().skills ?? [];
/** Saved profiles, or the default for new and existing projects: repository skills in "all", nothing else. */
export function skillProfiles(saved: SkillProfiles | undefined, loader?: Loader): SkillProfiles {
  return saved ?? { all: loaded(loader).filter(skill => skill.sourceInfo.scope === "project").map(skill => skill.name), coordinator: [], worker: [], scout: [], reviewer: [] };
}
/** Names that no longer load are ignored. */
export function effectiveSkills(saved: SkillProfiles | undefined, loader: Loader | undefined, role: SkillRole): Skill[] {
  const profiles = skillProfiles(saved, loader), wanted = new Set([...profiles.all, ...profiles[role]]);
  return loaded(loader).filter(skill => wanted.has(skill.name));
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
