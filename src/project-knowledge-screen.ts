import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, Editor, ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { request } from "./client.ts";
import { KnowledgeDocument, KnowledgeMetadata, KnowledgePath, KnowledgeRevision } from "./knowledge-types.ts";
import { clean } from "./project-items.ts";
import { errorText, parse } from "./state.ts";

export type KnowledgeDraft = { text: string; expectedRevision: string | null };
type EditTarget = Pick<KnowledgeDocument, "path" | "text"> & { revision: string | null };
type Mode = { kind: "list"; list: SelectList }
  | { kind: "read"; document: KnowledgeDocument; scroll: ScrollView }
  | { kind: "edit"; target: EditTarget; editor: Editor; key: string }
  | { kind: "path"; editor: Editor }
  | { kind: "discard"; document: KnowledgeDocument; list: SelectList }
  | { kind: "history"; document: KnowledgeDocument; list: SelectList }
  | { kind: "revision"; document: KnowledgeDocument; scroll: ScrollView };

export class KnowledgeScreen implements Component, Focusable {
  private mode: Mode;
  private busy = false;
  private closed = false;
  private hasFocus = false;
  private notice = "Enter reads a document. Esc returns to Projects.";

  constructor(private input: { projectId: string; tui: TUI; keys: KeybindingsManager; theme: SelectListTheme; borderColor: (text: string) => string; drafts: Map<string, KnowledgeDraft>; pathDrafts: Map<string, string>; paint: () => void; exit: () => void; height: () => number }) {
    this.mode = { kind: "list", list: this.list([]) };
    void this.act(() => this.browse());
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; if (this.mode.kind === "edit" || this.mode.kind === "path") this.mode.editor.focused = value; }
  invalidate() {
    if (this.mode.kind === "edit" || this.mode.kind === "path") this.mode.editor.invalidate();
    else if (this.mode.kind === "read" || this.mode.kind === "revision") this.mode.scroll.invalidate();
    else this.mode.list.invalidate();
  }
  dispose() { this.remember(); this.closed = true; if (this.mode.kind === "edit" || this.mode.kind === "path") this.mode.editor.focused = false; }

  render(width: number): string[] {
    const height = Math.max(1, this.input.height());
    let body: string[];
    switch (this.mode.kind) {
      case "list": body = ["Project knowledge · n new topic · r refresh", ...this.mode.list.render(width)]; break;
      case "discard": body = ["Discard the retained draft? Current host text remains unchanged.", ...this.mode.list.render(width)]; break;
      case "history": body = ["Recorded revisions · Enter reads · Esc returns to current text", ...this.mode.list.render(width)]; break;
      case "path": {
        const lines = this.mode.editor.render(width), room = Math.max(1, height - 4), cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
        const start = Math.max(0, cursor - room + 1);
        body = ["New topic path · Enter composes body · Esc keeps path", "Example: research/topic.md or plans/next-step.md", "Only managed topic folders; existing files cannot be overwritten.", ...lines.slice(start, start + room)];
        break;
      }
      case "edit": {
        const draft = this.input.drafts.get(this.mode.key);
        const lines = this.mode.editor.render(width), allowance = Math.max(1, height - 5);
        const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
        const start = Math.max(0, cursor - allowance + 1);
        body = [clean(this.mode.target.path), `Expected revision ${draft ? draft.expectedRevision ?? "null, create only" : "missing"}`, `${[...this.mode.editor.getExpandedText()].length} Unicode characters${this.mode.target.path === "MEMORY.md" ? " / 3000 maximum" : ""}`, "Enter saves · Shift+Enter newline · Esc keeps draft", ...lines.slice(start, start + allowance)];
        break;
      }
      case "read":
      case "revision": {
        const scroll = this.mode.scroll, lines = scroll.render(width);
        scroll.updateLayout(lines.length, Math.max(1, height - 3), this.input.paint);
        body = [clean(this.mode.document.path), this.mode.kind === "read" ? "v edit retained/current text · d discard draft · h history · r reread" : "Historical text, read-only · Esc returns to current text", ...lines.slice(scroll.scrollTop, scroll.scrollTop + Math.max(1, height - 3))];
        break;
      }
    }
    return [...body.slice(0, Math.max(0, height - 1)), clean(this.busy ? "Waiting for knowledge host…" : this.notice)];
  }

  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      this.remember();
      if (this.busy || this.mode.kind === "list") { this.dispose(); this.input.exit(); return; }
      if (this.mode.kind === "edit") { this.mode.editor.focused = false; void this.act(() => this.browse()); }
      else if (this.mode.kind === "path") { this.mode.editor.focused = false; void this.act(() => this.browse()); }
      else if (this.mode.kind === "history" || this.mode.kind === "revision" || this.mode.kind === "discard") this.read(this.mode.document);
      else void this.act(() => this.browse());
      this.input.paint(); return;
    }
    if (this.busy) return;
    const mode = this.mode;
    if (mode.kind === "edit" || mode.kind === "path") { mode.editor.handleInput(data); this.remember(); }
    else if (mode.kind === "list") {
      if (data === "n") this.newPath();
      else if (data === "r") void this.act(() => this.browse());
      else mode.list.handleInput(data);
    } else if (mode.kind === "history" || mode.kind === "discard") mode.list.handleInput(data);
    else {
      if (mode.kind === "read" && data === "v") this.edit(mode.document);
      else if (mode.kind === "read" && data === "d") this.discard(mode.document);
      else if (mode.kind === "read" && data === "h") void this.act(() => this.history(mode.document));
      else if (mode.kind === "read" && data === "r") void this.act(() => this.open(mode.document.path));
      else if (matchesKey(data, "up") || data === "k") mode.scroll.scrollBy(-1);
      else if (matchesKey(data, "down") || data === "j") mode.scroll.scrollBy(1);
      else if (matchesKey(data, "pageUp")) mode.scroll.scrollBy(-Math.max(1, this.input.height() - 3));
      else if (matchesKey(data, "pageDown")) mode.scroll.scrollBy(Math.max(1, this.input.height() - 3));
      else if (matchesKey(data, "home")) mode.scroll.scrollToStart();
      else if (matchesKey(data, "end")) mode.scroll.scrollToEnd();
    }
    this.input.paint();
  }

  private list(options: { value: string; label: string }[]) { return new SelectList(options, Math.max(2, Math.min(12, this.input.height() - 4)), this.input.theme); }
  private key(path: string) { return `${this.input.projectId}:${path}`; }
  private remember() {
    if (this.mode.kind === "path") { this.input.pathDrafts.set(this.input.projectId, this.mode.editor.getExpandedText()); return; }
    if (this.mode.kind !== "edit") return;
    const draft = this.input.drafts.get(this.mode.key);
    if (draft) draft.text = this.mode.editor.getExpandedText();
  }
  private async browse() {
    const documents = parse(Type.Array(KnowledgeMetadata), await request({ action: "knowledge-list", id: this.input.projectId }, false));
    if (this.closed) return;
    const list = this.list(documents.map(doc => ({ value: doc.path, label: clean(`${doc.path} · ${doc.author} · ${doc.size} bytes`) })));
    list.onSelect = item => { void this.act(() => this.open(item.value)); };
    this.mode = { kind: "list", list };
  }
  private async open(path: string) {
    const doc = parse(KnowledgeDocument, await request({ action: "knowledge-read", id: this.input.projectId, path }, false));
    if (doc.path !== path) throw new Error("Knowledge response path changed");
    if (!this.closed) this.read(doc);
  }
  private read(document: KnowledgeDocument) {
    if (this.mode.kind === "edit") this.mode.editor.focused = false;
    const draft = this.input.drafts.get(this.key(document.path));
    const text = `Current revision ${document.revision}\n${document.author} · ${document.updatedAt}\n\n${document.text}${draft ? `\n\nRetained draft, expected revision ${draft.expectedRevision}\n${draft.text}\n\n${draft.expectedRevision !== document.revision ? "Revision changed. Saving this draft still uses its original revision. No silent rebase." : "Draft has not been saved."}` : ""}`;
    this.mode = { kind: "read", document, scroll: new ScrollView(new Text(clean(text), 0, 0), { scrollbar: "hidden" }) };
  }
  private newPath() {
    const editor = new Editor(this.input.tui, { borderColor: this.input.borderColor, selectList: this.input.theme }, { paddingX: 1 });
    editor.setText(this.input.pathDrafts.get(this.input.projectId) ?? "research/topic.md"); editor.focused = this.hasFocus;
    editor.onSubmit = text => {
      this.input.pathDrafts.set(this.input.projectId, text);
      try {
        const path = parse(KnowledgePath, text.trim());
        if (!path.includes("/")) throw new Error("Use a managed topic folder. MEMORY.md/preferences.md are edited through their existing records");
        const prior = this.input.drafts.get(this.key(path));
        if (prior && prior.expectedRevision !== null) throw new Error("This path has an existing-document edit draft. Open it from the list; topic creation cannot reuse its write revision");
        editor.focused = false; this.edit({ path, text: "", revision: null });
      } catch (error) { this.notice = `Invalid new topic path: ${errorText(error)}. Path retained.`; }
      this.input.paint();
    };
    this.mode = { kind: "path", editor };
  }
  private edit(target: EditTarget) {
    const key = this.key(target.path), draft = this.input.drafts.get(key) ?? { text: target.text, expectedRevision: target.revision };
    if (stripVTControlCharacters(draft.text) !== draft.text || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(draft.text)) { this.notice = "Control-bearing text is read-only here. Use the explicit knowledge-write API to repair it."; return; }
    this.input.drafts.set(key, draft);
    const editor = new Editor(this.input.tui, { borderColor: this.input.borderColor, selectList: this.input.theme }, { paddingX: 1 });
    editor.setText(draft.text); editor.focused = this.hasFocus;
    editor.onSubmit = text => { void this.act(async () => {
      draft.text = text;
      const saved = parse(KnowledgeDocument, await request({ action: "knowledge-write", id: this.input.projectId, path: target.path, expectedRevision: draft.expectedRevision, text }, false));
      if (saved.path !== target.path) throw new Error("Knowledge write returned a different path");
      if (this.input.drafts.get(key) === draft && draft.text === text) this.input.drafts.delete(key);
      if (!this.closed) { editor.focused = false; this.read(saved); this.notice = "Revision-checked knowledge write recorded. MEMORY.md was not automatically changed."; }
    }); };
    this.mode = { kind: "edit", target, editor, key };
  }
  private discard(document: KnowledgeDocument) {
    const list = this.list([{ value: "cancel", label: "Keep draft unchanged" }, { value: "discard", label: "Discard draft and edit inspected current text" }]);
    list.onSelect = item => {
      if (item.value === "discard") { this.input.drafts.delete(this.key(document.path)); this.edit(document); }
      else this.read(document);
    };
    this.mode = { kind: "discard", document, list };
  }
  private async history(document: KnowledgeDocument) {
    const revisions = parse(Type.Array(KnowledgeRevision), await request({ action: "knowledge-history", id: this.input.projectId, path: document.path }, false));
    if (revisions.some(revision => revision.path !== document.path)) throw new Error("Knowledge history returned a different path");
    if (this.closed) return;
    const list = this.list(revisions.toReversed().map(revision => ({ value: revision.id, label: clean(`${revision.updatedAt} · ${revision.author} · ${revision.revision.slice(0, 12)}`) })));
    list.onSelect = item => {
      const revision = revisions.find(value => value.id === item.value);
      if (revision) this.mode = { kind: "revision", document, scroll: new ScrollView(new Text(clean(`Recorded revision ${revision.revision}\nPrior revision ${revision.priorRevision ?? "none"}\n\n${revision.text}`), 0, 0), { scrollbar: "hidden" }) };
      this.input.paint();
    };
    this.mode = { kind: "history", document, list };
  }
  private async act(action: () => Promise<void>) {
    if (this.busy || this.closed) return;
    this.busy = true; this.input.paint();
    try { await action(); }
    catch (error) { if (!this.closed) this.notice = `Knowledge action failed: ${errorText(error)}. Draft retained; no automatic replay.`; }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
}
