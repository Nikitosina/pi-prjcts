import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { BackgroundCommands } from "./background-commands.ts";
import { queuedInputNote, watchQueuedInput } from "./queued-input.ts";
import type { ResourceLeases } from "./resource-leases.ts";
import { sourceWriteDiagnostic } from "./source-writes.ts";

const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });
const Resource = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
  description: "Neutral name agreed by workers, e.g. ios-simulator or a device name.",
});
const Id = Type.String({ pattern: "^bg-[a-f0-9]{8}$" });
/** The background wait; the stall detector judges an agent inside it by its command's output. */
export const BACKGROUND_WAIT_TOOL = "projects_bg_status";
const MAX_WAIT_SECONDS = 1800;
const BLOCKED = /^printf '%s\\n' '([\s\S]*)' >&2; exit 126$/;
/** The worker shell policies answer a blocked command with a replacement script ending in `exit 126`; unwrap its message. */
function policyDenial(guarded: string): string | undefined {
  const message = BLOCKED.exec(guarded)?.[1];
  return message === undefined ? undefined : message.replaceAll("'\\''", "'");
}

/** Who a call acts for: the thread that holds the leases and owns the background commands, the directory they run in and the shell policy that gates them. */
type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];
export type EnvironmentTarget = { threadId: string; cwd: string; env: NodeJS.ProcessEnv; guard: (command: string) => string };

/** Lease and background-command tools. `target` resolves per call; for a worker it is fixed and `guard` is the shell policy the worker's bash uses. */
export function workerEnvironmentTools(input: {
  projectId: string;
  leases: ResourceLeases;
  background: BackgroundCommands;
  owner?: (api: ToolExecutionApi, context: ToolContext) => string | Promise<string>;
  target: (api: ToolExecutionApi, context: ToolContext) => EnvironmentTarget | Promise<EnvironmentTarget>;
}): ToolRegistration[] {
  const owner = async (api: ToolExecutionApi, context: ToolContext) =>
    input.owner ? input.owner(api, context) : (await input.target(api, context)).threadId;
  const acquire = defineTool({
    name: "projects_lease_acquire",
    description:
      "Take an advisory lease on a machine-global named resource (a simulator, a device, a port) before using it, so another worker does not interfere. Host-wide, across projects. Returns acquired:true with an expiry, or acquired:false naming the holding thread and when its lease ends; then do other work or retry. wait queues you FIFO for up to waitSeconds (max 300) before giving up. Calling again as the holder renews. The lease frees itself when your work settles, is stopped or crashes, and at expiry; release it earlier with projects_lease_release. Advisory only: nothing blocks use of the resource.",
    parameters: Type.Object(
      {
        resource: Resource,
        ttlMinutes: Type.Number({ minimum: 0.02, maximum: 240 }),
        waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    async execute(args, api, context) {
      const holder = { projectId: input.projectId, threadId: (await input.target(api, context)).threadId };
      return json(
        await input.leases.acquire(
          args.resource,
          holder,
          Math.round(args.ttlMinutes * 60_000),
          (args.waitSeconds ?? 0) * 1000,
          context.abortSignal,
        ),
      );
    },
  });
  const release = defineTool({
    name: "projects_lease_release",
    description:
      "Release a lease you hold, as soon as you no longer use the resource, so queued workers continue. Releasing a lease you do not hold changes nothing.",
    parameters: Type.Object({ resource: Resource }, { additionalProperties: false }),
    replay: "unsafe",
    async execute(args, api, context) {
      const holder = { projectId: input.projectId, threadId: await owner(api, context) };
      return json({ resource: args.resource, released: input.leases.release(args.resource, holder) });
    },
  });
  const start = defineTool({
    name: "projects_bg_start",
    description:
      "Start a long-running shell command (build, test run, dev server, big download) in the background in your worktree and return an id at once; bash calls can time out, this cannot. Same shell policy as bash; a denied command is rejected and nothing runs. Output goes to a log under your artifacts folder. Poll with projects_bg_status, end it with projects_bg_stop. At most 3 run per thread. It keeps running across your turns and is killed when the thread is stopped or archived or the host shuts down. Keep the command in the foreground (no trailing & or daemonizing): the whole process group is killed when it exits.",
    parameters: Type.Object(
      { command: Type.String({ minLength: 1, maxLength: 8000 }), label: Type.String({ minLength: 1, maxLength: 80 }) },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    async execute(args, api, context) {
      const t = await input.target(api, context);
      const denial = policyDenial(t.guard(args.command));
      if (denial !== undefined) throw new Error(denial);
      const warning = sourceWriteDiagnostic(args.command);
      if (warning) api.diagnostic(warning);
      const { command: _command, ...info } = input.background.start(t.threadId, {
        command: args.command,
        label: args.label,
        cwd: t.cwd,
        env: t.env,
      });
      return json(info);
    },
  });
  const status = defineTool({
    name: BACKGROUND_WAIT_TOOL,
    description: `State of one of your background commands: running, exited with its exit code, killed or lost, plus the last tailLines (default 40, max 200) of its output (capped) and the log artifact ref for the full output. To wait for a build or test run, make one call with a large waitSeconds (1-${MAX_WAIT_SECONDS}) instead of polling: it returns as soon as the command ends, when a message for you is queued (state running with a note), or after waitSeconds with state running. Do not poll with sleep and tail. after (a previous logBytes) returns only output newer than that offset.`,
    parameters: Type.Object(
      {
        id: Id,
        tailLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
        waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_SECONDS })),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    async execute(args, api, context) {
      const thread = await owner(api, context);
      const queued = args.waitSeconds ? watchQueuedInput(api, api.conversationId, context) : undefined;
      try {
        const signals = [context.abortSignal, queued?.signal].filter((signal) => signal !== undefined);
        const status = await input.background.wait(thread, args.id, {
          tailLines: args.tailLines ?? 40,
          after: args.after,
          waitSeconds: args.waitSeconds ?? 0,
          signal: signals.length ? AbortSignal.any(signals) : undefined,
        });
        const arrived = queued?.arrived();
        return json(arrived && status.state === "running" ? { ...status, note: queuedInputNote(arrived) } : status);
      } finally {
        queued?.stop();
      }
    },
  });
  const stop = defineTool({
    name: "projects_bg_stop",
    description: "Stop one of your background commands (the whole process group; SIGTERM, then SIGKILL). Harmless if it already exited.",
    parameters: Type.Object({ id: Id }, { additionalProperties: false }),
    replay: "unsafe",
    async execute(args, api, context) {
      const { command: _command, ...info } = await input.background.stop(await owner(api, context), args.id);
      return json(info);
    },
  });
  return [acquire, release, start, status, stop];
}
