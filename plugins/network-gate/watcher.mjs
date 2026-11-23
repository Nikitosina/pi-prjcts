import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const defaults = { configuration: "yteam fixed", probeUrl: "https://a.yandex-team.ru", intervalMs: 15000, stuckMs: 60000 };
export function settings(dir) {
  const file = join(dir, "settings.json");
  const cfg = { ...defaults, ...(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) };
  if (
    typeof cfg.configuration !== "string" ||
    !cfg.configuration.trim() ||
    new URL(cfg.probeUrl).protocol !== "https:" ||
    ![cfg.intervalMs, cfg.stuckMs].every((n) => Number.isSafeInteger(n) && n >= 1000 && n <= 3600000)
  )
    throw Error("Invalid network-gate settings");
  return cfg;
}
export function createWatcher({ dir, run, probe, now = Date.now, config = defaults, projects, control }) {
  const file = join(dir, "outage.json");
  const fresh = () => ({ outage: null, projects: {}, attempts: 0, next: 0, notified: false, restore: null, lastRepair: null });
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fresh();
  let saved = JSON.stringify(s);
  function save() {
    const text = JSON.stringify(s);
    if (text !== saved) {
      writeFileSync(file + ".tmp", text, { mode: 0o600 });
      renameSync(file + ".tmp", file);
      saved = text;
    }
  }
  let state = "UNKNOWN",
    since = now(),
    bad = 0,
    good = 0,
    repairing = false,
    lastError = null;
  const vpn = async (command) => {
    const body = command === "state" ? "get state of configuration configName" : `${command} configName`;
    const result = await run("/usr/bin/osascript", [
      "-e",
      `on run argv\nset configName to item 1 of argv\ntell application "Tunnelblick" to ${body}\nend run`,
      config.configuration,
    ]);
    if (result === "false") throw Error(`Tunnelblick refused ${command}`);
    return result.trim().toUpperCase();
  };
  const wifi = (...args) => run("/usr/sbin/networksetup", args);
  async function restore() {
    if (!s.restore) return;
    await wifi("-setairportpower", s.restore, "on");
    s.restore = null;
    save();
  }
  async function cycle() {
    const ports = await wifi("-listallhardwareports");
    const device = /^Hardware Port: (?:Wi-Fi|AirPort)\r?\nDevice: (en\d+)\s*$/m.exec(ports)?.[1];
    if (!device || !/: On\s*$/.test(await wifi("-getairportpower", device))) throw Error("No powered Wi-Fi device");
    s.restore = device;
    save();
    try {
      await wifi("-setairportpower", device, "off");
      await vpn("disconnect");
    } finally {
      await restore();
    }
    await vpn("connect");
  }
  async function repair() {
    if (now() < s.next) return;
    if (s.attempts >= 3) {
      if (!s.notified) {
        s.notified = true;
        save();
        await control.notice("VPN is still unavailable after three repair attempts. Check Tunnelblick.");
      }
      return;
    }
    const disconnected = ["EXITING", "DISCONNECTED"].includes(state);
    if (disconnected) {
      if (!/^Reachable\b/i.test((await run("/usr/sbin/scutil", ["-r", "1.1.1.1"])).trim())) return;
    } else if (!["RECONNECTING", "DISCONNECTING"].includes(state) || now() - since < config.stuckMs) return;
    repairing = true;
    s.next = now() + 15000 * 2 ** s.attempts++;
    s.lastRepair = `${new Date(now()).toISOString()} ${state}`;
    save();
    try {
      if (state === "DISCONNECTING") await cycle();
      else {
        if (!disconnected) await vpn("disconnect");
        await vpn("connect");
      }
    } finally {
      repairing = false;
    }
  }
  async function reconcile(recover) {
    const active = projects().filter((p) => !p.deleted && !p.archived && !p.disabledPlugins?.includes("network-gate"));
    const eligible = new Set(active.map((p) => p.id));
    for (const { id } of active) {
      try {
        if (!recover && (!(id in s.projects) || s.projects[id] === "claiming")) {
          s.projects[id] = "claiming";
          save();
          try {
            s.projects[id] = (await control.pause(
              id,
              `VPN ${config.configuration}: ${state}, corporate probe unavailable or VPN not connected`,
              s.outage,
            ))
              ? "paused"
              : "skip";
          } catch (error) {
            if (!(await control.owns(id))) {
              throw error;
            }
            s.projects[id] = "paused";
          }
        } else if (id in s.projects && s.projects[id] !== "skip") {
          if (!(await control.owns(id))) s.projects[id] = "skip";
          else if (recover) {
            await control.resume(id);
            s.projects[id] = "skip";
          } else s.projects[id] = "paused";
        }
      } catch (e) {
        lastError = e.message;
      } finally {
        save();
      }
    }
    if (recover && !Object.entries(s.projects).some(([id, v]) => eligible.has(id) && v !== "skip")) {
      Object.assign(s, fresh(), { lastRepair: s.lastRepair });
      save();
    }
  }
  async function sample() {
    lastError = null;
    try {
      await restore();
    } catch (e) {
      lastError = e.message;
    }
    const [v, p] = await Promise.allSettled([vpn("state"), probe(config.probeUrl)]);
    const next = v.status === "fulfilled" ? v.value : "UNKNOWN";
    if (next !== state) {
      state = next;
      since = now();
    }
    if (next === "CONNECTED" && p.status === "fulfilled" && p.value) {
      good++;
      bad = 0;
    } else {
      bad++;
      good = 0;
    }
    if (bad >= 2 && !s.outage) s.outage = randomUUID();
    save();
    if (!s.outage) return;
    await reconcile(good >= 2);
    if (bad >= 2 && !s.restore) await repair();
  }
  let running;
  return {
    tick() {
      return (running ??= sample()
        .catch((e) => {
          lastError = e.message;
        })
        .finally(() => (running = undefined)));
    },
    status: () => ({
      phase: repairing ? "repairing" : !s.outage && good >= 2 ? "ready" : "waiting",
      vpn: state,
      failures: bad,
      attempts: s.attempts,
      lastRepair: s.lastRepair,
      error: lastError,
      paused: Object.keys(s.projects).filter((id) => s.projects[id] === "paused"),
    }),
  };
}
