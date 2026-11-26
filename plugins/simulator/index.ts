import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import type { HostPluginApi, PluginRpcContext } from "../../src/plugin-types.ts";
import { createSimulators, leaseName } from "./simulator.ts";
import { requestIds, simulatorView, slimmingView } from "./section.ts";
import { pruneEnabledProjects } from "./test-products.ts";
import { COORDINATOR_NOTE, WORKER_NOTE, createSimulatorTools } from "./tools.ts";

const TEST_PRODUCTS_ROOT = join(homedir(), "Library", "Developer", "XcodeBuildMCP", "workspaces");
const TEST_PRODUCTS_KEEP_MS = 2 * 3600_000;
const summary = ({ removed, bytes }: { removed: number; bytes: number }) =>
  removed ? `XcodeBuildMCP: removed ${removed} old test products (${(bytes / 1024 ** 3).toFixed(1)} GB).` : "";

/**
 * Optional iOS simulators per project: owner-enabled clones of a shut-down simulator, managed by the coordinator,
 * leased to whole-repository workers and listed in a Settings → Plugins section (section.ts). Needs simslim and XcodeBuildMCP on a Mac.
 * Ownership and request receipts persist in each project's `simulator.json`. Failure cases: FAILURES.md.
 */
export default {
  name: "simulator",
  register(api: HostPluginApi) {
    const simulators = createSimulators(api);
    // Each simulator test run leaves 2-4 GB of test products; a daily cleanup is too rare for a busy afternoon (FAILURES.md T1-T4).
    // XcodeBuildMCP keys a workspace by its checkout. A project's roots are the ones the host owns for it (its folder and its worker workspaces);
    // a checkout two projects claim, and any workspace nobody claims, stay (some historical products remain on purpose).
    const sweep = (only?: string) =>
      pruneEnabledProjects({
        root: TEST_PRODUCTS_ROOT,
        now: Date.now(),
        keepMs: TEST_PRODUCTS_KEEP_MS,
        projects: api.projects.list().map((project) => ({
          id: project.id,
          disabledPlugins: project.disabledPlugins,
          roots: api.projects.workspaceRoots(project.id),
        })),
        admit: api.projects.work,
        only,
      });
    const pruneEnabled = () => sweep();
    const pruning = setInterval(() => void pruneEnabled().catch(() => {}), 3600_000);
    pruning.unref();
    const tools = createSimulatorTools(api, simulators);
    const { Type } = api.lib.typebox,
      { Value } = api.lib.value;
    const Id = Type.String({ pattern: "^[a-f0-9-]{36}$" }),
      Udid = Type.Optional(Type.String({ pattern: "^[a-fA-F0-9-]{36}$" }));
    const Configure = Type.Union([
      Type.Object({ enabled: Type.Boolean(), requestId: Id }, { additionalProperties: false }),
      Type.Object({ keepCategories: simulators.KeepCategories, requestId: Id }, { additionalProperties: false }),
    ]);
    const Act = Type.Object(
      { operation: simulators.SimulatorAction, requestId: Id, udid: Udid, sourceUdid: Udid },
      { additionalProperties: false, if: { properties: { operation: { const: "create" } } }, then: { required: ["sourceUdid"] } },
    );
    const Recover = Type.Object({ confirm: Id, requestId: Id }, { additionalProperties: false });
    // Section buttons carry request ids that change after each configure or recover and with each host start (FAILURES.md C5).
    const start = randomUUID(),
      changes = new Map<string, number>();
    const ids = (id: string) => requestIds(`${start}:${id}:${changes.get(id) ?? 0}`);
    const changed = <T>(id: string, result: T) => {
      changes.set(id, (changes.get(id) ?? 0) + 1);
      return result;
    };
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
        unresolved: simulators.unresolved,
        close: async () => {
          clearInterval(pruning);
          await simulators.close();
        },
      },
      cleanup: async (input) =>
        [await simulators.eraseIdle(input.projectId, input.unusedDays, input.signal), summary(await sweep(input.projectId))]
          .filter(Boolean)
          .join(" "),
      usage: (input) => simulators.usage(input.projectId, input.unusedDays, input.signal),
      rpc: {
        snapshot: async (context) => simulators.snapshot(project(context)),
        configure: async (context) =>
          changed(project(context), await simulators.configure(project(context), params(Configure, context.params))),
        action: async (context) => {
          const id = project(context);
          const input = context.params;
          if (!Value.Check(Act, input))
            throw Error("Invalid simulator action. For create, pass a valid sourceUdid from projects_simulator_status.");
          return simulators.act(id, input.operation, input.requestId, { udid: input.udid, sourceUdid: input.sourceUdid });
        },
        recover: async (context) => changed(project(context), await simulators.recover(project(context), params(Recover, context.params))),
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
      sections: {
        simulators: {
          title: "iOS simulators",
          place: "settings",
          refreshMs: 3000,
          read: async ({ projectId }) =>
            projectId
              ? simulatorView(projectId, await simulators.snapshot(projectId), ids(projectId))
              : { rows: [], empty: "Select a project to manage its simulators." },
        },
        slimming: {
          title: "Simulator slimming",
          place: "settings",
          refreshMs: 3000,
          read: async ({ projectId }) =>
            projectId
              ? slimmingView(await simulators.snapshot(projectId), ids(projectId))
              : { rows: [], empty: "Select a project to choose its slimming." },
        },
      },
    });
  },
};
