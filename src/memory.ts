import { posix } from "node:path";
import { deleteKnowledge, historyKnowledge, readAllKnowledge, readKnowledge, recentKnowledgeHistory, writeKnowledge } from "./knowledge.ts";

/** Knowledge as Memory (docs/ui2-contract.md): a classified view over the knowledge files, read without moving or rewriting them. */
export type MemoryKind = "preference" | "decision" | "procedure" | "archive";
export type MemoryStatus = "current" | "superseded" | "historical";
export type MemorySource = { chatId?: string; conversationId?: string; entryId?: number };
export type MemoryEntry = {
  path: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  status: MemoryStatus;
  supersededBy?: string;
  revision: string;
  updatedAt: string;
  source?: MemorySource;
  lastConfirmedAt?: string;
};
type BrokenLink = { from: string; to: string };

const KINDS: readonly MemoryKind[] = ["preference", "decision", "procedure", "archive"];
const STATUSES: readonly MemoryStatus[] = ["current", "superseded", "historical"];
const UUID_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Bounds of what reaches every prompt. */
export const PREFERENCES_LIMIT = 4000;

type Front = { fields: Record<string, string>; source: MemorySource; body: string };
/** Optional YAML front matter: flat `key: value` lines plus one nested `source:` block. Anything else is not front matter. */
export function frontMatter(text: string): Front | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {},
    source: MemorySource = {};
  let nested = false;
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const pair = /^(\s*)([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!pair) return null;
    const [, indent, key, raw] = pair as unknown as [string, string, string, string];
    const value = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (indent) {
      if (!nested) return null;
      if (key === "entryId" && /^\d+$/.test(value)) source.entryId = Number(value);
      else if (key === "chatId" || key === "conversationId") source[key] = value;
      continue;
    }
    nested = key === "source" && value === "";
    if (!nested) fields[key] = value;
  }
  return { fields, source, body: text.slice(match[0].length) };
}

/** The kind a file has by where it lives; front matter overrides it. */
export function folderKind(path: string): MemoryKind {
  if (path === "preferences.md") return "preference";
  if (path === "MEMORY.md" || path.startsWith("plans/") || path.startsWith("research/") || UUID_NAME.test(posix.basename(path)))
    return "archive";
  if (path.startsWith("decisions/")) return "decision";
  return "procedure";
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
function describe(
  path: string,
  text: string,
  meta: { revision: string; updatedAt: string },
): MemoryEntry & { body: string; links: string[] } {
  const front = frontMatter(text);
  const fields = front?.fields ?? {},
    body = front ? front.body : text;
  const kind = KINDS.find((item) => item === fields.kind) ?? folderKind(path);
  const supersededBy = fields.supersededBy || undefined;
  const status =
    STATUSES.find((item) => item === fields.status) ?? (supersededBy ? "superseded" : kind === "archive" ? "historical" : "current");
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, "");
  const firstText = lines.find((line) => line && !line.startsWith("#") && !line.startsWith("---"));
  const links = [...body.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)].map((item) => item[1]!);
  const source = front && Object.keys(front.source).length ? front.source : undefined;
  return {
    path,
    kind,
    title: clip(fields.title || heading || posix.basename(path, ".md"), 200),
    summary: clip((fields.summary || firstText || "").replace(/\s+/g, " "), 240),
    status,
    ...(supersededBy ? { supersededBy } : {}),
    revision: meta.revision,
    updatedAt: meta.updatedAt,
    ...(source ? { source } : {}),
    ...(fields.lastConfirmedAt ? { lastConfirmedAt: fields.lastConfirmedAt } : {}),
    body,
    links,
  };
}

/** Links inside knowledge resolve against the linking file's folder; links leaving knowledge (URLs, `../..`) are not checked. */
function target(from: string, link: string): string | null {
  if (/^[a-z]+:/i.test(link) || link.startsWith("/")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(from), link));
  return resolved.startsWith("..") ? null : resolved;
}

async function entries(dir: string) {
  return (await readAllKnowledge(dir)).map((document) => describe(document.path, document.text, document));
}
const publicEntry = ({ body: _body, links: _links, ...entry }: Awaited<ReturnType<typeof entries>>[number]): MemoryEntry => entry;

export async function memoryIndex(dir: string, options: { includeArchive?: boolean } = {}) {
  const all = await entries(dir);
  const known = new Set(all.map((entry) => entry.path));
  const brokenLinks: BrokenLink[] = [];
  for (const entry of all) {
    const targets = [...entry.links.map((link) => target(entry.path, link)), entry.supersededBy ? target("", entry.supersededBy) : null];
    for (const to of new Set(targets)) if (to && !known.has(to)) brokenLinks.push({ from: entry.path, to });
  }
  return {
    entries: all.filter((entry) => options.includeArchive || entry.kind !== "archive").map(publicEntry),
    brokenLinks,
  };
}

/** Memory entries for agents, archive included: all, or those whose title, summary or path contains `query` (case-insensitive). */
export async function findMemory(dir: string, query?: string): Promise<MemoryEntry[]> {
  const needle = query?.trim().toLowerCase();
  const { entries: listed } = await memoryIndex(dir, { includeArchive: true });
  return needle ? listed.filter((entry) => [entry.title, entry.summary, entry.path].some((field) => field.toLowerCase().includes(needle))) : listed;
}

/** Current preferences, injected into every role prompt: bounded and tagged with each entry's revision. */
export async function preferencesText(dir: string): Promise<string> {
  const current = (await entries(dir)).filter((entry) => entry.kind === "preference" && entry.status === "current");
  if (!current.length) return "";
  const parts = current.map((entry) => `[${entry.path} @ ${entry.revision.slice(0, 12)}]\n${entry.body.trim()}`);
  const text = `Preferences (memory; the owner's standing preferences, follow them):\n${parts.join("\n\n")}`;
  return text.length > PREFERENCES_LIMIT
    ? `${text.slice(0, PREFERENCES_LIMIT - 80).trimEnd()}\n… preferences truncated; read them with projects_knowledge_read`
    : text;
}

/** Undo the write that produced `revision`: the prior text comes back, or a just-created entry is removed. The undo is itself a revision. */
export async function undoMemory(dir: string, path: string, revision: string): Promise<{ entry: MemoryEntry | null }> {
  const current = await readKnowledge(dir, path);
  if (current.revision !== revision) throw new Error(`Memory revision conflict for ${path}; reread before undoing`);
  const record = (await historyKnowledge(dir, path)).findLast((item) => item.revision === revision);
  if (!record) throw new Error(`No recorded write produced this revision of ${path}; nothing to undo`);
  if (record.priorText === null) {
    await deleteKnowledge(dir, path, revision, "memory-undo");
    return { entry: null };
  }
  const restored = await writeKnowledge({ dir, path, text: record.priorText, expectedRevision: revision, author: "memory-undo" });
  return { entry: publicEntry(describe(path, restored.text, restored)) };
}

export type MemoryWrite = {
  path: string;
  revision: string;
  author: string;
  updatedAt: string;
  created: boolean;
  undone: boolean;
  current: boolean;
};
export const RECENT_LIMIT = 50;
/**
 * Recent writes, newest first, with whether `memory-undo` reverted each and whether it is still the entry's current revision,
 * so a client reloaded after an undo shows "Undone" instead of offering Undo again.
 */
export async function memoryRecent(dir: string): Promise<{ writes: MemoryWrite[] }> {
  // Undos and later writes come after the write they concern, so a window larger than the answer sees them.
  const records = await recentKnowledgeHistory(dir, RECENT_LIMIT * 4);
  const newest = new Map<string, string>();
  for (const record of records) if (!newest.has(record.path)) newest.set(record.path, record.revision);
  const undone = new Set(
    records.filter((record) => record.author === "memory-undo").map((record) => `${record.path}\0${record.priorRevision}`),
  );
  const writes = records
    .filter((record) => record.author !== "memory-undo")
    .slice(0, RECENT_LIMIT)
    .map((record) => ({
      path: record.path,
      revision: record.revision,
      author: record.author,
      updatedAt: record.updatedAt,
      created: record.priorText === null,
      undone: undone.has(`${record.path}\0${record.revision}`),
      current: newest.get(record.path) === record.revision,
    }));
  return { writes };
}
