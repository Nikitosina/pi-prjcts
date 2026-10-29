import { initTheme } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_ROLES,
  home,
  loadDeploySettings,
  saveDeploySettings,
  socketPath,
  Request,
  Project,
  errorText,
  jobs,
  legacyProjectIds,
  listProjects,
  loadProject,
  notes,
  parse,
  projectDir,
  saveJob,
  saveProject,
  type Request as RequestData,
} from "./state.ts";
import { ensureKnowledge, historyKnowledge, listKnowledge, readKnowledge, writeKnowledge } from "./knowledge.ts";
import { searchProject } from "./knowledge-search.ts";
import { loadProjectResourceLoader } from "./project-resources.ts";
import { referencedPrBlock } from "./pr-monitor.ts";
import { plugins } from "./plugins.ts";
import { expandSkillCommand, listSkills, skillNames, skillPreview } from "./coordinator-skills.ts";
import { refCandidates, referencedItemsBlock, refPreview } from "./inline-refs.ts";
import { recordInvokedSkill } from "./skill-profiles.ts";
import { mcpCatalog, mcpPool } from "./mcp-servers.ts";
import { resolveEntry, inbox } from "./inbox.ts";
import { body } from "./http.ts";
import { startWeb } from "./web.ts";
import { feed } from "./change-feed.ts";
import { createRemote, type RemoteAccess } from "./remote.ts";
import { startWebhooks } from "./webhook.ts";
import { startNotifier } from "./notify.ts";
import { clearQueuedDeploy, deployPending, idleDeployTick, queueDeploy, readDeployState, recordHostSha, forgetHostSha } from "./deploy.ts";
import { describeAcceptance } from "./result-acceptance.ts";
import { startTelegram } from "./telegram.ts";
import type { JobsSnapshot } from "./jobs.ts";
import { loadAutomations, rotateWebhookSecret, updateAutomations } from "./project-automations.ts";
import { listArtifacts } from "./artifacts.ts";
import { openDurableHost, durableHostSnapshot, durableHostActivity, type ProjectActivity } from "./durable-host.ts";
import {
  archiveConfig,
  archiveHistory,
  archiveImage,
  archiveProject,
  archiveProjects,
  archiveText,
  closeArchives,
} from "./archive-host.ts";
import {
  authorizationFingerprint,
  catalog,
  grantWholeRepository,
  grantWorkspace,
  quickWorkspacePreview,
  workspaceAuthorizationRevision,
  workspaceRepositoryFingerprint,
} from "./workspace-authorization.ts";
import { createGithubInspection } from "./github-inspection.ts";
import {
  authorizeGithub,
  authorizeGithubQuick,
  githubQuickPreview,
  inspectGithubRepository,
  rebindOneClickGithub,
} from "./github-authorization.ts";
import { settingsApplication } from "./settings-application.ts";
import { libraryImport, libraryList, libraryRead } from "./project-library.ts";
import { attachmentContent, deleteUpload, listUploads, saveUpload, uploadRecord, uploadText } from "./uploads.ts";
import { createModelRuntime, loadProviderExtensions } from "./provider-extensions.ts";
import { projectModelCatalog, projectModelPicker } from "./project-models.ts";
import { commandProfilesSnapshot } from "./command-profiles.ts";
import { type DurableProjectRuntime } from "./durable-runtime.ts";
import { DEFAULT_ROLE_PROMPTS } from "./role-prompts.ts";
import { limitsSnapshot, setLimitsTokenResolver, startCursorLogin } from "./usage-limits.ts";
import { machineStatus } from "./machine-status.ts";

process.env.PI_PROJECTS_HOST = "1";
initTheme("light", false);
mkdirSync(home(), { recursive: true, mode: 0o700 });
const lock = join(home(), "host.lock");
if (existsSync(lock)) {
  const value = readFileSync(lock, "utf8").trim();
  if (!value) process.exit(0);
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid host lock. Inspect it before removing it.");
  try {
    process.kill(pid, 0);
    process.exit(0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    unlinkSync(lock);
  }
}
let lockFd: number;
try {
  lockFd = openSync(lock, "wx", 0o600);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") process.exit(0);
  throw error;
}
writeFileSync(lockFd, String(process.pid));
closeSync(lockFd);
if (existsSync(socketPath())) unlinkSync(socketPath());
/** The skills installed right now (global, project-local, packages): built from disk on every call, never cached, so a skill installed a moment ago is found without a restart. Passive: never downloads a missing package. */
const configuredSkills = (id: string) => loadProjectResourceLoader(loadProject(id), { passive: true });
const durableRuntimes = new Map<string, Promise<DurableProjectRuntime>>();
const projectLocks = new Map<string, Promise<void>>();
const settingsUpdating = new Set<string>();
const lifecycleChanging = new Set<string>();
const ownerCloseFailed = new Set<string>();
const githubInspection = createGithubInspection();
let closing = false;
let shutdownOperation: Promise<void> | undefined;
const activeRequests = new Set<Promise<unknown>>();
const hostStartedAt = Date.now();
const hostEvents: Array<{ at: number; kind: string; detail: string }> = [];
function recordHostEvent(kind: string, detail: string): void {
  hostEvents.push({ at: Date.now(), kind, detail });
  if (hostEvents.length > 500) hostEvents.shift();
}

async function withProjectLock<T>(id: string, operation: () => Promise<T>, duringTransition = false): Promise<T> {
  const previous = projectLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectLocks.set(id, current);
  await previous;
  try {
    if (closing) throw new Error("Host is stopping");
    if (ownerCloseFailed.has(id)) throw new Error("Project owner close failed; restart the owned host before retrying");
    if (!duringTransition && lifecycleChanging.has(id)) throw new Error("Project lifecycle transition is in progress");
    if (!duringTransition && settingsUpdating.has(id)) throw new Error("Project settings update is in progress");
    return await operation();
  } finally {
    release();
    if (projectLocks.get(id) === current) projectLocks.delete(id);
  }
}

async function withDurableOwner<T>({
  id,
  validate,
  operation,
}: {
  id: string;
  validate?: (project: Project) => void;
  operation: (owner: DurableProjectRuntime) => Promise<T>;
}): Promise<T> {
  ownedProjectDir(id);
  validate?.(loadProject(id));
  const opening = durable(id);
  const owner = await opening;
  return withProjectLock(id, async () => {
    ownedProjectDir(id);
    if (durableRuntimes.get(id) !== opening) throw new Error("Project owner changed before the locked operation; no operation applied");
    validate?.(loadProject(id));
    return operation(owner);
  });
}

/**
 * Default: a project with a repository checkout gets a whole-repository workspace scope, so its workers get shell and file
 * tools in their own isolated worktree. Publication (pushes, PRs, merges) keeps its separate approvals. Not applied to a project
 * that already has a grant, or whose owner ever revoked one: that is their decision.
 */
function withDefaultWorkspace(project: Project): Project {
  if (project.archived || project.deleted || project.workspaceAuthorization || project.workspaceAuthorizationHistory?.length)
    return project;
  // Plain Git checkouts only: a workspace provider plugin keeps its own owner-confirmed setup.
  try {
    const preview = quickWorkspacePreview(project, workerWorktreeRoot(project.id));
    return preview.available && preview.provider === "github"
      ? rebindAuthorizations(grantWholeRepository(project, workerWorktreeRoot(project.id)).project)
      : project;
  } catch {
    return project;
  }
}

function durable(id: string, duringLifecycle = false): Promise<DurableProjectRuntime> {
  if (closing) throw new Error("Host is stopping");
  if (ownerCloseFailed.has(id)) throw new Error("Project owner close failed; restart the owned host before retrying");
  if (lifecycleChanging.has(id) && !duringLifecycle) throw new Error("Project lifecycle transition is in progress");
  if (settingsUpdating.has(id)) throw new Error("Project settings update is in progress");
  const present = durableRuntimes.get(id);
  if (present) return present;
  // Existing projects get the default scope when their runtime first opens.
  let project = loadProject(id);
  const granted = withDefaultWorkspace(project);
  if (granted !== project) {
    saveProject(granted);
    project = granted;
  }
  // Opening may install a configured package once, as before; later catalog lookups are passive.
  const opening = loadProjectResourceLoader(project).then((loader) => openDurableHost(project, loader, () => configuredSkills(id)));
  durableRuntimes.set(id, opening);
  opening.catch(() => {
    if (durableRuntimes.get(id) === opening) durableRuntimes.delete(id);
  });
  return opening;
}

async function lifecycle<T>(
  id: string,
  validate: (project: ReturnType<typeof loadProject>) => void,
  operation: (owner: DurableProjectRuntime) => Promise<T>,
): Promise<T> {
  let resumePlugins = () => {};
  await withProjectLock(id, async () => {
    validate(loadProject(id));
    resumePlugins = plugins.pauseLifecycle(id);
    lifecycleChanging.add(id);
  });
  try {
    return await operation(await durable(id, true));
  } finally {
    lifecycleChanging.delete(id);
    resumePlugins();
  }
}

/** One-click authorizations (GitHub and provider plugins) follow workspace grant changes. */
const rebindAuthorizations = (project: ReturnType<typeof loadProject>) =>
  plugins
    .workspaceProviders()
    .reduce((current, provider) => (provider.rebind ? provider.rebind(current) : current), rebindOneClickGithub(project));
/** Worker worktrees for one-click grants live with the project data, outside the owner checkout. */
function workerWorktreeRoot(id: string): string {
  return join(projectDir(id), "worktrees");
}

async function persistWorkspaceGrant<T>(
  before: ReturnType<typeof loadProject>,
  expectedRevision: string,
  result: { project: ReturnType<typeof loadProject>; scope: T },
): Promise<T> {
  const persist = async () =>
    withProjectLock(
      before.id,
      async () => {
        const project = loadProject(before.id);
        if (workspaceAuthorizationRevision(project) !== expectedRevision || project.archived || project.deleted)
          throw new Error("Workspace authorization changed or project became inactive");
        saveProject(rebindAuthorizations({ ...project, workspaceAuthorization: result.project.workspaceAuthorization }));
        return result.scope;
      },
      true,
    );
  return lifecycle(
    before.id,
    (project) => {
      if (workspaceAuthorizationRevision(project) !== expectedRevision)
        throw new Error("Workspace authorization changed; refresh before granting");
    },
    async (owner) => {
      const current = await owner.snapshot(),
        plan = await owner.jobs();
      if (
        current.coordinator.busy ||
        current.coordinator.submissions.some((item) => item.status === "queued" || item.status === "placed") ||
        workBusy(plan)
      )
        throw new Error("Workspace grants require an idle Durable project");
      await closeLifecycleOwner(before.id, owner);
      return persist();
    },
  );
}

/** Work is in flight: a worker, scout or reviewer has not finished. */
const workBusy = (view: JobsSnapshot) => view.agents.some((agent) => agent.endedAt === null);

async function closeLifecycleOwner(id: string, owner: DurableProjectRuntime): Promise<void> {
  try {
    await owner.close();
  } catch (error) {
    ownerCloseFailed.add(id);
    throw new Error("Project owner close failed; restart the owned host before retrying", { cause: error });
  }
  durableRuntimes.delete(id);
}

/** Work is running or queued: closing the owner now would interrupt it. */
async function ownerBusy(owner: DurableProjectRuntime): Promise<boolean> {
  const current = await owner.snapshot(),
    plan = await owner.jobs();
  return (
    current.coordinator.busy ||
    current.coordinator.submissions.some((item) => item.status === "queued" || item.status === "placed") ||
    workBusy(plan)
  );
}

const settings = settingsApplication({
  load: loadProject,
  save: saveProject,
  lock: (id, operation) => withProjectLock(id, operation),
  running: (id) => durableRuntimes.get(id),
  skillInstalled: async (id, skill) => (await configuredSkills(id)).getSkills().skills.some((item) => item.name === skill),
  closing: () => closing,
  async reopenIfIdle(id) {
    let existing: Promise<DurableProjectRuntime> | undefined;
    // The block only goes up once the owner is idle, so a busy project keeps serving requests.
    const idle = await withProjectLock(id, async () => {
      existing = durableRuntimes.get(id);
      if (existing && (await ownerBusy(await existing))) return false;
      settingsUpdating.add(id);
      return true;
    });
    if (!idle) return false;
    try {
      if (existing) await closeLifecycleOwner(id, await existing);
    } finally {
      settingsUpdating.delete(id);
    }
    // Reopened at once so schedules and PR follow keep running.
    void durable(id).catch(() => {});
    return true;
  },
});

function ownedProjectDir(id: string): string {
  const project = loadProject(id);
  if (project.id !== id) throw new Error("Project ownership mismatch");
  return projectDir(project.id);
}

async function knowledgeDir(id: string): Promise<string> {
  const dir = ownedProjectDir(id);
  await ensureKnowledge(dir);
  return dir;
}

function dispatch(input: RequestData): Promise<unknown> {
  const operation = dispatchRequest(input);
  activeRequests.add(operation);
  void operation.finally(() => activeRequests.delete(operation)).catch(() => {});
  return operation;
}

// Live activity per project for the sidebar. Only runtimes that are already open are asked (a closed project has nothing running), and a result is reused for 1.5 s.
const activityCache = new Map<string, { at: number; value: Promise<ProjectActivity> }>();
const IDLE_ACTIVITY: ProjectActivity = { working: false, needs: false, finishedAt: 0 };
async function projectActivity(id: string): Promise<ProjectActivity> {
  const opening = durableRuntimes.get(id);
  if (!opening || closing || lifecycleChanging.has(id) || settingsUpdating.has(id) || ownerCloseFailed.has(id)) return IDLE_ACTIVITY;
  const cached = activityCache.get(id);
  if (cached && Date.now() - cached.at < 1500) return cached.value;
  const value = Promise.race([
    opening.then((owner) => durableHostActivity(owner, id)),
    new Promise<ProjectActivity>((done) => setTimeout(() => done(IDLE_ACTIVITY), 2000).unref()),
  ]).catch(() => IDLE_ACTIVITY);
  activityCache.set(id, { at: Date.now(), value });
  return value;
}

async function dispatchRequest(input: RequestData): Promise<unknown> {
  if (closing) throw new Error("Host is stopping");
  switch (input.action) {
    case "web":
      return { url: web.url };
    case "remote-reload":
      await remote!.reload();
      return remote!.status();
    case "remote-status":
      return remote!.status();
    case "remote-devices":
      return remote!.devices();
    case "remote-pair-start":
      return remote!.pairStart();
    case "remote-pair-cancel":
      await remote!.pairCancel();
      return { cancelled: true };
    case "remote-revoke":
      await remote!.revoke(input.deviceId, input.confirm);
      return { revoked: true };
    case "remote-rename":
      remote!.rename(input.deviceId, input.name);
      return { renamed: true };
    case "answer": {
      const entry = await withProjectLock(input.id, async () => {
        const project = loadProject(input.id);
        const dir = ownedProjectDir(input.id);
        const entry = resolveEntry(dir, input);
        if (project.problem === entry.question) project.problem = null;
        project.phase = inbox(dir).some((item) => !item.result) || project.problem ? "attention" : "ready";
        saveProject(project);
        return entry;
      });
      // The answer is recorded first; waking the coordinator is best effort (a paused project keeps it for later).
      // The answer wakes the chat that asked; questions from before chats existed go to Main.
      const asked = entry.native
        ? (await (await durable(input.id)).chats()).find((chat) => chat.conversationId === entry.native?.conversationId)?.id
        : undefined;
      try {
        await dispatchRequest({
          action: "message",
          id: input.id,
          text: `Owner answered your question "${entry.title}":\n${input.text}`,
          ...(asked && asked !== "main" ? { chatId: asked } : {}),
        });
      } catch (error) {
        recordHostEvent("answer-delivery-deferred", errorText(error));
      }
      return entry;
    }
    // `notice` is read from disk only (no runtime is opened per project): unanswered questions in the inbox.
    case "list":
      return Promise.all(
        listProjects()
          .filter((project) => !project.deleted)
          .map(async (project) => {
            let questions = 0;
            try {
              questions = inbox(projectDir(project.id)).filter((item) => item.kind === "question" && !item.result).length;
            } catch {}
            return { ...project, notice: { questions }, activity: await projectActivity(project.id) };
          }),
      );
    case "create": {
      if (!isAbsolute(input.cwd)) throw new Error("Workspace path must be absolute");
      const cwd = await realpath(input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("Workspace must be a directory");
      const id = input.requestId ?? randomUUID();
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            name: input.name,
            cwd: input.cwd,
            objective: input.objective ?? "",
            model: input.model ?? null,
            knowledgeAccess: input.knowledgeAccess ?? null,
          }),
        )
        .digest("hex");
      const project = await withProjectLock(id, async () => {
        const dir = projectDir(id);
        if (existsSync(dir)) {
          if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, "project.json")).isFile())
            throw new Error("Creation UUID path is not a regular owned project; retained without replacement");
          const existing = loadProject(id);
          if (
            !input.requestId ||
            existing.id !== id ||
            existing.creation?.requestId !== input.requestId ||
            existing.creation.fingerprint !== fingerprint
          )
            throw new Error("Creation request UUID collides or its inputs changed; no project was overwritten");
          if (existing.cwd !== cwd)
            throw new Error("Creation workspace resolves to a different owned directory; no project was retargeted");
          return existing;
        }
        const created = parse(Project, {
          version: 1,
          id,
          name: input.name,
          cwd,
          objective: input.objective ?? "",
          createdAt: new Date().toISOString(),
          model: input.model ?? "openai-codex/gpt-5.6-sol",
          models: {},
          fallbackModels: {},
          runtime: "durable",
          ...(input.requestId ? { creation: { requestId: input.requestId, fingerprint } } : {}),
          ...(input.knowledgeAccess === undefined ? {} : { knowledgeAccess: input.knowledgeAccess }),
          libraryAccess: "coordinator",
          decisionAccess: "coordinator",
          phase: "ready",
          problem: null,
        });
        const withScope = withDefaultWorkspace(created);
        saveProject(withScope);
        return withScope;
      });
      if (!project.archived && !project.deleted) await ensureKnowledge(ownedProjectDir(project.id));
      return loadProject(project.id);
    }
    case "models-snapshot":
      return projectModelCatalog(input);
    case "model-picker-snapshot":
      return projectModelPicker(input.id ? loadProject(input.id) : undefined);
    case "usage-snapshot":
      return (await durable(input.id)).usageSnapshot(input);
    case "library-import":
      return withProjectLock(input.id, async () => {
        const project = loadProject(input.id);
        if (input.confirm !== project.id) throw new Error("Library import requires confirmation matching project id");
        if (project.deleted || project.archived) throw new Error("Inactive project cannot import library files");
        return libraryImport(ownedProjectDir(input.id), input);
      });
    case "library-list":
      return libraryList(ownedProjectDir(input.id), input);
    case "upload-list":
      return listUploads(ownedProjectDir(input.id));
    case "upload-read": {
      const { record, text } = uploadText(ownedProjectDir(input.id), input.uploadId),
        chars = [...text],
        offset = input.offset ?? 0,
        end = Math.min(chars.length, offset + (input.limit ?? 20_000));
      return { record, text: chars.slice(offset, end).join(""), offset, nextOffset: end < chars.length ? end : null };
    }
    case "upload-delete":
      return withProjectLock(input.id, async () => deleteUpload(ownedProjectDir(input.id), input.uploadId));
    case "library-read":
      return libraryRead(ownedProjectDir(input.id), input);
    case "settings-snapshot":
      return settings.snapshot(input.id);
    case "prompts-snapshot": {
      const project = loadProject(input.id),
        defaults = DEFAULT_ROLE_PROMPTS;
      return {
        scope: "project",
        roles: PROMPT_ROLES.map((role) => ({
          role,
          default: defaults[role],
          override: project.prompts?.[role] ?? null,
          effective: project.prompts?.[role] ?? defaults[role],
        })),
      };
    }
    case "coordinator-skills":
      return { skills: listSkills(await configuredSkills(input.id)) };
    case "ref-candidates":
      return refCandidates(loadProject(input.id), await knowledgeDir(input.id), { refresh: input.refresh });
    case "ref-preview":
      return input.kind === "skill"
        ? skillPreview(await configuredSkills(input.id), input.value)
        : refPreview(loadProject(input.id), { kind: input.kind, value: input.value });
    case "mcp-catalog":
      loadProject(input.id);
      return mcpCatalog();
    case "mcp-probe": {
      const project = loadProject(input.id),
        info = mcpCatalog().servers.find((item) => item.name === input.server);
      if (!info || info.status !== "ready") return { ok: false, error: info ? `Server is ${info.status}` : "Unknown server" };
      try {
        return { ok: true, tools: (await mcpPool.tools(input.server, project.cwd)).length };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
    case "settings-update": {
      const result = await settings.update(input);
      feed.publish(input.id, { topic: "settings" });
      return result;
    }
    case "command-profiles-snapshot":
      return commandProfilesSnapshot(loadProject(input.id));
    case "command-profile-read": {
      const profile = (loadProject(input.id).commandProfiles ?? []).find((item) => item.id === input.profileId);
      if (!profile) throw new Error("Unknown command profile");
      return profile;
    }
    case "command-profile-set":
      return settings.setCommandProfile(input);
    case "show":
      return durableHostSnapshot(await durable(input.id), input.chatId);
    case "search":
      return searchProject(ownedProjectDir(input.id), input.query, await (await durable(input.id)).searchSources(), input.limit);
    case "chat-create":
      return withDurableOwner({
        id: input.id,
        validate: (project) => {
          if (project.deleted || project.archived) throw new Error("Inactive project cannot open a chat");
        },
        operation: (owner) => owner.chatCreate(input.title),
      });
    case "chat-update":
      return withDurableOwner({
        id: input.id,
        validate: (project) => {
          if (project.deleted) throw new Error("Project is deleted");
        },
        operation: (owner) => owner.chatUpdate(input.chatId, { title: input.title, archived: input.archived }),
      });
    case "delete":
      return lifecycle(
        input.id,
        () => {
          if (input.confirm !== input.id) throw new Error("Deletion requires confirmation matching project id");
        },
        async (owner) => {
          await owner.pause();
          await closeLifecycleOwner(input.id, owner);
          return withProjectLock(
            input.id,
            async () => {
              const project = loadProject(input.id);
              project.archived = true;
              project.deleted = true;
              saveProject(project);
              return { deleted: true, retained: true, paused: true };
            },
            true,
          );
        },
      );
    case "archive":
      return lifecycle(
        input.id,
        () => {},
        async (owner) => {
          await owner.pause();
          await closeLifecycleOwner(input.id, owner);
          return withProjectLock(
            input.id,
            async () => {
              const project = loadProject(input.id);
              project.archived = true;
              saveProject(project);
              return { archived: true, paused: true };
            },
            true,
          );
        },
      );
    case "restore":
      return lifecycle(
        input.id,
        () => {},
        async (owner) => {
          if (!(await owner.jobs()).paused) throw new Error("Project must be paused before restore");
          await closeLifecycleOwner(input.id, owner);
          return withProjectLock(
            input.id,
            async () => {
              const project = loadProject(input.id);
              project.archived = false;
              project.deleted = false;
              saveProject(project);
              return { archived: false, paused: true };
            },
            true,
          );
        },
      );
    case "jobs-snapshot":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.jobs() });
    case "job-approve": {
      const result = await (await durable(input.id)).approveJob(input.jobId);
      if ("refused" in result) throw new Error(result.refused);
      return { ...result.outcome, line: describeAcceptance(result.outcome) };
    }
    case "artifacts-list": {
      // Owner browsing: one thread's files, or every thread that has some (known threads of this project only).
      const dir = ownedProjectDir(input.id),
        threads = (await (await durable(input.id)).jobs()).agents.map((agent) => agent.id);
      if (input.threadId) {
        if (!threads.includes(input.threadId)) throw new Error("Unknown thread for this project");
        const { dir: _, ...listing } = listArtifacts(dir, input.threadId);
        return listing;
      }
      return {
        threads: [...new Set(threads)].flatMap((threadId) => {
          const { dir: _, ...listing } = listArtifacts(dir, threadId);
          return listing.files.length ? [listing] : [];
        }),
      };
    }
    case "compact":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.compact(input.chatId) });
    case "chat-reload":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.reload(input.chatId) });
    case "chat-reset":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.reset(input.chatId) });
    case "worktrees-snapshot":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.worktrees() });
    case "worktrees-cleanup":
      if (input.confirm !== input.id) throw new Error("Worktree cleanup requires confirmation matching project id");
      return withDurableOwner({ id: input.id, operation: (owner) => owner.cleanupWorktrees() });
    case "event-log":
      return withDurableOwner({
        id: input.id,
        operation: async (owner) => {
          const [plan, scheduled, view] = await Promise.all([
            owner.jobs(),
            owner.scheduleSnapshot({ includeHistory: true }),
            owner.snapshot(),
          ]);
          const events: Array<{ at: number; kind: string; source: string; id: string | null; detail: string }> = [];
          for (const job of plan.jobs) {
            events.push({
              at: job.createdAt,
              kind: "work-dispatched",
              source: "plan",
              id: job.id,
              detail: `worker: ${job.title.slice(0, 240)}`,
            });
            if (job.endedAt !== null)
              events.push({ at: job.endedAt, kind: "work-settled", source: "plan", id: job.id, detail: job.status });
            if (job.status === "failed")
              events.push({
                at: job.endedAt ?? job.createdAt,
                kind: "error",
                source: "plan",
                id: job.id,
                detail: job.reason ?? "Job failed",
              });
          }
          for (const event of scheduled.events)
            events.push({ at: event.createdAtMs, kind: "schedule-fired", source: "schedule", id: event.eventId, detail: event.kind });
          for (const item of scheduled.intents)
            if (item.status === "uncertain" || item.status === "interrupted")
              events.push({
                at: item.recordedAtMs,
                kind: item.status === "uncertain" ? "error" : "approval",
                source: "schedule",
                id: item.requestId,
                detail: item.outcome ?? item.status,
              });
          for (const decision of inbox(projectDir(input.id)))
            if (decision.result)
              events.push({
                at: Date.parse(decision.result.at),
                kind: "approval",
                source: "decision",
                id: decision.id,
                detail: decision.kind,
              });
          for (const event of hostEvents) events.push({ ...event, source: "host-observed", id: null });
          if (view.coordinator.busy)
            events.push({ at: Date.now(), kind: "lifecycle", source: "snapshot", id: null, detail: "coordinator-busy" });
          events.sort((a, b) => b.at - a.at);
          const offset = input.offset ?? 0,
            limit = input.limit ?? 100;
          return { events: events.slice(offset, offset + limit), offset, limit, total: events.length };
        },
      });
    case "host-health":
      return withDurableOwner({
        id: input.id,
        operation: async (owner) => {
          const [plan, view] = await Promise.all([owner.jobs(), owner.snapshot()]);
          const projectJobs = jobs(input.id);
          let leases = 0;
          try {
            const pid = Number(readFileSync(lock, "utf8").trim());
            leases = Number.isSafeInteger(pid) && pid > 0 ? 1 : 0;
          } catch {
            leases = 0;
          }
          return {
            uptimeMs: Date.now() - hostStartedAt,
            pid: process.pid,
            node: process.version,
            activeLeases: leases,
            activeLocks: projectLocks.size,
            queue: {
              queued: 0,
              running: plan.jobs.filter((job) => job.status === "running").length,
            },
            busy: view.coordinator.busy,
            paused: plan.paused,
            failedJobs: projectJobs.filter((job) => job.state === "failed").length,
            macAwake: null,
            macAwakeReason: "No bounded platform-specific awake probe is configured",
          };
        },
      });
    case "pause":
      return lifecycle(
        input.id,
        () => {},
        async (owner) => {
          const result = await owner.pause();
          recordHostEvent("lifecycle", `paused:${input.id}`);
          return { paused: result.paused };
        },
      );
    case "resume":
      return lifecycle(
        input.id,
        (project) => {
          if (input.confirm !== undefined && input.confirm !== input.id) throw new Error("Resume confirmation must match the project id");
          if (project.deleted) throw new Error("Deleted project must be restored before resume");
          if (project.archived) throw new Error("Archived project must be restored before resume");
        },
        async (owner) => {
          const paused = (await owner.resume()).paused;
          recordHostEvent("lifecycle", `resumed:${input.id}`);
          return { paused };
        },
      );
    case "owner-setup-snapshot": {
      const project = loadProject(input.id);
      const workspaceRevision = workspaceAuthorizationRevision(project);
      const githubRevision = createHash("sha256")
        .update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []]))
        .digest("hex");
      const profileSnapshot = commandProfilesSnapshot(project);
      return {
        projectId: project.id,
        workspaceRevision,
        githubRevision,
        profilesRevision: profileSnapshot.revision,
        workspace: project.workspaceAuthorization
          ? {
              version: project.workspaceAuthorization.version,
              provider: project.workspaceAuthorization.provider,
              owner: project.workspaceAuthorization.owner,
              repositories: project.workspaceAuthorization.repositories.map((repository) => ({
                repositoryId: repository.repositoryId,
                provider: repository.provider,
                ownerCheckout: repository.ownerCheckout,
                approvedRoot: repository.approvedRoot,
                fileOwnershipPrefix: repository.fileOwnershipPrefix,
                ...(repository.sharedObjectStore ? { sharedObjectStore: repository.sharedObjectStore } : {}),
                ...(repository.subpath ? { subpath: repository.subpath } : {}),
              })),
              scopes: project.workspaceAuthorization.scopes.map((scope) => ({
                id: scope.id,
                repositoryId: scope.repositoryId,
                fileCount: scope.files.length,
                baseRevision: scope.baseRevision,
                evidenceCapture: scope.evidenceCapture === true,
                wholeRepository: scope.wholeRepository === true,
              })),
            }
          : null,
        quickGrant: quickWorkspacePreview(project, workerWorktreeRoot(project.id)),
        githubQuick: await githubQuickPreview(project),
        workspaceHistory: (project.workspaceAuthorizationHistory ?? []).map((item) => ({
          revokedAt: item.revokedAt,
          repositoryId: item.repositoryId,
          scopeId: item.scopeId,
          baseRevision: item.baseRevision,
          repositorySha256: item.repositorySha256,
          scopeSha256: item.scopeSha256,
        })),
        github: project.githubAuthorization ?? [],
        providerCards: plugins.workspaceProviders().flatMap((provider) => provider.setupCards?.(project) ?? []),
        unloadedProvider:
          project.workspaceAuthorization &&
          project.workspaceAuthorization.provider !== "github" &&
          !plugins.workspaceProvider(project.workspaceAuthorization.provider)
            ? project.workspaceAuthorization.provider
            : null,
        githubHistory: (project.githubAuthorizationHistory ?? []).map((item) => ({
          revokedAt: item.revokedAt,
          repositoryId: item.authorization.repositoryId,
          numericId: item.authorization.numericId,
          branchPrefix: item.authorization.branchPrefix,
          baseBranch: item.authorization.baseBranch,
          owner: item.authorization.owner,
        })),
        profiles: profileSnapshot.profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          repositoryId: profile.repositoryId,
          scopeIds: profile.scopeIds,
          effect: profile.effect,
          enabled: profile.enabled,
          revision: profile.revision,
          executionAvailable: profile.executionAvailable,
          blocker: profile.blocker,
        })),
        configuredCatalog: { available: true, reason: "Configured Pi skills load automatically for whole-repository workers." },
      };
    }
    case "github-repository-inspect": {
      const project = loadProject(input.id),
        revision = workspaceAuthorizationRevision(project);
      const result = await inspectGithubRepository(project, input);
      const current = loadProject(input.id);
      if (current.cwd !== project.cwd || workspaceAuthorizationRevision(current) !== revision)
        throw new Error("Project workspace changed during repository identity inspection; inspect again");
      return result;
    }
    case "github-authorize":
    case "github-quick-authorize": {
      if (input.confirm !== input.id) throw new Error("GitHub authorization requires confirmation matching project id");
      const before = loadProject(input.id);
      const revision = createHash("sha256")
        .update(JSON.stringify([before.githubAuthorization ?? [], before.githubAuthorizationHistory ?? []]))
        .digest("hex");
      if (revision !== input.expectedRevision) throw new Error("GitHub authorization changed; refresh before authorizing");
      const authorization =
        input.action === "github-quick-authorize" ? await authorizeGithubQuick(before, input) : await authorizeGithub(before, input);
      const validate = (project: ReturnType<typeof loadProject>) => {
        const currentRevision = createHash("sha256")
          .update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []]))
          .digest("hex");
        if (
          currentRevision !== input.expectedRevision ||
          authorizationFingerprint(project) !== authorizationFingerprint(before) ||
          project.archived ||
          project.deleted
        )
          throw new Error("Project authorization changed during GitHub authorization");
        const existing = project.githubAuthorization?.find((item) => item.repositoryId === authorization.repositoryId);
        if (
          existing &&
          (existing.numericId !== authorization.numericId ||
            existing.branchPrefix !== authorization.branchPrefix ||
            existing.baseBranch !== authorization.baseBranch ||
            existing.owner !== authorization.owner)
        )
          throw new Error("GitHub publication target is immutable");
        if (!existing && (project.githubAuthorization?.length ?? 0) >= 64) throw new Error("GitHub authorization limit reached");
      };
      return lifecycle(input.id, validate, async (owner) => {
        const view = await owner.snapshot(),
          plan = await owner.jobs();
        if (
          view.coordinator.busy ||
          view.coordinator.submissions.some((item) => item.status === "queued" || item.status === "placed") ||
          workBusy(plan)
        )
          throw new Error("GitHub authorization requires no active project work");
        await closeLifecycleOwner(input.id, owner);
        return withProjectLock(
          input.id,
          async () => {
            const project = loadProject(input.id);
            validate(project);
            const entries = project.githubAuthorization ?? [];
            saveProject({
              ...project,
              githubAuthorization: [...entries.filter((item) => item.repositoryId !== authorization.repositoryId), authorization],
            });
            return authorization;
          },
          true,
        );
      });
    }
    case "plugins":
      return { plugins: plugins.status(), labels: plugins.labels(), web: plugins.web() };
    case "plugin": {
      const handler = plugins.rpc(input.plugin, input.method);
      if (!handler)
        throw new Error(`Plugin RPC ${input.plugin}.${input.method} is unavailable: the plugin is not loaded or has no such method`);
      return handler({
        params: input.params,
        projectId: input.id,
        withRoot: (id, fn) => withDurableOwner({ id, operation: (owner) => owner.withRoot(fn) }),
        mutateIdle: (id, change) =>
          lifecycle(id, change.validate, async (owner) => {
            const view = await owner.snapshot(),
              plan = await owner.jobs();
            if (
              view.coordinator.busy ||
              view.coordinator.submissions.some((item) => item.status === "queued" || item.status === "placed") ||
              workBusy(plan)
            )
              throw new Error("This change requires no active project work");
            await closeLifecycleOwner(id, owner);
            return withProjectLock(
              id,
              async () => {
                const project = loadProject(id);
                change.validate(project);
                saveProject(change.apply(project));
              },
              true,
            );
          }),
      });
    }
    case "provider-pr-inspect":
    case "provider-ci-inspect":
    case "provider-review-inspect":
    case "provider-ci-detail":
    case "provider-conflict-inspect":
    case "provider-ci-job-inspect": {
      const project = loadProject(input.id);
      const revision = authorizationFingerprint(project);
      const result = await githubInspection.inspect(project, input);
      if (authorizationFingerprint(loadProject(input.id)) !== revision)
        throw new Error("Workspace authorization changed during inspection; inspect again");
      return result;
    }
    case "command-intent-inspect":
      return (await durable(input.id)).commandIntentInspect(input.key, input.confirm);
    case "command-intents-snapshot":
      return (await durable(input.id)).commandIntentsSnapshot(input);
    case "github-read-snapshot":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.githubReadSnapshot(input) });
    case "github-write-inspect":
      return (await durable(input.id)).githubWriteInspect(input);
    case "github-write-snapshot":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.githubWriteSnapshot(input) });
    case "github-revoke": {
      if (input.confirm !== input.id) throw new Error("GitHub authorization revocation requires confirmation matching project id");
      return lifecycle(
        input.id,
        (project) => {
          if (project.archived || project.deleted) throw new Error("Restore the project before changing GitHub authorization");
          const revision = createHash("sha256")
            .update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []]))
            .digest("hex");
          if (
            revision !== input.expectedRevision ||
            !(project.githubAuthorization ?? []).some((item) => item.repositoryId === input.repositoryId)
          )
            throw new Error("GitHub authorization changed or is unknown; refresh before revoking");
          if ((project.githubAuthorizationHistory ?? []).length >= 64) throw new Error("GitHub authorization history limit reached");
        },
        async (owner) => {
          const view = await owner.snapshot(),
            plan = await owner.jobs();
          if (
            view.coordinator.busy ||
            view.coordinator.submissions.some((item) => item.status === "queued" || item.status === "placed") ||
            workBusy(plan)
          )
            throw new Error("GitHub authorization changes require an idle project");
          await closeLifecycleOwner(input.id, owner);
          return withProjectLock(
            input.id,
            async () => {
              const project = loadProject(input.id),
                currentRevision = createHash("sha256")
                  .update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []]))
                  .digest("hex");
              if (project.archived || project.deleted) throw new Error("Restore the project before changing GitHub authorization");
              if (currentRevision !== input.expectedRevision) throw new Error("GitHub authorization changed before revocation");
              const authorization = (project.githubAuthorization ?? []).find((item) => item.repositoryId === input.repositoryId);
              if (!authorization) throw new Error("Unknown active GitHub authorization");
              const history = project.githubAuthorizationHistory ?? [];
              if (history.length >= 64) throw new Error("GitHub authorization history limit reached");
              saveProject({
                ...project,
                githubAuthorization: (project.githubAuthorization ?? []).filter((item) => item.repositoryId !== input.repositoryId),
                githubAuthorizationHistory: [...history, { revokedAt: new Date().toISOString(), authorization }],
              });
              return { revoked: true, repositoryId: input.repositoryId };
            },
            true,
          );
        },
      );
    }
    case "workspace-catalog":
      return catalog(loadProject(input.id));
    case "workspace-grant": {
      if (input.confirm !== input.id) throw new Error("Workspace grant requires confirmation matching project id");
      const before = loadProject(input.id);
      if (workspaceAuthorizationRevision(before) !== input.expectedRevision)
        throw new Error("Workspace authorization changed; refresh before granting");
      return persistWorkspaceGrant(
        before,
        input.expectedRevision,
        grantWorkspace({
          project: before,
          repositoryId: input.repositoryId,
          provider: input.provider,
          ownerCheckout: input.ownerCheckout,
          approvedRoot: input.approvedRoot,
          fileOwnershipPrefix: input.fileOwnershipPrefix,
          files: input.files,
          baseRevision: input.baseRevision,
          evidenceCapture: input.evidenceCapture,
        }),
      );
    }
    case "workspace-quick-grant": {
      if (input.confirm !== input.id) throw new Error("Workspace grant requires confirmation matching project id");
      const before = loadProject(input.id);
      if (workspaceAuthorizationRevision(before) !== input.expectedRevision)
        throw new Error("Workspace authorization changed; refresh before granting");
      // Projects get this scope automatically; asking again is a no-op that returns the existing one.
      const existing = before.workspaceAuthorization?.scopes.find((scope) => scope.wholeRepository);
      if (existing) return existing;
      return persistWorkspaceGrant(before, input.expectedRevision, grantWholeRepository(before, workerWorktreeRoot(input.id)));
    }
    case "workspace-revoke": {
      if (input.confirm !== input.id) throw new Error("Workspace revocation requires confirmation matching project id");
      const persist = () =>
        withProjectLock(
          input.id,
          async () => {
            const project = loadProject(input.id),
              auth = project.workspaceAuthorization;
            if (project.archived || project.deleted) throw new Error("Restore the project before changing workspace authorization");
            if (workspaceAuthorizationRevision(project) !== input.expectedRevision || !auth)
              throw new Error("Workspace authorization changed before revocation");
            const scope = auth.scopes.find((item) => item.id === input.scopeId);
            if (!scope) throw new Error("Unknown active workspace scope");
            const repository = auth.repositories.find((item) => item.repositoryId === scope.repositoryId);
            if (!repository) throw new Error("Workspace scope has no retained repository binding");
            const history = project.workspaceAuthorizationHistory ?? [];
            if (history.length >= 2048) throw new Error("Workspace authorization history limit reached");
            const scopes = auth.scopes.filter((item) => item.id !== scope.id),
              repositories = auth.repositories.filter((item) => scopes.some((remaining) => remaining.repositoryId === item.repositoryId));
            const historyEntry = {
              revokedAt: new Date().toISOString(),
              repositoryId: repository.repositoryId,
              repositorySha256: workspaceRepositoryFingerprint(repository),
              scopeId: scope.id,
              scopeSha256: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
              baseRevision: scope.baseRevision,
            };
            saveProject(
              rebindAuthorizations({
                ...project,
                workspaceAuthorization: scopes.length ? { ...auth, scopes, repositories } : undefined,
                workspaceAuthorizationHistory: [...history, historyEntry],
              }),
            );
            return { revoked: true, scopeId: input.scopeId, repositoryId: scope.repositoryId };
          },
          true,
        );
      return lifecycle(
        input.id,
        (project) => {
          if (project.archived || project.deleted) throw new Error("Restore the project before changing workspace authorization");
          if (
            workspaceAuthorizationRevision(project) !== input.expectedRevision ||
            !project.workspaceAuthorization?.scopes.some((scope) => scope.id === input.scopeId)
          )
            throw new Error("Workspace scope changed or is unknown; refresh before revoking");
          if ((project.workspaceAuthorizationHistory ?? []).length >= 2048)
            throw new Error("Workspace authorization history limit reached");
        },
        async (owner) => {
          const current = await owner.snapshot(),
            plan = await owner.jobs();
          if (
            current.coordinator.busy ||
            current.coordinator.submissions.some((item) => item.status === "queued" || item.status === "placed") ||
            workBusy(plan)
          )
            throw new Error("Workspace changes require an idle project");
          await closeLifecycleOwner(input.id, owner);
          return persist();
        },
      );
    }
    case "schedule-create":
      return withDurableOwner({
        id: input.id,
        operation: (owner) =>
          owner.scheduleCreate({
            id: input.scheduleId,
            atMs: input.atMs,
            text: input.text,
            everyMs: input.everyMs,
            calendar: input.calendar,
          }),
      });
    case "schedule-enable":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.scheduleSetEnabled(input.scheduleId, input.enabled) });
    case "schedule-snapshot":
      return (await durable(input.id)).scheduleSnapshot({ includeHistory: input.includeHistory });
    case "schedule-history":
      return (await durable(input.id)).scheduleHistory(input.kind, {
        offset: input.offset,
        limit: input.limit,
        textOffset: input.textOffset,
        textLimit: input.textLimit,
      });
    case "event-opt-in":
      return withDurableOwner({ id: input.id, operation: (owner) => owner.scheduleSetEventOptIn(input.enabled) });
    case "automation-snapshot":
      return automationSnapshot(input.id);
    case "automation-update": {
      const project = loadProject(input.id);
      if (project.deleted || project.archived) throw new Error("Automations need an active project");
      const owner = await durable(input.id),
        before = loadAutomations(input.id);
      if (input.change.eventChat && input.change.eventChat !== "main") {
        const chat = (await owner.chats()).find((item) => item.id === input.change.eventChat);
        if (!chat || chat.archived) throw new Error("Choose an existing, active chat for events");
      }
      const next = await withProjectLock(input.id, async () => updateAutomations(input.id, input.change));
      if (next.follow.enabled && (!before.follow.enabled || next.follow.everyMs !== before.follow.everyMs)) owner.followKick();
      recordHostEvent("automations", `${input.id}:follow=${next.follow.enabled}:webhook=${next.webhook.enabled}`);
      return automationSnapshot(input.id);
    }
    case "webhook-rotate": {
      if (input.confirm !== input.id) throw new Error("Rotating the webhook secret requires confirmation matching project id");
      await withProjectLock(input.id, async () => rotateWebhookSecret(input.id));
      recordHostEvent("automations", `${input.id}:webhook-rotated`);
      return automationSnapshot(input.id);
    }
    case "prs": {
      const project = loadProject(input.id);
      if (project.archived || project.deleted) return { providers: [], unloaded: [] };
      const granted = project.workspaceAuthorization?.provider;
      return {
        providers: await (await durable(input.id)).prs(input.refresh === true),
        unloaded: granted && granted !== "github" && !plugins.workspaceProvider(granted) ? [granted] : [],
      };
    }
    case "pr-watch":
    case "pr-hide": {
      const project = loadProject(input.id),
        provider = plugins.prProvider(input.provider);
      if (project.archived || project.deleted || !provider?.applies(project))
        throw new Error("Watching or hiding PRs needs an active project served by a loaded PR provider");
      const owner = await durable(input.id);
      const pr = provider.normalizeId ? provider.normalizeId(project, input.pr) : input.pr;
      return input.action === "pr-watch"
        ? { watched: await owner.prWatch(input.provider, pr, input.watch) }
        : { hidden: await owner.prHide(input.provider, pr, input.hide) };
    }
    case "follow-poll": {
      const result = await (await durable(input.id)).followPoll();
      return { result, ...(await automationSnapshot(input.id)) };
    }
    case "event-ingest":
      return withDurableOwner({
        id: input.id,
        operation: (owner) => owner.ingestLocalEvent({ eventId: input.eventId, kind: input.kind, payload: input.payload }),
      });
    case "thread-steer": {
      const project = loadProject(input.id);
      if (project.deleted || project.archived) throw new Error("Inactive project cannot control worker threads");
      return { result: await (await durable(input.id)).steerJob(input.threadId, input.text, { requestId: input.requestId }) };
    }
    case "thread-stop": {
      const project = loadProject(input.id);
      if (project.deleted || project.archived) throw new Error("Inactive project cannot control worker threads");
      await (await durable(input.id)).stopJob(input.threadId, input.reason ?? "Stopped by the owner");
      return { stopped: true, threadId: input.threadId };
    }
    case "worker-contexts":
      return (await durable(input.id)).workerContexts(input.threadIds);
    case "limits-snapshot":
      return limitsSnapshot(Date.now(), input.visit === true ? "visit" : false);
    case "limits-refresh":
      return limitsSnapshot(Date.now(), true);
    case "machine-status":
      return machineStatus();
    case "cursor-connect":
      return startCursorLogin();
    case "thread-history":
      return (await durable(input.id)).threadHistory(input.threadId, input);
    case "chat-history":
      return (await durable(input.id)).chatHistory(input.chatId, input);
    case "transcript-text":
      return (await durable(input.id)).transcriptText(
        input.threadId ? { threadId: input.threadId } : { chatId: input.chatId ?? "main" },
        input.ref,
        input,
      );
    case "transcript-image": {
      const image = await (
        await durable(input.id)
      ).transcriptImage(input.threadId ? { threadId: input.threadId } : { chatId: input.chatId ?? "main" }, input.ref);
      return { mime: image.mime, data: image.bytes.toString("base64") };
    }
    case "archive-config":
      return archiveConfig(input.home);
    case "archive-projects":
      return archiveProjects();
    case "archive-project":
      return archiveProject(input.projectId);
    case "archive-history":
      return archiveHistory(input.projectId, input.conversationId, input);
    case "archive-text":
      return archiveText(input.projectId, input.conversationId, input.ref, input);
    case "archive-image": {
      const image = await archiveImage(input.projectId, input.conversationId, input.ref);
      return { mime: image.mime, data: image.bytes.toString("base64") };
    }
    case "thread-send":
      return withDurableOwner({
        id: input.id,
        validate: (project) => {
          if (project.deleted) throw new Error("Project is deleted; admission is denied");
          if (project.archived) throw new Error("Project is archived; admission is denied");
        },
        operation: async (owner) => {
          const plan = await owner.jobs();
          if (plan.paused) throw new Error("Project plan is paused; admission is denied");
          return { result: await owner.steerJob(input.threadId, input.text, { followUp: true, requestId: input.requestId }) };
        },
      });
    case "message": {
      const prepareJob = () => {
        const project = loadProject(input.id);
        if (project.deleted) throw new Error("Project is deleted; admission is denied");
        if (project.archived) throw new Error("Project is archived; admission is denied");
        for (const upload of input.attachments ?? []) uploadRecord(ownedProjectDir(input.id), upload);
        return {
          id: input.requestId ?? randomUUID(),
          text: input.text,
          at: new Date().toISOString(),
          state: "queued",
          error: null,
          ...(input.chatId && input.chatId !== "main" ? { chatId: input.chatId } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        } satisfies import("./state.ts").Job;
      };
      return withDurableOwner({
        id: input.id,
        validate: (project) => {
          if (project.deleted) throw new Error("Project is deleted; admission is denied");
          if (project.archived) throw new Error("Project is archived; admission is denied");
        },
        operation: async (owner) => {
          // A repeated request ID (Telegram update replay) returns the job it already admitted.
          const prior = input.requestId ? jobs(input.id).find((job) => job.id === input.requestId) : undefined;
          if (prior) return prior;
          const job = prepareJob();
          // The job keeps what the owner typed; the coordinator receives the expanded skill.
          // `/skill:<name>` anywhere: skill blocks precede the owner's words. `@issue:/@doc:/@upload:/@file:` and `#123` / `PR #123`: compact untrusted blocks follow them.
          const text =
            (skillNames(job.text).length ? await expandSkillCommand(await configuredSkills(input.id), job.text) : job.text) +
            (await referencedItemsBlock(loadProject(input.id), ownedProjectDir(input.id), job.text)) +
            (await referencedPrBlock(loadProject(input.id), job.text));
          if (text.length > 120_000)
            throw new Error(`Message with its skills and references is too large to send (${text.length} characters; limit 120000)`);
          for (const invoked of skillNames(job.text)) recordInvokedSkill(ownedProjectDir(input.id), invoked);
          const plan = await owner.jobs();
          if (plan.paused) throw new Error("Project plan is paused; admission is denied");
          // Validate the chat before recording the job, so an unknown or archived chat leaves no ledger entry.
          const chat = (await owner.chats()).find((item) => item.id === (input.chatId ?? "main"));
          if (!chat) throw new Error("Unknown chat for this project");
          if (chat.archived) throw new Error("Chat is archived; restore it before sending");
          saveJob(input.id, job);
          await owner.admit(attachmentContent(ownedProjectDir(input.id), text, job.attachments, owner.acceptsImages), {
            requestId: job.id,
            chatId: input.chatId,
            title: job.text,
          });
          return job;
        },
      });
    }
    case "work-submit": {
      const validate = () => {
        ownedProjectDir(input.id);
        const project = loadProject(input.id);
        if (project.deleted || project.archived) throw new Error("Inactive project cannot admit scoped worker work");
        if (!project.workspaceAuthorization?.scopes.some((scope) => scope.id === input.workspaceScopeId))
          throw new Error("Scoped submission requires an existing owner-authorized workspace scope");
      };
      validate();
      return withDurableOwner({
        id: input.id,
        validate,
        operation: (owner) =>
          owner.spawn(undefined, {
            role: "worker",
            brief: input.text,
            title: input.text.slice(0, 80),
            acceptance: ["The request is done as described"],
            scopeId: input.workspaceScopeId,
            requestId: input.requestId,
          }),
      });
    }
    case "notes":
      loadProject(input.id);
      return notes(projectDir(input.id));
    case "knowledge-list":
      return listKnowledge(await knowledgeDir(input.id));
    case "knowledge-read":
      return readKnowledge(await knowledgeDir(input.id), input.path);
    case "knowledge-write": {
      const written = writeKnowledge({
        dir: await knowledgeDir(input.id),
        path: input.path,
        text: input.text,
        expectedRevision: input.expectedRevision,
        author: "owner",
      });
      feed.publish(input.id, { topic: "knowledge" });
      return written;
    }
    case "knowledge-history":
      return historyKnowledge(await knowledgeDir(input.id), input.path);
    case "notify-feed":
      return notifier.feed(input.after);
    case "telegram-snapshot":
      return telegram.snapshot();
    case "telegram-token": {
      const snapshot = await telegram.setToken(input.token);
      recordHostEvent("telegram", `bot set: @${snapshot.botUsername}`);
      return snapshot;
    }
    case "telegram-pair":
      recordHostEvent("telegram", "pairing code issued");
      return telegram.pair();
    case "telegram-unpair":
      recordHostEvent("telegram", "unpaired");
      return telegram.unpair();
    case "telegram-remove":
      recordHostEvent("telegram", "bot removed");
      return telegram.remove();
    case "deploy-snapshot":
      return { settings: loadDeploySettings(), state: readDeployState(), running: deployRunning() };
    case "deploy-settings":
      saveDeploySettings(input.settings);
      recordHostEvent(
        "deploy",
        `deploy when idle ${input.settings.idle ? "on" : "off"} ${input.settings.startHour}-${input.settings.endHour}`,
      );
      return { settings: loadDeploySettings(), state: readDeployState(), running: deployRunning() };
    case "deploy-start":
      if (deployRunning()) throw new Error("A deploy is already running");
      if (!(await noOwnerBusy())) {
        queueDeploy();
        recordHostEvent("deploy", "deploy queued: work is running");
        return {
          settings: loadDeploySettings(),
          state: readDeployState(),
          running: false,
          queued: true,
          line: "Work is running, so the deploy is queued. It runs at the next moment no project has work running, whatever the deploy window.",
        };
      }
      startDeploy();
      recordHostEvent("deploy", "deploy started by the owner");
      return { settings: loadDeploySettings(), state: readDeployState(), running: true, queued: false };
    case "shutdown":
      closing = true;
      setTimeout(() => {
        void shutdown();
      }, 50);
      return { stopping: true };
    default: {
      const exhaustive: never = input;
      throw new Error(String(exhaustive));
    }
  }
}

let remote: RemoteAccess | null = null;
// Subscription limits read the logins through Pi's own resolver, which renews an expiring OAuth token under the auth-store lock. Only an OAuth login is used here (an API key has no usage endpoint).
let limitsModels: Promise<Awaited<ReturnType<typeof createModelRuntime>>> | null = null;
setLimitsTokenResolver(async (providerId) => {
  limitsModels ??= createModelRuntime();
  limitsModels.catch(() => {
    limitsModels = null;
  });
  const result = await (await limitsModels).getAuth(providerId);
  return result?.source === "OAuth" ? result.auth.apiKey : undefined;
});
const web = await startWeb(
  dispatch,
  async (id, onFrame, onEnd, chatId) => (await durable(id)).watchLive(onFrame, onEnd, chatId),
  (id, filename, bytes) =>
    withProjectLock(id, async () => {
      const project = loadProject(id);
      if (project.deleted || project.archived) throw new Error("Inactive project cannot take uploads");
      return saveUpload(ownedProjectDir(id), { filename, bytes });
    }),
  () => notifier.seq(),
  () => remote,
  (id) => durable(id),
);
remote = createRemote({
  webUrl: web.url,
  report: (detail) => recordHostEvent("remote", detail),
  summary: async () => {
    let needs = 0;
    for (const project of listProjects().filter((project) => !project.deleted && !project.archived))
      needs += inbox(projectDir(project.id)).filter((item) => !item.result).length;
    return { needs };
  },
});
try {
  await remote.reload();
} catch {
  recordHostEvent("remote", "Remote access could not start; inspect local configuration");
}
const webhooks = await startWebhooks(async (id, event) => {
  if (closing) throw new Error("Host is stopping");
  const result = await (await durable(id)).ingestAutomationEvent(event);
  return { status: result.status, ...(result.duplicate ? { duplicate: true as const } : {}) };
});
// Notices for the browser and Telegram come from open Durable owners only; a project in a lifecycle or settings transition is skipped for that scan.
const notifier = startNotifier({
  owner: (project) =>
    closing || lifecycleChanging.has(project.id) || settingsUpdating.has(project.id) || ownerCloseFailed.has(project.id)
      ? null
      : (durableRuntimes.get(project.id) ?? null),
  tickMs: Number(process.env.PI_PROJECTS_NOTIFY_TICK_MS ?? 3000),
  progress: (view) => void telegram.progress(view),
  onNotice: () => {
    web.noticesChanged(notifier.seq());
    remote?.notices(notifier.feed(pushCursor).items);
    pushCursor = notifier.seq();
    void telegram?.flush();
  },
  report: (detail) => recordHostEvent("notify", detail),
});
let pushCursor = notifier.seq();
const telegram = startTelegram({
  dispatch: (input) => dispatch(parse(Request, input)),
  approve: async (projectId, jobId) => {
    const result = await (await durable(projectId)).approveJob(jobId);
    if ("refused" in result) throw new Error(result.refused);
    return result.outcome;
  },
  chats: async (id) => (await durable(id)).chats(),
  notifier,
  report: (detail) => recordHostEvent("telegram", detail),
});
void telegram.flush();
async function automationSnapshot(id: string) {
  const project = loadProject(id),
    config = loadAutomations(id);
  return {
    eventChat: config.eventChat,
    webhook: { enabled: config.webhook.enabled, url: webhooks.url(project.id), secret: config.webhook.secret },
    follow: !project.deleted && !project.archived ? await (await durable(id)).followSnapshot() : null,
    githubRepositories: (project.githubAuthorization ?? []).map((item) => item.repositoryId),
  };
}
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
try {
  recordHostSha(execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
} catch (error) {
  forgetHostSha();
  recordHostEvent("deploy", `could not record the sha this host started from; deploy will refuse: ${errorText(error)}`);
}
function deployRunning(): boolean {
  try {
    const pid = Number(readFileSync(join(home(), "deploy.lock"), "utf8"));
    process.kill(pid, 0);
    return Number.isSafeInteger(pid) && pid > 0;
  } catch {
    return false;
  }
}
/** The deploy stops this host, so it must outlive it: detached, with its own log. */
function startDeploy(): void {
  const log = openSync(join(home(), "deploy.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(repoRoot, "src", "cli.ts"), "deploy", repoRoot], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PI_PROJECTS_HOME: home() },
    cwd: repoRoot,
  });
  child.on("error", (error) => recordHostEvent("deploy", `deploy did not start: ${errorText(error)}`));
  child.unref();
  closeSync(log);
}
/** Idle means no open project owner is busy; a project whose runtime is not open has nothing running. */
async function noOwnerBusy(): Promise<boolean> {
  for (const opening of durableRuntimes.values()) if (await ownerBusy(await opening)) return false;
  return true;
}
const idleDeployTimer = setInterval(
  () => {
    const settings = loadDeploySettings();
    if (closing) return;
    if (readDeployState().queuedAt !== undefined && !deployRunning()) {
      void noOwnerBusy()
        .then((idle) => {
          if (!idle || closing) return;
          clearQueuedDeploy();
          startDeploy();
          recordHostEvent("deploy", "queued deploy started: the host is idle");
        })
        .catch((error) => recordHostEvent("deploy", `queued deploy check failed: ${errorText(error)}`));
      return;
    }
    if (!settings.idle) return;
    idleDeployTick({
      now: new Date(),
      window: settings,
      idle: noOwnerBusy,
      pending: () => deployPending(repoRoot),
      start() {
        startDeploy();
        recordHostEvent("deploy", "deploy started: host idle inside the deploy window");
      },
    }).catch((error) => recordHostEvent("deploy", `idle deploy check failed: ${errorText(error)}`));
  },
  Number(process.env.PI_PROJECTS_DEPLOY_TICK_MS ?? 5 * 60_000),
);
idleDeployTimer.unref();
const server = createServer(async (request, response) => {
  try {
    if (closing) throw new Error("Host is stopping");
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          data: {
            pid: process.pid,
            home: home(),
            plugins: plugins.status().map(({ source, name, state, error }) => ({ source, name, state, ...(error ? { error } : {}) })),
          },
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/api") throw new Error("Unknown endpoint");
    const input = parse(Request, JSON.parse(await body(request)));
    const data = await dispatch(input);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: errorText(error) }));
  }
});
server.requestTimeout = 120000;
// Plugins load before the first request or project restore; a failing plugin is recorded, never fatal.
for (const status of await plugins.load())
  process.stderr.write(
    JSON.stringify({
      event: status.state === "loaded" ? "plugin-loaded" : "plugin-failed",
      source: status.source,
      name: status.name,
      provides: status.provides,
      ...(status.error ? { error: status.error } : {}),
    }) + "\n",
  );
server.listen(socketPath(), () => {
  if (closing) return;
  void loadProviderExtensions().then(({ status }) =>
    process.stderr.write(
      JSON.stringify({ event: "provider-extensions", loaded: status.loaded, providers: status.providers, errors: status.errors }) + "\n",
    ),
  );
  chmodSync(socketPath(), 0o600);
  process.stderr.write(JSON.stringify({ event: "projects-host-started", pid: process.pid, socket: socketPath() }) + "\n");
  for (const id of legacyProjectIds())
    process.stderr.write(
      JSON.stringify({ event: "legacy-project-refused", project: id, reason: "removed legacy runtime; not listed or opened" }) + "\n",
    );
  for (const project of listProjects().filter((p) => !p.deleted && !p.archived)) {
    const restore = durable(project.id);
    void restore.catch((error) =>
      process.stderr.write(JSON.stringify({ event: "restore-failed", project: project.id, error: errorText(error) }) + "\n"),
    );
  }
});
server.on("error", (error) => {
  process.stderr.write(errorText(error) + "\n");
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

function shutdown(): Promise<void> {
  if (shutdownOperation) return shutdownOperation;
  closing = true;
  closeArchives();
  shutdownOperation = Promise.resolve().then(async () => {
    let failed = ownerCloseFailed.size !== 0;
    const report = (error: unknown) => {
      failed = true;
      process.stderr.write(errorText(error) + "\n");
    };
    try {
      await remote?.close();
    } catch (error) {
      report(error);
    }
    try {
      web.close();
    } catch (error) {
      report(error);
    }
    try {
      webhooks.close();
    } catch (error) {
      report(error);
    }
    try {
      telegram.close();
      await notifier.close();
    } catch (error) {
      report(error);
    }
    try {
      server.close();
    } catch (error) {
      report(error);
    }
    try {
      await plugins.close();
    } catch (error) {
      report(error);
    }
    try {
      await githubInspection.close();
    } catch (error) {
      report(error);
    }
    try {
      await mcpPool.close();
    } catch (error) {
      report(error);
    }
    for (const pending of durableRuntimes.values()) {
      try {
        await (await pending).close();
      } catch (error) {
        report(error);
      }
    }
    await Promise.allSettled([...activeRequests]);
    try {
      if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch (error) {
      report(error);
    }
    process.exit(failed ? 1 : 0);
  });
  return shutdownOperation;
}
