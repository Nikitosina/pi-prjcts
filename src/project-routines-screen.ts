import { ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { request } from "./client.ts";
import { clean, firstLine } from "./project-items.ts";
import { Id, errorText, parse, type Project, type Request } from "./state.ts";

const Schedule = Type.Object({ id: Type.String(), projectId: Id, enabled: Type.Boolean(), kind: Type.Union([Type.Literal("once"), Type.Literal("interval"), Type.Literal("calendar")]), text: Type.String() });
const Monitor = Type.Object({ id: Id, repositoryId: Type.String(), expectedRepositoryId: Type.Integer({ minimum: 1 }), pullRequest: Type.Integer({ minimum: 1 }), kind: Type.Union([Type.Literal("pr"), Type.Literal("ci"), Type.Literal("review")]), enabled: Type.Boolean() });
const Schedules = Type.Object({ eventOptIn: Type.Boolean(), automaticAdmissionBlocker: Type.Union([Type.Null(), Type.Literal("uncertain-provider-write"), Type.Literal("uncertain-command")]), schedules: Type.Array(Schedule), historyIncluded: Type.Literal(false), historyCounts: Type.Object({ events: Type.Integer({ minimum: 0 }), intents: Type.Integer({ minimum: 0 }) }), events: Type.Array(Type.Unknown(), { maxItems: 0 }), intents: Type.Array(Type.Unknown(), { maxItems: 0 }) });
const Monitors = Type.Object({ items: Type.Array(Monitor) });
const Plan = Type.Object({ paused: Type.Boolean(), pausing: Type.Boolean() });
const Range = Type.Object({ offset: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }), total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) });
const historyHeader = { offset: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1, maximum: 100 }), total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]), observedAtMs: Type.Number() };
const History = Type.Union([
  Type.Object({ ...historyHeader, kind: Type.Literal("events"), items: Type.Array(Type.Object({ eventId: Type.String(), projectId: Id, kind: Type.String(), payload: Type.String(), requestId: Type.String(), payloadRange: Range }), { maxItems: 30 }) }),
  Type.Object({ ...historyHeader, kind: Type.Literal("intents"), items: Type.Array(Type.Object({ requestId: Type.String(), stableId: Type.String(), kind: Type.Union([Type.Literal("schedule"), Type.Literal("event")]), status: Type.Union([Type.Literal("recorded"), Type.Literal("submitted"), Type.Literal("interrupted"), Type.Literal("uncertain"), Type.Literal("failed")]), submissionId: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]), text: Type.String(), textRange: Range, outcome: Type.Union([Type.Null(), Type.String()]), outcomeRange: Type.Union([Type.Null(), Range]) }), { maxItems: 30 }) }),
]);
function validateRange(text: string, range: Static<typeof Range>, requested: number) {
  if (range.offset !== Math.min(requested, range.total) || range.end < range.offset || range.end > range.total || range.end - range.offset !== Array.from(text).length || range.end - range.offset > 4000 || range.nextOffset !== (range.end < range.total ? range.end : null)) throw new Error("Routine history text range differs from its excerpt");
}
function nextTextOffset(page: Static<typeof History>): number | null {
  const offsets = page.kind === "events" ? page.items.flatMap(item => item.payloadRange.nextOffset === null ? [] : [item.payloadRange.nextOffset]) : page.items.flatMap(item => [item.textRange.nextOffset, item.outcomeRange?.nextOffset ?? null].flatMap(offset => offset === null ? [] : [offset]));
  return offsets.length ? Math.min(...offsets) : null;
}
type Schedule = Static<typeof Schedule>;
type Monitor = Static<typeof Monitor>;
type Snapshot = { schedules: Static<typeof Schedules>; monitors: Static<typeof Monitors>; plan: Static<typeof Plan> };
type Change = { kind: "schedule"; record: Schedule; enabled: boolean } | { kind: "monitor"; record: Monitor; enabled: boolean } | { kind: "events"; enabled: boolean };
type Mode = { kind: "choose"; list: SelectList }
  | { kind: "list"; lens: "schedules" | "monitors"; offset: number; list: SelectList }
  | { kind: "read"; lens: "schedules" | "monitors"; offset: number; change: Exclude<Change, { kind: "events" }>; scroll: ScrollView }
  | { kind: "history"; page: Static<typeof History>; textOffset: number; scroll: ScrollView }
  | { kind: "confirm"; change: Change; list: SelectList; scroll: ScrollView; focus: "choices" | "details" };

export class RoutinesScreen implements Component, Focusable {
  focused = false;
  private mode: Mode;
  private snapshot: Snapshot | null = null;
  private busy = false;
  private closed = false;
  private notice = "Retained definitions and receipts, not execution proof. Creation is available through the stable-ID CLI.";
  constructor(private input: { project: Project; keys: KeybindingsManager; theme: SelectListTheme; height: () => number; paint: () => void; exit: () => void }) {
    this.mode = { kind: "choose", list: this.list([]) };
    void this.act(() => this.load());
  }
  dispose() { this.closed = true; }
  invalidate() {
    const mode = this.mode;
    if (mode.kind === "choose" || mode.kind === "list") mode.list.invalidate();
    else { mode.scroll.invalidate(); if (mode.kind === "confirm") mode.list.invalidate(); }
  }
  render(width: number): string[] {
    const height = Math.max(1, this.input.height()), mode = this.mode, snapshot = this.snapshot;
    const policy = snapshot ? `Plan ${snapshot.plan.paused || snapshot.plan.pausing ? "paused/draining" : "open"} · events ${snapshot.schedules.eventOptIn ? "opted in" : "off"} · automatic blocker ${snapshot.schedules.automaticAdmissionBlocker ?? "none recorded"}` : "Loading retained routine state";
    let body: string[];
    if (mode.kind === "choose" || mode.kind === "list") {
      const total = mode.kind === "list" ? this.records(mode.lens).length : 0;
      body = [mode.kind === "list" ? `Cached ${mode.lens} ${Math.min(mode.offset + 1, total)}-${Math.min(mode.offset + 100, total)}/${total} · [ / ] page · r reread` : "Enter inspect · r reread · Esc close", ...mode.list.render(width)];
    } else if (mode.kind === "confirm") {
      const choices = mode.list.render(width), room = Math.max(1, height - choices.length - 4), content = mode.scroll.render(width);
      mode.scroll.updateLayout(content.length, room, this.input.paint);
      body = [...content.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room), `Tab: ${mode.focus === "choices" ? "scroll definition" : "select choices"}`, ...choices];
    } else {
      const content = mode.scroll.render(width), room = Math.max(1, height - 4);
      mode.scroll.updateLayout(content.length, room, this.input.paint);
      body = [mode.kind === "read" ? "e explicitly confirm toggle · Esc cached list" : `Sampled ${mode.page.kind} ${mode.page.offset}-${mode.page.offset + mode.page.items.length}/${mode.page.total} · [ / ] records · { / } text · v events · t intents · r reread · Esc menu`, ...content.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room)];
    }
    return [clean(policy), ...body, clean(this.busy ? "Waiting for owned state/confirmed change. Esc closes; no automatic retry." : this.notice)].slice(0, height);
  }
  handleInput(data: string) {
    if (this.closed) return;
    const mode = this.mode;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      if (this.busy || mode.kind === "choose") { this.dispose(); this.input.exit(); }
      else if (mode.kind === "read") this.browse(mode.lens, mode.offset);
      else this.choose();
      this.input.paint(); return;
    }
    if (this.busy) return;
    if (mode.kind === "choose" || mode.kind === "list") {
      if (data === "r") void this.act(() => this.load());
      else if (mode.kind === "list" && (data === "[" || data === "]")) this.browse(mode.lens, data === "[" ? Math.max(0, mode.offset - 100) : Math.min(Math.max(0, Math.floor((this.records(mode.lens).length - 1) / 100) * 100), mode.offset + 100));
      else mode.list.handleInput(data);
    } else if (mode.kind === "history") {
      const page = mode.page;
      if (data === "[") void this.act(() => this.history(page.kind, Math.max(0, page.offset - 30), 0));
      else if (data === "]" && page.nextOffset !== null) void this.act(() => this.history(page.kind, page.nextOffset ?? page.offset, 0));
      else if (data === "{") void this.act(() => this.history(page.kind, page.offset, Math.max(0, mode.textOffset - 4000)));
      else if (data === "}") { const next = nextTextOffset(page); if (next !== null) void this.act(() => this.history(page.kind, page.offset, next)); }
      else if (data === "v" || data === "t") void this.act(() => this.history(data === "v" ? "events" : "intents", 0, 0));
      else if (data === "r") void this.act(() => this.history(page.kind, page.offset, mode.textOffset));
      else this.scroll(mode.scroll, data);
    } else if (mode.kind === "read" && data === "e") this.confirm(mode.change);
    else if (mode.kind === "confirm") {
      if (matchesKey(data, "tab")) mode.focus = mode.focus === "choices" ? "details" : "choices";
      else if (mode.focus === "choices") mode.list.handleInput(data);
      else this.scroll(mode.scroll, data);
    } else this.scroll(mode.scroll, data);
    this.input.paint();
  }
  private list(options: { value: string; label: string }[]) { return new SelectList(options, Math.max(2, Math.min(12, this.input.height() - 4)), this.input.theme); }
  private records(lens: "schedules" | "monitors") { return lens === "schedules" ? this.snapshot?.schedules.schedules ?? [] : this.snapshot?.monitors.items ?? []; }
  private async load() {
    const id = this.input.project.id;
    const [schedules, monitors, plan] = await Promise.all([request({ action: "schedule-snapshot", id, includeHistory: false }, false), request({ action: "monitor-snapshot", id }, false), request({ action: "plan-snapshot", id }, false)]);
    const snapshot = { schedules: parse(Schedules, schedules), monitors: parse(Monitors, monitors), plan: parse(Plan, plan) };
    if (snapshot.schedules.schedules.some(record => record.projectId !== id)) throw new Error("Routine snapshot contains another project's schedule");
    if (this.closed) return;
    this.snapshot = snapshot; this.choose();
  }
  private choose() {
    const snapshot = this.snapshot;
    const list = this.list([{ value: "schedules", label: `Schedules (${snapshot?.schedules.schedules.length ?? 0})` }, { value: "monitors", label: `GitHub monitors (${snapshot?.monitors.items.length ?? 0}); Arc deferred` }, { value: "history", label: `Paged history (${snapshot?.schedules.historyCounts.events ?? 0} events, ${snapshot?.schedules.historyCounts.intents ?? 0} intents)` }, { value: "events", label: `${snapshot?.schedules.eventOptIn ? "Disable" : "Enable"} event opt-in, separately confirmed` }]);
    list.onSelect = item => {
      if (!snapshot) return;
      if (item.value === "schedules" || item.value === "monitors") this.browse(item.value, 0);
      else if (item.value === "events") this.confirm({ kind: "events", enabled: !snapshot.schedules.eventOptIn });
      else void this.act(() => this.history("intents", 0, 0));
      this.input.paint();
    };
    this.mode = { kind: "choose", list };
  }
  private async history(kind: "events" | "intents", offset: number, textOffset: number) {
    const page = parse(History, await request({ action: "schedule-history", id: this.input.project.id, kind, offset, limit: 30, textOffset, textLimit: 4000 }, false));
    if (page.kind !== kind || page.offset !== offset || page.limit !== 30 || page.nextOffset !== null && !page.items.length || page.nextOffset !== (offset + page.items.length < page.total ? offset + page.items.length : null) || page.items.length > Math.max(0, page.total - offset)) throw new Error("Routine history differs from its owned page");
    if (page.kind === "events") for (const item of page.items) {
      if (item.projectId !== this.input.project.id) throw new Error("Event history belongs to another project");
      validateRange(item.payload, item.payloadRange, textOffset);
    } else for (const item of page.items) {
      validateRange(item.text, item.textRange, textOffset);
      if (item.outcome === null ? item.outcomeRange !== null : item.outcomeRange === null) throw new Error("Intent outcome excerpt/range mismatch");
      if (item.outcome !== null && item.outcomeRange !== null) validateRange(item.outcome, item.outcomeRange, textOffset);
    }
    if (this.closed) return;
    this.mode = { kind: "history", page, textOffset, scroll: new ScrollView(new Text(clean(`Live sampled page; no replay, current provider guarantee or execution proof. Full-text hashes identify recorded text, not effects.\n${JSON.stringify(page, null, 2)}`), 0, 0)) };
  }
  private browse(lens: "schedules" | "monitors", offset: number) {
    const snapshot = this.snapshot; if (!snapshot) return;
    const records = this.records(lens).slice(offset, offset + 100);
    const list = this.list(records.map(record => ({ value: record.id, label: clean(`${record.enabled ? "enabled" : "disabled"} · ${record.kind} · ${record.id}`).replaceAll("\n", " ") })));
    list.onSelect = item => {
      const schedule = lens === "schedules" ? snapshot.schedules.schedules.find(record => record.id === item.value) : undefined;
      const monitor = lens === "monitors" ? snapshot.monitors.items.find(record => record.id === item.value) : undefined;
      const change: Exclude<Change, { kind: "events" }> | null = schedule ? { kind: "schedule", record: schedule, enabled: !schedule.enabled } : monitor ? { kind: "monitor", record: monitor, enabled: !monitor.enabled } : null;
      if (!change) return;
      this.mode = { kind: "read", lens, offset, change, scroll: new ScrollView(new Text(clean(JSON.stringify(change.record, null, 2)), 0, 0)) }; this.input.paint();
    };
    this.mode = { kind: "list", lens, offset, list };
  }
  private confirm(change: Change) {
    const list = this.list([{ value: "cancel", label: "Cancel, no change" }, { value: "confirm", label: `Confirm ${change.enabled ? "enable" : "disable"} ${change.kind}` }]);
    const detail = `Project ${this.input.project.id}\n${JSON.stringify(change, null, 2)}\nEnabling can permit future authorized work/polling while the Mac is awake. It does not resume, grant tools/publication, clear uncertain effects or replay retained intents. Monitors need separate event opt-in and current repository authorization. Disabling retains ticks/cursors.\nNo schedule/monitor is created here. Definitions created through CLI start disabled.`;
    list.onSelect = item => {
      if (item.value !== "confirm") { this.choose(); this.input.paint(); return; }
      void this.act(async () => {
        let input: Request;
        switch (change.kind) {
          case "schedule": input = { action: "schedule-enable", id: this.input.project.id, scheduleId: change.record.id, enabled: change.enabled }; break;
          case "monitor": input = { action: "monitor-enable", id: this.input.project.id, monitorId: change.record.id, enabled: change.enabled }; break;
          case "events": input = { action: "event-opt-in", id: this.input.project.id, enabled: change.enabled }; break;
          default: { const exhaustive: never = change; throw new Error(`Unknown routine change ${exhaustive}`); }
        }
        await request(input, false);
        this.notice = "Confirmed setting recorded. No execution outcome inferred.";
        if (!this.closed) await this.load();
      });
    };
    this.mode = { kind: "confirm", change, list, scroll: new ScrollView(new Text(clean(detail), 0, 0)), focus: "choices" };
  }
  private scroll(scroll: ScrollView, data: string) {
    if (matchesKey(data, "up") || data === "k") scroll.scrollTo(scroll.scrollTop - 1);
    else if (matchesKey(data, "down") || data === "j") scroll.scrollTo(scroll.scrollTop + 1);
    else if (matchesKey(data, "pageUp")) scroll.scrollTo(scroll.scrollTop - Math.max(1, this.input.height() - 4));
    else if (matchesKey(data, "pageDown")) scroll.scrollTo(scroll.scrollTop + Math.max(1, this.input.height() - 4));
  }
  private async act(operation: () => Promise<void>) {
    if (this.closed || this.busy) return;
    this.busy = true; this.input.paint();
    try { await operation(); } catch (error) { if (!this.closed) this.notice = firstLine(errorText(error)); }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
}
