import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { Request, errorText, type Request as RequestData } from "./state.ts";
import { fitJson } from "./response-limit.ts";
import type { FocusTarget } from "./change-feed.ts";

type Action = RequestData["action"];
/** What the Host agent may do with one host action: run it, ask the owner first, or never (with the reason). */
export type ActionPolicy =
  { kind: "allow"; description: string } | { kind: "dangerous"; description: string } | { kind: "exclude"; reason: string };
const allow = (description: string): ActionPolicy => ({ kind: "allow", description });
const dangerous = (description: string): ActionPolicy => ({ kind: "dangerous", description });
const exclude = (reason: string): ActionPolicy => ({ kind: "exclude", reason });

/** The contract's minimum list of actions that need the owner's approval (docs/ui2-contract.md); `remove` has no request yet. */
export const DANGEROUS_MINIMUM = [
  "delete",
  "archive",
  "remove",
  "job-approve",
  "deploy-start",
  "workspace-revoke",
  "github-revoke",
  "telegram-unpair",
  "upload-delete",
  "worktrees-cleanup",
  "remote-revoke",
] as const;

/**
 * Every host action, keyed so TypeScript refuses a `Request` member without an entry: a new UI action reaches the Host agent
 * with one line here, or states why it must not. `scripts/host-agent-e2e.mjs` checks the map against the live union.
 */
export const ACTION_POLICY: Record<Action, ActionPolicy> = {
  "remote-reload": allow("Reload remote access configuration."),
  "remote-status": allow("Remote access status."),
  "remote-devices": allow("Paired remote devices."),
  "remote-pair-start": exclude("Pairing issues a code that grants a new device control of the host; the owner pairs in person."),
  "remote-pair-cancel": allow("Cancel a pending device pairing."),
  "remote-revoke": dangerous("Revoke a paired remote device."),
  "remote-rename": allow("Rename a paired remote device."),
  "command-intent-inspect": allow("Inspect one recorded command intent of a project."),
  "command-intents-snapshot": allow("Recorded command intents of a project."),
  "coordinator-skills": allow("Skills a project's coordinator has."),
  "prompts-snapshot": allow("A project's role prompts."),
  "ref-candidates": allow("Candidates for an inline reference in a project message."),
  "ref-preview": allow("Preview of an inline reference."),
  "mcp-catalog": allow("Configured MCP servers."),
  "mcp-probe": allow("Probe an MCP server."),
  "command-profiles-snapshot": allow("Command profiles of a project."),
  "command-profile-read": allow("Read one command profile."),
  "command-profile-set": allow("Change a command profile."),
  web: exclude("The answer carries the browser bearer token, which must not enter a transcript."),
  answer: allow("Answer a project's open question (inbox entry)."),
  list: allow("All projects with activity and open questions."),
  create: allow("Create a project for an absolute workspace path."),
  "models-snapshot": allow("Model catalog and a project's model settings."),
  "model-picker-snapshot": allow("Models offered by the model picker."),
  "usage-snapshot": allow("Token and cost usage of a project."),
  "event-log": allow("Recent host events."),
  "host-health": allow("Host process health."),
  "library-import": allow("Import files into a project's library."),
  "library-list": allow("A project's library files."),
  "library-read": allow("Read a library file."),
  "settings-snapshot": allow("A project's settings with their revision."),
  "settings-update": allow("Change a project's settings (expectedRevision from settings-snapshot)."),
  compact: allow("Compact a chat's context."),
  "chat-reload": allow("Rebuild a chat's prompt and tools."),
  "chat-reset": allow("Start a new context in a chat; history stays."),
  "artifacts-list": allow("Artifacts saved by a project's agents."),
  "worktrees-snapshot": allow("A project's worktrees."),
  "worktrees-cleanup": dangerous("Delete a project's settled worktrees."),
  show: allow("A project with its chats, jobs and status."),
  search: allow("Search a project's chats and knowledge."),
  "chat-create": allow("Create a chat in a project."),
  "chat-update": allow("Rename, archive or restore a chat."),
  pause: allow("Pause a project's new work."),
  "jobs-snapshot": allow("A project's Jobs and agents."),
  "job-approve": dangerous("Approve a Ready Job: merges its PR."),
  resume: allow("Resume a paused project."),
  archive: dangerous("Archive a project."),
  restore: allow("Restore an archived project."),
  delete: dangerous("Delete a project."),
  "owner-setup-snapshot": allow("A project's workspace and GitHub setup."),
  "github-repository-inspect": allow("Inspect a GitHub repository."),
  "github-authorize": allow("Authorize GitHub access for a project."),
  "github-revoke": dangerous("Revoke a project's GitHub access."),
  "provider-pr-inspect": allow("Inspect a pull request."),
  "provider-conflict-inspect": allow("Inspect a pull request's merge conflicts."),
  "provider-ci-job-inspect": allow("Inspect one CI job."),
  "provider-ci-detail": allow("CI details of a pull request."),
  "provider-review-inspect": allow("Reviews of a pull request."),
  "provider-ci-inspect": allow("CI status of a pull request."),
  "github-read-snapshot": allow("Recorded GitHub reads of a project."),
  "github-write-inspect": allow("Inspect one recorded GitHub write."),
  "github-write-snapshot": allow("Recorded GitHub writes of a project."),
  "workspace-catalog": allow("Repositories a project may use."),
  "github-quick-authorize": allow("Authorize GitHub for a project in one step."),
  "workspace-quick-grant": allow("Grant a project its whole repository in one step."),
  "workspace-grant": allow("Grant a project workspace scopes."),
  "workspace-revoke": dangerous("Revoke a project's workspace grant."),
  "thread-dismiss": allow("Dismiss a settled agent."),
  "thread-steer": allow("Send instructions to a running agent."),
  "thread-stop": allow("Stop a running agent."),
  "thread-history": allow("An agent's transcript page."),
  "chat-history": allow("A chat's transcript page."),
  "transcript-text": allow("Full text of one transcript item."),
  "transcript-image": exclude("Returns image bytes; read the transcript text instead."),
  "archive-config": allow("Configure the previous-deployment archive."),
  "archive-projects": allow("Projects in the archive."),
  "archive-project": allow("One archived project."),
  "archive-history": allow("An archived transcript page."),
  "archive-text": allow("Full text of an archived transcript item."),
  "archive-image": exclude("Returns image bytes; read the archived text instead."),
  "thread-send": allow("Send a message to an agent."),
  "worker-contexts": allow("Context usage of agents."),
  "limits-snapshot": allow("Provider subscription limits."),
  "limits-refresh": allow("Refresh provider limits."),
  "limits-visibility": allow("Show or hide a provider in limits."),
  "machine-status": allow("CPU, memory, disk and battery of the machine."),
  "cursor-connect": exclude("Starts an interactive provider login in the owner's browser."),
  message: allow("Send a message to a project chat as the owner."),
  "upload-list": allow("A project's uploads."),
  "upload-read": allow("Read an upload."),
  "upload-delete": dangerous("Delete an upload."),
  "schedule-create": allow("Schedule a message for a project."),
  "schedule-enable": allow("Enable or disable a schedule."),
  "schedule-snapshot": allow("A project's schedules."),
  "schedule-history": allow("Runs of a project's schedules."),
  "event-opt-in": allow("Opt a project in or out of local events."),
  "event-ingest": allow("Deliver a local event to a project."),
  "automation-snapshot": allow("A project's automations."),
  "automation-update": allow("Change a project's automations."),
  "webhook-rotate": dangerous("Rotate a project's webhook secret; existing senders stop working."),
  "follow-poll": allow("Poll followed pull requests now."),
  prs: allow("A project's pull requests."),
  "pr-watch": allow("Watch or unwatch a pull request."),
  "pr-hide": allow("Hide or show a pull request."),
  plugins: allow("Loaded plugins."),
  plugin: allow("Call a plugin method."),
  "work-submit": exclude("Worker-scoped admission path; the Host agent sends with message."),
  notes: allow("A project's notes."),
  "knowledge-list": allow("A project's knowledge files."),
  "knowledge-read": allow("Read a knowledge file."),
  "knowledge-write": allow("Write a knowledge file."),
  "knowledge-history": allow("Revisions of a knowledge file."),
  shutdown: exclude("Stops the host the Host agent runs in; the owner stops it."),
  "deploy-shutdown": exclude("Internal step of a deploy."),
  "deploy-snapshot": allow("Deploy settings and state."),
  "deploy-settings": allow("Change deploy settings."),
  "deploy-start": dangerous("Deploy a new host version."),
  "notify-feed": allow("Recent notices."),
  "telegram-snapshot": allow("Telegram connection status."),
  "telegram-token": exclude("Takes the bot token, a secret that must not enter a transcript."),
  "telegram-pair": exclude("Pairing issues a code that makes a Telegram account the owner; the owner pairs in person."),
  "telegram-unpair": dangerous("Unpair the owner's Telegram."),
  "telegram-remove": dangerous("Remove the Telegram bot."),
  "host-agent-history": exclude("The Host agent's own transcript is already its context."),
  "host-agent-send": exclude("The Host agent would message itself."),
  "host-agent-stop": exclude("The Host agent would stop its own turn."),
  "host-agent-reset": exclude("The Host agent would reset its own context mid-turn."),
  "host-agent-settings": allow("The Host agent's model, thinking and disabled tools."),
  "approvals-list": allow("Owner approvals and their states."),
  "approval-decide": exclude("Only the owner decides approvals."),
};

const members = new Map<string, TSchema>(
  Request.anyOf.map((member) => [String((member as { properties: { action: { const: string } } }).properties.action.const), member]),
);
export const hasAction = (action: string): boolean => members.has(action);
export const isDangerous = (action: string): boolean => ACTION_POLICY[action as Action]?.kind === "dangerous";

/** The exact request `{ action, ...input }` if the agent may call it; throws a short refusal otherwise. */
export function validateCall(action: string, input: unknown): RequestData {
  const policy = members.has(action) ? ACTION_POLICY[action as Action] : undefined;
  if (!policy) throw new Error(`Unknown host action "${action}"; list them with host_actions`);
  if (policy.kind === "exclude") throw new Error(`"${action}" is not available to agents: ${policy.reason}`);
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input)))
    throw new Error("input must be an object of the action's fields");
  const request = { ...(input as object), action };
  const schema = members.get(action)!;
  if (!Value.Check(schema, request))
    throw new Error(
      `Invalid input for ${action}: ${[...Value.Errors(schema, request)]
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ")
        .slice(0, 1500)}`,
    );
  return request as RequestData;
}

/** Allowed and dangerous actions with their input schema (the action field left out), for `host_actions` and settings. */
export function agentActions(): { name: string; description: string; dangerous: boolean; input: unknown }[] {
  return [...members].flatMap(([name, schema]) => {
    const policy = ACTION_POLICY[name as Action];
    if (policy.kind === "exclude") return [];
    const { action: _, ...properties } = (schema as { properties: Record<string, unknown> }).properties;
    return [{ name, description: policy.description, dangerous: policy.kind === "dangerous", input: properties }];
  });
}

export const RESULT_CHARS = 12_000;
const text = (value: unknown) => ({
  output: [{ type: "text" as const, text: typeof value === "string" ? value : fitJson(RESULT_CHARS, () => value) }],
});

/** What the tools need from the host; approvals are keyed by the tool task so a replayed call finds the same one. */
export type HostToolDeps = {
  dispatch(request: RequestData): Promise<unknown>;
  requestApproval(input: { key: string; request: RequestData; summary: string }): Promise<{ id: string; state: string }>;
  focus(target: FocusTarget): void;
};

export const pendingText = (approval: { id: string; state: string }) =>
  approval.state === "pending"
    ? `Approval ${approval.id} is pending: the owner decides in the browser or Telegram. The host runs the request only if they approve, and the outcome arrives as a follow-up message. Do not retry.`
    : `Approval ${approval.id} is already ${approval.state}; its outcome was posted as a follow-up message.`;

const Summary = Type.String({ minLength: 1, maxLength: 300, description: "One line for the owner: what runs and why." });

/** The Host agent's tools: host actions through the same dispatch as the owner's browser, plus browser focus and UI settings. */
export function hostAgentTools(deps: HostToolDeps): ToolRegistration[] {
  const actions = defineTool({
    name: "host_actions",
    description:
      "List the host actions you can call with host_call: name, one-line description, input fields (JSON Schema) and whether it needs the owner's approval. Pass a filter substring to narrow the list.",
    parameters: Type.Object({ filter: Type.Optional(Type.String({ maxLength: 60 })) }),
    replay: "safe",
    async execute(args) {
      const filter = args.filter?.toLowerCase();
      const list = agentActions().filter((item) => !filter || `${item.name} ${item.description}`.toLowerCase().includes(filter));
      return text({
        actions: filter ? list : list.map(({ input: _, ...item }) => item),
        note: filter ? undefined : "Pass filter to see input fields.",
      });
    },
  });
  const call = defineTool({
    name: "host_call",
    description:
      "Run one host action exactly as the owner's browser does: { action, input } where input holds the action's fields without `action`. Actions marked dangerous do not run: they become an owner approval and the tool answers with its id at once. Give dangerous calls a one-line summary for the owner.",
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 60 }),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      summary: Type.Optional(Summary),
    }),
    replay: "unsafe",
    async execute(args, api) {
      const request = validateCall(args.action, args.input ?? {});
      if (isDangerous(request.action)) {
        const approval = await deps.requestApproval({
          key: `host-agent:${api.conversationId}:${api.taskId}`,
          request,
          summary: args.summary ?? `${request.action} ${JSON.stringify(args.input ?? {}).slice(0, 200)}`,
        });
        return text(pendingText(approval));
      }
      try {
        return text({ ok: true, result: (await deps.dispatch(request)) ?? null });
      } catch (error) {
        return text({ ok: false, error: errorText(error) });
      }
    },
  });
  const focus = defineTool({
    name: "ui_focus",
    description:
      "Point the owner's open browser at a view: { view: 'project' | 'chat' | 'settings' | 'approvals' | ..., projectId?, chatId?, section? }. Use it when you change something they will want to see.",
    parameters: Type.Object({
      view: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
      projectId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
      chatId: Type.Optional(Type.String({ pattern: "^(main|[a-f0-9-]{36})$" })),
      section: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" })),
    }),
    replay: "safe",
    async execute(args) {
      deps.focus(args);
      return text("Focus sent to open browsers.");
    },
  });
  const uiSet = defineTool({
    name: "ui_set",
    description: "Change the owner's UI settings (theme, animations, hotkeys, panels, status line) with a partial patch.",
    parameters: Type.Object({ patch: Type.Record(Type.String(), Type.Unknown()) }),
    replay: "unsafe",
    async execute(args) {
      if (!hasAction("ui-set") || !hasAction("ui-get")) return text("ui_set is not available on this host yet.");
      try {
        const current = (await deps.dispatch(validateCall("ui-get", {}))) as { revision: unknown };
        return text({ ok: true, result: await deps.dispatch(validateCall("ui-set", { revision: current.revision, patch: args.patch })) });
      } catch (error) {
        return text({ ok: false, error: errorText(error) });
      }
    },
  });
  return [actions, call, focus, uiSet] as ToolRegistration[];
}

/** A Coordinator's way to a dangerous host action: it only files the approval; the host runs it after the owner approves. The key is unique within one project's storage. */
export function ownerApprovalTool(input: {
  requestApproval(input: {
    key: string;
    conversationId: number;
    request: RequestData;
    summary: string;
  }): Promise<{ id: string; state: string }>;
}): ToolRegistration {
  return defineTool({
    name: "owner_approval_request",
    description: `Ask the owner to approve one dangerous host action, which the host then runs exactly as given: ${DANGEROUS_MINIMUM.filter(hasAction).join(", ")} and other actions the host marks dangerous. input holds the action's fields without \`action\` (the same as the browser sends). Answers at once with the approval id; the outcome arrives later as a follow-up message in this chat. Use it only for these actions; do everything else yourself.`,
    parameters: Type.Object({
      action: Type.String({ minLength: 1, maxLength: 60 }),
      input: Type.Record(Type.String(), Type.Unknown()),
      summary: Summary,
    }),
    replay: "safe",
    async execute(args, api) {
      const request = validateCall(args.action, args.input);
      if (!isDangerous(request.action))
        throw new Error(
          `"${request.action}" needs no approval; it is not a dangerous host action, so do it with your own tools or ask the owner.`,
        );
      const approval = await input.requestApproval({
        key: `${api.conversationId}:${api.taskId}`,
        conversationId: Number(api.conversationId),
        request,
        summary: args.summary,
      });
      return text(pendingText(approval));
    },
  }) as ToolRegistration;
}
