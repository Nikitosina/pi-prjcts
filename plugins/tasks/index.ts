import { fileURLToPath } from "node:url";
import type { HostPluginApi, PluginRpcContext } from "../../src/plugin-types.ts";
import { createTaskStore, isChatId } from "./store.ts";
import { COORDINATOR_NOTE, createTaskTools } from "./tools.ts";

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
      web: {
        script: fileURLToPath(new URL("ui.js", import.meta.url)),
        style: fileURLToPath(new URL("ui.css", import.meta.url)),
        sidebar: { title: "Tasks" },
      },
    });
  },
};
