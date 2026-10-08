import { initTheme } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home, socketPath, Request, Project, errorText, jobs, listProjects, loadProject, notes, parse, projectDir, saveJob, saveProject, type Request as RequestData } from "./state.ts";
import { ensureKnowledge, historyKnowledge, listKnowledge, readKnowledge, writeKnowledge } from "./knowledge.ts";
import { searchProject } from "./knowledge-search.ts";
import { loadProjectResourceLoader, openCoordinator, type Runtime } from "./coordinator.ts";
import { expandSkillCommand, listSkills, SKILL_COMMAND } from "./coordinator-skills.ts";
import { recordInvokedSkill } from "./skill-profiles.ts";
import { resolveEntry, inbox } from "./inbox.ts";
import { body } from "./http.ts";
import { startWeb } from "./web.ts";
import { startWebhooks } from "./webhook.ts";
import { startNotifier } from "./notify.ts";
import { startTelegram } from "./telegram.ts";
import { loadAutomations, rotateWebhookSecret, updateAutomations } from "./project-automations.ts";
import { openDurableHost, durableHostSnapshot } from "./durable-host.ts";
import { authorizationFingerprint, catalog, grantWholeRepository, grantWorkspace, quickWorkspacePreview, workspaceAuthorizationRevision, workspaceRepositoryFingerprint } from "./workspace-authorization.ts";
import { createGithubInspection } from "./github-inspection.ts";
import { authorizeGithub, authorizeGithubQuick, githubQuickPreview, inspectGithubRepository, rebindOneClickGithub } from "./github-authorization.ts";
import { projectSettings, updateProjectSettings } from "./project-settings.ts";
import { libraryImport, libraryList, libraryRead } from "./project-library.ts";
import { attachmentContent, deleteUpload, listUploads, saveUpload, uploadRecord, uploadText } from "./uploads.ts";
import { projectModelCatalog, validateProjectModelChanges } from "./project-models.ts";
import { applyCommandProfile, commandProfilesSnapshot, prepareCommandProfile } from "./command-profiles.ts";
import { captureOwnerWorkerSkillCatalog } from "./worker-skill-owner-catalog.ts";
import { protectedSkillBackingFiles } from "./worker-skill-backing.ts";
import type { DurableProjectRuntime } from "./durable-runtime.ts";

process.umask(0o077);
process.env.PI_PROJECTS_HOST = "1";
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
initTheme("light", false);
mkdirSync(home(), { recursive: true, mode: 0o700 });
const lock = join(home(), "host.lock");
if (existsSync(lock)) {
  const value = readFileSync(lock, "utf8").trim();
  if (!value) process.exit(0);
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid host lock. Inspect it before removing it.");
  try { process.kill(pid, 0); process.exit(0); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    unlinkSync(lock);
  }
}
let lockFd: number;
try { lockFd = openSync(lock, "wx", 0o600); }
catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") process.exit(0);
  throw error;
}
writeFileSync(lockFd, String(process.pid)); closeSync(lockFd);
if (existsSync(socketPath())) unlinkSync(socketPath());
const runtimes = new Map<string, Promise<Runtime>>();
const configuredSkillLoaders = new Map<string, ReturnType<typeof loadProjectResourceLoader>>();
function configuredSkills(id: string) {
  const present = configuredSkillLoaders.get(id);
  if (present) return present;
  const opening = loadProjectResourceLoader(loadProject(id));
  configuredSkillLoaders.set(id, opening);
  opening.catch(() => { if (configuredSkillLoaders.get(id) === opening) configuredSkillLoaders.delete(id); });
  return opening;
}
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
  const current = new Promise<void>(resolve => { release = resolve; });
  projectLocks.set(id, current);
  await previous;
  try {
    if (closing) throw new Error("Host is stopping");
    if (ownerCloseFailed.has(id)) throw new Error("Project owner close failed; restart the owned host before retrying");
    if (!duringTransition && lifecycleChanging.has(id)) throw new Error("Project lifecycle transition is in progress");
    if (!duringTransition && settingsUpdating.has(id)) throw new Error("Project settings update is in progress");
    return await operation();
  }
  finally { release(); if (projectLocks.get(id) === current) projectLocks.delete(id); }
}

async function withDurableOwner<T>({ id, validate, operation }: { id: string; validate?: (project: Project) => void; operation: (owner: DurableProjectRuntime) => Promise<T> }): Promise<T> {
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

function runtime(id: string): Promise<Runtime> {
  if (closing) throw new Error("Host is stopping");
  if (loadProject(id).runtime === "durable") throw new Error("This legacy operation is not available for Durable projects yet");
  const present = runtimes.get(id);
  if (present) return present;
  const opening = openCoordinator(loadProject(id), () => listProjects());
  runtimes.set(id, opening);
  opening.catch(() => { if (runtimes.get(id) === opening) runtimes.delete(id); });
  return opening;
}

function durable(id: string, duringLifecycle = false): Promise<DurableProjectRuntime> {
  if (closing) throw new Error("Host is stopping");
  if (ownerCloseFailed.has(id)) throw new Error("Project owner close failed; restart the owned host before retrying");
  if (lifecycleChanging.has(id) && !duringLifecycle) throw new Error("Project lifecycle transition is in progress");
  if (settingsUpdating.has(id)) throw new Error("Project settings update is in progress");
  const present = durableRuntimes.get(id);
  if (present) return present;
  const project = loadProject(id);
  if (project.runtime !== "durable") throw new Error("Project has not been authorized for Durable migration");
  const opening = configuredSkills(id).then(loader => openDurableHost(project, loader));
  durableRuntimes.set(id, opening);
  opening.catch(() => { if (durableRuntimes.get(id) === opening) durableRuntimes.delete(id); });
  return opening;
}

async function lifecycle<T>(id: string, validate: (project: ReturnType<typeof loadProject>) => void, operation: (owner: DurableProjectRuntime) => Promise<T>): Promise<T> {
  await withProjectLock(id, async () => {
    validate(loadProject(id));
    lifecycleChanging.add(id);
  });
  try { return await operation(await durable(id, true)); }
  finally { lifecycleChanging.delete(id); }
}

/** Worker worktrees for one-click grants live with the project data, outside the owner checkout. */
function workerWorktreeRoot(id: string): string { return join(projectDir(id), "worktrees"); }

async function persistWorkspaceGrant<T>(before: ReturnType<typeof loadProject>, expectedRevision: string, result: { project: ReturnType<typeof loadProject>; scope: T }): Promise<T> {
  const persist = async () => withProjectLock(before.id, async () => {
    const project = loadProject(before.id);
    if (workspaceAuthorizationRevision(project) !== expectedRevision || project.archived || project.deleted) throw new Error("Workspace authorization changed or project became inactive");
    saveProject(rebindOneClickGithub({ ...project, workspaceAuthorization: result.project.workspaceAuthorization })); return result.scope;
  }, before.runtime === "durable");
  if (before.runtime !== "durable") return persist();
  return lifecycle(before.id, project => { if (workspaceAuthorizationRevision(project) !== expectedRevision) throw new Error("Workspace authorization changed; refresh before granting"); }, async owner => {
    const current = await owner.snapshot(), plan = await owner.planSnapshot();
    if (current.coordinator.busy || current.coordinator.submissions.some(item => item.status === "queued" || item.status === "placed") || plan.pausing || plan.work.some(work => work.status === "queued" || work.status === "running")) throw new Error("Workspace grants require an idle Durable project");
    await closeLifecycleOwner(before.id, owner); return persist();
  });
}

async function closeLifecycleOwner(id: string, owner: DurableProjectRuntime): Promise<void> {
  try { await owner.close(); }
  catch (error) {
    ownerCloseFailed.add(id);
    throw new Error("Project owner close failed; restart the owned host before retrying", { cause: error });
  }
  durableRuntimes.delete(id);
  configuredSkillLoaders.delete(id);
}

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

async function dispatchRequest(input: RequestData): Promise<unknown> {
  if (closing) throw new Error("Host is stopping");
  switch (input.action) {
    case "web": return { url: web.url };
    case "answer": case "review": {
      if (loadProject(input.id).runtime === "durable") {
        const entry = await withProjectLock(input.id, async () => {
          const project = loadProject(input.id);
          const dir = ownedProjectDir(input.id);
          const entry = resolveEntry(dir, input, "manual");
          if (entry.kind === "question" && project.problem === entry.question) project.problem = null;
          project.phase = inbox(dir).some(item => !item.result) || project.problem ? "attention" : "ready";
          saveProject(project);
          return entry;
        });
        // The answer is recorded first; waking the coordinator is best effort (a paused project keeps it for later).
        if (input.action === "answer" && entry.kind === "question") {
          // The answer wakes the chat that asked; questions from before chats existed go to Main.
          const asked = entry.native ? (await (await durable(input.id)).chats()).find(chat => chat.conversationId === entry.native?.conversationId)?.id : undefined;
          try { await dispatchRequest({ action: "message", id: input.id, text: `Owner answered your question "${entry.title}":\n${input.text}`, ...(asked && asked !== "main" ? { chatId: asked } : {}) }); }
          catch (error) { recordHostEvent("answer-delivery-deferred", errorText(error)); }
        }
        return entry;
      }
      const owner = await runtime(input.id);
      const entry = resolveEntry(projectDir(input.id), input);
      if (entry.kind === "question" && owner.project.problem === entry.question) owner.project.problem = null;
      owner.project.phase = inbox(projectDir(input.id)).some(item => !item.result) || owner.project.problem ? "attention" : "ready";
      saveProject(owner.project);
      owner.pump();
      return entry;
    }
    case "list": return listProjects().filter(project => !project.deleted);
    case "create": {
      if (!isAbsolute(input.cwd)) throw new Error("Workspace path must be absolute");
      const cwd = await realpath(input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("Workspace must be a directory");
      const id = input.requestId ?? randomUUID();
      const fingerprint = createHash("sha256").update(JSON.stringify({ name: input.name, cwd: input.cwd, objective: input.objective ?? "", model: input.model ?? null, knowledgeAccess: input.knowledgeAccess ?? null })).digest("hex");
      const project = await withProjectLock(id, async () => {
        const dir = projectDir(id);
        if (existsSync(dir)) {
          if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, "project.json")).isFile()) throw new Error("Creation UUID path is not a regular owned project; retained without replacement");
          const existing = loadProject(id);
          if (!input.requestId || existing.id !== id || existing.creation?.requestId !== input.requestId || existing.creation.fingerprint !== fingerprint) throw new Error("Creation request UUID collides or its inputs changed; no project was overwritten");
          if (existing.cwd !== cwd) throw new Error("Creation workspace resolves to a different owned directory; no project was retargeted");
          return existing;
        }
        const created = parse(Project, {
          version: 1, id, name: input.name, cwd, objective: input.objective ?? "", createdAt: new Date().toISOString(),
          model: input.model ?? "openai-codex/gpt-5.6-sol",
          models: { worker: "openai-codex/gpt-5.6-terra", scout: "openai-codex/gpt-5.6-luna", reviewer: "openai-codex/gpt-5.6-sol" },
          runtime: "durable", ...(input.requestId ? { creation: { requestId: input.requestId, fingerprint } } : {}),
          ...(input.knowledgeAccess === undefined ? {} : { knowledgeAccess: input.knowledgeAccess }), decisionAccess: "coordinator", sessionFile: null, phase: "ready", problem: null, runs: [],
        });
        saveProject(created);
        return created;
      });
      if (!project.archived && !project.deleted) await ensureKnowledge(ownedProjectDir(project.id));
      return loadProject(project.id);
    }
    case "models-snapshot": return projectModelCatalog(input);
    case "usage-snapshot": return (await durable(input.id)).usageSnapshot(input);
    case "library-import": return withProjectLock(input.id, async () => {
      const project = loadProject(input.id);
      if (input.confirm !== project.id) throw new Error("Library import requires confirmation matching project id");
      if (project.deleted || project.archived) throw new Error("Inactive project cannot import library files");
      return libraryImport(ownedProjectDir(input.id), input);
    });
    case "library-list": return libraryList(ownedProjectDir(input.id), input);
    case "upload-list": return listUploads(ownedProjectDir(input.id));
    case "upload-read": {
      const { record, text } = uploadText(ownedProjectDir(input.id), input.uploadId), chars = [...text], offset = input.offset ?? 0, end = Math.min(chars.length, offset + (input.limit ?? 20_000));
      return { record, text: chars.slice(offset, end).join(""), offset, nextOffset: end < chars.length ? end : null };
    }
    case "upload-delete": return withProjectLock(input.id, async () => deleteUpload(ownedProjectDir(input.id), input.uploadId));
    case "library-read": return libraryRead(ownedProjectDir(input.id), input);
    case "settings-snapshot": return projectSettings(loadProject(input.id));
    case "coordinator-skills": return { skills: listSkills(await configuredSkills(input.id)) };
    case "settings-update": {
      updateProjectSettings(loadProject(input.id), input);
      await validateProjectModelChanges(input.changes);
      let existing: Promise<DurableProjectRuntime> | undefined;
      await withProjectLock(input.id, async () => {
        updateProjectSettings(loadProject(input.id), input);
        existing = durableRuntimes.get(input.id);
        settingsUpdating.add(input.id);
      });
      try {
        if (existing) {
          const owner = await existing, current = await owner.snapshot(), plan = await owner.planSnapshot();
          if (current.coordinator.busy || current.coordinator.submissions.some(item => item.status === "queued" || item.status === "placed") || plan.pausing || plan.work.some(item => item.status === "queued" || item.status === "running")) throw new Error("Settings changes require an idle coordinator and worker queue");
          await closeLifecycleOwner(input.id, owner);
        }
        return await withProjectLock(input.id, async () => {
          const project = updateProjectSettings(loadProject(input.id), input);
          saveProject(project);
          return projectSettings(project);
        }, true);
      } finally { settingsUpdating.delete(input.id); }
    }
    case "worker-skills-catalog": {
      const project = loadProject(input.id);
      const protectedFiles = await protectedSkillBackingFiles();
      const catalog = await captureOwnerWorkerSkillCatalog({ project: () => loadProject(input.id), configured: { kind: "loaded", loader: await configuredSkills(input.id) }, protectedFiles });
      const offset = input.offset ?? 0, limit = input.limit ?? 16;
      return { ...catalog, candidates: catalog.candidates.slice(offset, offset + limit), page: { offset, limit, total: catalog.candidates.length, nextOffset: offset + limit < catalog.candidates.length ? offset + limit : null } };
    }
    case "command-profiles-snapshot": return commandProfilesSnapshot(loadProject(input.id));
    case "command-profile-read": {
      const profile = (loadProject(input.id).commandProfiles ?? []).find(item => item.id === input.profileId);
      if (!profile) throw new Error("Unknown command profile");
      return profile;
    }
    case "command-profile-set": {
      const profile = await prepareCommandProfile(loadProject(input.id), input);
      let existing: Promise<DurableProjectRuntime> | undefined;
      await withProjectLock(input.id, async () => {
        applyCommandProfile(loadProject(input.id), input, profile);
        settingsUpdating.add(input.id);
        existing = durableRuntimes.get(input.id);
      });
      try {
        if (existing) {
          const owner = await existing;
          const view = await owner.snapshot(), plan = await owner.planSnapshot();
          if (view.coordinator.busy || view.coordinator.submissions.some(item => item.status === "queued" || item.status === "placed") || plan.pausing || plan.work.some(item => item.status === "queued" || item.status === "running")) throw new Error("Command profile changes require no active project work");
          await closeLifecycleOwner(input.id, owner);
        }
        return await withProjectLock(input.id, async () => {
          const project = applyCommandProfile(loadProject(input.id), input, profile);
          saveProject(project);
          return commandProfilesSnapshot(project);
        }, true);
      } finally { settingsUpdating.delete(input.id); }
    }
    case "show": return loadProject(input.id).runtime === "durable" ? durableHostSnapshot(await durable(input.id), input.chatId, input.focus) : (await runtime(input.id)).snapshot();
    case "search": return searchProject(ownedProjectDir(input.id), input.query, loadProject(input.id).runtime === "durable" ? await (await durable(input.id)).searchSources() : null, input.limit);
    case "chat-create": return withDurableOwner({ id: input.id, validate: project => { if (project.deleted || project.archived) throw new Error("Inactive project cannot open a chat"); }, operation: owner => owner.chatCreate(input.title) });
    case "chat-update": return withDurableOwner({ id: input.id, validate: project => { if (project.deleted) throw new Error("Project is deleted"); }, operation: owner => owner.chatUpdate(input.chatId, { title: input.title, archived: input.archived }) });
    case "delete": return lifecycle(input.id, () => {
      if (input.confirm !== input.id) throw new Error("Deletion requires confirmation matching project id");
    }, async owner => {
      await owner.pausePlan();
      await closeLifecycleOwner(input.id, owner);
      return withProjectLock(input.id, async () => {
        const project = loadProject(input.id);
        project.archived = true;
        project.deleted = true;
        saveProject(project);
        return { deleted: true, retained: true, paused: true };
      }, true);
    });
    case "archive": return lifecycle(input.id, () => {}, async owner => {
      await owner.pausePlan();
      await closeLifecycleOwner(input.id, owner);
      return withProjectLock(input.id, async () => {
        const project = loadProject(input.id);
        project.archived = true;
        saveProject(project);
        return { archived: true, paused: true };
      }, true);
    });
    case "restore": return lifecycle(input.id, () => {}, async owner => {
      if (!(await owner.planSnapshot()).paused) throw new Error("Project must be paused before restore");
      await closeLifecycleOwner(input.id, owner);
      return withProjectLock(input.id, async () => {
        const project = loadProject(input.id);
        project.archived = false;
        project.deleted = false;
        saveProject(project);
        return { archived: false, paused: true };
      }, true);
    });
    case "plan-snapshot": return withDurableOwner({ id: input.id, operation: owner => owner.planSnapshot() });
    case "work-archive": return withDurableOwner({ id: input.id, operation: owner => owner.archiveWork({ workIds: input.workIds, terminal: input.terminal }) });
    case "event-log": return withDurableOwner({ id: input.id, operation: async owner => {
      const [plan, scheduled, view] = await Promise.all([owner.planSnapshot(), owner.scheduleSnapshot({ includeHistory: true }), owner.snapshot()]);
      const events: Array<{ at: number; kind: string; source: string; id: string | null; detail: string }> = [];
      for (const work of plan.work) {
        if (work.startedAt !== null) events.push({ at: work.startedAt, kind: "work-dispatched", source: "plan", id: work.id, detail: `${work.role}: ${work.text.slice(0, 240)}` });
        if (work.endedAt !== null) events.push({ at: work.endedAt, kind: "work-settled", source: "plan", id: work.id, detail: work.status });
        if (work.status === "failed") events.push({ at: work.endedAt ?? work.startedAt ?? Date.now(), kind: "error", source: "plan", id: work.id, detail: work.blocker ?? "Work failed" });
      }
      for (const event of scheduled.events) events.push({ at: event.createdAtMs, kind: "schedule-fired", source: "schedule", id: event.eventId, detail: event.kind });
      for (const item of scheduled.intents) if (item.status === "uncertain" || item.status === "interrupted") events.push({ at: item.recordedAtMs, kind: item.status === "uncertain" ? "error" : "approval", source: "schedule", id: item.requestId, detail: item.outcome ?? item.status });
      for (const decision of inbox(projectDir(input.id))) if (decision.result) events.push({ at: Date.parse(decision.result.at), kind: "approval", source: "decision", id: decision.id, detail: decision.kind });
      for (const event of hostEvents) events.push({ ...event, source: "host-observed", id: null });
      if (view.coordinator.busy) events.push({ at: Date.now(), kind: "lifecycle", source: "snapshot", id: null, detail: "coordinator-busy" });
      events.sort((a, b) => b.at - a.at);
      const offset = input.offset ?? 0, limit = input.limit ?? 100;
      return { events: events.slice(offset, offset + limit), offset, limit, total: events.length };
    } });
    case "host-health": return withDurableOwner({ id: input.id, operation: async owner => {
      const [plan, view] = await Promise.all([owner.planSnapshot(), owner.snapshot()]);
      const projectJobs = jobs(input.id);
      let leases = 0;
      try { const pid = Number(readFileSync(lock, "utf8").trim()); leases = Number.isSafeInteger(pid) && pid > 0 ? 1 : 0; } catch { leases = 0; }
      return { uptimeMs: Date.now() - hostStartedAt, pid: process.pid, node: process.version, activeLeases: leases, activeLocks: projectLocks.size, queue: { queued: plan.work.filter(work => work.status === "queued").length, running: plan.work.filter(work => work.status === "running").length }, busy: view.coordinator.busy, paused: plan.paused, failedJobs: projectJobs.filter(job => job.state === "failed").length, macAwake: null, macAwakeReason: "No bounded platform-specific awake probe is configured" };
    } });
    case "pause": return lifecycle(input.id, () => {}, async owner => { const result = await owner.pausePlan(); recordHostEvent("lifecycle", `paused:${input.id}`); return { paused: result.paused }; });
    case "resume": return lifecycle(input.id, project => {
      if ("recovery" in input && input.confirm !== input.id) throw new Error("Recovery requires confirmation matching project id");
      if (project.deleted) throw new Error("Deleted project must be restored before resume");
      if (project.archived) throw new Error("Archived project must be restored before resume");
    }, async owner => {
      if ("recovery" in input) await owner.pausePlan();
      else {
        const plan = await owner.planSnapshot();
        if (plan.work.length !== 0 || (await owner.snapshot()).coordinator.submissions.length !== 0) throw new Error("Project resume with prior work requires an explicit recovery decision");
      }
      const paused = (await owner.resumePlan()).paused;
      recordHostEvent("lifecycle", `resumed:${input.id}`);
      return "recovery" in input ? { paused, recovery: input.recovery } : { paused };
    });
    case "owner-setup-snapshot": {
      const project = loadProject(input.id);
      const workspaceRevision = workspaceAuthorizationRevision(project);
      const githubRevision = createHash("sha256").update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []])).digest("hex");
      const grants = project.workerSkillGrants ?? [];
      const grantsRevision = createHash("sha256").update(JSON.stringify(grants)).digest("hex");
      const profileSnapshot = commandProfilesSnapshot(project);
      return { projectId: project.id, workspaceRevision, githubRevision, grantsRevision, profilesRevision: profileSnapshot.revision, workspace: project.workspaceAuthorization ? { version: project.workspaceAuthorization.version, provider: project.workspaceAuthorization.provider, owner: project.workspaceAuthorization.owner, repositories: project.workspaceAuthorization.repositories.map(repository => ({ repositoryId: repository.repositoryId, provider: repository.provider, ownerCheckout: repository.ownerCheckout, approvedRoot: repository.approvedRoot, fileOwnershipPrefix: repository.fileOwnershipPrefix })), scopes: project.workspaceAuthorization.scopes.map(scope => ({ id: scope.id, repositoryId: scope.repositoryId, fileCount: scope.files.length, baseRevision: scope.baseRevision, evidenceCapture: scope.evidenceCapture === true, wholeRepository: scope.wholeRepository === true })) } : null, quickGrant: quickWorkspacePreview(project, workerWorktreeRoot(project.id)), githubQuick: await githubQuickPreview(project), workspaceHistory: (project.workspaceAuthorizationHistory ?? []).map(item => ({ revokedAt: item.revokedAt, repositoryId: item.repositoryId, scopeId: item.scopeId, baseRevision: item.baseRevision, repositorySha256: item.repositorySha256, scopeSha256: item.scopeSha256 })), github: project.githubAuthorization ?? [], githubHistory: (project.githubAuthorizationHistory ?? []).map(item => ({ revokedAt: item.revokedAt, repositoryId: item.authorization.repositoryId, numericId: item.authorization.numericId, branchPrefix: item.authorization.branchPrefix, baseBranch: item.authorization.baseBranch, owner: item.authorization.owner })),  profiles: profileSnapshot.profiles.map(profile => ({ id: profile.id, label: profile.label, repositoryId: profile.repositoryId, scopeIds: profile.scopeIds, effect: profile.effect, enabled: profile.enabled, revision: profile.revision, executionAvailable: profile.executionAvailable, blocker: profile.blocker })), grants: grants.map(grant => ({ id: grant.id, revision: grant.revision, enabled: grant.enabled, scopeIds: grant.scopeIds, skills: grant.skills.map(skill => ({ catalogId: skill.catalogId, name: skill.name })) })), configuredCatalog: { available: true, reason: "Configured Pi skills load automatically for whole-repository workers." } };
    }
    case "github-repository-inspect": {
      const project = loadProject(input.id), revision = workspaceAuthorizationRevision(project);
      const result = await inspectGithubRepository(project, input);
      const current = loadProject(input.id);
      if (current.cwd !== project.cwd || workspaceAuthorizationRevision(current) !== revision) throw new Error("Project workspace changed during repository identity inspection; inspect again");
      return result;
    }
    case "github-authorize": case "github-quick-authorize": {
      if (input.confirm !== input.id) throw new Error("GitHub authorization requires confirmation matching project id");
      const before = loadProject(input.id);
      const revision = createHash("sha256").update(JSON.stringify([before.githubAuthorization ?? [], before.githubAuthorizationHistory ?? []])).digest("hex");
      if (revision !== input.expectedRevision) throw new Error("GitHub authorization changed; refresh before authorizing");
      const authorization = input.action === "github-quick-authorize" ? await authorizeGithubQuick(before, input) : await authorizeGithub(before, input);
      const validate = (project: ReturnType<typeof loadProject>) => {
        const currentRevision = createHash("sha256").update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []])).digest("hex");
        if (currentRevision !== input.expectedRevision || authorizationFingerprint(project) !== authorizationFingerprint(before) || project.archived || project.deleted) throw new Error("Project authorization changed during GitHub authorization");
        const existing = project.githubAuthorization?.find(item => item.repositoryId === authorization.repositoryId);
        if (existing && (existing.numericId !== authorization.numericId || existing.branchPrefix !== authorization.branchPrefix || existing.baseBranch !== authorization.baseBranch || existing.owner !== authorization.owner)) throw new Error("GitHub publication target is immutable");
        if (!existing && (project.githubAuthorization?.length ?? 0) >= 64) throw new Error("GitHub authorization limit reached");
      };
      return lifecycle(input.id, validate, async owner => {
        const view = await owner.snapshot(), plan = await owner.planSnapshot();
        if (view.coordinator.busy || view.coordinator.submissions.some(item => item.status === "queued" || item.status === "placed") || plan.pausing || plan.work.some(item => item.status === "queued" || item.status === "running")) throw new Error("GitHub authorization requires no active project work");
        await closeLifecycleOwner(input.id, owner);
        return withProjectLock(input.id, async () => {
          const project = loadProject(input.id);
          validate(project);
          const entries = project.githubAuthorization ?? [];
          saveProject({ ...project, githubAuthorization: [...entries.filter(item => item.repositoryId !== authorization.repositoryId), authorization] });
          return authorization;
        }, true);
      });
    }
    case "provider-pr-inspect": case "provider-ci-inspect": case "provider-review-inspect": case "provider-ci-detail": case "provider-conflict-inspect": case "provider-ci-job-inspect": {
      const project = loadProject(input.id);
      const revision = authorizationFingerprint(project);
      const result = await githubInspection.inspect(project, input);
      if (authorizationFingerprint(loadProject(input.id)) !== revision) throw new Error("Workspace authorization changed during inspection; inspect again");
      return result;
    }
    case "command-intent-inspect": return (await durable(input.id)).commandIntentInspect(input.key, input.confirm);
    case "command-intents-snapshot": return (await durable(input.id)).commandIntentsSnapshot(input);
    case "github-read-snapshot": return withDurableOwner({ id: input.id, operation: owner => owner.githubReadSnapshot(input) });
    case "github-write-inspect": return (await durable(input.id)).githubWriteInspect(input);
    case "github-write-snapshot": return withDurableOwner({ id: input.id, operation: owner => owner.githubWriteSnapshot(input) });
    case "operation-execute": return (await durable(input.id)).operationExecute(input);
    case "operation-inspect": return (await durable(input.id)).operationInspect(input);
    case "operation-snapshot": return withDurableOwner({ id: input.id, operation: owner => owner.operationSnapshot(input) });
    case "operation-request": case "operation-decide": return withDurableOwner({ id: input.id, validate: project => {
      if (project.deleted || project.archived) throw new Error("Retained project must be restored before recording operation decisions");
      if (input.action === "operation-decide" && input.decision === "approve" && input.confirm !== input.id) throw new Error("Operation approval requires confirmation matching project id");
    }, operation: owner => input.action === "operation-request" ? owner.operationRequest(input) : owner.operationDecide(input) });
    case "github-revoke": {
      if (input.confirm !== input.id) throw new Error("GitHub authorization revocation requires confirmation matching project id");
      return lifecycle(input.id, project => {
        if (project.archived || project.deleted) throw new Error("Restore the project before changing GitHub authorization");
        const revision = createHash("sha256").update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []])).digest("hex");
        if (revision !== input.expectedRevision || !(project.githubAuthorization ?? []).some(item => item.repositoryId === input.repositoryId)) throw new Error("GitHub authorization changed or is unknown; refresh before revoking");
        if ((project.githubAuthorizationHistory ?? []).length >= 64) throw new Error("GitHub authorization history limit reached");
      }, async owner => {
        const view = await owner.snapshot(), plan = await owner.planSnapshot();
        if (view.coordinator.busy || view.coordinator.submissions.some(item => item.status === "queued" || item.status === "placed") || plan.pausing || plan.work.some(item => item.status === "queued" || item.status === "running")) throw new Error("GitHub authorization changes require an idle project");
        await closeLifecycleOwner(input.id, owner);
        return withProjectLock(input.id, async () => {
          const project = loadProject(input.id), currentRevision = createHash("sha256").update(JSON.stringify([project.githubAuthorization ?? [], project.githubAuthorizationHistory ?? []])).digest("hex");
          if (project.archived || project.deleted) throw new Error("Restore the project before changing GitHub authorization");
          if (currentRevision !== input.expectedRevision) throw new Error("GitHub authorization changed before revocation");
          const authorization = (project.githubAuthorization ?? []).find(item => item.repositoryId === input.repositoryId);
          if (!authorization) throw new Error("Unknown active GitHub authorization");
          const history = project.githubAuthorizationHistory ?? [];
          if (history.length >= 64) throw new Error("GitHub authorization history limit reached");
          saveProject({ ...project, githubAuthorization: (project.githubAuthorization ?? []).filter(item => item.repositoryId !== input.repositoryId), githubAuthorizationHistory: [...history, { revokedAt: new Date().toISOString(), authorization }] });
          return { revoked: true, repositoryId: input.repositoryId };
        }, true);
      });
    }
    case "workspace-catalog": return catalog(loadProject(input.id));
    case "workspace-grant": {
      if (input.confirm !== input.id) throw new Error("Workspace grant requires confirmation matching project id");
      const before = loadProject(input.id);
      if (workspaceAuthorizationRevision(before) !== input.expectedRevision) throw new Error("Workspace authorization changed; refresh before granting");
      return persistWorkspaceGrant(before, input.expectedRevision, grantWorkspace({ project: before, repositoryId: input.repositoryId, provider: input.provider, ownerCheckout: input.ownerCheckout, approvedRoot: input.approvedRoot, fileOwnershipPrefix: input.fileOwnershipPrefix, files: input.files, baseRevision: input.baseRevision, evidenceCapture: input.evidenceCapture }));
    }
    case "workspace-quick-grant": {
      if (input.confirm !== input.id) throw new Error("Workspace grant requires confirmation matching project id");
      const before = loadProject(input.id);
      if (workspaceAuthorizationRevision(before) !== input.expectedRevision) throw new Error("Workspace authorization changed; refresh before granting");
      return persistWorkspaceGrant(before, input.expectedRevision, grantWholeRepository(before, workerWorktreeRoot(input.id)));
    }
    case "workspace-revoke": {
      if (input.confirm !== input.id) throw new Error("Workspace revocation requires confirmation matching project id");
      const before = loadProject(input.id);
      const persist = () => withProjectLock(input.id, async () => {
        const project = loadProject(input.id), auth = project.workspaceAuthorization;
        if (project.archived || project.deleted) throw new Error("Restore the project before changing workspace authorization");
        if (workspaceAuthorizationRevision(project) !== input.expectedRevision || !auth) throw new Error("Workspace authorization changed before revocation");
        const scope = auth.scopes.find(item => item.id === input.scopeId);
        if (!scope) throw new Error("Unknown active workspace scope");
        const repository = auth.repositories.find(item => item.repositoryId === scope.repositoryId);
        if (!repository) throw new Error("Workspace scope has no retained repository binding");
        const history = project.workspaceAuthorizationHistory ?? [];
        if (history.length >= 2048) throw new Error("Workspace authorization history limit reached");
        const scopes = auth.scopes.filter(item => item.id !== scope.id), repositories = auth.repositories.filter(item => scopes.some(remaining => remaining.repositoryId === item.repositoryId));
        const historyEntry = { revokedAt: new Date().toISOString(), repositoryId: repository.repositoryId, repositorySha256: workspaceRepositoryFingerprint(repository), scopeId: scope.id, scopeSha256: createHash("sha256").update(JSON.stringify(scope)).digest("hex"), baseRevision: scope.baseRevision };
        saveProject(rebindOneClickGithub({ ...project, workspaceAuthorization: scopes.length ? { ...auth, scopes, repositories } : undefined, workspaceAuthorizationHistory: [...history, historyEntry] }));
        return { revoked: true, scopeId: input.scopeId, repositoryId: scope.repositoryId };
      }, before.runtime === "durable");
      if (before.runtime !== "durable") return persist();
      return lifecycle(input.id, project => {
        if (project.archived || project.deleted) throw new Error("Restore the project before changing workspace authorization");
        if (workspaceAuthorizationRevision(project) !== input.expectedRevision || !project.workspaceAuthorization?.scopes.some(scope => scope.id === input.scopeId)) throw new Error("Workspace scope changed or is unknown; refresh before revoking");
        if ((project.workspaceAuthorizationHistory ?? []).length >= 2048) throw new Error("Workspace authorization history limit reached");
      }, async owner => {
        const current = await owner.snapshot(), plan = await owner.planSnapshot();
        if (current.coordinator.busy || current.coordinator.submissions.some(item => item.status === "queued" || item.status === "placed") || plan.pausing || plan.work.some(work => work.status === "queued" || work.status === "running")) throw new Error("Workspace changes require an idle project");
        await closeLifecycleOwner(input.id, owner);
        return persist();
      });
    }
    case "schedule-create": return withDurableOwner({ id: input.id, operation: owner => owner.scheduleCreate({ id: input.scheduleId, atMs: input.atMs, text: input.text, everyMs: input.everyMs, calendar: input.calendar }) });
    case "schedule-enable": return withDurableOwner({ id: input.id, operation: owner => owner.scheduleSetEnabled(input.scheduleId, input.enabled) });
    case "schedule-snapshot": return (await durable(input.id)).scheduleSnapshot({ includeHistory: input.includeHistory });
    case "schedule-history": return (await durable(input.id)).scheduleHistory(input.kind, { offset: input.offset, limit: input.limit, textOffset: input.textOffset, textLimit: input.textLimit });
    case "monitor-create": return withDurableOwner({ id: input.id, validate: project => {
      if (project.deleted || project.archived) throw new Error("Inactive project cannot monitor providers");
    }, operation: owner => owner.monitorCreate({ id: input.monitorId, repositoryId: input.repositoryId, expectedRepositoryId: input.expectedRepositoryId, pullRequest: input.pullRequest, kind: input.kind, everyMs: input.everyMs }) });
    case "monitor-enable": return withDurableOwner({ id: input.id, operation: owner => owner.monitorSetEnabled(input.monitorId, input.enabled) });
    case "monitor-snapshot": return (await durable(input.id)).monitorSnapshot();
    case "event-opt-in": return withDurableOwner({ id: input.id, operation: owner => owner.scheduleSetEventOptIn(input.enabled) });
    case "automation-snapshot": return automationSnapshot(input.id);
    case "automation-update": {
      const project = loadProject(input.id);
      if (project.deleted || project.archived || project.runtime !== "durable") throw new Error("Automations need an active Durable project");
      const owner = await durable(input.id), before = loadAutomations(input.id);
      if (input.change.eventChat && input.change.eventChat !== "main") { const chat = (await owner.chats()).find(item => item.id === input.change.eventChat); if (!chat || chat.archived) throw new Error("Choose an existing, active chat for events"); }
      const next = await withProjectLock(input.id, async () => updateAutomations(input.id, input.change));
      if (next.follow.enabled && (!before.follow.enabled || next.follow.everyMs !== before.follow.everyMs || next.autoMerge.enabled !== before.autoMerge.enabled)) owner.followKick();
      recordHostEvent("automations", `${input.id}:follow=${next.follow.enabled}:webhook=${next.webhook.enabled}:autoMerge=${next.autoMerge.enabled}`);
      return automationSnapshot(input.id);
    }
    case "webhook-rotate": {
      if (input.confirm !== input.id) throw new Error("Rotating the webhook secret requires confirmation matching project id");
      await withProjectLock(input.id, async () => rotateWebhookSecret(input.id));
      recordHostEvent("automations", `${input.id}:webhook-rotated`);
      return automationSnapshot(input.id);
    }
    case "follow-poll": { const result = await (await durable(input.id)).followPoll(); return { result, ...(await automationSnapshot(input.id)) }; }
    case "event-ingest": return withDurableOwner({ id: input.id, operation: owner => owner.ingestLocalEvent({ eventId: input.eventId, kind: input.kind, payload: input.payload }) });
    case "thread-steer": {
      const project = loadProject(input.id);
      if (project.deleted || project.archived) throw new Error("Inactive project cannot control worker threads");
      return (await durable(input.id)).steerThread(input.threadId, input.text, { requestId: input.requestId });
    }
    case "thread-stop": {
      const project = loadProject(input.id);
      if (project.deleted || project.archived) throw new Error("Inactive project cannot control worker threads");
      await (await durable(input.id)).stop(input.threadId);
      return { stopped: true, threadId: input.threadId };
    }
    case "legacy-thread-history": return (await durable(input.id)).legacyThreadHistory(input.name, input);
    case "thread-history": return (await durable(input.id)).threadHistory(input.threadId, input);
    case "thread-send": return withDurableOwner({ id: input.id, validate: project => {
      if (project.deleted) throw new Error("Project is deleted; admission is denied");
      if (project.archived) throw new Error("Project is archived; admission is denied");
    }, operation: async owner => {
      const plan = await owner.planSnapshot();
      if (plan.paused || plan.pausing) throw new Error("Project plan is paused; admission is denied");
      return owner.followUp(input.threadId, input.text, { requestId: input.requestId });
    } });
    case "message": {
      const prepareJob = () => {
        const project = loadProject(input.id);
        if (project.deleted) throw new Error("Project is deleted; admission is denied");
        if (project.archived) throw new Error("Project is archived; admission is denied");
        for (const upload of input.attachments ?? []) uploadRecord(ownedProjectDir(input.id), upload);
        return { id: input.requestId ?? randomUUID(), text: input.text, at: new Date().toISOString(), state: "queued", error: null, ...(input.chatId && input.chatId !== "main" ? { chatId: input.chatId } : {}), ...(input.attachments ? { attachments: input.attachments } : {}) } satisfies import("./state.ts").Job;
      };
      if (input.attachments && loadProject(input.id).runtime !== "durable") throw new Error("Attachments need a Durable project");
      if (loadProject(input.id).runtime === "durable") return withDurableOwner({ id: input.id, validate: project => {
        if (project.deleted) throw new Error("Project is deleted; admission is denied");
        if (project.archived) throw new Error("Project is archived; admission is denied");
      }, operation: async owner => {
        // A repeated request ID (Telegram update replay) returns the job it already admitted.
        const prior = input.requestId ? jobs(input.id).find(job => job.id === input.requestId) : undefined;
        if (prior) return prior;
        const job = prepareJob();
        // The job keeps what the owner typed; the coordinator receives the expanded skill.
        const text = await expandSkillCommand(await configuredSkills(input.id), job.text);
        const invoked = SKILL_COMMAND.exec(job.text.trim())?.[1];
        if (invoked) recordInvokedSkill(ownedProjectDir(input.id), invoked);
        const plan = await owner.planSnapshot();
        if (plan.paused || plan.pausing) throw new Error("Project plan is paused; admission is denied");
        // Validate the chat before recording the job, so an unknown or archived chat leaves no ledger entry.
        const chat = (await owner.chats()).find(item => item.id === (input.chatId ?? "main"));
        if (!chat) throw new Error("Unknown chat for this project");
        if (chat.archived) throw new Error("Chat is archived; restore it before sending");
        saveJob(input.id, job);
        await owner.admit(attachmentContent(ownedProjectDir(input.id), text, job.attachments, owner.acceptsImages), { requestId: job.id, chatId: input.chatId, title: job.text });
        return job;
      } });
      ownedProjectDir(input.id);
      const before = loadProject(input.id);
      if (before.deleted) throw new Error("Project is deleted; admission is denied");
      if (before.archived) throw new Error("Project is archived; admission is denied");
      const opening = runtime(input.id);
      const owner = await opening;
      return withProjectLock(input.id, async () => {
        ownedProjectDir(input.id);
        if (loadProject(input.id).runtime === "durable" || runtimes.get(input.id) !== opening) throw new Error("Legacy project owner changed; no message admitted");
        const job = prepareJob();
        saveJob(input.id, job); owner.pump();
        return job;
      });
    }
    case "work-submit": {
      const validate = () => {
        ownedProjectDir(input.id);
        const project = loadProject(input.id);
        if (project.runtime !== "durable") throw new Error("Scoped submission requires a Durable project; legacy delegation is separate");
        if (project.deleted || project.archived) throw new Error("Inactive project cannot admit scoped worker work");
        if (!project.workspaceAuthorization?.scopes.some(scope => scope.id === input.workspaceScopeId)) throw new Error("Scoped submission requires an existing owner-authorized workspace scope");
      };
      validate();
      return withDurableOwner({ id: input.id, validate, operation: owner => owner.plan({ work: [{ id: input.requestId, requestId: input.requestId, threadId: input.threadId, role: "worker", text: input.text, workspaceScopeId: input.workspaceScopeId }] }) });
    }
    case "delegate": return (await runtime(input.id)).delegate(input.role, input.task);
    case "workers": {
      const owner = await runtime(input.id);
      return owner.inspect(input.run);
    }
    case "control": {
      const owner = await runtime(input.id);
      owner.ownRun(input.run);
      if (input.operation === "steer" && !input.message?.trim()) throw new Error("Steering requires a message");
      return owner.rpc(input.operation, { id: input.run, ...(input.message ? { message: input.message } : {}) });
    }
    case "notes": loadProject(input.id); return notes(projectDir(input.id));
    case "knowledge-list": return listKnowledge(await knowledgeDir(input.id));
    case "knowledge-read": return readKnowledge(await knowledgeDir(input.id), input.path);
    case "knowledge-write": return writeKnowledge({ dir: await knowledgeDir(input.id), path: input.path, text: input.text, expectedRevision: input.expectedRevision, author: "owner" });
    case "knowledge-history": return historyKnowledge(await knowledgeDir(input.id), input.path);
    case "notify-feed": return notifier.feed(input.after);
    case "telegram-snapshot": return telegram.snapshot();
    case "telegram-token": { const snapshot = await telegram.setToken(input.token); recordHostEvent("telegram", `bot set: @${snapshot.botUsername}`); return snapshot; }
    case "telegram-pair": recordHostEvent("telegram", "pairing code issued"); return telegram.pair();
    case "telegram-unpair": recordHostEvent("telegram", "unpaired"); return telegram.unpair();
    case "telegram-remove": recordHostEvent("telegram", "bot removed"); return telegram.remove();
    case "shutdown": closing = true; setTimeout(() => { void shutdown(); }, 50); return { stopping: true };
    default: { const exhaustive: never = input; throw new Error(String(exhaustive)); }
  }
}

const web = await startWeb(dispatch, async (id, onFrame, onEnd, chatId) => (await durable(id)).watchLive(onFrame, onEnd, chatId), (id, filename, bytes) => withProjectLock(id, async () => {
  const project = loadProject(id);
  if (project.deleted || project.archived) throw new Error("Inactive project cannot take uploads");
  return saveUpload(ownedProjectDir(id), { filename, bytes });
}));
const webhooks = await startWebhooks(async (id, event) => {
  if (closing) throw new Error("Host is stopping");
  const result = await (await durable(id)).ingestAutomationEvent(event);
  return { status: result.status, ...(result.duplicate ? { duplicate: true as const } : {}) };
});
// Notices for the browser and Telegram come from open Durable owners only; a project in a lifecycle or settings transition is skipped for that scan.
const notifier = startNotifier({
  owner: project => closing || lifecycleChanging.has(project.id) || settingsUpdating.has(project.id) || ownerCloseFailed.has(project.id) ? null : durableRuntimes.get(project.id) ?? null,
  tickMs: Number(process.env.PI_PROJECTS_NOTIFY_TICK_MS ?? 3000), onNotice: () => { void telegram?.flush(); }, report: detail => recordHostEvent("notify", detail),
});
const telegram = startTelegram({ dispatch: input => dispatch(parse(Request, input)), chats: async id => (await durable(id)).chats(), notifier, report: detail => recordHostEvent("telegram", detail) });
void telegram.flush();
async function automationSnapshot(id: string) {
  const project = loadProject(id), config = loadAutomations(id);
  return { eventChat: config.eventChat, webhook: { enabled: config.webhook.enabled, url: webhooks.url(project.id), secret: config.webhook.secret }, follow: project.runtime === "durable" && !project.deleted && !project.archived ? await (await durable(id)).followSnapshot() : null, githubRepositories: (project.githubAuthorization ?? []).map(item => item.repositoryId) };
}
const server = createServer(async (request, response) => {
  try {
    if (closing) throw new Error("Host is stopping");
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data: { pid: process.pid, home: home() } }));
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
server.listen(socketPath(), () => {
  if (closing) return;
  chmodSync(socketPath(), 0o600);
  process.stderr.write(JSON.stringify({ event: "projects-host-started", pid: process.pid, socket: socketPath() }) + "\n");
  for (const project of listProjects().filter(p => !p.deleted && !p.archived && (p.runtime === "durable" || p.sessionFile))) {
    const restore = project.runtime === "durable" ? durable(project.id) : runtime(project.id).then(owner => { if (!closing) owner.pump(); });
    void restore.catch(error => process.stderr.write(JSON.stringify({ event: "restore-failed", project: project.id, error: errorText(error) }) + "\n"));
  }
});
server.on("error", error => { process.stderr.write(errorText(error) + "\n"); void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

function shutdown(): Promise<void> {
  if (shutdownOperation) return shutdownOperation;
  closing = true;
  shutdownOperation = Promise.resolve().then(async () => {
    let failed = ownerCloseFailed.size !== 0;
    const report = (error: unknown) => { failed = true; process.stderr.write(errorText(error) + "\n"); };
    try { web.close(); } catch (error) { report(error); }
    try { webhooks.close(); } catch (error) { report(error); }
    try { telegram.close(); await notifier.close(); } catch (error) { report(error); }
    try { server.close(); } catch (error) { report(error); }
    try { await githubInspection.close(); } catch (error) { report(error); }
    for (const pending of durableRuntimes.values()) {
      try { await (await pending).close(); }
      catch (error) { report(error); }
    }
    for (const pending of runtimes.values()) {
      let owner: Runtime | undefined;
      try {
        owner = await pending;
        try { await owner.session.abort(); } catch (error) { report(error); }
        try { await owner.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch (error) { report(error); }
      } catch (error) { report(error); }
      finally { try { owner?.session.dispose(); } catch (error) { report(error); } }
    }
    await Promise.allSettled([...activeRequests]);
    try { if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); }
    catch (error) { report(error); }
    process.exit(failed ? 1 : 0);
  });
  return shutdownOperation;
}

