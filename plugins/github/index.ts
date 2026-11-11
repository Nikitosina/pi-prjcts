import type { HostPluginApi } from "../../src/plugin-types.ts";
import { githubCoordinatorTools } from "./coordinator-tools.ts";

/**
 * The built-in GitHub plugin. Core loads it on every host before configured plugins (`src/plugins.ts`); it shares the reserved
 * `github` identity with the GitHub PR provider, which stays in core for now. Stage 1 holds the Coordinator GitHub tools only.
 */
export default {
  name: "github",
  register(api: HostPluginApi) {
    api.provide({ coordinatorTools: githubCoordinatorTools(api) });
  },
};
