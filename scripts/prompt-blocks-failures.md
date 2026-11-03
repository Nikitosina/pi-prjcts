# Prompt blocks: failure cases

Written before `src/prompt-blocks.ts`. `scripts/prompt-blocks-unit.mjs` covers B1–B10; `scripts/prompt-blocks-e2e.mjs` covers P1–P15 against a private host with the fake provider.

## Resolver (unit)

- B1 With nothing saved, a target's behavior text differs from today's prompt: the four role prompts, the Host agent prompt and the task helper instructions must stay byte-identical.
- B2 A legacy `project.prompts[role]` override is lost, or shown as a default. It must assemble to exactly the old text, be marked `legacy`, and reach a task helper as "Owner worker instructions" like before.
- B3 The saved list and the resolved order disagree, or a disabled block's text still reaches the prompt.
- B4 A duplicate id, an unknown or missing built-in, a bad custom id, a custom block without a name or text, a renamed built-in, or an over-limit list (block count, custom count, block size, aggregate size) is accepted.
- B5 Saving a built-in's default text, or omitting its text, stores a copy of the default instead of no override.
- B6 A list saved before a new built-in existed loses that built-in, instead of keeping it enabled at its default position.
- B7 A worker's frozen frame (repository, workspace, skills, host contract) changes when only behavior blocks change, or composing a frame gives different text from the configured sections.
- B8 Built-in authority text (`SHARED_ROLE_RULES`, the coordinator context rules) becomes an editable block, so turning blocks off removes authority rules.
- B9 A built-in behavior block cannot be edited or turned off (the owner chose editable built-in behavior; only generated authority and capability text stays fixed, outside blocks).
- B10 The coordinator's context-management habits (read reports first, read by path and range, brief with refs, when to reread) are fixed in the host contract instead of an editable coordinator block; or moving them loses or duplicates a sentence of today's prompt; or the generated fact (tool answers stay until compaction) and the guard (habits never replace a required skill read, proof or evidence check) leave the host contract; or a legacy coordinator override loses the habits it ran with before, or the older per-role editor saves the habits into an override so they appear twice.

## Runtime and requests (e2e)

- P1 `prompt-blocks-get` on a fresh project shows the built-ins, uncustomized, with token estimates; `prompt-render` role text equals the assembled blocks.
- P2 A stale revision, or any list refused by B4, changes `project.json`.
- P3 A saved custom block, a disabled block and a new order do not reach the next coordinator request, or the host contract and authority rules disappear from it.
- P4 A new worker, scout or reviewer does not start with the saved blocks.
- P5 A follow-up to a worker that already ran keeps its old behavior, instead of adopting the saved blocks on that turn.
- P6 Adopting behavior changes the worker's frozen repository instructions (AGENTS.md changed and the host restarted), its workspace instructions, or its skills.
- P7 A message sent while a worker's turn is running changes that turn's instructions.
- P8 A worker prepared by a host without frames (an older version) never adopts behavior even though its stored prompt is exactly reconstructable, or adopts it with a guessed frame when it is not, or is not reported `frozen` with a reason (scripts/prompt-blocks-legacy-e2e.mjs, a home prepared by base 9f4ee13).
- P9 `prompt-blocks-set` with `blocks: null` leaves a saved list or a legacy override behind.
- P10 A legacy override set through `settings-update` and a saved block list both apply, instead of the later write replacing the other.
- P11 The Host agent's own blocks do not reach its next turn, or a self-edit through `host_call` changes the instructions of the turn that made it.
- P12 Editing the Host agent's prompt (by the owner or by itself) changes its tools or lets `host_call` run an action the policy excludes or gates.
- P13 `prompt-render` drops `chatId`, or calls a configured prompt active when the chat still runs an older one.
- P14 Owner and Host agent saves do not publish a change topic, so open views go stale.
- P15 An edited coordinator context-habits block does not reach the next coordinator request, or editing it removes the generated context fact and guard from the host contract.
