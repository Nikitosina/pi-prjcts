import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { networkGate } from "../../plugins/network-gate/index.mjs";
const up = () => {
  const file = join(process.env.PI_PROJECTS_HOME, "fake-vpn");
  return existsSync(file) && readFileSync(file, "utf8") === "up";
};
export default networkGate({
  intervalMs: 200,
  probe: async () => up(),
  run: async (file, args) => {
    if (file.endsWith("osascript") && args.join(" ").includes("state of")) return up() ? "CONNECTED" : "WAIT";
    throw Error("unscripted fake command");
  },
});
