import {
  createEventBus, DefaultResourceLoader, getAgentDir, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Project } from "./state.ts";

type Resolver = { resolve(onMissing?: (source: string) => Promise<"install" | "skip" | "error">): Promise<unknown> };

/**
 * `passive` is for catalog lookups the owner did not ask to change anything: a configured package that is not installed is skipped instead of being downloaded.
 * The SDK offers this only on its (private) package manager, so the wrapper checks its shape and fails loudly if a pinned-SDK upgrade moves it.
 */
export async function loadProjectResourceLoader(project: Project, options: { passive?: boolean } = {}): Promise<DefaultResourceLoader> {
  const settingsManager = SettingsManager.create(project.cwd, getAgentDir());
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: project.cwd, agentDir: getAgentDir(), settingsManager, eventBus: createEventBus(), noExtensions: true }); // skills only: extension code never runs here (model providers load once, isolated, in provider-extensions.ts)
  if (options.passive) {
    const manager = (resourceLoader as unknown as { packageManager?: Resolver }).packageManager;
    if (typeof manager?.resolve !== "function") throw new Error("Pi SDK package manager changed; passive skill discovery cannot skip package installs");
    const resolve = manager.resolve.bind(manager);
    manager.resolve = () => resolve(async () => "skip");
  }
  await resourceLoader.reload();
  const failures = resourceLoader.getExtensions().errors;
  if (failures.length) throw new Error(failures.map(error => `${error.path}: ${error.error}`).join("\n"));
  return resourceLoader;
}
