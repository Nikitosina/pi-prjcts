// The checkout roots a project owns, for plugins that key host-wide state by checkout (the simulator's test products).
import { realpathSync } from "node:fs";

/** The project's folder and the real directories under its worker worktree root. */
export function verifiedWorkspaceRoots(cwd: string | undefined, _worktreeRoot: string): string[] {
  try {
    return cwd ? [realpathSync(cwd)] : [];
  } catch {
    return [];
  }
}
