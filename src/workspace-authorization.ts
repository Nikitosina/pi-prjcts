import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { Project, WorkspaceAuthorization } from "./state.ts";
import { findVcsRoot } from "./vcs.ts";
import { plugins } from "./plugins.ts";
import type { QuickWorkspacePreview } from "./plugin-types.ts";
export type { QuickWorkspacePreview } from "./plugin-types.ts";

export type WorkspaceCatalogEntry = Readonly<{ note?: string; id: string; repositoryId: string; provider: string; files: readonly string[]; baseRevision: string; evidenceCapture?: boolean; wholeRepository?: boolean; commands?: readonly { id: string; label: string; effect: string; timeoutMs: number }[] }>;

/** The only owner identity accepted by the local trusted host surface. */
export function trustedOwner(): string { return `uid:${process.getuid?.() ?? userInfo().username}`; }

export function catalog(project: Project): readonly WorkspaceCatalogEntry[] {
  return (project.workspaceAuthorization?.scopes ?? []).map(scope => ({
    id: scope.id, repositoryId: scope.repositoryId, provider: project.workspaceAuthorization!.provider,
    files: [...scope.files], baseRevision: scope.baseRevision, evidenceCapture: scope.evidenceCapture === true,
    ...(scope.wholeRepository ? { wholeRepository: true, note: project.workspaceAuthorization!.provider === "github" ? "Any repository path except VCS metadata; each new worker thread starts from current owner HEAD; with GitHub authorized, workers push their own pi/ branch and the host opens a draft PR" : plugins.workspaceProvider(project.workspaceAuthorization!.provider)?.wholeRepositoryNote ?? "Any repository path except VCS metadata (workspace provider plugin not loaded)" } : {}),
    commands: (project.commandProfiles ?? []).filter(profile => profile.enabled && profile.scopeIds.includes(scope.id) && profile.repositoryId === scope.repositoryId && profile.workspaceRevision === authorizationFingerprint(project)).map(profile => ({ id: profile.id, label: profile.label, effect: profile.effect, timeoutMs: profile.timeoutMs })),
  }));
}

export function grantWorkspace(input: { project: Project; repositoryId: string; provider: "github"; ownerCheckout: string; approvedRoot: string; fileOwnershipPrefix: string; files: readonly string[]; baseRevision: string; evidenceCapture?: boolean }): { project: Project; scope: WorkspaceCatalogEntry } {
  if (input.provider !== "github") throw new Error("New workspace grants require the github provider");
  const checkout = realpathSync(input.ownerCheckout);
  const root = realpathSync(input.approvedRoot);
  if (checkout !== resolve(input.project.cwd)) throw new Error("Owner checkout must equal the project workspace");
  if (resolve(root) === resolve(checkout)) throw new Error("Approved root must be distinct from the owner checkout");
  if (!statSync(root).isDirectory()) throw new Error("Approved root must be a directory");
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const actualRoot = execFileSync("git", ["-C", checkout, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: gitEnv }).trim();
  if (resolve(actualRoot) !== checkout) throw new Error("Owner checkout is not a Git repository");
  const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv }).trim();
  if (head !== input.baseRevision || !/^[0-9a-f]{40}$/.test(input.baseRevision)) throw new Error("Base revision does not match the owner checkout HEAD");
  if (!/^[^\\/]+(?:\/[^\\/]+)*$/.test(input.fileOwnershipPrefix)) throw new Error("Invalid file ownership prefix");
  if (input.files.length === 0 || input.files.some(file => file !== input.fileOwnershipPrefix && !file.startsWith(`${input.fileOwnershipPrefix}/`) || file.includes("\\") || file.split("/").some(part => !part || part === "." || part === ".."))) throw new Error("Files must remain under the ownership prefix");
  const scope = { id: randomUUID(), repositoryId: input.repositoryId, files: [...input.files], baseRevision: input.baseRevision, ...(input.evidenceCapture === true ? { evidenceCapture: true as const } : {}) };
  return addScope(input.project, { repositoryId: input.repositoryId, provider: input.provider, ownerCheckout: checkout, approvedRoot: root, fileOwnershipPrefix: input.fileOwnershipPrefix, sharedObjectStore: null }, scope);
}

function addScope(project: Project, repository: WorkspaceAuthorization["repositories"][number], scope: WorkspaceAuthorization["scopes"][number]): { project: Project; scope: WorkspaceCatalogEntry } {
  const input = { project, repositoryId: repository.repositoryId, provider: repository.provider };
  const existing = input.project.workspaceAuthorization;
  if (existing && (existing.owner !== trustedOwner() || existing.provider !== input.provider)) throw new Error("Workspace authorization owner/provider is immutable");
  const previous = existing?.repositories.find(item => item.repositoryId === input.repositoryId);
  const previousHistory = input.project.workspaceAuthorizationHistory?.find(item => item.repositoryId === input.repositoryId);
  const repositoryDigest = workspaceRepositoryFingerprint(repository);
  if (previous && (previous.provider !== repository.provider || previous.ownerCheckout !== repository.ownerCheckout || previous.approvedRoot !== repository.approvedRoot || previous.fileOwnershipPrefix !== repository.fileOwnershipPrefix || (previous.sharedObjectStore ?? null) !== (repository.sharedObjectStore ?? null) || (previous.subpath ?? "") !== (repository.subpath ?? "")) || previousHistory && previousHistory.repositorySha256 !== repositoryDigest) throw new Error("Repository authorization is immutable; use a new repository id");
  const authorization: WorkspaceAuthorization = existing ? { ...existing, repositories: previous ? existing.repositories : [...existing.repositories, repository], scopes: [...existing.scopes, scope] } : { version: 1, provider: input.provider, owner: trustedOwner(), repositories: [repository], scopes: [scope] };
  return { project: { ...input.project, workspaceAuthorization: authorization }, scope: { ...scope, provider: input.provider } };
}

export function workspaceRepositoryFingerprint(repository: { repositoryId: string; provider: string; ownerCheckout: string; approvedRoot: string; fileOwnershipPrefix: string; sharedObjectStore?: string | null; subpath?: string }): string {
  // subpath is part of the digest only when set, so fingerprints of existing grants do not change.
  return createHash("sha256").update(JSON.stringify({ repositoryId: repository.repositoryId, provider: repository.provider, ownerCheckout: repository.ownerCheckout, approvedRoot: repository.approvedRoot, fileOwnershipPrefix: repository.fileOwnershipPrefix, sharedObjectStore: repository.sharedObjectStore ?? null, ...(repository.subpath ? { subpath: repository.subpath } : {}) })).digest("hex");
}
export function authorizationFingerprint(project: Project): string { return createHash("sha256").update(JSON.stringify(project.workspaceAuthorization ?? null)).digest("hex"); }
export function workspaceAuthorizationRevision(project: Project): string { return createHash("sha256").update(JSON.stringify([project.workspaceAuthorization ?? null, project.workspaceAuthorizationHistory ?? []])).digest("hex"); }

/** Whole-repository repositories use "." as their ownership prefix; scopes carry no file list. */
export const WHOLE_REPOSITORY_PREFIX = ".";
const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

/** Derives every whole-repository grant field from the project checkout; the owner only confirms. */
export function quickWorkspacePreview(project: Project, approvedRoot: string): QuickWorkspacePreview {
  if (project.workspaceAuthorization?.scopes.some(scope => scope.wholeRepository)) return { available: false, blocker: "Workers can already edit this repository" };
  const found = existsSync(project.cwd) ? findVcsRoot(project.cwd) : null;
  if (found && found.kind !== "git") { const provider = plugins.workspaceProvider(found.kind); return provider ? provider.quickPreview(project, found.root) : { available: false, blocker: `No workspace provider plugin is loaded for ${found.kind} checkouts` }; }
  let checkout: string, head: string, dirty: boolean, origin = "";
  try {
    checkout = realpathSync(project.cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (resolve(git("rev-parse", "--show-toplevel")) !== checkout) return { available: false, blocker: `Project folder ${checkout} is not the root of a Git repository` };
    head = git("rev-parse", "HEAD");
    dirty = git("status", "--porcelain=v1", "--untracked-files=all").length > 0;
    try { origin = git("remote", "get-url", "origin"); } catch { origin = ""; }
  } catch { return { available: false, blocker: `Project folder ${project.cwd} is not a Git repository with at least one commit` }; }
  const github = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(origin);
  const repositoryId = github ? `${github[1]}/${github[2]}` : `local/${basename(checkout)}`;
  const root = existsSync(approvedRoot) ? realpathSync(approvedRoot) : approvedRoot;
  const digest = workspaceRepositoryFingerprint({ repositoryId, provider: "github", ownerCheckout: checkout, approvedRoot: root, fileOwnershipPrefix: WHOLE_REPOSITORY_PREFIX, sharedObjectStore: null });
  const active = project.workspaceAuthorization?.repositories.find(item => item.repositoryId === repositoryId), revoked = project.workspaceAuthorizationHistory?.find(item => item.repositoryId === repositoryId);
  if (active && workspaceRepositoryFingerprint(active) !== digest || revoked && revoked.repositorySha256 !== digest) return { available: false, blocker: `Repository ${repositoryId} already has a folder-limited grant; use Advanced setup` };
  return { available: true, provider: "github", repositoryId, ownerCheckout: checkout, approvedRoot: root, head, dirty };
}

export function grantWholeRepository(project: Project, approvedRoot: string): { project: Project; scope: WorkspaceCatalogEntry } {
  const preview = quickWorkspacePreview(project, approvedRoot);
  if (!preview.available) throw new Error(preview.blocker);
  if (preview.provider !== "github") {
    mkdirSync(preview.approvedRoot, { recursive: true, mode: 0o700 });
    return addScope(project, { repositoryId: preview.repositoryId, provider: preview.provider, ownerCheckout: preview.ownerCheckout, approvedRoot: realpathSync(preview.approvedRoot), fileOwnershipPrefix: WHOLE_REPOSITORY_PREFIX, sharedObjectStore: preview.sharedObjectStore!, ...(preview.subpath ? { subpath: preview.subpath } : {}) }, { id: randomUUID(), repositoryId: preview.repositoryId, files: [], baseRevision: preview.head, wholeRepository: true });
  }
  mkdirSync(approvedRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(approvedRoot);
  if (root === preview.ownerCheckout || root.startsWith(`${preview.ownerCheckout}/`)) throw new Error("Worker worktrees must live outside the project checkout");
  return addScope(project, { repositoryId: preview.repositoryId, provider: "github", ownerCheckout: preview.ownerCheckout, approvedRoot: root, fileOwnershipPrefix: WHOLE_REPOSITORY_PREFIX, sharedObjectStore: null }, { id: randomUUID(), repositoryId: preview.repositoryId, files: [], baseRevision: preview.head, wholeRepository: true });
}
