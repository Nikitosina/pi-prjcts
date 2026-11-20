import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const hostCheckout = fileURLToPath(new URL("..", import.meta.url));
/** Read local objects only, even in a partial clone or a worker environment with Git overrides. */
export const readHostGit = (...args: string[]) =>
  execFileSync("/usr/bin/git", ["--no-replace-objects", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: hostCheckout,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    timeout: 5000,
  });
