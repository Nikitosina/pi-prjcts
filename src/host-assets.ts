import { hostCheckout, readHostGit as git } from "./host-checkout.ts";
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";

const revision = process.argv[2] === "--resume-instance" && /^[0-9a-f]{40}$/.test(process.argv[4] ?? "") ? process.argv[4] : null;

// The checkout may move during startup. A replacement serves its inbox and shipped plugin assets from the confirmed revision.
export function inboxAssetNames(dir: string): string[] {
  return revision ? git("ls-tree", "-z", "--name-only", `${revision}:web`).toString().split("\0") : readdirSync(dir);
}
export function readBrowserAsset(path: string): Buffer {
  const name = relative(hostCheckout, path);
  return revision && /^(web|plugins)\//.test(name) ? git("cat-file", "blob", `${revision}:${name}`) : readFileSync(path);
}
