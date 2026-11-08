import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { HostPluginApi, PluginRpcContext } from "../../src/plugin-types.ts";
import { createSimulators, leaseName } from "./simulator.ts";
import { pruneTestProducts } from "./test-products.ts";
import { COORDINATOR_NOTE, WORKER_NOTE, createSimulatorTools } from "./tools.ts";

const TEST_PRODUCTS_ROOT = join(homedir(), "Library", "Developer", "XcodeBuildMCP", "workspaces");
const TEST_PRODUCTS_KEEP_MS = 2 * 3600_000;
const pruneXcodeTestProducts = async () => {
  const { removed, bytes } = await pruneTestProducts({ root: TEST_PRODUCTS_ROOT, now: Date.now(), keepMs: TEST_PRODUCTS_KEEP_MS });
  return removed ? `XcodeBuildMCP: removed ${removed} old test products (${(bytes / 1024 ** 3).toFixed(1)} GB).` : "";
};

/**
 * Optional iOS simulators per project: owner-enabled clones of a shut-down simulator, managed by the coordinator,
 * leased to whole-repository workers and shown read-only in a project card. Needs simslim and XcodeBuildMCP on a Mac.
 * Ownership and request receipts persist in each project's `simulator.json`. Failure cases: FAILURES.md.
 */
export default {
  name: "simulator",
  register(api: HostPluginApi) {
    const simulators = createSimulators(api);
    // Each simulator test run leaves 2-4 GB of test products; a daily cleanup is too rare for a busy afternoon (FAILURES.md T1-T4).
    const pruning = setInterval(() => void pruneXcodeTestProducts().catch(() => {}), 3600_000);
    pruning.unref();
    const tools = createSimulatorTools(api, simulators);
    const { Type } = api.lib.typebox,
      { Value } = api.lib.value;
    const Id = Type.String({ pattern: "^[a-f0-9-]{36}$" }),
      Udid = Type.Optional(Type.String({ pattern: "^[a-fA-F0-9-]{36}$" }));
    const Configure = Type.Object({ enabled: Type.Boolean(), sourceUdid: Udid, requestId: Id }, { additionalProperties: false });
    const Act = Type.Object(
      { operation: simulators.SimulatorAction, requestId: Id, udid: Udid, sourceUdid: Udid },
      { additionalProperties: false },
    );
    const Recover = Type.Object({ confirm: Id, requestId: Id }, { additionalProperties: false });
    const project = (context: PluginRpcContext) => {
      if (!context.projectId) throw new Error("Simulator requests need a project id");
      api.projects.load(context.projectId);
      return context.projectId;
    };
    const params = <T extends TSchema>(schema: T, value: unknown): Static<T> => {
      if (!Value.Check(schema, value)) throw new Error("Invalid simulator request");
      return value;
    };
    api.provide({
      coordinatorTools: {
        applies: () => true,
        prompt: { name: "iOS simulators", text: COORDINATOR_NOTE, on: (project) => simulators.enabled(project.id) },
        create: (input) => tools.coordinator(input),
      },
      workerTools: { offered: simulators.enabled, create: (input) => tools.worker(input), instructions: WORKER_NOTE },
      leaseName,
      lifecycle: {
        pause: simulators.pause,
        close: async () => {
          clearInterval(pruning);
          await simulators.close();
        },
      },
      cleanup: async (input) =>
        [await simulators.eraseIdle(input.projectId, input.unusedDays, input.signal), await pruneXcodeTestProducts()]
          .filter(Boolean)
          .join(" "),
      usage: (input) => simulators.usage(input.projectId, input.unusedDays, input.signal),
      rpc: {
        snapshot: async (context) => simulators.snapshot(project(context)),
        configure: async (context) => simulators.configure(project(context), params(Configure, context.params)),
        action: async (context) => {
          const id = project(context),
            input = params(Act, context.params);
          return simulators.act(id, input.operation, input.requestId, { udid: input.udid, sourceUdid: input.sourceUdid });
        },
        recover: async (context) => simulators.recover(project(context), params(Recover, context.params)),
      },
      // Erasing or deleting a device and settling an unknown outcome lose state, so agents need the owner's approval for them.
      rpcPolicy: {
        snapshot: "read",
        configure: "write",
        action: (value) =>
          typeof value === "object" &&
          value !== null &&
          "operation" in value &&
          (value.operation === "reset" || value.operation === "delete")
            ? "dangerous"
            : "write",
        recover: "dangerous",
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
