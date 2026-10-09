import { arcanum } from "./arcanum.ts";
import { cli, runCli } from "./vcs.ts";
import type { Project } from "./state.ts";

/** An existing branch a new worker thread continues: the local branch name and the tip its worktree starts from. */
export type ContinuationBranch = { name: string; sha: string };
const HEX40 = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Branch names only: nothing option-like, no traversal, no ref-syntax tricks (the value reaches git/arc argv). */
function cleanName(value: string, what: string): string {
  if (!NAME.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock") || value.includes("@{")) throw new Error(`Invalid ${what} ${JSON.stringify(value)}: use a plain branch name`);
  return value;
}

/**
 * Resolves and authorizes `ref` for a new worker thread to continue (its pushes then update the existing PR).
 * Git: a branch inside the project's branch prefix (never a protected branch). Arc: a branch or PR under the owner's own users/<login>/.
 * Everything is checked before any worktree exists; nothing here writes except fetching the branch into the owner checkout (as PR-head reads do).
 */
export async function resolveContinuationBranch(project: Project, ref: string, scopeId: string | undefined): Promise<ContinuationBranch> {
  const authorization = project.workspaceAuthorization;
  if (!authorization) throw new Error("branch continuation needs an owner-authorized workspace");
  const scope = authorization.scopes.find(item => item.id === scopeId);
  if (!scope) throw new Error("branch continuation needs a workspace scope: pass workspaceScopeId");
  if (scope.wholeRepository !== true) throw new Error("branch continuation needs a whole-repository workspace scope");
  const repository = authorization.repositories.find(item => item.repositoryId === scope.repositoryId);
  if (!repository) throw new Error("Workspace scope repository is not host-authorized");
  return authorization.provider === "arc" ? arcBranch(project, ref, repository.ownerCheckout) : gitBranch(project, ref, repository.ownerCheckout);
}

async function gitBranch(project: Project, ref: string, checkout: string): Promise<ContinuationBranch> {
  if (/^(?:pull\/)?\d+$/.test(ref)) throw new Error("Pass the PR's branch name (a GitHub PR number cannot be resolved to a branch here)");
  const name = cleanName(ref.replace(/^refs\/heads\//, "").replace(/^origin\//, ""), "branch");
  const publication = project.githubAuthorization?.[0];
  const prefix = publication?.branchPrefix ?? "pi/", protectedNames = [publication?.baseBranch, "main", "master"];
  if (!name.startsWith(prefix) || protectedNames.includes(name)) throw new Error(`Branch ${name} is not a project branch (project branches start with ${prefix}); this project may not push to it, so it cannot be continued`);
  const git = (...args: string[]) => runCli(cli.git(), ["-C", checkout, ...args]);
  const fetched = await git("fetch", "--no-tags", "--quiet", "origin", `refs/heads/${name}`);
  // A branch that exists only locally (not pushed yet) is continued from its local tip.
  const sha = (await git("rev-parse", "--verify", "--quiet", fetched.code === 0 ? "FETCH_HEAD^{commit}" : `refs/heads/${name}^{commit}`)).stdout.trim();
  if (!HEX40.test(sha)) throw new Error(`Branch ${name} was not found on origin or locally${fetched.stderr ? `: ${fetched.stderr.trim().slice(-300)}` : ""}`);
  return { name, sha };
}

async function arcBranch(project: Project, ref: string, checkout: string): Promise<ContinuationBranch> {
  const login = project.arcAuthorization?.login;
  if (!login) throw new Error("Arcadia is not connected for this project, so branch ownership cannot be verified");
  const mine = `users/${login}/`;
  let remote: string;
  const pr = /^(?:pull\/)?([1-9][0-9]{0,8})$/.exec(ref)?.[1];
  if (pr) {
    const info = await arcanum<{ author?: { name?: string; uid?: string } | null; vcs?: { from_branch?: string } | null; status?: string }>(["pr", "get", "--id", pr]);
    if (info.author?.name !== login && info.author?.uid !== login) throw new Error(`PR ${pr} was not authored by ${login}; this project may only continue the owner's own PRs`);
    if (!info.vcs?.from_branch) throw new Error(`PR ${pr} has no source branch`);
    remote = info.vcs.from_branch;
  } else remote = ref.startsWith("users/") ? ref : `${mine}${ref}`;
  cleanName(remote, "branch");
  if (!remote.startsWith(mine) || remote.length === mine.length) throw new Error(`Branch ${remote} is not under ${mine}; this project may only continue the owner's own branches`);
  const name = cleanName(remote.slice(mine.length), "branch");
  if (name === "trunk") throw new Error("trunk cannot be continued");
  const log = await runCli(cli.arc(), ["log", "-n", "1", "--oneline", "--no-decorate", remote], checkout);
  const sha = log.stdout.split(/\s+/)[0] ?? "";
  if (log.code || !HEX40.test(sha)) throw new Error(`Branch ${remote} was not found in Arcadia${log.stderr ? `: ${log.stderr.trim().slice(-300)}` : ""}`);
  return { name, sha };
}
