import { inbox } from "./inbox.ts";
import { evidence } from "./evidence.ts";
import { openDurableProject, type DurableCoordinatorMessage, type DurableProjectRuntime, type DurableSubmissionState } from "./durable-runtime.ts";
import { compactSkillText } from "./coordinator-skills.ts";
import { attachmentContent, listUploads } from "./uploads.ts";
import { plugins } from "./plugins.ts";
import { jobs, loadProject, notes, projectDir, saveJob, saveProject, type Project, type Snapshot } from "./state.ts";

export async function openDurableHost(project: Project, configuredSkillLoader?: import("@earendil-works/pi-coding-agent").DefaultResourceLoader): Promise<DurableProjectRuntime> {
  const owner = await openDurableProject({ project, dir: projectDir(project.id), configuredSkillLoader });
  try {
    if ((await owner.planSnapshot()).paused) return owner;
    for (const job of jobs(project.id).filter(job => job.state === "queued" || job.state === "running")) {
      await owner.admit(attachmentContent(projectDir(project.id), job.text, job.attachments, owner.acceptsImages), { requestId: job.id, chatId: job.chatId });
    }
    return owner;
  } catch (error) { await owner.close(); throw error; }
}

type JobLedger = ReturnType<typeof jobs>;
// Brings a chat's job ledger in line with the runtime's submissions. The ledger of the chat being viewed is always saved; others only when something changed.
function settleLedger(projectId: string, ledger: JobLedger, submissions: DurableSubmissionState[], alwaysSave: boolean): void {
  for (const job of ledger) {
    const submission = submissions.find(item => item.requestId === job.id);
    if (!submission) continue;
    const before = `${job.state}\0${job.error}`, wasSettled = job.state === "done" || job.state === "failed";
    switch (submission.status) {
      case "queued": job.state = "queued"; job.error = null; break;
      case "placed": job.state = "running"; job.error = null; break;
      case "done": job.state = "done"; job.error = null; break;
      case "unanswered": job.state = submission.reason === "aborted" ? "interrupted" : "failed"; job.error = submission.detail ? `${submission.reason}: ${submission.detail}` : submission.reason; break;
      default: { const exhaustive: never = submission.status; throw new Error(String(exhaustive)); }
    }
    // Stamped on the observed transition only, so turns that finished before this field existed do not light up.
    if ((job.state === "done" || job.state === "failed") && !wasSettled) job.settledAt = Date.now();
    if (`${job.state}\0${job.error}` !== before || alwaysSave) saveJob(projectId, job);
  }
}

export type ProjectActivity = { working: boolean; needs: boolean; finishedAt: number };

// Live state of one open project for the sidebar, whichever project the browser is looking at: a coordinator turn or worker running or queued,
// a failed newest turn or a blocked worker, and when anything last finished. Same rules the chat tabs use, so the dots agree.
export async function durableHostActivity(owner: DurableProjectRuntime, projectId: string): Promise<ProjectActivity> {
  const chats = (await owner.chats()).filter(chat => !chat.archived);
  const all = jobs(projectId);
  let needs = false, finishedAt = 0;
  for (const chat of chats) {
    const ledger = all.filter(job => (job.chatId ?? "main") === chat.id);
    if (ledger.some(job => job.state === "queued" || job.state === "running")) settleLedger(projectId, ledger, await owner.chatSubmissions(chat.id), false);
    if (ledger.findLast(job => job.state === "done" || job.state === "failed")?.state === "failed") needs = true;
    for (const job of ledger) if (job.state === "done" && job.settledAt !== undefined) finishedAt = Math.max(finishedAt, job.settledAt);
  }
  const work = (await owner.planSnapshot()).work.filter(item => !item.archived);
  for (const item of work) if (item.status === "completed") finishedAt = Math.max(finishedAt, item.endedAt ?? 0);
  return {
    working: chats.some(chat => chat.busy) || work.some(item => item.status === "running" || item.status === "queued"),
    needs: needs || work.some(item => item.status === "blocked"),
    finishedAt,
  };
}

export async function durableHostSnapshot(owner: DurableProjectRuntime, chatId?: string, focus?: number, from?: number): Promise<Snapshot> {
  const view = await owner.snapshot(chatId);
  const paused = (await owner.planSnapshot()).paused;
  const project = loadProject(view.project.id);
  // Each chat has its own ledger; jobs without a chat belong to Main. Unsettled jobs of other chats are settled too, so attention covers every chat.
  const all = jobs(project.id), ledgerOf = (id: string) => all.filter(job => (job.chatId ?? "main") === id);
  const viewed = ledgerOf(view.chatId);
  settleLedger(project.id, viewed, view.coordinator.submissions, true);
  for (const chat of view.chats) {
    if (chat.id === view.chatId) continue;
    const ledger = ledgerOf(chat.id);
    if (ledger.some(job => job.state === "queued" || job.state === "running")) settleLedger(project.id, ledger, await owner.chatSubmissions(chat.id), false);
  }
  // Per chat, only the newest settled turn decides attention; a later success clears an earlier failure.
  const failure = (id: string) => { const settled = ledgerOf(id).findLast(job => job.state === "done" || job.state === "failed"); return settled?.state === "failed" ? settled.error : null; };
  const finishedAt = (id: string) => ledgerOf(id).findLast(job => job.state === "done" && job.settledAt !== undefined)?.settledAt;
  const chats = view.chats.map(chat => ({ ...chat, attention: failure(chat.id) !== null, ...(finishedAt(chat.id) === undefined ? {} : { finishedAt: finishedAt(chat.id) }) }));
  const failing = [chats.find(chat => chat.id === view.chatId), ...chats].find(chat => chat?.attention);
  project.problem = !failing ? null : failing.id === view.chatId ? failure(failing.id) : `Chat "${failing.title}": ${failure(failing.id)}`;
  project.phase = project.problem ? "attention" : view.chats.some(chat => chat.busy) ? "busy" : "ready";
  saveProject(project);
  const dir = projectDir(project.id);
  const window = transcriptWindow(view.coordinator.messages, focus, from);
  return {
    project, busy: view.coordinator.busy, paused, jobs: viewed,
    messages: window.map(([message, index]) => "kind" in message && message.kind === "compaction"
      ? { role: "compaction", index, at: message.at, text: "", kind: message.kind }
      : "kind" in message
      ? { role: "tool", index, at: message.at, text: "", kind: message.kind, name: message.name, argsPreview: message.argsPreview, status: message.status, resultPreview: message.resultPreview }
      : { role: message.role, index, at: message.at, text: message.role === "user" ? compactSkillText(message.text) : message.text, ...(message.thinking ? { thinking: message.thinking } : {}) }),
    earlier: earlierMessages(view.coordinator.messages, window),
    inbox: inbox(dir), notes: notes(dir), evidence: evidence(dir),
    durableInspection: view.durableInspection,
    context: view.coordinator.context,
    chatId: view.chatId, chats, uploads: listUploads(dir), failedJobs: all.filter(job => job.state === "failed" || job.state === "interrupted").length,
    providerCards: plugins.workspaceProviders().flatMap(provider => provider.setupCards?.(project) ?? []),
    unloadedProvider: project.workspaceAuthorization && project.workspaceAuthorization.provider !== "github" && !plugins.workspaceProvider(project.workspaceAuthorization.provider) ? project.workspaceAuthorization.provider : null,
  };
}

// The last 30 conversational messages and every step between them, so a long tool chain never hides the turn that started it.
// With `focus` (a search jump), the window also reaches back to that message; older tool rows stay out beyond 400 rows. `from` (Show earlier messages)
// adds everything from that transcript index on. Compaction dividers sit at their stored position and do not count as messages. Pairs carry the transcript index.
function transcriptRows(messages: readonly DurableCoordinatorMessage[]): [DurableCoordinatorMessage, number][] {
  return messages.map((message, index): [DurableCoordinatorMessage, number] => [message, index]).filter(([message]) => "kind" in message || message.text.trim() || message.thinking);
}
function transcriptWindow(messages: readonly DurableCoordinatorMessage[], focus?: number, from?: number): [DurableCoordinatorMessage, number][] {
  const rows = transcriptRows(messages);
  let start = rows.length;
  for (let texts = 0; start > 0 && texts < 30; start--) if (!("kind" in rows[start - 1][0])) texts++;
  const tail = Math.max(start, rows.length - 400), at = focus === undefined ? -1 : rows.findIndex(([, index]) => index >= focus);
  const base = at < 0 || at >= tail ? rows.slice(tail) : (() => {
    const first = Math.max(0, at - 3);
    return rows.filter(([message], position) => position >= tail || position >= first && (!("kind" in message) || position <= at + 40));
  })();
  if (from === undefined) return base;
  const kept = new Set(base.map(([, index]) => index));
  return rows.filter(([, index]) => index >= from || kept.has(index));
}
// Stored conversational messages that the window leaves out, for the Show earlier messages button.
function earlierMessages(messages: readonly DurableCoordinatorMessage[], window: readonly [DurableCoordinatorMessage, number][]): number {
  const shown = new Set(window.map(([, index]) => index));
  return transcriptRows(messages).filter(([message, index]) => !("kind" in message) && !shown.has(index)).length;
}
