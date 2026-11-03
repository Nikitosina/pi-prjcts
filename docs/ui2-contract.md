# UI 2.0 contract (branch `ui-2.0`)

This is the shared contract between three parallel workstreams: **backend** (tiers, profiles, host `ui` document, `/ui2` serving, creation auto-grant, verifier removal), **host agent** (the Host agent runtime and its RPCs) and **web** (the new client in `web-ui2/`). The plan and the owner's decisions are in `docs/ui2-plan.md`. Reference screenshots are in `docs/ui2-reference/`. Terms follow `CONTEXT.md`. New terms: **Host agent**, **Tier**, **Profile**.

If a workstream needs to change a shape below, edit this file in the same commit and say so in its handback.

## Conventions

- Every new request is a member of the closed `Request` union in `src/state.ts` and goes through `dispatch` in `src/host-server.ts`. The browser calls `POST /api` with the bearer token, exactly like `web/`.
- Validation fails before any runtime opens (ARCHITECTURE rule).
- Writes take a `revision` and refuse when it is stale (`{ error: "stale revision" }`-style errors in the existing format).
- Host-level change topics are published on the change feed under the reserved key `"host"`. The browser subscribes with `GET /changes?project=host` (same SSE framing as project changes). Host topics: `ui`, `tiers`, `host-agent`, `approvals`, `projects` (list changed).
- Enums are string literal unions, typed in TypeScript.

## Types

```ts
type ThinkingLevel = "off" | "low" | "medium" | "high" | "max"; // maps to pi-ai levels; "max" = the provider's highest
type ProfileId = "coordinator" | "worker" | "scout" | "reviewer"; // verifier is removed
type ThemeId = "claude" | "midnight" | "light" | "system";
type AnimationLevel = "off" | "subtle" | "full";
type FontId = "jetbrains-mono" | "system-sans" | "system-mono";

type Tier = {
  id: string;          // stable slug, e.g. "workhorse"
  name: string;        // "Workhorse"
  letter: string;      // one or two chars shown as a badge: "S+", "A", "C"
  models: string[];    // ordered "provider/model" refs; index 0 is preferred, the rest are the fallback order
};

type ProfileSettings = {
  tier?: string;            // Tier.id; absent = legacy per-role model fields keep working
  thinking?: ThinkingLevel; // absent = "medium" (today's hardcoded value)
  tools?: { disabled: string[] }; // tool names or group ids ("group:<id>") switched off for this profile
};

type UiSettings = {
  theme: ThemeId;                       // default "claude"
  font: FontId;                         // default "jetbrains-mono", including documents saved before this field
  animations: AnimationLevel;           // default "subtle"
  hotkeys: Record<string, string>;      // command id -> binding, only overrides of the defaults
  panels: { list: boolean; context: boolean; hostAgent: boolean };
  statusLine: boolean;                  // terminal-style bottom status line, default true
  statusItems: { id: StatusItemId; enabled: boolean }[]; // bar order: every id exactly once; default all shown in this order
  // StatusItemId: "activity" | "model" | "thinking" | "context" | "cost" | "limits" (all provider usage, one item)
  //             | "spacer" (pushes later items right) | "connection" | "hints". A missing field reads as the default;
  //             ui-set refuses an unknown, duplicate or missing id.
};
```

## Backend requests

| action | input | result |
| --- | --- | --- |
| `ui-get` | `{}` | `{ revision, ui: UiSettings }` |
| `ui-set` | `{ revision, patch: Partial<UiSettings> }` | `{ revision, ui }`, publishes host `ui` |
| `tiers-get` | `{}` | `{ revision, tiers: Tier[], catalog: { ref, name, provider, contextWindow, inputCost, outputCost, available }[] }` |
| `tiers-set` | `{ revision, tiers: Tier[] }` | `{ revision, tiers }`, validated against the live catalog, publishes host `tiers` |
| `profiles-get` | `{ projectId }` | `{ revision, profiles: Record<ProfileId, ProfileSettings & { effectiveModel: string \| null }> }` |
| `profiles-set` | `{ projectId, revision, profile: ProfileId, patch: ProfileSettings }` | same as get; goes through `settings-application.ts` with an `EFFECTS` entry (`profiles`: models and prompts). The patch replaces the fields it names; `revision` is the `settings-snapshot` revision |
| `profile-tools` | `{ projectId, profile: ProfileId }` | `{ groups: { id, label, source: "core" \| "plugin" \| "mcp" \| "skill", locked: boolean, tools: { name, description, parameters: unknown, enabled: boolean }[] }[] }` |
| `prompt-render` | `{ projectId, profile: ProfileId, chatId?, workerMode?: "job" \| "task" }`, or `{ profile: "host" }` | `{ sections: { id, label, source: string, editable: boolean, text: string, tokens: number }[], totalTokens, basis: "configured", label: "Configured for next use", active? }`; `active` (coordinator with `chatId`, and host) is `{ chatId, matchesConfigured: boolean, pending: boolean }` |
| `prompt-blocks-get` | `{ projectId?, target: "coordinator" \| "worker" \| "taskHelper" \| "scout" \| "reviewer" \| "host" }` (no `projectId` for `host`) | `{ scope: "project" \| "host", projectId, target, revision: string, customized, legacy, blocks: { id, name, kind: "builtin" \| "custom", enabled, text, defaultText: string \| null, edited, tokens }[], text, tokens, limits, application }` (docs/prompt-blocks.md) |
| `prompt-blocks-set` | `{ projectId?, target, revision, blocks: ({ id, enabled, text? } \| { id: "custom:<slug>", name, enabled, text })[] \| null }` | same as get; the list replaces the target's whole list, `null` restores the built-ins. Publishes project `settings` or host `host-agent`. Allowed for the Host agent, including its own target |
| `chat-stop` | `{ projectId, chatId?, reason? }` | `{ stopped: boolean, chatId }` aborts the running Coordinator turn of that chat (⌘.) like the other Stops: queued inputs withdrawn, history kept, the chat answers the next message, other chats and background agents keep running. `stopped: false` when the chat was idle. Publishes the chat topic; refuses an unknown chat and an archived or deleted project. Allowed for the Host agent. |
| `schedule-create` | existing input plus `name?` | the schedule, now with `name: string \| null` and `revision: number` (records saved before read as `null` and `0`) |
| `schedule-update` | `{ id, scheduleId, revision, name?: string \| null, text?, schedule?: { atMs, everyMs?, calendar? } }` | the schedule, `revision + 1`. `schedule` replaces kind and next run together; a one-shot that already ran cannot be rescheduled. Stale revision refused. `schedule-enable` also bumps the revision |
| `schedule-run` | `{ id, scheduleId }` | the run's outcome, like a due run. Runs enabled or not; a one-shot counts as run and is disabled; refused while a run of it is in flight |
| `schedule-delete` | `{ id, scheduleId, revision }` | `{ schedule }`, the deleted record. Dangerous for agents (approval); the owner's Undo is `schedule-restore` |
| `schedule-restore` | `{ id, scheduleId }` | the schedule, back exactly as it was (same id, revision, enabled). Within ten minutes of the delete; refused after, or when the id exists again |

Notes:
- Tier storage: `<home>/tiers.json`. On first read with no file, generate tiers from the current project models so nothing changes for existing projects.
- Quota or rate-limit failure moves to the next model of the profile's tier (all of them, in order, never back to a model already left), replacing the single `fallbackModels` move. Without a tier the legacy rule stays: only quota moves, once, to `fallbackModels`. Telegram `/model` keeps working on legacy fields; it may show tiers later.
- `profiles-set` refuses an unknown tier, a tier with no model that has credentials, and switching off a locked tool (`agents` and `owner_approval_request` for the coordinator, `job` for the worker). `skill:<name>` rows are the skill profile: switching one off stores it in the project's `skillProfiles.off[profile]` (not in `tools.disabled`), so the prompt's skills list, `projects_skill_file`, `profile-tools` and `profiles-get` all follow it; turning a skill on for one profile when it was off for all keeps it off for the others. `tiers-set` refuses a stale revision, duplicate ids or models, an uninstalled model, an empty tier and removing a tier a project uses.
- Thinking level replaces the hardcoded `"medium"` in `durable-runtime.ts` for each role.
- `profile-tools` must not contact MCP servers or allocate a workspace (same rule as the Tools/access panel). MCP servers appear as one group each with a write toggle as a pseudo-tool `mcp-writes:<server>`; skills appear as a `skill` group.
- `prompt-render` sections, in order (`id` in brackets): host contract [`host`] (locked), instance AGENTS.md [`instance`], repository instructions [`repository`], project instructions [`project`] (the old `objective`, editable), role instructions [`role`] (editable), "Preferences (memory)" [`preferences`] (locked), "Memory index" [`memory`] (locked), skills list [`skills`] (locked). Tokens are an estimate (chars/4), labelled as such in `source`. The role section is the assembled prompt blocks. Sections are the configured prompt for the next use, not what a running agent has; `chatId` adds whether that chat runs it (`active`). `workerMode: "task"` renders a task helper: its parts in prompt order, joined by the helper template rather than by blank lines.
- `create` grants the whole-repository workspace and GitHub access in the same step (reuse `workspace-quick-grant` / `github-quick-authorize` logic). A later revoke still shows a visible blocker.
- Verifier: workers run the verify skill themselves through `projects_verify_run`; no verifier subagent role is offered to new turns. Recorded verifier conversations still read. Turning verification on no longer needs `models.verifier`; the verifier prompt is no longer listed in `prompts-snapshot`.
- Static: `GET /ui2/` serves `web-ui2/index.html` and `/ui2/*` its files, with the same token, CSP and origin rules as `web/`.

## Host agent requests

| action | input | result |
| --- | --- | --- |
| `host-agent-history` | `{ before?: number }` | a `TranscriptPage` (same shape as `chat-history`) |
| `host-agent-send` | `{ requestId, text }` | `{ accepted: true }`; queues as a steer when busy |
| `host-agent-stop` | `{}` | `{ stopped: boolean }` |
| `host-agent-reset` | `{}` | `{ ok: true }` (new context, history kept, like the reference "New session") |
| `host-agent-settings` | `{ revision?, patch?: { model?, tier?: string \| null, thinking?, disabledTools?: string[] } }` | `{ revision: number, model, tier, thinking, disabledTools, effectiveModel, tools: { name, description, dangerous: boolean }[], actions: { name, description, dangerous: boolean }[] }` |
| `approvals-list` | `{}` | `{ approvals: Approval[] }` |
| `approval-decide` | `{ id, decision: "approve" \| "deny", note? }` | `{ approval: Approval }` |

- Approval is per request, not only per action: `deploy-settings` that turns on idle auto-deploy, and a `plugin` call the plugin does not declare `read` or `write` in its `rpcPolicy` (PLUGINS.md), need approval like the dangerous actions.
- Agent-facing results and approval outcomes redact secrets (`webhook.secret`, Telegram `pairing.code`, `secret`/`token`/`apiKey`/`password` fields) as `"[redacted]"`; the browser gets the real values.

```ts
type Approval = {
  id: string;
  requestedBy: { kind: "host-agent" } | { kind: "coordinator"; projectId: string; chatId: string };
  action: string;      // Request action name, e.g. "delete"
  input: unknown;      // the exact validated request that will run
  summary: string;     // one line written by the agent
  state: "pending" | "approved" | "denied" | "done" | "failed";
  at: string;
  result?: unknown;
};
```

- Settings: `model` is a plain `"provider/model"` ref checked against the live catalog. `effectiveModel` is the set model, else the tier's first model, else the newest active project's model (null when there is none, and send refuses). `tier: null` clears the tier; `model: null` clears the pin so the tier applies, and a patch that sets a tier without naming `model` clears the pin too. `tools` are the Host agent's own tools (what `disabledTools` names); `actions` are the host actions behind `host_call`. A patch needs the current `revision`.
- Live streaming: `GET /live?project=host` streams the same frame shape as a coordinator chat's live stream (text, thinking, tools with status and duration).
- Tools for the Host agent are generated from an allow-list over `Request` actions (`src/host-agent-tools.ts`): one `host_call { action, input }` tool validated with `Request`, one `host_actions` tool that lists allowed actions with their input schema and a one-line description, plus `ui_focus { view, projectId?, chatId?, section? }` and `ui_set` (wraps `ui-set`). A script asserts every `Request` action is either allowed, marked dangerous, or explicitly excluded with a reason.
- Dangerous actions (at least: `delete`, `archive`, `remove`, `job-approve`, `deploy-start`, `workspace-revoke`, `github-revoke`, `telegram-unpair`, `upload-delete`, `worktrees-cleanup`, `remote-revoke`) create a pending `Approval` instead of running. The tool returns at once with the approval id. When the owner decides, the host runs the stored request (on approve) and posts the outcome to the Host agent as a follow-up.
- `ui_focus` publishes a host `host-agent` frame `{ t: "topic", topic: "host-agent", type: "focus", view, projectId?, chatId?, section? }`; the browser follows it, except that Settings views (`settings` or a section name) never open by themselves: the owner gets a toast with Open settings. Other `host-agent` frames (no `type`) mean history or settings changed: refetch.
- Also dangerous: `webhook-rotate`, `telegram-remove`. Excluded with reasons in `ACTION_POLICY`: `web`, `telegram-token`, `telegram-pair`, `remote-pair-start`, `cursor-connect`, `transcript-image`, `archive-image`, `work-submit`, `shutdown`, `deploy-shutdown`, the `host-agent-*` controls except settings, and `approval-decide`. `remove` has no request yet.
- Coordinators get the same gate through the tool `owner_approval_request { action, input, summary }`. It accepts only dangerous actions, files an `Approval` with `requestedBy: { kind: "coordinator", projectId, chatId }` and returns at once. The outcome is posted to that chat as an internal follow-up (Main when the chat is gone). Outcome messages start with `[approval <id>]`.
- Storage: `<home>/host-agent/` with its own pi-durable storage, opened only by the host.

## Web client (`web-ui2/`)

- Plain ES modules, no build step, same as `web/`. Shares nothing at runtime with `web/` except copied helpers (escaping, markdown); escape everything from providers, transcripts and plugins.
- Uses existing reads for projects, chats, jobs, settings, knowledge, automations, limits, PRs and live frames. Uses the requests above for the new parts.
- Hotkeys come from one registry (`web-ui2/hotkeys.js`) whose bindings are merged from defaults and `UiSettings.hotkeys`.

## Memory (knowledge reimagined)

Owned by the backend workstream (requests, prompt brief, coordinator prompt) and the web workstream (Memory view, chat rows). See "Knowledge → Memory" in `docs/ui2-plan.md`.

```ts
type MemoryKind = "preference" | "decision" | "procedure" | "archive";
type MemoryStatus = "current" | "superseded" | "historical";
type MemoryEntry = {
  path: string;            // relative to knowledge/
  kind: MemoryKind;
  title: string;
  summary: string;         // one line
  status: MemoryStatus;
  supersededBy?: string;   // path
  revision: string;
  updatedAt: string;
  source?: { chatId?: string; conversationId?: string; entryId?: number };
  lastConfirmedAt?: string;
};
```

| action | input | result |
| --- | --- | --- |
| `memory-index` | `{ projectId, includeArchive?: boolean }` | `{ entries: MemoryEntry[], brokenLinks: { from: string, to: string }[] }` |
| `memory-undo` | `{ projectId, path, revision }` | `{ entry: MemoryEntry \| null }` restores the previous revision (or removes a just-created entry) |
| `memory-recent` | `{ projectId }` | `{ writes: { path, revision, author, updatedAt, created: boolean, undone: boolean, current: boolean }[] }`, newest first, at most 50, undo records left out. `undone`: `memory-undo` reverted this write; `current`: it is still the entry's revision, so Undo is offered only when `current && !undone`. Reloaded chat rows retain Undone and stale-write state. |

- Kind, status, summary, supersededBy and source live in optional YAML front matter. Without it, classify by folder on read (`preferences.md` → preference, `decisions/` → decision, `MEMORY.md`, `research/` (legacy included), `plans/` and UUID-named notes → archive, everything else, `runbooks/` included → procedure). Malformed front matter is ignored and the folder rule applies. Never move or rewrite the owner's existing files during a read.
- The index replaces the hand-written `MEMORY.md` injection: titles plus summaries, archive and preferences excluded, superseded decisions marked with their replacement, bounded (3,000 chars). It is the `prompt-render` section "Memory index". `brokenLinks` lists relative `.md` links and `supersededBy` targets that do not exist; external links are ignored.
- `memory-undo` is itself a revision (author `memory-undo`) and refuses a revision that is no longer current.
- Current preferences (bounded, e.g. 4,000 chars, with revision) are injected into every role prompt as their own `prompt-render` section "Preferences (memory)".
- Coordinator prompt: when the owner corrects something or states a lasting preference, save it as a preference without asking (YOLO), keep review packets and statuses out of memory, mark replaced decisions superseded instead of adding correction documents. Memory never grants execution authority.
- Chat rendering: knowledge tool calls render as memory rows: a write as "Remembered: <title> · Undo · Edit", a read as "Used memory: <kind> · <title>", linking to the entry in the Memory view.

## Appearance and transcript diagnostics

- JetBrains Mono is bundled locally as a variable woff2 with its SIL OFL license; no runtime CDN. `font` applies across the app, with System sans and System mono alternatives and local fallbacks. `/ui2/*.woff2` is served as `font/woff2`; CSP allows only same-origin fonts.
- PR36 live frames may include `nested: { running: string[], done: number, failed: number }`. A running codemode tool row summarizes these without expanding the row.
- `show.context.compactionFailure` remains visible as a quiet status-line warning and an expandable, bounded error in Settings → Context; it is not inserted into the primary chat transcript.
