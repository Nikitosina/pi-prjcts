import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OPEN_STAGES = ["planned", "in-progress", "in-review", "blocked"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];
export type Stage = OpenStage | "done";

export type TaskPr = { provider: string; repository: string; number: string; url?: string };
export type Task = {
  id: string;
  title: string;
  stage: Stage;
  note?: string;
  job?: string;
  pr?: TaskPr;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};
type Lists = Record<string, Task[]>;

export const MAX_OPEN = 50;
export const MAX_FINISHED = 50;
export const MAX_TITLE = 200;
export const MAX_NOTE = 500;
const PROJECT_ID = /^[a-f0-9-]{36}$/;
const CHAT_ID = /^(main|[a-f0-9-]{36})$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,39}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const PR_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isChatId = (value: unknown): value is string => typeof value === "string" && CHAT_ID.test(value);

export function checkPr(input: { provider: string; repository: string; number: string; url?: string }): TaskPr {
  if (!PROVIDER.test(input.provider)) throw new Error("provider must be a PR provider id such as github");
  if (!REPOSITORY.test(input.repository)) throw new Error("repository must be the repository name the provider uses, without spaces");
  if (!PR_NUMBER.test(input.number)) throw new Error("number must be the PR id the provider reported");
  if (input.url === undefined) return { provider: input.provider, repository: input.repository, number: input.number };
  let protocol = "";
  try {
    protocol = new URL(input.url).protocol;
  } catch {}
  if ((protocol !== "https:" && protocol !== "http:") || input.url.length > 500)
    throw new Error("url must be an http(s) link of at most 500 characters");
  return { provider: input.provider, repository: input.repository, number: input.number, url: input.url };
}

const samePr = (a: TaskPr, b: TaskPr) => a.provider === b.provider && a.repository === b.repository && a.number === b.number;

/** Durable task lists, one file per project holding one list per chat. Every change is a synchronous read-modify-write with an atomic replace. */
export function createTaskStore(dir: string, now: () => Date = () => new Date()) {
  const file = (projectId: string) => {
    if (!PROJECT_ID.test(projectId ?? "")) throw new Error("Tasks need a project id");
    return join(dir, `${projectId}.json`);
  };
  const read = (projectId: string): Lists => {
    const path = file(projectId);
    if (!existsSync(path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every(Array.isArray))
        throw new Error("shape");
      return parsed as Lists;
    } catch {
      throw new Error(`The tasks file of this project is unreadable (${path}); it was left untouched`);
    }
  };
  const write = (projectId: string, lists: Lists) => {
    const path = file(projectId);
    writeFileSync(`${path}.tmp`, JSON.stringify(lists), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  const chat = (chatId: string) => {
    if (!isChatId(chatId)) throw new Error("Tasks need a chat id");
    return chatId;
  };
  const change = <T>(projectId: string, chatId: string, apply: (tasks: Task[]) => T): T => {
    const lists = read(projectId);
    const tasks = lists[chat(chatId)] ?? [];
    const result = apply(tasks);
    const finished = tasks.filter((task) => task.stage === "done");
    lists[chatId] = tasks.filter((task) => task.stage !== "done" || finished.indexOf(task) >= finished.length - MAX_FINISHED);
    write(projectId, lists);
    return result;
  };
  const find = (tasks: Task[], id: string) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Unknown task ${id} in this chat`);
    return task;
  };
  const open = (tasks: Task[], id: string) => {
    const task = find(tasks, id);
    if (task.stage === "done") throw new Error(`Task ${id} is finished`);
    return task;
  };
  const stamp = (task: Task) => {
    task.updatedAt = now().toISOString();
    return task;
  };
  const clean = <T extends Task>(task: T): T => JSON.parse(JSON.stringify(task));

  return {
    list: (projectId: string, chatId: string): Task[] => (read(projectId)[chat(chatId)] ?? []).map(clean),
    add(projectId: string, chatId: string, input: { title: string; stage?: OpenStage; note?: string; job?: string }): Task {
      return change(projectId, chatId, (tasks) => {
        if (tasks.filter((task) => task.stage !== "done").length >= MAX_OPEN)
          throw new Error(`This chat already has ${MAX_OPEN} open tasks; finish some before adding more`);
        const at = now().toISOString();
        const task: Task = {
          id: randomUUID().slice(0, 8),
          title: input.title,
          stage: input.stage ?? "planned",
          createdAt: at,
          updatedAt: at,
        };
        if (input.note !== undefined) task.note = input.note;
        if (input.job !== undefined) task.job = input.job;
        tasks.push(task);
        return clean(task);
      });
    },
    update(projectId: string, chatId: string, id: string, patch: { title?: string; stage?: OpenStage; note?: string; job?: string }): Task {
      return change(projectId, chatId, (tasks) => {
        const task = open(tasks, id);
        Object.assign(task, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
        return clean(stamp(task));
      });
    },
    attachPr(projectId: string, chatId: string, id: string, pr: TaskPr, replace: boolean): Task {
      return change(projectId, chatId, (tasks) => {
        const task = open(tasks, id);
        const holder = tasks.find((item) => item.pr && samePr(item.pr, pr));
        if (holder && holder.id !== id) throw new Error(`That PR is already attached to task ${holder.id}`);
        if (task.pr && samePr(task.pr, pr) && task.pr.url === pr.url) return clean(task);
        if (task.pr && !samePr(task.pr, pr) && !replace)
          throw new Error("This task already has another PR; pass replace: true to replace it");
        task.pr = pr;
        return clean(stamp(task));
      });
    },
    finish(projectId: string, chatId: string, id: string, note?: string): Task {
      return change(projectId, chatId, (tasks) => {
        const task = find(tasks, id);
        if (task.stage === "done") return clean(task);
        task.stage = "done";
        if (note !== undefined) task.note = note;
        task.finishedAt = now().toISOString();
        return clean(stamp(task));
      });
    },
  };
}
export type TaskStore = ReturnType<typeof createTaskStore>;
