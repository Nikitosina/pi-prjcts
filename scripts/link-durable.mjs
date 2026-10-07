import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = "1.0.0";
const pi = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
const host = join(pi, "node_modules");
if (JSON.parse(readFileSync(join(pi, "package.json"))).version !== "1.0.0") throw new Error("This Durable pin requires the installed Pi 1.0.0 host");
const base = join(root, ".dependencies", "durable", version);
const target = join(base, "package");
mkdirSync(base, { recursive: true });
if (!existsSync(join(target, "package.json"))) {
  const receipt = JSON.parse(execFileSync("npm", ["pack", `@earendil-works/pi-durable@${version}`, "--pack-destination", base, "--json"], { encoding: "utf8" }));
  const entry = receipt[0];
  const filename = `earendil-works-pi-durable-${version}.tgz`;
  if (entry?.version !== version || entry.filename !== filename || typeof entry.integrity !== "string") throw new Error("Unexpected Durable package receipt");
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(join(base, filename))).digest("base64");
  if (entry.integrity !== integrity) throw new Error("Durable archive integrity mismatch");
  writeFileSync(join(base, "receipt.json"), JSON.stringify({ name: entry.name, version, filename, integrity }, null, 2) + "\n");
  execFileSync("tar", ["-xzf", join(base, filename), "-C", base]);
}
if (JSON.parse(readFileSync(join(target, "package.json"))).version !== version) throw new Error("Unexpected installed Durable version");
function link(name, location, modules) {
  if (!existsSync(location)) throw new Error(`Missing host dependency: ${name}`);
  const path = join(modules, name); mkdirSync(dirname(path), { recursive: true });
  try {
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${path}`);
    unlinkSync(path);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  symlinkSync(location, path);
}
for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-mcp", "@earendil-works/chord", "typebox", "diff"]) {
  const location = join(host, name);
  link(name, location, join(base, "node_modules"));
  if (name.startsWith("@earendil-works/")) link(name, location, join(root, "node_modules"));
}
link("@earendil-works/pi-durable", target, join(root, "node_modules"));
process.stdout.write(`Linked Pi Durable ${version} using the installed Pi 1.0 shared libraries; no coding SDK installed.\n`);
