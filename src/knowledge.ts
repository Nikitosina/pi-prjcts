import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { notes, parse, readJson, saveJson } from "./state.ts";
import { KnowledgeDocument, KnowledgeMetadata, KnowledgePath, KnowledgeRevision, KnowledgeWrite, type KnowledgeDocument as Document, type KnowledgeMetadata as Metadata, type KnowledgeRevision as Revision, type KnowledgeWrite as Write } from "./knowledge-types.ts";

const memoryLimit = 3000;
const topicLimit = 32000;
const roots = new Set(["architecture", "research", "decisions", "runbooks", "plans"]);
const Journal = KnowledgeRevision;

/** The journal preserves both versions before writing. Recovery applies it only
 * if the prior or intended revision still matches; otherwise the human edit wins
 * and the interrupted write remains in the conflict archive. */
export async function ensureKnowledge(dir: string): Promise<void> {
  const root = knowledgeRoot(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const folder of roots) mkdirSync(checkedPath(root, folder), { recursive: true, mode: 0o700 });
  mkdirSync(control(root), { recursive: true, mode: 0o700 });
  await withLock(root, async () => {
    recover(root);
    seed(root, "MEMORY.md", "# Project memory\n\nRead topic files only when needed. Standing instructions are supplied separately.\n\n- preferences.md: stable workflow preferences\n- architecture/: code ownership and runtime flows\n- research/: verified findings and sources\n- decisions/: decisions and rationale\n- runbooks/: repeatable build, test, and debug commands\n- plans/: active plans and progress\n- research/legacy/: imported historical notes, read on demand\n");
    seed(root, "preferences.md", "# Preferences\n\nRecord stable working preferences here.\n");
    migrate(root, dir);
  });
}

export async function listKnowledge(dir: string): Promise<Metadata[]> {
  await ensureKnowledge(dir);
  const root = knowledgeRoot(dir);
  return paths(root).map(path => metadata(root, path)).sort((left, right) => left.path.localeCompare(right.path));
}

export async function readKnowledge(dir: string, path: string): Promise<Document> {
  await ensureKnowledge(dir);
  const root = knowledgeRoot(dir);
  const valid = parse(KnowledgePath, path);
  return parse(KnowledgeDocument, { ...metadata(root, valid), text: readDocument(root, valid) });
}

export async function writeKnowledge(input: Write): Promise<Document> {
  const request = parse(KnowledgeWrite, input);
  await ensureKnowledge(request.dir);
  const root = knowledgeRoot(request.dir);
  checkLength(request.path, request.text);
  return withLock(root, async () => {
    recover(root);
    const target = documentPath(root, request.path);
    const present = existsSync(target);
    const current = present ? metadata(root, request.path) : null;
    if (request.expectedRevision === null ? present : current?.revision !== request.expectedRevision) throw new Error(`Knowledge revision conflict for ${request.path}`);
    const revision = digest(request.text);
    const priorTime = current ? Date.parse(current.updatedAt) : 0;
    const now = new Date(Math.max(Date.now(), Number.isFinite(priorTime) ? priorTime + 1 : 0)).toISOString();
    const next = parse(KnowledgeMetadata, { path: request.path, revision, updatedAt: now, author: request.author, size: Buffer.byteLength(request.text) });
    const priorRevision = current?.revision ?? null;
    const journal = parse(Journal, { ...next, id: randomUUID(), text: request.text, priorRevision, priorText: present ? readDocument(root, request.path) : null });
    saveJson(controlPath(root, "journal.json"), journal);
    atomicWrite(target, request.text);
    saveRevision(root, journal);
    saveJson(metaPath(root, request.path), next);
    rmSync(controlPath(root, "journal.json"), { force: true });
    return parse(KnowledgeDocument, { ...next, text: request.text });
  });
}

export async function historyKnowledge(dir: string, path: string): Promise<Revision[]> {
  await ensureKnowledge(dir);
  const root = knowledgeRoot(dir);
  const valid = parse(KnowledgePath, path);
  const folder = controlPath(root, `history/${digest(valid)}`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => name.endsWith(".json")).sort().map(name => parse(KnowledgeRevision, readJson(controlPath(root, `history/${digest(valid)}/${name}`))));
}

export async function knowledgeContext(dir: string): Promise<string> {
  await ensureKnowledge(dir);
  return memoryIndex(dir);
}

export function memoryIndex(dir: string): string {
  const root = knowledgeRoot(dir);
  const index = documentPath(root, "MEMORY.md");
  if (statSync(index).size > memoryLimit * 4) throw new Error(`MEMORY.md exceeds the ${memoryLimit} Unicode character limit; repair it before starting a model turn.`);
  const text = readDocument(root, "MEMORY.md");
  if ([...text].length > memoryLimit) throw new Error(`MEMORY.md exceeds the ${memoryLimit} Unicode character limit; repair it through knowledge-read and knowledge-write before starting a model turn.`);
  return text;
}

function knowledgeRoot(dir: string): string {
  const root = join(resolve(dir), "knowledge");
  rejectSymlink(root);
  return root;
}
function control(root: string): string { return checkedPath(root, ".knowledge"); }
function controlPath(root: string, path: string): string { return checkedPath(root, `.knowledge/${path}`); }
function metaPath(root: string, path: string): string { return controlPath(root, `metadata/${digest(path)}.json`); }
function saveRevision(root: string, revision: Revision): void {
  saveJson(controlPath(root, `history/${digest(revision.path)}/${revision.updatedAt.replaceAll(":", "-")}-${revision.id}.json`), revision);
}
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

function checkLength(path: string, text: string): void {
  const limit = path === "MEMORY.md" ? memoryLimit : topicLimit;
  if ([...text].length > limit) throw new Error(`${path} exceeds the ${limit} Unicode character limit`);
}

function documentPath(root: string, path: string): string {
  return checkedPath(root, parse(KnowledgePath, path));
}

function checkedPath(root: string, path: string): string {
  const candidate = resolve(root, path);
  const suffix = relative(root, candidate);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Knowledge path escapes its project");
  rejectSymlink(root);
  let cursor = root;
  for (const piece of path.split("/")) { cursor = join(cursor, piece); rejectSymlink(cursor); }
  return candidate;
}

function rejectSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("Knowledge paths cannot traverse symlinks"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}

function readDocument(root: string, path: string): string {
  const target = documentPath(root, path);
  if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error(`Knowledge document does not exist: ${path}`);
  return readFileSync(target, "utf8");
}

function metadata(root: string, path: string): Metadata {
  const text = readDocument(root, path);
  const revision = digest(text);
  const stored = metaPath(root, path);
  if (existsSync(stored)) {
    try {
      const value = parse(KnowledgeMetadata, readJson(stored));
      if (value.path === path && value.revision === revision) return value;
    } catch { /* Manually damaged metadata must not hide a readable document. */ }
  }
  return parse(KnowledgeMetadata, { path, revision, updatedAt: statSync(documentPath(root, path)).mtime.toISOString(), author: "manual", size: Buffer.byteLength(text) });
}

function paths(root: string): string[] {
  const found: string[] = [];
  const visit = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === ".knowledge" || entry.isSymbolicLink()) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(folder, entry.name), path);
      else if (entry.isFile()) {
        try { found.push(parse(KnowledgePath, path)); } catch { /* Ignore non-knowledge files. */ }
      }
    }
  };
  visit(root, "");
  return found;
}

function seed(root: string, path: string, text: string): void {
  const target = documentPath(root, path);
  if (!existsSync(target)) {
    atomicWrite(target, text);
    saveJson(metaPath(root, path), parse(KnowledgeMetadata, { path, revision: digest(text), updatedAt: new Date().toISOString(), author: "system", size: Buffer.byteLength(text) }));
  }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function recover(root: string): void {
  const journalPath = controlPath(root, "journal.json");
  if (!existsSync(journalPath)) return;
  const journal = parse(Journal, readJson(journalPath));
  checkLength(journal.path, journal.text);
  if (digest(journal.text) !== journal.revision || (journal.priorText === null ? null : digest(journal.priorText)) !== journal.priorRevision) throw new Error("Knowledge journal is corrupt; preserve it before repair.");
  const target = documentPath(root, journal.path);
  const current = existsSync(target) ? metadata(root, journal.path).revision : null;
  if (current === journal.priorRevision || current === journal.revision) {
    if (current !== journal.revision) atomicWrite(target, journal.text);
    saveRevision(root, journal);
    saveJson(metaPath(root, journal.path), parse(KnowledgeMetadata, { path: journal.path, revision: journal.revision, updatedAt: journal.updatedAt, author: journal.author, size: journal.size }));
  } else {
    saveJson(controlPath(root, `conflicts/${journal.id}.json`), journal);
  }
  rmSync(journalPath, { force: true });
}

function migrate(root: string, dir: string): void {
  for (const note of notes(dir)) {
    const receipt = controlPath(root, `imports/${note.id}.json`);
    if (existsSync(receipt)) continue;
    const path = `research/legacy/${note.id}.md`;
    const text = `# Legacy note ${note.id}\n\nAuthor: ${note.author}\nRecorded: ${note.at}\n\n${note.text}`;
    const target = documentPath(root, path);
    if (!existsSync(target)) {
      atomicWrite(target, text);
      saveJson(metaPath(root, path), parse(KnowledgeMetadata, { path, revision: digest(text), updatedAt: new Date().toISOString(), author: "migration", size: Buffer.byteLength(text) }));
    }
    saveJson(receipt, { note: note.id, importedAt: new Date().toISOString(), sourceDigest: digest(JSON.stringify(note)) });
  }
}

async function withLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  // SQLite supplies only the process lock; Markdown and the recovery journal
  // remain authoritative. The OS releases this lock even after SIGKILL.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = controlPath(root, "writer.sqlite");
    for (const suffix of ["-journal", "-wal", "-shm"]) controlPath(root, `writer.sqlite${suffix}`);
    const database = new DatabaseSync(path);
    let acquired = false;
    try {
      database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      acquired = true;
      return await work();
    } catch (error) {
      if (acquired || !(error instanceof Error && "errcode" in error && error.errcode === 5)) throw error;
    } finally {
      try { if (acquired) database.exec("ROLLBACK"); }
      finally { database.close(); }
    }
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error("Knowledge is locked by a live process; retry after its write finishes");
}
