import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { version } = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
if (/^1\.\d+\.\d+$/.test(version)) {
  const subagents = dirname(fileURLToPath(import.meta.resolve("pi-subagents")));
  const path = join(subagents, "src", "runs", "background", "runner-aliases.js");
  const source = readFileSync(path, "utf8");
  const before = "    const required = [...HOST_PEER_ALIASES, ...(isPreChord ? [] : CHORD_PEER_ALIASES)];";
  const after = [
    "    // Pi 1.x removed this unused export; children import the core root.",
    "    const isPi1 = /^1\\.\\d+\\.\\d+$/.test(hostManifest?.version ?? \"\");",
    "    const required = [...HOST_PEER_ALIASES, ...(isPreChord ? [] : CHORD_PEER_ALIASES)]",
    "        .filter(({ specifier }) => !isPi1 || specifier !== \"@earendil-works/pi-agent-core/node\");",
  ].join("\n");
  if (source.includes(after)) {
    process.stdout.write("Pi 1.x worker alias patch already applied.\n");
  } else if (!source.includes("@earendil-works/pi-agent-core/node")) {
    process.stdout.write("Worker runner no longer requires the obsolete alias.\n");
  } else {
    if (source.split(before).length !== 2) throw new Error("Worker alias code changed. Review Pi 1.x compatibility before patching.");
    writeFileSync(path, source.replace(before, after));
    process.stdout.write(`Patched installed pi-subagents for Pi ${version}.\n`);
  }
}
