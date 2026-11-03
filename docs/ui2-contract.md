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
  animations: AnimationLevel;           // default "subtle"
  hotkeys: Record<string, string>;      // command id -> binding, only overrides of the defaults
  panels: { list: boolean; context: boolean; hostAgent: boolean };
  statusLine: boolean;                  // terminal-style bottom status line, default true
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
| `profiles-set` | `{ projectId, revision, profile: ProfileId, patch: ProfileSettings }` | same as get; goes through `settings-application.ts` with an `EFFECTS` entry |
| `profile-tools` | `{ projectId, profile: ProfileId }` | `{ groups: { id, label, source: "core" \| "plugin" \| "mcp" \| "skill", locked: boolean, tools: { name, description, parameters: unknown, enabled: boolean }[] }[] }` |
| `prompt-render` | `{ projectId, profile: ProfileId, chatId? }` | `{ sections: { id, label, source: string, editable: boolean, text: string, tokens: number }[], totalTokens }` |
| `chat-stop` | `{ id, chatId? }` | `{ stopped: boolean }` aborts the running Coordinator turn of that chat (⌘.); history kept. Added by the web workstream: no existing request stops a Coordinator turn. |

Notes:
- Tier storage: `<home>/tiers.json`. On first read with no file, generate tiers from the current project models so nothing changes for existing projects.
- Quota or retryable provider failure moves to the next model of the profile's tier (all of them, in order), replacing the single `fallbackModels` move. Telegram `/model` keeps working on legacy fields; it may show tiers later.
- Thinking level replaces the hardcoded `"medium"` in `durable-runtime.ts` for each role.
- `profile-tools` must not contact MCP servers or allocate a workspace (same rule as the Tools/access panel). MCP servers appear as one group each with a write toggle as a pseudo-tool `mcp-writes:<server>`; skills appear as a `skill` group.
- `prompt-render` sections, in order: host contract (locked), instance AGENTS.md, repository instructions, project instructions (the old `objective`, editable), role instructions (editable), skills list (locked). Tokens may be an estimate (chars/4) and must be labelled as such in `source`.
- `create` grants the whole-repository workspace and GitHub access in the same step (reuse `workspace-quick-grant` / `github-quick-authorize` logic). A later revoke still shows a visible blocker.
- Verifier: workers run the verify skill themselves through `projects_verify_run`; no verifier subagent role is offered to new turns. Recorded verifier conversations still read.
- Static: `GET /ui2/` serves `web-ui2/index.html` and `/ui2/*` its files, with the same token, CSP and origin rules as `web/`.

## Host agent requests

| action | input | result |
| --- | --- | --- |
| `host-agent-history` | `{ before?: number }` | a `TranscriptPage` (same shape as `chat-history`) |
| `host-agent-send` | `{ requestId, text }` | `{ accepted: true }`; queues as a steer when busy |
| `host-agent-stop` | `{}` | `{ stopped: boolean }` |
| `host-agent-reset` | `{}` | `{ ok: true }` (new context, history kept, like the reference "New session") |
| `host-agent-settings` | `{ revision?, patch?: { tier?, thinking?, disabledTools?: string[] } }` | `{ revision, tier, thinking, disabledTools, effectiveModel, tools: { name, description, dangerous: boolean }[] }` |
| `approvals-list` | `{}` | `{ approvals: Approval[] }` |
| `approval-decide` | `{ id, decision: "approve" \| "deny", note? }` | `{ approval: Approval }` |

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

- Live streaming: `GET /live?project=host` streams the same frame shape as a coordinator chat's live stream (text, thinking, tools with status and duration).
- Tools for the Host agent are generated from an allow-list over `Request` actions (`src/host-agent-tools.ts`): one `host_call { action, input }` tool validated with `Request`, one `host_actions` tool that lists allowed actions with their input schema and a one-line description, plus `ui_focus { view, projectId?, chatId?, section? }` and `ui_set` (wraps `ui-set`). A script asserts every `Request` action is either allowed, marked dangerous, or explicitly excluded with a reason.
- Dangerous actions (at least: `delete`, `archive`, `remove`, `job-approve`, `deploy-start`, `workspace-revoke`, `github-revoke`, `telegram-unpair`, `upload-delete`, `worktrees-cleanup`, `remote-revoke`) create a pending `Approval` instead of running. The tool returns at once with the approval id. When the owner decides, the host runs the stored request (on approve) and posts the outcome to the Host agent as a follow-up.
- `ui_focus` publishes a host `host-agent` frame `{ type: "focus", ... }`; the browser follows it.
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

- Kind, status, summary, supersededBy and source live in optional YAML front matter. Without it, classify by folder on read (`preferences.md` → preference, `decisions/` → decision, `runbooks/` → procedure, `research/legacy/`, `plans/` and UUID-named notes → archive). Never move or rewrite the owner's existing files during a read.
- The index replaces the hand-written `MEMORY.md` injection: titles plus summaries, archive excluded.
- Current preferences (bounded, e.g. 4,000 chars, with revision) are injected into every role prompt as their own `prompt-render` section "Preferences (memory)".
- Coordinator prompt: when the owner corrects something or states a lasting preference, save it as a preference without asking (YOLO), keep review packets and statuses out of memory, mark replaced decisions superseded instead of adding correction documents. Memory never grants execution authority.
- Chat rendering: knowledge tool calls render as memory rows: a write as "Remembered: <title> · Undo · Edit", a read as "Used memory: <kind> · <title>", linking to the entry in the Memory view.
