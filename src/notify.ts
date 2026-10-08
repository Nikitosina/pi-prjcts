import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inbox } from "./inbox.ts";
import { errorText, home, listProjects, projectDir, saveJson, type Project } from "./state.ts";
import type { DurableProjectRuntime } from "./durable-runtime.ts";

/** One thing the owner should hear about: a needs-you question or approval, a finished coordinator turn, or a failed one. */
export type Notice = {
  seq: number; at: number; projectId: string; project: string; chatId: string; chat: string;
  kind: "question" | "approval" | "result" | "error"; title: string; text: string;
  entryId?: string; choices?: string[]; operationId?: string; fingerprint?: string; workId?: string; threadId?: string;
};
/** `workBaselined`: failed work existing before worker-failure notices (or before the project was first scanned) was marked seen silently. */
type ProjectState = { seen: string[]; chats: Record<string, number>; workBaselined?: boolean };
type State = { version: 1; startedAt: number; seq: number; feed: Notice[]; projects: Record<string, ProjectState> };
const FEED = 200, SEEN = 2000, TEXT = 3500;
const clip = (text: string, max = TEXT) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Host-wide notification feed (`<home>/notifications.json`, 0600). A scan every few seconds reads each open Durable project's inbox,
 * pending approvals and, per chat, coordinator input submissions newer than the last one handled; it never depends on catching a busy flag.
 * Projects and chats that existed when the feed was first created are baselined silently; later ones report everything.
 * The feed keeps the newest 200 notices; consumers (browser, Telegram) keep their own cursors on `seq`.
 */
export function startNotifier(options: { owner: (project: Project) => Promise<DurableProjectRuntime> | null; tickMs: number; onNotice: () => void; report: (detail: string) => void }) {
  const path = join(home(), "notifications.json");
  const state: State = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, startedAt: Date.now(), seq: 0, feed: [], projects: {} };
  if (!existsSync(path)) saveJson(path, state);
  let scanning: Promise<void> | null = null, closed = false;
  const push = (notice: Omit<Notice, "seq" | "at">) => { state.feed.push({ ...notice, seq: ++state.seq, at: Date.now() }); if (state.feed.length > FEED) state.feed.splice(0, state.feed.length - FEED); };

  async function scanProject(project: Project, owner: DurableProjectRuntime): Promise<boolean> {
    const known = state.projects[project.id];
    const silent = !known && Date.parse(project.createdAt) < state.startedAt;
    const entry: ProjectState = known ?? { seen: [], chats: {} };
    const before = state.seq, seen = new Set(entry.seen);
    const chats = await owner.chats();
    const chatOf = (conversationId?: number) => chats.find(chat => chat.conversationId === conversationId) ?? chats[0];
    const base = { projectId: project.id, project: project.name };
    for (const item of inbox(projectDir(project.id)).filter(item => !item.result)) {
      const key = `inbox:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (silent) continue;
      const chat = chatOf(item.native?.conversationId);
      push({ ...base, chatId: chat.id, chat: chat.title, kind: "question", title: item.title, text: clip(item.question), entryId: item.id, choices: [...item.choices] });
    }
    for (const record of (await owner.operationSnapshot({ action: "operation-snapshot", id: project.id, status: "pending", offset: 0, limit: 100 })).items) {
      const key = `operation:${record.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (silent) continue;
      const op = record.operation, what = op.kind === "command" ? `command ${op.effect} in ${op.repositoryId}` : `${op.kind} ${op.repositoryId} PR #${op.pullRequest} at ${op.expectedHead.slice(0, 7)}`;
      push({ ...base, chatId: "main", chat: chats[0].title, kind: "approval", title: `${op.provider} ${what}`, text: `Approval needed: ${op.provider} ${what}. Approving records consent only; it does not execute.`, operationId: record.id, fingerprint: record.fingerprint });
    }
    // A failed worker goes to the chat that delegated it. Stopped and interrupted work (owner stop, pause, restart) is not a failure.
    const quietWork = silent || !entry.workBaselined;
    const planWork = (await owner.planSnapshot()).work;
    for (const work of planWork) {
      if (work.status !== "failed") continue;
      const key = `work:${work.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (quietWork) continue;
      const chat = work.chatConversationId === null ? chats[0] : chatOf(work.chatConversationId);
      const task = work.text.replace(/\s+/g, " ").trim();
      push({ ...base, chatId: chat.id, chat: chat.title, kind: "error", title: `${work.parentThreadId ? "Sub-agent" : work.role[0].toUpperCase() + work.role.slice(1)} failed`, text: clip(`${work.role} failed: ${task.length > 200 ? `${task.slice(0, 199)}…` : task}${work.blocker ? `\n${work.blocker}` : ""}`), workId: work.id, threadId: work.threadId });
    }
    entry.workBaselined = true;
    // A coordinator turn is a result only when nothing is still running in its chat and no work report follows it (a later report turn means
    // work was still running when it was written); batched submissions share one answer and notify once. Intermediate status lines stay quiet.
    const working = new Set(planWork.filter(work => work.status === "queued" || work.status === "running").map(work => work.chatConversationId === null ? chats[0].id : chatOf(work.chatConversationId).id));
    for (const chat of chats) {
      const after = entry.chats[chat.id];
      // Archived chats are skipped, but baselined once so a restored chat does not replay its history.
      if (chat.archived && after !== undefined) continue;
      const quiet = after === undefined && (silent || chat.archived);
      const submissions = await owner.chatSubmissions(chat.id, after ?? -1);
      let last = after ?? -1;
      for (const [index, submission] of submissions.entries()) {
        if (submission.status === "queued" || submission.status === "placed") break;
        last = submission.id;
        if (quiet) continue;
        // Watchdog checks are internal coordinator turns, never an owner-facing "Finished".
        if (submission.requestId?.startsWith("event:watchdog:")) continue;
        if (submission.status === "done" && submission.text?.trim() && !working.has(chat.id) && !submissions.slice(index + 1).some(later => later.requestId?.startsWith("plan-report:") || later.answerId !== null && later.answerId === submission.answerId)) push({ ...base, chatId: chat.id, chat: chat.title, kind: "result", title: "Finished", text: clip(submission.text.trim()) });
        else if (submission.status === "unanswered" && submission.reason !== "aborted") push({ ...base, chatId: chat.id, chat: chat.title, kind: "error", title: "Coordinator turn failed", text: clip(`${submission.reason ?? "failed"}${submission.detail ? `: ${submission.detail}` : ""}`) });
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
    for (const project of listProjects().filter(item => !item.deleted && !item.archived)) {
      if (closed) return;
      const opening = options.owner(project);
      if (!opening) continue;
      const before = state.seq;
      try { if (await scanProject(project, await opening)) changed = true; }
      catch (error) { options.report(`${project.id}: ${errorText(error)}`); }
      if (state.seq !== before) changed = true;
    }
    if (changed && !closed) { saveJson(path, state); options.onNotice(); }
  }
  const tick = () => { if (!scanning && !closed) scanning = scan().catch(error => options.report(errorText(error))).finally(() => { scanning = null; }); };
  const timer = setInterval(tick, options.tickMs);
  timer.unref();
  setTimeout(tick, 50).unref();
  return {
    feed: (after?: number) => ({ seq: state.seq, items: after === undefined ? [] : state.feed.filter(item => item.seq > after) }),
    seq: () => state.seq,
    scan: tick,
    close: async () => { closed = true; clearInterval(timer); await scanning; },
  };
}
export type Notifier = ReturnType<typeof startNotifier>;
