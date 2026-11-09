import { createHash } from "node:crypto";

/** A browser file held in memory as it was when the host (or its plugin) loaded, with the ETag it is revalidated by. */
export type WebFile = { content: Buffer; mime: string; etag: string };

export const webFile = (content: Buffer, mime: string): WebFile => ({
  content,
  mime,
  etag: `"${createHash("sha256").update(content).digest("hex")}"`,
});
