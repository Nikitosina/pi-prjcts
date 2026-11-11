// notes: the example plugin of docs/plugins. Short notes per project, kept in the plugin's state directory.
// The owner's browser (the panel in Settings → Plugins) and the Host agent use the RPC methods; coordinators and workers use the tools.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = /^[a-f0-9-]{36}$/;

export default {
  name: "notes",
  version: "1.0.0",
  register(api) {
    const { defineTool, defineExtension } = api.lib.durable;
    const { Type } = api.lib.typebox;
    const { Value } = api.lib.value;

    const file = (projectId) => {
      if (!PROJECT_ID.test(projectId ?? "")) throw new Error("notes need a project id");
      return join(api.stateDir, `${projectId}.json`);
    };
    const read = (projectId) => (existsSync(file(projectId)) ? JSON.parse(readFileSync(file(projectId), "utf8")) : []);
    const add = (projectId, text) => {
      const notes = [...read(projectId), { text, at: new Date().toISOString() }];
      writeFileSync(file(projectId), JSON.stringify(notes));
      return notes;
    };
    const text = (value) => ({ output: [{ type: "text", text: JSON.stringify(value) }] });
    const AddParams = Type.Object({ text: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false });

    api.provide({
      rpc: {
        list: async ({ projectId }) => ({ notes: read(projectId) }),
        add: async ({ projectId, params }) => {
          if (!Value.Check(AddParams, params)) throw new Error("add needs { text } of 1 to 500 characters");
          return { notes: add(projectId, params.text) };
        },
        clear: async ({ projectId }) => {
          writeFileSync(file(projectId), "[]");
          return { notes: [] };
        },
      },
      // Clearing loses data, so the Host agent needs the owner's approval for it.
      rpcPolicy: { list: "read", add: "write", clear: "dangerous" },
      web: { script: fileURLToPath(new URL("ui.js", import.meta.url)), style: fileURLToPath(new URL("ui.css", import.meta.url)) },

      coordinatorTools: {
        applies: () => true,
        prompt: {
          name: "Project notes",
          text: "- Project notes: read them with notes_read before planning; record lasting facts with notes_add.",
        },
        create: ({ projectId, isCoordinator }) => {
          const coordinatorOnly = (toolApi) => {
            if (!isCoordinator(toolApi.conversationId)) throw new Error("notes tools are coordinator-only");
          };
          const readTool = defineTool({
            name: "notes_read",
            description: "Read this project's notes. Read-only.",
            parameters: Type.Object({}, { additionalProperties: false }),
            replay: "safe",
            async execute(_args, toolApi) {
              coordinatorOnly(toolApi);
              return text(read(projectId));
            },
          });
          const addTool = defineTool({
            name: "notes_add",
            description: "Add one short note to this project's notes.",
            parameters: AddParams,
            replay: "unsafe",
            async execute(args, toolApi) {
              coordinatorOnly(toolApi);
              return text(add(projectId, args.text));
            },
          });
          const tools = [readTool, addTool];
          return { tools, extension: defineExtension({ name: "projects.notes", tools }) };
        },
      },

      workerTools: {
        offered: () => true,
        instructions: "\n\nProject notes: notes_worker_read lists the notes the Coordinator recorded for this project.",
        create: ({ projectId, conversationId }) => [
          defineTool({
            name: "notes_worker_read",
            description: "Read this project's notes. Read-only.",
            parameters: Type.Object({}, { additionalProperties: false }),
            replay: "safe",
            async execute(_args, toolApi) {
              if (Number(toolApi.conversationId) !== conversationId) throw new Error("notes tools belong to another worker");
              return text(read(projectId));
            },
          }),
        ],
      },
    });
  },
};
