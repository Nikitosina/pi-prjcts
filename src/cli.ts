import { request, inboxUrl, openInbox } from "./client.ts";
import { Role, parse, errorText, Request } from "./state.ts";

const args = process.argv.slice(2);
const startHost = args[0] !== "--no-start";
if (!startHost) args.shift();
const [command, first, second, ...rest] = args;
if (command?.startsWith("copy-")) {
  try {
    if (startHost) throw new Error("Copy-only maintenance requires --no-start and never starts a host");
    const { initializeDisposableRoot, inspectDisposableCopy, archiveDisposableCopy, switchCopy, rollbackCopy } = await import("./copy-only-maintenance.ts");
    let result: unknown;
    if (command === "copy-root-init" && first && !second && rest.length === 0) result = initializeDisposableRoot(first);
    else if (["copy-inspect", "copy-archive", "copy-switch", "copy-rollback"].includes(command) && first && second && rest.length >= (command === "copy-inspect" ? 2 : 3)) {
      const [cwd, archive, ...tail] = rest;
      if (command === "copy-inspect" && (archive !== "--confirm" || tail.length !== 1 || tail[0] !== second)) throw new Error("Usage: --no-start copy-inspect <owned-root> <project-uuid> <cwd> --confirm <same-project-uuid>");
      if (command !== "copy-inspect" && (tail.length !== 2 || tail[0] !== "--confirm" || tail[1] !== second)) throw new Error("Explicit --confirm <same-project-uuid> is required");
      result = command === "copy-inspect" ? inspectDisposableCopy(first, second, cwd) : command === "copy-archive" ? archiveDisposableCopy(first, second, cwd, archive) : command === "copy-switch" ? switchCopy(first, second, cwd, archive) : rollbackCopy(first, second, cwd, archive);
    } else throw new Error("Usage: --no-start copy-root-init <new-root> | copy-inspect <root> <uuid> <cwd> --confirm <uuid> | copy-archive|copy-switch|copy-rollback <root> <uuid> <cwd> <archive-dir> --confirm <uuid>");
    process.stdout.write(JSON.stringify(result, null, 2) + "\\n");
  } catch (error) { process.stderr.write(errorText(error) + "\\n"); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
if (command === "ui" || command === "ui-url") {
  try {
    if (!startHost) throw new Error("--no-start is only supported for API commands");
    const url = command === "ui" ? await openInbox(first) : await inboxUrl(first);
    process.stdout.write((command === "ui" ? `Opened ${new URL(url).origin}` : url) + "\n");
  } catch (error) { process.stderr.write(errorText(error) + "\n"); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
function integerArgument(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be an explicit nonnegative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be a safe integer`);
  return number;
}
function confirmedArguments(parts: string[], id: string): string[] {
  if (parts.length < 2 || parts.at(-2) !== "--confirm" || parts.at(-1) !== id) throw new Error("Explicit --confirm <same-project-id> is required");
  return parts.slice(0, -2);
}
let input: Request;
switch (command) {
  case "list": input = { action: "list" }; break;
  case "create":
    if (!first || !second) throw new Error("Usage: create <name> <workspace> [objective]");
    input = { action: "create", name: first, cwd: second, objective: rest.join(" ") }; break;
  case "create-once": {
    const [cwd, ...objective] = rest;
    if (!first || !second || !cwd) throw new Error("Usage: create-once <request-uuid> <name> <workspace> [objective]");
    input = parse(Request, { action: "create", requestId: first, name: second, cwd, objective: objective.join(" ") });
    break;
  }
  case "show": case "notes": case "pause": case "archive": case "restore":
    if (!first || second) throw new Error(`Usage: ${command} <project-id>`);
    input = parse(Request, { action: command, id: first }); break;
  case "resume":
    if (!first) throw new Error("Usage: resume <project-id> [--leave-interrupted --confirm <same-project-id>]");
    if (second === undefined) input = { action: "resume", id: first };
    else {
      if (second !== "--leave-interrupted" || rest.length !== 2 || rest[0] !== "--confirm" || rest[1] !== first) throw new Error("Usage: resume <project-id> --leave-interrupted --confirm <same-project-id>");
      input = { action: "resume", id: first, recovery: "leave-interrupted", confirm: rest[1] };
    }
    break;
  case "plan":
    if (!first || second) throw new Error("Usage: plan <project-id>");
    input = { action: "plan-snapshot", id: first }; break;
  case "delete":
    if (!first || second !== "--confirm" || rest.length !== 1 || rest[0] !== first) throw new Error("Usage: delete <project-id> --confirm <same-project-id>");
    input = { action: "delete", id: first, confirm: rest[0] }; break;
  case "send":
    if (!first || !second) throw new Error("Usage: send <project-id> <message>");
    input = { action: "message", id: first, text: [second, ...rest].join(" ") }; break;
  case "delegate":
    if (!first || !second || !rest.length) throw new Error("Usage: delegate <project-id> <worker|scout|reviewer> <task>");
    input = { action: "delegate", id: first, role: parse(Role, second), task: rest.join(" ") }; break;
  case "submit-scoped": {
    const [threadId, requestId, ...text] = rest;
    if (!first || !second || !threadId || !requestId || !text.length) throw new Error("Usage: submit-scoped <project-id> <scope-id> <thread-id> <request-id> <task>");
    input = parse(Request, { action: "work-submit", id: first, workspaceScopeId: second, threadId, requestId, text: text.join(" ") });
    break;
  }
  case "thread-send": case "thread-steer": {
    const [requestId, ...text] = rest;
    if (!first || !second || !requestId || !text.length) throw new Error(`Usage: ${command} <project-id> <thread-id> <request-id> <text>`);
    input = parse(Request, { action: command, id: first, threadId: second, requestId, text: text.join(" ") });
    break;
  }
  case "thread-stop":
    if (!first || !second || rest.length !== 2 || rest[0] !== "--confirm" || rest[1] !== second) throw new Error("Usage: thread-stop <project-id> <thread-id> --confirm <same-thread-id>");
    input = parse(Request, { action: "thread-stop", id: first, threadId: second }); break;
  case "thread-history": case "legacy-thread-history": {
    const [offset = "0", textOffset = "0"] = rest;
    if (!first || !second || rest.length > 2 || !/^\d+$/.test(offset) || !/^\d+$/.test(textOffset)) throw new Error(`Usage: ${command} <project-id> <${command === "thread-history" ? "thread-id" : "retained-name"}> [message-offset] [Unicode-text-offset]`);
    input = parse(Request, { action: command, id: first, ...(command === "thread-history" ? { threadId: second } : { name: second }), offset: Number(offset), textOffset: Number(textOffset), limit: 30, textLimit: 4000 });
    break;
  }
  case "schedules":
    if (!first || rest.length || second !== undefined && second !== "--without-history") throw new Error("Usage: schedules <project-id> [--without-history]");
    input = parse(Request, { action: "schedule-snapshot", id: first, ...(second ? { includeHistory: false } : {}) }); break;
  case "monitors":
    if (!first || second || rest.length) throw new Error("Usage: monitors <project-id>");
    input = parse(Request, { action: "monitor-snapshot", id: first }); break;
  case "schedule-history": {
    const [offset = "0", textOffset = "0"] = rest;
    if (!first || (second !== "events" && second !== "intents") || rest.length > 2) throw new Error("Usage: schedule-history <project-id> <events|intents> [record-offset] [Unicode-text-offset]");
    input = parse(Request, { action: "schedule-history", id: first, kind: second, offset: integerArgument(offset, "Record offset"), textOffset: integerArgument(textOffset, "Unicode text offset"), limit: 30, textLimit: 4000 }); break;
  }
  case "schedule-once": case "schedule-interval": case "schedule-daily": case "schedule-weekly": {
    if (!first || !second) throw new Error(`Usage: ${command} <project-id> <stable-schedule-id> <start-epoch-ms> ${command === "schedule-interval" ? "<interval-ms> " : command === "schedule-daily" ? "<IANA-zone> <HH:mm> " : command === "schedule-weekly" ? "<IANA-zone> <HH:mm> <days-0-to-6-comma-separated> " : ""}<text> --confirm <same-project-id>`);
    const [start, ...definition] = confirmedArguments(rest, first), atMs = integerArgument(start, "Start epoch milliseconds");
    if (command === "schedule-once") input = parse(Request, { action: "schedule-create", id: first, scheduleId: second, atMs, text: definition.join(" ") });
    else if (command === "schedule-interval") {
      const [interval, ...text] = definition;
      input = parse(Request, { action: "schedule-create", id: first, scheduleId: second, atMs, everyMs: integerArgument(interval, "Interval milliseconds"), text: text.join(" ") });
    } else {
      const [timezone, time, ...tail] = definition;
      if (command === "schedule-daily") input = parse(Request, { action: "schedule-create", id: first, scheduleId: second, atMs, calendar: { kind: "daily", timezone, time }, text: tail.join(" ") });
      else {
        const [days, ...text] = tail;
        input = parse(Request, { action: "schedule-create", id: first, scheduleId: second, atMs, calendar: { kind: "weekly", timezone, time, days: (days ?? "").split(",").map(day => integerArgument(day, "Weekday")) }, text: text.join(" ") });
      }
    }
    break;
  }
  case "schedule-enable": case "monitor-enable": {
    if (!first || !second) throw new Error(`Usage: ${command} <project-id> <routine-id> <true|false> --confirm <same-project-id>`);
    const values = confirmedArguments(rest, first);
    if (values.length !== 1 || (values[0] !== "true" && values[0] !== "false")) throw new Error("Enabled must be exactly true or false");
    input = parse(Request, { action: command, id: first, ...(command === "schedule-enable" ? { scheduleId: second } : { monitorId: second }), enabled: values[0] === "true" }); break;
  }
  case "event-opt-in": {
    if (!first || (second !== "true" && second !== "false") || confirmedArguments(rest, first).length) throw new Error("Usage: event-opt-in <project-id> <true|false> --confirm <same-project-id>");
    input = parse(Request, { action: "event-opt-in", id: first, enabled: second === "true" }); break;
  }
  case "monitor-create": {
    if (!first || !second) throw new Error("Usage: monitor-create <project-id> <stable-monitor-uuid> <repository-id> <numeric-repository-id> <pr-number> <pr|ci|review> <interval-ms> --confirm <same-project-id>");
    const values = confirmedArguments(rest, first);
    if (values.length !== 5) throw new Error("Monitor requires repository identity, PR number, kind and interval");
    const [repositoryId, expectedRepositoryId, pullRequest, kind, everyMs] = values;
    input = parse(Request, { action: "monitor-create", id: first, monitorId: second, repositoryId, expectedRepositoryId: integerArgument(expectedRepositoryId, "Repository numeric ID"), pullRequest: integerArgument(pullRequest, "PR number"), kind, everyMs: integerArgument(everyMs, "Monitor interval milliseconds") }); break;
  }
  case "owner-workspaces": case "owner-skills-catalog": case "owner-skills-grants": case "owner-command-profiles": case "owner-setup": {
    if (!first || second !== undefined || rest.length) throw new Error(`Usage: ${command} <project-id>`);
    const action = command === "owner-workspaces" ? "workspace-catalog" : command === "owner-skills-catalog" ? "worker-skills-catalog" : command === "owner-skills-grants" ? "worker-skills-grants" : command === "owner-command-profiles" ? "command-profiles-snapshot" : "owner-setup-snapshot";
    input = parse(Request, { action, id: first }); break;
  }
  case "owner-workspace-revoke": {
    const [expectedRevision, confirm] = rest;
    if (!first || !second || rest.length !== 3 || confirm !== "--confirm" || rest[2] !== first) throw new Error("Usage: owner-workspace-revoke <project-id> <scope-id> <workspace-revision> --confirm <same-project-id>");
    input = parse(Request, { action: "workspace-revoke", id: first, scopeId: second, expectedRevision, confirm: rest[2] }); break;
  }
  case "owner-github-revoke": {
    if (!first || !second || rest.length !== 3 || rest[1] !== "--confirm" || rest[2] !== first) throw new Error("Usage: owner-github-revoke <project-id> <repository-id> <github-revision> --confirm <same-project-id>");
    input = parse(Request, { action: "github-revoke", id: first, repositoryId: second, expectedRevision: rest[0], confirm: rest[2] }); break;
  }
  case "owner-github-inspect": {
    if (!first || !second || rest.length) throw new Error("Usage: owner-github-inspect <project-id> <repository-id>");
    input = parse(Request, { action: "github-repository-inspect", id: first, repositoryId: second }); break;
  }
  case "owner-github-authorize": {
    if (!first || !second || rest.length !== 5 || rest[3] !== "--confirm" || rest[4] !== first) throw new Error("Usage: owner-github-authorize <project-id> <repository-id> <numeric-repository-id> <branch-prefix> <github-revision> --confirm <same-project-id>");
    input = parse(Request, { action: "github-authorize", id: first, repositoryId: second, expectedRepositoryId: integerArgument(rest[0], "Numeric GitHub repository ID"), branchPrefix: rest[1], expectedRevision: rest[2], confirm: rest[4] }); break;
  }
  case "owner-workspace-grant": {
    if (!first || !second || rest.length !== 8 || rest[6] !== "--confirm" || rest[7] !== first) throw new Error("Usage: owner-workspace-grant <project-id> <repository-id> <owner-checkout> <approved-root> <ownership-prefix> <files-json> <base-revision> <workspace-revision> --confirm <same-project-id>");
    let files: unknown;
    try { files = JSON.parse(rest[3]); } catch { throw new Error("Workspace files must be a JSON array"); }
    input = parse(Request, { action: "workspace-grant", id: first, repositoryId: second, provider: "github", ownerCheckout: rest[0], approvedRoot: rest[1], fileOwnershipPrefix: rest[2], files, baseRevision: rest[4], expectedRevision: rest[5], confirm: rest[7] }); break;
  }
  case "owner-profile-read": {
    if (!first || !second || rest.length) throw new Error("Usage: owner-profile-read <project-id> <profile-id>");
    input = parse(Request, { action: "command-profile-read", id: first, profileId: second }); break;
  }
  case "owner-profile-set": {
    if (!first || !second || rest.length !== 3 || rest[1] !== "--confirm" || rest[2] !== first) throw new Error("Usage: owner-profile-set <project-id> <profile-revision> <profile-json> --confirm <same-project-id>");
    let profile: unknown;
    try { profile = JSON.parse(rest[0]); } catch { throw new Error("Profile JSON must be valid JSON"); }
    input = parse(Request, { action: "command-profile-set", id: first, expectedRevision: second, profile, confirm: rest[2] }); break;
  }
  case "owner-skill-grant": {
    if (!first || !second || rest.length !== 4 || rest[2] !== "--confirm" || rest[3] !== first) throw new Error("Usage: owner-skill-grant <project-id> <catalog-revision> <grants-revision> <selection-json> --confirm <same-project-id>");
    let selection: unknown;
    try { selection = JSON.parse(rest[1]); } catch { throw new Error("Skill selection must be valid JSON"); }
    input = parse(Request, { action: "worker-skills-grant-set", id: first, expectedCatalogRevision: second, expectedGrantsRevision: rest[0], selection, confirm: rest[3] }); break;
  }
  case "owner-skill-revoke": {
    if (!first || !second || rest.length !== 3 || rest[1] !== "--confirm" || rest[2] !== first) throw new Error("Usage: owner-skill-revoke <project-id> <grant-id> <grants-revision> --confirm <same-project-id>");
    input = parse(Request, { action: "worker-skills-grant-revoke", id: first, grantId: second, expectedGrantsRevision: rest[0], confirm: rest[2] }); break;
  }
  case "workers":
    if (!first) throw new Error("Usage: workers <project-id> [run-id]");
    input = { action: "workers", id: first, ...(second ? { run: second } : {}) }; break;
  case "steer": case "stop":
    if (!first || !second) throw new Error(`Usage: ${command} <project-id> <run-id>${command === "steer" ? " <message>" : ""}`);
    input = { action: "control", id: first, run: second, operation: command, ...(command === "steer" ? { message: rest.join(" ") } : {}) }; break;
  case "host-stop": input = { action: "shutdown" }; break;
  default:
    process.stderr.write("Usage: projects [--no-start] <ui|ui-url|list|create|create-once|show|send|delegate|submit-scoped|workers|steer|stop|thread-send|thread-steer|thread-stop|thread-history|legacy-thread-history|schedules|schedule-history|schedule-once|schedule-interval|schedule-daily|schedule-weekly|schedule-enable|event-opt-in|monitors|monitor-create|monitor-enable|owner-setup|owner-workspaces|owner-skills-catalog|owner-skills-grants|owner-command-profiles|owner-workspace-grant|owner-workspace-revoke|owner-github-inspect|owner-github-authorize|owner-github-revoke|owner-profile-read|owner-profile-set|owner-skill-grant|owner-skill-revoke|notes|plan|pause|resume|archive|restore|delete|host-stop> ...\n");
    process.exit(1);
}
try {
  const data = await request(input, startHost && command !== "host-stop");
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
} catch (error) {
  process.stderr.write(errorText(error) + "\n");
  if (input.action === "create" && input.requestId) process.stderr.write(`Creation request UUID ${input.requestId} has an unconfirmed response; its backend record may or may not exist. Inspect that UUID or repeat the exact same bound request; do not generate a replacement UUID.\n`);
  if (input.action === "work-submit" || input.action === "thread-send" || input.action === "thread-steer") process.stderr.write(`Thread ${input.threadId}, request ${input.requestId}: response is unconfirmed. Inspect owned history or retry exactly the same request/text; do not infer failure or generate a replacement identity.\n`);
  if (input.action === "schedule-create") process.stderr.write(`Schedule ${input.scheduleId}: response is unconfirmed. Inspect its retained definition/ticks before any exact-ID retry; do not invent a replacement ID or start time.\n`);
  if (input.action === "monitor-create") process.stderr.write(`Monitor ${input.monitorId}: response is unconfirmed. Inspect its retained binding/cursor before any exact-ID retry; do not invent a replacement UUID.\n`);
  process.exitCode = 1;
}
