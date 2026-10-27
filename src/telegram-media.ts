import { closeSync, readSync } from "node:fs";
import { basename } from "node:path";
import { openArtifact } from "./artifacts.ts";

export const TELEGRAM_FILE_LIMIT = 50_000_000;
export type MediaRef = { ref: string; caption: string };
export type TelegramPart = { kind: "text"; text: string } | { kind: "media"; media: MediaRef };

// Code examples are not attachments. All other image syntax is consumed, including unsafe URLs.
export function extractTelegramMedia(markdown: string): { markdown: string; media: MediaRef[] } {
  const media: MediaRef[] = [];
  markdown = markdown.replace(/[\uE000\uE001]/g, "");
  let text = "", cursor = 0;
  for (const match of markdown.matchAll(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|!\[([^\]\n]*)\]\(/g)) {
    if (match[1] || match.index < cursor) continue;
    const start = match.index + match[0].length;
    let end = start, depth = 1;
    for (; end < markdown.length && markdown[end] !== "\n"; end++) {
      if (markdown[end] === "(") depth++;
      if (markdown[end] === ")" && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const index = media.push({ ref: markdown.slice(start, end), caption: match[2] }) - 1;
    text += markdown.slice(cursor, match.index) + `\uE000${index}\uE001`;
    cursor = end + 1;
  }
  text += markdown.slice(cursor);
  return { markdown: text, media };
}

export function loadTelegramMedia(controlRoot: string, ref: string) {
  const match = /^artifact:([a-f0-9-]{36})\/(.+)$/.exec(ref);
  if (!match) throw new Error("Only authorized artifact attachments are supported");
  const opened = openArtifact(controlRoot, match[1], match[2]);
  try {
    if (opened.size === 0 || opened.size > TELEGRAM_FILE_LIMIT) throw new Error("Attachment is empty or exceeds Telegram's 50 MB upload limit");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Attachment changed while reading");
      offset += count;
    }
    const photo = opened.size <= 10_000_000 && (opened.mime === "image/png" || opened.mime === "image/jpeg");
    const method = photo ? "sendPhoto" : opened.mime === "video/mp4" ? "sendVideo" : "sendDocument";
    return { bytes, mime: opened.mime, filename: basename(match[2]), method };
  } finally { closeSync(opened.fd); }
}

export function telegramMediaForm(media: ReturnType<typeof loadTelegramMedia>, chatId: number, caption: string, document = false): { method: string; body: FormData } {
  const method = document ? "sendDocument" : media.method;
  const field = method === "sendPhoto" ? "photo" : method === "sendVideo" ? "video" : "document";
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("caption", caption);
  body.set(field, new Blob([new Uint8Array(media.bytes)], { type: media.mime }), media.filename);
  return { method, body };
}
