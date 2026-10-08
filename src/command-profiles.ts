import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { parse, type Project, type Request } from "./state.ts";
import { CommandProfileInput, type CommandProfile, type CommandProgram } from "./command-profile-types.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";

type Update = Extract<Request, { action: "command-profile-set" }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const programLimit = 128 * 1024 * 1024;

function within(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

export async function commandProgram(executable: string): Promise<CommandProgram> {
  if (!isAbsolute(executable) || executable.includes("\0")) throw new Error("Command executable must be an explicit absolute path");
  const path = await realpath(executable);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let outcome: { kind: "inspected"; program: CommandProgram } | { kind: "failed"; error: unknown };
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(programLimit) || (before.mode & 0o111n) === 0n) throw new Error("Command executable must be a bounded regular executable file");
    const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < Number(before.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (result.bytesRead === 0) throw new Error("Command executable changed while being read");
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (!named.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size || named.mode !== after.mode || named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs || await realpath(executable) !== path) throw new Error("Command executable identity changed");
    outcome = { kind: "inspected", program: { path, dev: before.dev.toString(), ino: before.ino.toString(), size: before.size.toString(), sha256: digest.digest("hex") } };
  } catch (error) {
    outcome = { kind: "failed", error };
  }
  try { await handle.close(); }
  catch (error) {
    if (outcome.kind === "failed") throw new AggregateError([outcome.error, error], "Command executable inspection and close failed");
    throw error;
  }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.program;
}

export function validateCommandRisk(profile: Pick<CommandProfile, "program" | "arguments" | "effect">) {
  const name = basename(profile.program.path), args = profile.arguments;
  if (name === "gh" && args.includes("pr") && args.includes("merge")) throw new Error("Direct GH merge/auto-merge commands are unavailable; use the PR/head-bound executor");
  if (name === "gh" && args.includes("api")) {
    const decoded = args.map(value => { try { return decodeURIComponent(value); } catch { return value; } });
    if (decoded.some(value => /(?:^|\/)repos\/[^/?#]+\/[^/?#]+\/(?:pulls\/[^/?#]+\/merge|merges)(?:[/?#]|$)/i.test(value))) throw new Error("Direct GH REST merge endpoints are unavailable; use the PR/head-bound executor");
    if (decoded.some(value => /(?:^|\/)graphql(?:[/?#]|$)/i.test(value) || /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(value))) throw new Error("Direct GH GraphQL commands are unavailable; use scoped provider tools and the PR/head-bound executor");
  }
  if (name === "git" && args.includes("worktree") && args.some(value => value === "remove" || value === "prune")) throw new Error("Git worktree cleanup requires ownership-safe resource controls; command profiles cannot perform it");
  if (name === "git" && args.some(value => /^core\.hooksPath=/i.test(value))) throw new Error("Command profiles cannot override repository Git safety hooks");
  const destructive = ["rm", "rmdir", "shred", "diskutil", "mkfs", "newfs"].includes(name)
    || name === "git" && (args.some(value => ["reset", "clean", "gc", "prune", "rebase", "filter-branch", "filter-repo", "update-ref"].includes(value))
      || args.some(value => value === "-f" || value === "-D" || value === "--amend" || /^--(?:force|delete|mirror|prune)/.test(value))
      || args.includes("push") && args.some(value => value.startsWith(":"))
      || args.some(value => value === "branch" || value === "tag") && args.includes("-d"))
    || name === "gh" && (args.includes("delete") || args.includes("api") && args.some(value => value === "DELETE" || value === "-XDELETE" || value === "--method=DELETE"));
  if (destructive && profile.effect === "workspace") throw new Error("Recognized destructive command requires a separately approved non-workspace profile");
}

function riskBlocker(profile: CommandProfile) {
  try { validateCommandRisk(profile); return null; }
  catch (error) { return error instanceof Error ? error.message : "Command risk classification is unavailable"; }
}

export function commandProfilesSnapshot(project: Project) {
  const profiles = project.commandProfiles ?? [];
  return { revision: hash(JSON.stringify({ workspace: authorizationFingerprint(project), profiles })), profiles: profiles.map(profile => ({
    id: profile.id, label: profile.label, repositoryId: profile.repositoryId, provider: profile.provider,
    scopeIds: [...profile.scopeIds], effect: profile.effect, enabled: profile.enabled,
    timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes, revision: profile.revision,
    executable: profile.executable, arguments: [...profile.arguments], program: { ...profile.program }, executionAvailable: riskBlocker(profile) === null && profile.enabled && profile.provider === "github" && !project.archived && !project.deleted && profile.owner === trustedOwner() && profile.workspaceRevision === authorizationFingerprint(project),
    blocker: riskBlocker(profile) ?? (profile.provider === "arc" ? "Arc command execution is deferred; profiles cannot run" : profile.effect !== "workspace" ? "Separate exact owner approval with execution enabled is required" : !profile.enabled ? "Command profile is disabled" : profile.workspaceRevision !== authorizationFingerprint(project) ? "Command scope authorization changed; obtain a new grant" : null),
  })) };
}

export async function prepareCommandProfile(project: Project, input: Update): Promise<CommandProfile> {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("Command profile requires confirmation matching project id");
  if (project.archived || project.deleted) throw new Error("Command profiles require an active project");
  if (input.expectedRevision !== commandProfilesSnapshot(project).revision) throw new Error("Command profile revision conflict; reread before updating");
  const definition = parse(CommandProfileInput, input.profile);
  if (definition.arguments.some(value => value.includes("\0"))) throw new Error("Command arguments cannot contain NUL");
  const grant = project.workspaceAuthorization;
  const repository = grant?.repositories.find(item => item.repositoryId === definition.repositoryId);
  if (!grant || grant.owner !== trustedOwner() || !repository || repository.provider !== grant.provider || definition.scopeIds.some(id => !grant.scopes.some(scope => scope.id === id && scope.repositoryId === repository.repositoryId))) throw new Error("Command profile requires exact authorized repository scopes");
  if (grant.provider === "arc" && definition.enabled) throw new Error("Arc command execution is deferred; profiles cannot be enabled");
  const program = await commandProgram(definition.executable);
  validateCommandRisk({ program, arguments: definition.arguments, effect: definition.effect });
  const executableName = basename(program.path);
  if (grant.provider === "arc" && ["git", "gh"].includes(executableName) || grant.provider === "github" && ["arc", "arcanum"].includes(executableName)) throw new Error("Command executable does not match the selected VCS provider");
  const roots = await Promise.all([realpath(project.cwd), ...grant.repositories.flatMap(item => [realpath(item.ownerCheckout), realpath(item.approvedRoot)])]);
  if (roots.some(root => within(root, program.path))) throw new Error("Command executable cannot reside in a mutable repository or workspace root");
  const identity = { ...definition, scopeIds: [...definition.scopeIds].sort(), program, provider: grant.provider, owner: grant.owner, workspaceRevision: authorizationFingerprint(project) };
  return { ...identity, revision: hash(JSON.stringify(identity)), grantedAt: new Date().toISOString() };
}

export function applyCommandProfile(project: Project, input: Update, profile: CommandProfile): Project {
  if (input.id !== project.id || input.confirm !== project.id || project.archived || project.deleted) throw new Error("Command profile target is no longer authorized");
  if (input.expectedRevision !== commandProfilesSnapshot(project).revision || profile.workspaceRevision !== authorizationFingerprint(project) || profile.owner !== trustedOwner()) throw new Error("Command profile authorization changed; reread before updating");
  if (profile.provider === "arc" && profile.enabled) throw new Error("Arc command execution is deferred; profiles cannot be enabled");
  validateCommandRisk(profile);
  const profiles = project.commandProfiles ?? [], existing = profiles.find(item => item.id === profile.id);
  if (!existing && profiles.length >= 32) throw new Error("Command profile limit reached");
  return { ...project, commandProfiles: existing ? profiles.map(item => item.id === profile.id ? profile : item) : [...profiles, profile] };
}
