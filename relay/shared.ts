import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
type Asset = { bytes: Buffer; mime: string; etag: string };
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

/** Known browser push services only; shared by host subscription storage and relay delivery. */
export function pushServiceAllowed(url: URL): boolean {
  const suffixes = ["push.apple.com", "push.services.mozilla.com", "notify.windows.com"];
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port &&
    (url.hostname === "fcm.googleapis.com" || suffixes.some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)));
}

/** Exact fingerprint input: each served URL (sorted lexically), then LF, then its raw file bytes; no trailing delimiter. */
export function bootstrapAssets(): Map<string, Asset> {
  const mime: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", webmanifest: "application/manifest+json", svg: "image/svg+xml", png: "image/png" };
  const entries: [string, Asset][] = [];
  for (const entry of readdirSync(join(root, "bootstrap"), { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith(".d.ts")) continue;
    const path = entry.name === "index.html" ? "/" : ["sw.js", "manifest.webmanifest"].includes(entry.name) ? `/${entry.name}` : `/boot/${entry.name}`;
    const bytes = readFileSync(join(root, "bootstrap", entry.name));
    entries.push([path, { bytes, mime: mime[entry.name.split(".").at(-1)!] ?? "application/octet-stream", etag: `"${hash(bytes)}"` }]);
  }
  return new Map(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export function fingerprint(): string {
  const digest = createHash("sha256");
  for (const [path, asset] of bootstrapAssets()) digest.update(path + "\n").update(asset.bytes);
  return digest.digest("hex");
}

