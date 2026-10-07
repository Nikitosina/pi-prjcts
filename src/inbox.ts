import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InboxEntry, Note, parse, readJson, saveJson, saveJob, type Job, type Request } from "./state.ts";

export function inbox(dir: string): InboxEntry[] {
  const path = join(dir, "decisions");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return readdirSync(path).filter(name => name.endsWith(".json")).map(name => parse(InboxEntry, readJson(join(path, name)))).sort((a, b) => a.at.localeCompare(b.at));
}

export function addQuestion(dir: string, question: string, choices: string[] = []): InboxEntry {
  const prior = inbox(dir).find(item => item.kind === "question" && item.result === null && item.question === question && JSON.stringify(item.choices) === JSON.stringify(choices));
  if (prior) return prior;
  const entry = parse(InboxEntry, { kind: "question", id: randomUUID(), at: new Date().toISOString(), title: question.split("\n")[0].slice(0, 160), question, choices, result: null });
  save(dir, entry);
  return entry;
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

export function addReview(dir: string, run: { id: string; task: string }, outcome: string): void {
  const path = join(dir, "decisions", `${run.id}.json`);
  if (existsSync(path)) return;
  save(dir, parse(InboxEntry, { kind: "review", id: run.id, at: new Date().toISOString(), title: run.task.slice(0, 160), run: run.id, outcome, result: null }));
}

type Resolution = Extract<Request, { action: "answer" | "review" }>;

export function resolveEntry(dir: string, input: Resolution, delivery: "queue" | "manual" = "queue"): InboxEntry {
  const entry = parse(InboxEntry, readJson(join(dir, "decisions", `${input.entry}.json`)));
  const at = new Date().toISOString();
  if (input.action === "answer" && entry.kind !== "question") throw new Error("This item is a review, not a question");
  if (input.action === "review" && entry.kind !== "review") throw new Error("This item is a question, not a review");
  if (entry.result) {
    const same = entry.kind === "question" ? input.action === "answer" && entry.result.text === input.text
      : input.action === "review" && entry.result.action === input.operation && entry.result.text === (input.text ?? "");
    if (!same) throw new Error("This inbox item was already resolved. Refresh before continuing.");
    recoverEntry(dir, input.id, entry, delivery === "queue");
    return entry;
  }
  if (input.action === "answer" && entry.kind === "question") {
    if (!input.text.trim()) throw new Error("Answer cannot be empty");
    entry.result = delivery === "queue" ? { at, text: input.text, job: randomUUID() } : { at, text: input.text, delivery: "manual" };
  } else if (input.action === "review" && entry.kind === "review") {
    if (input.operation === "revise") {
      if (!input.text?.trim()) throw new Error("Describe the requested changes");
      entry.result = delivery === "queue" ? { action: "revise", at, text: input.text, job: randomUUID() } : { action: "revise", at, text: input.text, delivery: "manual" };
    } else entry.result = { action: "accept", at, text: input.text ?? "" };
  }
  save(dir, entry);
  recoverEntry(dir, input.id, entry, delivery === "queue");
  return entry;
}

export function recoverInbox(dir: string, id: string): void {
  for (const entry of inbox(dir)) recoverEntry(dir, id, entry);
}

function recoverEntry(dir: string, projectId: string, entry: InboxEntry, enqueue = true): void {
  const result = entry.result;
  if (!result) return;
  const text = entry.kind === "question" ? `Owner answered: ${entry.question}\nAnswer: ${result.text}`
    : `Owner ${"action" in result && result.action === "accept" ? "accepted" : "requested changes to"} run ${entry.run}: ${entry.title}\n${result.text}`;
  const note = parse(Note, { id: entry.id, at: result.at, author: "owner", text: text.slice(0, 32000) });
  const notePath = join(dir, "notes", `${result.at.replaceAll(":", "-")}-${entry.id}.json`);
  if (!existsSync(notePath)) saveJson(notePath, note);
  if (enqueue && "job" in result && !existsSync(join(dir, "inbox", `${result.job}.json`))) {
    const job: Job = { id: result.job, text: text.slice(0, 31000) + "\nUse the owner's answer for this project. Do not bypass permissions or repeat completed changes. Inspect the existing run before starting another writer.", at: result.at, state: "queued", error: null };
    saveJob(projectId, job);
  }
}

function save(dir: string, entry: InboxEntry): void {
  saveJson(join(dir, "decisions", `${entry.id}.json`), entry);
}
