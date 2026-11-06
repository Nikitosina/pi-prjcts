# Prompt blocks

`src/prompt-blocks.ts` owns the editable behavior part of every agent prompt: ordered, named blocks per prompt target. The owner edits them in Settings → Prompt; the Host agent edits them with the same requests through `host_call`. Failure cases: `scripts/prompt-blocks-failures.md`.

## What is editable

- Targets: `coordinator`, `worker`, `scout`, `reviewer`, `contract` and `integrations` per project, and `host` (the Host agent's own prompt). One `worker` list serves both kinds of worker: its `delivery-pr` block (mode `job`) reaches only independent Job workers, its `delivery-return` block (mode `helper`) only task helpers, every other block both. The retired `taskHelper` target is read so older projects load, and is never applied.
- `contract` is the host contract every project role reads after its generated role line (`authority`, required; `evidence`). `integrations` are the coordinator's tool rules (`questions`, `library`, `github`, `gh`, `mcp`, and one `plugin:<plugin name>` block per plugin that declares `coordinatorTools.prompt`). Settings → Prompt lists both as their own groups on each role's tab.
- An integration block has a `grant`: it reaches the prompt only while that grant is on (`active`), and turning it off removes the text, never the tool. A plugin without `prompt` keeps its older `instructions(project)` text as locked generated text.
- Contract, integration and role text may use the placeholders `{project}`, `{projectId}` and `{githubRepos}`, filled per project at assembly. A save with any other `{name}` is refused (the Host agent target has no placeholders).
- Built-in blocks are the sections of `ROLE_BLOCKS` in `role-prompts.ts`, each with a stable id and name. Every built-in can be edited and moved; every built-in except a `required` one (the worker's two delivery blocks, the contract's authority) can be turned off. The coordinator's context habits (read by path and range, when to reread) are its `context` block; they were host text before, so a legacy coordinator override keeps that block on, and the older per-role editor (`prompts-snapshot` `default`, `override`, `effective`) shows and saves the role text without it. Custom blocks have ids `custom:<slug>` (lowercase letters, digits and dashes, 1–48 characters), a name and text.
- Not blocks, and not editable here: the role line ("You are the … for …"), the coordinator context fact and guard (`COORDINATOR_CONTEXT_RULES`), work rules and the verification line, instance and repository instructions (AGENTS.md), project instructions (Settings → objective), the preferences brief, skill indexes and workspace bindings. No memory index reaches a prompt. Prose never grants or removes a tool: tools, the `host_call` policy and owner approvals are enforced in code.
- Limits: 32 blocks, 16 custom blocks, 12,000 characters per block, 24,000 characters of enabled text per target, 80-character names.

## Resolution

One resolver, `resolvePromptBlocks`, serves runtime and preview:

1. A saved list for the target (`project.promptBlocks[target]`, or `promptBlocks` in `<home>/host-agent/settings.json`).
2. Else a legacy `project.prompts[role]` override: one block `custom:legacy` ("Earlier owner instructions") with the old text, over the built-ins turned off. It assembles to exactly the old text.
3. Else the built-ins, which assemble byte-identically to the prompts before blocks existed.

The enabled blocks are joined with one blank line between them, in list order (a worker's: those of its mode). A list saved before a built-in existed gets that built-in, enabled, after the built-in that precedes it by default. A legacy worker override keeps both delivery blocks on, so each kind of worker still gets its own delivery after the old text.

## Saving

- A save replaces the target's whole ordered list. A built-in sent without text, or with its default text, is stored without text. A list equal to the defaults stores nothing. `null` restores the built-ins and removes a legacy override.
- Refused, with an error starting `Prompt blocks:`: a required block turned off, a duplicate id, an unknown or missing built-in (turn it off instead), a malformed custom id, a custom block without a name or text, a renamed built-in, and anything over the limits.
- Per target the later write wins: saving blocks removes that role's legacy override, and a legacy `settings-update` `prompts` write removes that role's blocks.
- Project targets save through `settings-update` (field `promptBlocks`), so they share the settings revision and its stale-revision refusal (`Settings revision conflict; reread before updating`). The host target shares the Host agent settings revision (`Host agent settings changed (stale revision); reload and retry`).

## When running agents adopt a save

- Coordinator chats: rebuilt from the saved project at once when idle; a working chat is marked stale and rebuilt before its next owner message. `prompt-render` with `chatId` reports `active.matchesConfigured` (the chat runs exactly the configured instructions) and `active.pending` (it is stale and adopts before its next message).
- Host agent: its instructions change only between turns. A save during a turn, including its own `host_call`, leaves that turn's instructions alone and applies when the turn ends or before the next message. `application.pending` and `prompt-render` `active` say whether it still runs older instructions.
- New workers, task helpers, scouts and reviewers start with the saved blocks.
- The contract is part of each agent's frame (below): coordinator chats adopt it before their next message, other agents only when they start after the save (`application.adopts` `next-message-and-new-agents`). Integrations adopt like the coordinator's blocks.
- Existing workers, task helpers, scouts and reviewers adopt the saved behavior on their next continued or retried turn (a follow-up, a retry, or a resume), and only while their conversation is idle: no run, no queued input, no compaction. A message sent during a running turn leaves that turn's instructions alone; the agent stays `pending` until a later idle turn.
- What they keep is their frame, stored per agent conversation (`projects.agent-prompt`) when the host first prepares it: the host contract with its grants, repository instructions frozen for the thread, project instructions, the skill index, authority rules and workspace bindings. Adoption recomposes that frame with the current behavior text; nothing is parsed out of a stored prompt.
- `jobs-snapshot` `agents[].prompt` is per agent: `{ state: "current" | "pending" | "legacy-unchecked" | "frozen", reason }`. `current` runs the saved behavior (or has not started yet), `pending` adopts on its next idle turn, `legacy-unchecked` was prepared before frames existed and has not had a turn since, `frozen` was prepared before frames and its stored prompt could not be proven (the reason says why); it keeps the prompt it started with.
- Proof for an agent prepared before frames: on its next continued or retried turn the host rebuilds its frame from the current inputs and composes it with each behavior it could have started with (the current blocks, the built-ins, the legacy override or the kept `custom:legacy` text). Only an exact match with its stored instructions records the frame; then it adopts like any other agent. Nothing is parsed out of the stored prompt. Proof fails when an input changed since it was prepared: AGENTS.md, the objective, grants, the skill index, its workspace binding, or an override that is gone. Such an agent is `frozen`; the next turn checks again.
