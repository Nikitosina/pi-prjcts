import { createHash } from "node:crypto";
import { defineDoc, type Conversation, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurablePlanning } from "./durable-planning.ts";
import { hasUncertainGithubWrites } from "./github-worker.ts";
import { hasUncertainGithubOperations } from "./github-operations.ts";
import { hasUncertainCommands } from "./command-runtime.ts";
import { nextCalendarOccurrence, latestCalendarOccurrence, copyCalendarRule, type CalendarRule } from "./schedule-calendar.ts";
type Schedule = { id: string; projectId: string; enabled: boolean; atMs: number; text: string; createdAtMs: number; updatedAtMs: number } & ({ kind: "once" } | { kind: "interval"; everyMs: number; nextAtMs: number } | { kind: "calendar"; rule: CalendarRule; nextAtMs: number });
type Event = { eventId: string; projectId: string; kind: string; payload: string; createdAtMs: number; requestId: string };
export type ScheduleIntent = { requestId: string; kind: "schedule" | "event"; stableId: string; text: string; /** Chat conversation the event went to; absent means the root (Main). */ conversationId?: number; status: "recorded" | "submitted" | "interrupted" | "uncertain" | "failed"; submissionId: number | null; recordedAtMs: number; outcome: string | null };
export type DurableScheduleSnapshot = { automaticAdmissionBlocker: "uncertain-provider-write" | "uncertain-command" | null; eventOptIn: boolean; schedules: Schedule[] } & ({ historyIncluded?: true; events: Event[]; intents: ScheduleIntent[] } | { historyIncluded: false; historyCounts: { events: number; intents: number }; events: []; intents: [] });
export type ScheduleHistoryOptions = { offset?: number; limit?: number; textOffset?: number; textLimit?: number };
type TextRange = { offset: number; end: number; total: number; nextOffset: number | null; sha256: string };
type HistoryPage = { offset: number; limit: number; total: number; nextOffset: number | null; observedAtMs: number };
export type ScheduleHistoryPage = HistoryPage & ({ kind: "events"; items: Array<Event & { payloadRange: TextRange }> } | { kind: "intents"; items: Array<ScheduleIntent & { textRange: TextRange; outcomeRange: TextRange | null }>; routines: Array<{ routineId: string; recentRuns: Array<{ at: number; outcome: "ok" | "failed" | "skipped" | "paused"; durationMs: number | null }> }> });
type ScheduleState = { eventOptIn: boolean; schedules: Record<string, Schedule>; events: Record<string, Event>; intents: Record<string, ScheduleIntent> };
function own<T>(record: Record<string, T>, key: string): T | undefined { return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined; }
function scheduleCopy(value: Schedule): Schedule { return value.kind === "calendar" ? { ...value, rule: copyCalendarRule(value.rule) } : { ...value }; }
function eventCopy(value: Event): Event { return { ...value }; }
function intentCopy(value: ScheduleIntent): ScheduleIntent { return { ...value }; }
function snapshotCopy(state: ScheduleState, automaticAdmissionBlocker: DurableScheduleSnapshot["automaticAdmissionBlocker"], includeHistory: boolean): DurableScheduleSnapshot {
  const base = { automaticAdmissionBlocker, eventOptIn: state.eventOptIn, schedules: Object.values(state.schedules).map(scheduleCopy) };
  return includeHistory ? { ...base, events: Object.values(state.events).map(eventCopy), intents: Object.values(state.intents).map(intentCopy) } : { ...base, historyIncluded: false, historyCounts: { events: Object.keys(state.events).length, intents: Object.keys(state.intents).length }, events: [], intents: [] };
}
function historyInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid schedule history page or text range");
  return result;
}
function historyText(value: string, offset: number, limit: number): { text: string; range: TextRange } {
  const characters = Array.from(value), start = Math.min(offset, characters.length), end = Math.min(start + limit, characters.length);
  return { text: characters.slice(start, end).join(""), range: { offset: start, end, total: characters.length, nextOffset: end < characters.length ? end : null, sha256: createHash("sha256").update(value).digest("hex") } };
}
export const DurableSchedule = defineDoc<ScheduleState>({ kind: "projects.durable-schedule", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ eventOptIn: false, schedules: {}, events: {}, intents: {} }) });
class AdmissionMutex { private tail = Promise.resolve(); async run<T>(operation: () => Promise<T>): Promise<T> { const previous = this.tail; let release!: () => void; this.tail = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } } }
export function scheduleRuntime(root: Conversation, projectId: string, isClosed: () => boolean, hooks: { afterScheduleIntentRecorded?: (value: Readonly<{ requestId: string; stableId: string; kind: "schedule" | "event"; submissionId: null }>) => Promise<void>; beforeScheduleReceiptCommit?: (value: Readonly<{ requestId: string; submissionId: number }>) => Promise<void> } = {}) {
  const mutex = new AdmissionMutex();
  const automaticBlocker = async (tx: Tx): Promise<DurableScheduleSnapshot["automaticAdmissionBlocker"]> => await hasUncertainGithubWrites(tx, root.id) || await hasUncertainGithubOperations(tx, root.id) ? "uncertain-provider-write" : await hasUncertainCommands(tx, root.id) ? "uncertain-command" : null;
  const uncertainEffects = async (tx: Tx) => await automaticBlocker(tx) !== null;
  const snapshot = (options: { includeHistory?: boolean } = {}): Promise<DurableScheduleSnapshot> => root.commit(async tx => snapshotCopy(await tx.doc(DurableSchedule, root.id), await automaticBlocker(tx), options.includeHistory ?? true), BACKGROUND_CONTEXT);
  const history = (kind: "events" | "intents", options: ScheduleHistoryOptions = {}): Promise<ScheduleHistoryPage> => {
    const offset = historyInteger(options.offset, 0, 0, 1000000), limit = historyInteger(options.limit, 30, 1, 100), textOffset = historyInteger(options.textOffset, 0, 0, 1000000), textLimit = historyInteger(options.textLimit, 4000, 1, 4000);
    return root.commit(async tx => {
      const state = await tx.doc(DurableSchedule, root.id);
      if (kind === "events") {
        const records = Object.values(state.events), selected = records.slice(offset, offset + limit);
        return { kind, offset, limit, total: records.length, nextOffset: offset + selected.length < records.length ? offset + selected.length : null, observedAtMs: Date.now(), items: selected.map(record => { const excerpt = historyText(record.payload, textOffset, textLimit); return { ...eventCopy(record), payload: excerpt.text, payloadRange: excerpt.range }; }) };
      }
      const records = Object.values(state.intents), selected = records.slice(offset, offset + limit);
      const routines = new Map<string, Array<{ at: number; outcome: "ok" | "failed" | "skipped" | "paused"; durationMs: number | null }>>();
      for (const intent of records) {
        if (intent.kind !== "schedule") continue;
        const outcome = intent.status === "submitted" && intent.outcome === "completed" ? "ok" : intent.status === "failed" ? "failed" : intent.status === "interrupted" ? "paused" : intent.status === "recorded" ? "skipped" : null;
        if (outcome === null) continue;
        const runs = routines.get(intent.stableId) ?? [];
        runs.push({ at: intent.recordedAtMs, outcome, durationMs: null });
        routines.set(intent.stableId, runs);
      }
      return { kind, offset, limit, total: records.length, nextOffset: offset + selected.length < records.length ? offset + selected.length : null, observedAtMs: Date.now(), items: selected.map(record => { const excerpt = historyText(record.text, textOffset, textLimit), outcome = record.outcome === null ? null : historyText(record.outcome, textOffset, textLimit); return { ...intentCopy(record), text: excerpt.text, textRange: excerpt.range, outcome: outcome?.text ?? null, outcomeRange: outcome?.range ?? null }; }), routines: [...routines].map(([routineId, runs]) => ({ routineId, recentRuns: runs.sort((a, b) => b.at - a.at).slice(0, 20) })) };
    }, BACKGROUND_CONTEXT);
  };
  const create = (input: { id?: string; atMs: number; text: string; everyMs?: number; calendar?: CalendarRule }) => mutex.run(async () => {
    if (!Number.isSafeInteger(input.atMs) || input.atMs < 0 || !input.text || input.text.length > 32000) throw new Error("Invalid schedule");
    if (input.everyMs !== undefined && (!Number.isSafeInteger(input.everyMs) || input.everyMs < 60000 || input.everyMs > 31536000000)) throw new Error("Schedule interval must be between one minute and one year");
    if (input.calendar !== undefined && input.everyMs !== undefined) throw new Error("Choose a calendar rule or an interval, not both");
    const firstCalendarAt = input.calendar === undefined ? null : nextCalendarOccurrence(input.calendar, input.atMs - 1);
    if (isClosed()) throw new Error("Project is closed");
    const id = input.id ?? crypto.randomUUID(), now = Date.now();
    return root.commit(async tx => {
      const state = await tx.doc(DurableSchedule, root.id), prior = own(state.schedules, id);
      if (prior) {
        if (prior.atMs !== input.atMs || prior.text !== input.text || (prior.kind === "interval" ? prior.everyMs : undefined) !== input.everyMs || JSON.stringify(prior.kind === "calendar" ? copyCalendarRule(prior.rule) : undefined) !== JSON.stringify(input.calendar)) throw new Error("Conflicting schedule ID");
        return scheduleCopy(prior);
      }
      const base = { id, projectId, enabled: false, atMs: input.atMs, text: input.text, createdAtMs: now, updatedAtMs: now };
      const value: Schedule = input.calendar !== undefined && firstCalendarAt !== null ? { ...base, kind: "calendar", rule: copyCalendarRule(input.calendar), nextAtMs: firstCalendarAt } : input.everyMs === undefined ? { ...base, kind: "once" } : { ...base, kind: "interval", everyMs: input.everyMs, nextAtMs: input.atMs };
      state.schedules = { ...state.schedules, [id]: value };
      return scheduleCopy(value);
    }, BACKGROUND_CONTEXT);
  });
  const setEnabled = (id: string, enabled: boolean) => mutex.run(async () => root.commit(async tx => { const state = await tx.doc(DurableSchedule, root.id); const schedule = own(state.schedules, id); if (!schedule) throw new Error("Unknown schedule"); if (enabled && schedule.kind === "once" && Object.values(state.intents).some(intent => intent.kind === "schedule" && intent.stableId === id)) throw new Error("Consumed one-shot schedules cannot be re-enabled"); schedule.enabled = enabled; schedule.updatedAtMs = Date.now(); return scheduleCopy(schedule); }, BACKGROUND_CONTEXT));
  const setEventOptIn = (enabled: boolean) => mutex.run(async () => root.commit(async tx => { const state = await tx.doc(DurableSchedule, root.id); state.eventOptIn = enabled; return state.eventOptIn; }, BACKGROUND_CONTEXT));
  /** `options.target` routes the event to a chat; `automation` events (Follow PRs, webhook) carry their own owner opt-in instead of `eventOptIn`. */
  const ingest = (input: { eventId: string; kind: string; payload: string }, guard?: (tx: Tx) => Promise<boolean>, onRecord?: (tx: Tx) => Promise<void>, options: { target?: Conversation; automation?: boolean } = {}) => mutex.run(async () => { if (!input.eventId || input.eventId.length > 256 || !input.kind || input.kind.length > 128 || input.payload.length > 32000) throw new Error("Invalid owner-local event"); if (isClosed()) throw new Error("Project is closed"); const result = await root.commit(async tx => { if (await uncertainEffects(tx)) throw new Error("Automatic event admission is blocked by an uncertain effect"); if (guard && !await guard(tx)) throw new Error("Event admission is no longer authorized"); const state = await tx.doc(DurableSchedule, root.id); if (!state.eventOptIn && !options.automation) throw new Error("Owner-local event ingress is disabled"); const prior = own(state.events, input.eventId); if (prior) { if (prior.kind !== input.kind || prior.payload !== input.payload) throw new Error("Conflicting event ID"); const priorIntent = own(state.intents, prior.requestId); if (!priorIntent) throw new Error("Event intent record is missing"); await onRecord?.(tx); return { intent: intentCopy(priorIntent), newlyRecorded: false }; } const requestId = `event:${input.eventId}`; state.events = { ...state.events, [input.eventId]: { ...input, projectId, createdAtMs: Date.now(), requestId } }; const intent: ScheduleIntent = { requestId, kind: "event", stableId: input.eventId, text: `[Owner-local event ${input.kind}]\n${input.payload}`, status: "recorded", submissionId: null, recordedAtMs: Date.now(), outcome: null, ...(options.target && options.target.id !== root.id ? { conversationId: Number(options.target.id) } : {}) }; state.intents[requestId] = intent; await onRecord?.(tx); return { intent: intentCopy(intent), newlyRecorded: true }; }, BACKGROUND_CONTEXT); if (result.newlyRecorded) await hooks.afterScheduleIntentRecorded?.({ requestId: result.intent.requestId, stableId: result.intent.stableId, kind: result.intent.kind, submissionId: null }); const submitted: ScheduleIntent & { duplicate?: true } = await submitIntent(result.intent, options.target); if (!result.newlyRecorded) submitted.duplicate = true; return submitted; });
  async function submitIntent(intent: ScheduleIntent, target: Conversation = root): Promise<ScheduleIntent> { if (intent.status !== "recorded") return intent; if (isClosed()) return mark(intent.requestId, "interrupted", "Project closed"); const allowed = await root.commit(async tx => { const planning = await tx.doc(DurablePlanning, root.id); const state = await tx.doc(DurableSchedule, root.id); const current = own(state.intents, intent.requestId); if (!current || current.status !== "recorded" || planning.paused || planning.pausing) return "paused"; return await uncertainEffects(tx) ? "uncertain" : "allowed"; }, BACKGROUND_CONTEXT); if (allowed !== "allowed") return mark(intent.requestId, "interrupted", allowed === "uncertain" ? "Automatic admission blocked by an uncertain effect" : "Project paused"); try { const submission = await (intent.conversationId === undefined ? root : target).submit({ type: "input", content: intent.text, requestId: intent.requestId, whenBusy: "followUp" }, BACKGROUND_CONTEXT); await hooks.beforeScheduleReceiptCommit?.({ requestId: intent.requestId, submissionId: Number(submission.id) }); return root.commit(async tx => { const state = await tx.doc(DurableSchedule, root.id); const current = own(state.intents, intent.requestId); if (current) { current.status = "submitted"; current.submissionId = Number(submission.id); } return current ? intentCopy(current) : intentCopy(intent); }, BACKGROUND_CONTEXT); } catch (error) { return mark(intent.requestId, "uncertain", `Admission failed; fingerprint ${createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex")}`); } }
  const mark = (requestId: string, status: ScheduleIntent["status"], outcome: string) => root.commit(async tx => { const state = await tx.doc(DurableSchedule, root.id); const intent = own(state.intents, requestId); if (!intent) throw new Error("Schedule intent record is missing"); intent.status = status; intent.outcome = outcome; return intentCopy(intent); }, BACKGROUND_CONTEXT);
  function eligible(schedule: Schedule, state: ScheduleState): boolean {
    if (!schedule.enabled) return false;
    const intents = Object.values(state.intents).filter(intent => intent.kind === "schedule" && intent.stableId === schedule.id);
    if (schedule.kind === "once") return intents.length === 0;
    return !intents.some(intent => intent.status === "recorded" || intent.status === "uncertain" || (intent.status === "submitted" && intent.outcome !== "completed"));
  }
  const nextDeadline = () => root.commit(async tx => {
    const state = await tx.doc(DurableSchedule, root.id), planning = await tx.doc(DurablePlanning, root.id);
    if (isClosed() || planning.paused || planning.pausing) return null;
    if (await uncertainEffects(tx)) return Object.values(state.schedules).some(schedule => schedule.enabled) ? Date.now() + 60000 : null;
    const deadlines = Object.values(state.schedules).flatMap(schedule => {
      if (eligible(schedule, state)) return [schedule.kind === "once" ? schedule.atMs : schedule.nextAtMs];
      if (schedule.enabled && schedule.kind !== "once" && Object.values(state.intents).some(intent => intent.kind === "schedule" && intent.stableId === schedule.id && intent.status === "submitted" && intent.outcome === null)) return [Date.now() + 60000];
      return [];
    });
    return deadlines.length ? Math.min(...deadlines) : null;
  }, BACKGROUND_CONTEXT);
  const fireDue = (now = Date.now()) => mutex.run(async () => {
    if (isClosed()) return null;
    const due = await root.commit(async tx => {
      const state = await tx.doc(DurableSchedule, root.id), planning = await tx.doc(DurablePlanning, root.id);
      if (planning.paused || planning.pausing || await uncertainEffects(tx)) return null;
      const schedule = Object.values(state.schedules).filter(item => eligible(item, state) && (item.kind === "once" ? item.atMs : item.nextAtMs) <= now).sort((a, b) => (a.kind === "once" ? a.atMs : a.nextAtMs) - (b.kind === "once" ? b.atMs : b.nextAtMs))[0];
      if (!schedule) return null;
      const atMs = schedule.kind === "calendar" ? latestCalendarOccurrence(schedule.rule, now) : schedule.kind === "interval" ? schedule.nextAtMs + Math.floor((now - schedule.nextAtMs) / schedule.everyMs) * schedule.everyMs : schedule.atMs;
      const requestId = `schedule:${schedule.id}:tick:${schedule.id}:${atMs}`;
      if (own(state.intents, requestId)) throw new Error("Schedule tick already recorded");
      if (schedule.kind === "calendar") schedule.nextAtMs = nextCalendarOccurrence(schedule.rule, atMs);
      else if (schedule.kind === "interval") schedule.nextAtMs = atMs + schedule.everyMs;
      else schedule.enabled = false;
      schedule.updatedAtMs = now;
      state.intents[requestId] = { requestId, kind: "schedule", stableId: schedule.id, text: schedule.text, status: "recorded", submissionId: null, recordedAtMs: now, outcome: null };
      return intentCopy(state.intents[requestId]);
    }, BACKGROUND_CONTEXT);
    if (due) await hooks.afterScheduleIntentRecorded?.({ requestId: due.requestId, stableId: due.stableId, kind: due.kind, submissionId: null });
    return due ? submitIntent(due) : null;
  });
  const reconcile = async (): Promise<void> => mutex.run(async () => { const updates = await root.commit(async tx => { const state = await tx.doc(DurableSchedule, root.id); const result: Array<{ requestId: string; status: ScheduleIntent["status"]; submissionId?: number; outcome?: string | null }> = []; for (const intent of Object.values(state.intents)) { const receipt = await tx.submissionByRequest((intent.conversationId ?? root.id) as Conversation["id"], intent.requestId); if (!receipt) { if (intent.status === "recorded") result.push({ requestId: intent.requestId, status: "uncertain", outcome: "No public SDK submission record; preserved as uncertain rather than resubmitted" }); continue; } if (receipt.status === "done" || receipt.status === "unanswered") result.push({ requestId: intent.requestId, status: receipt.status === "done" ? "submitted" : receipt.reason === "aborted" ? "interrupted" : "failed", submissionId: Number(receipt.id), outcome: receipt.status === "done" ? "completed" : receipt.reason }); else if (intent.status === "recorded") result.push({ requestId: intent.requestId, status: "submitted", submissionId: Number(receipt.id), outcome: null }); } return result; }, BACKGROUND_CONTEXT); if (isClosed()) return; for (const update of updates) await root.commit(async tx => { const state = await tx.doc(DurableSchedule, root.id); const intent = own(state.intents, update.requestId); if (intent) { intent.status = update.status; if (update.submissionId !== undefined) intent.submissionId = update.submissionId; if (update.outcome !== undefined) intent.outcome = update.outcome; } }, BACKGROUND_CONTEXT); });
  return { snapshot, history, create, setEnabled, setEventOptIn, ingest, fireDue, nextDeadline, reconcile, mutex };
}
