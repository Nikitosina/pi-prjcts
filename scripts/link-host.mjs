import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const pi = join(globalModules, "@earendil-works", "pi-coding-agent");
for (const [name, target] of [
  ["@earendil-works/pi-coding-agent", pi],
  ["typebox", join(pi, "node_modules", "typebox")],
  ["@types/node", join(pi, "node_modules", "@types", "node")],
]) {
  if (!existsSync(target)) throw new Error(`Missing installed dependency: ${target}`);
  const link = join(root, "node_modules", name);
  mkdirSync(join(link, ".."), { recursive: true });
  try {
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${link}`);
    unlinkSync(link);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  symlinkSync(target, link);
}
process.stdout.write("Linked installed Pi and host types.\n");
