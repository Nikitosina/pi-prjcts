import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

/** Recorded calls keep their old name; new coordinator turns use the standard bash tool. */
export function coordinatorShellTools(bash: ToolRegistration) {
  const legacy = defineTool({
    name: "projects_vcs_shell",
    description:
      "Run a shell command in this chat's worktree. Integrating task branches is ordinary work. Final merge to main, deployment and destructive actions require explicit owner approval.",
    parameters: bash.parameters,
    replay: "unsafe",
    execute: (args, api, context) => bash.execute(args, api, context),
  });
  return { tools: [legacy], extension: defineExtension({ name: "projects.coordinator-shell", tools: [legacy] }) };
}
