import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** Bounded repository standing resources; knowledge documents are intentionally never read here. */
export type DurableStanding = Readonly<{ revision: string; text: string; paths: readonly string[] }>;
export function loadDurableStanding(cwd: string): DurableStanding {
  const root = realpathSync(resolve(cwd));
  const rootFacts = lstatSync(root);
  if (!rootFacts.isDirectory()) throw new Error("Repository standing root must be a directory");
  const piRoot = join(root, ".pi"), piFacts = optionalFacts(piRoot);
  if (piFacts && (piFacts.isSymbolicLink() || !piFacts.isDirectory())) throw new Error("Repository .pi standing directory must be a regular directory, not a symlink");
  const candidates = ["AGENTS.md", "INSTRUCTIONS.md", ".pi/instructions.md", ".pi/skills.md"];
  const found: string[] = []; const chunks: string[] = [];
  for (const relative of candidates) {
    const path = join(root, relative), facts = optionalFacts(path);
    if (!facts) continue;
    if (facts.isSymbolicLink() || !facts.isFile()) throw new Error(`Repository standing resource must be a regular file, not a symlink: ${relative}`);
    const text = readStandingFile(path, relative, facts);
    if (!sameDirectory(rootFacts, lstatSync(root))) throw new Error("Repository standing root changed during reading");
    if (relative.startsWith(".pi/") && (!piFacts || !sameDirectory(piFacts, lstatSync(piRoot)))) throw new Error("Repository .pi standing directory changed during reading");
    found.push(relative); chunks.push(`## ${relative}\n${text}`);
  }
  if (!sameDirectory(rootFacts, lstatSync(root))) throw new Error("Repository standing root changed during reading");
  const text = chunks.join("\n\n");
  return { revision: `${found.join(",")}:${text.length}:${hash(text)}`, text, paths: found };
}
function optionalFacts(path: string) {
  try { return lstatSync(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}
type StandingFacts = NonNullable<ReturnType<typeof optionalFacts>>;
function sameDirectory(before: StandingFacts, after: StandingFacts): boolean {
  return after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino;
}
function sameFile(before: StandingFacts, after: StandingFacts): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function readStandingFile(path: string, relative: string, expected: StandingFacts): string {
  const maxBytes = 64_000;
  if (expected.size > maxBytes) throw new Error(`Repository standing resource exceeds ${maxBytes} bytes: ${relative}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const before = fstatSync(fd);
    if (!sameFile(expected, before) || realpathSync(path) !== path) throw new Error(`Repository standing resource changed or escaped its root: ${relative}`);
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw new Error(`Repository standing resource exceeds ${maxBytes} bytes: ${relative}`);
    if (length !== before.size || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(path)) || realpathSync(path) !== path) throw new Error(`Repository standing resource changed during reading: ${relative}`);
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    if (text.length > 16_000) throw new Error(`Repository standing resource exceeds 16000 UTF-16 code units; split the instructions instead of truncating: ${relative}`);
  } catch (primary) {
    try { closeSync(fd); } catch (cleanup) { throw new AggregateError([primary, cleanup], `Standing-resource read and close failed: ${relative}`); }
    throw primary;
  }
  closeSync(fd);
  return text;
}
function hash(value: string): string { let result = 2166136261; for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619); return (result >>> 0).toString(16); }
