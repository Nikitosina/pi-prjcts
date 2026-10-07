import { CURSOR_MARKER, Editor, ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { request } from "./client.ts";
import { errorText, parse, type Request } from "./state.ts";

type Action = "workspace-grant" | "workspace-revoke" | "github-authorize" | "github-revoke" | "command-profile-set" | "worker-skills-grant-set" | "worker-skills-grant-revoke";
const OwnerFields = Type.Record(Type.String(), Type.Unknown());
type Entry = { value: string; label: string };

export class OwnerSetupScreen implements Component, Focusable {
  private list: SelectList;
  private detail: ScrollView | null = null;
  private editor: Editor | null = null;
  private selectedAction: Action | null = null;
  private pending: Request | null = null;
  private busy = false;
  private closed = false;
  private hasFocus = false;
  private snapshot: unknown = null;
  private notice = "Owner actions only. Each change needs fresh project confirmation. No action executes a profile.";

  constructor(private input: { projectId: string; tui: TUI; keys: KeybindingsManager; theme: SelectListTheme; borderColor: (text: string) => string; height: () => number; paint: () => void; exit: () => void }) {
    this.list = this.makeList([]);
    void this.act(() => this.refresh());
  }
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; if (this.editor) this.editor.focused = value; }
  invalidate() { this.list.invalidate(); this.detail?.invalidate(); this.editor?.invalidate(); }
  dispose() { this.closed = true; if (this.editor) this.editor.focused = false; }
  render(width: number): string[] {
    const height = Math.max(1, this.input.height());
    if (this.editor) {
      const lines = this.editor.render(width), room = Math.max(1, height - 4), cursor = lines.findIndex(line => line.includes(CURSOR_MARKER)), start = Math.max(0, cursor - room + 1);
      return [`Owner ${this.selectedAction} · JSON fields only, no consent is saved`, `Project ${this.input.projectId} · Enter reviews · Esc cancels`, ...lines.slice(start, start + room), this.notice].slice(0, height);
    }
    const items = this.list.render(width);
    if (this.pending && this.detail) {
      const text = this.detail.render(width), room = Math.max(1, height - items.length - 3);
      this.detail.updateLayout(text.length, room, this.input.paint);
      return [...text.slice(this.detail.scrollTop, this.detail.scrollTop + room), ...items, this.notice].slice(0, height);
    }
    return [`Owner setup · project ${this.input.projectId} · r reread`, ...items, this.notice].slice(0, height);
  }
  handleInput(data: string) {
    if (this.closed || this.busy) return;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      if (this.editor) { this.editor.focused = false; this.editor = null; this.menu(); }
      else if (this.pending) { this.pending = null; this.detail = null; this.menu(); }
      else { this.dispose(); this.input.exit(); }
      this.input.paint(); return;
    }
    if (this.editor) { this.editor.handleInput(data); this.input.paint(); return; }
    if (this.pending && this.detail) {
      if (matchesKey(data, "tab")) this.confirmPending();
      else if (data === "y") void this.act(() => this.commit());
      else if (matchesKey(data, "enter")) this.confirmPending();
      else this.list.handleInput(data);
      this.input.paint(); return;
    }
    if (data === "r") void this.act(() => this.refresh());
    else this.list.handleInput(data);
    this.input.paint();
  }
  private makeList(entries: Entry[]) { return new SelectList(entries, Math.max(2, Math.min(12, this.input.height() - 3)), this.input.theme); }
  private async act(fn: () => Promise<void>) {
    this.busy = true; this.input.paint();
    try { await fn(); } catch (error) { if (!this.closed) this.notice = errorText(error); }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
  private async refresh() {
    const snapshot = await request({ action: "owner-setup-snapshot", id: this.input.projectId }, false);
    if (this.closed) return;
    this.snapshot = snapshot;
    this.notice = "Configured skills unavailable in standalone host. No Arc setup. Fixed profiles remain inactive until separately selected by an authorized worker; profile definition is not execution approval.";
    this.menu();
  }
  private menu() {
    const rows: Entry[] = [
      { value: "inspect", label: "Inspect current workspace, GitHub, profiles and skill grants" },
      { value: "scope-details", label: "Inspect exact scope files and base revisions" },
      { value: "profile-read", label: "Read exact fixed profile argv and executable identity" },
      { value: "catalog", label: "Inspect repository skill catalog" },
      { value: "github-inspect", label: "Read GitHub repository numeric ID and default branch" },
      { value: "scope-revoke", label: "Revoke a workspace scope" },
      { value: "github-revoke", label: "Revoke GitHub authorization" },
      { value: "scope-grant", label: "Create a workspace scope" },
      { value: "github-authorize", label: "Authorize GitHub publication target" },
      { value: "profile-set", label: "Register or disable fixed command profile" },
      { value: "skill-set", label: "Grant selected repository skills" },
      { value: "skill-revoke", label: "Revoke worker skill grant" },
      { value: "cancel", label: "Back" },
    ];
    this.list = this.makeList(rows);
    this.list.onSelect = item => { if (item.value === "cancel") { this.dispose(); this.input.exit(); } else void this.act(() => this.choose(item.value)); this.input.paint(); };
  }
  private async choose(value: string) {
    if (value === "inspect") { this.inspect(this.snapshot); return; }
    if (value === "scope-details") { this.inspect(await request({ action: "workspace-catalog", id: this.input.projectId }, false)); return; }
    if (value === "profile-read") { this.profiles(); return; }
    if (value === "github-inspect") { this.githubInspect(); return; }
    if (value === "catalog") { this.inspect(await request({ action: "worker-skills-catalog", id: this.input.projectId }, false)); return; }
    const actions: Record<string, Action> = { "scope-revoke": "workspace-revoke", "github-revoke": "github-revoke", "scope-grant": "workspace-grant", "github-authorize": "github-authorize", "profile-set": "command-profile-set", "skill-set": "worker-skills-grant-set", "skill-revoke": "worker-skills-grant-revoke" };
    const action = actions[value];
    if (!action) return;
    this.selectedAction = action;
    const editor = new Editor(this.input.tui, { borderColor: this.input.borderColor, selectList: this.input.theme }, { paddingX: 1 });
    editor.setText("{}"); editor.focused = this.hasFocus;
    editor.onSubmit = text => {
      editor.focused = false;
      try { this.prepare(action, text); this.editor = null; }
      catch (error) { editor.setText(text); editor.focused = this.hasFocus; this.editor = editor; this.notice = errorText(error); }
      this.input.paint();
    };
    this.editor = editor;
    this.notice = "Enter the API fields as JSON. Use the current revision from Inspect. The host validates exact IDs and paths. Confirmation is a separate next step and is never retained.";
  }
  private githubInspect() {
    const editor = new Editor(this.input.tui, { borderColor: this.input.borderColor, selectList: this.input.theme }, { paddingX: 1 });
    editor.setText(""); editor.focused = this.hasFocus;
    editor.onSubmit = repositoryId => { this.editor = null; editor.focused = false; void this.act(async () => this.inspect(await request({ action: "github-repository-inspect", id: this.input.projectId, repositoryId: repositoryId.trim() }, false))); };
    this.editor = editor;
    this.notice = "Read-only identity check. Enter the exact owner/repository from the selected checkout's credential-free GitHub origin. This issues a provider GET only after you submit.";
  }
  private profiles() {
    const options: Entry[] = [];
    if (this.snapshot && typeof this.snapshot === "object" && "profiles" in this.snapshot && Array.isArray(this.snapshot.profiles)) {
      for (const profile of this.snapshot.profiles) {
        if (profile && typeof profile === "object" && "id" in profile && typeof profile.id === "string" && "label" in profile && typeof profile.label === "string") options.push({ value: profile.id, label: `${profile.label} · ${profile.id}` });
      }
    }
    this.list = this.makeList(options.length ? options : [{ value: "none", label: "No profiles registered" }]);
    this.list.onSelect = item => { if (item.value !== "none") void this.act(async () => this.inspect(await request({ action: "command-profile-read", id: this.input.projectId, profileId: item.value }, false))); };
  }
  private prepare(action: Action, text: string) {
    let fields: unknown;
    try { fields = JSON.parse(text); } catch { throw new Error("Enter valid JSON fields"); }
    const parsedFields = parse(OwnerFields, fields);
    if (Array.isArray(parsedFields)) throw new Error("Enter one JSON object");
    const data = { ...parsedFields, action, id: this.input.projectId, confirm: this.input.projectId };
    this.pending = parse(Request, data);
    this.detail = new ScrollView(new Text(`Project ${this.input.projectId}\nAction ${action}\n\n${JSON.stringify(this.pending, null, 2)}\n\nPress y to submit with fresh owner confirmation. Any API revision conflict cancels the change. Revocation stops future admission and preserves receipts, scopes and repository history. Profile registration does not execute the command or grant executable approval.`, 0, 0), { scrollbar: "hidden" });
    this.list = this.makeList([{ value: "cancel", label: "Cancel, make no change" }, { value: "confirm", label: `Confirm this owner action for project ${this.input.projectId}` }]);
    this.list.onSelect = item => { if (item.value === "confirm") void this.act(() => this.commit()); else { this.pending = null; this.detail = null; this.menu(); } };
    this.notice = "Review the exact request. Consent is separate from the editable draft.";
  }
  private inspect(value: unknown) {
    this.pending = null;
    this.detail = new ScrollView(new Text(JSON.stringify(value, null, 2), 0, 0), { scrollbar: "hidden" });
    this.list = this.makeList([{ value: "back", label: "Back to owner setup" }]);
    this.list.onSelect = () => { this.pending = null; this.detail = null; this.menu(); this.input.paint(); };
  }
  private confirmPending() { this.list = this.makeList([{ value: "cancel", label: "Cancel" }, { value: "confirm", label: `Confirm for project ${this.input.projectId}` }]); }
  private async commit() {
    const pending = this.pending;
    if (!pending || this.closed || !("id" in pending) || this.input.projectId !== pending.id) throw new Error("Owner target changed; reopen setup for the intended project");
    const result = await request(pending, false);
    if (this.closed || pending.id !== this.input.projectId) return;
    this.pending = null; this.detail = null; this.notice = `Host recorded the owner action. ${JSON.stringify(result)}`;
    await this.refresh();
  }
}
