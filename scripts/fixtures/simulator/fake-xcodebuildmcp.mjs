// A fake XcodeBuildMCP screenshot for scripts/simulator-panel-e2e.mjs: copies $SIMULATOR_FAKE_PNG to a temp file named like the real one.
import { appendFileSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2),
  udid = args[args.indexOf("--simulator-id") + 1];
appendFileSync(process.env.SIMULATOR_FAKE_LOG, JSON.stringify({ at: Date.now(), args: ["screenshot", udid] }) + "\n");
const screenshotPath = join(tmpdir(), `screenshot_${randomUUID()}.png`);
copyFileSync(process.env.SIMULATOR_FAKE_PNG, screenshotPath);
process.stdout.write(
  JSON.stringify({
    didError: false,
    error: null,
    data: { artifacts: { simulatorId: udid, screenshotPath }, capture: { format: "image/png" } },
  }),
);
