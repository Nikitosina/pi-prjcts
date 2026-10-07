import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { parse } from "./state.ts";
import { captureWorkerSkillDocument, readWorkerSkillDocument } from "./worker-skill-files.ts";
import { WorkerSkillCandidate, WorkerSkillOrigin, type WorkerSkillCandidate as Candidate } from "./worker-skill-types.ts";

const Frontmatter = Type.Object({
  name: Type.Optional(Type.String({ maxLength: 64 })),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  "disable-model-invocation": Type.Optional(Type.Boolean()),
});
type ProtectedFiles = Parameters<typeof captureWorkerSkillDocument>[0]["protectedFiles"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function captureCandidate(input: { origin: Static<typeof WorkerSkillOrigin>; relativePath: string; fallbackName: string; protectedFiles: ProtectedFiles }): Promise<Candidate> {
  const main = await captureWorkerSkillDocument({ root: input.origin.root, relativePath: input.relativePath, protectedFiles: input.protectedFiles });
  const text = await readWorkerSkillDocument({ root: input.origin.root, document: main, protectedFiles: input.protectedFiles });
  const frontmatter = parse(Frontmatter, parseFrontmatter(text).frontmatter);
  if (!frontmatter.description.trim()) throw new Error("Skill has no usable routing description");
  const metadata = { origin: input.origin, main, name: frontmatter.name || input.fallbackName, description: frontmatter.description, disableModelInvocation: frontmatter["disable-model-invocation"] === true };
  return parse(WorkerSkillCandidate, { ...metadata, catalogId: hash(JSON.stringify(metadata)) });
}

export async function captureRepositorySkillCandidate(input: { repositoryId: string; ownerCheckout: string; skillDirectory: string; mainFile: string; protectedFiles: ProtectedFiles }): Promise<Candidate> {
  const repository = await realpath(input.ownerCheckout), root = resolve(input.skillDirectory);
  if (await realpath(root) !== root) throw new Error("Repository skill directory must not be a symlink alias");
  const path = relative(repository, root);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) || ![".pi/skills", ".agents/skills"].some(prefix => path === prefix || path.startsWith(`${prefix}/`))) throw new Error("Repository skill directory is outside its repository-local skill roots");
  let directory = repository;
  for (const part of path.split(sep)) {
    directory = resolve(directory, part);
    const facts = await lstat(directory);
    if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("Repository skill directory ancestry is not regular");
  }
  return captureCandidate({ origin: parse(WorkerSkillOrigin, { kind: "repository", repositoryId: input.repositoryId, root }), relativePath: input.mainFile, fallbackName: basename(root), protectedFiles: input.protectedFiles });
}

export async function captureConfiguredSkillCandidate(input: { skill: Skill; protectedFiles: ProtectedFiles }): Promise<Candidate> {
  const skill = input.skill;
  const lexicalRoot = resolve(skill.baseDir), root = await realpath(lexicalRoot), file = resolve(skill.filePath), mainFile = relative(lexicalRoot, file);
  if (isAbsolute(mainFile) || mainFile === ".." || mainFile.startsWith(`..${sep}`)) throw new Error("Configured skill main file is outside its SDK directory");
  const named = await lstat(file);
  if (!named.isFile() || named.isSymbolicLink()) throw new Error("Configured skill main file must not be a symlink or special file");
  const candidate = await captureCandidate({ origin: parse(WorkerSkillOrigin, { kind: "configured", source: `pi-configured:${hash(JSON.stringify(skill.sourceInfo))}`, root }), relativePath: mainFile, fallbackName: basename(lexicalRoot), protectedFiles: input.protectedFiles });
  if (candidate.name !== skill.name || candidate.description !== skill.description || candidate.disableModelInvocation !== skill.disableModelInvocation) throw new Error("Configured skill metadata changed since its SDK catalog; rediscover before selecting it");
  return candidate;
}
