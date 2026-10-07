import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { captureRepositorySkillCandidate } from "./worker-skill-catalog.ts";
import { SKILL_CATALOG_LIMITS, type WorkerSkillCandidate } from "./worker-skill-types.ts";

type Input = Pick<Parameters<typeof captureRepositorySkillCandidate>[0], "repositoryId" | "ownerCheckout" | "protectedFiles">;
type Diagnostic = { path: string; fingerprint: string };
const entryLimit = 4096, candidateLimit = SKILL_CATALOG_LIMITS.candidates, byteLimit = SKILL_CATALOG_LIMITS.bytes, depthLimit = 8;

async function optionalFacts(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

export async function discoverRepositorySkills(input: Input): Promise<{ candidates: WorkerSkillCandidate[]; diagnostics: Diagnostic[] }> {
  const repository = await realpath(input.ownerCheckout), rootFacts = await lstat(repository, { bigint: true });
  if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink()) throw new Error("Repository skill discovery requires a regular owned directory");
  const candidates: WorkerSkillCandidate[] = [], diagnostics: Diagnostic[] = [];
  let entries = 0, attempted = 0, bytes = 0;
  async function capture(directory: string, mainFile: string) {
    if (++attempted > candidateLimit) throw new Error("Repository skill candidate limit exceeded");
    const facts = await optionalFacts(join(directory, mainFile));
    const reserved = facts && facts.size > 0n ? Number(facts.size) : 0;
    if (!Number.isSafeInteger(reserved) || reserved > byteLimit - bytes) throw new Error("Repository skill discovery byte budget exceeded");
    bytes += reserved;
    let candidate: WorkerSkillCandidate;
    try {
      candidate = await captureRepositorySkillCandidate({ ...input, ownerCheckout: repository, skillDirectory: directory, mainFile });
    } catch (error) {
      if (error instanceof AggregateError) throw error;
      diagnostics.push({ path: relative(repository, join(directory, mainFile)), fingerprint: createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex") });
      return;
    }
    bytes += Math.max(0, candidate.main.size - reserved);
    if (bytes > byteLimit) throw new Error("Captured repository skill documents exceed the byte budget");
    candidates.push(candidate);
  }
  async function walk(directory: string, depth: number) {
    if (depth > depthLimit) throw new Error("Repository skill discovery depth limit exceeded");
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Repository skill discovery refuses symlinked/nonregular directories");
    const main = await optionalFacts(join(directory, "SKILL.md"));
    if (main) {
      await capture(directory, "SKILL.md");
    } else {
      const handle = await opendir(directory);
      let outcome: { kind: "done" } | { kind: "failed"; error: unknown };
      try {
        for (;;) {
          const entry = await handle.read();
          if (!entry) break;
          if (++entries > entryLimit) throw new Error("Repository skill discovery entry limit exceeded");
          const path = join(directory, entry.name), facts = await lstat(path, { bigint: true });
          if (facts.isSymbolicLink()) throw new Error("Repository skill discovery refuses symlinked entries");
          if (facts.isDirectory()) await walk(path, depth + 1);
          else if (depth === 0 && facts.isFile() && entry.name.endsWith(".md")) await capture(directory, entry.name);
        }
        outcome = { kind: "done" };
      } catch (error) { outcome = { kind: "failed", error }; }
      try { await handle.close(); }
      catch (error) {
        if (outcome.kind === "failed") throw new AggregateError([outcome.error, error], "Repository skill discovery and directory close failed");
        throw error;
      }
      if (outcome.kind === "failed") throw outcome.error;
    }
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || await realpath(directory) !== directory) throw new Error("Repository skill discovery directory changed");
  }
  for (const parentName of [".pi", ".agents"]) {
    const parent = join(repository, parentName), parentFacts = await optionalFacts(parent);
    if (!parentFacts) continue;
    if (!parentFacts.isDirectory() || parentFacts.isSymbolicLink()) throw new Error("Repository skill discovery parent is not regular");
    const directory = join(parent, "skills"), facts = await optionalFacts(directory);
    if (facts) await walk(directory, 0);
    const after = await lstat(parent, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || parentFacts.dev !== after.dev || parentFacts.ino !== after.ino) throw new Error("Repository skill discovery parent changed");
  }
  const after = await lstat(repository, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || rootFacts.dev !== after.dev || rootFacts.ino !== after.ino) throw new Error("Repository skill discovery root changed");
  return { candidates, diagnostics };
}
