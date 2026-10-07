// unpdf (PDF text extraction for uploads): pinned, dependency-free, integrity-checked like the Durable pin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pin = { name: "unpdf", version: "1.8.1", integrity: "sha512-xkURhy2SoGpOIH0a1gLHNkASPIQYonadDJs2AQwPEfUakafeD9EA1WTWWsaR++gfTCXJpV27W7tU1nXuk82UKQ==" };
const base = join(root, ".dependencies", pin.name, pin.version), target = join(base, "package");
mkdirSync(base, { recursive: true });
if (!existsSync(join(target, "package.json"))) {
  const entry = JSON.parse(execFileSync("npm", ["pack", `${pin.name}@${pin.version}`, "--pack-destination", base, "--json"], { encoding: "utf8" }))[0];
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(join(base, entry.filename))).digest("base64");
  if (entry.version !== pin.version || integrity !== pin.integrity) throw new Error("unpdf archive integrity mismatch");
  writeFileSync(join(base, "receipt.json"), JSON.stringify({ name: pin.name, version: pin.version, filename: entry.filename, integrity }, null, 2) + "\n");
  execFileSync("tar", ["-xzf", join(base, entry.filename), "-C", base]);
}
if (JSON.parse(readFileSync(join(target, "package.json"))).version !== pin.version) throw new Error("Unexpected installed unpdf version");
const path = join(root, "node_modules", pin.name);
try { if (!lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${path}`); unlinkSync(path); }
catch (error) { if (error.code !== "ENOENT") throw error; }
symlinkSync(target, path);
process.stdout.write(`Linked ${pin.name} ${pin.version}.\n`);
