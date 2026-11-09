import { createHash } from "node:crypto";
import type { Conversation, HostPluginApi, ToolExecutionApi } from "../../src/plugin-types.ts";
import { binaryResult } from "../../src/binary-results.ts";
import { MAX_OWNED, simulatorResource, WORKER_OPERATIONS, type Simulators } from "./simulator.ts";

/** The coordinator's simulator rules: the editable "iOS simulators" integration block, shown while management is on. Tool details live in the descriptions. */
export const COORDINATOR_NOTE = `- iOS simulators: you manage up to ${MAX_OWNED} clones yourself (projects_simulator_status, projects_simulator_action). Never ask the owner to create, boot or delete one. Give a coding worker the exact UDID and its simulator:<UDID> lease resource. Delete clones nobody needs. An unknown outcome blocks management: tell the owner, never guess or substitute another simulator.`;
/** Worker counterpart, appended to the instructions of workers that have the simulator tools. */
export const WORKER_NOTE =
  "\n\nManaged iOS simulators: get the clone your task names with projects_worker_simulator_status, acquire its simulator:<UDID> lease before build, install, launch or screenshot, and release it when done. While you hold the lease, boot, shut down or reboot that clone with projects_worker_simulator_boot. Use only project clones; ask the Coordinator to create, reset or delete one.";

export function createSimulatorTools(host: HostPluginApi, simulators: Simulators) {
  const { defineExtension, defineTool } = host.lib.durable,
    { Type } = host.lib.typebox;
  const empty = Type.Object({}, { additionalProperties: false });
  const Udid = (description: string) => Type.Optional(Type.String({ pattern: "^[a-fA-F0-9-]{36}$", description }));
  const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });

  function coordinatorSimulatorTools(input: { projectId: string; isCoordinator: (id: Conversation["id"]) => boolean }) {
    const authorize = (api: ToolExecutionApi) => {
      if (!input.isCoordinator(api.conversationId)) throw Error("Simulator lifecycle tools are coordinator-only");
    };
    const status = defineTool({
      name: "projects_simulator_status",
      description:
        "Read this project's owned simulator clones (UDID, state, lease resource and holder, slimming), operation progress and the source simulators available for cloning. Read-only. Slimming (simslim) disables some services: check it before testing push, StoreKit, iCloud or other affected features. Management turned off by the owner cannot be turned on here.",
      parameters: empty,
      replay: "safe",
      async execute(_args, api) {
        authorize(api);
        return json(await simulators.snapshot(input.projectId));
      },
    });
    const action = defineTool({
      name: "projects_simulator_action",
      description: `Manage this project's pi-prjcts-created simulators (up to ${MAX_OWNED}). create clones sourceUdid (any shut-down source from status; default the owner's pin or the newest shut-down iPhone), then slims and boots the clone; boot slims/boots; shutdown frees RAM without deleting data; reset erases the clone's apps/data and reboots slim; delete permanently deletes the clone. boot/shutdown/reset/delete take udid of an owned clone (required when several are owned) and are refused only while a worker leases that clone. Returns accepted progress; don't poll repeatedly while other work can proceed. Uncertain outcomes do not retry automatically and block management until the owner inspects them. Only a leased clone is blocked: ask its worker to release the lease rather than stopping the worker. Never touch source simulators, shared runtimes or global caches.`,
      parameters: Type.Object(
        {
          operation: simulators.SimulatorAction,
          requestId: Type.String({
            pattern: "^[a-f0-9-]{36}$",
            description: "Stable UUID for this exact operation; never reuse it for a different intent",
          }),
          udid: Udid("Owned clone for boot/shutdown/reset/delete"),
          sourceUdid: Udid("Source simulator to clone for create"),
        },
        { additionalProperties: false },
      ),
      replay: "unsafe",
      async execute(args, api) {
        authorize(api);
        return json(
          await simulators.act(input.projectId, args.operation, args.requestId, { udid: args.udid, sourceUdid: args.sourceUdid }),
        );
      },
    });
    const screenshot = defineTool({
      name: "projects_simulator_screenshot",
      description:
        "Capture and inspect the actual current screen of one booted, owned simulator (udid; default the first owned clone). Read-only, no taps or text input. Screenshots may be cached for four seconds.",
      parameters: Type.Object({ udid: Udid("Owned clone to capture") }, { additionalProperties: false }),
      replay: "safe",
      async execute(args, api) {
        authorize(api);
        return image(input.projectId, input.projectId, args.udid);
      },
    });
    const rotate = defineTool({
      name: "projects_simulator_rotate",
      description:
        "Rotate one booted, owned simulator (udid; default the first owned clone) to an orientation, like Simulator's rotate menu. Refused while a worker leases that clone. The iPhone home screen stays portrait; apps that support landscape rotate. Check the result with projects_simulator_screenshot.",
      parameters: Type.Object(
        { orientation: simulators.Orientation, udid: Udid("Owned clone to rotate") },
        { additionalProperties: false },
      ),
      replay: "safe",
      async execute(args, api) {
        authorize(api);
        return json(
          await simulators.rotate(input.projectId, args.udid, args.orientation, (udid) => {
            if (
              host.leases
                .held((holder) => !holder.threadId.startsWith("plugin:"))
                .some((lease) => lease.resource === simulatorResource(udid))
            )
              throw Error("A worker leases this simulator; ask it to rotate, or wait for the lease");
          }),
        );
      },
    });
    const tools = [status, action, screenshot, rotate];
    return { tools, extension: defineExtension({ name: "projects.coordinator-simulator", tools }) };
  }

  function workerSimulatorTools(input: { projectId: string; threadId: string; conversationId: number }) {
    const authorize = (api: ToolExecutionApi) => {
      if (Number(api.conversationId) !== input.conversationId) throw Error("Simulator tools belong to another worker conversation");
    };
    const status = defineTool({
      name: "projects_worker_simulator_status",
      description:
        "List this project's simulator clones with their UDID, state, slimming and exact canonical lease resource. Use the clone your task names; acquire its resource with projects_lease_acquire before build/install/launch. Never use a source device. Does not grant lifecycle authority.",
      parameters: empty,
      replay: "safe",
      async execute(_args, api) {
        authorize(api);
        return json(await simulators.snapshot(input.projectId));
      },
    });
    const screenshot = defineTool({
      name: "projects_worker_simulator_screenshot",
      description:
        "Inspect an actual screenshot of a project-owned simulator while holding its canonical lease (udid; default the clone you lease). No simulator input or lifecycle authority.",
      parameters: Type.Object({ udid: Udid("Leased clone to capture") }, { additionalProperties: false }),
      replay: "safe",
      async execute(args, api) {
        authorize(api);
        const leased = new Set(
          host.leases
            .held((holder) => holder.projectId === input.projectId && holder.threadId === input.threadId)
            .map((lease) => lease.resource),
        );
        const clones = (await simulators.snapshot(input.projectId)).devices.filter((device) => leased.has(simulatorResource(device.udid)));
        const target = args.udid ? clones.find((device) => device.udid === args.udid!.toUpperCase()) : clones[0];
        if (!target) throw Error("Acquire the simulator's canonical lease before inspecting it");
        return image(input.projectId, input.threadId, target.udid);
      },
    });
    const rotate = defineTool({
      name: "projects_worker_simulator_rotate",
      description:
        "Rotate a project simulator whose canonical lease you hold (udid; default the clone you lease) to an orientation. The iPhone home screen stays portrait; apps that support landscape rotate.",
      parameters: Type.Object(
        { orientation: simulators.Orientation, udid: Udid("Leased clone to rotate") },
        { additionalProperties: false },
      ),
      replay: "safe",
      async execute(args, api) {
        authorize(api);
        const leased = new Set(
          host.leases
            .held((holder) => holder.projectId === input.projectId && holder.threadId === input.threadId)
            .map((lease) => lease.resource),
        );
        const udid =
          args.udid?.toUpperCase() ??
          (await simulators.snapshot(input.projectId)).devices.find((device) => leased.has(simulatorResource(device.udid)))?.udid;
        if (!udid || !leased.has(simulatorResource(udid))) throw Error("Acquire the simulator's canonical lease before rotating it");
        return json(await simulators.rotate(input.projectId, udid, args.orientation, () => {}));
      },
    });
    const WorkerOperation = Type.Union([...WORKER_OPERATIONS, "reboot" as const].map((operation) => Type.Literal(operation)));
    const boot = defineTool({
      name: "projects_worker_simulator_boot",
      description:
        "Boot (slim), shut down, or reboot (shut down, then boot) the project clone whose canonical simulator:<UDID> lease you hold (udid; default the clone you lease). Your lease authorizes it; no other lease is needed. Waits for the outcome. Create, reset and delete stay with the Coordinator. An unknown outcome blocks simulator management until the owner inspects it: report it, never retry with another clone.",
      parameters: Type.Object({ operation: WorkerOperation, udid: Udid("Leased clone") }, { additionalProperties: false }),
      replay: "unsafe",
      async execute(args, api, context) {
        authorize(api);
        const leased = new Set(
          host.leases
            .held((holder) => holder.projectId === input.projectId && holder.threadId === input.threadId)
            .map((lease) => lease.resource),
        );
        const udid =
          args.udid?.toUpperCase() ??
          (await simulators.snapshot(input.projectId)).devices.find((device) => leased.has(simulatorResource(device.udid)))?.udid;
        if (!udid) throw Error("Acquire the simulator's canonical lease with projects_lease_acquire before booting or shutting it down");
        const steps = args.operation === "reboot" ? (["shutdown", "boot"] as const) : [args.operation];
        for (const operation of steps) {
          // Request ids derive from the tool call, so a replayed call finds its receipt instead of acting twice.
          const requestId = callUuid(`${input.threadId}:${api.callId}:${operation}`);
          await simulators.act(input.projectId, operation, requestId, { udid }, { kind: "leaseHolder", threadId: input.threadId });
          const outcome = await simulators.outcome(input.projectId, requestId, context?.abortSignal);
          if (outcome === "running") throw Error(`Stopped waiting; the ${operation} continues: check projects_worker_simulator_status`);
          if (outcome !== "done") throw Error(`Simulator ${operation} outcome is ${outcome}; tell the Coordinator, do not retry`);
        }
        const device = (await simulators.snapshot(input.projectId)).devices.find((item) => item.udid === udid);
        return json({ operation: args.operation, udid, state: device?.state ?? "Unknown", slim: device?.slim ?? null });
      },
    });
    return [status, screenshot, rotate, boot];
  }
  function callUuid(seed: string): string {
    const hex = createHash("sha256").update(seed).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  /** Frames are stored as artifacts of `scope` (a worker's thread, or the project for the coordinator); the transcript keeps the reference and a small copy. */
  async function image(projectId: string, scope: string, udid?: string) {
    const frame = await simulators.frame(projectId, udid);
    const stored = await binaryResult(
      { controlRoot: host.projects.dir(projectId), scope },
      { bytes: frame.bytes, label: `Simulator screenshot ${new Date(frame.capturedAt).toISOString()}` },
    );
    return { output: stored };
  }
  return { coordinator: coordinatorSimulatorTools, worker: workerSimulatorTools };
}
