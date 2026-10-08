import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { Evidence, Id, parse, readJson, saveJson } from "./state.ts";

const limit = 10 * 1024 * 1024;

export function evidence(dir: string): Evidence[] {
  const path = join(dir, "evidence");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return readdirSync(path).filter(name => name.endsWith(".json")).map(name => parse(Evidence, readJson(join(path, name)))).sort((a, b) => a.at.localeCompare(b.at));
}

export async function captureEvidenceBytes(input: { dir: string; filename: string; title: string; sessionFile: string | null; bytes: Buffer; native?: Evidence["native"]; id?: string }): Promise<Evidence> {
  const bytes = Buffer.from(input.bytes);
  if (bytes.length > limit) throw new Error("Captured evidence exceeds the 10 MiB limit");
  const record = parse(Evidence, { id: input.id === undefined ? randomUUID() : parse(Id, input.id), at: new Date().toISOString(), title: input.title, filename: basename(input.filename), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sessionFile: input.sessionFile, ...(input.native ? { native: input.native } : {}) });
  const project = lstatSync(input.dir);
  if (!project.isDirectory() || project.isSymbolicLink()) throw new Error("Evidence project root must be a physical directory");
  mkdirSync(join(input.dir, "evidence"), { recursive: true, mode: 0o700 });
  const folder = lstatSync(join(input.dir, "evidence"));
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("Evidence folder must be a physical directory");
  const data = await open(join(input.dir, "evidence", `${record.id}.data`), "wx", 0o600);
  try { await data.writeFile(bytes); await data.sync(); } finally { await data.close(); }
  saveJson(join(input.dir, "evidence", `${record.id}.json`), record);
  return record;
}

export async function readEvidenceRecord(dir: string, id: string): Promise<Evidence> {
  parse(Id, id);
  const path = join(dir, "evidence");
  const file = await open(join(path, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 524288) throw new Error("Invalid library metadata file");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Library metadata changed during read");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Library metadata changed during read");
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const record = parse(Evidence, raw);
    if (record.id !== id) throw new Error("Library metadata identity does not match");
    return record;
  } finally { await file.close(); }
}
export async function readEvidence(dir: string, id: string): Promise<{ record: Evidence; bytes: Buffer; mime: string }> {
  parse(Id, id);
  const record = await readEvidenceRecord(dir, id);
  if (record.id !== id) throw new Error("Stored evidence identity does not match");
  const file = await open(join(dir, "evidence", `${id}.data`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid stored evidence");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Stored evidence changed during read");
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || bytes.length !== record.size) throw new Error("Stored evidence changed during read");
  } finally { await file.close(); }
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error("Stored evidence hash does not match");
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "text/plain; charset=utf-8";
  return { record, bytes, mime };
}
