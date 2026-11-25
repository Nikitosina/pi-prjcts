import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
        web: { script: fileURLToPath(new URL("./ui.js", import.meta.url)) },
      });
      if (api.projects.control) timer = setTimeout(poll, 0).unref();
    },
  };
}
export default networkGate();
