import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWatcher, settings } from "./watcher.mjs";
const execute = promisify(execFile);
const system = {
  run: async (file, args) => (await execute(file, args, { timeout: 8000, maxBuffer: 65536 })).stdout.trim(),
  probe: async (url) => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
    try {
      if (!response.ok) return false;
      for await (const _ of response.body ?? []) {
      }
      return true;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  },
};
const PHASES = { ready: "good", repairing: "work", waiting: "needs" };
/** Up to 500 characters of ids, then how many more; a row's text holds 500. */
function listed(ids) {
  let text = "";
  for (const [index, id] of ids.entries()) {
    const next = text ? `${text}, ${id}` : id;
    const rest = ids.length - index - 1;
    if (next.length + (rest ? ` and ${rest} more`.length : 0) > 500) return `${text} and ${ids.length - index} more`;
    text = next;
  }
  return text || "none";
}
/** The VPN gate section in Settings → Plugins: the watcher's status as key/value rows. */
export function gateView(s) {
  const clip = (text) => (text.length > 500 ? `${text.slice(0, 499)}…` : text);
  const rows = [
    { label: "VPN gate", text: clip(String(s.vpn)), status: { label: s.phase, tone: PHASES[s.phase] ?? "neutral" } },
    { label: "Failed samples", text: String(s.failures) },
    { label: "Repair attempts", text: `${s.attempts}/3` },
    { label: "Last repair", text: s.lastRepair ?? "none" },
    { label: "Paused projects", text: listed(s.paused) },
  ];
  if (s.error) rows.push({ label: "Error", text: clip(String(s.error)), status: { label: "error", tone: "bad" } });
  return { rows };
}
export function networkGate(deps = system) {
  return {
    name: "network-gate",
    version: "1.0.0",
    register(api) {
      const config = settings(api.stateDir);
      const watcher = createWatcher({ dir: api.stateDir, projects: api.projects.list, control: api.projects.control, config, ...deps });
      let timer,
        pending,
        closed = false;
      const poll = () => {
        if (closed) return;
        pending = watcher.tick().finally(() => {
          if (!closed) timer = setTimeout(poll, deps.intervalMs ?? config.intervalMs).unref();
        });
      };
      api.provide({
        rpc: { status: async () => watcher.status() },
        rpcPolicy: { status: "read" },
        lifecycle: {
          close: async () => {
            closed = true;
            clearTimeout(timer);
            await pending;
          },
        },
        sections: { status: { title: "VPN gate", place: "settings", refreshMs: 3000, read: async () => gateView(await watcher.status()) } },
      });
      if (api.projects.control) timer = setTimeout(poll, 0).unref();
    },
  };
}
export default networkGate();
