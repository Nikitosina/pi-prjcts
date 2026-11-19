import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as chord from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import type { Conversation, Tx } from "@earendil-works/pi-durable";
import * as typebox from "typebox";
import * as value from "typebox/value";
import { githubPrProvider } from "./github-prs.ts";
import { createPluginGate, disabledMessage } from "./plugin-gate.ts";
import { clip, createListCache, RateLimitedError } from "./pr-cache.ts";
import type {
  CoordinatorToolsProvider,
  FollowProvider,
  MergeProvider,
  HostPluginApi,
  PluginCapabilities,
  PluginModule,
  PluginRoute,
  PluginRpcHandler,
  PluginRpcKind,
  PluginStatus,
  PrProvider,
  VcsProvider,
  WebContribution,
  WorkerToolsProvider,
  WorkspaceProvider,
} from "./plugin-types.ts";
import { usePluginPromptBlocks } from "./prompt-blocks.ts";
import { hostLeases } from "./resource-leases.ts";
import { webFile, type WebFile } from "./web-file.ts";
import { home, listProjects, loadProject, projectDir, workerWorktreeRoot, type Project } from "./state.ts";
import { verifiedWorkspaceRoots } from "./workspace-roots.ts";
import { runCli, findVcsRoot } from "./vcs.ts";
import {
  authorizationFingerprint,
  trustedOwner,
  WHOLE_REPOSITORY_PREFIX,
  workspaceRepositoryFingerprint,
} from "./workspace-authorization.ts";
import { command } from "./workspace-isolation.ts";

/*
 * Plugin loader and registry. Bundled built-in plugins (BUNDLED) load first with source "built-in". Configured sources, in order: `plugins.json` in the host home (primary, persistent: `{ "plugins": ["/abs/path/to/plugin", ...] }`)
 * and the environment variable PI_PROJECTS_PLUGINS (":"-separated paths, additive; used by tests and one-off runs).
 * A path is a module file or a directory with index.ts / index.mjs / index.js (or a package.json "main"). Relative paths resolve against the host home.
 * A plugin that fails to import, has the wrong shape, throws in register, conflicts with another plugin or times out is recorded
 * (status(), the `plugins` RPC, the UI) and contributes nothing; the host keeps running.
 */
/** `web` holds the declared browser files as they were at load, so a later change on disk waits for the restart like the plugin's code. */
type Loaded = { plugin: string; builtIn?: true; capabilities: PluginCapabilities; web?: { "ui.js"?: WebFile; "ui.css"?: WebFile } };
const loaded: Loaded[] = [];
const statuses: PluginStatus[] = [];
/** The loader's result per resolved plugin directory, as the running host started: what a later change to the configuration does not touch. */
const attempts = new Map<string, PluginStatus>();
let loading: Promise<PluginStatus[]> | undefined;

/** Status source of a built-in plugin. */
export const BUILT_IN = "built-in";
/** Bundled plugins core loads first on every host, without configuration; their names are reserved, so a configured copy is refused. */
const BUNDLED = [{ name: "github", path: fileURLToPath(new URL("../plugins/github/index.ts", import.meta.url)) }];
/** Capabilities core still implements for a built-in identity; they join the bundled plugin's own when it loads, and stay without it. Lazy: the provider modules import this one. */
const coreCapabilities = (name: string): PluginCapabilities => (name === "github" ? { prs: githubPrProvider } : {});
const builtins = (): Loaded[] =>
  BUNDLED.filter((item) => !loaded.some((other) => other.plugin === item.name)).map((item) => ({
    plugin: item.name,
    builtIn: true,
    capabilities: coreCapabilities(item.name),
  }));
const each = <T>(pick: (capabilities: PluginCapabilities) => T | undefined): T[] =>
  [...builtins(), ...loaded].flatMap((item) => {
    const value = pick(item.capabilities);
    return value === undefined ? [] : [value];
  });
// Plugin rules for the coordinator are editable integration blocks, resolved with the project's other prompt blocks.
usePluginPromptBlocks(() =>
  [...builtins(), ...loaded].flatMap((item) => {
    const tools = item.capabilities.coordinatorTools,
      prompt = tools?.prompt;
    if (!tools || !prompt) return [];
    const plugin = item.plugin;
    return [
      {
        id: `plugin:${item.plugin}`,
        name: prompt.name,
        text: prompt.text,
        grant: {
          label: prompt.name,
          on: (project: Project) => !disabledIn(project, plugin) && tools.applies(project) && (prompt.on?.(project) ?? true),
        },
      },
    ];
  }),
);
const disabledIn = (project: Pick<Project, "disabledPlugins">, plugin: string) => project.disabledPlugins?.includes(plugin) ?? false;
const release = (resume: (() => void) | undefined) => {
  try {
    resume?.();
  } catch {
    /* resuming never blocks the host */
  }
};
/** Lifecycle pauses taken by a disable: held while the plugin is off, released by the enable. */
const heldPauses = new Map<string, () => void>();
/** Every entry of a plugin into a project runs through this gate: a plugin the project turned off refuses, and work in flight is counted. */
// A project whose stored state cannot be read is not one that has the plugin on: the gate fails closed.
const gate = createPluginGate((projectId, plugin) => {
  try {
    return disabledIn(loadProject(projectId), plugin);
  } catch {
    return true;
  }
});
const loadedName = (name: string) => loaded.some((item) => item.plugin === name) || builtins().some((item) => item.plugin === name);

/** What the project's folder really is (no grant needed), or null when it is not a checkout. */
function checkoutKind(project: Project): string | null {
  try {
    return project.cwd && existsSync(project.cwd) ? (findVcsRoot(project.cwd, project)?.kind ?? null) : null;
  } catch {
    return null;
  }
}

/** Why the project cannot turn the plugin off whatever else happens, or null. Looks at the real checkout, so it holds before a grant and after one is revoked. */
function requiredBy(project: Project, name: string, checkout: () => string | null = () => checkoutKind(project)): string | null {
  const item = [...builtins(), ...loaded].find((entry) => entry.plugin === name);
  if (!item) return null;
  const claims = [item.capabilities.workspace?.id, item.capabilities.vcs?.kind, item.capabilities.merge?.kind];
  const provider = project.workspaceAuthorization?.provider;
  if (provider && (provider === name || claims.includes(provider)))
    return "required by this project's checkout (its workspace grant uses this plugin)";
  const kind = checkout();
  if (kind && (claims.includes(kind) || (kind === "git" && name === "github")))
    return `required by this project's checkout (its folder is a ${kind} checkout this plugin serves)`;
  if (name === "github" && project.githubAuthorization?.length) return "required by this project's GitHub authorizations";
  return null;
}

/** Takes the held pauses of a project's disabled plugins again after a lifecycle transition resumed the plugins' hooks. */
function keepHeld(projectId: string) {
  for (const [held, resume] of [...heldPauses]) {
    const [id, name] = held.split("\0");
    if (id !== projectId) continue;
    release(resume);
    heldPauses.delete(held);
    try {
      const paused = [...builtins(), ...loaded].find((entry) => entry.plugin === name)?.capabilities.lifecycle?.pause?.(projectId);
      if (paused) heldPauses.set(held, paused);
    } catch {
      /* the stored flag already refuses every entry of the plugin */
    }
  }
}

/** Takes the plugin's lifecycle pause for a disable; a plugin whose pause refuses blocks the disable. */
function pauseOf(project: Project, name: string): (() => void) | undefined {
  const lifecycle = [...builtins(), ...loaded].find((entry) => entry.plugin === name)?.capabilities.lifecycle;
  try {
    return lifecycle?.pause?.(project.id);
  } catch (error) {
    throw new Error(`Cannot disable "${name}": it has active work in this project (${message(error)})`);
  }
}

/** A copy of `provider` whose listed methods run through the project gate; everything else (and `this`) stays the provider's own. */
const guards = new WeakMap<object, Map<string, object>>();
/** One stable guarded copy per provider, plugin and capability: callers that compare providers across calls keep working, and one object serving two capabilities gets a wrapper for each. */
function guarded<T extends object>(plugin: string, capability: string, provider: T, overrides: Partial<T>): T {
  const key = `${plugin}\0${capability}`;
  const made = guards.get(provider)?.get(key);
  if (made) return made as T;
  const fresh = Object.assign(Object.create(provider) as T, overrides);
  guards.set(provider, (guards.get(provider) ?? new Map()).set(key, fresh));
  return fresh;
}

export const plugins = {
  gate,
  /** One row per plugin for a project: whether it is on, and why it cannot be turned off now (null when it can). */
  forProject: (project: Project): Array<PluginStatus & { enabled: boolean; lock: string | null }> => {
    let kind: string | null | undefined;
    const checkout = () => (kind === undefined ? (kind = checkoutKind(project)) : kind);
    return statuses.map((status) => {
      const name = status.name;
      const enabled = !(name && disabledIn(project, name));
      const busy = name ? gate.active(project.id, name) : 0;
      const lock =
        name && status.state === "loaded" ? (requiredBy(project, name, checkout) ?? (busy ? `active work (${busy} running)` : null)) : null;
      return { ...status, enabled, lock };
    });
  },
  /** Why the plugin cannot be turned off in this project right now (needed by its checkout, or work in flight), or null. Read-only, so it can run before a lock. */
  disableBlock: (project: Project, name: string): string | null => {
    const required = requiredBy(project, name);
    if (required) return `Cannot disable "${name}": ${required}`;
    const busy = gate.active(project.id, name);
    return busy ? `Cannot disable "${name}": it has active work in this project (${busy} running). Try again when it finishes.` : null;
  },
  /**
   * Why the plugin cannot be turned off while it reports a write with an unknown outcome, or null when it reports none. Fails closed:
   * a check that throws, does not answer in time or answers anything but a boolean refuses the disable.
   */
  unresolvedWrites: async (name: string, root: Conversation): Promise<string | null> => {
    const check = [...builtins(), ...loaded].find((entry) => entry.plugin === name)?.capabilities.uncertainWrites;
    if (!check) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const unknown: unknown = await Promise.race([
        root.commit((tx) => check(tx, root.id), chord.BACKGROUND_CONTEXT),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the check timed out")), timeoutMs());
        }),
      ]);
      if (unknown === false) return null;
      if (unknown === true)
        return `Cannot disable "${name}": it has a write with an unknown outcome in this project. Resolve it first, then turn the plugin off.`;
      throw new Error("the check did not answer yes or no");
    } catch (error) {
      return `Cannot disable "${name}": its unresolved writes could not be checked (${message(error)}). Try again.`;
    } finally {
      clearTimeout(timer);
    }
  },
  /** Why the plugin cannot be turned off while it holds an unresolved write outside the Durable store (its lifecycle `unresolved` hook), or null. Fails closed. */
  unresolvedOutside: (projectId: string, name: string): string | null => {
    const hook = [...builtins(), ...loaded].find((entry) => entry.plugin === name)?.capabilities.lifecycle?.unresolved;
    if (!hook) return null;
    try {
      const reason = hook(projectId);
      if (reason === null) return null;
      if (typeof reason === "string" && reason)
        return `Cannot disable "${name}": it has a write with an unknown outcome in this project (${reason}).`;
      throw new Error("the check did not answer with a reason or null");
    } catch (error) {
      return `Cannot disable "${name}": its unresolved writes could not be checked (${message(error)}). Try again.`;
    }
  },
  /**
   * Turns the plugin off once its unresolved writes are known to be none. The lifecycle pause is taken first, so the plugin's own
   * background work cannot finish a write after the check; work that begins during the check (the gate's started count) refuses
   * the disable. Any refusal releases the pause and leaves the plugin on.
   */
  disable: async (read: () => Project, name: string, root: Conversation, save: (next: Project) => void): Promise<Project> => {
    if (!loadedName(name)) throw new Error(`Plugin "${name}" is not loaded`);
    const project = read();
    if (project.disabledPlugins?.includes(name)) return project;
    const blocked = plugins.disableBlock(project, name);
    if (blocked) throw new Error(blocked);
    const before = gate.started(project.id, name);
    const paused = pauseOf(project, name);
    let latest: Project;
    try {
      const unresolved = (await plugins.unresolvedWrites(name, root)) ?? plugins.unresolvedOutside(project.id, name);
      if (unresolved) throw new Error(unresolved);
      if (gate.started(project.id, name) !== before)
        throw new Error(`Cannot disable "${name}": work began while its writes were being checked. Try again.`);
      // Read again: the project may have been saved (outside the project lock) while the writes were being checked.
      latest = read();
    } catch (error) {
      release(paused);
      throw error;
    }
    return plugins.setEnabled(latest, name, false, save, paused);
  },
  /**
   * The project with the plugin turned on or off. Synchronous on purpose: the caller saves the result in the same tick, so no call
   * can begin between the work check and the stored flag. Refuses a plugin with active work or one the checkout needs.
   * `paused` is a lifecycle pause already taken for this disable; setEnabled owns it from here and releases it on every refusal.
   */
  setEnabled: (project: Project, name: string, enabled: boolean, save: (next: Project) => void, paused?: () => void): Project => {
    if (!loadedName(name)) throw new Error(`Plugin "${name}" is not loaded`);
    const off = new Set(project.disabledPlugins ?? []);
    if (enabled === !off.has(name)) {
      release(paused);
      return project;
    }
    const held = `${project.id}\0${name}`;
    if (enabled) off.delete(name);
    else {
      try {
        const blocked = plugins.disableBlock(project, name);
        if (blocked) throw new Error(blocked);
        paused ??= pauseOf(project, name);
      } catch (error) {
        release(paused);
        throw error;
      }
      off.add(name);
    }
    const { disabledPlugins: _, ...rest } = project;
    const next = off.size ? { ...rest, disabledPlugins: [...off].sort() } : rest;
    // The pause is kept only once the flag is stored: a failed save leaves the plugin as it was, running.
    try {
      save(next);
    } catch (error) {
      release(paused);
      throw error;
    }
    if (paused) heldPauses.set(held, paused);
    else if (enabled) {
      release(heldPauses.get(held));
      heldPauses.delete(held);
    }
    return next;
  },
  /** With a project, only providers of plugins it has on: a plugin it turned off is never asked about its folder. */
  vcsProviders: (project?: Pick<Project, "disabledPlugins">): VcsProvider[] =>
    [...builtins(), ...loaded].flatMap((item) =>
      item.capabilities.vcs && !(project && disabledIn(project, item.plugin)) ? [item.capabilities.vcs] : [],
    ),
  vcsProvider: (kind: string): VcsProvider | undefined => each((caps) => caps.vcs).find((item) => item.kind === kind),
  workspaceProviders: (): WorkspaceProvider[] => plugins.workspaceSources(),
  workspaceProvider: (id: string): WorkspaceProvider | undefined => plugins.workspaceSources().find((item) => item.id === id),
  /** Workspace providers: a project that turned the plugin off is offered no setup of it (a grant that uses it locks the plugin on). */
  workspaceSources: (): WorkspaceProvider[] =>
    [...builtins(), ...loaded].flatMap((item) => {
      const provider = item.capabilities.workspace;
      if (!provider) return [];
      return [
        guarded(item.plugin, "workspace", provider, {
          quickPreview: (project, walkedRoot) =>
            disabledIn(project, item.plugin)
              ? { available: false, blocker: disabledMessage(item.plugin) }
              : provider.quickPreview(project, walkedRoot),
          setupCards: provider.setupCards
            ? (project) => (disabledIn(project, item.plugin) ? [] : provider.setupCards!(project))
            : undefined,
          rebind: provider.rebind ? (project) => (disabledIn(project, item.plugin) ? project : provider.rebind!(project)) : undefined,
        }),
      ];
    }),
  prProviders: (): PrProvider[] =>
    [...builtins(), ...loaded].flatMap((item) => {
      const provider = item.capabilities.prs,
        plugin = item.plugin;
      if (!provider) return [];
      const run = <R>(project: Project, work: () => Promise<R>) => gate.run(project.id, plugin, work);
      return [
        guarded(item.plugin, "prs", provider, {
          applies: (project) => !disabledIn(project, plugin) && provider.applies(project),
          list: (project, options) => run(project, () => provider.list(project, options)),
          touching: provider.touching ? (project) => run(project, () => provider.touching!(project)) : undefined,
          detail: (project, id) => run(project, () => provider.detail(project, id)),
          status: (project, id) => run(project, () => provider.status(project, id)),
          published: (root, project) => run(project, () => provider.published(root, project)),
        }),
      ];
    }),
  prProvider: (id: string): PrProvider | undefined => plugins.prProviders().find((item) => item.id === id),
  followProviders: (): FollowProvider[] =>
    [...builtins(), ...loaded].flatMap((item) => {
      const provider = item.capabilities.follow,
        plugin = item.plugin;
      if (!provider) return [];
      return [
        guarded(item.plugin, "follow", provider, {
          repository: (project) => (disabledIn(project, plugin) ? undefined : provider.repository(project)),
          observe: (input) => gate.settled(input.project.id, plugin, () => provider.observe(input)),
          published: (root, project) => gate.run(project.id, plugin, () => provider.published(root, project)),
        }),
      ];
    }),
  /** Follow providers whose plugin this project has turned off. */
  followProvidersOff: (project: Pick<Project, "disabledPlugins">): string[] =>
    [...builtins(), ...loaded].flatMap((item) =>
      item.capabilities.follow && disabledIn(project, item.plugin) ? [item.capabilities.follow.id] : [],
    ),
  /** The merge provider for a checkout kind, its methods counted and refused by the project gate (`plugin` is the provider's plugin). */
  mergeProvider: (projectId: string, kind: string): MergeProvider | undefined => {
    const item = [...builtins(), ...loaded].find((entry) => entry.capabilities.merge?.kind === kind);
    return item?.capabilities.merge ? plugins.gatedMerge(projectId, item.plugin, item.capabilities.merge) : undefined;
  },
  gatedMerge: (projectId: string, plugin: string, provider: MergeProvider): MergeProvider =>
    gate.methods(projectId, plugin, provider, ["inspect", "markReady", "merge", "enableAutoMerge", "pullMain"]),
  coordinatorTools: (): CoordinatorToolsProvider[] => plugins.coordinatorToolSources().map((source) => source.provider),
  /** Coordinator tool providers with their origin: a built-in plugin's tools keep their built-in tool group. Their calls run through the project gate. */
  coordinatorToolSources: (): Array<{ provider: CoordinatorToolsProvider; builtIn: boolean }> =>
    [...builtins(), ...loaded].flatMap((item) => {
      const provider = item.capabilities.coordinatorTools;
      if (!provider) return [];
      const guard = guarded<CoordinatorToolsProvider>(item.plugin, "coordinatorTools", provider, {
        applies: (project) => !disabledIn(project, item.plugin) && provider.applies(project),
        create: (input) => {
          const made = provider.create(input);
          // The Durable registration is what a chat executes: gate its tools too, not only the offered list.
          const extension = { ...made.extension, tools: gate.tools(input.projectId, item.plugin, [...(made.extension.tools ?? [])]) };
          return { extension, tools: gate.tools(input.projectId, item.plugin, made.tools) };
        },
      });
      return [{ provider: guard, builtIn: item.builtIn === true }];
    }),
  /** Worker tool providers: offered only while the project has the plugin on; tools a thread already froze stop at their next call after a disable. */
  workerTools: (): WorkerToolsProvider[] =>
    [...builtins(), ...loaded].flatMap((item) => {
      const provider = item.capabilities.workerTools;
      if (!provider) return [];
      return [
        guarded<WorkerToolsProvider>(item.plugin, "workerTools", provider, {
          offered: (projectId: string) => !gate.isOff(projectId, item.plugin) && provider.offered(projectId),
          create: (input) => gate.tools(input.projectId, item.plugin, provider.create(input)),
        }),
      ];
    }),
  /**
   * Runs every plugin's lifecycle pause; one refusal resumes the others and refuses the change. Returns the combined resume.
   * A pause held by a plugin disable is the host's to keep: a plugin whose hook is one flag per project loses it when the transition
   * resumes, so each held pause of this project is released and taken again after the resumes.
   */
  pauseLifecycle: (projectId: string): (() => void) => {
    const resumes: Array<() => void> = [];
    const resumeAll = () => {
      for (const resume of resumes.splice(0).reverse()) release(resume);
      keepHeld(projectId);
    };
    try {
      for (const hooks of each((caps) => caps.lifecycle)) if (hooks.pause) resumes.push(hooks.pause(projectId));
    } catch (error) {
      resumeAll();
      throw error;
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      resumeAll();
    };
  },
  /** Cleanup routine steps of loaded plugins, by plugin name. */
  cleanupSteps: (projectId: string) =>
    loaded.flatMap((item) => {
      const run = item.capabilities.cleanup;
      if (!run || gate.isOff(projectId, item.plugin)) return [];
      return [{ plugin: item.plugin, run: ((input) => gate.run(projectId, item.plugin, () => run(input))) as typeof run }];
    }),
  usageSources: (projectId: string) =>
    loaded.flatMap((item) => {
      const measure = item.capabilities.usage;
      if (!measure || gate.isOff(projectId, item.plugin)) return [];
      return [{ plugin: item.plugin, measure: ((input) => gate.run(projectId, item.plugin, () => measure(input))) as typeof measure }];
    }),
  close: async (): Promise<void> => {
    await Promise.allSettled(each((caps) => caps.lifecycle).map((hooks) => hooks.close?.()));
  },
  /** Browser contributions of loaded plugins (asset URLs only). */
  web: (): Array<{ plugin: string; script: string | null; style: string | null; sidebar: { title: string } | null }> =>
    loaded
      .filter((item) => item.capabilities.web?.script || item.capabilities.web?.style)
      .map((item) => ({
        plugin: item.plugin,
        script: item.capabilities.web?.script ? `/plugins/${item.plugin}/ui.js` : null,
        style: item.capabilities.web?.style ? `/plugins/${item.plugin}/ui.css` : null,
        sidebar:
          item.capabilities.web?.script && item.capabilities.web.sidebar
            ? { title: item.capabilities.web.sidebar.title ?? item.plugin }
            : null,
      })),
  /** The declared browser file for /plugins/<name>/ui.js|ui.css; nothing else below a plugin is served. */
  webAsset: (plugin: string, file: string): WebFile | undefined => {
    const web = loaded.find((item) => item.plugin === plugin)?.web;
    return file === "ui.js" || file === "ui.css" ? web?.[file] : undefined;
  },
  route: (plugin: string, name: string): PluginRoute | undefined => {
    const routes = loaded.find((item) => item.plugin === plugin)?.capabilities.web?.routes;
    return routes && Object.hasOwn(routes, name) ? routes[name] : undefined;
  },
  rpc: (plugin: string, method: string): PluginRpcHandler | undefined =>
    loaded.find((item) => item.plugin === plugin)?.capabilities.rpc?.[method],
  /** The declared agent policy of one call; undefined when the plugin does not classify the method (or its policy throws). */
  rpcKind: (plugin: string, method: string, params: unknown): PluginRpcKind | undefined => {
    const policy = loaded.find((item) => item.plugin === plugin)?.capabilities.rpcPolicy?.[method];
    try {
      const kind = typeof policy === "function" ? policy(params) : policy;
      return kind === "read" || kind === "write" || kind === "dangerous" ? kind : undefined;
    } catch {
      return undefined;
    }
  },
  /** True when any plugin reports a write whose outcome is unknown (blocks automatic admission). */
  /** A project whose state cannot be read blocks admission rather than skipping a plugin's check. */
  anyUncertainWrites: async (tx: Tx, root: Conversation["id"], projectId: string): Promise<boolean> => {
    let project: Project;
    try {
      project = loadProject(projectId);
    } catch {
      return true;
    }
    for (const item of [...builtins(), ...loaded]) {
      const check = item.capabilities.uncertainWrites;
      if (check && !disabledIn(project, item.plugin) && (await check(tx, root)) !== false) return true;
    }
    return false;
  },
  privateDirs: (): string[] => each((caps) => caps.vcs).flatMap((item) => [...(item.privateDirs ?? [])]),
  vcsExecutables: (): string[] => each((caps) => caps.vcs).flatMap((item) => [...(item.executables ?? [])]),
  workerRules: (project: Pick<Project, "disabledPlugins">): string[] =>
    [...builtins(), ...loaded].flatMap((item) =>
      item.capabilities.vcs?.workerRule && !disabledIn(project, item.plugin) ? [item.capabilities.vcs.workerRule] : [],
    ),
  status: (): PluginStatus[] => statuses.map((item) => ({ ...item })),
  /** The loader's result for the plugin at this directory, if this host tried it at its start. */
  attempt: (directory: string): PluginStatus | undefined => {
    for (const [path, status] of attempts) if (isPluginAt(directory, path)) return { ...status };
    return undefined;
  },
  /** Resolved directories of the current configuration (`plugins.json` and the environment), loaded or not. */
  configuredPaths: (): string[] => configured().flatMap((item) => ("path" in item ? [item.path] : [])),
  /** Display labels of providers with PR cards or follow events (for event titles). */
  labels: (): Record<string, string> => ({
    ...Object.fromEntries(each((caps) => caps.prs).map((item) => [item.id, item.label])),
    ...Object.fromEntries(each((caps) => caps.follow).map((item) => [item.id, item.label])),
  }),
  load: loadPlugins,
  /** Test seam: drops every registration. */
  reset: () => {
    loaded.length = 0;
    statuses.length = 0;
    attempts.clear();
    heldPauses.clear();
    loading = undefined;
  },
};

const timeoutMs = () => Number(process.env.PI_PROJECTS_PLUGIN_TIMEOUT_MS) || 15_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION = /^\S{1,40}$/;

const resolvePluginPath = (value: string): string =>
  resolve(isAbsolute(value) ? value : value.startsWith("~/") ? join(process.env.HOME ?? "", value.slice(2)) : join(home(), value));

/** Whether a resolved configured path is this plugin directory or the directory's entry file (the loader accepts both). */
export const isPluginAt = (directory: string, path: string): boolean => {
  if (path === directory) return true;
  try {
    return entryOf(directory) === path;
  } catch {
    return false;
  }
};

/** Configured plugin sources: [{ source, path }] or a recorded problem. */
function configured(): Array<{ source: string; path: string } | { source: string; problem: string }> {
  const out: Array<{ source: string; path: string } | { source: string; problem: string }> = [];
  const file = join(home(), "plugins.json");
  const resolvePath = resolvePluginPath;
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const list = Array.isArray(data) ? data : (data as { plugins?: unknown } | null)?.plugins;
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item))
        throw new Error('expected { "plugins": ["/path", ...] }');
      for (const item of list as string[]) out.push({ source: item, path: resolvePath(item) });
    } catch (error) {
      out.push({ source: file, problem: `plugins.json is unreadable: ${message(error)}` });
    }
  }
  for (const item of (process.env.PI_PROJECTS_PLUGINS ?? "").split(":").filter(Boolean))
    out.push({ source: item, path: resolvePath(item) });
  return out.filter((item, at, all) => !("path" in item) || all.findIndex((other) => "path" in other && other.path === item.path) === at);
}

function entryOf(path: string): string {
  if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
  if (!statSync(path).isDirectory()) return path;
  try {
    const main = (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { main?: unknown }).main;
    if (typeof main === "string" && existsSync(join(path, main))) return join(path, main);
  } catch {
    /* no package.json */
  }
  for (const name of ["index.ts", "index.mjs", "index.js"]) if (existsSync(join(path, name))) return join(path, name);
  throw new Error(`directory has no index.ts, index.mjs, index.js or package.json main: ${path}`);
}

const requireFunctions = (what: string, value: object, names: string[]) => {
  for (const name of names)
    if (typeof (value as Record<string, unknown>)[name] !== "function") throw new Error(`${what}.${name} must be a function`);
};
const requireStrings = (what: string, value: object, names: string[]) => {
  for (const name of names)
    if (typeof (value as Record<string, unknown>)[name] !== "string" || !(value as Record<string, string>)[name])
      throw new Error(`${what}.${name} must be a non-empty string`);
};
/** Fields that older plugins still provide: the host ignores them with one log line instead of refusing the plugin. */
function dropRetired(name: string, caps: PluginCapabilities): void {
  const follow = caps.follow as (typeof caps.follow & { autoMerge?: unknown }) | undefined;
  if (follow?.autoMerge === undefined) return;
  delete follow.autoMerge;
  process.stderr.write(`plugin ${name}: follow.autoMerge is retired and ignored; approve a PR to merge it\n`);
}
function validate(caps: PluginCapabilities): void {
  if (caps.vcs) {
    requireStrings("vcs", caps.vcs, ["kind"]);
    requireFunctions("vcs", caps.vcs, ["isRoot", "changedFiles", "codeDiff", "workerState", "resolveContinuation"]);
    if (caps.vcs.kind === "git") throw new Error('vcs.kind "git" is built in');
  }
  if (caps.workspace) {
    requireStrings("workspace", caps.workspace, ["id"]);
    requireFunctions("workspace", caps.workspace, ["quickPreview", "plan", "attach", "workerFacts", "remove"]);
    requireFunctions("workspace.isolation", caps.workspace.isolation, ["preflight", "add", "entry", "exact", "statusCommand", "release"]);
    if (caps.workspace.id === "github" || caps.workspace.id === "git") throw new Error(`workspace.id "${caps.workspace.id}" is built in`);
  }
  if (caps.prs) {
    requireStrings("prs", caps.prs, ["id", "label", "watchDocKind"]);
    requireFunctions("prs", caps.prs, ["applies", "list", "detail", "parseRefs", "status", "published", "url"]);
    if (caps.prs.id === "github") throw new Error('prs.id "github" is built in');
  }
  if (caps.follow) {
    requireStrings("follow", caps.follow, ["id", "eventKind", "label"]);
    requireFunctions("follow", caps.follow, ["repository", "observe", "published"]);
  }
  if (caps.merge) {
    requireStrings("merge", caps.merge, ["kind"]);
    requireFunctions("merge", caps.merge, ["inspect", "merge", "enableAutoMerge", "pullMain"]);
  }
  if (caps.coordinatorTools) requireFunctions("coordinatorTools", caps.coordinatorTools, ["create", "applies"]);
  if (caps.uncertainWrites !== undefined && typeof caps.uncertainWrites !== "function")
    throw new Error("uncertainWrites must be a function");
  if (caps.workerTools) requireFunctions("workerTools", caps.workerTools, ["offered", "create"]);
  if (caps.leaseName !== undefined && typeof caps.leaseName !== "function") throw new Error("leaseName must be a function");
  if (caps.cleanup !== undefined && typeof caps.cleanup !== "function") throw new Error("cleanup must be a function");
  if (caps.usage !== undefined && typeof caps.usage !== "function") throw new Error("usage must be a function");
  for (const hook of ["pause", "unresolved", "close"] as const)
    if (caps.lifecycle?.[hook] !== undefined && typeof caps.lifecycle[hook] !== "function")
      throw new Error(`lifecycle.${hook} must be a function`);
  for (const file of ["script", "style"] as const) {
    const path = caps.web?.[file];
    if (path !== undefined && (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)))
      throw new Error(`web.${file} must be an absolute path to an existing file`);
  }
  const sidebar = caps.web?.sidebar;
  if (sidebar !== undefined) {
    if (!caps.web?.script) throw new Error("web.sidebar needs web.script");
    if (
      typeof sidebar !== "object" ||
      sidebar === null ||
      (sidebar.title !== undefined && (typeof sidebar.title !== "string" || !sidebar.title.trim() || sidebar.title.length > 60))
    )
      throw new Error("web.sidebar must be { title?: string of 1 to 60 characters }");
  }
  for (const [route, handler] of Object.entries(caps.web?.routes ?? {}))
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(route) || route === "ui.js" || route === "ui.css" || typeof handler !== "function")
      throw new Error(`web.routes.${route} must be a function with a kebab-case name`);
  for (const [method, handler] of Object.entries(caps.rpc ?? {}))
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(method) || typeof handler !== "function")
      throw new Error(`rpc.${method} must be a function with a kebab-case name`);
  for (const [method, policy] of Object.entries(caps.rpcPolicy ?? {}))
    if (!caps.rpc?.[method] || !(typeof policy === "function" || policy === "read" || policy === "write" || policy === "dangerous"))
      throw new Error(`rpcPolicy.${method} must name an rpc method and be "read", "write", "dangerous" or a function of params`);
}
function conflict(name: string, caps: PluginCapabilities, builtIn: boolean): string | undefined {
  if ((!builtIn && BUNDLED.some((item) => item.name === name)) || loaded.some((item) => item.plugin === name))
    return `a plugin named "${name}" is already loaded`;
  const clash = (what: string, id: string | undefined, existing: Array<string | undefined>) =>
    id !== undefined && existing.includes(id) ? `${what} "${id}" is already provided by another plugin` : undefined;
  return (
    clash(
      "vcs kind",
      caps.vcs?.kind,
      each((c) => c.vcs).map((item) => item.kind),
    ) ??
    clash(
      "workspace provider",
      caps.workspace?.id,
      each((c) => c.workspace).map((item) => item.id),
    ) ??
    clash(
      "PR provider",
      caps.prs?.id,
      each((c) => c.prs).map((item) => item.id),
    ) ??
    clash(
      "follow provider",
      caps.follow?.id,
      each((c) => c.follow).map((item) => item.id),
    )
  );
}
const provides = (caps: PluginCapabilities) =>
  (Object.keys(caps) as Array<keyof PluginCapabilities>).filter((key) => caps[key] !== undefined);

async function hostApi(name: string, stage: PluginCapabilities): Promise<HostPluginApi> {
  const { Jobs } = await import("./jobs.ts");
  const stateDir = join(home(), "plugins", name);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return {
    name,
    stateDir,
    lib: { durable, typebox, value, chord, docs: { jobs: Jobs } },
    provide(capabilities) {
      for (const key of Object.keys(capabilities) as Array<keyof PluginCapabilities>) {
        if (stage[key] !== undefined) throw new Error(`capability "${key}" was provided twice`);
        (stage as Record<string, unknown>)[key] = capabilities[key];
      }
    },
    projects: {
      load: loadProject,
      list: listProjects,
      dir: projectDir,
      record: <T>(project: object, key: string) => (project as Record<string, unknown>)[key] as T | undefined,
      authorizationFingerprint,
      trustedOwner,
      workspaceRoots: (id) => verifiedWorkspaceRoots(loadProject(id).cwd, workerWorktreeRoot(id)),
      work: (id, work) => gate.run(id, name, work),
    },
    exec: {
      run: runCli,
      runSync: (file, args, cwd) =>
        execFileSync(file, args, {
          cwd,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
      command,
    },
    leases: {
      acquire: (resource, holder, ttlMs) =>
        hostLeases.acquire(resource, { projectId: holder.projectId, threadId: `plugin:${name}:${holder.owner}` }, ttlMs),
      release: (resource, holder) =>
        hostLeases.release(resource, { projectId: holder.projectId, threadId: `plugin:${name}:${holder.owner}` }),
      held: (match) => hostLeases.held(match),
    },
    vcs: { findRoot: findVcsRoot },
    workspace: { WHOLE_REPOSITORY_PREFIX, repositoryFingerprint: workspaceRepositoryFingerprint },
    prs: { createListCache, RateLimitedError, clip },
  };
}

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs()} ms`)), timeoutMs());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A declared file that cannot be read is not served (404), as before; it does not fail the plugin. */
function webFiles(web: WebContribution | undefined): Loaded["web"] {
  const read = (path: string | undefined, mime: string) => {
    if (!path) return undefined;
    try {
      return webFile(readFileSync(path), mime);
    } catch {
      return undefined;
    }
  };
  return { "ui.js": read(web?.script, "text/javascript; charset=utf-8"), "ui.css": read(web?.style, "text/css; charset=utf-8") };
}

async function loadOne(source: string, path: string, builtIn = false): Promise<PluginStatus> {
  const status: PluginStatus = { source, name: null, version: null, state: "failed", provides: [], loadedAtMs: Date.now() };
  try {
    const imported = await withTimeout(import(pathToFileURL(entryOf(path)).href) as Promise<Record<string, unknown>>, "import");
    const module = (imported.default && typeof imported.default === "object" ? imported.default : imported) as Partial<PluginModule>;
    if (typeof module.name !== "string" || !NAME.test(module.name))
      throw new Error("the module must export a name matching /^[a-z][a-z0-9-]{0,39}$/");
    if (typeof module.register !== "function") throw new Error("the module must export register(api)");
    status.name = module.name;
    if (module.version !== undefined && (typeof module.version !== "string" || !VERSION.test(module.version)))
      throw new Error("the module's version must be a string of 1 to 40 characters without spaces");
    status.version = module.version ?? null;
    const stage: PluginCapabilities = {};
    await withTimeout(
      hostApi(module.name, stage).then((api) => module.register!(api)),
      "register",
    );
    dropRetired(module.name, stage);
    validate(stage);
    const clash = conflict(module.name, stage, builtIn);
    if (clash) throw new Error(clash);
    const capabilities = builtIn ? { ...coreCapabilities(module.name), ...stage } : stage;
    loaded.push({ plugin: module.name, ...(builtIn ? { builtIn: true as const } : {}), capabilities, web: webFiles(stage.web) });
    if (stage.leaseName) hostLeases.addNaming(stage.leaseName);
    status.state = "loaded";
    status.provides = provides(capabilities);
  } catch (error) {
    status.error = message(error);
  }
  return status;
}

/** A restart forgets the pauses a disable held: take them again for every project that has a plugin off. A refusing plugin stays gated by the flag. */
function retakePauses() {
  for (const project of listProjects())
    for (const name of project.disabledPlugins ?? []) {
      const held = `${project.id}\0${name}`;
      if (heldPauses.has(held)) continue;
      try {
        const paused = [...builtins(), ...loaded].find((entry) => entry.plugin === name)?.capabilities.lifecycle?.pause?.(project.id);
        if (paused) heldPauses.set(held, paused);
      } catch {
        /* the stored flag already refuses every entry of the plugin */
      }
    }
}

/** Loads every configured plugin once per host process; later callers share the result. Never throws. */
export function loadPlugins(): Promise<PluginStatus[]> {
  return (loading ??= (async () => {
    for (const item of BUNDLED) statuses.push(await loadOne(BUILT_IN, item.path, true));
    for (const item of configured()) {
      if ("problem" in item) {
        statuses.push({
          source: item.source,
          name: null,
          version: null,
          state: "failed",
          error: item.problem,
          provides: [],
          loadedAtMs: Date.now(),
        });
        continue;
      }
      const status = await loadOne(item.source, item.path);
      statuses.push(status);
      attempts.set(item.path, status);
    }
    retakePauses();
    return plugins.status();
  })());
}
