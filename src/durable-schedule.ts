import { createHash } from "node:crypto";
import { defineDoc, type Conversation, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Jobs } from "./jobs.ts";
import { hasUncertainGithubWrites } from "./github-worker.ts";
import { plugins } from "./plugins.ts";
import { hasUncertainCommands } from "./command-runtime.ts";
import { nextCalendarOccurrence, latestCalendarOccurrence, copyCalendarRule, type CalendarRule } from "./schedule-calendar.ts";
import { cleanupSettingsError, type CleanupSettings } from "./workspace-cleanup.ts";
import { scriptError } from "./routine-script.ts";
/** What a routine does when it fires: send its text to a chat, or a host action that runs without a model. */
export type RoutineAction =
  | { kind: "prompt" }
  | { kind: "cleanup"; settings: CleanupSettings }
  /** One shell command, stored exactly; a failed run tells `chatId` (default Main). */
  | { kind: "script"; command: string; timeoutMs: number; chatId?: string };
export type HostAction = Exclude<RoutineAction, { kind: "prompt" }>;
type Schedule = {
  id: string;
  projectId: string;
  enabled: boolean;
  atMs: number;
  text: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Absent on records saved before names and revisions existed. */
  name?: string;
  revision?: number;
  /** Absent on prompt routines and records saved before actions existed. */
  action?: HostAction;
} & (
  { kind: "once" } | { kind: "interval"; everyMs: number; nextAtMs: number } | { kind: "calendar"; rule: CalendarRule; nextAtMs: number }
);
/** A schedule as reads return it: name null when unnamed, revision 0 for records saved before revisions. */
export type ScheduleView = (Schedule extends infer T ? (T extends unknown ? Omit<T, "name" | "revision" | "action"> : never) : never) & {
  name: string | null;
  revision: number;
  action: RoutineAction;
};
export type ScheduleTiming = { atMs: number; everyMs?: number; calendar?: CalendarRule };
type Event = { eventId: string; projectId: string; kind: string; payload: string; createdAtMs: number; requestId: string };
export type ScheduleIntent = {
  requestId: string;
  kind: "schedule" | "event";
  stableId: string;
  text: string;
  /** Chat conversation the event went to; absent means the root (Main). */ conversationId?: number;
  status: "recorded" | "submitted" | "interrupted" | "uncertain" | "failed";
  submissionId: number | null;
  recordedAtMs: number;
  outcome: string | null;
  /** A host action run instead of a chat submission: it has no SDK receipt; its result is `summary`. */
  action?: HostAction["kind"];
  durationMs?: number;
  summary?: string;
};
export type DurableScheduleSnapshot = {
  automaticAdmissionBlocker: "uncertain-provider-write" | "uncertain-command" | null;
  eventOptIn: boolean;
  schedules: ScheduleView[];
} & (
  | { historyIncluded?: true; events: Event[]; intents: ScheduleIntent[] }
  | { historyIncluded: false; historyCounts: { events: number; intents: number }; events: []; intents: [] }
);
export type ScheduleHistoryOptions = { offset?: number; limit?: number; textOffset?: number; textLimit?: number };
type TextRange = { offset: number; end: number; total: number; nextOffset: number | null; sha256: string };
type HistoryPage = { offset: number; limit: number; total: number; nextOffset: number | null; observedAtMs: number };
export type ScheduleHistoryPage = HistoryPage &
  (
    | { kind: "events"; items: Array<Event & { payloadRange: TextRange }> }
    | {
        kind: "intents";
        items: Array<ScheduleIntent & { textRange: TextRange; outcomeRange: TextRange | null }>;
        routines: Array<{
          routineId: string;
          recentRuns: Array<{ at: number; outcome: "ok" | "failed" | "skipped" | "paused"; durationMs: number | null }>;
        }>;
      }
  );
type ScheduleState = {
  eventOptIn: boolean;
  schedules: Record<string, Schedule>;
  /** Deleted schedules kept for `schedule-restore` until the restore window passes; absent in documents written before. */
  deleted?: Record<string, { schedule: Schedule; deletedAtMs: number }>;
  events: Record<string, Event>;
  intents: Record<string, ScheduleIntent>;
};
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
const actionCopy = (action: HostAction): HostAction =>
  action.kind === "cleanup"
    ? { kind: action.kind, settings: { ...action.settings, disposable: [...action.settings.disposable] } }
    : { ...action };
function scheduleCopy(value: Schedule): ScheduleView {
  const copy = storedCopy(value);
  return { ...copy, name: value.name ?? null, revision: value.revision ?? 0, action: copy.action ?? { kind: "prompt" } };
}
function storedCopy(value: Schedule): Schedule {
  const copy = value.kind === "calendar" ? { ...value, rule: copyCalendarRule(value.rule) } : { ...value };
  return value.action ? { ...copy, action: actionCopy(value.action) } : copy;
}
const RESTORE_MS = Number(process.env.PI_PROJECTS_SCHEDULE_RESTORE_MS) || 10 * 60_000;
/** Checks a timing and returns the fields it sets; the first calendar occurrence is at or after `atMs`. */
function timingFields(
  timing: ScheduleTiming,
): { kind: "once" } | { kind: "interval"; everyMs: number; nextAtMs: number } | { kind: "calendar"; rule: CalendarRule; nextAtMs: number } {
  if (!Number.isSafeInteger(timing.atMs) || timing.atMs < 0) throw new Error("Invalid schedule");
  if (timing.everyMs !== undefined && (!Number.isSafeInteger(timing.everyMs) || timing.everyMs < 60000 || timing.everyMs > 31536000000))
    throw new Error("Schedule interval must be between one minute and one year");
  if (timing.calendar !== undefined && timing.everyMs !== undefined) throw new Error("Choose a calendar rule or an interval, not both");
  if (timing.calendar !== undefined) {
    const first = nextCalendarOccurrence(timing.calendar, timing.atMs - 1);
    if (first !== null) return { kind: "calendar", rule: copyCalendarRule(timing.calendar), nextAtMs: first };
  }
  return timing.everyMs === undefined ? { kind: "once" } : { kind: "interval", everyMs: timing.everyMs, nextAtMs: timing.atMs };
}
/** A run of this schedule that has not finished: recorded, uncertain, or submitted without an outcome yet. */
function inFlight(state: ScheduleState, id: string): boolean {
  return Object.values(state.intents).some(
    (intent) =>
      intent.kind === "schedule" &&
      intent.stableId === id &&
      (intent.status === "recorded" || intent.status === "uncertain" || (intent.status === "submitted" && intent.outcome === null)),
  );
}
const consumed = (state: ScheduleState, id: string) =>
  Object.values(state.intents).some((intent) => intent.kind === "schedule" && intent.stableId === id);
function eventCopy(value: Event): Event {
  return { ...value };
}
function intentCopy(value: ScheduleIntent): ScheduleIntent {
  return { ...value };
}
function snapshotCopy(
  state: ScheduleState,
  automaticAdmissionBlocker: DurableScheduleSnapshot["automaticAdmissionBlocker"],
  includeHistory: boolean,
): DurableScheduleSnapshot {
  const base = { automaticAdmissionBlocker, eventOptIn: state.eventOptIn, schedules: Object.values(state.schedules).map(scheduleCopy) };
  return includeHistory
    ? { ...base, events: Object.values(state.events).map(eventCopy), intents: Object.values(state.intents).map(intentCopy) }
    : {
        ...base,
        historyIncluded: false,
        historyCounts: { events: Object.keys(state.events).length, intents: Object.keys(state.intents).length },
        events: [],
        intents: [],
      };
}
function historyInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid schedule history page or text range");
  return result;
}
function historyText(value: string, offset: number, limit: number): { text: string; range: TextRange } {
  const characters = Array.from(value),
    start = Math.min(offset, characters.length),
    end = Math.min(start + limit, characters.length);
  return {
    text: characters.slice(start, end).join(""),
    range: {
      offset: start,
      end,
      total: characters.length,
      nextOffset: end < characters.length ? end : null,
      sha256: createHash("sha256").update(value).digest("hex"),
    },
  };
}
export const DurableSchedule = defineDoc<ScheduleState>({
  kind: "projects.durable-schedule",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ eventOptIn: false, schedules: {}, events: {}, intents: {} }),
});
export class AdmissionMutex {
  private tail = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
export function scheduleRuntime(
  root: Conversation,
  projectId: string,
  isClosed: () => boolean,
  hooks: {
    afterScheduleIntentRecorded?: (
      value: Readonly<{ requestId: string; stableId: string; kind: "schedule" | "event"; submissionId: null }>,
    ) => Promise<void>;
    beforeScheduleReceiptCommit?: (value: Readonly<{ requestId: string; submissionId: number }>) => Promise<void>;
    /** Runs a host action; resolves with a one-line summary, throws when it failed. */
    runAction?: (
      action: HostAction,
      run: { requestId: string; recordedAtMs: number; routineId: string; name: string },
    ) => Promise<{ ok: boolean; summary: string }>;
  } = {},
) {
  const mutex = new AdmissionMutex();
  // Host actions running in this process; one recorded in flight but missing here died with an earlier host.
  const running = new Set<string>();
  const actionRuns = new Set<Promise<void>>();
  const automaticBlocker = async (tx: Tx): Promise<DurableScheduleSnapshot["automaticAdmissionBlocker"]> =>
    (await hasUncertainGithubWrites(tx, root.id)) || (await plugins.anyUncertainWrites(tx, root.id))
      ? "uncertain-provider-write"
      : (await hasUncertainCommands(tx, root.id))
        ? "uncertain-command"
        : null;
  const uncertainEffects = async (tx: Tx) => (await automaticBlocker(tx)) !== null;
  const snapshot = (options: { includeHistory?: boolean } = {}): Promise<DurableScheduleSnapshot> =>
    root.commit(
      async (tx) => snapshotCopy(await tx.doc(DurableSchedule, root.id), await automaticBlocker(tx), options.includeHistory ?? true),
      BACKGROUND_CONTEXT,
    );
  const history = (kind: "events" | "intents", options: ScheduleHistoryOptions = {}): Promise<ScheduleHistoryPage> => {
    const offset = historyInteger(options.offset, 0, 0, 1000000),
      limit = historyInteger(options.limit, 30, 1, 100),
      textOffset = historyInteger(options.textOffset, 0, 0, 1000000),
      textLimit = historyInteger(options.textLimit, 4000, 1, 4000);
    return root.commit(async (tx) => {
      const state = await tx.doc(DurableSchedule, root.id);
      if (kind === "events") {
        const records = Object.values(state.events),
          selected = records.slice(offset, offset + limit);
        return {
          kind,
          offset,
          limit,
          total: records.length,
          nextOffset: offset + selected.length < records.length ? offset + selected.length : null,
          observedAtMs: Date.now(),
          items: selected.map((record) => {
            const excerpt = historyText(record.payload, textOffset, textLimit);
            return { ...eventCopy(record), payload: excerpt.text, payloadRange: excerpt.range };
          }),
        };
      }
      const records = Object.values(state.intents),
        selected = records.slice(offset, offset + limit);
      const routines = new Map<string, Array<{ at: number; outcome: "ok" | "failed" | "skipped" | "paused"; durationMs: number | null }>>();
      for (const intent of records) {
        if (intent.kind !== "schedule") continue;
        const outcome =
          intent.status === "submitted" && intent.outcome === "completed"
            ? "ok"
            : intent.status === "failed"
              ? "failed"
              : intent.status === "interrupted"
                ? "paused"
                : intent.status === "recorded"
                  ? "skipped"
                  : null;
        if (outcome === null) continue;
        const runs = routines.get(intent.stableId) ?? [];
        runs.push({ at: intent.recordedAtMs, outcome, durationMs: intent.durationMs ?? null });
        routines.set(intent.stableId, runs);
      }
      return {
        kind,
        offset,
        limit,
        total: records.length,
        nextOffset: offset + selected.length < records.length ? offset + selected.length : null,
        observedAtMs: Date.now(),
        items: selected.map((record) => {
          const excerpt = historyText(record.text, textOffset, textLimit),
            outcome = record.outcome === null ? null : historyText(record.outcome, textOffset, textLimit);
          return {
            ...intentCopy(record),
            text: excerpt.text,
            textRange: excerpt.range,
            outcome: outcome?.text ?? null,
            outcomeRange: outcome?.range ?? null,
          };
        }),
        routines: [...routines].map(([routineId, runs]) => ({ routineId, recentRuns: runs.sort((a, b) => b.at - a.at).slice(0, 20) })),
      };
    }, BACKGROUND_CONTEXT);
  };
  const create = (input: { id?: string; atMs: number; text: string; everyMs?: number; calendar?: CalendarRule; name?: string }) =>
    mutex.run(async () => {
      if (!input.text || input.text.length > 32000) throw new Error("Invalid schedule");
      const timing = timingFields(input);
      if (isClosed()) throw new Error("Project is closed");
      const id = input.id ?? crypto.randomUUID(),
        now = Date.now();
      return root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id),
          prior = own(state.schedules, id);
        if (prior) {
          if (
            prior.atMs !== input.atMs ||
            prior.text !== input.text ||
            prior.name !== input.name ||
            (prior.kind === "interval" ? prior.everyMs : undefined) !== input.everyMs ||
            JSON.stringify(prior.kind === "calendar" ? copyCalendarRule(prior.rule) : undefined) !== JSON.stringify(input.calendar)
          )
            throw new Error("Conflicting schedule ID");
          return scheduleCopy(prior);
        }
        const value: Schedule = {
          id,
          projectId,
          enabled: false,
          atMs: input.atMs,
          text: input.text,
          createdAtMs: now,
          updatedAtMs: now,
          ...(input.name ? { name: input.name } : {}),
          revision: 0,
          ...timing,
        };
        state.schedules = { ...state.schedules, [id]: value };
        return scheduleCopy(value);
      }, BACKGROUND_CONTEXT);
    });
  const setEnabled = (id: string, enabled: boolean) =>
    mutex.run(async () =>
      root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const schedule = own(state.schedules, id);
        if (!schedule) throw new Error("Unknown schedule");
        if (
          enabled &&
          schedule.kind === "once" &&
          Object.values(state.intents).some((intent) => intent.kind === "schedule" && intent.stableId === id)
        )
          throw new Error("Consumed one-shot schedules cannot be re-enabled");
        schedule.enabled = enabled;
        schedule.updatedAtMs = Date.now();
        schedule.revision = (schedule.revision ?? 0) + 1;
        return scheduleCopy(schedule);
      }, BACKGROUND_CONTEXT),
    );
  const withRevision = (schedule: Schedule | undefined, revision: number): Schedule => {
    if (!schedule) throw new Error("Unknown schedule");
    if ((schedule.revision ?? 0) !== revision) throw new Error("Schedule changed (stale revision); reread it and retry");
    return schedule;
  };
  /** Name, prompt and timing, replaced as given; timing replaces kind and next run together. */
  const update = (
    id: string,
    revision: number,
    change: { name?: string | null; text?: string; schedule?: ScheduleTiming; cleanup?: Partial<CleanupSettings> },
  ) =>
    mutex.run(async () => {
      if (change.text !== undefined && (!change.text || change.text.length > 32000)) throw new Error("Invalid schedule");
      const timing = change.schedule ? timingFields(change.schedule) : undefined;
      if (isClosed()) throw new Error("Project is closed");
      return root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const current = withRevision(own(state.schedules, id), revision);
        if (current.action && change.text !== undefined) throw new Error("Only prompt routines have prompt text");
        if (change.cleanup && current.action?.kind !== "cleanup") throw new Error("Only the cleanup routine has cleanup settings");
        const action =
          change.cleanup && current.action?.kind === "cleanup"
            ? { kind: current.action.kind, settings: { ...current.action.settings, ...change.cleanup } }
            : undefined;
        const refused = action && cleanupSettingsError(action.settings);
        if (refused) throw new Error(refused);
        if (change.schedule && current.kind === "once" && consumed(state, id))
          throw new Error("This one-shot schedule already ran; create a new one instead of rescheduling it");
        const { name: _name, ...kept } = current;
        const named = change.name === undefined ? current.name : (change.name ?? undefined);
        const base = {
          ...kept,
          ...(named ? { name: named } : {}),
          text: change.text ?? current.text,
          updatedAtMs: Date.now(),
          revision: revision + 1,
          ...(action ? { action: actionCopy(action) } : {}),
        };
        const next: Schedule =
          change.schedule && timing
            ? (() => {
                const {
                  everyMs: _every,
                  nextAtMs: _next,
                  rule: _rule,
                  kind: _kind,
                  ...rest
                } = base as Schedule & { everyMs?: number; nextAtMs?: number; rule?: CalendarRule };
                return { ...rest, atMs: change.schedule.atMs, ...timing };
              })()
            : (base as Schedule);
        state.schedules = { ...state.schedules, [id]: next };
        return scheduleCopy(next);
      }, BACKGROUND_CONTEXT);
    });
  /** A script routine, off until enabled like any new routine; its command is stored exactly. */
  const createScript = (input: {
    id?: string;
    name?: string;
    command: string;
    timeoutMs: number;
    chatId?: string;
    atMs: number;
    everyMs?: number;
    calendar?: CalendarRule;
  }) =>
    mutex.run(async () => {
      const refused = scriptError(input);
      if (refused) throw new Error(refused);
      const timing = timingFields(input);
      if (isClosed()) throw new Error("Project is closed");
      const id = input.id ?? crypto.randomUUID(),
        now = Date.now();
      const action: HostAction = {
        kind: "script",
        command: input.command,
        timeoutMs: input.timeoutMs,
        ...(input.chatId ? { chatId: input.chatId } : {}),
      };
      return root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id),
          prior = own(state.schedules, id);
        if (prior) {
          if (JSON.stringify(prior.action) !== JSON.stringify(action) || prior.name !== input.name || prior.atMs !== input.atMs)
            throw new Error("Conflicting schedule ID");
          return scheduleCopy(prior);
        }
        const value: Schedule = {
          id,
          projectId,
          enabled: false,
          atMs: input.atMs,
          text: "",
          createdAtMs: now,
          updatedAtMs: now,
          ...(input.name ? { name: input.name } : {}),
          revision: 0,
          action,
          ...timing,
        };
        state.schedules = { ...state.schedules, [id]: value };
        return scheduleCopy(value);
      }, BACKGROUND_CONTEXT);
    });
  /** Changes a script routine's command, timeout or chat (revision-checked). */
  const setScript = (id: string, revision: number, change: { command?: string; timeoutMs?: number; chatId?: string | null }) =>
    mutex.run(async () =>
      root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const current = withRevision(own(state.schedules, id), revision);
        if (current.action?.kind !== "script") throw new Error("Only script routines have a command");
        const { chatId: _chat, ...kept } = current.action;
        const chatId = change.chatId === undefined ? current.action.chatId : (change.chatId ?? undefined);
        const action: HostAction = {
          ...kept,
          ...(change.command !== undefined ? { command: change.command } : {}),
          ...(change.timeoutMs !== undefined ? { timeoutMs: change.timeoutMs } : {}),
          ...(chatId ? { chatId } : {}),
        };
        const refused = scriptError(action);
        if (refused) throw new Error(refused);
        const next: Schedule = { ...current, action, updatedAtMs: Date.now(), revision: revision + 1 };
        state.schedules = { ...state.schedules, [id]: next };
        return scheduleCopy(next);
      }, BACKGROUND_CONTEXT),
    );
  /** Runs the prompt now, enabled or not; a one-shot counts as run. Refused while a run of it is still in flight. */
  const runNow = (id: string) =>
    mutex.run(async () => {
      if (isClosed()) throw new Error("Project is closed");
      const now = Date.now();
      const due = await root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const schedule = own(state.schedules, id);
        if (!schedule) throw new Error("Unknown schedule");
        if (inFlight(state, id)) throw new Error("A run of this schedule is already in flight");
        const requestId = `schedule:${id}:run:${now}`;
        if (own(state.intents, requestId)) throw new Error("Schedule run already recorded");
        if (schedule.kind === "once") schedule.enabled = false;
        state.intents[requestId] = runIntent(schedule, requestId, now);
        return { intent: intentCopy(state.intents[requestId]), action: schedule.action && actionCopy(schedule.action) };
      }, BACKGROUND_CONTEXT);
      return dispatch(due.intent, due.action);
    });
  function runIntent(schedule: Schedule, requestId: string, now: number): ScheduleIntent {
    return {
      requestId,
      kind: "schedule",
      stableId: schedule.id,
      text: schedule.action ? (schedule.name ?? schedule.action.kind) : schedule.text,
      status: "recorded",
      submissionId: null,
      recordedAtMs: now,
      outcome: null,
      ...(schedule.action ? { action: schedule.action.kind } : {}),
    };
  }
  async function dispatch(intent: ScheduleIntent, action: HostAction | undefined): Promise<ScheduleIntent> {
    await hooks.afterScheduleIntentRecorded?.({
      requestId: intent.requestId,
      stableId: intent.stableId,
      kind: intent.kind,
      submissionId: null,
    });
    return action ? startAction(intent, action) : submitIntent(intent);
  }
  /** Starts a host action in the background; the intent stays submitted without an outcome until it ends, so runs never overlap. */
  async function startAction(intent: ScheduleIntent, action: HostAction): Promise<ScheduleIntent> {
    const runAction = hooks.runAction;
    if (!runAction) return mark(intent.requestId, "failed", "This host cannot run the routine's action");
    if (isClosed()) return mark(intent.requestId, "interrupted", "Project closed");
    const started = await root.commit(async (tx) => {
      const planning = await tx.doc(Jobs, root.id);
      const current = own((await tx.doc(DurableSchedule, root.id)).intents, intent.requestId);
      if (!current || current.status !== "recorded" || planning.paused) return null;
      current.status = "submitted";
      return intentCopy(current);
    }, BACKGROUND_CONTEXT);
    if (!started) return mark(intent.requestId, "interrupted", "Project paused");
    running.add(intent.requestId);
    const startedAt = Date.now();
    const finish = (status: ScheduleIntent["status"], outcome: string, summary: string) =>
      root.commit(async (tx) => {
        const current = own((await tx.doc(DurableSchedule, root.id)).intents, intent.requestId);
        if (current) Object.assign(current, { status, outcome, summary, durationMs: Date.now() - startedAt });
      }, BACKGROUND_CONTEXT);
    const work = runAction(action, {
      requestId: intent.requestId,
      recordedAtMs: intent.recordedAtMs,
      routineId: intent.stableId,
      name: intent.text,
    })
      .then(
        (result) => (result.ok ? finish("submitted", "completed", result.summary) : finish("failed", result.summary, result.summary)),
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          return finish("failed", message, message);
        },
      )
      .catch(() => {})
      .finally(() => {
        running.delete(intent.requestId);
        actionRuns.delete(work);
      });
    actionRuns.add(work);
    return started;
  }
  /** Creates a built-in routine once, enabled; an existing one (perhaps turned off or retimed by the owner) is left as it is. */
  const ensureRoutine = (input: { id: string; name: string; action: HostAction; everyMs: number; firstAtMs: number }) =>
    mutex.run(async () =>
      root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const prior = own(state.schedules, input.id);
        if (prior) return scheduleCopy(prior);
        const now = Date.now();
        const value: Schedule = {
          id: input.id,
          projectId,
          enabled: true,
          atMs: input.firstAtMs,
          text: "",
          createdAtMs: now,
          updatedAtMs: now,
          name: input.name,
          revision: 0,
          action: actionCopy(input.action),
          kind: "interval",
          everyMs: input.everyMs,
          nextAtMs: input.firstAtMs,
        };
        state.schedules = { ...state.schedules, [input.id]: value };
        return scheduleCopy(value);
      }, BACKGROUND_CONTEXT),
    );
  /** Waits for host actions started by this runtime, for a clean close. */
  const drain = async () => {
    await Promise.allSettled([...actionRuns]);
  };
  /** Deletes a schedule and keeps it restorable for the restore window; returns the deleted record. */
  const remove = (id: string, revision: number) =>
    mutex.run(async () =>
      root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const schedule = withRevision(own(state.schedules, id), revision);
        if (schedule.action?.kind === "cleanup") throw new Error("The cleanup routine cannot be deleted; turn it off instead");
        const now = Date.now();
        const { [id]: _removed, ...rest } = state.schedules;
        state.schedules = rest;
        const kept = Object.fromEntries(Object.entries(state.deleted ?? {}).filter(([, item]) => now - item.deletedAtMs <= RESTORE_MS));
        state.deleted = { ...kept, [id]: { schedule: storedCopy(schedule), deletedAtMs: now } };
        return scheduleCopy(schedule);
      }, BACKGROUND_CONTEXT),
    );
  const restore = (id: string) =>
    mutex.run(async () =>
      root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        if (own(state.schedules, id)) throw new Error("A schedule with this id exists; nothing to restore");
        const entry = own(state.deleted ?? {}, id);
        if (!entry) throw new Error("No deleted schedule with this id");
        if (Date.now() - entry.deletedAtMs > RESTORE_MS) throw new Error("The restore window for this schedule has passed");
        const { [id]: _restored, ...rest } = state.deleted ?? {};
        state.deleted = rest;
        state.schedules = { ...state.schedules, [id]: storedCopy(entry.schedule) };
        return scheduleCopy(entry.schedule);
      }, BACKGROUND_CONTEXT),
    );
  const setEventOptIn = (enabled: boolean) =>
    mutex.run(async () =>
      root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        state.eventOptIn = enabled;
        return state.eventOptIn;
      }, BACKGROUND_CONTEXT),
    );
  /** `options.target` routes the event to a chat; `automation` events (Follow PRs, webhook) carry their own owner opt-in instead of `eventOptIn`. */
  const ingest = (
    input: { eventId: string; kind: string; payload: string },
    guard?: (tx: Tx) => Promise<boolean>,
    onRecord?: (tx: Tx) => Promise<void>,
    options: { target?: Conversation; automation?: boolean } = {},
  ) =>
    mutex.run(async () => {
      if (!input.eventId || input.eventId.length > 256 || !input.kind || input.kind.length > 128 || input.payload.length > 32000)
        throw new Error("Invalid owner-local event");
      if (isClosed()) throw new Error("Project is closed");
      const result = await root.commit(async (tx) => {
        if (await uncertainEffects(tx)) throw new Error("Automatic event admission is blocked by an uncertain effect");
        if (guard && !(await guard(tx))) throw new Error("Event admission is no longer authorized");
        const state = await tx.doc(DurableSchedule, root.id);
        if (!state.eventOptIn && !options.automation) throw new Error("Owner-local event ingress is disabled");
        const prior = own(state.events, input.eventId);
        if (prior) {
          if (prior.kind !== input.kind || prior.payload !== input.payload) throw new Error("Conflicting event ID");
          const priorIntent = own(state.intents, prior.requestId);
          if (!priorIntent) throw new Error("Event intent record is missing");
          await onRecord?.(tx);
          return { intent: intentCopy(priorIntent), newlyRecorded: false };
        }
        const requestId = `event:${input.eventId}`;
        state.events = { ...state.events, [input.eventId]: { ...input, projectId, createdAtMs: Date.now(), requestId } };
        const intent: ScheduleIntent = {
          requestId,
          kind: "event",
          stableId: input.eventId,
          text: `[Owner-local event ${input.kind}]\n${input.payload}`,
          status: "recorded",
          submissionId: null,
          recordedAtMs: Date.now(),
          outcome: null,
          ...(options.target && options.target.id !== root.id ? { conversationId: Number(options.target.id) } : {}),
        };
        state.intents[requestId] = intent;
        await onRecord?.(tx);
        return { intent: intentCopy(intent), newlyRecorded: true };
      }, BACKGROUND_CONTEXT);
      if (result.newlyRecorded)
        await hooks.afterScheduleIntentRecorded?.({
          requestId: result.intent.requestId,
          stableId: result.intent.stableId,
          kind: result.intent.kind,
          submissionId: null,
        });
      const submitted: ScheduleIntent & { duplicate?: true } = await submitIntent(result.intent, options.target);
      if (!result.newlyRecorded) submitted.duplicate = true;
      return submitted;
    });
  async function submitIntent(intent: ScheduleIntent, target: Conversation = root): Promise<ScheduleIntent> {
    if (intent.status !== "recorded") return intent;
    if (isClosed()) return mark(intent.requestId, "interrupted", "Project closed");
    const allowed = await root.commit(async (tx) => {
      const planning = await tx.doc(Jobs, root.id);
      const state = await tx.doc(DurableSchedule, root.id);
      const current = own(state.intents, intent.requestId);
      if (!current || current.status !== "recorded" || planning.paused) return "paused";
      return (await uncertainEffects(tx)) ? "uncertain" : "allowed";
    }, BACKGROUND_CONTEXT);
    if (allowed !== "allowed")
      return mark(
        intent.requestId,
        "interrupted",
        allowed === "uncertain" ? "Automatic admission blocked by an uncertain effect" : "Project paused",
      );
    try {
      const submission = await (intent.conversationId === undefined ? root : target).submit(
        {
          type: "input",
          content: intent.text,
          entry: { kind: "projects.internal-input" },
          requestId: intent.requestId,
          whenBusy: "followUp",
        },
        BACKGROUND_CONTEXT,
      );
      await hooks.beforeScheduleReceiptCommit?.({ requestId: intent.requestId, submissionId: Number(submission.id) });
      return root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const current = own(state.intents, intent.requestId);
        if (current) {
          current.status = "submitted";
          current.submissionId = Number(submission.id);
        }
        return current ? intentCopy(current) : intentCopy(intent);
      }, BACKGROUND_CONTEXT);
    } catch (error) {
      return mark(
        intent.requestId,
        "uncertain",
        `Admission failed; fingerprint ${createHash("sha256")
          .update(error instanceof Error ? error.message : String(error))
          .digest("hex")}`,
      );
    }
  }
  const mark = (requestId: string, status: ScheduleIntent["status"], outcome: string) =>
    root.commit(async (tx) => {
      const state = await tx.doc(DurableSchedule, root.id);
      const intent = own(state.intents, requestId);
      if (!intent) throw new Error("Schedule intent record is missing");
      intent.status = status;
      intent.outcome = outcome;
      return intentCopy(intent);
    }, BACKGROUND_CONTEXT);
  function eligible(schedule: Schedule, state: ScheduleState): boolean {
    if (!schedule.enabled) return false;
    const intents = Object.values(state.intents).filter((intent) => intent.kind === "schedule" && intent.stableId === schedule.id);
    if (schedule.kind === "once") return intents.length === 0;
    return !intents.some(
      (intent) =>
        intent.status === "recorded" || intent.status === "uncertain" || (intent.status === "submitted" && intent.outcome !== "completed"),
    );
  }
  const nextDeadline = () =>
    root.commit(async (tx) => {
      const state = await tx.doc(DurableSchedule, root.id),
        planning = await tx.doc(Jobs, root.id);
      if (isClosed() || planning.paused) return null;
      if (await uncertainEffects(tx))
        return Object.values(state.schedules).some((schedule) => schedule.enabled) ? Date.now() + 60000 : null;
      const deadlines = Object.values(state.schedules).flatMap((schedule) => {
        if (eligible(schedule, state)) return [schedule.kind === "once" ? schedule.atMs : schedule.nextAtMs];
        if (
          schedule.enabled &&
          schedule.kind !== "once" &&
          Object.values(state.intents).some(
            (intent) =>
              intent.kind === "schedule" && intent.stableId === schedule.id && intent.status === "submitted" && intent.outcome === null,
          )
        )
          return [Date.now() + 60000];
        return [];
      });
      return deadlines.length ? Math.min(...deadlines) : null;
    }, BACKGROUND_CONTEXT);
  const fireDue = (now = Date.now()) =>
    mutex.run(async () => {
      if (isClosed()) return null;
      const due = await root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id),
          planning = await tx.doc(Jobs, root.id);
        if (planning.paused || (await uncertainEffects(tx))) return null;
        const schedule = Object.values(state.schedules)
          .filter((item) => eligible(item, state) && (item.kind === "once" ? item.atMs : item.nextAtMs) <= now)
          .sort((a, b) => (a.kind === "once" ? a.atMs : a.nextAtMs) - (b.kind === "once" ? b.atMs : b.nextAtMs))[0];
        if (!schedule) return null;
        const atMs =
          schedule.kind === "calendar"
            ? latestCalendarOccurrence(schedule.rule, now)
            : schedule.kind === "interval"
              ? schedule.nextAtMs + Math.floor((now - schedule.nextAtMs) / schedule.everyMs) * schedule.everyMs
              : schedule.atMs;
        const requestId = `schedule:${schedule.id}:tick:${schedule.id}:${atMs}`;
        if (own(state.intents, requestId)) throw new Error("Schedule tick already recorded");
        if (schedule.kind === "calendar") schedule.nextAtMs = nextCalendarOccurrence(schedule.rule, atMs);
        else if (schedule.kind === "interval") schedule.nextAtMs = atMs + schedule.everyMs;
        else schedule.enabled = false;
        schedule.updatedAtMs = now;
        state.intents[requestId] = runIntent(schedule, requestId, now);
        return { intent: intentCopy(state.intents[requestId]), action: schedule.action && actionCopy(schedule.action) };
      }, BACKGROUND_CONTEXT);
      return due ? dispatch(due.intent, due.action) : null;
    });
  const reconcile = async (): Promise<void> =>
    mutex.run(async () => {
      const updates = await root.commit(async (tx) => {
        const state = await tx.doc(DurableSchedule, root.id);
        const result: Array<{ requestId: string; status: ScheduleIntent["status"]; submissionId?: number; outcome?: string | null }> = [];
        for (const intent of Object.values(state.intents)) {
          if (intent.action) {
            const open = intent.status === "recorded" || (intent.status === "submitted" && intent.outcome === null);
            if (open && !running.has(intent.requestId))
              result.push({ requestId: intent.requestId, status: "interrupted", outcome: "The host stopped during the run" });
            continue;
          }
          const receipt = await tx.submissionByRequest((intent.conversationId ?? root.id) as Conversation["id"], intent.requestId);
          if (!receipt) {
            if (intent.status === "recorded")
              result.push({
                requestId: intent.requestId,
                status: "uncertain",
                outcome: "No public SDK submission record; preserved as uncertain rather than resubmitted",
              });
            continue;
          }
          if (receipt.status === "done" || receipt.status === "unanswered")
            result.push({
              requestId: intent.requestId,
              status: receipt.status === "done" ? "submitted" : receipt.reason === "aborted" ? "interrupted" : "failed",
              submissionId: Number(receipt.id),
              outcome: receipt.status === "done" ? "completed" : receipt.reason,
            });
          else if (intent.status === "recorded")
            result.push({ requestId: intent.requestId, status: "submitted", submissionId: Number(receipt.id), outcome: null });
        }
        return result;
      }, BACKGROUND_CONTEXT);
      if (isClosed()) return;
      for (const update of updates)
        await root.commit(async (tx) => {
          const state = await tx.doc(DurableSchedule, root.id);
          const intent = own(state.intents, update.requestId);
          if (intent) {
            intent.status = update.status;
            if (update.submissionId !== undefined) intent.submissionId = update.submissionId;
            if (update.outcome !== undefined) intent.outcome = update.outcome;
          }
        }, BACKGROUND_CONTEXT);
    });
  return {
    snapshot,
    history,
    create,
    setEnabled,
    update,
    runNow,
    remove,
    restore,
    setEventOptIn,
    ingest,
    fireDue,
    nextDeadline,
    reconcile,
    ensureRoutine,
    createScript,
    setScript,
    drain,
    mutex,
  };
}
