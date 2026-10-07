import { createHash } from "node:crypto";
import { Image, ScrollView, SelectList, Text, matchesKey, type Component, type Focusable, type KeybindingsManager, type SelectListTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { request } from "./client.ts";
import { clean } from "./project-items.ts";
import { Evidence, errorText, parse } from "./state.ts";

const Page = Type.Object({ items: Type.Array(Evidence), total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) });
const Chunk = Type.Object({ record: Evidence, mime: Type.String(), encoding: Type.Literal("base64"), data: Type.String({ maxLength: 174764 }), offset: Type.Integer({ minimum: 0 }), chunkSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) });
type Mode = { kind: "list"; list: SelectList; offset: number; page: ReturnType<typeof readPage> }
  | { kind: "preview"; record: Evidence; offset: number; nextOffset: number | null; scroll: ScrollView }
  | { kind: "image"; record: Evidence; scroll: ScrollView };
function readPage(value: unknown) { return parse(Page, value); }
function hash(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
const chunkLimit = 131072;

export class LibraryScreen implements Component, Focusable {
  focused = false;
  private mode: Mode;
  private closed = false;
  private busy = false;
  private notice = "Enter opens hash-pinned evidence. [ / ] page · r refresh · Esc back.";
  private listOffset = 0;
  constructor(private input: { projectId: string; upload: () => void; keys: KeybindingsManager; theme: SelectListTheme; fallbackColor: (text: string) => string; height: () => number; paint: () => void; exit: () => void }) {
    this.mode = { kind: "list", list: this.list([]), offset: 0, page: { items: [], total: 0, nextOffset: null } };
    void this.act(() => this.browse(0));
  }
  invalidate() { if (this.mode.kind === "list") this.mode.list.invalidate(); else this.mode.scroll.invalidate(); }
  dispose() { this.closed = true; }
  render(width: number): string[] {
    const height = Math.max(1, this.input.height()), mode = this.mode;
    let lines: string[];
    if (mode.kind === "list") lines = [`Library ${mode.offset + (mode.page.items.length ? 1 : 0)}-${mode.offset + mode.page.items.length}/${mode.page.total}`, "[ / ] pages · Enter inspect · u upload · r refresh", ...mode.list.render(width)];
    else {
      const content = mode.scroll.render(width), room = Math.max(1, height - 3);
      mode.scroll.updateLayout(content.length, room, this.input.paint);
      lines = [clean(mode.record.filename), mode.kind === "image" ? "Full image hash checked · Esc returns to list" : "[ / ] previous / next bytes · Esc returns to list", ...content.slice(mode.scroll.scrollTop, mode.scroll.scrollTop + room)];
    }
    return [...lines.slice(0, Math.max(0, height - 1)), clean(this.busy ? "Reading pinned library artifact… Esc closes this panel." : this.notice)];
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || this.input.keys.matches(data, "app.interrupt")) {
      if (this.busy || this.mode.kind === "list") { this.dispose(); this.input.exit(); }
      else void this.act(() => this.browse(this.listOffset));
      return;
    }
    if (this.busy) return;
    const mode = this.mode;
    if (mode.kind === "list") {
      if (data === "u") this.input.upload();
      else if (data === "r") void this.act(() => this.browse(mode.offset));
      else if (data === "[") void this.act(() => this.browse(Math.max(0, mode.offset - 100)));
      else if (data === "]" && mode.page.nextOffset !== null) void this.act(() => this.browse(mode.page.nextOffset ?? mode.offset));
      else mode.list.handleInput(data);
    } else {
      if (mode.kind === "preview" && data === "[") void this.act(() => this.preview(mode.record, Math.max(0, mode.offset - chunkLimit)));
      else if (mode.kind === "preview" && data === "]" && mode.nextOffset !== null) void this.act(() => this.preview(mode.record, mode.nextOffset ?? mode.offset));
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
  private async browse(offset: number) {
    const page = readPage(await request({ action: "library-list", id: this.input.projectId, offset, limit: 100 }, false));
    if (page.items.some(record => record.native && record.native.projectId !== this.input.projectId)) throw new Error("Artifact provenance belongs to another project");
    if (page.items.length > 100 || page.nextOffset !== null && page.nextOffset !== offset + page.items.length) throw new Error("Invalid library continuation");
    if (this.closed) return;
    const list = this.list(page.items.map(record => ({ value: record.id, label: clean(`${record.title} · ${record.filename} · ${record.size} bytes`) })));
    list.onSelect = item => {
      const record = page.items.find(record => record.id === item.value);
      if (record) void this.act(() => this.preview(record, 0));
    };
    this.listOffset = offset; this.mode = { kind: "list", list, offset, page };
  }
  private async chunk(record: Evidence, offset: number) {
    if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > 10485760) throw new Error("Artifact size is outside the bounded native viewer");
    if (record.native && record.native.projectId !== this.input.projectId) throw new Error("Artifact is not owned by this project");
    const value = parse(Chunk, await request({ action: "library-read", id: this.input.projectId, evidenceId: record.id, expectedSha256: record.sha256, offset, limit: chunkLimit }, false));
    const bytes = Buffer.from(value.data, "base64");
    const end = offset + bytes.length;
    if (JSON.stringify(value.record) !== JSON.stringify(record) || value.offset !== offset || bytes.toString("base64") !== value.data || bytes.length !== Math.min(chunkLimit, record.size - offset) || hash(bytes) !== value.chunkSha256 || value.nextOffset !== (end < record.size ? end : null)) throw new Error("Library chunk does not match its pinned identity, bytes or continuation");
    return { ...value, bytes };
  }
  private async preview(record: Evidence, offset: number) {
    const first = await this.chunk(record, offset);
    if (this.closed) return;
    if (offset === 0 && ["image/png", "image/jpeg", "image/webp"].includes(first.mime)) {
      const chunks = [first.bytes];
      let next = first.nextOffset;
      while (next !== null) {
        if (this.closed) return;
        const chunk = await this.chunk(record, next);
        if (chunk.mime !== first.mime) throw new Error("Artifact MIME changed during image read");
        chunks.push(chunk.bytes); next = chunk.nextOffset;
      }
      if (this.closed) return;
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== record.size || hash(bytes) !== record.sha256) throw new Error("Full image does not match the pinned artifact hash");
      const image = new Image(bytes.toString("base64"), first.mime, { fallbackColor: this.input.fallbackColor }, { filename: clean(record.filename), maxHeightCells: Math.max(2, this.input.height() - 4) });
      this.mode = { kind: "image", record, scroll: new ScrollView(image, { scrollbar: "hidden" }) };
      this.notice = `Full image SHA-256 ${record.sha256}`;
      return;
    }
    if (offset === 0 && first.nextOffset === null && hash(first.bytes) !== record.sha256) throw new Error("Full artifact hash does not match");
    let content: string;
    try { content = clean(new TextDecoder("utf-8", { fatal: true }).decode(first.bytes)); }
    catch { content = `This byte range is not complete valid UTF-8. It may be binary or split a code point. Original bytes are shown as base64, without replacement characters.\n\n${first.data}`; }
    const text = `Artifact ${record.id}\nSHA-256 ${record.sha256}\nBytes ${offset}-${offset + first.bytes.length} of ${record.size}\nChunk SHA-256 ${first.chunkSha256}\n${first.nextOffset === null ? "End of artifact" : "More bytes available with ]"}\nNative provenance ${JSON.stringify(record.native ?? null)}\nText previews strip terminal control sequences. Binary or incomplete UTF-8 is shown as base64.\n\n${content}`;
    this.mode = { kind: "preview", record, offset, nextOffset: first.nextOffset, scroll: new ScrollView(new Text(clean(text), 0, 0), { scrollbar: "hidden" }) };
  }
  private async act(action: () => Promise<void>) {
    if (this.busy || this.closed) return;
    this.busy = true; this.input.paint();
    try { await action(); }
    catch (error) { if (!this.closed) this.notice = `Library read failed: ${errorText(error)}. No automatic replay.`; }
    finally { this.busy = false; if (!this.closed) this.input.paint(); }
  }
}
