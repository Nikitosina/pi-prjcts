import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("host.ts", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
function cleanRevision(): string | null {
  try {
    const git = (...args: string[]) =>
      execFileSync("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
        cwd: root,
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    if (git("status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none")) return null;
    const head = git("rev-parse", "HEAD");
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

export const hostBoot = {
  instance: randomUUID(),
  sha: cleanRevision(),
  previous: process.argv[2] === "--resume-instance" ? process.argv[3] : null,
};

export function assertRestartable() {
  if (!process.execve || process.execArgv.length || realpathSync(process.argv[1]!) !== realpathSync(entry))
    throw new Error("This host launch cannot be restarted in place.");
  if (!hostBoot.sha || cleanRevision() !== hostBoot.sha)
    throw new Error("Cannot verify the running version: the host checkout changed, is dirty or was not clean at startup.");
}

export function replaceHost(home: string): never {
  assertRestartable();
  return process.execve!(process.execPath, [process.execPath, entry, "--resume-instance", hostBoot.instance, hostBoot.sha!], {
    ...process.env,
    PI_PROJECTS_HOME: home,
  });
}
