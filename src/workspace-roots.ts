// The checkout roots a project owns, for plugins that key host-wide state by checkout (the simulator's test products).
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * The project's folder and the real directories directly under its worker worktree root, which the host creates and owns. A symlink, a file or
 * a directory that resolves outside the worktree root is not claimed. Nothing is asked of git: a worktree list names checkouts the host never made.
 */
export function verifiedWorkspaceRoots(cwd: string | undefined, worktreeRoot: string): string[] {
  const roots = new Set<string>();
  const folder = cwd ? real(cwd) : null;
  if (folder) roots.add(folder);
  const base = real(worktreeRoot);
  if (base) {
    let names: string[] = [];
    try {
      names = readdirSync(base);
    } catch {
      /* an unreadable root claims nothing */
    }
    for (const name of names) {
      const path = join(base, name);
      try {
        if (!lstatSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      const resolved = real(path);
      if (resolved?.startsWith(base + sep)) roots.add(resolved);
    }
  }
  return [...roots];
}
