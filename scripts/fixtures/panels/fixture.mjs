// Plugins for plugin-panels-e2e that only declare browser files from this directory (scripts/plugin-panels-failures.md).
import { fileURLToPath } from "node:url";

export const panelOnly = (name, version, script) => ({
  name,
  version,
  register(api) {
    api.provide({ web: { script: fileURLToPath(new URL(script, import.meta.url)) } });
  },
});
