/*
 * Per-project plugin gate. Every entry of a plugin into a project (tool call, RPC, web route) runs through `run`: it refuses a
 * plugin the project turned off and counts the work in flight, which is what a later disable must wait out (the owner's rule:
 * a plugin with active work in the project cannot be disabled). `run` checks and counts in one synchronous step.
 */
export const disabledMessage = (plugin: string) =>
  `Plugin "${plugin}" is disabled in this project. Enable it in Project settings → Plugins.`;

type Executable = { execute: (...args: never[]) => unknown };

export function createPluginGate(isDisabled: (projectId: string, plugin: string) => boolean) {
  const running = new Map<string, number>();
  const key = (projectId: string, plugin: string) => `${projectId}\0${plugin}`;
  const gate = {
    /** True while the project has the plugin turned off. */
    isOff: isDisabled,
    /** Calls in flight for the plugin in this project. */
    active: (projectId: string, plugin: string): number => running.get(key(projectId, plugin)) ?? 0,
    async run<T>(projectId: string, plugin: string, work: () => T | Promise<T>): Promise<T> {
      if (isDisabled(projectId, plugin)) throw new Error(disabledMessage(plugin));
      const id = key(projectId, plugin);
      running.set(id, (running.get(id) ?? 0) + 1);
      try {
        return await work();
      } finally {
        const left = (running.get(id) ?? 1) - 1;
        if (left > 0) running.set(id, left);
        else running.delete(id);
      }
    },
    /** The same tools whose `execute` runs through the gate, so a thread that already holds them stops at once after a disable. */
    tools<T extends Executable>(projectId: string, plugin: string, tools: T[]): T[] {
      return tools.map((tool) => ({
        ...tool,
        execute: (...args: never[]) => gate.run(projectId, plugin, () => tool.execute(...args)),
      }));
    },
  };
  return gate;
}
