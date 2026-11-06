import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { DurableProjectRuntime } from "./durable-runtime.ts";
import { validateCall } from "./host-agent-tools.ts";
import { DEFAULT_SCRIPT_TIMEOUT_MS } from "./routine-script.ts";
import { fitJson } from "./response-limit.ts";
import type { Request as RequestData } from "./state.ts";

export const ROUTINE_TOOL = "projects_routines";
const RUNS_SHOWN = 10;

const Timing = {
  atMs: Type.Optional(Type.Integer({ minimum: 0, description: "First run, epoch ms." })),
  everyMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 31_536_000_000 })),
  calendar: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: 'Daily rule: { kind: "daily", timezone, time: "HH:MM" }.' }),
  ),
};

/** The Coordinator's routines (scripts/routine-script-failures.md S13-S16): prompt routines freely; script routines only through an owner approval pinned to this project. */
export function coordinatorRoutineTools(input: {
  projectId: string;
  runtime: () => DurableProjectRuntime | undefined;
  isCoordinator: (conversationId: number) => boolean;
  requestApproval(input: {
    key: string;
    conversationId: number;
    request: RequestData;
    summary: string;
  }): Promise<{ id: string; state: string }>;
}) {
  const answer = (value: unknown) => ({
    output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  });
  const owner = () => {
    const runtime = input.runtime();
    if (!runtime) throw new Error("The project is not open");
    return runtime;
  };
  const needs = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`This action needs ${name}`);
    return value;
  };
  const approval = async (api: ToolExecutionApi, action: string, fields: Record<string, unknown>, summary: string | undefined) => {
    const request = validateCall(action, { ...fields, id: input.projectId });
    const filed = await input.requestApproval({
      key: `${api.conversationId}:${api.taskId}`,
      conversationId: Number(api.conversationId),
      request,
      summary: needs(summary, "summary"),
    });
    return { ok: true, approval: filed, note: "The owner decides; the outcome arrives later as a follow-up message in this chat." };
  };
  const tool = defineTool({
    name: ROUTINE_TOOL,
    description: [
      "Manage this project's routines (schedules). Prompt routines send their text to Main when they fire; script routines run one shell command in the project folder; the cleanup routine trims workspaces and caches.",
      "Actions: list; runs (last 10 runs of scheduleId); output (kept output of one script run: scheduleId, requestId, offset); create (prompt routine: name, text, atMs, everyMs or calendar; starts off); update (scheduleId, revision, name, text, schedule, cleanup); enable (scheduleId, enabled); run (scheduleId, now); delete (scheduleId, revision; restorable for 10 minutes); restore (scheduleId).",
      "create_script and set_script (command, timeoutMs, chatId for failure notices) file an owner approval with your summary; the routine changes only after the owner approves. Timing, on/off and deleting a script routine need no approval.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("runs"),
        Type.Literal("output"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("enable"),
        Type.Literal("run"),
        Type.Literal("delete"),
        Type.Literal("restore"),
        Type.Literal("create_script"),
        Type.Literal("set_script"),
      ]),
      scheduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
      enabled: Type.Optional(Type.Boolean()),
      schedule: Type.Optional(Type.Object(Timing)),
      cleanup: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      command: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 7_200_000 })),
      chatId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "What the owner approves (script actions)." })),
      ...Timing,
    }),
    replay: "unsafe",
    async execute(args, api) {
      if (!input.isCoordinator(Number(api.conversationId))) throw new Error("Routine tools are for the coordinator");
      try {
        const id = () => needs(args.scheduleId, "scheduleId");
        switch (args.action) {
          case "list": {
            const routines = (await owner().scheduleSnapshot({ includeHistory: false })).schedules.map((item) => ({
              id: item.id,
              name: item.name,
              kind: item.action.kind,
              enabled: item.enabled,
              revision: item.revision,
              atMs: item.atMs,
              ...("everyMs" in item && item.everyMs ? { everyMs: item.everyMs } : {}),
              ...("calendar" in item && item.calendar ? { calendar: item.calendar } : {}),
              ...(item.action.kind === "prompt" ? { text: item.text.slice(0, 300) } : {}),
              ...(item.action.kind === "script" ? { command: item.action.command.slice(0, 300), timeoutMs: item.action.timeoutMs } : {}),
              ...(item.action.kind === "cleanup" ? { cleanup: item.action.settings } : {}),
            }));
            return answer(fitJson(routines.length, (n) => ({ ok: true, total: routines.length, routines: routines.slice(0, n) })));
          }
          case "runs": {
            const runs = (await owner().scheduleSnapshot({ includeHistory: true })).intents
              .filter((item) => item.stableId === id())
              .slice(-RUNS_SHOWN)
              .map((item) => ({
                requestId: item.requestId,
                at: item.recordedAtMs,
                status: item.status,
                outcome: item.outcome,
                ...(item.summary ? { summary: item.summary } : {}),
                ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
              }));
            return answer({ ok: true, runs });
          }
          case "output": {
            const kept = await owner().scheduleOutput(id(), needs(args.requestId, "requestId"));
            const offset = args.offset ?? 0,
              rest = kept.text.slice(offset);
            // Escaping grows the text, so the encoded answer is what is fitted.
            return answer(
              fitJson(rest.length, (n) => ({
                ok: true,
                exitCode: kept.exitCode,
                durationMs: kept.durationMs,
                truncatedAtStart: kept.truncated,
                nextOffset: n < rest.length ? offset + n : null,
                text: rest.slice(0, n),
              })),
            );
          }
          case "create":
            return answer({
              ok: true,
              routine: await owner().scheduleCreate({
                name: args.name,
                text: needs(args.text, "text"),
                atMs: needs(args.atMs, "atMs"),
                everyMs: args.everyMs,
                calendar: args.calendar as never,
              }),
            });
          case "update":
            return answer({
              ok: true,
              routine: await owner().scheduleUpdate(id(), needs(args.revision, "revision"), {
                name: args.name,
                text: args.text,
                schedule: args.schedule as never,
                cleanup: args.cleanup as never,
              }),
            });
          case "enable":
            return answer({ ok: true, routine: await owner().scheduleSetEnabled(id(), needs(args.enabled, "enabled")) });
          case "run":
            return answer({ ok: true, run: await owner().scheduleRun(id()) });
          case "delete":
            return answer({ ok: true, routine: await owner().scheduleDelete(id(), needs(args.revision, "revision")) });
          case "restore":
            return answer({ ok: true, routine: await owner().scheduleRestore(id()) });
          case "create_script":
            return answer(
              await approval(
                api,
                "routine-script-create",
                {
                  ...(args.name ? { name: args.name } : {}),
                  command: needs(args.command, "command"),
                  timeoutMs: args.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
                  ...(args.chatId ? { chatId: args.chatId } : {}),
                  atMs: needs(args.atMs, "atMs"),
                  ...(args.everyMs ? { everyMs: args.everyMs } : {}),
                  ...(args.calendar ? { calendar: args.calendar } : {}),
                },
                args.summary,
              ),
            );
          case "set_script":
            return answer(
              await approval(
                api,
                "routine-script-set",
                {
                  scheduleId: id(),
                  revision: needs(args.revision, "revision"),
                  ...(args.command ? { command: args.command } : {}),
                  ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
                  ...(args.chatId ? { chatId: args.chatId } : {}),
                },
                args.summary,
              ),
            );
        }
      } catch (error) {
        return answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  return [tool];
}
