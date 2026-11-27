import { fileURLToPath } from "node:url";

/** Optional plugins shipped inside this checkout, offered in Settings → Plugins. Static metadata: listing never imports the plugin's code. */
export const BUNDLED_PLUGIN_IDS = ["tasks", "simulator", "network-gate"] as const;
export type BundledPluginId = (typeof BUNDLED_PLUGIN_IDS)[number];

export type BundledPlugin = { id: BundledPluginId; name: string; description: string; directory: string };

const directory = (id: BundledPluginId) => fileURLToPath(new URL(`../plugins/${id}`, import.meta.url));

export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    id: "tasks",
    name: "Tasks",
    description: "A task list per project and chat for the Coordinator, shown in the Tasks section of the chat's right panel.",
    directory: directory("tasks"),
  },
  {
    id: "simulator",
    name: "iOS simulators",
    description:
      "Managed iOS simulator clones per project, with Coordinator and worker tools and a settings section. Needs Xcode on this Mac.",
    directory: directory("simulator"),
  },
  {
    id: "network-gate",
    name: "Network gate",
    description: "Pause projects when the corporate VPN is down and resume them after recovery. Needs Tunnelblick on this Mac.",
    directory: directory("network-gate"),
  },
];

export const isBundledPluginId = (value: unknown): value is BundledPluginId =>
  typeof value === "string" && (BUNDLED_PLUGIN_IDS as readonly string[]).includes(value);
