# Reference

Signatures on this page are copied from [`src/plugin-types.ts`](../../src/plugin-types.ts), shortened where noted. Loader rules come from [`src/plugins.ts`](../../src/plugins.ts). Provider capabilities (`vcs`, `workspace`, `prs`, `follow`, `merge`, `uncertainWrites`) are in [`PLUGINS.md`](../../PLUGINS.md).

## The module

```ts
export type PluginModule = {
  name: string;
  /** Shown with the plugin's status; up to 40 characters without spaces. */
  version?: string;
  register(api: HostPluginApi): void | Promise<void>;
};
```

Export it as the default export, or export `name`, `version` and `register` by name. The loader enforces these rules:

- `name` matches `/^[a-z][a-z0-9-]{0,39}$/` and is unique on the host. `github` is reserved for the built-in GitHub plugin (`plugins/github`), which loads first on every host with source `built-in`; the `plugins` RPC and Settings → Plugins list it too.
- `version` is optional. When present it is 1 to 40 characters without spaces. A plugin without it shows `version: null`.
- Import and `register` each have to finish within `PI_PROJECTS_PLUGIN_TIMEOUT_MS` (15 seconds by default).
- `register` calls `api.provide({...})` once or more, each capability at most once. Nothing is visible until `register` returns. If it throws, nothing it provided stays registered.
- After `register`, the loader checks every provided capability: required methods are functions, RPC method names are kebab-case (`/^[a-z][a-z0-9-]{0,63}$/`), every `rpcPolicy` key names an `rpc` method, and `sections` follow the declaration rules of [Sections](#sections), with an error that names the field. It also refuses a provider id or checkout kind that another plugin already provides.

A plugin that fails any rule is recorded as `failed` with the reason and contributes nothing; the host keeps running.

A path in `plugins.json` is a module file, or a directory with a `package.json` `main`, `index.ts`, `index.mjs` or `index.js` (checked in that order). The host runs `.ts` files with Node's built-in type stripping, so a TypeScript plugin uses only erasable syntax and needs no build.

## `HostPluginApi`

`register` receives this object. Shortened; provider-only fields are marked.

```ts
type HostPluginApi = {
  name: string;          // the plugin's own name
  stateDir: string;      // $PI_PROJECTS_HOME/plugins/<name>/, created for you
  lib: PluginLib;        // the host's libraries, see below
  provide(capabilities: PluginCapabilities): void;
  projects: {
    load(id: string): Project;                                   // throws for an unknown project
    dir(id: string): string;                                     // $PI_PROJECTS_HOME/<id>
    record<T = unknown>(project: Project, key: string): T | undefined;
    authorizationFingerprint(project: Project): string;          // providers
    trustedOwner(): string;                                      // providers
  };
  exec: {
    run(file: string, args: string[], cwd?: string): Promise<CliResult>;   // never throws; the exit code is data
    runSync(file: string, args: string[], cwd: string): string;            // throws on failure; trimmed stdout; 30 s limit
    command(file: string, args: string[], cwd?: string): Promise<CliResult>; // sanitized environment (providers)
  };
  leases: { acquire; release; held };                            // see Resource leases
  vcs: { findRoot(dir: string): { kind: string; root: string } | null };
  workspace: { WHOLE_REPOSITORY_PREFIX; repositoryFingerprint };  // providers
  prs: { createListCache; RateLimitedError; clip };               // providers
};
```

### `api.lib`

```ts
type PluginLib = {
  durable: typeof import("@earendil-works/pi-durable");
  typebox: typeof import("typebox");
  value: typeof import("typebox/value");
  chord: typeof import("@earendil-works/chord/context");
  docs: { jobs: typeof Jobs };
};
```

Use these instead of importing your own copies. Durable tools and documents only work with the host's instances. The host pins Pi Durable and Chord 1.4.0 and typebox 1.3.27 in its `package.json`; a test may import the same versions directly, as the [example test](examples/notes/index.test.mjs) does, but the plugin itself takes them from `api.lib`.

## Capabilities

`api.provide` takes any of these keys. The status of a loaded plugin lists the keys it provided under `provides`.

| key | for | section |
| --- | --- | --- |
| `rpc`, `rpcPolicy` | methods the owner's clients and the Host agent call | [RPC methods](#rpc-methods) |
| `coordinatorTools` | tools for coordinators of matching projects | [Coordinator tools](#coordinator-tools) |
| `workerTools` | tools for whole-repository workers | [Worker tools](#worker-tools) |
| `leaseName` | canonical names for resources the plugin owns | [Resource leases](#resource-leases) |
| `lifecycle` | hooks around project pause, resume, archive, delete and host shutdown | [Lifecycle](#lifecycle) |
| `cleanup`, `usage` | a step of the Workspace cleanup routine and a row in Settings → Storage | [Cleanup and storage](#cleanup-and-storage) |
| `sections` | declarative sections in Settings → Plugins and in the chat's right panel | [Sections](#sections) |
| `vcs`, `workspace`, `prs`, `follow`, `merge`, `uncertainWrites` | a checkout kind or PR service | [`PLUGINS.md`](../../PLUGINS.md) |

## RPC methods and agent tools

A plugin offers two kinds of calls. Pick by who calls.

| | RPC methods (`rpc`) | Agent tools (`coordinatorTools`, `workerTools`) |
| --- | --- | --- |
| Called by | clients of the host API: the browser, local scripts over the host socket, and the Host agent through `host_call` | the model of a coordinator or worker conversation |
| Shape | `{ action: "plugin", plugin, method, id?, params? }` | a Durable tool with a typebox schema, offered by name |
| Input checks | none by the host; validate `params` yourself | the harness validates arguments against `parameters` |
| Agent safety | `rpcPolicy` decides whether the Host agent needs the owner's approval | the owner can switch coordinator tools off in Settings → Tools (group Plugins); worker tools are not listed there, and the plugin's `workerTools.offered` decides which projects get them |
| Durability | a plain call | recorded in the conversation; `replay` decides whether an interrupted call reruns after a restart |

Coordinators and workers cannot call RPC methods. To let them use the same behavior, put it in a function and call it from both an RPC handler and a tool, as the example plugin does.

### RPC methods

```ts
rpc?: Record<string, (context: PluginRpcContext) => Promise<unknown>>;
rpcPolicy?: Record<string, "read" | "write" | "dangerous" | ((params: unknown) => "read" | "write" | "dangerous")>;

type PluginRpcContext = {
  params: unknown;                // the caller's params, unchecked
  projectId: string | undefined;  // the request's `id`
  withRoot<T>(projectId: string, fn: (root: Conversation) => Promise<T>): Promise<T>;
  mutateIdle(projectId: string, change: { validate(project: Project): void; apply(project: Project): Project }): Promise<void>;
};
```

The handler's resolved value is the `data` of the reply; a throw becomes `{ ok: false, error }`. `withRoot` opens the project's Durable root conversation. `mutateIdle` changes the project record only while the project has no queued or running work; `validate` runs before and again under the project lock.

`rpcPolicy` is the approval policy for agents:

- `"read"` and `"write"`: the Host agent's `host_call` runs the method directly.
- `"dangerous"`, a method without a policy, and a policy function that throws or returns anything else: `host_call` files an owner approval instead, and the method runs only after the owner approves it, with the stored params.
- A function decides per call from `params`, for example `"dangerous"` only for a delete operation.

The owner's own browser calls are not gated. The host trusts the plugin's classification: a destructive method marked `"read"` runs without approval, so classify by the worst thing a call can do. From the example:

```js
rpcPolicy: { list: "read", add: "write", clear: "dangerous" },
```

### Coordinator tools

```ts
coordinatorTools?: {
  create(input: {
    projectId: string;
    root: () => Conversation | undefined;
    isCoordinator: (id: Conversation["id"]) => boolean;
    chatIdOf: (id: Conversation["id"]) => string | undefined;
  }): { tools: ToolRegistration[]; extension: Extension };
  applies(project: Project): boolean;
  prompt?: { name: string; text: string; on?(project: Project): boolean };
  instructions?(project: Project): string;   // older form, ignored when prompt is set
};
```

- The host calls `create` once per project when it opens the project's runtime. It installs the tools for every project, so recorded calls still resolve, and offers them only where `applies(project)` is true.
- `extension` is the Pi Durable registration of the same tools: `api.lib.durable.defineExtension({ name, tools })`. Give it a stable, unique name such as `projects.<plugin name>`.
- Check `isCoordinator(toolApi.conversationId)` in `execute`, as the simulator plugin does, so a call from any conversation other than a coordinator's is refused.
- `prompt` adds the coordinator's rules for the tools as an editable integration block, `plugin:<plugin name>` in Settings → Prompt. It shows while `applies` and `on` are true. `text` may use `{project}`, `{projectId}` and `{githubRepos}`.
- `chatIdOf(toolApi.conversationId)` is the chat of the calling Coordinator conversation (`main` or the chat id), `undefined` for any other conversation. A tool that keeps per-chat data takes the chat from it and never from an argument. The [tasks plugin](../../plugins/tasks/README.md) does this.
- Prefix tool names with the plugin name; tool names share one namespace with core tools.

A tool returns Durable output, not Pi coding-agent `content`:

```js
const { defineTool } = api.lib.durable, { Type } = api.lib.typebox;
defineTool({
  name: "notes_add",
  description: "Add one short note to this project's notes.",
  parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
  replay: "unsafe",   // never rerun after an interruption; "safe" for reads and idempotent writes
  async execute(args, toolApi) {
    return { output: [{ type: "text", text: JSON.stringify(add(projectId, args.text)) }] };
  },
});
```

### Worker tools

```ts
workerTools?: {
  offered(projectId: string): boolean;
  create(input: { projectId: string; threadId: string; conversationId: number }): ToolRegistration[];
  instructions?: string;   // appended to the instructions of workers that get the tools
};
```

- Only workers bound to a whole-repository workspace get them. Task helpers, scouts and reviewers do not.
- `offered` is asked when a worker thread is first bound. A thread then keeps exactly the tool set it started with: turning the offer on later reaches only new threads, and turning it off does not remove tools from existing ones.
- Check `Number(toolApi.conversationId) === conversationId` in `execute` so a tool serves only the worker it was created for.

### State

- `api.stateDir` is the plugin's own directory, `$PI_PROJECTS_HOME/plugins/<name>/`, created with mode 0700. It is per host home, shared by all projects; key files by project id.
- `api.projects.dir(id)` is the project's state directory, for per-project files such as the simulator plugin's `simulator.json`. Pick a file name that cannot clash with core files.
- Validate a project id before using it in a path. The example checks `/^[a-f0-9-]{36}$/`.
- The host keeps a plugin's files when the plugin is not loaded, and nothing reads them until it is loaded again.
- Durable documents defined through `api.lib.durable` need an explicit `checkpointWhen` policy (`() => false` keeps changes as deltas).

### Per-project on and off

The owner turns a loaded plugin on or off for one project in Project settings → Plugins (a plugin is on by default). A disabled plugin is not unloaded and keeps its stored files; other projects are unaffected.

- Every entry of the plugin into a disabled project is refused at execution time with "plugin is disabled in this project": tool calls (also of threads that froze the tools earlier), RPC calls and web routes. `cleanup` and `usage` skip the project, and `workerTools.offered`, `coordinatorTools.applies` and the prompt block treat the plugin as absent.
- The host refuses to disable a plugin that has active work in the project (a running tool call, RPC or route, or a `lifecycle.pause` that throws) or that the project's checkout needs (its workspace grant names the plugin or a provider id it provides). Nothing is stopped by force.
- A disable holds the plugin's `lifecycle.pause` for the project until the enable, and a restarted host takes it again. Hooks the host cannot route through the project (`lifecycle.close`, timers, a coordinator `extension`'s own hooks) are the plugin's own; a host-wide timer must work per project through `api.projects.list()` and touch only what an enabled project owns (the simulator plugin prunes only the XcodeBuildMCP workspaces of enabled projects' folders and worktrees).

### Resource leases

Leases are host-wide advisory locks shared with workers, who take them with `projects_lease_acquire`. Use them for devices or ports a worker and the plugin must not use at the same time.

```ts
leases: {
  acquire(resource: string, holder: { projectId: string; owner: string }, ttlMs: number): Promise<LeaseAnswer>;
  release(resource: string, holder: { projectId: string; owner: string }): boolean;
  held(match?: (holder: { projectId: string; threadId: string }) => boolean): Array<{ resource: string; projectId: string; threadId: string; until: string }>;
};
leaseName?: (resource: string) => string | undefined;
```

- `acquire` answers at once (`{ acquired: false, heldBy, until }` when someone else holds it); the same holder calling again renews.
- The plugin's holds use thread id `plugin:<name>:<owner>`. Project stops do not release them and worker cards do not list them, so release them yourself.
- Leases live in host memory; a host restart drops them.
- `leaseName` maps every alias of a resource the plugin owns to one canonical name, so aliases share one lease. Return `undefined` for resources that are not yours. The simulator plugin maps a bare device id and `simulator:<id>` to the same lease.

### Lifecycle

```ts
lifecycle?: {
  pause?(projectId: string): () => void;   // before pause, resume, archive or delete; throw to refuse; returns the resume
  close?(): Promise<void>;                 // host shutdown: abort outstanding work
};
```

`pause` runs synchronously before the change; when one plugin throws, the host resumes the others and refuses the change. Use `close` to stop timers and child processes. `plugin check` also calls `close` and waits for it at most 5 seconds.

### Cleanup and storage

```ts
cleanup?: (input: { projectId: string; unusedDays: number; signal: AbortSignal }) => Promise<string>;
usage?: (input: { projectId: string; unusedDays: number; signal: AbortSignal }) =>
  Promise<{ label: string; count: number | null; bytes: number | null; reclaimableBytes: number | null; note?: string } | null>;
```

- `cleanup` is a step of the project's Workspace cleanup routine, after the core steps. Remove only what the plugin owns, nobody uses now, and nobody used within `unusedDays`. Resolve with a one-line summary, or `""` for nothing to say; throw to fail the run.
- `usage` is the plugin's row in Settings → Storage, or `null` when it keeps nothing for the project. `reclaimableBytes` is what `cleanup` would free now. A throw shows the row as unknown; other rows still answer.

### Sections

A plugin shows things to the owner only through sections: data it returns, which the inbox draws itself. No plugin code runs in the browser. This holds for every host, local or paired, so a remote host or the relay can never run code in the owner's page.

```ts
sections?: Record<string, PluginSection>; // at most 4, keyed by a kebab-case id of up to 40 characters

type PluginSection = {
  title: string;              // 1 to 60 characters
  place: "settings" | "chat";
  refreshMs?: number;         // read again every N ms while shown and the page is visible: an integer from 2000 to 3600000
  read(context: { projectId: string | undefined; chatId: string | undefined }): Promise<SectionView>;
};
type SectionView = { rows: SectionRow[]; empty?: string; footer?: string };
type SectionRow = {
  label?: string;                                   // a muted key before the text
  text: string;
  status?: { label: string; tone?: "neutral" | "good" | "work" | "needs" | "bad" };
  detail?: string[];                                // muted lines under the text
  links?: { label: string; url: string }[];         // http and https only
  buttons?: { label: string; method: string; params?: unknown; confirm?: string }[];
};
```

Where a section shows:

- `settings`: in the plugin's card in Settings → Plugins, for the selected project. `read` gets `projectId` (or none when no project is selected) and never a `chatId`.
- `chat`: in the chat's right panel, under Workers and Pull requests, in plugin load order. `read` gets the selected `projectId` and `chatId` (`"main"` for the main chat).

A section shows only for projects where its plugin is on. Turning the plugin off removes its sections at once.

Reading:

- The browser reads a section with the `plugin-section` action, `{ action: "plugin-section", plugin, section, id?, chatId? }`, through the host that owns the project. It is a read: the Host agent may call it too.
- The host refuses a chat section without a project and a chat, a settings section with a chat, an unknown section, and a plugin that is off for the project. It gives `read` 15 seconds.
- The inbox runs one read of a section at a time. It reads on mount, every `refreshMs`, and when the page becomes visible again. It stops when the section goes away: Settings closes, the owner leaves Plugins, or selects another project or chat. An answer for a previous selection is dropped.
- A `read` that throws shows its message in the section. A failed refresh keeps the last rows and says "Could not refresh". Other sections keep working.

Limits. The host checks every view and refuses one that breaks a rule, with a message that names the field, for example `rows[0].links[0].url must be an absolute http or https URL`. Only the fields above leave the host.

| field | limit |
| --- | --- |
| `rows` | at most 50 |
| `label` | up to 60 characters |
| `text`, each `detail` line | up to 500 characters; at most 3 detail lines |
| `status.label` | 1 to 40 characters |
| `links` | at most 3; label up to 300 characters, URL up to 500, absolute `http:` or `https:` |
| `buttons` | at most 3; label 1 to 40 characters, `confirm` up to 300 |
| button `params` | JSON of at most 2 KB |
| `empty`, `footer` | up to 300 characters |

Buttons:

- `method` names one of the plugin's `rpc` methods that has an `rpcPolicy` entry. A click sends one `plugin` call with that method and `params`, for the section's project, and reads the section again.
- The host attaches the call's kind from `rpcPolicy` for these exact `params`. A `"dangerous"` call needs a `confirm` text; the inbox shows it inline with Cancel focused. A `confirm` on any other call asks too.
- A write is never retried. When its answer is lost, the section says the result is unknown. Put a request id in `params` when a repeated call must not act twice, and keep it the same while nothing changed, or every refresh redraws the section.

Every string is drawn as text, never as HTML. Links open in a new tab with `noopener noreferrer`, and the browser checks their protocol again.

From the example:

```js
sections: {
  notes: {
    title: "Notes",
    place: "settings",
    read: async ({ projectId }) => {
      if (!projectId) return { rows: [], empty: "Select a project to see its notes." };
      const notes = read(projectId);
      const summary = {
        label: "Saved",
        text: String(notes.length),
        buttons: notes.length ? [{ label: "Clear notes", method: "clear", confirm: "Delete every note of this project?" }] : [],
      };
      return { rows: [summary, ...latest(projectId, 49).map(noteRow)] };
    },
  },
},
```

The [example plugin](examples/notes/index.mjs) also has a chat section with the three latest notes.

Removed: the `web` capability (`web.script`, `web.style`, `web.sidebar`, `web.routes`) and `window.piProjects`. A plugin that still provides `web` loads without it, and the host logs one line saying so.
