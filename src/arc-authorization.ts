import type { ArcAuthorization, Project, Request } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";
import { arcFacts, findVcsRoot } from "./vcs.ts";

/** One-click Arcadia, the counterpart of one-click GitHub: needs the Arc whole-repository grant; derives the login from `arc info`. Offline: no Arcanum call. */
export type ArcQuickPreview = { available: true; repositoryId: string; login: string; baseBranch: "trunk" } | { available: false; blocker: string };

export function arcQuickPreview(project: Project): ArcQuickPreview {
  const grant = project.workspaceAuthorization, scope = grant?.scopes.find(item => item.wholeRepository);
  if (!grant || !scope) return { available: false, blocker: "Let workers edit this repository first (step 1)" };
  if (grant.provider !== "arc") return { available: false, blocker: "Workspace grant is not an Arc checkout" };
  const existing = project.arcAuthorization;
  if (existing?.workspaceRevision === authorizationFingerprint(project)) return { available: false, blocker: `Arcadia is connected for ${existing.repositoryId}` };
  const found = findVcsRoot(project.cwd);
  if (found?.kind !== "arc") return { available: false, blocker: "The project folder is no longer an Arc checkout" };
  const facts = arcFacts(project.cwd, found.root);
  if (!facts.ok) return { available: false, blocker: facts.blocker };
  if (facts.facts.repository !== scope.repositoryId) return { available: false, blocker: `Workspace repository ${scope.repositoryId} differs from ${facts.facts.repository}; use Advanced setup` };
  return { available: true, repositoryId: scope.repositoryId, login: facts.facts.login, baseBranch: "trunk" };
}

export function authorizeArcQuick(project: Project, input: Extract<Request, { action: "arc-quick-authorize" }>): ArcAuthorization {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("Arcadia authorization requires confirmation matching project id");
  const preview = arcQuickPreview(project);
  if (!preview.available) throw new Error(preview.blocker);
  return { repositoryId: preview.repositoryId, login: preview.login, baseBranch: preview.baseBranch, owner: trustedOwner(), workspaceRevision: authorizationFingerprint(project), at: new Date().toISOString() };
}

/** The authorization follows workspace grant changes, like one-click GitHub. */
export function rebindArc(project: Project): Project {
  const arc = project.arcAuthorization;
  if (!arc || !project.workspaceAuthorization?.scopes.some(scope => scope.repositoryId === arc.repositoryId)) return project;
  return { ...project, arcAuthorization: { ...arc, workspaceRevision: authorizationFingerprint(project) } };
}
