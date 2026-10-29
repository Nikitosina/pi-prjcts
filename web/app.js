import {
  api,
  changeProject,
  getGeneration,
  getProjectId,
  projects,
  restoreBrowserDrafts,
  setError,
  setProjectId,
  setProjects,
  setTab,
  showError,
  tab,
} from "./app/shell.js";
import { PROJECT_SEEN, chatId, markSeen, renderProjects, seenAt } from "./app/chat.js";
import { loadPluginStatus } from "./app/prs.js";
// Features register their handlers when they load. Modules import each other, so the effective order is the import graph's, not this list.
import "./app/decisions.js";
import "./app/workers.js";
import "./app/knowledge.js";
import "./app/artifacts.js";
import "./app/composer.js";
import "./app/admin.js";
import "./app/settings.js";
import "./app/observability.js";
import "./app/creation.js";
import "./app/notifications.js";
import "./app/search.js";
import "./app/limits.js";
import "./app/archive.js";

let refusal = null;
async function start() {
  document.querySelector("#compose button").disabled = true;
  const current = getGeneration();
  try {
    const loaded = await api({ action: "list" });
    if (current !== getGeneration()) return;
    setProjects(loaded);
    for (const project of loaded) if (seenAt(project.id, PROJECT_SEEN) === null) markSeen(project.id, PROJECT_SEEN);
    renderProjects();
    if (!projects.some((p) => p.id === getProjectId())) {
      // A legacy (pre-Durable) project is not listed; say why instead of silently opening another one.
      const wanted = getProjectId();
      setProjectId(projects[0]?.id ?? null);
      if (wanted)
        await api({ action: "show", id: wanted }).catch((error) => {
          if (current === getGeneration() && /removed legacy runtime/.test(error.message)) refusal = error.message;
        });
      if (current !== getGeneration()) return;
    }
    changeProject(getProjectId(), chatId);
    if (refusal) {
      setError(refusal, "action");
      refusal = null;
    } else await loadPluginStatus();
  } catch (error) {
    if (current === getGeneration()) showError(error);
  }
}
restoreBrowserDrafts();
setTab(tab);
void start();
