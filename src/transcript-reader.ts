import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Reads a conversation's entries for display: newest page first, bounded text, images by reference.
 * It touches only the rows of the requested page and never serializes a whole result, so a 1 MB tool result or an inline base64 image costs one row parse.
 */
/** A worker/Job id, optionally followed by its durable child conversation id. */
export const ThreadReference = Type.String({ pattern: "^[a-f0-9-]{36}(/[0-9]+)?$" });
export const PAGE_ENTRIES = 40;
export const TEXT_PREVIEW_CHARS = 4000;
const THINKING_PREVIEW_CHARS = 600,
  ARGS_PREVIEW_CHARS = 500,
  READ_TEXT_MAX = 20_000;

/** The slice of a durable entry the reader looks at. */
export type RawEntry = {
  id: number;
  kind: string;
  origin?: "owner" | "internal";
  data?: unknown;
  model?: readonly { role: string; content?: unknown; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean }[];
  head?: number;
};
/** Where entries come from: the live durable storage, or an archived sqlite file. */
export type TranscriptSource = {
  /** Up to `limit` entries of the conversation with id below `before` (all when undefined), newest first. */
  newest(conversationId: number, before: number | undefined, limit: number): Promise<readonly RawEntry[]> | readonly RawEntry[];
  entry(conversationId: number, entryId: number): Promise<RawEntry | undefined> | RawEntry | undefined;
};

/** Source over a live pi-durable Storage; scans are fork-aware. */
export function storageSource(storage: Pick<Storage, "scanEntries" | "entry">, context: Context): TranscriptSource {
  return {
    async newest(conversationId, before, limit) {
      const query = {
        conversationId: conversationId as ConversationId,
        ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }),
      };
      return (await storage.scanEntries(query, limit, undefined, context)).items as unknown as RawEntry[];
    },
    async entry(conversationId, entryId) {
      return (await storage.entry(conversationId as ConversationId, entryId as EntryId, context))?.entry as unknown as RawEntry | undefined;
    },
  };
}

/** Coordinator-only provenance. Exact legacy matches are bounded to the newest submission page; unknown entries stay unknown. */
export function coordinatorStorageSource(
  storage: Pick<Storage, "scanEntries" | "entry" | "scanSubmissions">,
  context: Context,
  ownerSubmissionIds: readonly number[],
): TranscriptSource {
  const source = storageSource(storage, context);
  const owners = new Set(ownerSubmissionIds);
  return {
    ...source,
    async newest(conversationId, before, limit) {
      const rows = await source.newest(conversationId, before, limit);
      const legacy = rows.filter((row) => row.kind === "pi.user");
      if (!legacy.length) return rows;
      const page = await storage.scanSubmissions(
        { conversationId: conversationId as ConversationId, order: "descending" },
        200,
        undefined,
        context,
      );
      const origins = new Map<number, "owner" | "internal">();
      for (const submission of page.items)
        if (submission.conversationId === conversationId && submission.type === "input" && submission.entry !== undefined)
          origins.set(submission.entry, owners.has(submission.id) ? "owner" : "internal");
      return rows.map((row) => {
        const origin = row.kind === "pi.user" ? origins.get(row.id) : undefined;
        return origin ? { ...row, origin } : row;
      });
    },
  };
}

export type ImageRef = { ref: string; mime: string; bytes: number };
export type TranscriptItem =
  | {
      kind: "message";
      entryId: number;
      role: "user" | "assistant";
      origin?: "owner" | "internal";
      at: number;
      text: string;
      textChars: number;
      truncated: boolean;
      /** Address for `readTranscriptText`. */
      ref: string;
      thinking?: string;
      images: ImageRef[];
    }
  | { kind: "tool-call"; entryId: number; at: number; callId: string; name: string; argsPreview: string }
  | {
      kind: "tool-result";
      entryId: number;
      at: number;
      callId: string;
      name: string;
      isError: boolean;
      preview: string;
      textChars: number;
      truncated: boolean;
      ref: string;
      images: ImageRef[];
    }
  /** The model no longer sees entries before `head`; they stay readable. */
  | { kind: "compaction"; entryId: number; at: number; head: number | null; summary: string }
  | { kind: "reset"; entryId: number; at: number; handoff: string };

export type TranscriptPage = {
  conversationId: number;
  /** Chronological within the page. Pages themselves go newest to oldest. */
  items: TranscriptItem[];
  /** Pass as `before` for the next older page; null at the start of the conversation. */
  before: number | null;
  entries: number;
};

/** Shared default-limit trimming: keep newest whole entries and point `before` at the first omitted one. */
export const transcriptEntryCount = (page: TranscriptPage): number => new Set(page.items.map((item) => item.entryId)).size;
export function trimTranscriptPage(page: TranscriptPage, kept: number): TranscriptPage {
  const entryIds = [...new Set(page.items.map((item) => item.entryId))];
  const first = entryIds[entryIds.length - kept]!;
  return { ...page, items: page.items.filter((item) => item.entryId >= first), before: kept < entryIds.length ? first : page.before };
}

export function validateEntryId(value: unknown, name = "before"): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name} cursor`);
  return value;
}

/** `display` rewrites a message's full text before it is cut to a preview (the host hides expanded skill bodies this way). */
export type PageOptions = { before?: number | null; limit?: number; display?: (role: "user" | "assistant", text: string) => string };
export async function readTranscriptPage(
  source: TranscriptSource,
  conversationId: number,
  options: PageOptions = {},
): Promise<TranscriptPage> {
  const before = validateEntryId(options.before),
    limit = options.limit ?? PAGE_ENTRIES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid transcript page size");
  // Fetch one extra row to know whether older entries exist without counting.
  const rows = [...(await source.newest(conversationId, before, limit + 1))],
    older = rows.length > limit,
    entries = older ? rows.slice(0, limit) : rows;
  return {
    conversationId,
    items: entries.toReversed().flatMap((entry) => entryItems(entry, options.display)),
    before: older ? entries[entries.length - 1]!.id : null,
    entries: entries.length,
  };
}

function inputOrigin(entry: RawEntry): RawEntry["origin"] {
  if (entry.kind === "projects.owner-input") return "owner";
  if (entry.kind === "projects.internal-input") return "internal";
  return entry.origin;
}

const ReportData = Type.Object({ text: Type.String(), at: Type.Optional(Type.Number({ minimum: 0 })) });
const reportData = (entry: RawEntry) =>
  entry.kind === "projects.agent-report" && Value.Check(ReportData, entry.data) ? entry.data : undefined;

/** Items of one entry in display order. Calls come out right after their assistant text. */
function entryItems(entry: RawEntry, display?: PageOptions["display"]): TranscriptItem[] {
  const report = reportData(entry);
  if (report) {
    const text = preview(report.text, TEXT_PREVIEW_CHARS);
    return [
      {
        kind: "message",
        entryId: entry.id,
        role: "user",
        origin: "internal",
        at: report.at ?? 0,
        text: text.text,
        textChars: text.total,
        truncated: text.truncated,
        ref: `${entry.id}.0`,
        images: [],
      },
    ];
  }
  if (entry.kind === "pi.compaction")
    return [
      {
        kind: "compaction",
        entryId: entry.id,
        at: stamp(entry),
        head: entry.head ?? null,
        summary: preview(firstText(entry), TEXT_PREVIEW_CHARS).text,
      },
    ];
  if (entry.kind === "pi.reset")
    return [{ kind: "reset", entryId: entry.id, at: stamp(entry), handoff: preview(firstText(entry), TEXT_PREVIEW_CHARS).text }];
  const items: TranscriptItem[] = [];
  (entry.model ?? []).forEach((message, index) => {
    const at = message.timestamp ?? 0,
      ref = `${entry.id}.${index}`;
    if (message.role === "user" || message.role === "assistant") {
      const content = parts(message.content),
        text = preview(display ? display(message.role, joinText(content)) : joinText(content), TEXT_PREVIEW_CHARS),
        thinking = message.role === "assistant" ? preview(joinText(content, "thinking"), THINKING_PREVIEW_CHARS).text : "";
      items.push({
        kind: "message",
        entryId: entry.id,
        role: message.role,
        ...(message.role === "user" && inputOrigin(entry) ? { origin: inputOrigin(entry) } : {}),
        at,
        text: text.text,
        textChars: text.total,
        truncated: text.truncated,
        ref,
        ...(thinking ? { thinking } : {}),
        images: imageRefs(entry.id, index, content),
      });
      if (message.role === "assistant")
        for (const part of content)
          if (part.type === "toolCall" && typeof part.id === "string")
            items.push({
              kind: "tool-call",
              entryId: entry.id,
              at,
              callId: part.id,
              name: typeof part.name === "string" ? part.name : "tool",
              argsPreview: boundedJson(part.arguments, ARGS_PREVIEW_CHARS),
            });
    } else if (message.role === "toolResult") {
      const content = parts(message.content),
        text = preview(joinText(content), TEXT_PREVIEW_CHARS);
      items.push({
        kind: "tool-result",
        entryId: entry.id,
        at,
        callId: message.toolCallId ?? "",
        name: message.toolName ?? "tool",
        isError: message.isError === true,
        preview: text.text,
        textChars: text.total,
        truncated: text.truncated,
        ref,
        images: imageRefs(entry.id, index, content),
      });
    }
  });
  return items;
}

type Part = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  data?: unknown;
  mimeType?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};
const parts = (content: unknown): Part[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content.filter((part): part is Part => typeof part === "object" && part !== null)
      : [];
const stamp = (entry: RawEntry) => entry.model?.[0]?.timestamp ?? 0;
const firstText = (entry: RawEntry) => joinText(parts(entry.model?.[0]?.content));

function joinText(content: Part[], field: "text" | "thinking" = "text"): string {
  const kind = field === "text" ? "text" : "thinking";
  return content
    .filter((part) => part.type === kind && typeof part[field] === "string")
    .map((part) => part[field] as string)
    .join("\n");
}

/** Cuts at a code point boundary, so a surrogate pair never splits. */
function cut(text: string, length: number): string {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}
function preview(text: string, max: number): { text: string; total: number; truncated: boolean } {
  const truncated = text.length > max;
  return { text: truncated ? `${cut(text, max - 1)}…` : text, total: text.length, truncated };
}

function imageRefs(entryId: number, message: number, content: Part[]): ImageRef[] {
  return content.flatMap((part, index) =>
    part.type === "image" && typeof part.data === "string"
      ? [
          {
            ref: `${entryId}.${message}.${index}`,
            mime: typeof part.mimeType === "string" ? part.mimeType : "image/png",
            bytes: Math.floor((part.data.length * 3) / 4),
          },
        ]
      : [],
  );
}

/** Compact JSON of at most `max` characters: bounded depth, keys, items and string length, so a huge argument never gets serialized. */
export function boundedJson(value: unknown, max: number): string {
  let used = 0;
  const out: string[] = [];
  const push = (text: string) => {
    if (used >= max) return false;
    const room = max - used;
    out.push(text.length > room ? `${text.slice(0, room)}…` : text);
    used += Math.min(text.length, room);
    return used < max;
  };
  const walk = (node: unknown, depth: number): boolean => {
    if (typeof node === "string") return push(JSON.stringify(node.length > 200 ? `${node.slice(0, 200)}…` : node));
    if (node === null || typeof node !== "object") return push(String(node));
    if (depth >= 4) return push(Array.isArray(node) ? "[…]" : "{…}");
    if (Array.isArray(node)) {
      if (!push("[")) return false;
      for (const [index, item] of node.slice(0, 12).entries()) if ((index > 0 && !push(",")) || !walk(item, depth + 1)) return false;
      return push(node.length > 12 ? `,…${node.length - 12} more]` : "]");
    }
    if (!push("{")) return false;
    const keys = Object.keys(node);
    for (const [index, key] of keys.slice(0, 16).entries())
      if ((index > 0 && !push(",")) || !push(`${JSON.stringify(key)}:`) || !walk((node as Record<string, unknown>)[key], depth + 1))
        return false;
    return push(keys.length > 16 ? `,…${keys.length - 16} more}` : "}");
  };
  walk(value, 0);
  return out.join("");
}

function locate(ref: string): { entryId: number; message: number; part?: number } {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(ref);
  if (!match) throw new Error("Invalid transcript reference");
  return { entryId: Number(match[1]), message: Number(match[2]), ...(match[3] === undefined ? {} : { part: Number(match[3]) }) };
}

/** Full text of a message or tool result, by code point range. Offsets count Unicode characters. */
export async function readTranscriptText(
  source: TranscriptSource,
  conversationId: number,
  ref: string,
  range: { offset?: number; limit?: number } = {},
): Promise<{ text: string; offset: number; nextOffset: number | null; totalChars: number }> {
  const { entryId, message, part } = locate(ref),
    offset = range.offset ?? 0,
    limit = range.limit ?? TEXT_PREVIEW_CHARS;
  if (part !== undefined) throw new Error("Not a text reference");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > READ_TEXT_MAX)
    throw new Error("Invalid text range");
  const entry = await source.entry(conversationId, entryId),
    target = entry?.model?.[message],
    report = entry && message === 0 ? reportData(entry) : undefined;
  if (!entry || (!target && !report)) throw new Error("Transcript entry not found");
  const chars = [...(report ? report.text : joinText(parts(target?.content)))],
    end = Math.min(chars.length, offset + limit);
  return { text: chars.slice(offset, end).join(""), offset, nextOffset: end < chars.length ? end : null, totalChars: chars.length };
}

/** Bytes of one inline image, decoded only when asked for. */
export async function readTranscriptImage(
  source: TranscriptSource,
  conversationId: number,
  ref: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const { entryId, message, part } = locate(ref);
  if (part === undefined) throw new Error("Not an image reference");
  const entry = await source.entry(conversationId, entryId),
    image = parts(entry?.model?.[message]?.content)[part];
  if (!image || image.type !== "image" || typeof image.data !== "string") throw new Error("Transcript image not found");
  return { bytes: Buffer.from(image.data, "base64"), mime: typeof image.mimeType === "string" ? image.mimeType : "image/png" };
}
