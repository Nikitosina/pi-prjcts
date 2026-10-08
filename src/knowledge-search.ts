import { listKnowledge, readKnowledge } from "./knowledge.ts";
import { listUploads, uploadText } from "./uploads.ts";
import type { SearchSources } from "./durable-runtime.ts";

/** BM25 keyword search over knowledge documents and owner uploads (and, for the owner's search UI, chat and worker transcripts), by chunk. No embeddings. */
const CHUNK = 1200, K1 = 1.2, B = 0.75;
const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the this to was were will with not but".split(" "));
type Message = { index: number; role: "user" | "assistant"; at: number };
type Source = { source: "knowledge"; path: string } | { source: "upload"; uploadId: string; filename: string; kind: string }
  | ({ source: "chat"; chatId: string; chat: string; archived: boolean } & Message) | ({ source: "worker"; threadId: string; label: string; child: boolean } & Message);
type Chunk = { owner: Source; offset: number; text: string; terms: Map<string, number>; length: number };
const cache = new Map<string, Chunk[]>(), transcriptCache = new Map<string, Chunk[]>();

/** Lowercased words; a camelCase identifier also yields its parts, so "ostrichSpeed" matches "ostrich". */
export function tokenize(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word => { const parts = word.split(/(?<=\p{Ll})(?=\p{Lu})/u); return (parts.length > 1 ? [word, ...parts] : [word]).map(part => part.toLowerCase()); }).filter(term => term.length > 1 && !STOP.has(term));
}

/** Code-point chunks, broken at a newline or space near the boundary; offsets match the read tools. */
function chunks(owner: Source, text: string): Chunk[] {
  const chars = [...text], out: Chunk[] = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(chars.length, start + CHUNK);
    if (end < chars.length) { const window = chars.slice(start + CHUNK / 2, end).join(""); const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" ")); if (cut > 0) end = start + CHUNK / 2 + [...window.slice(0, cut)].length + 1; }
    const body = chars.slice(start, end).join(""), terms = new Map<string, number>(), tokens = tokenize(body);
    for (const term of tokens) terms.set(term, (terms.get(term) ?? 0) + 1);
    if (tokens.length) out.push({ owner, offset: start, text: body, terms, length: tokens.length });
    start = end;
  }
  return out;
}

async function corpus(dir: string): Promise<Chunk[]> {
  const all: Chunk[] = [], seen = new Set<string>();
  for (const doc of await listKnowledge(dir)) {
    const key = `${dir}\0k\0${doc.path}\0${doc.revision}`; seen.add(key);
    if (!cache.has(key)) cache.set(key, chunks({ source: "knowledge", path: doc.path }, (await readKnowledge(dir, doc.path)).text));
    all.push(...cache.get(key)!);
  }
  for (const record of listUploads(dir)) {
    if (record.kind === "image") { all.push({ owner: { source: "upload", uploadId: record.id, filename: record.filename, kind: record.kind }, offset: 0, text: record.filename, terms: new Map(tokenize(record.filename).map(term => [term, 1])), length: tokenize(record.filename).length || 1 }); continue; }
    const key = `${dir}\0u\0${record.id}\0${record.sha256}`; seen.add(key);
    if (!cache.has(key)) cache.set(key, chunks({ source: "upload", uploadId: record.id, filename: record.filename, kind: record.kind }, `${record.filename}\n${uploadText(dir, record.id).text}`));
    all.push(...cache.get(key)!);
  }
  for (const key of cache.keys()) if (key.startsWith(`${dir}\0`) && !seen.has(key)) cache.delete(key);
  return all;
}

function snippet(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase(), at = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0), text.length);
  const start = Math.max(0, (at === text.length ? 0 : at) - 120);
  return `${start ? "…" : ""}${text.slice(start, start + 320).replace(/\s+/g, " ").trim()}${start + 320 < text.length ? "…" : ""}`;
}

// Committed messages never change, so a message's chunks are cached by conversation and position; keys not seen in a search are dropped.
function transcriptCorpus(dir: string, sources: SearchSources): Chunk[] {
  const all: Chunk[] = [], seen = new Set<string>();
  const add = (conversationId: number, message: Message & { text: string }, owner: Source) => {
    const key = `${dir}\0${conversationId}\0${message.index}\0${message.text.length}`; seen.add(key);
    if (!transcriptCache.has(key)) transcriptCache.set(key, chunks(owner, message.text));
    all.push(...transcriptCache.get(key)!.map(chunk => ({ ...chunk, owner })));
  };
  for (const chat of sources.chats) for (const { text, ...message } of chat.messages) add(chat.conversationId, { ...message, text }, { source: "chat", chatId: chat.id, chat: chat.title, archived: chat.archived, ...message });
  for (const thread of sources.threads) {
    const label = `${thread.parentThreadId ? "Sub-agent " : ""}${thread.role} · ${thread.task.replace(/\s+/g, " ").trim().slice(0, 80)}`;
    for (const { text, ...message } of thread.messages) add(thread.conversationId, { ...message, text }, { source: "worker", threadId: thread.threadId, label, child: thread.parentThreadId !== null, ...message });
  }
  for (const key of transcriptCache.keys()) if (key.startsWith(`${dir}\0`) && !seen.has(key)) transcriptCache.delete(key);
  return all;
}

function rank(query: string, all: Chunk[], limit: number) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) throw new Error("Search query needs at least one word of two or more letters or digits (common words are ignored)");
  const average = all.reduce((sum, chunk) => sum + chunk.length, 0) / Math.max(1, all.length);
  const idf = new Map(terms.map(term => { const n = all.filter(chunk => chunk.terms.has(term)).length; return [term, Math.log(1 + (all.length - n + 0.5) / (n + 0.5))]; }));
  const scored = all.flatMap(chunk => {
    let score = 0;
    for (const term of terms) { const f = chunk.terms.get(term) ?? 0; if (f) score += idf.get(term)! * f * (K1 + 1) / (f + K1 * (1 - B + B * chunk.length / average)); }
    return score > 0 ? [{ chunk, score }] : [];
  }).sort((a, b) => b.score - a.score || ("at" in b.chunk.owner ? b.chunk.owner.at : 0) - ("at" in a.chunk.owner ? a.chunk.owner.at : 0)).slice(0, limit);
  return {
    query, terms, searched: { chunks: all.length },
    results: scored.map(({ chunk, score }) => ({ ...chunk.owner, offset: chunk.owner.source === "upload" ? Math.max(0, chunk.offset - [...`${chunk.owner.filename}\n`].length) : chunk.offset, score: Math.round(score * 1000) / 1000, snippet: snippet(chunk.text, terms) })),
  };
}

export async function searchKnowledge(dir: string, query: string, limit = 8) {
  return rank(query, await corpus(dir), Math.min(20, Math.max(1, limit)));
}

/** Owner search UI: knowledge, uploads and, for Durable projects, every chat and worker thread. A message hit carries its transcript `index`. */
export async function searchProject(dir: string, query: string, sources: SearchSources | null, limit = 30) {
  if (!tokenize(query).length) return rank(query, [], 1);
  const all = [...await corpus(dir), ...sources ? transcriptCorpus(dir, sources) : []];
  return { ...rank(query, all, Math.min(50, Math.max(1, limit))), transcripts: sources !== null };
}
