import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { Type, type Static } from "typebox";
import { modelCopy, sniffImageMime, type ResultBlock } from "./binary-results.ts";
import { Id, parse, readJson, saveJson } from "./state.ts";

/** Owner uploads: project knowledge that coordinator and workers can search and read. Worker evidence stays in the library. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const TEXT_MAX_CHARS = 2_000_000;
export const UploadRecord = Type.Object(
  {
    id: Id,
    at: Type.String(),
    filename: Type.String({ minLength: 1, maxLength: 240 }),
    kind: Type.Union([Type.Literal("text"), Type.Literal("pdf"), Type.Literal("image")]),
    mime: Type.String({ maxLength: 100 }),
    size: Type.Integer({ minimum: 1 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    /** Extracted/decoded text length in code points; 0 for images. */
    textChars: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    extractError: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type UploadRecord = Static<typeof UploadRecord>;

function folder(dir: string, create = false): string | null {
  const path = join(dir, "uploads");
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Uploads folder must be a physical directory");
    return path;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!create) return null;
  mkdirSync(path, { mode: 0o700 });
  return path;
}

export function validUploadName(name: string): string {
  if (
    !name ||
    name.length > 240 ||
    basename(name) !== name ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    /[\u0000-\u001f\u007f]/.test(name)
  )
    throw new Error("Upload filename must be a plain file name of at most 240 characters");
  return name;
}

function detect(bytes: Buffer): { kind: UploadRecord["kind"]; mime: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: "image", mime: "image/png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: "image", mime: "image/jpeg" };
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
    return { kind: "image", mime: "image/webp" };
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Unsupported file type: upload text, code, Markdown, PDF, PNG, JPEG or WebP");
  }
  if (text.includes("\u0000")) throw new Error("Unsupported file type: binary data is not text");
  return { kind: "text", mime: "text/plain; charset=utf-8" };
}

async function extract(kind: UploadRecord["kind"], bytes: Buffer): Promise<{ text: string; error: string | null }> {
  if (kind === "image") return { text: "", error: null };
  if (kind === "text") return { text: bytes.toString("utf8").replace(/^﻿/, ""), error: null };
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
      return { text: (await extractText(document, { mergePages: true })).text, error: null };
    } finally {
      await document.cleanup();
    }
  } catch (error) {
    return { text: "", error: `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
  }
}

async function writeExclusive(path: string, data: Buffer | string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Stores bytes, then extracted text, then metadata last: a listed upload always has its bytes. Identical name+bytes is idempotent. */
export async function saveUpload(dir: string, input: { filename: string; bytes: Buffer }): Promise<UploadRecord> {
  const filename = validUploadName(input.filename),
    bytes = input.bytes;
  if (bytes.length === 0) throw new Error("Upload is empty");
  if (bytes.length > UPLOAD_MAX_BYTES) throw new Error("Upload exceeds the 20 MiB limit");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = listUploads(dir).find((item) => item.sha256 === sha256 && item.filename === filename);
  if (existing) return existing;
  const { kind, mime } = detect(bytes);
  const extracted = await extract(kind, bytes);
  const chars = [...extracted.text],
    truncated = chars.length > TEXT_MAX_CHARS;
  const text = truncated ? chars.slice(0, TEXT_MAX_CHARS).join("") : extracted.text;
  const path = folder(dir, true)!,
    id = randomUUID();
  await writeExclusive(join(path, `${id}.data`), bytes);
  await writeExclusive(join(path, `${id}.txt`), text);
  // The model sees this bounded copy, so a transcript never holds the full image.
  const copy = kind === "image" ? await modelCopy(bytes, mime) : null;
  if (copy) await writeExclusive(join(path, `${id}.model`), Buffer.from(copy.data, "base64"));
  const record = parse(UploadRecord, {
    id,
    at: new Date().toISOString(),
    filename,
    kind,
    mime,
    size: bytes.length,
    sha256,
    textChars: Math.min(chars.length, TEXT_MAX_CHARS),
    truncated,
    extractError: extracted.error,
  });
  saveJson(join(path, `${id}.json`), record);
  return record;
}

export function listUploads(dir: string): UploadRecord[] {
  const path = folder(dir);
  if (!path) return [];
  return readdirSync(path)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => parse(UploadRecord, readJson(join(path, name))))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function uploadRecord(dir: string, id: string): UploadRecord {
  parse(Id, id);
  const path = folder(dir);
  const record = path ? listUploads(dir).find((item) => item.id === id) : undefined;
  if (!record) throw new Error("Unknown upload for this project");
  return record;
}

export function uploadText(dir: string, id: string): { record: UploadRecord; text: string } {
  const record = uploadRecord(dir, id);
  return { record, text: readFileSync(join(folder(dir)!, `${record.id}.txt`), "utf8") };
}

export function uploadBytes(dir: string, id: string): { record: UploadRecord; bytes: Buffer } {
  const record = uploadRecord(dir, id),
    bytes = readFileSync(join(folder(dir)!, `${record.id}.data`));
  if (bytes.length !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.sha256)
    throw new Error("Stored upload does not match its metadata");
  return { record, bytes };
}

/** Metadata goes first, so a partly deleted upload is never listed. */
export function deleteUpload(dir: string, id: string): { deleted: string } {
  const record = uploadRecord(dir, id),
    path = folder(dir)!;
  rmSync(join(path, `${record.id}.json`));
  for (const suffix of ["txt", "data", "model"]) rmSync(join(path, `${record.id}.${suffix}`), { force: true });
  return { deleted: record.id };
}

type ImagePart = { type: "image"; data: string; mimeType: string };
/** The bounded image the model sees for an upload; null for non-images and for uploads stored before copies existed. */
export function uploadModelCopy(dir: string, id: string): ImagePart | null {
  const record = uploadRecord(dir, id),
    path = join(folder(dir)!, `${record.id}.model`);
  if (record.kind !== "image" || !existsSync(path)) return null;
  const bytes = readFileSync(path),
    mimeType = sniffImageMime(bytes);
  return mimeType ? { type: "image", data: bytes.toString("base64"), mimeType } : null;
}

/** Result of reading an image upload: its record and reference as text, plus the bounded copy when one exists. */
export function uploadImageResult(dir: string, id: string): ResultBlock[] {
  const record = uploadRecord(dir, id),
    copy = uploadModelCopy(dir, id);
  const note = copy
    ? "Reduced copy attached; the full image is the owner's upload."
    : "No reduced copy; the owner can view the image in the Knowledge tab.";
  return [{ type: "text", text: JSON.stringify({ record, ref: `upload:${record.id}`, note }) }, ...(copy ? [copy] : [])];
}
/** Coordinator input for an owner message: the text plus an attachment block naming each upload; images inline when the model accepts them. */
export function attachmentContent(
  dir: string,
  text: string,
  ids: readonly string[] | undefined,
  acceptsImages: boolean,
): string | ({ type: "text"; text: string } | ImagePart)[] {
  if (!ids?.length) return text;
  // A deleted upload (e.g. before a restart re-admits a queued job) stays named, not fatal; `message` validates IDs up front.
  const known = new Map(listUploads(dir).map((record) => [record.id, record]));
  const images: ImagePart[] = [];
  const lines = ids.map((id) => {
    const record = known.get(id);
    if (!record) return `- deleted upload ${id}`;
    const copy = acceptsImages && record.kind === "image" ? uploadModelCopy(dir, record.id) : null,
      inline = copy !== null;
    if (copy) images.push(copy);
    return `- ${record.filename} · ${record.kind} · ${record.size} bytes · upload ${record.id}${inline ? " · image attached (reduced copy)" : ""}`;
  });
  const block = `${text}\n\n${ATTACHMENT_HEADER}\n${lines.join("\n")}`;
  return images.length ? [{ type: "text", text: block }, ...images] : block;
}
export const ATTACHMENT_HEADER = "[Attached files: project uploads; read with projects_upload_read, find with projects_search]";
