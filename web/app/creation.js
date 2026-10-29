import {
  UiRequestError,
  api,
  captureDrafts,
  changeProject,
  dialog,
  dialogVersion,
  disableActions,
  draftPairs,
  draftText,
  getGeneration,
  getProjectId,
  isBusy,
  onBusyChange,
  persistBrowserDrafts,
  persistDraftsSafely,
  projects,
  registerActions,
  registerDrafts,
  registerForms,
  setBusy,
  setProjects,
  showDialog,
  toast,
  uiFrame,
} from "./shell.js";
import { esc, uuid } from "./format.js";

const creationDrafts = new Map();
onBusyChange(() => {
  document.querySelector("#create").disabled = isBusy();
});

function createDialog() {
  if (!creationDrafts.size) {
    newCreationDraft();
    return;
  }
  showDialog(
    "Retained creation drafts",
    `<p>Unknown outcomes cannot be resubmitted. Inspect the project list before explicitly starting a separate new draft. Draft UUIDs are client identities, not backend idempotency receipts.</p><button data-action="creation-new">Start a separate new draft</button>${[...creationDrafts].map(([id, draft]) => `<article class="task"><strong>${esc(draft.name || "Unnamed draft")}</strong><p>${esc(draft.outcome)} ${draft.createdId ? `· created project ${esc(draft.createdId)}` : ""}</p><button data-action="creation-edit" data-draft="${esc(id)}">Inspect ${draft.outcome === "draft" ? "/ edit" : "retained outcome"}</button>${draft.outcome === "created" ? `<button data-action="creation-dismiss" data-draft="${esc(id)}">Dismiss known-success client entry</button>` : ""}</article>`).join("")}`,
  );
}
function newCreationDraft() {
  captureDrafts();
  const id = crypto.randomUUID();
  creationDrafts.set(id, { name: "", cwd: "", objective: "", outcome: "draft", createdId: null, requestBound: true });
  persistBrowserDrafts();
  creationEdit(id);
}
function creationEdit(id) {
  const draft = creationDrafts.get(id);
  if (!draft) throw new Error("Unknown retained creation draft");
  if (draft.outcome !== "draft") {
    showDialog(
      "Retained creation outcome",
      `<p>${draft.outcome === "created" ? `Project ${esc(draft.createdId)} was created. Open its known UUID; do not recreate it.` : draft.requestBound === true ? `Creation outcome is unknown. An explicitly confirmed exact retry uses bound request/project UUID ${esc(id)}, without restoring or resuming it.` : "Old creation outcome is unbound. This draft cannot be resubmitted. Inspect the owned project list before starting any separate creation."}</p><pre>${esc(JSON.stringify({ name: draft.name, cwd: draft.cwd, objective: draft.objective }, null, 2))}</pre>${draft.outcome === "unknown" && draft.requestBound === true ? `<form data-create data-draft="${esc(id)}" data-retry="true"><label class="checkbox"><input name="trusted" type="checkbox" required><span>Retry exactly this stored creation request using the same UUID and inputs. Do not restore, resume or replace any existing project.</span></label><button type="submit">Retry the exact bound request</button></form>` : ""}<button data-action="creation-list">Back to retained drafts</button>`,
    );
    return;
  }
  showDialog(
    "New project",
    `<form data-create data-draft="${esc(id)}"><label><span>Project name</span><input name="name" maxlength="120" value="${esc(draft.name)}" required></label><label><span>Folder</span><input name="cwd" maxlength="32000" value="${esc(draft.cwd)}" placeholder="/Users/you/Projects/my-app" required></label><label><span>Objective <small>(optional)</small></span><textarea name="objective" maxlength="32000" rows="3" placeholder="What should the coordinator help you achieve?">${esc(draft.objective)}</textarea></label><label class="checkbox"><input name="trusted" type="checkbox" required><span>I trust this folder. Workers still need separate permission to edit code or publish.</span></label><button class="primary" type="submit">Create project</button></form>`,
  );
  dialog.querySelector("input").focus();
}
function captureCreationDraft() {
  const form = dialog.querySelector("[data-create]"),
    draft = form && creationDrafts.get(form.dataset.draft);
  if (!draft || draft.outcome !== "draft") return;
  for (const field of ["name", "cwd", "objective"]) draft[field] = form.elements.namedItem(field).value;
}

export async function resumeDialog() {
  const id = getProjectId();
  const version = showDialog("Resume this project?", '<p class="note">Reading the saved plan…</p>');
  const plan = await api({ action: "plan-snapshot", id });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId()) return;
  dialog.querySelector(".dialog-body").innerHTML =
    `<details><summary>Saved plan</summary><pre>${esc(JSON.stringify(plan, null, 2))}</pre></details><p>Resume restarts work the pause interrupted, on the same threads and worktrees. Stopped and failed work stays as it is.</p><form data-resume-project data-project="${esc(id)}"><input type="hidden" name="confirm" value="${esc(id)}"><button type="submit" class="primary">Resume and continue work</button></form><hr><p class="note">A project with no prior work can resume without confirmation.</p><button data-action="confirm-resume" data-project="${esc(id)}">Resume idle project</button>`;
  disableActions();
}
registerActions({
  "creation-list"() {
    createDialog();
  },
  "creation-new"() {
    newCreationDraft();
  },
  "creation-edit"(node) {
    creationEdit(node.dataset.draft);
  },
  "creation-dismiss"(node) {
    const draft = creationDrafts.get(node.dataset.draft);
    if (!draft || draft.outcome !== "created" || !uuid(draft.createdId))
      throw new Error("Only known-success creation entries may be dismissed");
    creationDrafts.delete(node.dataset.draft);
    persistBrowserDrafts();
    createDialog();
  },
});
registerForms([
  [
    "[data-create]",
    async (form) => {
      const data = new FormData(form);
      if (isBusy()) return;
      if (!data.has("trusted")) throw new Error("Approve the trusted workspace before creating it");
      captureCreationDraft();
      const creation = creationDrafts.get(form.dataset.draft);
      const retry = form.dataset.retry === "true";
      if (!creation || (retry ? creation.outcome !== "unknown" || creation.requestBound !== true : creation.outcome !== "draft"))
        throw new Error("Only a fresh draft or explicitly confirmed exact bound retry may be submitted");
      const payload = {
        action: "create",
        requestId: form.dataset.draft,
        name: creation.name.trim(),
        cwd: creation.cwd.trim(),
        objective: creation.objective.trim(),
      };
      if (!payload.name || !payload.cwd) throw new Error("Project name and workspace path are required");
      const previousOutcome = creation.outcome,
        previousBinding = creation.requestBound;
      creation.outcome = "unknown";
      creation.requestBound = true;
      try {
        persistBrowserDrafts();
      } catch (error) {
        creation.outcome = previousOutcome;
        creation.requestBound = previousBinding;
        throw error;
      }
      for (const field of ["name", "cwd", "objective"]) {
        const control = form.elements.namedItem(field);
        if (control && "readOnly" in control) control.readOnly = true;
      }
      const frame = uiFrame();
      setBusy(true);
      disableActions();
      try {
        const p = await api(payload);
        if (!p || p.id !== payload.requestId || !uuid(p.id))
          throw new Error("Creation response differs from its bound project UUID; inspect the original request before any new creation");
        creation.outcome = "created";
        creation.createdId = p.id;
        persistDraftsSafely();
        if (!projects.some((project) => project.id === p.id)) projects.push(p);
        toast(`Project created: ${p.id}. Do not recreate it if list refresh fails.`);
        if (
          frame.projectId !== getProjectId() ||
          frame.generation !== getGeneration() ||
          frame.dialogVersion !== dialogVersion ||
          !dialog.open
        )
          return;
        let loaded;
        try {
          loaded = await api({ action: "list" });
        } catch (error) {
          throw new UiRequestError(
            `Project ${p.id} was created, but listing failed: ${error instanceof Error ? error.message : String(error)}. Open its known UUID or refresh the list; do not recreate it.`,
            frame,
          );
        }
        if (
          frame.projectId !== getProjectId() ||
          frame.generation !== getGeneration() ||
          frame.dialogVersion !== dialogVersion ||
          !dialog.open
        )
          return;
        if (!loaded.some((project) => project.id === p.id)) loaded.push(p);
        setProjects(loaded);
        changeProject(p.id);
      } finally {
        setBusy(false);
        disableActions();
      }
    },
  ],
]);
document.addEventListener("input", (event) => {
  if (!event.target.closest("[data-create]")) return;
  captureCreationDraft();
  persistDraftsSafely();
});
document.querySelector("#create").addEventListener("click", createDialog);
registerDrafts({
  key: "creations",
  entries: () => [...creationDrafts],
  validate(pairs) {
    if (
      !draftPairs(pairs) ||
      pairs.some(
        ([id, value]) =>
          !uuid(id) ||
          !value ||
          typeof value.name !== "string" ||
          value.name.length > 120 ||
          !draftText(value.cwd) ||
          !draftText(value.objective) ||
          !["draft", "unknown", "created"].includes(value.outcome) ||
          (value.requestBound !== undefined && typeof value.requestBound !== "boolean") ||
          (value.outcome === "created"
            ? !uuid(value.createdId) || (value.requestBound === true && value.createdId !== id)
            : value.createdId !== null),
      )
    )
      throw new Error("Malformed creation drafts; nothing restored or truncated");
  },
  restore(pairs) {
    for (const [id, value] of pairs)
      creationDrafts.set(id, {
        name: value.name,
        cwd: value.cwd,
        objective: value.objective,
        outcome: value.outcome,
        createdId: value.createdId,
        ...(value.requestBound === undefined ? {} : { requestBound: value.requestBound }),
      });
  },
  capture: captureCreationDraft,
});
