import { stripVTControlCharacters } from "node:util";
import { Type, type Static } from "typebox";
import type { Evidence, InboxEntry, Job, Note, Project, Snapshot } from "./state.ts";
import type { NativeOperation, NativeOperations, NativePlan, NativeWork } from "./project-native-data.ts";

export const Layout = Type.Union([Type.Literal("desk"), Type.Literal("board"), Type.Literal("inbox")]);
export type Layout = Static<typeof Layout>;
export const layouts: Layout[] = ["desk", "board", "inbox"];
export const layoutNames: Record<Layout, string> = { desk: "Command desk", board: "Work board", inbox: "Decision inbox" };
export type Section = "work" | "inbox" | "approvals" | "evidence" | "notes" | "activity" | "conversation";
export type Lane = "Planned" | "Running" | "Needs you" | "Complete";
export const lanes: Lane[] = ["Planned", "Running", "Needs you", "Complete"];

type Run = Project["runs"][number];
export type Item =
  | { kind: "approval"; key: string; title: string; state: string; lane: Lane; operation: NativeOperation }
  | { kind: "thread"; key: string; title: string; state: string; lane: Lane; work: NativeWork }
  | { kind: "entry"; key: string; title: string; state: string; lane: Lane; entry: InboxEntry }
  | { kind: "run"; key: string; title: string; state: string; lane: Lane; run: Run }
  | { kind: "job"; key: string; title: string; state: string; lane: Lane; job: Job }
  | { kind: "message"; key: string; title: string; state: string; lane: Lane; message: Snapshot["messages"][number] }
  | { kind: "note"; key: string; title: string; state: string; lane: Lane; note: Note }
  | { kind: "evidence"; key: string; title: string; state: string; lane: Lane; evidence: Evidence };

export function items(snapshot: Snapshot, section: Section, plan?: NativePlan, approvals?: NativeOperations): Item[] {
  switch (section) {
    case "inbox": return [...snapshot.inbox.filter(entry => !entry.result).map(inboxItem), ...(approvals?.items ?? []).filter(record => record.status === "pending").map(approvalItem)];
    case "approvals": return (approvals?.items ?? []).map(approvalItem);
    case "evidence": return snapshot.evidence.map(evidenceItem);
    case "notes": return snapshot.notes.toReversed().map(note => ({ kind: "note", key: note.id, title: firstLine(note.text), state: note.author, lane: "Complete", note }));
    case "activity": return snapshot.jobs.toReversed().map(jobItem);
    case "conversation": return snapshot.messages.filter(message => message.text.trim()).toReversed().map(message => ({ kind: "message", key: `message-${message.at}-${message.role}`, title: firstLine(message.text), state: message.role, lane: "Complete", message }));
    case "work": {
      const pending = snapshot.inbox.filter(entry => !entry.result);
      return [
        ...pending.map(inboxItem),
        ...(approvals?.items ?? []).filter(record => record.status === "pending").map(approvalItem),
        ...(plan?.work ?? []).toReversed().map(work => ({ kind: "thread", key: work.id, title: firstLine(work.text), state: `${work.role} · ${work.status}`, lane: work.status === "running" ? "Running" : work.status === "queued" ? "Planned" : ["blocked", "failed", "interrupted"].includes(work.status) ? "Needs you" : "Complete", work } satisfies Item)),
        ...(snapshot.project.runtime === "durable" ? [] : snapshot.project.runs).toReversed().filter(run => !pending.some(entry => entry.kind === "review" && entry.run === run.id)).map(run => {
          const state = snapshot.runStates.find(s => s.id === run.id)?.state ?? "unknown";
          return { kind: "run", key: run.id, title: firstLine(run.task), state, lane: snapshot.activeRuns.some(active => active.id === run.id) ? "Running" : "Complete", run } satisfies Item;
        }),
        ...snapshot.jobs.filter(job => ["queued", "failed", "interrupted"].includes(job.state)).map(jobItem),
      ];
    }
    default: { const exhaustive: never = section; throw new Error(String(exhaustive)); }
  }
}

export function details(snapshot: Snapshot, item: Item | undefined): string {
  if (!item) return snapshot.project.problem ? `Project needs attention\n\n${snapshot.project.problem}\n\nUse / to send an instruction to the coordinator.` : "No items in this view.\n\nUse / to send any request to the coordinator.\nPress m for conversation, w for work, i for inbox, e for evidence, or n for notes.";
  switch (item.kind) {
    case "approval": {
      const record = item.operation;
      return `Operation ${record.operation.kind}\n\nStatus: ${record.status}\nProject: ${record.projectId}\nID: ${record.id}\nFingerprint: ${record.fingerprint}\nBinding: ${record.bindingRevision}\nScope current: ${record.scopeCurrent}\n\n${JSON.stringify(record.operation, null, 2)}\n\n${record.status === "pending" ? "v  Approve record only\ny  Permit exact bound executor, separate confirmation\nc  Reject\n\nApproval does not execute an operation." : `Decided by: ${record.owner}\nExecutable approval: ${record.executionApproved === true}\n\nDecisions cannot be upgraded or overwritten.\ng  Execute an explicitly approved GitHub merge, separate confirmation.\nh  Inspect original merge outcome, never replay or grant retry permission.`}\n\nArc execution is deferred. Auto-merge is unavailable. Changed scope cannot execute.\no  All approval records     [ / ] previous / next approval page`;
    }
    case "thread": {
      const work = item.work;
      return `${work.text}\n\nRole: ${work.role}\nState: ${work.status}\nWork: ${work.id}\nThread: ${work.threadId}\nDependencies: ${work.dependsOn.join(", ") || "none"}\n${work.blocker ? `\nBlocked: ${work.blocker}\n` : ""}${work.attempt ? `\nFrozen model: ${work.attempt.model}\nWorkspace: ${work.attempt.cwd}\nAttempt: ${work.attempt.id}\nTools: ${work.attempt.toolNames.join(", ")}` : "\nNo execution attempt recorded."}\n\nt  Thread history     f  Follow up\ns  Steer with confirmation     x  Stop with confirmation\n\nWork items sharing a thread UUID reuse its conversation. Follow-ups do not grant new tools or scope.`;
    }
    case "entry": {
      const entry = item.entry;
      if (entry.kind === "question") return `Decision needed\n\n${entry.question}\n\n${entry.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n")}\n\na  Answer with a choice or free text\n\n${snapshot.project.runtime === "durable" ? "The host records your answer. It does not resume the project or grant execution authority." : "The host records your answer and wakes the coordinator."}`;
      const state = snapshot.runStates.find(state => state.id === entry.run);
      const evidence = snapshot.evidence.filter(record => state?.sessionFile && record.sessionFile === state.sessionFile);
      return `${entry.title}\n\nOutcome: ${entry.outcome}\nRun: ${entry.run}\n\n${state?.summary || "The worker has ended. Press t to inspect its transcript."}\n\nCaptured evidence: ${evidence.length}\n${evidence.map(record => `  ${record.title} · ${record.filename}`).join("\n")}\n\nv  Accept result     c  Request changes\nt  Transcript        e  All captured evidence\n\nAcceptance does not commit, merge, or publish.`;
    }
    case "run": {
      const state = snapshot.runStates.find(state => state.id === item.run.id);
      return `${item.run.task}\n\nRole: ${item.run.role}\nState: ${item.state}\nRun: ${item.run.id}\nModel: ${snapshot.project.models[item.run.role]}\n\n${state?.summary || "Waiting for worker output."}\n\nt  Transcript${item.lane === "Running" ? "     s  Steer     x  Stop with confirmation" : ""}`;
    }
    case "job": return `${item.job.text}\n\nState: ${item.job.state}\nCreated: ${item.job.at}${item.job.error ? `\n\n${item.job.error}` : ""}\n\n${item.job.state === "interrupted" ? "Not replayed automatically. Inspect existing workers before sending a new instruction." : "This is a coordinator request, not a worker task."}`;
    case "note": return `${item.note.text}\n\n${item.note.author} · ${item.note.at}`;
    case "message": return `${item.message.role} · ${new Date(item.message.at).toLocaleString()}\n\n${item.message.text}`;
    case "evidence": return `${item.evidence.title}\n\nFile: ${item.evidence.filename}\nBytes: ${item.evidence.size}\nCaptured: ${item.evidence.at}\nSHA-256: ${item.evidence.sha256}\n\nEnter  Inspect the hash-checked captured file\n\nThis opens the stored evidence, not a mutable workspace file.`;
    default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
  }
}

export function worker(item: Item | undefined, snapshot: Snapshot): Run | undefined {
  if (item?.kind === "run") return item.run;
  if (item?.kind === "entry" && item.entry.kind === "review") {
    const id = item.entry.run;
    return snapshot.project.runs.find(run => run.id === id);
  }
  return undefined;
}

export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replaceAll("\t", "  ");
}
export function firstLine(text: string): string { return clean(text).split("\n")[0] || "Untitled"; }
function inboxItem(entry: InboxEntry): Item { return { kind: "entry", key: entry.id, title: firstLine(entry.title), state: entry.kind === "question" ? "decision" : `review · ${entry.outcome}`, lane: "Needs you", entry }; }
function approvalItem(operation: NativeOperation): Item { return { kind: "approval", key: `operation:${operation.id}`, title: `${operation.operation.provider} ${operation.operation.kind} · ${operation.operation.repositoryId}`, state: operation.scopeCurrent ? operation.status : `${operation.status} · scope changed`, lane: operation.status === "pending" ? "Needs you" : "Complete", operation }; }
function evidenceItem(evidence: Evidence): Item { return { kind: "evidence", key: evidence.id, title: firstLine(evidence.title), state: evidence.filename, lane: "Complete", evidence }; }
function jobItem(job: Job): Item { return { kind: "job", key: job.id, title: firstLine(job.text), state: job.state, lane: job.state === "queued" ? "Planned" : job.state === "running" ? "Running" : job.state === "done" ? "Complete" : "Needs you", job }; }
