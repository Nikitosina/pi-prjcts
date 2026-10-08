import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InboxEntry, Note, parse, readJson, saveJson, type Request } from "./state.ts";

export function inbox(dir: string): InboxEntry[] {
  const path = join(dir, "decisions");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Run-review decisions of the removed legacy runtime are ignored, not fatal.
  return readdirSync(path).filter(name => name.endsWith(".json")).map(name => readJson(join(path, name))).filter(value => (value as { kind?: unknown }).kind !== "review").map(value => parse(InboxEntry, value)).sort((a, b) => a.at.localeCompare(b.at));
}

export function retainQuestion(dir: string, input: Extract<InboxEntry, { kind: "question" }>): InboxEntry {
  const path = join(dir, "decisions", `${input.id}.json`);
  const entry = parse(InboxEntry, input);
  if (entry.kind !== "question") throw new Error("Decision intent must identify a question");
  if (existsSync(path)) {
    const current = parse(InboxEntry, readJson(path));
    if (current.kind !== "question" || current.id !== entry.id || current.at !== entry.at || current.title !== entry.title || current.question !== entry.question || JSON.stringify(current.choices) !== JSON.stringify(entry.choices) || current.native?.projectId !== entry.native?.projectId || current.native?.conversationId !== entry.native?.conversationId || current.native?.taskId !== entry.native?.taskId || current.native?.callId !== entry.native?.callId) throw new Error("Retained question identity conflict");
    return current;
  }
  save(dir, entry);
  return entry;
}

type Answer = Extract<Request, { action: "answer" }>;

/** Records the owner's answer; the host then wakes the asking chat. A repeated identical answer is idempotent. */
export function resolveEntry(dir: string, input: Answer): InboxEntry {
  const entry = parse(InboxEntry, readJson(join(dir, "decisions", `${input.entry}.json`)));
  if (entry.result) {
    if (entry.result.text !== input.text) throw new Error("This inbox item was already resolved. Refresh before continuing.");
    return entry;
  }
  if (!input.text.trim()) throw new Error("Answer cannot be empty");
  entry.result = { at: new Date().toISOString(), text: input.text, delivery: "manual" };
  save(dir, entry);
  const note = parse(Note, { id: entry.id, at: entry.result.at, author: "owner", text: `Owner answered: ${entry.question}\nAnswer: ${input.text}`.slice(0, 32000) });
  const notePath = join(dir, "notes", `${entry.result.at.replaceAll(":", "-")}-${entry.id}.json`);
  if (!existsSync(notePath)) saveJson(notePath, note);
  return entry;
}

function save(dir: string, entry: InboxEntry): void {
  saveJson(join(dir, "decisions", `${entry.id}.json`), entry);
}
