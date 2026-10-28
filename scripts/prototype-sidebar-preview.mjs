// PROTOTYPE tooling (web/PROTOTYPE-SIDEBAR-NOTES.md). One command: isolated scratch host + fake provider + seeded projects, E assets enabled for that host only.
// Usage: node scripts/prototype-sidebar-preview.mjs [evidence-dir]   Prints the E URL and the stop command. Never touches your real host or data.
import { execFileSync } from "node:child_process"; import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
const root = join(dirname(new URL(import.meta.url).pathname), ".."), verify = join(root, ".agents/skills/verify-pi-prjcts/scripts/verify.mjs");
const evidence = process.argv[2] ?? mkdtempSync(join(tmpdir(), "pp-e-evidence-"));
const launched = JSON.parse(execFileSync("node", [verify, "launch", "--evidence", evidence], { encoding: "utf8", env: { ...process.env, PI_PROTOTYPE_SIDEBAR_E: "1" } }));
const run = join(launched.scratch, "run.json");
const ids = execFileSync("node", [join(root, "scripts/prototype-sidebar-seed.mjs"), run], { encoding: "utf8" });
writeFileSync(join(launched.scratch, "prototype-ids.json"), ids);
const url = JSON.parse(readFileSync(run, "utf8")).webUrl.replace("/#", "/?variant=E#");
console.log(JSON.stringify({ url, scratch: launched.scratch, ids: join(launched.scratch, "prototype-ids.json"), stop: `node ${verify} cleanup --run ${launched.scratch}` }, null, 2));
