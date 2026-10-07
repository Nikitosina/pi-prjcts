import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, Editor, ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { request } from "./client.ts";
import { clean, firstLine } from "./project-items.ts";
import { errorText, parse, type Request } from "./state.ts";

const Settings = Type.Object({ revision: Type.String({ pattern: "^[a-f0-9]{64}$" }), values: Type.Object({
  name: Type.String(), objective: Type.String(), model: Type.String(), models: Type.Object({ worker: Type.String(), scout: Type.String(), reviewer: Type.String() }),
  knowledgeAccess: Type.Union([Type.Literal("read-only"), Type.Literal("maintain")]), libraryAccess: Type.Union([Type.Literal("none"), Type.Literal("coordinator")]), decisionAccess: Type.Union([Type.Literal("none"), Type.Literal("coordinator")]), workerCap: Type.Integer({ minimum: 1, maximum: 32 }),
}) });
const Models = Type.Object({ items: Type.Array(Type.Object({ reference: Type.String(), name: Type.String(), configured: Type.Boolean() })), offset: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), total: Type.Integer(), networkChecked: Type.Literal(false) });
type Settings = Static<typeof Settings>;
type Models = Static<typeof Models>;
type Changes = Extract<Request, { action: "settings-update" }>["changes"];
type Role = "coordinator" | "worker" | "scout" | "reviewer";
export type SettingsDraft = { text: string; expectedRevision: string };
type Mode = { kind: "list" | "choices"; list: SelectList }
  | { kind: "editor"; field: "name" | "objective"; editor: Editor; key: string }
  | { kind: "models"; role: Role; base: Settings; page: Models; list: SelectList }
  | { kind: "conflicted-draft"; list: SelectList; scroll: ScrollView; focus: "choices" | "details" }
  | { kind: "confirm"; changes: Changes; revision: string; list: SelectList; scroll: ScrollView; focus: "choices" | "details"; draftKey: string | null };

export class SettingsScreen implements Component, Focusable {
  private mode: Mode;
  private settings: Settings | null = null;
  private busy = false;
  private closed = false;
  private hasFocus = false;
  private notice = "Confirmed changes require an idle Durable project. Existing threads keep frozen models/instructions.";
  constructor(private input: { projectId: string; tui: TUI; keys: KeybindingsManager; theme: SelectListTheme; borderColor: (text: string) => string; drafts: Map<string, SettingsDraft>; height: () => number; paint: () => void; exit: () => void }) {
    this.mode = { kind: "list", list: this.list([]) };
    void this.act(() => this.reload());
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; if (this.mode.kind === "editor") this.mode.editor.focused = value; }
  invalidate() {
    if (this.mode.kind === "editor") this.mode.editor.invalidate();
    else { this.mode.list.invalidate(); if (this.mode.kind === "confirm" || this.mode.kind === "conflicted-draft") this.mode.scroll.invalidate(); }
  }
  dispose() { this.remember(); this.closed = true; if (this.mode.kind === "editor") this.mode.editor.focused = false; }
  render(width: number): string[] {
    const height = Math.max(1, this.input.height()), mode = this.mode;
    let body: string[];
    if (mode.kind === "editor") {
      const lines = mode.editor.render(width), room = Math.max(1, height - 4), cursor = lines.findIndex(line => line.includes(CURSOR_MARKER)), start = Math.max(0, cursor - room + 1);
      body = [`Edit ${mode.field} · Enter reviews change · Esc keeps draft`, `Expected revision ${this.input.drafts.get(mode.key)?.expectedRevision ?? "missing"}`, "Empty objective allowed. Shift+Enter adds a line.", ...lines.slice(start, start + room)];
    } else if (mode.kind === "confirm" || mode.kind === "conflicted-draft") {
      const choices = mode.list.render(width), room = Math.max(1, height - choices.length - 3), lines = mode.scroll.render(width);
      mode.scroll.updateLayout(lines.length, room, this.input.paint);
      body = [...lines.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room), `Tab: ${mode.focus === "choices" ? "scroll exact change" : "select choices"}`, ...choices];
    } else body = [mode.kind === "models" ? `Models ${mode.page.offset + (mode.page.items.length ? 1 : 0)}-${mode.page.offset + mode.page.items.length}/${mode.page.total} · [ / ] pages` : "Project settings · r reread · Esc back", ...mode.list.render(width)];
    return [...body.slice(0, Math.max(0, height - 1)), clean(this.busy ? "Waiting for settings host… Esc closes this panel." : this.notice)];
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      this.remember();
      if (this.busy || this.mode.kind === "list") { this.dispose(); this.input.exit(); }
      else { if (this.mode.kind === "editor") this.mode.editor.focused = false; this.menu(); }
      this.input.paint(); return;
    }
    if (this.busy) return;
    const mode = this.mode;
    if (mode.kind === "editor") { mode.editor.handleInput(data); this.remember(); }
    else if (mode.kind === "confirm" || mode.kind === "conflicted-draft") {
      if (matchesKey(data, "tab")) mode.focus = mode.focus === "choices" ? "details" : "choices";
      else if (mode.focus === "choices") mode.list.handleInput(data);
      else this.scroll(mode.scroll, data);
    } else if (data === "r") void this.act(() => this.reload());
    else if (mode.kind === "models" && data === "[") void this.act(() => this.models(mode.role, mode.base, Math.max(0, mode.page.offset - 100)));
    else if (mode.kind === "models" && data === "]" && mode.page.nextOffset !== null) void this.act(() => this.models(mode.role, mode.base, mode.page.nextOffset ?? mode.page.offset));
    else mode.list.handleInput(data);
    this.input.paint();
  }
  private list(options: { value: string; label: string }[]) { return new SelectList(options, Math.max(2, Math.min(12, this.input.height() - 3)), this.input.theme); }
  private remember() {
    if (this.mode.kind !== "editor") return;
    const draft = this.input.drafts.get(this.mode.key);
    if (draft) draft.text = this.mode.editor.getExpandedText();
  }
  private async reload() {
    const settings = parse(Settings, await request({ action: "settings-snapshot", id: this.input.projectId }, false));
    if (!this.closed) { this.settings = settings; this.menu(); }
  }
  private menu() {
    const base = this.settings;
    if (!base) return;
    const values = base.values;
    const list = this.list([
      { value: "name", label: `Name: ${firstLine(values.name)}` }, { value: "objective", label: `Objective: ${firstLine(values.objective)}` },
      ...(["coordinator", "worker", "scout", "reviewer"] satisfies Role[]).map(role => ({ value: role, label: clean(`${role} model: ${role === "coordinator" ? values.model : values.models[role]}`).replaceAll("\n", " ") })),
      { value: "knowledge", label: `Worker knowledge access: ${values.knowledgeAccess}` }, { value: "library", label: `Agent library access: ${values.libraryAccess}` }, { value: "questions", label: `Coordinator questions: ${values.decisionAccess}` }, { value: "cap", label: `Hard worker cap: ${values.workerCap}` },
    ]);
    list.onSelect = item => {
      switch (item.value) {
        case "name": case "objective": this.edit(item.value, base); break;
        case "coordinator": case "worker": case "scout": case "reviewer": { const role = item.value; void this.act(() => this.models(role, base, 0)); break; }
        case "knowledge": this.choices(["read-only", "maintain"], value => { if (value === "read-only" || value === "maintain") this.confirm({ knowledgeAccess: value }, base.revision); }); break;
        case "library": this.choices(["none", "coordinator"], value => { if (value === "none" || value === "coordinator") this.confirm({ libraryAccess: value }, base.revision); }); break;
        case "questions": this.choices(["none", "coordinator"], value => { if (value === "none" || value === "coordinator") this.confirm({ decisionAccess: value }, base.revision); }); break;
        case "cap": this.choices(Array.from({ length: 32 }, (_, i) => String(i + 1)), value => this.confirm({ workerCap: Number(value) }, base.revision)); break;
      }
      this.input.paint();
    };
    this.mode = { kind: "list", list };
  }
  private choices(values: string[], select: (value: string) => void) {
    const list = this.list(values.map(value => ({ value, label: value })));
    list.onSelect = item => select(item.value);
    this.mode = { kind: "choices", list };
  }
  private edit(field: "name" | "objective", base: Settings, keepOldRevision = false) {
    const key = `${this.input.projectId}:${field}`, draft = this.input.drafts.get(key) ?? { text: base.values[field], expectedRevision: base.revision };
    if (draft.expectedRevision !== base.revision && !keepOldRevision) {
      const list = this.list([{ value: "cancel", label: "Cancel, keep draft unchanged" }, { value: "keep", label: "Edit retained draft with its original revision" }, { value: "discard", label: "Discard draft and edit inspected current text" }]);
      list.onSelect = item => {
        if (item.value === "discard") { this.input.drafts.delete(key); this.edit(field, base, true); }
        else if (item.value === "keep") this.edit(field, base, true);
        else this.menu();
        this.input.paint();
      };
      this.mode = { kind: "conflicted-draft", list, focus: "choices", scroll: new ScrollView(new Text(clean(`Project ${this.input.projectId}\nField ${field}\n\nCurrent inspected revision ${base.revision}\n${base.values[field]}\n\nRetained draft, expected revision ${draft.expectedRevision}\n${draft.text}\n\nNo automatic rebase or overwrite. Discard only affects this local draft.`), 0, 0), { scrollbar: "hidden" }) };
      return;
    }
    if (stripVTControlCharacters(draft.text) !== draft.text || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(draft.text)) { this.notice = "Control-bearing initial settings are read-only here. Use the explicit settings API to repair them."; return; }
    this.input.drafts.set(key, draft);
    const editor = new Editor(this.input.tui, { borderColor: this.input.borderColor, selectList: this.input.theme }, { paddingX: 1 });
    editor.setText(draft.text); editor.focused = this.hasFocus;
    editor.onSubmit = text => { draft.text = text; editor.focused = false; this.confirm(field === "name" ? { name: text } : { objective: text }, draft.expectedRevision, key); this.input.paint(); };
    this.mode = { kind: "editor", field, editor, key };
    this.notice = draft.expectedRevision !== base.revision ? "Retained draft has an older revision. Save still uses that revision; no automatic rebase. Cancel/r rereads without losing it." : "Review the exact change before saving.";
  }
  private async models(role: Role, base: Settings, offset: number) {
    const page = parse(Models, await request({ action: "models-snapshot", offset, limit: 100 }, false));
    if (page.offset !== offset || page.items.length > 100 || page.nextOffset !== null && page.nextOffset !== offset + page.items.length) throw new Error("Invalid model catalog continuation");
    if (this.closed) return;
    const list = this.list(page.items.map(model => ({ value: model.reference, label: clean(`${model.reference} · ${model.configured ? "credentials configured" : "credentials missing"}`).replaceAll("\n", " ") })));
    list.onSelect = item => {
      const model = page.items.find(model => model.reference === item.value);
      if (!model?.configured) { this.notice = "This catalog entry lacks configured credentials. No model request was made."; this.input.paint(); return; }
      const changes: Changes = role === "coordinator" ? { model: model.reference } : { models: role === "worker" ? { worker: model.reference } : role === "scout" ? { scout: model.reference } : { reviewer: model.reference } };
      this.confirm(changes, base.revision); this.input.paint();
    };
    this.mode = { kind: "models", role, base, page, list };
    this.notice = "Offline installed metadata only. Credentials/network are not tested. Existing threads retain their frozen model.";
  }
  private confirm(changes: Changes, revision: string, draftKey: string | null = null) {
    const list = this.list([{ value: "cancel", label: "Cancel, retain drafts and settings" }, { value: "save", label: "Save exact revision-checked change" }]);
    const scroll = new ScrollView(new Text(clean(`Project ${this.input.projectId}\nExpected revision ${revision}\n\n${JSON.stringify(changes, null, 2)}\n\nModel/name/objective defaults do not rewrite frozen threads. Tool/knowledge access changes remain subject to host compatibility and idle checks. No shell, provider publication or model request is authorized by this setting change.`), 0, 0), { scrollbar: "hidden" });
    list.onSelect = item => {
      if (item.value === "cancel") { this.menu(); this.input.paint(); return; }
      void this.act(async () => {
        const saved = parse(Settings, await request({ action: "settings-update", id: this.input.projectId, confirm: this.input.projectId, expectedRevision: revision, changes }, false));
        if (draftKey) {
          const draft = this.input.drafts.get(draftKey);
          if (draft && draft.expectedRevision === revision && draft.text === (changes.name ?? changes.objective)) this.input.drafts.delete(draftKey);
        }
        if (!this.closed) { this.settings = saved; this.menu(); this.notice = "Revision-checked settings change recorded. Existing threads were not rewritten."; }
      });
    };
    this.mode = { kind: "confirm", changes, revision, list, scroll, focus: "choices", draftKey };
  }
  private scroll(scroll: ScrollView, data: string) {
    if (matchesKey(data, "up") || data === "k") scroll.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) scroll.scrollBy(-Math.max(1, this.input.height() - 4));
    else if (matchesKey(data, "pageDown")) scroll.scrollBy(Math.max(1, this.input.height() - 4));
    else if (matchesKey(data, "home")) scroll.scrollToStart();
    else if (matchesKey(data, "end")) scroll.scrollToEnd();
  }
  private async act(action: () => Promise<void>) {
    if (this.busy || this.closed) return;
    this.busy = true; this.input.paint();
    try { await action(); }
    catch (error) { if (!this.closed) this.notice = `Settings action failed: ${errorText(error)}. Draft retained; no automatic replay or rebase.`; }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
}
