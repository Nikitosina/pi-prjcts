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
import { home, loadProject, projectDir, type Project } from "./state.ts";
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
    return [
      {
        id: `plugin:${item.plugin}`,
        name: prompt.name,
        text: prompt.text,
        grant: { label: prompt.name, on: (project: Project) => tools.applies(project) && (prompt.on?.(project) ?? true) },
      },
    ];
  }),
);
export const plugins = {
  vcsProviders: (): VcsProvider[] => each((caps) => caps.vcs),
  vcsProvider: (kind: string): VcsProvider | undefined => each((caps) => caps.vcs).find((item) => item.kind === kind),
  workspaceProviders: (): WorkspaceProvider[] => each((caps) => caps.workspace),
  workspaceProvider: (id: string): WorkspaceProvider | undefined => each((caps) => caps.workspace).find((item) => item.id === id),
  prProviders: (): PrProvider[] => each((caps) => caps.prs),
  prProvider: (id: string): PrProvider | undefined => each((caps) => caps.prs).find((item) => item.id === id),
  followProviders: (): FollowProvider[] => each((caps) => caps.follow),
  mergeProvider: (kind: string): MergeProvider | undefined => each((caps) => caps.merge).find((item) => item.kind === kind),
  coordinatorTools: (): CoordinatorToolsProvider[] => each((caps) => caps.coordinatorTools),
  /** Coordinator tool providers with their origin: a built-in plugin's tools keep their built-in tool group. */
  coordinatorToolSources: (): Array<{ provider: CoordinatorToolsProvider; builtIn: boolean }> =>
    [...builtins(), ...loaded].flatMap((item) =>
      item.capabilities.coordinatorTools ? [{ provider: item.capabilities.coordinatorTools, builtIn: item.builtIn === true }] : [],
    ),
  workerTools: (): WorkerToolsProvider[] => each((caps) => caps.workerTools),
  /** Runs every plugin's lifecycle pause; one refusal resumes the others and refuses the change. Returns the combined resume. */
  pauseLifecycle: (projectId: string): (() => void) => {
    const resumes: Array<() => void> = [];
    const resumeAll = () => {
      for (const resume of resumes.splice(0).reverse()) {
        try {
          resume();
        } catch {
          /* resuming never blocks the host */
        }
      }
    };
    try {
      for (const hooks of each((caps) => caps.lifecycle)) if (hooks.pause) resumes.push(hooks.pause(projectId));
    } catch (error) {
      resumeAll();
      throw error;
    }
    return resumeAll;
  },
  /** Cleanup routine steps of loaded plugins, by plugin name. */
  cleanupSteps: () =>
    loaded.flatMap((item) => (item.capabilities.cleanup ? [{ plugin: item.plugin, run: item.capabilities.cleanup }] : [])),
  usageSources: () =>
    loaded.flatMap((item) => (item.capabilities.usage ? [{ plugin: item.plugin, measure: item.capabilities.usage }] : [])),
  close: async (): Promise<void> => {
    await Promise.allSettled(each((caps) => caps.lifecycle).map((hooks) => hooks.close?.()));
  },
  /** Browser contributions of loaded plugins (asset URLs only). */
  web: (): Array<{ plugin: string; script: string | null; style: string | null }> =>
    loaded
      .filter((item) => item.capabilities.web?.script || item.capabilities.web?.style)
      .map((item) => ({
        plugin: item.plugin,
        script: item.capabilities.web?.script ? `/plugins/${item.plugin}/ui.js` : null,
        style: item.capabilities.web?.style ? `/plugins/${item.plugin}/ui.css` : null,
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
  anyUncertainWrites: async (tx: Tx, root: Conversation["id"]): Promise<boolean> => {
    for (const check of each((caps) => caps.uncertainWrites)) if (await check(tx, root)) return true;
    return false;
  },
  privateDirs: (): string[] => each((caps) => caps.vcs).flatMap((item) => [...(item.privateDirs ?? [])]),
  vcsExecutables: (): string[] => each((caps) => caps.vcs).flatMap((item) => [...(item.executables ?? [])]),
  workerRules: (): string[] => each((caps) => caps.vcs).flatMap((item) => (item.workerRule ? [item.workerRule] : [])),
  status: (): PluginStatus[] => statuses.map((item) => ({ ...item })),
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
    loading = undefined;
  },
};

const timeoutMs = () => Number(process.env.PI_PROJECTS_PLUGIN_TIMEOUT_MS) || 15_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const VERSION = /^\S{1,40}$/;

/** Configured plugin sources: [{ source, path }] or a recorded problem. */
function configured(): Array<{ source: string; path: string } | { source: string; problem: string }> {
  const out: Array<{ source: string; path: string } | { source: string; problem: string }> = [];
  const file = join(home(), "plugins.json");
  const resolvePath = (value: string) =>
    resolve(isAbsolute(value) ? value : value.startsWith("~/") ? join(process.env.HOME ?? "", value.slice(2)) : join(home(), value));
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
  for (const hook of ["pause", "close"] as const)
    if (caps.lifecycle?.[hook] !== undefined && typeof caps.lifecycle[hook] !== "function")
      throw new Error(`lifecycle.${hook} must be a function`);
  for (const file of ["script", "style"] as const) {
    const path = caps.web?.[file];
    if (path !== undefined && (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)))
      throw new Error(`web.${file} must be an absolute path to an existing file`);
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
      dir: projectDir,
      record: <T>(project: object, key: string) => (project as Record<string, unknown>)[key] as T | undefined,
      authorizationFingerprint,
      trustedOwner,
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
      statuses.push(await loadOne(item.source, item.path));
    }
    return plugins.status();
  })());
}
