# Prompt blocks

`src/prompt-blocks.ts` owns the editable behavior part of every agent prompt: ordered, named blocks per prompt target. The owner edits them in Settings → Prompt; the Host agent edits them with the same requests through `host_call`. Failure cases: `scripts/prompt-blocks-failures.md`.

## What is editable

- Targets: `coordinator`, `worker` (independent Job worker), `taskHelper` (a worker in a chat's shared or isolated workspace), `scout`, `reviewer` per project, and `host` (the Host agent's own prompt).
- Built-in blocks are the lines of the built-in prompts in `role-prompts.ts`, each with a stable id and name. Every built-in can be edited, turned off and moved. Custom blocks have ids `custom:<slug>` (lowercase letters, digits and dashes, 1–48 characters), a name and text.
- Not blocks, and not editable here: the host contract (`SHARED_ROLE_RULES`, the coordinator context rules, grants and plugin rules), instance and repository instructions, project instructions (Settings → objective), the preferences brief, the memory index, skill indexes and workspace bindings. Prose never grants or removes a tool: tools, the `host_call` policy and owner approvals are enforced in code.
- Limits: 32 blocks, 16 custom blocks, 12,000 characters per block, 24,000 characters of enabled text per target, 80-character names.

## Resolution

One resolver, `resolvePromptBlocks`, serves runtime and preview:

1. A saved list for the target (`project.promptBlocks[target]`, or `promptBlocks` in `<home>/host-agent/settings.json`).
2. Else a legacy `project.prompts[role]` override: one block `custom:legacy` ("Earlier owner instructions") with the old text, over the built-ins turned off. It assembles to exactly the old text.
3. Else the built-ins, which assemble byte-identically to the prompts before blocks existed.

The enabled blocks are joined one per line, in list order. A list saved before a built-in existed gets that built-in, enabled, after the built-in that precedes it by default. A task helper's behavior is the owner's enabled custom worker blocks as "Owner worker instructions", then the task-helper blocks; edited worker built-ins (the Job workflow) do not reach task helpers.

## Saving

- A save replaces the target's whole ordered list. A built-in sent without text, or with its default text, is stored without text. A list equal to the defaults stores nothing. `null` restores the built-ins and removes a legacy override.
- Refused, with an error starting `Prompt blocks:`: a duplicate id, an unknown or missing built-in (turn it off instead), a malformed custom id, a custom block without a name or text, a renamed built-in, and anything over the limits.
- Per target the later write wins: saving blocks removes that role's legacy override, and a legacy `settings-update` `prompts` write removes that role's blocks.
- Project targets save through `settings-update` (field `promptBlocks`), so they share the settings revision and its stale-revision refusal (`Settings revision conflict; reread before updating`). The host target shares the Host agent settings revision (`Host agent settings changed (stale revision); reload and retry`).

## When running agents adopt a save

- Coordinator chats: rebuilt from the saved project at once when idle; a working chat is marked stale and rebuilt before its next owner message. `prompt-render` with `chatId` reports `active.matchesConfigured` (the chat runs exactly the configured instructions) and `active.pending` (it is stale and adopts before its next message).
- Host agent: its instructions change only between turns. A save during a turn, including its own `host_call`, leaves that turn's instructions alone and applies when the turn ends or before the next message. `application.pending` and `prompt-render` `active` say whether it still runs older instructions.
- New workers, task helpers, scouts and reviewers start with the saved blocks.
