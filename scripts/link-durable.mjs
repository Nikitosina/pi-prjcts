// Links pinned, integrity-checked Pi Durable and unpdf against the installed global Pi's shared libraries; no second SDK is installed.
// Any installed Pi 1.x works as long as it satisfies every range Durable declares for the libraries it shares with Pi.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pins = [
  { name: "@earendil-works/pi-durable", dir: "durable", version: "1.0.0", integrity: "sha512-PvjCIdy5jRsBoJDRpCCI0RfwBax2ZPnMT5aw/tRQxcQOqbGGj2mq1z0WuVxoyimWWi+WYSYT2VySg3RO1qzySw==" },
  { name: "unpdf", dir: "unpdf", version: "1.8.1", integrity: "sha512-xkURhy2SoGpOIH0a1gLHNkASPIQYonadDJs2AQwPEfUakafeD9EA1WTWWsaR++gfTCXJpV27W7tU1nXuk82UKQ==" },
];
const pi = process.env.PI_PROJECTS_PI_ROOT ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
const host = join(pi, "node_modules");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const piVersion = json(join(pi, "package.json")).version;
if (!/^1\.\d+\.\d+$/.test(piVersion)) throw new Error(`Pi Durable ${pins[0].version} needs an installed Pi 1.x host; found ${piVersion} at ${pi}`);
const semver = createRequire(join(pi, "package.json"))("semver");

// Fetch once into .dependencies/<name>/<version>/package; the archive must match the pinned sha512 before it is unpacked.
function fetchPinned(pin) {
  const base = join(root, ".dependencies", pin.dir, pin.version), target = join(base, "package");
  mkdirSync(base, { recursive: true });
  if (!existsSync(join(target, "package.json"))) {
    const entry = JSON.parse(execFileSync("npm", ["pack", `${pin.name}@${pin.version}`, "--pack-destination", base, "--json"], { encoding: "utf8" }))[0];
    const integrity = "sha512-" + createHash("sha512").update(readFileSync(join(base, entry.filename))).digest("base64");
    if (entry.version !== pin.version || integrity !== pin.integrity) throw new Error(`${pin.name} archive integrity mismatch`);
    writeFileSync(join(base, "receipt.json"), JSON.stringify({ name: pin.name, version: pin.version, filename: entry.filename, integrity }, null, 2) + "\n");
    execFileSync("tar", ["-xzf", join(base, entry.filename), "-C", base]);
  }
  const receipt = json(join(base, "receipt.json"));
  if (receipt.integrity !== pin.integrity || json(join(target, "package.json")).version !== pin.version) throw new Error(`Unexpected unpacked ${pin.name}; delete ${base} and run again`);
  return { base, target };
}
function link(name, location, modules) {
  if (!existsSync(location)) throw new Error(`Missing host dependency: ${name}`);
  const path = join(modules, name); mkdirSync(dirname(path), { recursive: true });
  try {
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${path}`);
    if (readlinkSync(path) === location) return;
    unlinkSync(path);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  symlinkSync(location, path);
}

const durable = fetchPinned(pins[0]), declared = json(join(durable.target, "package.json")).dependencies ?? {};
const mismatched = Object.entries(declared).map(([name, range]) => {
  const location = join(host, name), version = existsSync(location) ? json(join(location, "package.json")).version : null;
  return { name, range, version, location };
}).filter(item => !item.version || !semver.satisfies(item.version, item.range));
if (mismatched.length) throw new Error(`Installed Pi ${piVersion} does not satisfy Pi Durable ${pins[0].version}: ${mismatched.map(item => `${item.name} ${item.version ?? "missing"} (needs ${item.range})`).join(", ")}`);
for (const name of Object.keys(declared)) {
  link(name, join(host, name), join(durable.base, "node_modules"));
  if (name.startsWith("@earendil-works/")) link(name, join(host, name), join(root, "node_modules"));
}
link("@earendil-works/pi-mcp", join(host, "@earendil-works/pi-mcp"), join(root, "node_modules"));
link(pins[0].name, durable.target, join(root, "node_modules"));
link(pins[1].name, fetchPinned(pins[1]).target, join(root, "node_modules"));
process.stdout.write(`Linked Pi Durable ${pins[0].version} and unpdf ${pins[1].version} against installed Pi ${piVersion}; no coding SDK installed.\n`);
