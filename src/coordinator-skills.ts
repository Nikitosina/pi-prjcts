import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseFrontmatter, type ResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** Owner-invoked skills: `/skill:<name> args` in the composer, expanded like pi does before it reaches the coordinator. */
type Loader = Pick<ResourceLoader, "getSkills">;
export type SkillSource = "repo" | "global" | "package";
export const SKILL_COMMAND = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/;
/** pi's own block format, so a transcript row can be shown as a compact chip. */
export const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
const SKILL_TEXT_LIMIT = 120_000;

function source(skill: Skill): SkillSource {
  return skill.sourceInfo.scope === "project" ? "repo" : skill.sourceInfo.origin === "package" ? "package" : "global";
}
const order: Record<SkillSource, number> = { repo: 0, global: 1, package: 2 };

export function listSkills(loader: Loader) {
  return loader.getSkills().skills
    .map(skill => ({ name: skill.name, description: skill.description, source: source(skill), manual: skill.disableModelInvocation }))
    .sort((left, right) => order[left.source] - order[right.source] || left.name.localeCompare(right.name));
}

/** Returns the text for the model, or the input unchanged when it is not a skill command. An unknown skill is an error, never sent as text. */
export async function expandSkillCommand(loader: Loader, text: string): Promise<string> {
  const match = SKILL_COMMAND.exec(text.trim());
  if (!match) return text;
  const skill = loader.getSkills().skills.find(item => item.name === match[1]);
  if (!skill) throw new Error(`Unknown skill /skill:${match[1]}. Pick one from the / list.`);
  const body = parseFrontmatter(await readFile(skill.filePath, "utf8")).body.trim();
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  const args = match[2]?.trim();
  const expanded = args ? `${block}\n\n${args}` : block;
  if (expanded.length > SKILL_TEXT_LIMIT) throw new Error(`Skill ${skill.name} is too large to send (${expanded.length} characters)`);
  return expanded;
}

/** Shows `/skill:<name> args` instead of the whole skill body. */
export function compactSkillText(text: string): string {
  const match = SKILL_BLOCK.exec(text);
  return match ? `/skill:${match[1]}${match[3] ? ` ${match[3]}` : ""}` : text;
}

export function coordinatorSkillTool(input: { loader?: Loader; root: () => Conversation | undefined }) {
  const tool = defineTool({
    name: "projects_skill_file",
    description: "Read a file that belongs to a pi skill, e.g. a reference an invoked <skill> block mentions. path is relative to the skill's directory (default SKILL.md). Paged by characters.",
    parameters: Type.Object({ skill: Type.String({ minLength: 1, maxLength: 128 }), path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40000 })) }, { additionalProperties: false }),
    replay: "safe",
    async execute(args, api: ToolExecutionApi) {
      const root = input.root();
      if (!root || api.conversationId !== root.id) throw new Error("Skill files are coordinator-only");
      const skill = input.loader?.getSkills().skills.find(item => item.name === args.skill);
      if (!skill) throw new Error(`Unknown skill ${args.skill}`);
      // Checked lexically first, then again after symlinks resolve.
      const escapes = (from: string, to: string) => { const inside = relative(from, to); return isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`); };
      const requested = resolve(skill.baseDir, args.path ?? "SKILL.md");
      if (escapes(resolve(skill.baseDir), requested)) throw new Error("Path escapes the skill directory");
      const base = await realpath(skill.baseDir);
      const target = await realpath(requested).catch(() => { throw new Error(`No file ${args.path ?? "SKILL.md"} in skill ${skill.name}`); });
      if (escapes(base, target)) throw new Error("Path escapes the skill directory");
      const inside = relative(base, target);
      if (!(await lstat(target)).isFile()) throw new Error("Not a file");
      const text = await readFile(target, "utf8"), offset = args.offset ?? 0, limit = args.limit ?? 20000;
      return { content: [{ type: "text" as const, text: JSON.stringify({ skill: skill.name, path: inside, offset, nextOffset: offset + limit < text.length ? offset + limit : null, totalCharacters: text.length, text: text.slice(offset, offset + limit) }) }] };
    },
  });
  return { tool, extension: defineExtension({ name: "projects.coordinator-skills", tools: [tool] }) };
}
