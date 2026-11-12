// A fake simslim for scripts/simulator-panel-e2e.mjs: answers from the JSON device list in $SIMULATOR_FAKE_STATE and logs each call to
// $SIMULATOR_FAKE_LOG. `fail.<command>` in the state makes that command fail with the given message. Clone folders live under $HOME.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const [command, target, name] = process.argv.slice(2);
appendFileSync(process.env.SIMULATOR_FAKE_LOG, JSON.stringify({ at: Date.now(), args: process.argv.slice(2) }) + "\n");
const path = process.env.SIMULATOR_FAKE_STATE,
  state = JSON.parse(readFileSync(path, "utf8"));
const save = () => writeFileSync(path, JSON.stringify(state, null, 2));
const device = () => state.devices.find((item) => item.udid === target);
const folder = (udid) => join(process.env.HOME, "Library/Developer/CoreSimulator/Devices", udid);
if (state.fail?.[command]) {
  process.stderr.write(state.fail[command]);
  process.exit(1);
}
switch (command) {
  case "list":
    process.stdout.write(JSON.stringify(state.devices));
    break;
  case "status":
    process.stdout.write(
      JSON.stringify({ managedDisabled: 3, managedTotal: 5, booted: device()?.state === "Booted", persistent: true, verdict: "slim" }),
    );
    break;
  case "on":
    device().state = "Booted";
    save();
    break;
  case "shutdown":
    device().state = "Shutdown";
    save();
    process.stdout.write("{}");
    break;
  case "erase":
    process.stdout.write("{}");
    break;
  case "clone": {
    const udid = randomUUID().toUpperCase(),
      source = device();
    mkdirSync(folder(udid), { recursive: true });
    state.devices.push({ udid, name, state: "Shutdown", osVersion: source.osVersion, set: "default" });
    save();
    process.stdout.write(JSON.stringify({ action: "clone", udid, sourceUdid: target, name }));
    break;
  }
  case "delete":
    state.devices = state.devices.filter((item) => item.udid !== target);
    rmSync(folder(target), { recursive: true, force: true });
    save();
    process.stdout.write("{}");
    break;
  default:
    process.stderr.write(`unexpected ${command}`);
    process.exit(2);
}
