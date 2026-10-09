/** Worker shell policy and naming for Arc worktrees. Best-effort text checks, like the git policy: not a sandbox. */
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** `KEYBOARD-15934-<slug>` when the task names a Tracker ticket, else `pi-<thread>-<slug>`. The local name is never prefixed: arc adds users/<login>/ on push. */
export function arcBranchName(task: string, threadId: string): string {
  const ticket = TICKET.exec(task)?.[0];
  const slug = (task.split("\n")[0] ?? "").replace(TICKET, " ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const head = ticket ?? `pi-${threadId.replaceAll("-", "").slice(0, 8)}`;
  return slug ? `${head}-${slug}` : head;
}
/** First of name, name-2, name-3 … that is not taken. */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base}-${n}`; if (!taken.has(name)) return name; }
}
export const arcTicket = (task: string): string | undefined => TICKET.exec(task)?.[0];

const stripNamespace = (ref: string) => ref.replace(/^\+/, "").replace(/^refs\/heads\//, "").replace(/^users\/[^/]+\//, "");

/**
 * Pushes may go to a branch this project allocated (`owned`), never delete, never set an upstream (the users/ prefix would double),
 * never to trunk or releases. A bare push or force push also checks, when it runs, that the checked-out branch is an owned one.
 * Merging, publishing, discarding PRs, `arc submit`, mount and worktree management stay with the owner and the host.
 */
export function guardWorkerArcCommand(command: string, policy: { branch: string; owned: ReadonlySet<string> }): string {
  const owned = new Set([policy.branch, ...policy.owned]);
  const chunks = command.split(/[;&|\n]+/).map(part => part.trim());
  let needsBranchCheck = false;
  const blocked = chunks.find(chunk => {
    const body = chunk.replace(/^(?:\w+=\S*\s+)+/, "").replace(/^(?:sudo|command|exec|nohup)\s+/, "");
    if (/^(?:git|gh)(?:\s|$)/.test(body)) return true;
    if (/^(?:\/\S*\/)?arc-wt(?:\s|$)/.test(body)) return !/^\S+\s+(?:list|config)(?:\s|$)/.test(body);
    if (/\barcanum(?:-go)?\b.*\b(?:merge|publish|auto-merge|discard)\b/.test(body)) return true;
    const arc = /^(?:\/\S*\/)?arc\s+(.*)$/.exec(body)?.[1]?.trim();
    if (arc === undefined) return false;
    if (/^(?:submit|mount|unmount|umount)(?:\s|$)/.test(arc)) return true;
    if (/^branch\s+(?:-\w*[dD]|--delete)/.test(arc)) return true;
    if (/^pr\s+(?:merge|publish|discard|auto-merge)(?:\s|$)/.test(arc)) return true;
    if (/^pr\s+create(?:\s|$)/.test(arc)) return !/--publish(?:=|\s+)disabled/.test(arc);
    // The checked-out branch decides what a bare push publishes: only project branches (or trunk, read-only) may be checked out; no new branches.
    if (/^(?:checkout|switch)(?:\s|$)/.test(arc)) {
      const args = arc.replace(/^\S+\s*/, "").split(/\s+/).filter(Boolean);
      if (args.includes("--")) return false;
      if (args.some(value => /^-[bBcC]$/.test(value) || value === "--orphan" || value === "--create")) return true;
      const target = args.filter(value => !value.startsWith("-"))[0];
      return target !== undefined && !(target === "trunk" || /^[0-9a-f]{7,64}$/.test(target) || owned.has(stripNamespace(target)));
    }
    if (/^push(?:\s|$)/.test(arc)) {
      const args = arc.replace(/^push\s*/, "").split(/\s+/).filter(Boolean);
      if (args.some(value => /^--(?:delete|all|mirror|tags|set-upstream|prune)$/.test(value) || /^-[a-zA-Z]*[dDu]/.test(value) && !value.startsWith("--"))) return true;
      const refs = args.filter(value => !value.startsWith("-"));
      if (refs.some(ref => !owned.has(stripNamespace(ref.includes(":") ? ref.split(":").at(-1)! : ref)))) return true;
      if (!refs.length) needsBranchCheck = true;
      return false;
    }
    return false;
  });
  if (blocked !== undefined) {
    const message = `Blocked by worker Arc policy at: ${blocked.slice(0, 200)} -- use arc (never git, gh or arc-wt); push only your own project branch (${[...owned].slice(0, 5).join(", ")}) with a bare \`arc push\` (arc adds users/<login>/; never -u users/...); no deletes, upstream changes, \`arc submit\`, mounts, or PR merge/publish/discard (the host opens draft PRs; the owner merges). Nothing in this command ran. This check is best-effort.`;
    return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
  }
  if (!needsBranchCheck) return command;
  // Bare push: whatever branch is checked out must be one of ours (another owner branch also lives under users/<login>/).
  const alternatives = [...owned].map(name => name.replace(/[^A-Za-z0-9._-]/g, "")).filter(Boolean).join("|");
  const check = `arc info --json 2>/dev/null | grep -Eq '"branch" *: *"(users/[^/"]+/)?(${alternatives})"'`;
  const refusal = "Blocked by worker Arc policy: the checked-out branch is not a branch of this project, so nothing was pushed. Check out your project branch first.";
  return `${check} || { printf '%s\\n' '${refusal}' >&2; exit 126; }; ${command}`;
}

/** Worker instruction block for an Arc worktree. */
export function arcWorkerInstructions(input: { branch: string; login: string | undefined; subpath: string; ticket: string | undefined; baseRevision: string }): string {
  const server = input.login ? `users/${input.login}/${input.branch}` : `users/<login>/${input.branch}`;
  return `\n\nArc mode (Arcadia): use arc, never git or gh, and never arc-wt (the host leases and removes your worktree). Your worktree is an isolated arc-wt checkout of the Arc monorepo started from trunk (${input.baseRevision.slice(0, 12)}); you work in its project folder${input.subpath ? ` (${input.subpath})` : ""}. Your branch is ${input.branch}; on the server it is ${server} (arc adds the namespace: push with a bare \`arc push\`, never \`-u users/...\`, which doubles the prefix). Commit with arc add and arc commit${input.ticket ? ` and start commit messages with ${input.ticket}` : ""}; read committed files with arc show. Update from trunk with arc pull trunk or arc rebase; after a rebase use arc push -f, only on your own project branch. Never delete branches, run arc submit, mount or unmount, or merge, publish or discard PRs; the host opens draft PRs and the owner approves merges. Do not change Tracker ticket statuses.`;
}
