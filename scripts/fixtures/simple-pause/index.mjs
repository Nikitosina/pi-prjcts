// A plugin whose lifecycle pause is one flag per project (a Set), the simplest hook the host accepts; globalThis.simplePaused is that flag.
const paused = (globalThis.simplePaused = new Set());
// Every pause and resume the plugin saw, in order ("pause:<project>", "resume:<project>"): a held pause must never show a resume.
const log = (globalThis.simpleLog = []);
// A write with an unknown outcome kept outside the Durable store, by project id (the simulator's persisted state is one).
const unresolved = (globalThis.simpleUnresolved = new Map());
export default {
  name: "simple",
  register(api) {
    api.provide({
      lifecycle: {
        pause: (projectId) => (
          paused.add(projectId),
          log.push(`pause:${projectId}`),
          () => (paused.delete(projectId), log.push(`resume:${projectId}`))
        ),
        unresolved: (projectId) => {
          const reason = unresolved.get(projectId);
          if (reason instanceof Error) throw reason;
          return reason ?? null;
        },
      },
    });
  },
};
