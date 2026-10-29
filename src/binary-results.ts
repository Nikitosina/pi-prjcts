import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { artifactRef, ensureArtifactDir } from "./artifacts.ts";

/** Tool results that carry bytes (MCP images, simulator screenshots, upload reads): the bytes become artifacts, the transcript gets a reference plus a small model copy. */
export const BINARY_STORE_MAX_BYTES = 25 * 1024 * 1024;
/** What the model sees: at most this many encoded bytes and pixels per side. */
export const MODEL_COPY_MAX_BYTES = 200 * 1024;
export const MODEL_COPY_MAX_SIDE = 1024;
const FOLDER = "binary";

/** `scope` is a thread id or the project id; its artifacts folder is `<controlRoot>/artifacts/<scope>`. */
export type BinaryScope = { controlRoot: string; scope: string };
export type StoredBinary = { ref: string; path: string; mime: string; size: number; sha256: string };
export type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  return undefined;
}

/** Strict base64: empty, malformed or oversized payloads are errors, not garbage files. */
export function decodeBase64(data: string): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new Error("Invalid base64 data");
  if (compact.length > Math.ceil((BINARY_STORE_MAX_BYTES * 4) / 3) + 4) throw new Error("Binary result is larger than the 25 MiB limit");
  return Buffer.from(compact, "base64");
}

/** Content-addressed and written through a temp file, so replays and races leave one complete file. */
export function storeBinary(target: BinaryScope, bytes: Uint8Array): StoredBinary {
  if (!bytes.length) throw new Error("Binary result is empty");
  if (bytes.length > BINARY_STORE_MAX_BYTES) throw new Error("Binary result is larger than the 25 MiB limit");
  const sha256 = createHash("sha256").update(bytes).digest("hex"),
    mime = sniffImageMime(bytes) ?? "application/octet-stream", // the declared type is never trusted
    name = `${sha256.slice(0, 24)}.${EXTENSION[mime] ?? "bin"}`;
  const dir = join(ensureArtifactDir(target.controlRoot, target.scope), FOLDER),
    path = join(dir, name);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  }
  return { ref: artifactRef(target.scope, `${FOLDER}/${name}`), path, mime, size: bytes.length, sha256 };
}

/** A downscaled copy for the model, or null when the image cannot be brought under the bound (the model then relies on the reference). */
export async function modelCopy(bytes: Uint8Array, mime: string): Promise<{ data: string; mimeType: string; note: string } | null> {
  if (!EXTENSION[mime]) return null;
  try {
    const copy = await resizeImage(bytes, mime, {
      maxWidth: MODEL_COPY_MAX_SIDE,
      maxHeight: MODEL_COPY_MAX_SIDE,
      maxBytes: MODEL_COPY_MAX_BYTES,
    });
    if (!copy || Buffer.byteLength(copy.data, "base64") > MODEL_COPY_MAX_BYTES * 1.4) return null;
    return {
      data: copy.data,
      mimeType: copy.mimeType,
      note: copy.wasResized
        ? `downscaled ${copy.originalWidth}x${copy.originalHeight} to ${copy.width}x${copy.height}`
        : `${copy.width}x${copy.height}`,
    };
  } catch {
    return null;
  }
}

const kb = (size: number) => (size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);

/** Result blocks for one binary: a text line with the markdown reference (so it renders in chats) and the bounded model copy of images. */
export async function binaryResult(target: BinaryScope, input: { bytes: Uint8Array; label: string }): Promise<ResultBlock[]> {
  const stored = storeBinary(target, input.bytes);
  const image = stored.mime.startsWith("image/") ? await modelCopy(input.bytes, stored.mime) : null;
  const shown = stored.mime.startsWith("image/") ? "!" : "";
  const status = image
    ? `model copy ${image.note}`
    : stored.mime.startsWith("image/")
      ? "no model copy; cite the reference"
      : "binary, metadata only";
  const text: ResultBlock = {
    type: "text",
    text: `${input.label}: ${shown}[${input.label}](${stored.ref}) ${stored.mime} ${kb(stored.size)} stored in full as ${stored.ref} (${status})`,
  };
  return image ? [text, { type: "image", data: image.data, mimeType: image.mimeType }] : [text];
}
