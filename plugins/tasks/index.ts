import type { HostPluginApi, PluginRpcContext, SectionRow, SectionTone } from "../../src/plugin-types.ts";
import { createTaskStore, isChatId, type Stage, type Task } from "./store.ts";
import { COORDINATOR_NOTE, createTaskTools } from "./tools.ts";

const STAGES: Record<Stage, { label: string; tone: SectionTone }> = {
  planned: { label: "Planned", tone: "neutral" },
  "in-progress": { label: "In progress", tone: "work" },
  "in-review": { label: "In review", tone: "neutral" },
  blocked: { label: "Blocked", tone: "needs" },
  done: { label: "Done", tone: "neutral" },
};

function row(task: Task): SectionRow {
  const pr = task.pr && `${task.pr.provider} ${task.pr.repository}#${task.pr.number}`;
  const detail = [...(pr && task.pr?.url ? [] : [pr ?? "no PR"]), ...(task.job ? [task.job] : []), ...(task.note ? [task.note] : [])];
  return {
    text: task.title,
    status: STAGES[task.stage],
    ...(pr && task.pr?.url ? { links: [{ label: pr.length > 300 ? `${pr.slice(0, 299)}…` : pr, url: task.pr.url }] } : {}),
    detail,
  };
}

/**
 * Optional task lists for the Coordinator: one durable list per project and chat, written only by the tools of that chat's own
 * Coordinator conversation and shown in the Tasks section of the right panel. Failure cases: FAILURES.md.
 */
export default {
  name: "tasks",
  version: "1.0.0",
  register(api: HostPluginApi) {
    const store = createTaskStore(api.stateDir);
    const tools = createTaskTools(api, store);
    const project = (context: PluginRpcContext) => {
      if (!context.projectId) throw new Error("Tasks need a project id");
      api.projects.load(context.projectId);
      return context.projectId;
    };
    api.provide({
      coordinatorTools: {
        applies: () => true,
        prompt: { name: "Tasks", text: COORDINATOR_NOTE },
        create: (input) => tools.coordinator(input),
      },
      // Read-only: the browser and the Host agent never write a chat's list.
      rpc: {
        list: async (context) => {
          const params = context.params as { chatId?: unknown } | undefined;
          if (!params || Object.keys(params).length !== 1 || !isChatId(params.chatId)) throw new Error("list needs { chatId } of a chat");
          return { tasks: store.list(project(context), params.chatId) };
        },
      },
      rpcPolicy: { list: "read" },
      sections: {
        tasks: {
          title: "Tasks",
          place: "chat",
          refreshMs: 3000,
          read: async ({ projectId, chatId }) => {
            if (!projectId || !isChatId(chatId)) throw new Error("Tasks need a project and a chat");
            api.projects.load(projectId);
            const tasks = store.list(projectId, chatId),
              open = tasks.filter((task) => task.stage !== "done"),
              finished = tasks.length - open.length;
            return { rows: open.map(row), empty: "No open tasks.", ...(finished ? { footer: `${finished} finished` } : {}) };
          },
        },
      },
    });
  },
};
