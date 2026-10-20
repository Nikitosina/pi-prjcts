import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { HostPluginApi, PluginRpcContext } from "../../src/plugin-types.ts";
import { createSimulators, leaseName } from "./simulator.ts";
import { COORDINATOR_NOTE, WORKER_NOTE, createSimulatorTools } from "./tools.ts";

/**
 * Optional iOS simulators per project: owner-enabled clones of a shut-down simulator, managed by the coordinator,
 * leased to whole-repository workers and shown read-only in a project card. Needs simslim and XcodeBuildMCP on a Mac.
 * Ownership and request receipts persist in each project's `simulator.json`. Failure cases: FAILURES.md.
 */
export default {
  name: "simulator",
  register(api: HostPluginApi) {
    const simulators = createSimulators(api);
    const tools = createSimulatorTools(api, simulators);
    const { Type } = api.lib.typebox, { Value } = api.lib.value;
    const Id = Type.String({ pattern: "^[a-f0-9-]{36}$" }), Udid = Type.Optional(Type.String({ pattern: "^[a-fA-F0-9-]{36}$" }));
    const Configure = Type.Object({ enabled: Type.Boolean(), sourceUdid: Udid, requestId: Id }, { additionalProperties: false });
    const Act = Type.Object({ operation: simulators.SimulatorAction, requestId: Id, udid: Udid, sourceUdid: Udid }, { additionalProperties: false });
    const Recover = Type.Object({ confirm: Id, requestId: Id }, { additionalProperties: false });
    const project = (context: PluginRpcContext) => { if (!context.projectId) throw new Error("Simulator requests need a project id"); api.projects.load(context.projectId); return context.projectId; };
    const params = <T extends TSchema>(schema: T, value: unknown): Static<T> => { if (!Value.Check(schema, value)) throw new Error("Invalid simulator request"); return value; };
    api.provide({
      coordinatorTools: { applies: () => true, instructions: () => COORDINATOR_NOTE, create: input => tools.coordinator(input) },
      workerTools: { offered: simulators.enabled, create: input => tools.worker(input), instructions: WORKER_NOTE },
      leaseName,
      lifecycle: { pause: simulators.pause, close: simulators.close },
      rpc: {
        snapshot: async context => simulators.snapshot(project(context)),
        configure: async context => simulators.configure(project(context), params(Configure, context.params)),
        action: async context => { const id = project(context), input = params(Act, context.params); return simulators.act(id, input.operation, input.requestId, { udid: input.udid, sourceUdid: input.sourceUdid }); },
        recover: async context => simulators.recover(project(context), params(Recover, context.params)),
      },
      web: {
        script: fileURLToPath(new URL("web/ui.js", import.meta.url)),
        style: fileURLToPath(new URL("web/ui.css", import.meta.url)),
        routes: {
          frame: async ({ projectId, query }) => {
            const udid = query.get("udid") ?? undefined;
            if (udid !== undefined && !/^[a-fA-F0-9-]{36}$/.test(udid)) throw new Error("Invalid simulator UDID");
            return simulators.frame(projectId, udid);
          },
        },
      },
    });
  },
};
