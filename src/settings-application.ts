import type { DurableProjectRuntime } from "./durable-runtime.ts";
import { applyCommandProfile, commandProfilesSnapshot, prepareCommandProfile } from "./command-profiles.ts";
import { projectSettings, updateProjectSettings } from "./project-settings.ts";
import { validateProjectModelChanges } from "./project-models.ts";
import { validateProfileChanges } from "./host-documents.ts";
import type { Project, Request } from "./state.ts";

type Update = Extract<Request, { action: "settings-update" }>;
type CommandProfileUpdate = Extract<Request, { action: "command-profile-set" }>;
type Changes = Update["changes"];

/**
 * How a changed field reaches a running owner. Every settings field applies without closing the owner:
 * - saved: read from the saved project at the moment it is used (a tool call, a delegation, a stall check), so saving is enough;
 * - models / context: pushed into the owner's live model and context state;
 * - prompts: coordinator chats are rebuilt from the saved project (busy chats before their next message); workers read it at delegation;
 * - profiles: both, since a profile carries a model (its tier), the coordinator's thinking level and its tool list.
 */
type Effect = "saved" | "models" | "context" | "prompts" | "profiles";
const EFFECTS: Partial<Record<keyof Changes, Effect>> = {
  name: "prompts",
  objective: "prompts",
  prompts: "prompts",
  skills: "prompts",
  knowledgeAccess: "prompts",
  libraryAccess: "prompts",
  decisionAccess: "prompts",
  githubCli: "prompts",
  model: "models",
  models: "models",
  fallbackModels: "models",
  profiles: "profiles",
  context: "context",
  mcp: "saved",
  verification: "saved",
  stallMinutes: "saved",
  scopedModels: "saved",
  worktreeSetup: "saved",
};
const touches = (changes: Changes, effect: Effect) => Object.keys(changes).some((key) => EFFECTS[key as keyof Changes] === effect);

const REOPEN_POLL_MS = 2000;

export type SettingsDeps = {
  load(id: string): Project;
  save(project: Project): void;
  /** Runs under the project's lock so the settings and the owner never disagree about who changes them. */
  lock<T>(id: string, operation: () => Promise<T>): Promise<T>;
  /** The owner if this project's runtime is open. */
  running(id: string): Promise<DurableProjectRuntime> | undefined;
  /** Turning verification on needs an installed skill. */
  skillInstalled(id: string, skill: string): Promise<boolean>;
  /** Closes the owner when nothing is running and opens it again; false while work is running. */
  reopenIfIdle(id: string): Promise<boolean>;
  closing(): boolean;
};

/** The one place that decides whether a settings change applies live or needs the owner reopened. */
export function settingsApplication(deps: SettingsDeps) {
  const pending = new Set<string>();
  const view = (project: Project) => ({ ...projectSettings(project), pendingReopen: pending.has(project.id) });

  // A reopen interrupts running work, so it waits for the project to have none.
  function reopenWhenIdle(id: string): void {
    if (pending.has(id)) return;
    pending.add(id);
    const attempt = async (): Promise<void> => {
      try {
        if (deps.closing() || (await deps.reopenIfIdle(id))) return void pending.delete(id);
      } catch {
        return void pending.delete(id);
      }
      setTimeout(() => void attempt(), REOPEN_POLL_MS).unref();
    };
    void attempt();
  }

  return {
    snapshot: (id: string) => view(deps.load(id)),
    async update(input: Update) {
      updateProjectSettings(deps.load(input.id), input);
      await validateProjectModelChanges(input.changes);
      await validateProfileChanges(input.changes.profiles);
      const skill = input.changes.verification?.enabled ? input.changes.verification.skill.trim() : "";
      if (skill && !(await deps.skillInstalled(input.id, skill)))
        throw new Error(`Verification skill "${skill}" is not installed for this project`);
      return deps.lock(input.id, async () => {
        const project = updateProjectSettings(deps.load(input.id), input);
        const owner = await deps.running(input.id);
        // Models are checked against the live catalog before anything is saved; a refusal leaves the settings untouched.
        if (owner && (touches(input.changes, "models") || touches(input.changes, "profiles"))) await owner.applyModels(project);
        if (owner && input.changes.context !== undefined) owner.applyContext(project.contextSettings);
        deps.save(project);
        if (owner && (touches(input.changes, "prompts") || touches(input.changes, "profiles"))) await owner.applySettings();
        return view(project);
      });
    },
    /** A command profile is bound into workspaces when the owner opens: saved now, bound after the project has no running work. Execution rechecks the saved profile, so a revocation is immediate. */
    async setCommandProfile(input: CommandProfileUpdate) {
      const profile = await prepareCommandProfile(deps.load(input.id), input);
      return deps.lock(input.id, async () => {
        const project = applyCommandProfile(deps.load(input.id), input, profile);
        deps.save(project);
        if (await deps.running(input.id)) reopenWhenIdle(input.id);
        return { ...commandProfilesSnapshot(project), pendingReopen: pending.has(input.id) };
      });
    },
  };
}
