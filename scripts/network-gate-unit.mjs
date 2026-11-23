import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcher } from "../plugins/network-gate/watcher.mjs";
for (const state of ["RECONNECTING", "DISCONNECTING", "EXITING"]) {
  const dir = mkdtempSync(join(tmpdir(), "network-gate-"));
  let now = 0,
    online = false,
    probe = false,
    notices = 0,
    owned = false;
  const calls = [];
  const run = async (file, args) => {
    if (file.endsWith("osascript")) {
      const script = args.join(" ");
      if (script.includes("state of")) return online ? "CONNECTED" : state;
      const cmd = script.includes("to disconnect") ? "disconnect" : "connect";
      calls.push(cmd);
      if (cmd === "disconnect" && calls.length === 2 && state === "DISCONNECTING") throw Error("stuck");
      return "true";
    }
    if (file.endsWith("scutil")) return "Reachable";
    assert.match(file, /networksetup$/);
    const [action, dev, power] = args;
    if (action === "-listallhardwareports") return "Hardware Port: Wi-Fi\nDevice: en7\n";
    if (action === "-getairportpower") return "Wi-Fi Power (en7): On";
    assert.deepEqual([action, dev], ["-setairportpower", "en7"]);
    calls.push(power);
    return "";
  };
  try {
    const watcher = createWatcher({
      dir,
      run,
      probe: async () => probe,
      now: () => now,
      projects: () => [{ id: "a" }],
      control: {
        pause: async () => (owned = true),
        resume: async () => {
          owned = false;
        },
        owns: async () => owned,
        notice: async () => notices++,
      },
    });
    const tick = async (t) => {
      now = t;
      await watcher.tick();
    };
    await tick(0);
    assert.equal(owned, false);
    await tick(15000);
    assert.equal(owned, true);
    if (state !== "EXITING") assert.deepEqual(calls, []);
    await tick(61000);
    if (state === "RECONNECTING") assert.deepEqual(calls, ["disconnect", "connect"]);
    if (state === "DISCONNECTING") assert.deepEqual(calls, ["off", "disconnect", "on"]);
    await tick(77000);
    await tick(108000);
    await tick(169000);
    await tick(230000);
    assert.equal(notices, 1);
    assert.equal(watcher.status().attempts, 3);
    if (state === "EXITING") assert.deepEqual(calls, ["connect", "connect", "connect"]);
    online = true;
    await tick(240000);
    assert.equal(owned, true);
    probe = true;
    await tick(250000);
    assert.equal(owned, true);
    await tick(260000);
    assert.equal(owned, false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
