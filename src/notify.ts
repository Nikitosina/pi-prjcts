import type { JobProgress } from "./telegram.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inbox } from "./inbox.ts";
import { extractTelegramMedia } from "./telegram-media.ts";
import { PR_NOTICE_TITLE } from "./pr-notices.ts";
import { loadAutomations } from "./project-automations.ts";
import { errorText, home, listProjects, projectDir, saveJson, type Project } from "./state.ts";
import type { DurableProjectRuntime } from "./durable-runtime.ts";

/** One thing the owner should hear about: a needs-you question, a finished coordinator turn, or a failed one. */
export type Notice = {
  seq: number;
  at: number;
  projectId: string;
  project: string;
  chatId: string;
  chat: string;
  kind: "question" | "result" | "error" | "pr";
  title: string;
  text: string;
  entryId?: string;
  choices?: string[];
  workId?: string;
  threadId?: string;
  /** A Ready report for this Job; with `mergeable`, Telegram offers Approve. */
  jobId?: string;
  mergeable?: boolean;
};
/** `workBaselined`: failed work existing before worker-failure notices (or before the project was first scanned) was marked seen silently. */
type ProjectState = { seen: string[]; chats: Record<string, number>; workBaselined?: boolean };
type State = { version: 1; startedAt: number; seq: number; feed: Notice[]; projects: Record<string, ProjectState> };
const FEED = 200,
  SEEN = 2000,
  TEXT = 3500;
const clip = (text: string, max = TEXT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Host-wide notification feed (`<home>/notifications.json`, 0600). A scan every few seconds reads each open Durable project's inbox
 * and, per chat, coordinator input submissions newer than the last one handled; it never depends on catching a busy flag.
 * Projects and chats that existed when the feed was first created are baselined silently; later ones report everything.
 * The feed keeps the newest 200 notices; consumers (browser, Telegram) keep their own cursors on `seq`.
 */
export function startNotifier(options: {
  owner: (project: Project) => Promise<DurableProjectRuntime> | null;
  tickMs: number;
  onNotice: () => void;
  /** Each running Job's plan as it changes, for the per-Job progress message. */
  progress?: (view: JobProgress) => void;
  report: (detail: string) => void;
}) {
  const path = join(home(), "notifications.json");
  const state: State = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { version: 1, startedAt: Date.now(), seq: 0, feed: [], projects: {} };
  if (!existsSync(path)) saveJson(path, state);
  const progressSeen = new Map<string, string>();
  let scanning: Promise<void> | null = null,
    closed = false;
  const push = (notice: Omit<Notice, "seq" | "at">) => {
    state.feed.push({ ...notice, seq: ++state.seq, at: Date.now() });
    if (state.feed.length > FEED) state.feed.splice(0, state.feed.length - FEED);
  };

  async function scanProject(project: Project, owner: DurableProjectRuntime): Promise<boolean> {
    const known = state.projects[project.id];
    const silent = !known && Date.parse(project.createdAt) < state.startedAt;
    const entry: ProjectState = known ?? { seen: [], chats: {} };
    const before = state.seq,
      seen = new Set(entry.seen);
    const chats = await owner.chats();
    const chatOf = (conversationId?: number) => chats.find((chat) => chat.conversationId === conversationId) ?? chats[0];
    const base = { projectId: project.id, project: project.name };
    for (const item of inbox(projectDir(project.id)).filter((item) => !item.result)) {
      const key = `inbox:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (silent) continue;
      const chat = chatOf(item.native?.conversationId);
      push({
        ...base,
        chatId: chat.id,
        chat: chat.title,
        kind: "question",
        title: item.title,
        text: clip(item.question),
        entryId: item.id,
        choices: [...item.choices],
      });
    }
    // CI failed / PR merged (Follow PRs and the provider PR monitors): one notice each, in the events chat.
    const eventChat = loadAutomations(project.id).eventChat,
      eventTarget = chats.find((chat) => chat.id === eventChat && !chat.archived) ?? chats[0];
    for (const item of await owner.prNotices()) {
      const target = (item.chat !== undefined && chats.find((chat) => chat.conversationId === item.chat && !chat.archived)) || eventTarget;
      const key = `prnotice:${item.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (silent) continue;
      push({
        ...base,
        chatId: target.id,
        chat: target.title,
        kind: "pr",
        title: PR_NOTICE_TITLE[item.kind] ?? "Pull request",
        text: clip(item.text),
      });
    }
    const { jobs, agents } = await owner.jobs();
    for (const job of jobs) {
      if (job.status !== "running" || !job.plan.length) continue;
      const view: JobProgress = {
        projectId: project.id,
        chatId: chatOf(Number(job.chat)).id,
        jobId: job.id,
        title: job.title,
        steps: job.plan.map((step) => ({ title: step.title, status: step.status, estimateMin: step.estimateMin ?? 0 })),
        etaMin: job.eta.etaMin,
      };
      const fingerprint = JSON.stringify(view);
      if (progressSeen.get(job.id) === fingerprint) continue;
      progressSeen.set(job.id, fingerprint);
      options.progress?.(view);
    }
    // Failed workers and Ready reports have no notice of their own: the coordinator's settled answer carries the explanation (and Approve).
    entry.workBaselined = true;
    // Background turns stay quiet while work runs; answers to Telegram owner messages do not wait for the workers.
    const working = new Set(jobs.filter((job) => job.status === "running").map((job) => chatOf(Number(job.chat)).id));
    for (const agent of agents) if (agent.working || (!agent.jobId && agent.endedAt === null)) working.add(chatOf(Number(agent.chat)).id);
    for (const chat of chats) {
      const after = entry.chats[chat.id];
      // Archived chats are skipped, but baselined once so a restored chat does not replay its history.
      if (chat.archived && after !== undefined) continue;
      const quiet = after === undefined && (silent || chat.archived);
      const submissions = await owner.chatSubmissions(chat.id, after ?? -1);
      // A batch can end with an event but still answer an earlier owner message.
      const telegramAnswers = new Set(
        submissions.flatMap((item) => (item.answerId !== null && item.origin === "telegram" ? [item.answerId] : [])),
      );
      let last = after ?? -1;
      for (const [index, submission] of submissions.entries()) {
        if (submission.status === "queued" || submission.status === "placed") break;
        last = submission.id;
        if (quiet) continue;
        const direct = submission.origin === "telegram" || (submission.answerId !== null && telegramAnswers.has(submission.answerId));
        if (
          submission.status === "done" &&
          submission.text?.trim() &&
          (direct || !working.has(chat.id)) &&
          // Follow PRs events about the project's own PRs wake the coordinator; PR notices already cover CI and merges.
          (direct || !submission.requestId?.startsWith("event:follow:")) &&
          !submissions.slice(index + 1).some((later) => later.answerId !== null && later.answerId === submission.answerId)
        ) {
          const report = submissions.some((item) => item.answerId === submission.answerId && item.requestId?.startsWith("report:"));
          const approvable =
            !working.has(chat.id) && (!direct || report)
              ? jobs
                  .filter(
                    (job) => !job.workspace && (job.status === "ready" || job.status === "ready-with-gaps") && job.pr && job.candidate,
                  )
                  .filter((job) => chatOf(Number(job.chat)).id === chat.id)
                  .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))[0]
              : undefined;
          push({
            ...base,
            chatId: chat.id,
            chat: chat.title,
            kind: "result",
            title: direct && !report ? "Reply" : "Finished",
            text: extractTelegramMedia(submission.text).media.some((media) => media.ref.startsWith("artifact:"))
              ? submission.text.trim()
              : clip(submission.text.trim()),
            ...(approvable ? { jobId: approvable.id, mergeable: true } : {}),
          });
        } else if (submission.status === "unanswered" && submission.reason !== "aborted")
          push({
            ...base,
            chatId: chat.id,
            chat: chat.title,
            kind: "error",
            title: "Coordinator turn failed",
            text: clip(`${submission.reason ?? "failed"}${submission.detail ? `: ${submission.detail}` : ""}`),
          });
      }
      entry.chats[chat.id] = last;
    }
    entry.seen = [...seen].slice(-SEEN);
    const changed = !known || state.seq !== before || JSON.stringify(known) !== JSON.stringify(entry);
    state.projects[project.id] = entry;
    return changed;
  }

  async function scan(): Promise<void> {
    let changed = false;
    for (const project of listProjects().filter((item) => !item.deleted && !item.archived)) {
      if (closed) return;
      const opening = options.owner(project);
      if (!opening) continue;
      const before = state.seq;
      try {
        if (await scanProject(project, await opening)) changed = true;
      } catch (error) {
        options.report(`${project.id}: ${errorText(error)}`);
      }
      if (state.seq !== before) changed = true;
    }
    if (changed && !closed) {
      saveJson(path, state);
      options.onNotice();
    }
  }
  const tick = () => {
    if (!scanning && !closed)
      scanning = scan()
        .catch((error) => options.report(errorText(error)))
        .finally(() => {
          scanning = null;
        });
  };
  const timer = setInterval(tick, options.tickMs);
  timer.unref();
  setTimeout(tick, 50).unref();
  return {
    feed: (after?: number) => ({ seq: state.seq, items: after === undefined ? [] : state.feed.filter((item) => item.seq > after) }),
    seq: () => state.seq,
    scan: tick,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await scanning;
    },
  };
}
export type Notifier = ReturnType<typeof startNotifier>;
