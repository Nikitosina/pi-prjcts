import {
  createEventBus, DefaultResourceLoader, getAgentDir, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Project } from "./state.ts";

export async function loadProjectResourceLoader(project: Project): Promise<DefaultResourceLoader> {
  const settingsManager = SettingsManager.create(project.cwd, getAgentDir());
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: project.cwd, agentDir: getAgentDir(), settingsManager, eventBus: createEventBus(), noExtensions: true }); // skills only: extension code never runs here (model providers load once, isolated, in provider-extensions.ts)
  await resourceLoader.reload();
  const failures = resourceLoader.getExtensions().errors;
  if (failures.length) throw new Error(failures.map(error => `${error.path}: ${error.error}`).join("\n"));
  return resourceLoader;
}
