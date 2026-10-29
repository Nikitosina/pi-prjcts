import { inbox } from "./inbox.ts";
import { evidence } from "./evidence.ts";
import { openDurableProject, type DurableProjectRuntime, type DurableSubmissionState } from "./durable-runtime.ts";
import { attachmentContent, listUploads } from "./uploads.ts";
import { plugins } from "./plugins.ts";
import { feed } from "./change-feed.ts";
import { jobs, loadProject, notes, projectDir, saveJob, saveProject, type Project, type Snapshot } from "./state.ts";

export async function openDurableHost(
  project: Project,
  configuredSkillLoader?: import("@earendil-works/pi-coding-agent").DefaultResourceLoader,
  discoverSkills?: () => Promise<import("@earendil-works/pi-coding-agent").DefaultResourceLoader>,
): Promise<DurableProjectRuntime> {
  // Settling is driven by commits, so reads never write. The owner is not yet known while the first commits arrive; they are caught up below.
  let settling: Promise<void> = Promise.resolve(),
    opened: DurableProjectRuntime | undefined;
  const settle = () => {
    settling = settling
      .then(() => (opened ? settleProject(opened, project.id) : undefined))
      .catch(() => {})
      .then(() => undefined);
    return settling;
  };
  const owner = await openDurableProject({
    project,
    dir: projectDir(project.id),
    configuredSkillLoader,
    discoverSkills,
    onChange: (event) => {
      // The ledger is settled before the browser is told, so its next read already shows the new state.
      if (event.topic === "chat") void settle().then(() => feed.publish(project.id, event));
      else feed.publish(project.id, event);
    },
  });
  opened = owner;
  try {
    if (!(await owner.jobs()).paused) {
      for (const job of jobs(project.id).filter((job) => job.state === "queued" || job.state === "running")) {
        await owner.admit(attachmentContent(projectDir(project.id), job.text, job.attachments, owner.acceptsImages), {
          requestId: job.id,
          chatId: job.chatId,
        });
      }
    }
    await settle();
    return owner;
  } catch (error) {
    await owner.close();
    throw error;
  }
}

type JobLedger = ReturnType<typeof jobs>;
// Brings a chat's job ledger in line with the runtime's submissions. The ledger of the chat being viewed is always saved; others only when something changed.
function settleLedger(projectId: string, ledger: JobLedger, submissions: DurableSubmissionState[], alwaysSave: boolean): void {
  for (const job of ledger) {
    const submission = submissions.find((item) => item.requestId === job.id);
    if (!submission) continue;
    const before = `${job.state}\0${job.error}`,
      wasSettled = job.state === "done" || job.state === "failed";
    switch (submission.status) {
      case "queued":
        job.state = "queued";
        job.error = null;
        break;
      case "placed":
        job.state = "running";
        job.error = null;
        break;
      case "done":
        job.state = "done";
        job.error = null;
        break;
      case "unanswered":
        job.state = submission.reason === "aborted" ? "interrupted" : "failed";
        job.error = submission.detail ? `${submission.reason}: ${submission.detail}` : submission.reason;
        break;
      default: {
        const exhaustive: never = submission.status;
        throw new Error(String(exhaustive));
      }
    }
    // Stamped on the observed transition only, so turns that finished before this field existed do not light up.
    if ((job.state === "done" || job.state === "failed") && !wasSettled) job.settledAt = Date.now();
    if (`${job.state}\0${job.error}` !== before || alwaysSave) saveJob(projectId, job);
  }
}

export type ProjectActivity = { working: boolean; needs: boolean; finishedAt: number };

/** Brings the job ledger of every chat in line with the runtime and records the project's phase and problem. Called by commits, never by a read. */
export async function settleProject(owner: DurableProjectRuntime, projectId: string): Promise<void> {
  const chats = await owner.chats(),
    all = jobs(projectId);
  for (const chat of chats) {
    const ledger = all.filter((job) => (job.chatId ?? "main") === chat.id),
      open = ledger.filter((job) => job.state === "queued" || job.state === "running");
    if (open.length)
      settleLedger(
        projectId,
        ledger,
        await owner.ledgerSubmissions(
          chat.id,
          open.map((job) => job.id),
        ),
        false,
      );
  }
  const project = loadProject(projectId),
    problem = chatProblems(all, chats);
  // Per chat, only the newest settled turn decides attention; a later success clears an earlier failure.
  const phase = problem ? "attention" : chats.some((chat) => chat.busy) ? "busy" : "ready";
  if (project.problem !== problem || project.phase !== phase) saveProject({ ...project, problem, phase });
}
const failureOf = (all: JobLedger, id: string) => {
  const settled = all.filter((job) => (job.chatId ?? "main") === id).findLast((job) => job.state === "done" || job.state === "failed");
  return settled?.state === "failed" ? settled.error : null;
};
const chatProblems = (all: JobLedger, chats: { id: string; title: string }[], viewed?: string): string | null => {
  const failing = [chats.find((chat) => chat.id === viewed), ...chats].find((chat) => chat && failureOf(all, chat.id) !== null);
  return !failing ? null : failing.id === viewed ? failureOf(all, failing.id) : `Chat "${failing.title}": ${failureOf(all, failing.id)}`;
};

// Live state of one open project for the sidebar, whichever project the browser is looking at: a coordinator turn or worker running or queued,
// a failed newest turn or a blocked worker, and when anything last finished. Same rules the chat tabs use, so the dots agree.
export async function durableHostActivity(owner: DurableProjectRuntime, projectId: string): Promise<ProjectActivity> {
  const chats = (await owner.chats()).filter((chat) => !chat.archived);
  const all = jobs(projectId);
  let needs = false,
    finishedAt = 0;
  for (const chat of chats) {
    const ledger = all.filter((job) => (job.chatId ?? "main") === chat.id);
    if (ledger.findLast((job) => job.state === "done" || job.state === "failed")?.state === "failed") needs = true;
    for (const job of ledger) if (job.state === "done" && job.settledAt !== undefined) finishedAt = Math.max(finishedAt, job.settledAt);
  }
  const work = (await owner.jobs()).jobs;
  for (const item of work) if (item.status !== "running") finishedAt = Math.max(finishedAt, item.endedAt ?? 0);
  return {
    working: chats.some((chat) => chat.busy) || work.some((item) => item.status === "running"),
    needs: needs || work.some((item) => item.status === "ready" || item.status === "ready-with-gaps"),
    finishedAt,
  };
}

/** A pure read of the saved ledger and the newest transcript page; the ledger is kept current by `settleProject`. */
export async function durableHostSnapshot(owner: DurableProjectRuntime, chatId?: string): Promise<Snapshot> {
  const view = await owner.snapshot(chatId);
  const paused = (await owner.jobs()).paused;
  const project = loadProject(view.project.id);
  const all = jobs(project.id),
    ledgerOf = (id: string) => all.filter((job) => (job.chatId ?? "main") === id);
  const finishedAt = (id: string) => ledgerOf(id).findLast((job) => job.state === "done" && job.settledAt !== undefined)?.settledAt;
  const chats = view.chats.map((chat) => ({
    ...chat,
    attention: failureOf(all, chat.id) !== null,
    ...(finishedAt(chat.id) === undefined ? {} : { finishedAt: finishedAt(chat.id) }),
  }));
  const dir = projectDir(project.id);
  return {
    project: { ...project, problem: chatProblems(all, chats, view.chatId), phase: project.phase },
    busy: view.coordinator.busy,
    paused,
    jobs: ledgerOf(view.chatId),
    messages: view.coordinator.history.items,
    before: view.coordinator.history.before,
    inbox: inbox(dir),
    notes: notes(dir),
    evidence: evidence(dir),
    context: view.coordinator.context,
    chatId: view.chatId,
    chats,
    uploads: listUploads(dir),
    failedJobs: all.filter((job) => job.state === "failed" || job.state === "interrupted").length,
    providerCards: plugins.workspaceProviders().flatMap((provider) => provider.setupCards?.(project) ?? []),
    unloadedProvider:
      project.workspaceAuthorization &&
      project.workspaceAuthorization.provider !== "github" &&
      !plugins.workspaceProvider(project.workspaceAuthorization.provider)
        ? project.workspaceAuthorization.provider
        : null,
  };
}
