import type { Conversation, HostPluginApi, ToolExecutionApi } from "../../src/plugin-types.ts";
import { MAX_NOTE, MAX_TITLE, OPEN_STAGES, checkPr, type TaskStore } from "./store.ts";

/** The Coordinator's task rules: the editable "Tasks" integration block. */
export const COORDINATOR_NOTE = `- Tasks: keep one task per parallel stream of work in this chat (tasks_list, tasks_add, tasks_update, tasks_attach_pr, tasks_finish); the owner sees them in the Tasks section of the right panel. Add a task when you start a stream, even when no Job exists yet. Update its stage at every transition and note what blocks it. Attach a PR only with the provider, repository and number its publication reported; never guess them, never copy them from another task or the project's default repository. A PR that has no task stays as it is. Finish a task when its work is merged, abandoned or answered, and list open tasks with their stages and PRs when you report on parallel work.`;

export function createTaskTools(host: HostPluginApi, store: TaskStore) {
  const { defineExtension, defineTool } = host.lib.durable,
    { Type } = host.lib.typebox;
  const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const Title = Type.String({ minLength: 1, maxLength: MAX_TITLE });
  const Note = Type.String({ maxLength: MAX_NOTE });
  const Job = Type.String({ minLength: 1, maxLength: 80, description: "Job or worker id the task follows, when there is one" });
  const Stage = Type.Union(OPEN_STAGES.map((stage) => Type.Literal(stage)));
  const Id = Type.String({ minLength: 1, maxLength: 40 });
  const strict = { additionalProperties: false };

  return {
    coordinator(input: {
      projectId: string;
      isCoordinator: (id: Conversation["id"]) => boolean;
      chatIdOf: (id: Conversation["id"]) => string | undefined;
    }) {
      // The chat is the caller's own chat; no argument can name another one.
      const caller = (api: ToolExecutionApi) => {
        const chatId = input.isCoordinator(api.conversationId) ? input.chatIdOf(api.conversationId) : undefined;
        if (!chatId) throw new Error("Tasks tools are coordinator-only");
        return chatId;
      };
      const list = defineTool({
        name: "tasks_list",
        description: "List this chat's tasks (open and recently finished) with stage, note and attached PR. Read-only.",
        parameters: Type.Object({}, strict),
        replay: "safe",
        async execute(_args, api) {
          return json({ tasks: store.list(input.projectId, caller(api)) });
        },
      });
      const add = defineTool({
        name: "tasks_add",
        description: "Add a task to this chat's list. A task needs no Job and no PR. Returns the task with its id.",
        parameters: Type.Object({ title: Title, stage: Type.Optional(Stage), note: Type.Optional(Note), job: Type.Optional(Job) }, strict),
        replay: "unsafe",
        async execute(args, api) {
          return json(store.add(input.projectId, caller(api), args));
        },
      });
      const update = defineTool({
        name: "tasks_update",
        description: "Change an open task's title, stage, note or job. Use tasks_finish to complete it.",
        parameters: Type.Object(
          { id: Id, title: Type.Optional(Title), stage: Type.Optional(Stage), note: Type.Optional(Note), job: Type.Optional(Job) },
          strict,
        ),
        replay: "safe",
        async execute({ id, ...patch }, api) {
          return json(store.update(input.projectId, caller(api), id, patch));
        },
      });
      const attach = defineTool({
        name: "tasks_attach_pr",
        description:
          "Attach the PR a task produced. Give the provider id, the repository and the PR number exactly as the publication reported them; they are never inferred. One PR belongs to one task; another PR on the same task needs replace: true.",
        parameters: Type.Object(
          {
            id: Id,
            provider: Type.String({ description: "PR provider id, for example github" }),
            repository: Type.String({ description: "Repository as that provider names it, for example owner/name" }),
            number: Type.String({ description: "PR number or id as a string" }),
            url: Type.Optional(Type.String({ description: "http(s) link to the PR" })),
            replace: Type.Optional(Type.Boolean()),
          },
          strict,
        ),
        replay: "safe",
        async execute({ id, replace, ...pr }, api) {
          return json(store.attachPr(input.projectId, caller(api), id, checkPr(pr), replace === true));
        },
      });
      const finish = defineTool({
        name: "tasks_finish",
        description: "Finish a task (merged, abandoned or answered). Finishing again changes nothing.",
        parameters: Type.Object({ id: Id, note: Type.Optional(Note) }, strict),
        replay: "safe",
        async execute({ id, note }, api) {
          return json(store.finish(input.projectId, caller(api), id, note));
        },
      });
      const tools = [list, add, update, attach, finish];
      return { tools, extension: defineExtension({ name: "projects.tasks", tools }) };
    },
  };
}
