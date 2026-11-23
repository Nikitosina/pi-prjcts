import { plugins } from "./plugins.ts";
import type { Project } from "./state.ts";
import { cli, findVcsRoot, runCli, DEFAULT_BASES } from "./vcs.ts";

export async function readyFiles(cwd: string, candidate: string, project: Project, scopeId: string | null): Promise<string> {
  const vcs = findVcsRoot(cwd, project);
  if (!vcs) return "unavailable";
  let status: string | undefined;
  if (vcs.kind === "git") {
    const git = (...args: string[]) => runCli(cli.git(), args, vcs.root);
    const repository = project.workspaceAuthorization?.scopes.find((scope) => scope.id === scopeId)?.repositoryId;
    const base = project.githubAuthorization?.find((grant) => grant.repositoryId === repository)?.baseBranch;
    for (const ref of base ? [`refs/remotes/origin/${base}`, `refs/heads/${base}`] : DEFAULT_BASES) {
      if ((await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`)).code) continue;
      const diff = await git(
        "diff",
        "--name-status",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--diff-filter=ADR",
        `${ref}...${candidate}`,
        "--",
      );
      if (!diff.code) status = diff.stdout;
      break;
    }
  } else {
    status = await plugins.vcsProvider(vcs.kind, project)?.candidateNameStatus?.(vcs.root, candidate);
  }
  if (status === undefined) return "unavailable";
  const rows = status.split("\n").filter((line) => /^(?:A|D|R\d*)\t/.test(line));
  const shown = rows.slice(0, 20).map((line) => (line.length > 300 ? `${line.slice(0, 299)}…` : line));
  if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} omitted`);
  return shown.join("\n") || "none";
}
