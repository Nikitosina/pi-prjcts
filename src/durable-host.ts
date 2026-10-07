import { inbox } from "./inbox.ts";
import { evidence } from "./evidence.ts";
import { openDurableProject, type DurableCoordinatorMessage, type DurableProjectRuntime, type DurableSubmissionState } from "./durable-runtime.ts";
import { compactSkillText } from "./coordinator-skills.ts";
import { jobs, loadProject, notes, projectDir, saveJob, saveProject, type Project, type Snapshot } from "./state.ts";

export async function openDurableHost(project: Project, configuredSkillLoader?: import("@earendil-works/pi-coding-agent").DefaultResourceLoader): Promise<DurableProjectRuntime> {
  const owner = await openDurableProject({ project, dir: projectDir(project.id), configuredSkillLoader });
  try {
    if ((await owner.planSnapshot()).paused) return owner;
    for (const job of jobs(project.id).filter(job => job.state === "queued" || job.state === "running")) {
      await owner.admit(job.text, { requestId: job.id, chatId: job.chatId });
    }
    return owner;
  } catch (error) { await owner.close(); throw error; }
}

export async function durableHostSnapshot(owner: DurableProjectRuntime, chatId?: string): Promise<Snapshot> {
  const view = await owner.snapshot(chatId);
  const paused = (await owner.planSnapshot()).paused;
  const project = loadProject(view.project.id);
  // Each chat has its own ledger; jobs without a chat belong to Main. Unsettled jobs of other chats are settled too, so attention covers every chat.
  const all = jobs(project.id), ledgerOf = (id: string) => all.filter(job => (job.chatId ?? "main") === id);
  const settle = (ledger: typeof all, submissions: DurableSubmissionState[]) => {
    for (const job of ledger) {
      const submission = submissions.find(item => item.requestId === job.id);
      if (!submission) continue;
      const before = `${job.state}\0${job.error}`;
      switch (submission.status) {
        case "queued": job.state = "queued"; job.error = null; break;
        case "placed": job.state = "running"; job.error = null; break;
        case "done": job.state = "done"; job.error = null; break;
        case "unanswered": job.state = submission.reason === "aborted" ? "interrupted" : "failed"; job.error = submission.detail ? `${submission.reason}: ${submission.detail}` : submission.reason; break;
        default: { const exhaustive: never = submission.status; throw new Error(String(exhaustive)); }
      }
      if (`${job.state}\0${job.error}` !== before || ledger === viewed) saveJob(project.id, job);
    }
  };
  const viewed = ledgerOf(view.chatId);
  settle(viewed, view.coordinator.submissions);
  for (const chat of view.chats) {
    if (chat.id === view.chatId) continue;
    const ledger = ledgerOf(chat.id);
    if (ledger.some(job => job.state === "queued" || job.state === "running")) settle(ledger, await owner.chatSubmissions(chat.id));
  }
  // Per chat, only the newest settled turn decides attention; a later success clears an earlier failure.
  const failure = (id: string) => { const settled = ledgerOf(id).findLast(job => job.state === "done" || job.state === "failed"); return settled?.state === "failed" ? settled.error : null; };
  const chats = view.chats.map(chat => ({ ...chat, attention: failure(chat.id) !== null }));
  const failing = [chats.find(chat => chat.id === view.chatId), ...chats].find(chat => chat?.attention);
  project.problem = !failing ? null : failing.id === view.chatId ? failure(failing.id) : `Chat "${failing.title}": ${failure(failing.id)}`;
  project.phase = project.problem ? "attention" : view.chats.some(chat => chat.busy) ? "busy" : "ready";
  saveProject(project);
  const dir = projectDir(project.id);
  return {
    project, busy: view.coordinator.busy, paused, jobs: viewed,
    messages: transcriptWindow(view.coordinator.messages).map(message => "kind" in message
      ? { role: "tool", at: message.at, text: "", kind: message.kind, name: message.name, argsPreview: message.argsPreview, status: message.status, resultPreview: message.resultPreview }
      : { role: message.role, at: message.at, text: message.role === "user" ? compactSkillText(message.text) : message.text, ...(message.thinking ? { thinking: message.thinking } : {}) }),
    activeRuns: [], runStates: [], inbox: inbox(dir), notes: notes(dir), evidence: evidence(dir),
    durableInspection: view.durableInspection,
    context: view.coordinator.context,
    chatId: view.chatId, chats,
  };
}

// The last 30 conversational messages and every step between them, so a long tool chain never hides the turn that started it.
function transcriptWindow(messages: readonly DurableCoordinatorMessage[]): DurableCoordinatorMessage[] {
  const rows = messages.filter(message => "kind" in message || message.text.trim() || message.thinking);
  let start = rows.length;
  for (let texts = 0; start > 0 && texts < 30; start--) if (!("kind" in rows[start - 1])) texts++;
  return rows.slice(Math.max(start, rows.length - 400));
}
