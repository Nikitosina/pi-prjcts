import { randomUUID } from "node:crypto";
import { LibraryScreen } from "./project-library-screen.ts";
import { GithubScreen } from "./project-github-screen.ts";
import { UploadScreen, type UploadDraft } from "./project-upload-screen.ts";
import { SettingsScreen, type SettingsDraft } from "./project-settings-screen.ts";
import { OwnerSetupScreen } from "./project-owner-setup-screen.ts";
import { RoutinesScreen } from "./project-routines-screen.ts";
import { KnowledgeScreen, type KnowledgeDraft } from "./project-knowledge-screen.ts";
import { NativeHistory, NativeOperations, NativePlan, NativeUsage, type NativeOperation, type NativeWork } from "./project-native-data.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Image, ScrollView, SelectList, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager, type SelectListTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { request } from "./client.ts";
import { readEvidence } from "./evidence.ts";
import { Project, Snapshot, errorText, parse, projectDir, type InboxEntry, type Request } from "./state.ts";
import { clean, details, items, lanes, layoutNames, layouts, worker, type Item, type Lane, type Layout, type Section } from "./project-items.ts";

type Run = Project["runs"][number];
type Target = { kind: "answer"; entry: Extract<InboxEntry, { kind: "question" }> }
  | { kind: "revise"; entry: Extract<InboxEntry, { kind: "review" }> }
  | { kind: "steer"; run: Run }
  | { kind: "thread-send" | "thread-steer"; work: NativeWork };
export type FormDraft = { text: string; requestId: string; submittedText: string | null };
type NativePanel = Pick<KnowledgeScreen, "focused" | "render" | "handleInput" | "invalidate" | "dispose">;
type Mode = { kind: "main"; focus: "list" | "detail" | "chat" }
  | { kind: "form"; title: string; editor: Editor; draftKey: string }
  | { kind: "menu"; title: string; hint: ScrollView; list: SelectList; focus: "choices" | "details" }
  | { kind: "viewer"; title: string; scroll: ScrollView }
  | { kind: "history"; title: string; scroll: ScrollView; page: NativeHistory; projectId: string; textOffset: number }
  | { kind: "panel"; title: string; panel: NativePanel }
  | { kind: "usage"; title: string; projectId: string; page: NativeUsage; scroll: ScrollView };
type Region = { x: number; y: number; width: number; height: number; component: SelectList | Editor; lane?: Lane };

const NativeText = Type.Object({ text: Type.String() });

export class ProjectsScreen implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keys: KeybindingsManager;
  private done: () => void;
  private selectProject: (id: string) => Promise<Snapshot>;
  private saveLayout: (layout: Layout) => void;
  private snapshot: Snapshot;
  private layout: Layout;
  private section: Section;
  private lane: Lane = "Needs you";
  private selected: string | undefined;
  private mode: Mode = { kind: "main", focus: "list" };
  private chat: Editor;
  private drafts: Map<string, string>;
  private formDrafts: Map<string, FormDraft>;
  private knowledgeDrafts: Map<string, KnowledgeDraft>;
  private knowledgePathDrafts: Map<string, string>;
  private settingsDrafts: Map<string, SettingsDraft>;
  private saveDrafts: () => void;
  private uploadDrafts: Map<string, UploadDraft>;
  private plan: NativePlan | undefined;
  private approvals: NativeOperations | undefined;
  private pendingApprovals: NativeOperations | undefined;
  private approvalOffset = 0;
  private refreshEpoch = 0;
  private reader = new Text("", 0, 0);
  private scroll = new ScrollView(this.reader, { scrollbar: "hidden" });
  private list: SelectList | undefined;
  private regions: Region[] = [];
  private timer: ReturnType<typeof setInterval>;
  private fetching: { id: string; epoch: number; approvalOffset: number } | undefined;
  private closed = false;
  private pending = false;
  private connection: string | null = null;
  private notice = "Live host. Esc closes this screen without stopping workers.";
  private hasFocus = false;
  private pageHeight = 10;

  constructor(input: { tui: TUI; theme: Theme; keys: KeybindingsManager; done: () => void; snapshot: Snapshot; layout: Layout; selectProject: (id: string) => Promise<Snapshot>; saveLayout: (layout: Layout) => void; drafts: Map<string, string>; formDrafts: Map<string, FormDraft>; knowledgeDrafts: Map<string, KnowledgeDraft>; knowledgePathDrafts: Map<string, string>; settingsDrafts: Map<string, SettingsDraft>; saveDrafts: () => void; uploadDrafts: Map<string, UploadDraft> }) {
    this.tui = input.tui; this.theme = input.theme; this.keys = input.keys; this.done = input.done;
    this.snapshot = input.snapshot; this.layout = input.layout; this.section = input.layout === "inbox" ? "inbox" : "work";
    this.selectProject = input.selectProject; this.saveLayout = input.saveLayout;
    this.drafts = input.drafts; this.formDrafts = input.formDrafts; this.knowledgeDrafts = input.knowledgeDrafts; this.knowledgePathDrafts = input.knowledgePathDrafts; this.settingsDrafts = input.settingsDrafts; this.saveDrafts = input.saveDrafts; this.uploadDrafts = input.uploadDrafts;
    this.chat = this.editor();
    this.chat.setText(this.drafts.get(this.snapshot.project.id) ?? "");
    this.chat.onSubmit = text => {
      if (!text.trim() || this.pending) return;
      void this.act(async () => {
        const id = this.snapshot.project.id;
        if (this.snapshot.paused || this.plan?.paused || this.snapshot.project.archived || this.snapshot.project.deleted) throw new Error("Restore/resume project admission before messaging; draft retained");
        await request({ action: "message", id, text }, false);
        if (!this.closed && this.snapshot.project.id === id && this.chat.getExpandedText() === text) this.chat.setText("");
        if (!this.closed) this.drafts.set(id, this.chat.getExpandedText());
        this.notice = "Sent to the persistent coordinator.";
      });
    };
    this.timer = setInterval(() => { this.checkpointDrafts(); void this.refresh(); }, 1500);
    this.timer.unref();
    void this.refresh();
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.focusEditors(); }
  invalidate(): void { if (this.mode.kind === "panel") this.mode.panel.invalidate(); this.chat.invalidate(); if (this.mode.kind === "form") this.mode.editor.invalidate(); this.reader.invalidate(); }
  dispose(): void { if (this.closed) return; if (this.mode.kind === "panel") this.mode.panel.dispose(); this.rememberForm(); this.checkpointDrafts(); this.closed = true; clearInterval(this.timer); this.chat.focused = false; if (this.mode.kind === "form") this.mode.editor.focused = false; }
  close(): void { this.dispose(); this.done(); }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (width < 32 || height < 18) return [this.fit("Projects: resize to at least 32 columns / 18 rows", width), this.fit("Esc closes; workers continue.", width)].slice(0, height);
    this.regions = [];
    this.focusEditors();
    const p = this.snapshot.project;
    const attention = this.snapshot.inbox.filter(entry => !entry.result).length + (this.pendingApprovals?.total ?? 0);
    const header = [
      this.theme.fg("accent", this.theme.bold(` PI PROJECTS / ${layoutNames[this.layout]}`)),
      ` ${clean(p.name)} · ${this.snapshot.busy ? "coordinating" : p.phase} · ${this.plan?.work.filter(work => work.status === "running").length ?? this.snapshot.activeRuns.length} workers · ${attention} need you${p.runtime === "durable" && !this.pendingApprovals ? " + approvals loading" : ""}`,
      this.theme.fg("muted", ` ${clean(p.cwd)} · ${p.runtime === "durable" ? `Durable · ${this.plan ? this.plan.pausing ? "pausing" : this.plan.paused ? "paused" : "active" : "plan loading"} · scoped workspaces` : "selected checkout · one writer"}`),
      this.theme.fg("border", "─".repeat(width)),
    ];
    let body: string[];
    if (this.mode.kind === "main") {
      const chatLines = this.chat.render(width);
      const room = Math.max(1, height - header.length - chatLines.length - 3);
      this.pageHeight = Math.max(1, room - 2);
      body = this.main(width, room);
      const chatY = header.length + body.length + 1;
      this.regions.push({ x: 0, y: chatY, width, height: chatLines.length, component: this.chat });
      body.push(this.theme.fg(this.mode.focus === "chat" ? "accent" : "muted", " Coordinator prompt  / to focus · Enter sends · Shift+Enter adds a line"), ...chatLines);
    } else {
      const room = height - header.length - 2;
      this.pageHeight = Math.max(1, room - 3);
      switch (this.mode.kind) {
        case "form": {
          const mode = this.mode;
          const editor = mode.editor.render(Math.max(1, width - 4));
          body = this.box(mode.title, ["This sends a real instruction to the Projects host.", "", ...editor, "", "Enter sends. Shift+Enter adds a line. Esc keeps the current task unchanged."], width, room, true);
          break;
        }
        case "menu": {
          const mode = this.mode, choices = mode.list.render(Math.max(1, width - 4));
          const hintHeight = Math.max(1, room - choices.length - 5);
          body = this.box(mode.title, [...this.viewport(mode.hint, Math.max(1, width - 4), hintHeight), "", `Tab: ${mode.focus === "choices" ? "scroll details" : "select choices"} · ↑↓ / PgUp / PgDn`, ...choices], width, room, true);
          break;
        }
        case "panel": body = this.box(this.mode.title, this.mode.panel.render(Math.max(1, width - 4)), width, room, true); break;
        case "usage":
        case "history":
        case "viewer": body = this.box(this.mode.title, this.viewport(this.mode.scroll, width - 2, room - 2), width, room, true); break;
      }
    }
    const hint = this.mode.kind === "main" ? " Esc close | 1 desk  2 board  3 inbox | i inbox  m conversation  w work  e evidence  n notes  K knowledge  L library  A upload  U usage  S settings  G GitHub  R routines  O owner setup  P lifecycle  o approvals | Tab focus  ? help" : " Esc back | ↑↓ select/scroll  PgUp/PgDn scroll";
    return [...header, ...body, this.theme.fg(this.connection ? "error" : "muted", ` ${clean(this.connection ?? (this.pending ? "Waiting for host action…" : this.notice))}`), this.theme.fg("dim", hint)].slice(0, height).map(line => this.fit(line, width));
  }

  handleInput(data: string): void {
    if (this.mode.kind === "panel") {
      if (matchesKey(data, "ctrl+c")) this.close();
      else this.mode.panel.handleInput(data);
      return;
    }
    if (this.keys.matches(data, "app.interrupt") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.pending) { this.close(); return; }
      if (this.mode.kind === "main" && this.mode.focus === "list") this.close();
      else { this.rememberForm(); this.mode = { kind: "main", focus: "list" }; this.paint(); }
      return;
    }
    if (this.pending) return;
    if (this.mode.kind === "form") { this.mode.editor.handleInput(data); this.rememberForm(); this.paint(); return; }
    if (this.mode.kind === "menu") {
      const mode = this.mode;
      if (matchesKey(data, "tab")) mode.focus = mode.focus === "choices" ? "details" : "choices";
      else if (mode.focus === "details") this.readKeys(data, mode.hint);
      else mode.list.handleInput(data);
      this.paint(); return;
    }
    if (this.mode.kind === "usage") {
      const mode = this.mode;
      const offset = data === "]" ? mode.page.nextOffset : data === "[" ? Math.max(0, mode.page.offset - 100) : data === "r" ? mode.page.offset : undefined;
      if (offset !== null && offset !== undefined) void this.act(() => this.usage(mode.projectId, offset));
      else { this.readKeys(data, mode.scroll); this.paint(); }
      return;
    }
    if (this.mode.kind === "history") {
      const mode = this.mode;
      const jump = data === "]" && mode.page.nextOffset !== null ? { offset: mode.page.nextOffset, textOffset: 0 }
        : data === "[" ? { offset: Math.max(0, mode.page.offset - 30), textOffset: 0 }
        : data === "}" && mode.page.items.some(item => item.nextTextOffset !== null) ? { offset: mode.page.offset, textOffset: mode.textOffset + 4000 }
        : data === "{" ? { offset: mode.page.offset, textOffset: Math.max(0, mode.textOffset - 4000) } : undefined;
      if (jump) void this.act(() => this.history(mode.projectId, mode.page.threadId, jump.offset, jump.textOffset));
      else { this.readKeys(data, mode.scroll); this.paint(); }
      return;
    }
    if (this.mode.kind === "viewer") { this.readKeys(data, this.mode.scroll); this.paint(); return; }
    if (this.mode.focus === "chat") {
      if (matchesKey(data, "tab")) this.mode.focus = "list";
      else this.chat.handleInput(data);
      this.paint(); return;
    }
    if (data === "1" || data === "2" || data === "3") {
      const next = layouts[Number(data) - 1];
      if (next) this.changeLayout(next);
      return;
    }
    const sections: Record<string, Section> = { o: "approvals", w: "work", i: "inbox", e: "evidence", n: "notes", l: "activity", m: "conversation" };
    const section = sections[data];
    if (section) { this.section = section; this.selected = undefined; this.mode.focus = "list"; this.scroll.scrollToStart(); this.paint(); return; }
    if (data === "/") { this.mode.focus = "chat"; this.paint(); return; }
    if (data === "?") { this.help(); return; }
    if (data === "K") { this.knowledge(); return; }
    if (data === "L") { this.library(); return; }
    if (data === "A") { this.upload(); return; }
    if (data === "U") { const id = this.snapshot.project.id; void this.act(() => this.usage(id)); return; }
    if (data === "P") { this.lifecycle(); return; }
    if (data === "S") { this.settingsPanel(); return; }
    if (data === "G") { this.githubPanel(); return; }
    if (data === "R") { this.routinesPanel(); return; }
    if (data === "O") { this.ownerSetupPanel(); return; }
    if (data === "p") { void this.chooseProject(); return; }
    if (data === "r") { void this.refresh(true); return; }
    if (matchesKey(data, "tab")) { this.mode.focus = this.mode.focus === "list" ? "detail" : "chat"; this.paint(); return; }
    if (this.section === "approvals" && (data === "[" || data === "]")) {
      const offset = data === "[" ? Math.max(0, (this.approvals?.offset ?? 0) - 100) : this.approvals?.nextOffset;
      if (offset !== null && offset !== undefined) void this.act(async () => { this.approvalOffset = offset; this.refreshEpoch++; this.selected = undefined; this.scroll.scrollToStart(); });
      return;
    }
    const item = this.current();
    if (item?.kind === "approval" && ["v", "y", "c", "g", "h"].includes(data)) { this.operationControl(item.operation, data); return; }
    if (data === "a" && item?.kind === "entry" && item.entry.kind === "question") { this.answerMenu(item.entry); return; }
    if (data === "v" && item?.kind === "entry" && item.entry.kind === "review") {
      const entry = item.entry;
      this.confirm("Accept this result?", "This closes the review. It does not commit, merge, or publish.", "Accept result", async () => { await request({ action: "review", id: this.snapshot.project.id, entry: entry.id, operation: "accept" }, false); this.notice = "Result accepted. No commit, merge, or publish."; });
      return;
    }
    if (data === "c" && item?.kind === "entry" && item.entry.kind === "review") { this.form("Request changes", { kind: "revise", entry: item.entry }); return; }
    if (item?.kind === "thread") {
      const id = this.snapshot.project.id, work = item.work;
      if (["f", "s", "x"].includes(data) && (this.snapshot.project.archived || this.snapshot.project.deleted)) { this.notice = "Restore the retained project before controlling threads."; this.paint(); return; }
      if (data === "t") { void this.act(() => this.history(id, work.threadId)); return; }
      if (data === "f") { this.form("Follow up on this thread", { kind: "thread-send", work }); return; }
      if (data === "s") {
        this.confirm("Steer this thread?", `Thread ${work.threadId}. The host records the replacement before interrupting existing work. Scope and frozen model stay unchanged.`, "Compose replacement", async () => this.form("Steer thread", { kind: "thread-steer", work }), true);
        return;
      }
      if (data === "x") {
        this.confirm("Stop this thread?", `Thread ${work.threadId}. Conversation, partial files and receipts remain.`, "Stop thread", async () => { await request({ action: "thread-stop", id, threadId: work.threadId }, false); this.notice = "Thread stop recorded. History and workspace retained."; });
        return;
      }
    }
    const run = worker(item, this.snapshot);
    if (data === "t" && run) { void this.transcript(run); return; }
    if (data === "s" && run && this.snapshot.activeRuns.some(active => active.id === run.id)) { this.form("Steer worker", { kind: "steer", run }); return; }
    if (data === "x" && run && this.snapshot.activeRuns.some(active => active.id === run.id)) {
      this.confirm("Stop this worker?", clean(run.task), "Stop worker", async () => { await request({ action: "control", id: this.snapshot.project.id, run: run.id, operation: "stop" }, false); this.notice = "Stop requested. Partial work remains in the checkout."; });
      return;
    }
    if (this.mode.focus === "detail") {
      if (this.keys.matches(data, "tui.select.confirm") && item?.kind === "evidence") void this.showEvidence(item);
      else this.readKeys(data, this.scroll);
      this.paint(); return;
    }
    if (this.layout === "board" && this.section === "work" && (matchesKey(data, "left") || matchesKey(data, "right"))) {
      this.lane = lanes[(lanes.indexOf(this.lane) + (matchesKey(data, "right") ? 1 : -1) + lanes.length) % lanes.length] ?? "Planned";
      this.selected = undefined; this.scroll.scrollToStart(); this.paint(); return;
    }
    this.list?.handleInput(data === "j" ? "\u001b[B" : data === "k" ? "\u001b[A" : data);
    this.paint();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.pending || this.mode.kind !== "main") return undefined;
    const region = this.regions.find(region => event.x >= region.x && event.x < region.x + region.width && event.y >= region.y && event.y < region.y + region.height);
    if (!region) return undefined;
    if (region.component === this.chat) this.mode.focus = "chat";
    else { this.mode.focus = "list"; if (region.lane) this.lane = region.lane; }
    this.focusEditors();
    const result = region.component.handleMouse({ ...event, x: event.x - region.x, y: event.y - region.y });
    this.paint();
    return result;
  }

  private main(width: number, height: number): string[] {
    const rows = items(this.snapshot, this.section, this.plan, this.section === "inbox" ? this.pendingApprovals : this.approvals);
    if (this.layout === "board" && this.section === "work") return this.board(rows, width, height);
    this.reader.setText(clean(details(this.snapshot, this.current())));
    if (this.layout === "inbox") return this.inbox(rows, width, height);
    if (width < 84) {
      const listHeight = Math.max(3, Math.floor(height * .4));
      const list = this.makeList(rows, listHeight - 3);
      return [...this.box(this.sectionLabel(), list.render(width - 2), width, listHeight, this.mainFocus() === "list"), ...this.detail(width, Math.max(1, height - listHeight))];
    }
    const left = Math.floor(width * .35);
    const list = this.makeList(rows, height - 3);
    this.regions.push({ x: 1, y: 5, width: left - 2, height: height - 2, component: list });
    return this.columns([
      { width: left, lines: this.box(this.sectionLabel(), list.render(left - 2), left, height, this.mainFocus() === "list") },
      { width: width - left - 1, lines: this.detail(width - left - 1, height) },
    ], height);
  }

  private board(rows: Item[], width: number, height: number): string[] {
    const boardHeight = Math.max(3, Math.floor(height * .45));
    const columnWidth = Math.max(1, Math.floor((width - 3) / 4));
    let top: string[];
    if (width < 88) {
      const laneRows = rows.filter(row => row.lane === this.lane);
      const list = this.makeList(laneRows, boardHeight - 3);
      top = this.box(`${this.lane} / ← → lanes`, list.render(width - 2), width, boardHeight, this.mainFocus() === "list");
    } else {
      const columns = lanes.map((lane, i) => {
        const laneRows = rows.filter(row => row.lane === lane);
        const size = i === 3 ? width - 3 - 3 * columnWidth : columnWidth;
        const list = this.makeList(laneRows, boardHeight - 3, lane === this.lane);
        this.regions.push({ x: i * (columnWidth + 1) + 1, y: 5, width: size - 2, height: boardHeight - 2, component: list, lane });
        return { width: size, lines: this.box(`${lane} · ${laneRows.length}`, list.render(size - 2), size, boardHeight, lane === this.lane && this.mainFocus() === "list") };
      });
      top = this.columns(columns, boardHeight);
    }
    this.reader.setText(clean(details(this.snapshot, this.current())));
    return [...top, ...this.detail(width, Math.max(1, height - boardHeight))];
  }

  private inbox(rows: Item[], width: number, height: number): string[] {
    const queueHeight = Math.min(Math.max(3, rows.length + 2), Math.max(3, Math.floor(height * .3)));
    const list = this.makeList(rows, queueHeight - 3);
    const title = this.section === "inbox" ? rows.length ? `${rows.length} decisions/results shown · ${this.pendingApprovals?.total ?? 0} pending approvals · o all records` : this.snapshot.project.runtime === "durable" && !this.pendingApprovals ? "Loading pending approvals" : "Nothing needs your call" : this.sectionLabel();
    if (width < 90) return [...this.box(title, list.render(width - 2), width, queueHeight, this.mainFocus() === "list"), ...this.detail(width, Math.max(1, height - queueHeight))];
    const left = width - 30;
    this.regions.push({ x: 1, y: 5, width: left - 2, height: queueHeight - 2, component: list });
    const queue = this.box(title, list.render(left - 2), left, queueHeight, this.mainFocus() === "list");
    const letter = this.detail(left, Math.max(1, height - queueHeight));
    const reply = this.snapshot.messages.findLast(message => message.role === "assistant" && message.text.trim());
    const background = [...(this.plan ? this.plan.work.filter(work => work.status === "running").map(work => `${work.role}: ${work.text}`) : this.snapshot.activeRuns.map(run => `${run.role}: ${run.task}`)), "", "Coordinator", "", clean(reply?.text ?? "Send any request with /.").slice(0, 200), "", "m  Read conversation", "", "Shared memory", "", clean(this.snapshot.notes.at(-1)?.text ?? "No shared notes yet.").slice(0, 200), "", "p  Switch project", "w  Inspect all work", "e  Evidence", "n  Shared notes"];
    const sidebar = this.box("While you decide", new Text(clean(background.join("\n")), 0, 0).render(27), 29, height, false);
    return this.columns([{ width: left, lines: [...queue, ...letter] }, { width: 29, lines: sidebar }], height);
  }

  private detail(width: number, height: number): string[] { return this.box("Inspector · Tab to scroll", this.viewport(this.scroll, Math.max(1, width - 2), Math.max(1, height - 2)), width, height, this.mainFocus() === "detail"); }
  private current(): Item | undefined { const rows = items(this.snapshot, this.section, this.plan, this.section === "inbox" ? this.pendingApprovals : this.approvals).filter(item => this.layout !== "board" || this.section !== "work" || item.lane === this.lane); return rows.find(item => item.key === this.selected) ?? rows[0]; }
  private mainFocus(): "list" | "detail" | "chat" { return this.mode.kind === "main" ? this.mode.focus : "list"; }
  private sectionLabel(): string { return ({ work: "All work", inbox: "Needs you · o all approvals", approvals: this.approvals ? `Approvals ${this.approvals.offset + (this.approvals.items.length ? 1 : 0)}-${this.approvals.offset + this.approvals.items.length}/${this.approvals.total} · [ / ] pages` : "No Durable approval records", evidence: "Captured evidence", notes: "Shared notes", activity: "Coordinator requests", conversation: "Coordinator conversation" })[this.section]; }

  private makeList(rows: Item[], count: number, active = true): SelectList {
    const list = new SelectList(rows.map(item => ({ value: item.key, label: clean(`${item.state} / ${item.title}`) })), Math.max(1, count), this.listTheme(active), { maxPrimaryColumnWidth: 10000 });
    const key = active ? this.current()?.key : undefined;
    if (active) this.selected = key;
    list.setSelectedIndex(Math.max(0, rows.findIndex(item => item.key === key)));
    list.onSelectionChange = item => { this.selected = item.value; this.scroll.scrollToStart(); this.paint(); };
    list.onSelect = selected => {
      this.selected = selected.value;
      const item = rows.find(item => item.key === selected.value);
      if (item?.kind === "evidence") void this.showEvidence(item);
      else if (item?.kind === "entry" && item.entry.kind === "question") this.answerMenu(item.entry);
      else { this.mode = { kind: "main", focus: "detail" }; this.paint(); }
    };
    if (active) this.list = list;
    return list;
  }

  private changeLayout(layout: Layout): void {
    const item = this.current();
    this.layout = layout;
    if (layout === "inbox") this.section = "inbox";
    else this.section = "work";
    this.selected = item?.key;
    this.lane = item?.lane ?? "Needs you";
    this.mode = { kind: "main", focus: "list" };
    this.saveLayout(layout); this.paint();
  }

  private answerMenu(entry: Extract<InboxEntry, { kind: "question" }>): void {
    const options = entry.choices.map((label, i) => ({ value: String(i), label: clean(label) }));
    options.push({ value: "custom", label: "Write a different answer" });
    const list = new SelectList(options, 6, this.listTheme());
    list.onSelect = item => {
      if (item.value === "custom") this.form("Answer the coordinator", { kind: "answer", entry });
      else {
        const text = entry.choices[Number(item.value)];
        if (text) void this.act(async () => { await request({ action: "answer", id: this.snapshot.project.id, entry: entry.id, text }, false); this.mode = { kind: "main", focus: "list" }; this.notice = this.snapshot.project.runtime === "durable" ? "Answer recorded. Pause and execution authority are unchanged." : "Answer recorded in shared notes. Coordinator notified."; });
      }
    };
    this.menu("Answer the coordinator", entry.question, list);
  }

  private form(title: string, target: Target): void {
    const id = this.snapshot.project.id;
    const targetId = target.kind === "answer" || target.kind === "revise" ? target.entry.id : target.kind === "steer" ? target.run.id : target.work.threadId;
    const draftKey = `${id}:${target.kind}:${targetId}`;
    if (!this.formDrafts.has(draftKey)) this.formDrafts.set(draftKey, { text: "", requestId: randomUUID(), submittedText: null });
    const editor = this.editor();
    editor.setText(this.formDrafts.get(draftKey)?.text ?? "");
    editor.onSubmit = text => {
      if (!text.trim() || this.pending) return;
      void this.act(async () => {
        const draft = this.formDrafts.get(draftKey);
        if (!draft || this.snapshot.project.id !== id) throw new Error("Form project changed; reopen the intended target");
        const threaded = target.kind === "thread-send" || target.kind === "thread-steer";
        if (threaded && draft.submittedText !== null && draft.submittedText !== text) throw new Error("Prior thread submission is unresolved. Resend its exact text or inspect history before creating a different request");
        draft.text = text;
        if (threaded) draft.submittedText = text;
        let input: Request;
        switch (target.kind) {
          case "answer": input = { action: "answer", id, entry: target.entry.id, text }; break;
          case "revise": input = { action: "review", id, entry: target.entry.id, operation: "revise", text }; break;
          case "steer": input = { action: "control", id, run: target.run.id, operation: "steer", message: text }; break;
          case "thread-send":
          case "thread-steer": input = { action: target.kind, id, threadId: target.work.threadId, requestId: draft.requestId, text }; break;
          default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
        }
        if (threaded) this.saveDrafts();
        await request(input, false);
        if (this.formDrafts.get(draftKey) === draft) {
          if (draft.text === text) this.formDrafts.delete(draftKey);
          else this.formDrafts.set(draftKey, { text: draft.text, requestId: randomUUID(), submittedText: null });
        }
        if (!this.closed) { this.mode = { kind: "main", focus: "list" }; this.notice = "Instruction recorded by the host."; }
      });
    };
    this.mode = { kind: "form", title, editor, draftKey }; this.paint();
  }

  private routinesPanel(): void {
    if (this.snapshot.project.runtime !== "durable") { this.notice = "Routine controls require a Durable project. No migration is performed here."; this.paint(); return; }
    const panel = new RoutinesScreen({ project: this.snapshot.project, keys: this.keys, theme: this.listTheme(), height: () => Math.max(1, this.pageHeight - 1),
      paint: () => this.paint(), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); },
    });
    this.mode = { kind: "panel", title: "Retained routines and separately confirmed toggles", panel }; this.paint();
  }

  private githubPanel(): void {
    if (this.snapshot.project.runtime !== "durable") { this.notice = "Native provider receipts require a Durable project. Arc adapter remains deferred."; this.paint(); return; }
    const panel = new GithubScreen({ project: this.snapshot.project, keys: this.keys, theme: this.listTheme(), height: () => Math.max(1, this.pageHeight - 1),
      paint: () => this.paint(), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); },
    });
    this.mode = { kind: "panel", title: "GitHub native receipts and explicit inspections", panel }; this.paint();
  }

  private ownerSetupPanel(): void {
    const panel = new OwnerSetupScreen({ projectId: this.snapshot.project.id, tui: this.tui, keys: this.keys, theme: this.listTheme(), borderColor: text => this.theme.fg("borderAccent", text), height: () => Math.max(1, this.pageHeight - 1), paint: () => this.paint(), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); } });
    this.mode = { kind: "panel", title: "Owner workspace and authority setup", panel }; this.paint();
  }

  private settingsPanel(): void {
    if (this.snapshot.project.runtime !== "durable") { this.notice = "Mutable settings require an explicit Durable migration."; this.paint(); return; }
    const panel = new SettingsScreen({ projectId: this.snapshot.project.id, tui: this.tui, keys: this.keys, theme: this.listTheme(), borderColor: text => this.theme.fg("borderAccent", text), drafts: this.settingsDrafts,
      height: () => Math.max(1, this.pageHeight - 1), paint: () => this.paint(), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); },
    });
    this.mode = { kind: "panel", title: "Project settings", panel }; this.paint();
  }

  private lifecycle(): void {
    const project = this.snapshot.project, id = project.id;
    if (project.runtime !== "durable" || !this.plan) { this.notice = "Lifecycle controls require a loaded Durable plan. r refreshes."; this.paint(); return; }
    const options = project.archived || project.deleted ? [{ value: "restore", label: "Restore retained project, remain paused" }]
      : [{ value: "pause", label: "Pause coordinator, workers and automatic admission" }, { value: "resume", label: "Resume and continue work the pause interrupted" }, { value: "archive", label: "Archive project, retain all work" }, { value: "delete", label: "Delete project from listing, retain all work" }];
    const list = new SelectList([{ value: "cancel", label: "Cancel, leave unchanged" }, ...options], 6, this.listTheme());
    list.onSelect = item => {
      if (item.value === "cancel") { this.mode = { kind: "main", focus: "list" }; this.paint(); return; }
      let input: Request, consequence: string;
      switch (item.value) {
        case "pause": input = { action: "pause", id }; consequence = "Stop admission and cancel owned active work. Partial repository work, conversations and receipts remain."; break;
        case "resume": input = { action: "resume", id, recovery: "leave-interrupted", confirm: id }; consequence = "Resume the project. Work the pause interrupted restarts on the same threads and worktrees; stopped and failed work stays as it is."; break;
        case "archive": input = { action: "archive", id }; consequence = "Pause and archive. Retain conversations, receipts, workspaces and remote PRs. No checkout cleanup or remote deletion."; break;
        case "delete": input = { action: "delete", id, confirm: id }; consequence = "Pause and remove this project from ordinary listing. Retain its data, repository work and remote PRs. No filesystem or provider cleanup."; break;
        case "restore": input = { action: "restore", id }; consequence = "Restore retained project metadata. The project remains paused; this does not resume or replay work."; break;
        default: throw new Error("Unknown lifecycle selection");
      }
      this.confirm(`Confirm ${item.value}?`, `Project ${clean(project.name)}\nID ${id}\n${consequence}`, `Confirm ${item.value}`, async () => {
        const result = await request(input, false);
        if (!this.closed) this.view("Lifecycle host response", new Text(clean(JSON.stringify(result, null, 2) ?? "No readable response; inspect project state before further action."), 0, 0));
        this.notice = "Lifecycle response recorded. Repository work and remote PRs were not cleaned up.";
      }, true);
    };
    this.menu("Project lifecycle", `Project ${clean(project.name)}\nID ${id}\n${project.deleted ? "Retained deletion" : project.archived ? "Archived" : this.plan.pausing ? "Pausing" : this.plan.paused ? "Paused" : "Active"}\nEvery change requires a separate confirmation. Closing the screen never pauses the project.`, list);
  }

  private async usage(id: string, offset = 0): Promise<void> {
    if (this.snapshot.project.runtime !== "durable") throw new Error("Owner-backed usage requires a Durable project");
    const page = parse(NativeUsage, await request({ action: "usage-snapshot", id, offset, limit: 100 }, false));
    if (this.closed || this.snapshot.project.id !== id) return;
    const coordinatorId = this.snapshot.durableInspection?.identity.coordinatorConversationId;
    if (page.offset !== offset || coordinatorId !== undefined && page.coordinator.conversationId !== coordinatorId) throw new Error("Usage page does not match the selected owned coordinator");
    const counters = (value: NativeUsage["workerPageTotal"]) => `tokens ${value.totalTokens} · input ${value.input} · output ${value.output} · cache read ${value.cacheRead} · cache write ${value.cacheWrite} · SDK estimated cost ${value.cost.total}`;
    const buckets = (value: NativeUsage["coordinator"]) => [...Object.entries(value.models).map(([model, usage]) => `Model ${model}\n${counters(usage)}`), ...Object.entries(value.tools).map(([tool, usage]) => `Tool ${tool}\n${counters(usage)}`)].join("\n\n") || "No recorded model/tool usage.";
    const text = `Observed ${new Date(page.observedAtMs).toLocaleString()}\n[ / ] worker pages · r reread this page\n\n${page.accounting}\n\nCoordinator conversation ${page.coordinator.conversationId}\n${counters(page.coordinator.total)}\n${buckets(page.coordinator)}${(page.chats ?? []).map(chat => `\n\nChat ${chat.title}${chat.archived ? " (archived)" : ""} conversation ${chat.conversationId}\n${counters(chat.total)}`).join("")}\n\nWorker page ${page.offset + (page.workers.length ? 1 : 0)}-${page.offset + page.workers.length}/${page.totalWorkers}\nRegistered reusable threads ${page.totalThreads}; legacy-only workers ${page.legacyOnlyWorkers}\nPAGE-ONLY worker total: ${counters(page.workerPageTotal)}\n\n${page.workers.map(worker => `${worker.kind === "thread" ? `Thread ${worker.threadId}` : `Retained legacy worker ${worker.name}`}\nConversation ${worker.conversationId}\nLegacy names: ${worker.legacyNames.join(", ") || "none"}\n${counters(worker.total)}\n${buckets(worker)}`).join("\n\n")}`;
    this.mode = { kind: "usage", title: "Owner-backed usage, live SDK estimates", projectId: id, page, scroll: new ScrollView(new Text(clean(text), 0, 0), { scrollbar: "hidden" }) };
    this.paint();
  }

  private knowledge(): void {
    const panel = new KnowledgeScreen({ projectId: this.snapshot.project.id, tui: this.tui, keys: this.keys, theme: this.listTheme(), borderColor: text => this.theme.fg("borderAccent", text), drafts: this.knowledgeDrafts, pathDrafts: this.knowledgePathDrafts,
      paint: () => this.paint(), height: () => Math.max(1, this.pageHeight - 1), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); },
    });
    this.mode = { kind: "panel", title: "Project knowledge", panel }; this.paint();
  }

  private upload(): void {
    if (this.snapshot.project.archived || this.snapshot.project.deleted) { this.notice = "Restore the retained project before importing references."; this.paint(); return; }
    if (this.mode.kind === "panel") this.mode.panel.dispose();
    const panel = new UploadScreen({ projectId: this.snapshot.project.id, tui: this.tui, keys: this.keys, theme: this.listTheme(), borderColor: text => this.theme.fg("borderAccent", text), drafts: this.uploadDrafts, persist: () => this.saveDrafts(),
      height: () => Math.max(1, this.pageHeight - 1), paint: () => this.paint(), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); },
    });
    this.mode = { kind: "panel", title: "Confirmed reference import", panel }; this.paint();
  }

  private library(): void {
    const panel = new LibraryScreen({ projectId: this.snapshot.project.id, upload: () => this.upload(), keys: this.keys, theme: this.listTheme(), fallbackColor: text => this.theme.fg("muted", text), height: () => Math.max(1, this.pageHeight - 1),
      paint: () => this.paint(), exit: () => { this.mode = { kind: "main", focus: "list" }; this.paint(); },
    });
    this.mode = { kind: "panel", title: "Project library", panel }; this.paint();
  }

  private operationControl(record: NativeOperation, key: string): void {
    if (this.snapshot.project.archived || this.snapshot.project.deleted) { this.notice = "Restore the retained project before deciding or executing operations."; this.paint(); return; }
    const id = this.snapshot.project.id;
    if (record.projectId !== id) { this.notice = "Approval is not owned by the selected project."; this.paint(); return; }
    const operation = record.operation;
    if (!record.scopeCurrent) { this.notice = "Approval scope changed. Request a new bound intent; this record cannot authorize execution."; this.paint(); return; }
    const binding = `Project ${id}\nOperation ${record.id}\nFingerprint ${record.fingerprint}\n${JSON.stringify(operation, null, 2)}`;
    if (key === "g" || key === "h") {
      if (record.status !== "approved" || record.executionApproved !== true || operation.provider !== "github" || operation.kind !== "merge") { this.notice = "Only a separately executable, exact-head GitHub merge can run here. Arc, auto-merge and command execution are unavailable in this control."; this.paint(); return; }
      const inspect = key === "h";
      this.confirm(inspect ? "Inspect original merge outcome?" : "Execute this exact-head merge?", `${binding}\n${inspect ? "Read matching retained evidence only. Missing evidence stays uncertain. No merge, replay or new retry permission." : "This can change the remote repository. The executor rechecks scope and head; uncertain effects are never replayed automatically."}`, inspect ? "Inspect original outcome only" : "Execute bound merge", async () => {
        const identity = { id, operationId: record.id, fingerprint: record.fingerprint, confirm: id };
        const result = await request(inspect ? { action: "operation-inspect", ...identity } : { action: "operation-execute", ...identity }, false);
        if (!this.closed && this.snapshot.project.id === id) this.view(inspect ? "Original bound outcome, no retry permission" : "Bound executor response, inspect outcome", new Text(clean(JSON.stringify(result, null, 2) ?? "No readable receipt returned. Outcome remains unproven."), 0, 0));
      }, true);
      return;
    }
    if (record.status !== "pending") { this.notice = "This decision is immutable; it cannot be upgraded or overwritten."; this.paint(); return; }
    if (key === "y" && (operation.provider === "arc" || operation.kind === "auto-merge")) { this.notice = "Executable approval is unavailable here for deferred Arc or auto-merge."; this.paint(); return; }
    const reject = key === "c", executable = key === "y";
    this.confirm(reject ? "Reject this operation?" : executable ? "Permit this exact executor?" : "Approve record only?", `${binding}\n${executable ? "This authorizes the exact bound executor, including its recorded effect. It does not execute it here." : "This records a decision only. It does not grant execution or perform a remote effect."}`, reject ? "Reject" : executable ? "Permit exact executor" : "Approve without execution", async () => {
      const identity = { id, operationId: record.id, fingerprint: record.fingerprint };
      await request(reject ? { action: "operation-decide", ...identity, decision: "reject" } : { action: "operation-decide", ...identity, decision: "approve", confirm: id, ...(executable ? { execution: true } : {}) }, false);
      this.notice = reject ? "Rejection recorded." : executable ? "Exact executable approval recorded. No operation executed." : "Plain approval recorded. Execution remains unapproved.";
    });
  }

  private checkpointDrafts(): void {
    this.rememberForm(); this.drafts.set(this.snapshot.project.id, this.chat.getExpandedText());
    try {
      this.saveDrafts();
      if (this.notice.startsWith("Draft persistence failed:")) this.notice = "Native draft snapshot recorded in the current Pi session. No actions replayed.";
    }
    catch (error) { this.notice = `Draft persistence failed: ${errorText(error)}. In-memory drafts retained; no truncation or replay.`; }
  }

  private rememberForm(): void {
    if (this.mode.kind !== "form") return;
    const draft = this.formDrafts.get(this.mode.draftKey);
    if (draft) draft.text = this.mode.editor.getExpandedText();
  }

  private confirm(title: string, hint: string, label: string, action: () => Promise<void>, keepMode = false): void {
    const list = new SelectList([{ value: "cancel", label: "Cancel, leave unchanged" }, { value: "confirm", label }], 3, this.listTheme());
    list.onSelect = item => {
      if (item.value === "cancel") { this.mode = { kind: "main", focus: "list" }; this.paint(); }
      else void this.act(async () => { await action(); if (!this.closed && !keepMode) this.mode = { kind: "main", focus: "list" }; });
    };
    this.menu(title, hint, list);
  }

  private menu(title: string, hint: string, list: SelectList): void {
    this.mode = { kind: "menu", title, hint: new ScrollView(new Text(clean(hint), 0, 0), { scrollbar: "hidden" }), list, focus: "choices" };
    this.paint();
  }

  private async chooseProject(): Promise<void> {
    await this.act(async () => {
      const projects = parse(Type.Array(Project), await request({ action: "list" }, false));
      const list = new SelectList([{ value: "known-project", label: "Open known retained project UUID", description: "Includes deleted projects; restore/resume stay separate" }, ...projects.map(p => ({ value: p.id, label: clean(p.name), description: clean(p.cwd) }))], Math.max(2, Math.min(12, this.tui.terminal.rows - 12)), this.listTheme());
      list.onSelect = item => {
        if (item.value === "known-project") this.retainedProjectForm();
        else void this.act(() => this.switchProject(parse(Project.properties.id, item.value)));
      };
      this.menu("Switch project", "Choose an ordinary project or explicitly enter a known owned UUID. Attachment does not restore/resume retained inactive projects.", list);
    });
  }

  private retainedProjectForm(): void {
    const draftKey = `${this.snapshot.project.id}:retained-project`;
    const draft = this.formDrafts.get(draftKey) ?? { text: "", requestId: randomUUID(), submittedText: null };
    this.formDrafts.set(draftKey, draft);
    const editor = this.editor(); editor.setText(draft.text);
    editor.onSubmit = text => {
      draft.text = text;
      void this.act(async () => {
        const id = parse(Project.properties.id, text.trim());
        this.saveDrafts();
        await this.switchProject(id);
      });
    };
    this.mode = { kind: "form", title: "Known owned project UUID. Open only; P restores separately while paused.", editor, draftKey };
    this.paint();
  }

  private async switchProject(id: string): Promise<void> {
    const previous = this.snapshot.project.id, text = this.chat.getExpandedText();
    this.rememberForm(); this.drafts.set(previous, text); this.saveDrafts();
    const snapshot = await this.selectProject(id);
    if (this.closed) return;
    if (snapshot.project.id !== id) throw new Error("Project selection returned a different owned UUID");
    this.refreshEpoch++; this.snapshot = snapshot; this.plan = undefined; this.approvals = undefined; this.pendingApprovals = undefined; this.approvalOffset = 0; this.selected = undefined; this.scroll.scrollToStart();
    this.mode = { kind: "main", focus: "list" }; this.chat.setText(this.drafts.get(id) ?? ""); this.connection = null;
    this.notice = snapshot.project.deleted || snapshot.project.archived ? "Retained project opened, not restored/resumed. P offers explicit paused restore." : "Project switched. Coordinator prompt now targets this project.";
  }

  private async history(id: string, threadId: string, offset = 0, textOffset = 0): Promise<void> {
    const page = parse(NativeHistory, await request({ action: "thread-history", id, threadId, offset, limit: 30, textOffset, textLimit: 4000 }, false));
    if (this.closed || this.snapshot.project.id !== id) return;
    if (page.threadId !== threadId) throw new Error("History returned a different owned thread");
    const text = `Thread ${threadId}\nConversation ${page.conversationId}\nMessages ${page.offset + (page.items.length ? 1 : 0)}-${page.offset + page.items.length} of ${page.total}\nText slice starts at Unicode character ${textOffset}\n[ / ] previous / next message page\n{ / } previous / next text slice\n\n${page.items.map(message => `${message.role} · entry ${message.id} · ${new Date(message.at).toLocaleString()}\n${message.text}${message.nextTextOffset === null ? "" : `\n[Text continues at character ${message.nextTextOffset}; press } to read more.]`}`).join("\n\n")}`;
    this.mode = { kind: "history", title: "Owned thread history", projectId: id, textOffset, page, scroll: new ScrollView(new Text(clean(text), 0, 0), { scrollbar: "hidden" }) };
    this.paint();
  }

  private async transcript(run: Run): Promise<void> {
    await this.act(async () => { const text = nativeText(await request({ action: "workers", id: this.snapshot.project.id, run: run.id }, false)); if (!this.closed) this.view("Worker transcript", new Text(clean(text), 0, 0)); });
  }
  private async showEvidence(item: Extract<Item, { kind: "evidence" }>): Promise<void> {
    await this.act(async () => {
      const data = await readEvidence(projectDir(this.snapshot.project.id), item.evidence.id);
      if (this.closed) return;
      const content = data.mime.startsWith("image/") ? new Image(data.bytes.toString("base64"), data.mime, { fallbackColor: text => this.theme.fg("muted", text) }, { filename: clean(data.record.filename), maxHeightCells: Math.max(2, this.pageHeight - 4) })
        : new Text(`${clean(data.record.filename)}\nSHA-256 ${data.record.sha256}\n\n${clean(data.bytes.subarray(0, 64000).toString("utf8"))}${data.bytes.length > 64000 ? "\n\nPreview limited to 64 KB." : ""}`, 0, 0);
      this.view("Hash-checked evidence", content);
    });
  }
  private view(title: string, component: Component): void { this.mode = { kind: "viewer", title, scroll: new ScrollView(component, { scrollbar: "hidden" }) }; this.paint(); }
  private help(): void { this.view("Projects controls", new Text("Durable thread history and controls are implementation-only, unverified.\n\n1 / 2 / 3     Switch layout without leaving Pi\nw / i         Work / decision inbox\ne / n / l     Evidence / notes / coordinator requests\nK             Browse/edit managed knowledge and inspect history\nL             Paged hash-pinned library, verified images and byte previews\nA             Confirmed UTF-8/base64 reference upload, at most 32 KiB\nU             Owner-backed usage, [ / ] pages, r rereads\nP             Confirmed pause/resume/archive/restore/retained delete\nS             Confirmed settings, role defaults, grants and hard worker cap\nO             Owner workspace, GitHub, fixed-profile and skill setup\nG             GitHub PR/CI/review/publication receipts and pinned inspection\nR             Retained schedules/monitors and separately confirmed toggles\no             All approval records, [ / ] to page\nv / y / c     Plain approval / executable approval / reject\ng / h         Execute approved merge / inspect original outcome\nm             Read the coordinator conversation\np             Switch project\nr             Reconnect and refresh\n/             Focus the coordinator prompt\nTab           List → inspector → coordinator prompt\n↑↓ or j / k   Select items\n← →           Board lanes\nEnter         Inspect a result or answer a question\na             Answer the selected question\nv / c         Accept review / request changes\nt             Read the worker transcript\ns / x         Steer / stop the selected worker or Durable thread\nf             Follow up on a selected Durable thread\n[ / ]         Previous / next thread history message page\n{ / }         Previous / next thread history text slice\nPgUp/PgDn     Scroll the inspector or evidence viewer\nEsc           Return to the list, then close the screen\n\nAll actions target the live Projects host.\nStop and review acceptance require confirmation.\nClosing the screen keeps the coordinator and workers running.\nDurable workers use only owner-authorized scoped workspaces.\nThere is no manual board status editing.", 0, 0)); }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.pending || this.closed) return;
    this.pending = true; this.paint();
    try { await action(); if (!this.closed) await this.refresh(); }
    catch (error) { if (!this.closed) this.notice = `Action failed: ${errorText(error)}. Draft retained; no automatic replay.`; }
    finally { this.pending = false; this.paint(); }
  }
  private async refresh(start = false): Promise<void> {
    const id = this.snapshot.project.id;
    const epoch = this.refreshEpoch, approvalOffset = this.approvalOffset;
    if (this.closed || this.fetching?.id === id && this.fetching.epoch === epoch && this.fetching.approvalOffset === approvalOffset) return;
    const fetching = { id, epoch, approvalOffset };
    this.fetching = fetching;
    try {
      const [snapshot, plan, approvals, pendingApprovals] = await Promise.all([
        request({ action: "show", id }, start).then(value => parse(Snapshot, value)),
        this.snapshot.project.runtime === "durable" ? request({ action: "plan-snapshot", id }, false).then(value => parse(NativePlan, value)) : Promise.resolve(undefined),
        this.snapshot.project.runtime === "durable" ? request({ action: "operation-snapshot", id, offset: approvalOffset, limit: 100 }, false).then(value => parse(NativeOperations, value)) : Promise.resolve(undefined),
        this.snapshot.project.runtime === "durable" ? request({ action: "operation-snapshot", id, status: "pending", offset: 0, limit: 100 }, false).then(value => parse(NativeOperations, value)) : Promise.resolve(undefined),
      ]);
      if (this.closed || this.snapshot.project.id !== id || this.refreshEpoch !== epoch || this.approvalOffset !== approvalOffset) return;
      if (approvals && (approvals.offset !== approvalOffset || approvals.items.some(record => record.projectId !== id))) throw new Error("Approval page does not match the selected project and offset");
      if (pendingApprovals && (pendingApprovals.offset !== 0 || pendingApprovals.items.some(record => record.projectId !== id || record.status !== "pending"))) throw new Error("Pending approval page does not match the selected project/filter");
      this.snapshot = snapshot; this.plan = plan; this.approvals = approvals; this.pendingApprovals = pendingApprovals; this.connection = null;
    } catch (error) { if (!this.closed && this.snapshot.project.id === id && this.refreshEpoch === epoch) this.connection = `Disconnected: ${errorText(error)}. Drafts kept. r reconnects.`; }
    finally { if (this.fetching === fetching) this.fetching = undefined; this.paint(); }
  }

  private editor(): Editor { return new Editor(this.tui, { borderColor: text => this.theme.fg("borderAccent", text), selectList: this.listTheme() }, { paddingX: 1 }); }
  private focusEditors(): void { if (this.mode.kind === "panel") this.mode.panel.focused = this.hasFocus; this.chat.focused = this.hasFocus && this.mode.kind === "main" && this.mode.focus === "chat"; if (this.mode.kind === "form") this.mode.editor.focused = this.hasFocus; }
  private paint(): void { if (!this.closed) { this.focusEditors(); this.tui.requestRender(); } }
  private readKeys(data: string, scroll: ScrollView): void {
    if (this.keys.matches(data, "tui.select.up") || data === "k") scroll.scrollBy(-1);
    else if (this.keys.matches(data, "tui.select.down") || data === "j") scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) scroll.scrollBy(-this.pageHeight);
    else if (matchesKey(data, "pageDown")) scroll.scrollBy(this.pageHeight);
    else if (matchesKey(data, "home")) scroll.scrollToStart();
    else if (matchesKey(data, "end")) scroll.scrollToEnd();
  }
  private viewport(scroll: ScrollView, width: number, height: number): string[] { const lines = scroll.render(Math.max(1, width)); scroll.updateLayout(lines.length, Math.max(1, height), () => this.paint()); return lines.slice(scroll.scrollTop, scroll.scrollTop + Math.max(1, height)); }
  private fit(line: string, width: number): string { return truncateToWidth(line, Math.max(1, width), ""); }
  private pad(line: string, width: number): string { const fit = this.fit(line, width); return fit + " ".repeat(Math.max(0, width - visibleWidth(fit))); }
  private box(title: string, lines: string[], width: number, height: number, active: boolean): string[] {
    const inner = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg(active ? "borderAccent" : "borderMuted", text);
    if (height < 3) return [this.fit(`${title}: ${lines[0] ?? ""}`, width), ...lines].slice(0, height);
    return [border("╭") + border(this.pad(` ${clean(title)} `, inner)) + border("╮"), ...Array.from({ length: height - 2 }, (_, i) => border("│") + this.pad(lines[i] ?? "", inner) + border("│")), border("╰" + "─".repeat(inner) + "╯")];
  }
  private columns(columns: { width: number; lines: string[] }[], height: number): string[] { return Array.from({ length: height }, (_, row) => columns.map(column => this.pad(column.lines[row] ?? "", column.width)).join(" ")); }
  private listTheme(active = true): SelectListTheme { return { selectedPrefix: text => this.theme.fg(active ? "accent" : "muted", text), selectedText: text => active ? this.theme.bg("selectedBg", this.theme.fg("accent", text)) : this.theme.fg("muted", text), description: text => this.theme.fg("muted", text), scrollInfo: text => this.theme.fg("dim", text), noMatch: () => this.theme.fg("muted", "  Nothing here yet.") }; }
}

function nativeText(value: unknown): string {
  return parse(NativeText, value).text;
}
