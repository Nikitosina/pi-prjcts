import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, Editor, ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { request } from "./client.ts";
import { clean, firstLine } from "./project-items.ts";
import { Evidence, errorText, parse } from "./state.ts";

export type UploadDraft = { projectId: string; importId: string; filename: string; title: string; encoding: "utf8" | "base64"; text: string; submittedFingerprint: string | null };
function prepared(draft: UploadDraft) {
  if (!draft.filename || draft.filename.length > 240 || basename(draft.filename) !== draft.filename || draft.filename.includes("\\") || /[\u0000-\u001f\u007f]/.test(draft.filename)) throw new Error("Filename must be a display name, not a path");
  if (!draft.title.trim() || draft.title.length > 1000) throw new Error("Title must contain 1-1000 characters");
  if (draft.text.length > 43692) throw new Error("Upload input exceeds the bounded native editor allowance");
  const bytes = Buffer.from(draft.text, draft.encoding === "utf8" ? "utf8" : "base64");
  if (draft.encoding === "utf8" && new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== draft.text) throw new Error("UTF-8 input contains invalid Unicode; use canonical base64 to preserve exact bytes");
  if (bytes.length > 32768) throw new Error("Native uploads are limited to 32 KiB");
  if (draft.encoding === "base64" && (!/^[A-Za-z0-9+/]*={0,2}$/.test(draft.text) || bytes.toString("base64") !== draft.text)) throw new Error("Paste canonical base64 without whitespace");
  const data = bytes.toString("base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify({ projectId: draft.projectId, importId: draft.importId, filename: draft.filename, title: draft.title, data, sha256 })).digest("hex");
  return { ...draft, data, sha256, fingerprint, size: bytes.length };
}
type Prepared = ReturnType<typeof prepared>;
type Mode = { kind: "drafts"; list: SelectList }
  | { kind: "fields" | "encoding"; draft: UploadDraft; list: SelectList }
  | { kind: "editor"; draft: UploadDraft; field: "filename" | "title" | "text"; editor: Editor }
  | { kind: "confirm"; draft: UploadDraft; payload: Prepared; list: SelectList; scroll: ScrollView; focus: "choices" | "details" };

export class UploadScreen implements Component, Focusable {
  private mode: Mode;
  private closed = false;
  private busy = false;
  private hasFocus = false;
  private notice = "Pasted reference bytes only. No local file access, command execution or agent grant.";
  constructor(private input: { projectId: string; tui: TUI; keys: KeybindingsManager; theme: SelectListTheme; borderColor: (text: string) => string; drafts: Map<string, UploadDraft>; persist: () => void; height: () => number; paint: () => void; exit: () => void }) {
    this.mode = { kind: "drafts", list: this.list([]) }; this.choose();
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; if (this.mode.kind === "editor") this.mode.editor.focused = value; }
  invalidate() { if (this.mode.kind === "editor") this.mode.editor.invalidate(); else { this.mode.list.invalidate(); if (this.mode.kind === "confirm") this.mode.scroll.invalidate(); } }
  dispose() { this.remember(); this.closed = true; if (this.mode.kind === "editor") this.mode.editor.focused = false; }
  render(width: number): string[] {
    const height = Math.max(1, this.input.height()), mode = this.mode;
    let body: string[];
    if (mode.kind === "editor") {
      const lines = mode.editor.render(width), room = Math.max(1, height - 4), cursor = lines.findIndex(line => line.includes(CURSOR_MARKER)), start = Math.max(0, cursor - room + 1);
      body = [`Upload ${mode.field} · Enter keeps field · Esc retains draft`, `Import UUID ${mode.draft.importId}`, `Content encoding ${mode.draft.encoding} · maximum 32 KiB decoded`, ...lines.slice(start, start + room)];
    } else if (mode.kind === "confirm") {
      const choices = mode.list.render(width), room = Math.max(1, height - choices.length - 3), lines = mode.scroll.render(width);
      mode.scroll.updateLayout(lines.length, room, this.input.paint);
      body = [...lines.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room), `Tab: ${mode.focus === "choices" ? "scroll exact import" : "select choices"}`, ...choices];
    } else body = [mode.kind === "drafts" ? "Retained upload drafts · explicit new UUID only" : `Import UUID ${mode.draft.importId}`, ...mode.list.render(width)];
    return [...body.slice(0, Math.max(0, height - 1)), clean(this.busy ? "Waiting for confirmed import… Esc closes panel without replay." : this.notice)];
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      this.remember();
      if (this.busy || this.mode.kind === "drafts") { this.dispose(); this.input.exit(); }
      else if (this.mode.kind === "editor") { this.mode.editor.focused = false; this.fields(this.mode.draft); }
      else if (this.mode.kind === "confirm" || this.mode.kind === "encoding") this.fields(this.mode.draft);
      else this.choose();
      this.input.paint(); return;
    }
    if (this.busy) return;
    const mode = this.mode;
    if (mode.kind === "editor") { mode.editor.handleInput(data); this.remember(); }
    else if (mode.kind === "confirm") {
      if (matchesKey(data, "tab")) mode.focus = mode.focus === "choices" ? "details" : "choices";
      else if (mode.focus === "choices") mode.list.handleInput(data);
      else this.scroll(mode.scroll, data);
    } else mode.list.handleInput(data);
    this.input.paint();
  }
  private list(options: { value: string; label: string }[]) { return new SelectList(options, Math.max(2, Math.min(12, this.input.height() - 3)), this.input.theme); }
  private remember() { if (this.mode.kind === "editor") this.mode.draft[this.mode.field] = this.mode.editor.getExpandedText(); }
  private choose() {
    const own = [...this.input.drafts.values()].filter(draft => draft.projectId === this.input.projectId);
    const list = this.list([{ value: "new", label: "Create a separate new upload draft/UUID" }, ...own.map(draft => ({ value: draft.importId, label: `${firstLine(draft.filename) || "Unnamed"} · ${draft.importId} · ${draft.submittedFingerprint ? "submission retained" : "not submitted"}` }))]);
    list.onSelect = item => {
      if (item.value === "new") {
        const draft: UploadDraft = { projectId: this.input.projectId, importId: randomUUID(), filename: "reference.md", title: "Project reference", encoding: "utf8", text: "", submittedFingerprint: null };
        this.input.drafts.set(draft.importId, draft); this.fields(draft);
      } else {
        const draft = this.input.drafts.get(item.value);
        if (draft?.projectId === this.input.projectId) this.fields(draft);
      }
      this.input.paint();
    };
    this.mode = { kind: "drafts", list };
  }
  private fields(draft: UploadDraft) {
    const list = this.list([{ value: "filename", label: `Filename: ${firstLine(draft.filename)}` }, { value: "title", label: `Title: ${firstLine(draft.title)}` }, { value: "encoding", label: `Input encoding: ${draft.encoding}` }, { value: "text", label: `Paste content (${draft.text.length} characters)` }, { value: "confirm", label: "Review exact bytes/hash and confirm import" }]);
    list.onSelect = item => {
      if (item.value === "filename" || item.value === "title" || item.value === "text") this.edit(draft, item.value);
      else if (item.value === "encoding") {
        const list = this.list([{ value: "utf8", label: "UTF-8 text" }, { value: "base64", label: "Canonical base64 bytes" }]);
        list.onSelect = item => { if (item.value === "utf8" || item.value === "base64") draft.encoding = item.value; this.fields(draft); this.input.paint(); };
        this.mode = { kind: "encoding", draft, list };
      } else if (item.value === "confirm") {
        try { this.confirm(draft, prepared(draft)); }
        catch (error) { this.notice = `Import not admitted: ${errorText(error)}. Draft retained.`; }
      }
      this.input.paint();
    };
    this.mode = { kind: "fields", draft, list };
  }
  private edit(draft: UploadDraft, field: "filename" | "title" | "text") {
    const text = draft[field];
    if (stripVTControlCharacters(text) !== text || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) { this.notice = "Control-bearing text cannot enter this editor. Use canonical base64 for binary references."; return; }
    const editor = new Editor(this.input.tui, { borderColor: this.input.borderColor, selectList: this.input.theme }, { paddingX: 1 });
    editor.setText(text); editor.focused = this.hasFocus;
    editor.onSubmit = text => { draft[field] = text; editor.focused = false; this.fields(draft); this.input.paint(); };
    this.mode = { kind: "editor", draft, field, editor };
  }
  private confirm(draft: UploadDraft, payload: Prepared) {
    if (draft.submittedFingerprint !== null && draft.submittedFingerprint !== payload.fingerprint) throw new Error("Prior submission is unresolved. Restore its exact metadata/bytes or explicitly create a separate new draft; the old UUID remains retained");
    const list = this.list([{ value: "cancel", label: "Cancel, retain draft and UUID" }, { value: "import", label: "Import these exact bytes into this project" }]);
    const preview = payload.encoding === "utf8" ? payload.text : `Base64 input\n${payload.text}`;
    const scroll = new ScrollView(new Text(clean(`Project ${payload.projectId}\nImport UUID ${payload.importId}\nFilename ${payload.filename}\nTitle ${payload.title}\nBytes ${payload.size}\nSHA-256 ${payload.sha256}\nFingerprint ${payload.fingerprint}\n\n${preview}\n\nThis stores an owner reference, not worker-generated evidence. It does not grant agent access or execute work.`), 0, 0), { scrollbar: "hidden" });
    list.onSelect = item => {
      if (item.value === "cancel") { this.fields(draft); this.input.paint(); return; }
      void this.act(async () => {
        draft.submittedFingerprint = payload.fingerprint;
        this.input.persist();
        const record = parse(Evidence, await request({ action: "library-import", id: payload.projectId, confirm: payload.projectId, importId: payload.importId, filename: payload.filename, title: payload.title, encoding: "base64", data: payload.data, expectedSha256: payload.sha256 }, false));
        if (record.id !== payload.importId || record.sha256 !== payload.sha256 || record.size !== payload.size || record.filename !== payload.filename || record.title !== payload.title || record.native !== undefined || record.sessionFile !== null) throw new Error("Import receipt does not match the confirmed owner reference");
        if (this.input.drafts.get(draft.importId) === draft && draft.filename === payload.filename && draft.title === payload.title && draft.encoding === payload.encoding && draft.text === payload.text) this.input.drafts.delete(draft.importId);
        if (!this.closed) { this.choose(); this.notice = `Import receipt ${record.id} recorded. Open the library to inspect the hash-checked reference.`; }
      });
    };
    this.mode = { kind: "confirm", draft, payload, list, scroll, focus: "choices" };
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
    catch (error) { if (!this.closed) this.notice = `Import failed: ${errorText(error)}. UUID/fingerprint retained; no automatic replay.`; }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
}
