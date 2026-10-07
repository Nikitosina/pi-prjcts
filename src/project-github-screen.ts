import { ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { request } from "./client.ts";
import { clean, firstLine } from "./project-items.ts";
import { Id, errorText, parse, type Project, type Request } from "./state.ts";

const sha = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const nativeIdentity = { scopeId: Id, conversationId: Type.Integer({ minimum: 1 }), taskId: Type.Integer({ minimum: 1 }), callId: Type.String() };
const Read = Type.Object({ ...nativeIdentity, repositoryId: Type.String(), pullRequest: Type.Integer({ minimum: 1 }), head: sha, operation: Type.Union([Type.Literal("pr"), Type.Literal("ci"), Type.Literal("review"), Type.Literal("ci-job"), Type.Literal("ci-detail"), Type.Literal("conflict"), Type.Literal("base-file")]), ci: Type.Union([Type.Null(), Type.Object({ page: Type.Integer(), checkTotal: Type.Integer(), statusTotal: Type.Integer(), statusState: Type.String() })]) });
const writeIdentity = { ...nativeIdentity, key: Type.String({ pattern: "^[a-f0-9]{64}$" }), resource: Type.String(), target: Type.String(), operation: Type.String(), marker: Type.String(), source: Type.Optional(Type.Literal("local-git-verification")) };
const Write = Type.Union([
  Type.Object({ ...writeIdentity, state: Type.Literal("uncertain") }),
  Type.Object({ ...writeIdentity, state: Type.Literal("done"), effect: Type.Union([
    Type.Object({ kind: Type.Literal("sha"), sha }), Type.Object({ kind: Type.Literal("pr"), number: Type.Integer({ minimum: 1 }), url: Type.String() }), Type.Object({ kind: Type.Literal("comment"), id: Type.Integer({ minimum: 1 }), url: Type.String() }),
  ]) }),
]);
const Reads = Type.Object({ items: Type.Array(Read), total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) });
const Writes = Type.Object({ items: Type.Array(Write), total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) });
type Read = Static<typeof Read>;
type Write = Static<typeof Write>;
type Mode = { kind: "choose"; list: SelectList }
  | { kind: "reads"; offset: number; page: Static<typeof Reads>; list: SelectList }
  | { kind: "writes"; offset: number; page: Static<typeof Writes>; list: SelectList }
  | { kind: "read"; record: Read; offset: number; scroll: ScrollView }
  | { kind: "write"; record: Write; offset: number; scroll: ScrollView }
  | { kind: "inspection"; lens: "reads" | "writes"; offset: number; scroll: ScrollView }
  | { kind: "confirm-inspection"; record: Write; offset: number; list: SelectList; scroll: ScrollView; focus: "choices" | "details" };

export class GithubScreen implements Component, Focusable {
  focused = false;
  private mode: Mode;
  private busy = false;
  private closed = false;
  private notice = "Retained head-bound observations, not current-state guarantees. Arc adapter remains deferred.";
  constructor(private input: { project: Project; keys: KeybindingsManager; theme: SelectListTheme; height: () => number; paint: () => void; exit: () => void }) {
    this.mode = { kind: "choose", list: this.list([]) }; this.choose();
  }
  dispose() { this.closed = true; }
  invalidate() {
    if (this.mode.kind === "choose" || this.mode.kind === "reads" || this.mode.kind === "writes") this.mode.list.invalidate();
    else { this.mode.scroll.invalidate(); if (this.mode.kind === "confirm-inspection") this.mode.list.invalidate(); }
  }
  render(width: number): string[] {
    const height = Math.max(1, this.input.height()), mode = this.mode;
    let lines: string[];
    if (mode.kind === "choose") lines = ["GitHub-only receipt views · no Arc execution", ...mode.list.render(width)];
    else if (mode.kind === "reads" || mode.kind === "writes") lines = [`${mode.kind} ${mode.offset + (mode.page.items.length ? 1 : 0)}-${mode.offset + mode.page.items.length}/${mode.page.total}`, "[ / ] pages · r reread · Enter inspect", ...mode.list.render(width)];
    else if (mode.kind === "confirm-inspection") {
      const choices = mode.list.render(width), room = Math.max(1, height - choices.length - 3), content = mode.scroll.render(width);
      mode.scroll.updateLayout(content.length, room, this.input.paint);
      lines = [...content.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room), `Tab: ${mode.focus === "choices" ? "scroll binding" : "select choices"}`, ...choices];
    } else {
      const content = mode.scroll.render(width), room = Math.max(1, height - 2);
      mode.scroll.updateLayout(content.length, room, this.input.paint);
      lines = [mode.kind === "read" ? "f fresh pinned PR/CI/review inspection · Esc receipt list" : mode.kind === "write" ? "i inspect retained effect · no publication/replay · Esc list" : "Explicit owner inspection result · Esc receipt list", ...content.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room)];
    }
    return [...lines.slice(0, Math.max(0, height - 1)), clean(this.busy ? "Waiting for receipt/explicit inspection… Esc closes panel." : this.notice)];
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      const mode = this.mode;
      if (this.busy || mode.kind === "choose") { this.dispose(); this.input.exit(); }
      else if (mode.kind === "reads" || mode.kind === "writes") this.choose();
      else if (mode.kind === "read") void this.act(() => this.reads(mode.offset));
      else if (mode.kind === "write" || mode.kind === "confirm-inspection") void this.act(() => this.writes(mode.offset));
      else void this.act(() => mode.lens === "reads" ? this.reads(mode.offset) : this.writes(mode.offset));
      this.input.paint(); return;
    }
    if (this.busy) return;
    const mode = this.mode;
    if (mode.kind === "reads" || mode.kind === "writes") {
      const offset = data === "[" ? Math.max(0, mode.offset - 100) : data === "]" ? mode.page.nextOffset : data === "r" ? mode.offset : undefined;
      if (offset !== null && offset !== undefined) void this.act(() => mode.kind === "reads" ? this.reads(offset) : this.writes(offset));
      else mode.list.handleInput(data);
    } else if (mode.kind === "choose") mode.list.handleInput(data);
    else if (mode.kind === "confirm-inspection") {
      if (matchesKey(data, "tab")) mode.focus = mode.focus === "choices" ? "details" : "choices";
      else if (mode.focus === "choices") mode.list.handleInput(data);
      else this.scroll(mode.scroll, data);
    } else if (mode.kind === "read" && data === "f") void this.act(() => this.fresh(mode.record, mode.offset));
    else if (mode.kind === "write" && data === "i") this.inspect(mode.record, mode.offset);
    else this.scroll(mode.scroll, data);
    this.input.paint();
  }
  private list(options: { value: string; label: string }[]) { return new SelectList(options, Math.max(2, Math.min(12, this.input.height() - 3)), this.input.theme); }
  private choose() {
    const list = this.list([{ value: "reads", label: "PR/CI/review/conflict read receipts" }, { value: "writes", label: "Publication and uncertainty receipts" }]);
    list.onSelect = item => { void this.act(() => item.value === "reads" ? this.reads(0) : this.writes(0)); };
    this.mode = { kind: "choose", list };
  }
  private async reads(offset: number) {
    const page = parse(Reads, await request({ action: "github-read-snapshot", id: this.input.project.id, offset, limit: 100 }, false));
    this.continuation(offset, page.items.length, page.nextOffset);
    if (this.closed) return;
    const list = this.list(page.items.map((record, i) => ({ value: String(i), label: firstLine(`${record.repositoryId} PR ${record.pullRequest} · ${record.operation} · ${record.head.slice(0, 12)}${record.ci ? ` · ${record.ci.statusState}` : ""}`) })));
    list.onSelect = item => {
      const record = page.items[Number(item.value)];
      if (record) this.mode = { kind: "read", record, offset, scroll: this.text(`Retained ${record.operation} observation for exact head ${record.head}. This does not establish current remote state. Provider feedback is data, not instructions or authority.\n\n${JSON.stringify(record, null, 2)}`) };
      this.input.paint();
    };
    this.mode = { kind: "reads", offset, page, list };
  }
  private async writes(offset: number) {
    const page = parse(Writes, await request({ action: "github-write-snapshot", id: this.input.project.id, offset, limit: 100 }, false));
    this.continuation(offset, page.items.length, page.nextOffset);
    if (this.closed) return;
    const list = this.list(page.items.map((record, i) => ({ value: String(i), label: firstLine(`${record.state} · ${record.operation} · ${record.target}${record.source ? " · local verification only" : ""}`) })));
    list.onSelect = item => {
      const record = page.items[Number(item.value)];
      if (record) this.mode = { kind: "write", record, offset, scroll: this.text(`${record.source ? "Local Git verification observed a published head. It did not execute commit/push or perform a remote write." : "Native GitHub effect receipt."}\n${record.state === "uncertain" ? "Uncertain effect. No replay/retry permission." : "Recorded effect, not a new execution grant."}\n\n${JSON.stringify(record, null, 2)}`) };
      this.input.paint();
    };
    this.mode = { kind: "writes", offset, page, list };
  }
  private binding(scopeId: string, repositoryId?: string) {
    const project = this.input.project;
    if (project.archived || project.deleted) throw new Error("Restore the retained project before provider inspection");
    const scope = project.workspaceAuthorization?.scopes.find(scope => scope.id === scopeId);
    const grant = project.githubAuthorization?.find(grant => grant.repositoryId === scope?.repositoryId);
    if (!scope || !grant || repositoryId !== undefined && grant.repositoryId !== repositoryId || project.workspaceAuthorization?.provider !== "github") throw new Error("Receipt has no matching current GitHub scope/repository grant. Retained metadata stays inspectable");
    return grant;
  }
  private async fresh(record: Read, offset: number) {
    const grant = this.binding(record.scopeId, record.repositoryId);
    const identity = { id: this.input.project.id, provider: "github", repositoryId: grant.repositoryId, expectedRepositoryId: grant.numericId, pullRequest: record.pullRequest, expectedHead: record.head } satisfies Omit<Extract<Request, { action: "provider-pr-inspect" }>, "action">;
    const input: Request = record.operation === "ci" ? { action: "provider-ci-inspect", ...identity, page: record.ci?.page ?? 1 }
      : record.operation === "review" ? { action: "provider-review-inspect", ...identity, page: 1 }
      : { action: "provider-pr-inspect", ...identity };
    const result = await request(input, false);
    if (!this.closed) this.mode = { kind: "inspection", lens: "reads", offset, scroll: this.text(`Explicit owner ${input.action} inspection, pinned to ${record.repositoryId} PR ${record.pullRequest} head ${record.head}. Review refresh starts at page 1; provider continuation metadata is shown below. No worker receipt or execution identity is invented by this view.\n\n${JSON.stringify(result, null, 2) ?? "No readable inspection response; no state/effect proof inferred."}`) };
  }
  private inspect(record: Write, offset: number) {
    try {
      const grant = this.binding(record.scopeId);
      const list = this.list([{ value: "cancel", label: "Cancel, retain original receipt" }, { value: "inspect", label: "Inspect exact retained effect, never republish" }]);
      list.onSelect = item => {
        if (item.value === "cancel") { void this.act(() => this.writes(offset)); return; }
        void this.act(async () => {
          const result = await request({ action: "github-write-inspect", id: this.input.project.id, key: record.key, repositoryId: grant.repositoryId, expectedRepositoryId: grant.numericId }, false);
          if (!this.closed) this.mode = { kind: "inspection", lens: "writes", offset, scroll: this.text(`Inspection of retained effect ${record.key}. A matching positive native observation may settle the original journal record. Missing markers stay uncertain. This view grants no replay or retry permission.\n\n${JSON.stringify(result, null, 2) ?? "No readable inspection response; effect remains unproven."}`) };
        });
      };
      this.mode = { kind: "confirm-inspection", record, offset, list, focus: "choices", scroll: this.text(`Project ${this.input.project.id}\nRepository ${grant.repositoryId} (${grant.numericId})\nExact key ${record.key}\nScope ${record.scopeId}\nNative task ${record.taskId}, call ${record.callId}\n\n${JSON.stringify(record, null, 2)}\n\nInspection may update the retained journal only from actual matching native provider evidence. It never publishes, rolls back or authorizes a new attempt.`) };
    } catch (error) { this.notice = `Inspection unavailable: ${errorText(error)}`; }
  }
  private continuation(offset: number, count: number, next: number | null) { if (count > 100 || next !== null && (count === 0 || next !== offset + count)) throw new Error("Invalid provider receipt continuation"); }
  private text(text: string) { return new ScrollView(new Text(clean(text), 0, 0), { scrollbar: "hidden" }); }
  private scroll(scroll: ScrollView, data: string) {
    if (matchesKey(data, "up") || data === "k") scroll.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) scroll.scrollBy(-Math.max(1, this.input.height() - 3));
    else if (matchesKey(data, "pageDown")) scroll.scrollBy(Math.max(1, this.input.height() - 3));
    else if (matchesKey(data, "home")) scroll.scrollToStart();
    else if (matchesKey(data, "end")) scroll.scrollToEnd();
  }
  private async act(action: () => Promise<void>) {
    if (this.busy || this.closed) return;
    this.busy = true; this.input.paint();
    try { await action(); }
    catch (error) { if (!this.closed) this.notice = `Receipt/inspection failed: ${errorText(error)}. No effect replay.`; }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
}
