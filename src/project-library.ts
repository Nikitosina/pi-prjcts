import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Id, parse } from "./state.ts";
import { captureEvidenceBytes, readEvidence, readEvidenceRecord } from "./evidence.ts";

async function folder(dir: string) {
  const root = await lstat(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Library project directory must be a physical directory");
  const path = join(dir, "evidence");
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Library evidence directory must be a physical directory");
    return path;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function libraryList(dir: string, options: { offset?: number; limit?: number }) {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid library page");
  const path = await folder(dir);
  if (path === null) return { items: [], total: 0, nextOffset: null };
  const names = (await readdir(path)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort();
  const items = await Promise.all(names.slice(offset, offset + limit).map(name => readEvidenceRecord(dir, parse(Id, name.slice(0, -5)))));
  return { items, total: names.length, nextOffset: offset + items.length < names.length ? offset + items.length : null };
}
export async function libraryImport(dir: string, input: { importId: string; filename: string; title: string; data: string; expectedSha256: string }) {
  const id = parse(Id, input.importId);
  if (!input.filename || input.filename.length > 240 || basename(input.filename) !== input.filename || input.filename.includes("\\") || /[\u0000-\u001f\u007f]/.test(input.filename)) throw new Error("Import filename must be a display name, not a path");
  if (input.data.length > 43692 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error("Invalid bounded base64 import");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length > 32768 || bytes.toString("base64") !== input.data) throw new Error("Library imports must be canonical base64 no larger than 32 KiB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.expectedSha256) throw new Error("Import hash does not match supplied bytes");
  const path = await folder(dir);
  if (path !== null) {
    let prior: Awaited<ReturnType<typeof readEvidenceRecord>> | undefined;
    try { prior = await readEvidenceRecord(dir, id); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (prior) {
      if (prior.sha256 !== sha256 || prior.size !== bytes.length || prior.filename !== input.filename || prior.title !== input.title || prior.sessionFile !== null || prior.native !== undefined) throw new Error("Import UUID already identifies different evidence");
      await readEvidence(dir, id);
      return prior;
    }
  }
  try { return await captureEvidenceBytes({ dir, id, filename: input.filename, title: input.title, bytes, sessionFile: null }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Incomplete import retained; inspect it and use a new import UUID");
    throw error;
  }
}

export async function libraryRead(dir: string, input: { evidenceId: string; expectedSha256: string; offset?: number; limit?: number }) {
  const offset = input.offset ?? 0, limit = input.limit ?? 65536;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 131072) throw new Error("Invalid library byte page");
  const path = await folder(dir);
  if (path === null) throw new Error("Library is empty");
  const record = await readEvidenceRecord(dir, parse(Id, input.evidenceId));
  if (record.sha256 !== input.expectedSha256) throw new Error("Library revision conflict; reread metadata before opening");
  const captured = await readEvidence(dir, record.id);
  if (captured.record.sha256 !== input.expectedSha256 || captured.bytes.length !== record.size) throw new Error("Library content no longer matches its metadata");
  if (offset > captured.bytes.length) throw new Error("Library byte offset exceeds file size");
  const bytes = captured.bytes.subarray(offset, offset + limit);
  return { record, mime: captured.mime, encoding: "base64", data: bytes.toString("base64"), offset, chunkSha256: createHash("sha256").update(bytes).digest("hex"), nextOffset: offset + bytes.length < captured.bytes.length ? offset + bytes.length : null };
}
