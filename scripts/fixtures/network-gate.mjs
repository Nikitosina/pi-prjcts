import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { networkGate } from "../../plugins/network-gate/index.mjs";
const sample = () => {
  const file = join(process.env.PI_PROJECTS_HOME, "fake-vpn");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const up = () => sample() === "up";
// "disconnected" lets the watcher try a repair, which fails on the unscripted command and shows an error.
const state = () => (up() ? "CONNECTED" : sample() === "disconnected" ? "DISCONNECTED" : "WAIT");
export default networkGate({
  intervalMs: 200,
  probe: async () => up(),
  run: async (file, args) => {
    if (file.endsWith("osascript") && args.join(" ").includes("state of")) return state();
    throw Error("unscripted fake command");
  },
});
