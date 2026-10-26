import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntime } from "./provider-extensions.ts";

/** Swap complete offline snapshots. Model objects already handed to Durable keep their original runtime. */
export async function liveModelRuntime() {
  let current = await createModelRuntime();
  const owners = new WeakMap<object, ModelRuntime>();
  const known = new Map<string, NonNullable<ReturnType<ModelRuntime["getModel"]>>>();
  const overrides = new Map<string | symbol, unknown>();
  const models = new Proxy(current, {
    get(_target, key) {
      if (overrides.has(key)) return overrides.get(key);
      if (key === "getModel") return (...args: Parameters<ModelRuntime["getModel"]>) => {
        const reference = JSON.stringify(args);
        const model = current.getModel(...args);
        if (!model) return known.get(reference);
        owners.set(model, current);
        known.set(reference, model);
        return model;
      };
      if (key === "streamSimple") return (...args: Parameters<ModelRuntime["streamSimple"]>) => {
        const runtime = owners.get(args[0]) ?? current;
        return runtime.streamSimple(...args);
      };
      const value = Reflect.get(current, key);
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(Reflect.get(current, key), current, args) : value;
    },
    // Durable adds its stream observer and context-window override on the facade, not on a snapshot.
    set(_target, key, value: unknown) { overrides.set(key, value); return true; },
  });
  const prepare = async () => {
    const candidate = await createModelRuntime();
    return { candidate, commit: () => { current = candidate; } };
  };
  return { models, prepare, refresh: async (validate?: (candidate: ModelRuntime) => void) => {
    const update = await prepare();
    validate?.(update.candidate);
    update.commit();
  } };
}
