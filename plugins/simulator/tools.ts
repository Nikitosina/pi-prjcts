import type { Conversation, HostPluginApi, ToolExecutionApi } from "../../src/plugin-types.ts";
import { MAX_OWNED, simulatorResource, type Simulators } from "./simulator.ts";

export const COORDINATOR_NOTE = `\n\nYou fully manage this project's iOS simulators; never ask the owner to create, pin, boot or delete one. The project may own up to ${MAX_OWNED} clones at once (for example an iPhone and an iPad). projects_simulator_status lists the owned clones (UDID, state, lease resource, current lease holder, slimming) and the sources you can clone from. projects_simulator_action creates a clone of any shut-down source (sourceUdid: pick the device the task needs, e.g. an iPad for tablet work; default is the owner's pin or the newest shut-down iPhone) and boots, shuts down, resets or deletes one owned clone (udid; required when several are owned). Reset erases the clone's apps and data; delete removes it permanently. Delete clones nobody needs any more. Only the clone a worker has leased is blocked; running workers do not block maintenance of other clones, so tell a worker to release a lease or wait for it instead of stopping the worker. Never touch source simulators, shared runtimes or global caches. Use a fresh stable requestId for each distinct action and reuse it only for the exact same retry. Actions return accepted progress; do not repeatedly poll while other work can proceed. projects_simulator_screenshot returns an actual screenshot of one clone. Give coding workers the exact UDID and its simulator:UDID lease resource. New whole-repository worker threads get projects_worker_simulator_status and projects_worker_simulator_screenshot; existing threads keep their frozen tool set. Workers must acquire the lease before using a clone and release it when finished. simslim disables some simulator services; inspect its status before testing push, StoreKit, iCloud or other affected features. If the owner turned management off, you cannot turn it on: tell them. Unknown outcomes block further management and need owner inspection; never guess or substitute a different simulator.`;
/** Worker counterpart, appended to the instructions of workers that have the simulator tools. */
export const WORKER_NOTE = "\n\nFor the project's managed iOS simulators, call projects_worker_simulator_status to get the clone your task names (exact UDID and canonical simulator:UDID lease resource). Acquire that exact resource before build/install/launch or projects_worker_simulator_screenshot. Only use project clones, never a source simulator; ask the coordinator to create, boot, reset or delete one (for example when you need an iPad and only an iPhone clone exists). Slimming disables some app services, so check status before feature-specific tests.";

export function createSimulatorTools(host: HostPluginApi, simulators: Simulators) {
  const { defineExtension, defineTool } = host.lib.durable, { Type } = host.lib.typebox;
  const empty = Type.Object({}, { additionalProperties: false });
  const Udid = (description: string) => Type.Optional(Type.String({ pattern: "^[a-fA-F0-9-]{36}$", description }));
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

  function coordinatorSimulatorTools(input: { projectId: string; isCoordinator: (id: Conversation["id"]) => boolean }) {
    const authorize = (api: ToolExecutionApi) => { if (!input.isCoordinator(api.conversationId)) throw Error("Simulator lifecycle tools are coordinator-only"); };
    const status = defineTool({ name: "projects_simulator_status", description: "Read this project's owned simulator clones (UDID, state, lease resource and holder, slimming), operation progress and the source simulators available for cloning. Read-only.", parameters: empty, replay: "safe", async execute(_args, api) {
      authorize(api); return json(await simulators.snapshot(input.projectId));
    } });
    const action = defineTool({ name: "projects_simulator_action", description: `Manage this project's pi-prjcts-created simulators (up to ${MAX_OWNED}). create clones sourceUdid (any shut-down source from status; default the owner's pin or the newest shut-down iPhone), then slims and boots the clone; boot slims/boots; shutdown frees RAM without deleting data; reset erases the clone's apps/data and reboots slim; delete permanently deletes the clone. boot/shutdown/reset/delete take udid of an owned clone (required when several are owned) and are refused only while a worker leases that clone. Returns accepted progress; uncertain outcomes do not retry automatically.`, parameters: Type.Object({
      operation: simulators.SimulatorAction,
      requestId: Type.String({ pattern: "^[a-f0-9-]{36}$", description: "Stable UUID for this exact operation; never reuse it for a different intent" }),
      udid: Udid("Owned clone for boot/shutdown/reset/delete"),
      sourceUdid: Udid("Source simulator to clone for create"),
    }, { additionalProperties: false }), replay: "unsafe", async execute(args, api) {
      authorize(api); return json(await simulators.act(input.projectId, args.operation, args.requestId, { udid: args.udid, sourceUdid: args.sourceUdid }));
    } });
    const screenshot = defineTool({ name: "projects_simulator_screenshot", description: "Capture and inspect the actual current screen of one booted, owned simulator (udid; default the first owned clone). Read-only, no taps or text input. Screenshots may be cached for four seconds.", parameters: Type.Object({ udid: Udid("Owned clone to capture") }, { additionalProperties: false }), replay: "safe", async execute(args, api) {
      authorize(api); return image(input.projectId, args.udid);
    } });
    const rotate = defineTool({ name: "projects_simulator_rotate", description: "Rotate one booted, owned simulator (udid; default the first owned clone) to an orientation, like Simulator's rotate menu. Refused while a worker leases that clone. The iPhone home screen stays portrait; apps that support landscape rotate. Check the result with projects_simulator_screenshot.", parameters: Type.Object({ orientation: simulators.Orientation, udid: Udid("Owned clone to rotate") }, { additionalProperties: false }), replay: "safe", async execute(args, api) {
      authorize(api);
      return json(await simulators.rotate(input.projectId, args.udid, args.orientation, udid => { if (host.leases.held(holder => !holder.threadId.startsWith("plugin:")).some(lease => lease.resource === simulatorResource(udid))) throw Error("A worker leases this simulator; ask it to rotate, or wait for the lease"); }));
    } });
    const tools = [status, action, screenshot, rotate];
    return { tools, extension: defineExtension({ name: "projects.coordinator-simulator", tools }) };
  }

  function workerSimulatorTools(input: { projectId: string; threadId: string; conversationId: number }) {
    const authorize = (api: ToolExecutionApi) => { if (Number(api.conversationId) !== input.conversationId) throw Error("Simulator tools belong to another worker conversation"); };
    const status = defineTool({ name: "projects_worker_simulator_status", description: "List this project's simulator clones with their UDID, state, slimming and exact canonical lease resource. Use the clone your task names; acquire its resource with projects_lease_acquire before build/install/launch. Never use a source device. Does not grant lifecycle authority.", parameters: empty, replay: "safe", async execute(_args, api) {
      authorize(api); return json(await simulators.snapshot(input.projectId));
    } });
    const screenshot = defineTool({ name: "projects_worker_simulator_screenshot", description: "Inspect an actual screenshot of a project-owned simulator while holding its canonical lease (udid; default the clone you lease). No simulator input or lifecycle authority.", parameters: Type.Object({ udid: Udid("Leased clone to capture") }, { additionalProperties: false }), replay: "safe", async execute(args, api) {
      authorize(api);
      const leased = new Set(host.leases.held(holder => holder.projectId === input.projectId && holder.threadId === input.threadId).map(lease => lease.resource));
      const clones = (await simulators.snapshot(input.projectId)).devices.filter(device => leased.has(simulatorResource(device.udid)));
      const target = args.udid ? clones.find(device => device.udid === args.udid!.toUpperCase()) : clones[0];
      if (!target) throw Error("Acquire the simulator's canonical lease before inspecting it");
      return image(input.projectId, target.udid);
    } });
    const rotate = defineTool({ name: "projects_worker_simulator_rotate", description: "Rotate a project simulator whose canonical lease you hold (udid; default the clone you lease) to an orientation. The iPhone home screen stays portrait; apps that support landscape rotate.", parameters: Type.Object({ orientation: simulators.Orientation, udid: Udid("Leased clone to rotate") }, { additionalProperties: false }), replay: "safe", async execute(args, api) {
      authorize(api);
      const leased = new Set(host.leases.held(holder => holder.projectId === input.projectId && holder.threadId === input.threadId).map(lease => lease.resource));
      const udid = args.udid?.toUpperCase() ?? (await simulators.snapshot(input.projectId)).devices.find(device => leased.has(simulatorResource(device.udid)))?.udid;
      if (!udid || !leased.has(simulatorResource(udid))) throw Error("Acquire the simulator's canonical lease before rotating it");
      return json(await simulators.rotate(input.projectId, udid, args.orientation, () => {}));
    } });
    return [status, screenshot, rotate];
  }
  async function image(id: string, udid?: string) {
    const frame = await simulators.frame(id, udid);
    return { content: [{ type: "text" as const, text: JSON.stringify({ capturedAt: frame.capturedAt, mime: frame.mime }) }, { type: "image" as const, data: frame.bytes.toString("base64"), mimeType: frame.mime }] };
  }
  return { coordinator: coordinatorSimulatorTools, worker: workerSimulatorTools };
}
