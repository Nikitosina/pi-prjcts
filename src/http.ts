import type { IncomingMessage } from "node:http";

export async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65536) throw new Error("Request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
