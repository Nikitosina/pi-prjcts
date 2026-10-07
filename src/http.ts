import type { IncomingMessage } from "node:http";

export async function body(request: IncomingMessage): Promise<string> { return (await bytes(request, 65536)).toString("utf8"); }

/** Reads at most `limit` bytes; refuses early on a larger declared length so oversized uploads are not buffered. */
export async function bytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new Error(`Request body exceeds ${limit >= 1048576 ? `${limit / 1048576} MiB` : `${limit / 1024} KiB`}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error(`Request body exceeds ${limit >= 1048576 ? `${limit / 1048576} MiB` : `${limit / 1024} KiB`}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
