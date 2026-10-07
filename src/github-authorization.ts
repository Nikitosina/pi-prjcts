import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import { parse, type GithubAuthorization, type Project, type Request } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";

const run = promisify(execFile);
const Repository = Type.Object({ id: Type.Integer({ minimum: 1 }), full_name: Type.String(), default_branch: Type.String() });
type Input = Extract<Request, { action: "github-authorize" }>;
type RepositoryInspection = Extract<Request, { action: "github-repository-inspect" }>;

/** Offline E2E suites point this at a fake GitHub CLI; the host otherwise uses the owner's Homebrew gh. */
export function githubCli(): string { return process.env.PI_PROJECTS_GH_CLI || "/opt/homebrew/bin/gh"; }

export async function githubRead(path: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const result = await run(githubCli(), ["api", "--hostname", "github.com", "--method", "GET", path], { encoding: "utf8", signal, timeout: 15000, maxBuffer: 1048576 });
    const value: unknown = JSON.parse(result.stdout);
    return value;
  } catch (error) { throw safeGithubError(error); }
}
export function safeGithubError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "Unknown GitHub failure";
  return new Error(`GitHub operation failed; fingerprint ${createHash("sha256").update(message).digest("hex")}`);
}

export async function checkoutRepository(checkout: string, signal?: AbortSignal): Promise<string> {
  const path = await realpath(checkout);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  try {
    const root = await run("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", env, signal, timeout: 10000, maxBuffer: 4096 });
    if (await realpath(root.stdout.trim()) !== path) throw new Error("Checkout root changed");
    const remote = await run("git", ["-C", path, "config", "--local", "--get", "remote.origin.url"], { encoding: "utf8", env, signal, timeout: 10000, maxBuffer: 4096 });
    const value = remote.stdout.trim();
    const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(value);
    if (ssh?.[1]) return ssh[1];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) throw new Error("Unsupported remote");
    const name = url.pathname.slice(1).replace(/\.git$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error("Invalid remote");
    return name;
  } catch { throw new Error("GitHub publication requires an exact credential-free origin on the authorized checkout"); }
}

export async function inspectGithubRepository(project: Project, input: RepositoryInspection) {
  if (input.id !== project.id || project.archived || project.deleted) throw new Error("Repository inspection requires the active owned project");
  if (await checkoutRepository(project.cwd) !== input.repositoryId) throw new Error("Repository does not match the credential-free origin of the selected checkout");
  const actual = parse(Repository, await githubRead(`repos/${input.repositoryId}`));
  if (actual.full_name !== input.repositoryId) throw new Error("GitHub repository name differs from the authorized checkout origin");
  return { repositoryId: actual.full_name, numericId: actual.id, defaultBranch: actual.default_branch };
}

export async function authorizeGithub(project: Project, input: Input): Promise<GithubAuthorization> {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("GitHub authorization requires confirmation matching project id");
  if (project.archived || project.deleted) throw new Error("Restore the project before authorizing publication");
  const grant = project.workspaceAuthorization;
  const repository = grant?.repositories.find(item => item.repositoryId === input.repositoryId);
  if (grant?.provider !== "github" || grant.owner !== trustedOwner() || repository?.provider !== "github" || !grant.scopes.some(item => item.repositoryId === input.repositoryId)) throw new Error("GitHub publication requires an existing exact workspace grant");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/$/.test(input.branchPrefix) || input.branchPrefix.includes("..") || input.branchPrefix.includes(".lock")) throw new Error("Invalid task branch prefix");
  if (await checkoutRepository(repository.ownerCheckout) !== input.repositoryId) throw new Error("Authorized checkout does not match the requested GitHub repository");
  const actual = parse(Repository, await githubRead(`repos/${input.repositoryId}`));
  if (actual.id !== input.expectedRepositoryId || actual.full_name !== input.repositoryId) throw new Error("GitHub repository identity does not match publication authorization");
  const prior = project.githubAuthorization?.find(item => item.repositoryId === input.repositoryId) ?? project.githubAuthorizationHistory?.find(item => item.authorization.repositoryId === input.repositoryId)?.authorization;
  if (prior && (prior.numericId !== actual.id || prior.branchPrefix !== input.branchPrefix || prior.baseBranch !== actual.default_branch || prior.owner !== trustedOwner())) throw new Error("GitHub publication target is immutable");
  return { repositoryId: actual.full_name, numericId: actual.id, branchPrefix: input.branchPrefix, baseBranch: actual.default_branch, owner: trustedOwner(), workspaceRevision: authorizationFingerprint(project), at: new Date().toISOString(), readInspection: true, ...(input.localPublication === true || (input.localPublication === undefined && prior?.localPublication === true) ? { localPublication: true as const } : {}), ...(input.reviewReplies === true || (input.reviewReplies === undefined && prior?.reviewReplies === true) ? { reviewReplies: true as const } : {}) };
}

/** One-click GitHub defaults come from the checkout origin. The preview stays offline; authorization reads the numeric id and default branch with gh. */
export const QUICK_BRANCH_PREFIX = "pi/";
export type GithubQuickPreview = { available: true; repositoryId: string; branchPrefix: string; reviewReplies: true; localPublication: true } | { available: false; blocker: string };

export async function githubQuickPreview(project: Project, signal?: AbortSignal): Promise<GithubQuickPreview> {
  const grant = project.workspaceAuthorization;
  const scope = grant?.scopes.find(item => item.wholeRepository);
  if (!grant || !scope) return { available: false, blocker: "Let workers edit this repository first (step 1)" };
  const repository = grant.repositories.find(item => item.repositoryId === scope.repositoryId);
  if (!repository || grant.provider !== "github") return { available: false, blocker: "Workspace grant has no GitHub repository" };
  const existing = project.githubAuthorization?.find(item => item.repositoryId === scope.repositoryId);
  if (existing?.workspaceRevision === authorizationFingerprint(project)) return { available: false, blocker: `GitHub is connected for ${existing.repositoryId}` };
  const prior = existing ?? project.githubAuthorizationHistory?.find(item => item.authorization.repositoryId === scope.repositoryId)?.authorization;
  if (prior && prior.branchPrefix !== QUICK_BRANCH_PREFIX) return { available: false, blocker: `${scope.repositoryId} was authorized with branch prefix ${prior.branchPrefix}; use Advanced setup` };
  let origin: string;
  try { origin = await checkoutRepository(repository.ownerCheckout, signal); } catch { return { available: false, blocker: "The checkout's origin is not a github.com remote; use Advanced setup" }; }
  if (origin !== scope.repositoryId) return { available: false, blocker: `Workspace repository ${scope.repositoryId} differs from origin ${origin}; use Advanced setup` };
  return { available: true, repositoryId: origin, branchPrefix: QUICK_BRANCH_PREFIX, reviewReplies: true, localPublication: true };
}

export async function authorizeGithubQuick(project: Project, input: Extract<Request, { action: "github-quick-authorize" }>): Promise<GithubAuthorization> {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("GitHub authorization requires confirmation matching project id");
  const preview = await githubQuickPreview(project);
  if (!preview.available) throw new Error(preview.blocker);
  let actual: { id: number; full_name: string };
  try { actual = parse(Repository, await githubRead(`repos/${preview.repositoryId}`)); } catch { throw new Error(`gh could not read ${preview.repositoryId}; run gh auth login`); }
  if (actual.full_name !== preview.repositoryId) throw new Error(`GitHub reports ${actual.full_name} for origin ${preview.repositoryId}; use Advanced setup`);
  const authorization = await authorizeGithub(project, { action: "github-authorize", id: input.id, confirm: input.confirm, expectedRevision: input.expectedRevision, repositoryId: preview.repositoryId, expectedRepositoryId: actual.id, branchPrefix: preview.branchPrefix, reviewReplies: true, localPublication: true });
  return { ...authorization, oneClick: true };
}

/** One-click authorizations follow workspace grant changes; advanced ones still need re-authorization. */
export function rebindOneClickGithub(project: Project): Project {
  if (!project.githubAuthorization?.some(item => item.oneClick)) return project;
  const revision = authorizationFingerprint(project);
  const repositories = new Set(project.workspaceAuthorization?.scopes.map(scope => scope.repositoryId) ?? []);
  return { ...project, githubAuthorization: project.githubAuthorization.map(item => item.oneClick && repositories.has(item.repositoryId) ? { ...item, workspaceRevision: revision } : item) };
}
