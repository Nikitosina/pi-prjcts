import { createBashTool } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { plugins } from "./plugins.ts";

export const VCS_SHELL_NOTE = "\n\nprojects_vcs_shell runs a shell command in the project checkout to prepare the environment for workers: fetch and inspect branches, PRs and history, create or check out a branch, and list, add, take over, remount or remove worktrees (git worktree, and arc-wt in Arcadia). Only VCS executables and read-only helpers (ls, cat, grep, head, tail, wc, find, jq, echo, cd) are accepted; command substitution and file redirects are refused. Pushing, submitting, merging or publishing PRs, renaming or deleting branches, forced removal, hard resets and cleaning are refused: publication stays with workers and the owner. The checkout belongs to the owner, so leave it on the branch it was on unless the owner asked otherwise. Hand a prepared branch to a worker with the branch field of projects_delegate; the host still allocates each worker's own worktree. Never edit files through this shell.";

// None of these can write files or run other programs (find is checked separately; rg --pre and sort -o could, so they are absent).
const HELPERS = new Set(["ls", "pwd", "cat", "head", "tail", "grep", "wc", "find", "jq", "echo", "printf", "cd", "test", "true", "which", "basename", "dirname", "realpath", "stat", "du", "df", "date"]);

/** Git rules for the owner's checkout: refuses publication, deletion and discarding work. Arguments follow the subcommand. */
function gitBlocked(args: string): boolean {
  // Global options precede the subcommand. -c and config writes could define aliases or hooks that run arbitrary programs; --exec-path picks other subcommand binaries.
  const words = args.split(/\s+/).filter(Boolean);
  let at = 0;
  while (words[at]?.startsWith("-")) {
    const option = words[at++]!;
    if (/^(?:-c|--config-env|--exec-path)(?:=|$)/.test(option)) return true;
    if (option === "-C" || option === "--git-dir" || option === "--work-tree" || option === "--namespace") at++;
  }
  const sub = words.slice(at).join(" ");
  // Options that run another program or write a file.
  if (/(?:^|\s)--(?:output|upload-pack|receive-pack|exec|ext-diff|textconv|open-files-in-pager|extcmd)(?:[\s=]|$)/.test(sub)) return true;
  if (/^(?:difftool|mergetool|bisect|archive|bundle|format-patch)(?:\s|$)/.test(sub) || /^submodule\s+foreach(?:\s|$)/.test(sub)) return true;
  if (/^rebase\s(?:.*\s)?-[a-zA-Z]*x/.test(sub) || /^grep\s(?:.*\s)?-[a-zA-Z]*O/.test(sub) || /^clone\s(?:.*\s)?-[a-zA-Z]*u/.test(sub)) return true;
  if (/^config(?:\s|$)/.test(sub) && !/^config\s+(?:--get\S*|--list|-l)(?:\s|$)/.test(sub)) return true;
  if (/^(?:push|clean|gc|prune|filter-branch|filter-repo|update-ref|replace)(?:\s|$)/.test(sub)) return true;
  if (/^branch\s+.*(?:-\w*[dDmM]|--delete|--move|--force)(?:\s|$)/.test(sub)) return true;
  if (/^(?:reset)\s+.*--(?:hard|merge|keep)(?:\s|$)/.test(sub)) return true;
  if (/^(?:checkout|switch|restore)\s/.test(sub) && /\s(?:--|-f|--force|--discard-changes|\.)(?:\s|$)/.test(` ${sub}`)) return true;
  if (/^stash\s+(?:drop|clear|pop)(?:\s|$)/.test(sub)) return true;
  if (/^worktree\s+(?:remove|prune).*(?:\s-f|--force)/.test(sub)) return true;
  if (/^(?:tag)\s+.*-d(?:\s|$)/.test(sub)) return true;
  return false;
}

/** Best-effort shell-text check, not a sandbox: every segment must start with an allowed executable; one refused segment refuses the command. */
export function guardCoordinatorCommand(command: string): string {
  const providers = plugins.vcsProviders().flatMap(provider => provider.coordinatorShell ? [provider.coordinatorShell] : []);
  const refuse = (at: string, why: string) => {
    const message = `Blocked by coordinator VCS shell policy at: ${at.slice(0, 200)} -- ${why}. Nothing in this command ran. Delegate edits, commits, pushes and PRs to a worker.`;
    return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
  };
  if (/`|\$\(|<\(|>\(/.test(command)) return refuse(command, "command substitution is not allowed");
  // Output only to the terminal: 2>&1 and /dev/null are the only redirects.
  const plain = command.replace(/[0-9&]?>{1,2}\s*(?:&[12]|\/dev\/null)(?=\s|$|[;&|])/g, " ");
  if (plain.includes(">")) return refuse(command, "file redirects are not allowed");
  for (const chunk of plain.split(/&&|\|\||[;&|\n]/).map(part => part.trim()).filter(Boolean)) {
    // GIT_EXTERNAL_DIFF, GIT_PAGER and similar variables make git run other programs.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(chunk)) return refuse(chunk, "environment assignments are not allowed");
    const [path = "", ...rest] = chunk.split(/\s+/), executable = path.split("/").at(-1)!, args = rest.join(" ");
    if (executable === "git") { if (gitBlocked(args)) return refuse(chunk, "pushes, deletes, forced or discarding operations are not allowed"); continue; }
    if (executable === "find" && /\s-(?:delete|exec|execdir|ok|fprint|fls)/.test(` ${args}`)) return refuse(chunk, "find may only list files");
    if (HELPERS.has(executable)) continue;
    const provider = providers.find(item => item.executables.includes(executable));
    if (!provider) return refuse(chunk, `${executable} is not a VCS executable or read-only helper`);
    const why = provider.blocked(executable, args);
    if (why) return refuse(chunk, why);
  }
  return command;
}

export function coordinatorShellTools(input: { cwd: string; isCoordinator: (id: Conversation["id"]) => boolean }) {
  const bash = createBashTool(input.cwd, { spawnHook: ({ command, ...context }) => ({ ...context, command: guardCoordinatorCommand(command) }) });
  const authorize = (api: ToolExecutionApi) => { if (!input.isCoordinator(api.conversationId)) throw Error("projects_vcs_shell is coordinator-only"); };
  const shell = defineTool({ name: "projects_vcs_shell", description: "Run a VCS command (git, and arc/arc-wt in Arcadia) or a read-only helper in the project checkout to prepare branches and worktrees for workers. Publication, merges, deletes, forced and discarding operations, redirects and command substitution are refused. Output is capped at 400 lines / 16 KB, keeping the end: bound history with -n or --max-count and narrow listings with paths, grep or head.", parameters: bash.parameters, replay: "unsafe", outputLimits: { maxBytes: 16 * 1024, maxLines: 400, retain: "tail" }, async execute(args, api, context) {
    authorize(api);
    return bash.execute(api.callId, args, context.abortSignal, update => api.output(update.content.map(item => item.type === "text" ? item.text : "").join("")));
  } });
  const tools = [shell];
  return { tools, extension: defineExtension({ name: "projects.coordinator-shell", tools }) };
}
