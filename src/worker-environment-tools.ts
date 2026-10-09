import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { BackgroundCommands } from "./background-commands.ts";
import type { ResourceLeases } from "./resource-leases.ts";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });
const Resource = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$", description: "Neutral name agreed by workers, e.g. ios-simulator or a device name." });
const Id = Type.String({ pattern: "^bg-[a-f0-9]{8}$" });
const BLOCKED = /^printf '%s\\n' '([\s\S]*)' >&2; exit 126$/;
/** The worker shell policies answer a blocked command with a replacement script ending in `exit 126`; unwrap its message. */
function policyDenial(guarded: string): string | undefined {
  const message = BLOCKED.exec(guarded)?.[1];
  return message === undefined ? undefined : message.replaceAll("'\\''", "'");
}

/** Lease and background-command tools for one worker thread in a worktree. `guard` is the same shell policy the worker's bash uses. */
export function workerEnvironmentTools(input: { projectId: string; threadId: string; cwd: string; env: NodeJS.ProcessEnv; leases: ResourceLeases; background: BackgroundCommands; guard: (command: string) => string }): ToolRegistration[] {
  const holder = { projectId: input.projectId, threadId: input.threadId };
  const acquire = defineTool({ name: "projects_lease_acquire", description: "Take an advisory lease on a machine-global named resource (a simulator, a device, a port) before using it, so another worker does not interfere. Host-wide, across projects. Returns acquired:true with an expiry, or acquired:false naming the holding thread and when its lease ends; then do other work or retry. wait queues you FIFO for up to waitSeconds (max 300) before giving up. Calling again as the holder renews. The lease frees itself when your work settles, is stopped or crashes, and at expiry; release it earlier with projects_lease_release. Advisory only: nothing blocks use of the resource.", parameters: Type.Object({ resource: Resource, ttlMinutes: Type.Number({ minimum: 0.02, maximum: 240 }), waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }, { additionalProperties: false }), replay: "unsafe", async execute(args, _api, context) {
    return json(await input.leases.acquire(args.resource, holder, Math.round(args.ttlMinutes * 60_000), (args.waitSeconds ?? 0) * 1000, context.abortSignal));
  } });
  const release = defineTool({ name: "projects_lease_release", description: "Release a lease you hold, as soon as you no longer use the resource, so queued workers continue. Releasing a lease you do not hold changes nothing.", parameters: Type.Object({ resource: Resource }, { additionalProperties: false }), replay: "unsafe", async execute(args) {
    return json({ resource: args.resource, released: input.leases.release(args.resource, holder) });
  } });
  const start = defineTool({ name: "projects_bg_start", description: "Start a long-running shell command (build, test run, dev server, big download) in the background in your worktree and return an id at once; bash calls can time out, this cannot. Same shell policy as bash; a denied command is rejected and nothing runs. Output goes to a log under your artifacts folder. Poll with projects_bg_status, end it with projects_bg_stop. At most 3 run per thread. It keeps running across your turns and is killed when the thread is stopped or archived or the host shuts down. Keep the command in the foreground (no trailing & or daemonizing): the whole process group is killed when it exits.", parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 8000 }), label: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }), replay: "unsafe", async execute(args) {
    const denial = policyDenial(input.guard(args.command));
    if (denial !== undefined) throw new Error(denial);
    const { command: _command, ...info } = input.background.start(input.threadId, { command: args.command, label: args.label, cwd: input.cwd, env: input.env });
    return json(info);
  } });
  const status = defineTool({ name: "projects_bg_status", description: "State of one of your background commands: running, exited with its exit code, killed or lost, plus the last tailLines (default 40, max 200) of its output (capped) and the log artifact ref for the full output.", parameters: Type.Object({ id: Id, tailLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })) }, { additionalProperties: false }), replay: "safe", async execute(args) {
    return json(input.background.status(input.threadId, args.id, args.tailLines ?? 40));
  } });
  const stop = defineTool({ name: "projects_bg_stop", description: "Stop one of your background commands (the whole process group; SIGTERM, then SIGKILL). Harmless if it already exited.", parameters: Type.Object({ id: Id }, { additionalProperties: false }), replay: "unsafe", async execute(args) {
    const { command: _command, ...info } = await input.background.stop(input.threadId, args.id);
    return json(info);
  } });
  return [acquire, release, start, status, stop];
}
