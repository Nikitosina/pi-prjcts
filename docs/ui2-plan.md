---
created at: 2026-11-03
tags:
---
Reference: https://youtu.be/1v7ldJiyH-Y?si=uUkcrUVlb-GFLhoS

![[Tiny Software Factories Agentic Engineering DONE WRONG.txt]]
## Problem
Current pi-prjcts UI is cluttered with noise UI controls which makes it hard for owner to work inside of it, specifically:
- Coordinator chat window does not show which tools are called
- Workers card contains one line header for each worker which makes it hard to understand at what stage each worker is currently at a glance; same for the model used by a worker
- UI is not extensible; there is no "master" agent which would have had the same tools as human does over all the projects and UI
- Left bar: hard to read because chats are visually separated from projects. Noisy buttons "open project by ID", "Old host archive", "tools/access" which should not be on a primary screen
- No hotkeys for quick switching/primary actions
- No sweet animations/transitions
- No themes to switch between, only claude-style UI
- No model tiers list, only 1 model per coordinator/worker
- Knowledge seems to be cluttered, not sure it helps human or agent to work better
- Observability tab is extremely noisy. Needs to be reimagined from ground-up or removed for now
- Settings:
	- Owner setup: remove as a concept, when a project is made, it is automatically authorized
	- cannot select group of models per tier and assign a tier (pool of models) to a profile, no separate "fallback" model. Solution: When quota on first model in tier list exhausts, automatically continue the work on next configured
	- verifier profile is useless, let worker verify its own work
	- Is objective of a project even used in any way? If not, remove
	- Too many subtitles which create UI noise, I would wrap them under "circled ?"
	- Separate "Access to project functions" is weird. Instead, I (and the "master" agent) want to control which tools every profile has, easily inspectable
	- Skills and MCP servers are fine logically, but I want a simpler and more modern UI to control the selection
	- Worktrees section: does not really help me, rather let coordinator manage them. Button "Clean up worktrees" always shows "0 KB"
	- Context and compaction is not UI friendly, needs to be refined
	- Automations UI is also hard to read and cluttered with subtitles
	- Overall: take a lot of inspiration from referenced video's settings

### Found while reviewing the code
- Settings is one long scroll page of 14 sections that mixes project settings (Skills, MCP, Context, Prompts, Automations) with host-wide ones (Notifications, Remote access, Deploy, Appearance, Providers). Nothing tells which scope a section changes
- Right column stacks up to five cards (Workers, Needs you, Pull requests, plugin cards, Knowledge preview) next to the chat. A coordinator question shows in three places: in the transcript, in the "asked you a question" hint and in the Needs you card
- No global "who is working now" signal: to see whether anything runs, the owner opens each project. The reference shows agent status in the top bar ("Answering you")
- Two navigations for chats: the tab strip above the header and the Chats list in the left bar
- Rare actions sit on the primary header: Pause, Resume and the ⋯ menu (archive/delete/restore), which also repeats as the Danger zone
- Hotkeys that exist (⌘B, ⌘K and a few more) are spread across 8 separate `keydown` listeners, cannot be listed and cannot be changed
- No thinking level setting at all, for any role
- Prompts: only role instructions are editable, and the owner cannot see the full prompt the agent actually gets (host contracts, instance AGENTS.md, repo AGENTS.md, skills list) or its size in tokens
- Context use is a tiny ring in the composer; compaction thresholds hide in an "Override" fold
- Knowledge tab mixes four unrelated things: memory documents, uploads, evidence and the workspace path
- Automations: "toggling always asks for confirmation", which adds a dialog to a reversible action
- Objective is used: it goes into every role prompt as "Project instructions" (`durable-runtime.ts`, `role-prompts.ts`). It duplicates the repo's AGENTS.md and is hidden from the owner's view of the prompt
- Owner preferences (theme, sidebar state) live in browser localStorage, so the agent cannot change them and they differ between browsers

## Solution

### Principles (taken from the reference)
1. **List on the left, focus in the center, agent at hand.** Every screen has the same three areas, and each can be toggled with a hotkey.
2. **Agent access parity.** Every control the owner has, the Host agent has as a tool. A control without a tool is a bug.
3. **Core four per profile.** Context, Model, Prompt, Tools. They are the main settings, not one item among fourteen.
4. **Quiet by default.** At most one line of description per section. Everything else goes behind a ⓘ popover.
5. **Keyboard first.** Every view and primary action has a hotkey, shown next to it, and the owner can rebind it.

### Layout
- **Left: list.** Projects with their chats nested under them in one tree. Each project and chat row shows a status dot (idle, working, needs you) and an unread mark. The "New project" button stays at the top. "Open project by ID", "Old host archive" and "Tools/access" leave the left bar: the first two move into the ⌘K command palette, and Tools/access moves into Settings → Tools.
- **Center: focus.** The selected chat by default. A worker transcript, Job report, knowledge document or setting opens here too and closes with Esc, which brings the chat back.
- **Right: context panel.** It shows the selected chat's Jobs, PRs and plugin cards, and it can be collapsed. Questions that need an answer live only in the transcript, as an answer form pinned above the composer, plus a count badge on the chat row. The Needs you card and the question hint are removed.
- **Top bar:** project name, a global status pill ("2 working · 1 needs you", click to jump), panel toggles, search and settings. Pause/Resume and the ⋯ menu leave the header and move to the command palette and Settings → Project.
- **Chat tabs** (the tab strip) are removed, because the left tree already does that job.
- **Host agent drawer** (see below) opens from any screen with a hotkey.

### Coordinator chat: show tool calls
- Each tool call is one compact row, as in the reference: status icon, tool name, a short argument summary, duration. Running calls show a spinner. Clicking a row expands its parameters and a bounded result preview, read through `transcript-reader` with no full-result stringify.
- Consecutive calls in one turn fold into a group ("read ×4, bash ×2 · 3.1s") once the turn ends. The live turn stays expanded.
- Thinking shows as a one-line "Thinking" marker that expands on click.
- Spawn and report events (`agents spawn`, a worker's handback) show as rows that link to the worker, not as text.
- This changes the web rule in `ARCHITECTURE.md` ("Coordinator chat ... hiding tool diagnostics"). Update that rule in the same change. Internal reports, reset handoffs and owner-origin parsing rules stay as they are.

### Workers card
Each worker is a block of two or three lines instead of one header line:
- Line 1: role icon, name, state colour, model chip (tier letter + short model name; the full name in a tooltip).
- Line 2: current plan step ("3/5 · Running verify skill"), a progress bar and ETA from `plan`.
- Line 3, only while running: the last tool call row, live.
- Stalled, failed and Ready states get one clear badge and one primary action (Open, Approve, Steer).

### Host agent (the "master" agent)
- A new term for `CONTEXT.md`: **Host agent**, the owner's agent over the whole host. It is not a Coordinator, does not own delivery and has no project workspace.
- It runs as one conversation in host-level durable storage (`<home>/host/durable.sqlite`). The host still owns all storage, as the architecture requires.
- **Tools come from the request schema.** The host already has one closed request union (`state.ts`) and one `dispatch`. Generate the Host agent's tools from an allow-list of those actions: list and create projects, send to a chat, read status, read and change settings, profiles, tiers, tools, automations, theme, hotkeys and layout. A new UI action then needs one allow-list line to reach the agent, and a test fails if a web action has no entry and no stated exclusion.
- **UI state moves to the host.** Theme, hotkeys, panel layout, nav bar items and animation level are stored host-side as one `ui` settings document and pushed through the change feed on a new `ui` topic. Then the agent can change them, and they are the same in every browser. Per-browser items (notification permission, last seen) stay in localStorage.
- **Owner-only actions stay owner-only:** Approve, Deploy, delete project, final merge. The agent may prepare them and show a button. It never presses it.

### Settings: rebuilt around the core four
Settings becomes an overlay (⌘,) with a left nav and a hotkey letter beside each item, as in the reference. Every item carries a scope label: **Project** or **Host**.

**Project**
- **General** (G): name, workspace path, Pause/Resume, Archive/Delete/Restore. Replaces Owner setup, Project and Danger zone.
- **Profile picker** at the top of the core four: Coordinator, Worker, Scout, Reviewer. Each tab edits that profile's core four.
- **Context** (C): one bar per profile, as in the reference: current use, a draggable auto-compaction mark, a force mark, the window size. "Compact now" sits next to it. The window override is a small ⓘ-guarded field, not a fold.
- **Model** (M): pick a tier and a thinking level (off, low, medium, high, max). The tier list shows context size and price per model.
- **Prompt** (P): "Rendered" view of the full assembled prompt, in sections with their source and token count: host contract (locked), instance AGENTS.md, repo AGENTS.md, project instructions, role instructions, skills list. "Edit" opens only the editable sections. The old *objective* becomes the editable "Project instructions" section, and the separate field is removed from the create form and from settings.
- **Tools** (T): one grid of toggles per profile, grouped by source: Coding (read, write, edit, bash), Delegation (`agents`), Job, Knowledge, GitHub, Archive, each plugin, each MCP server (with an "allow writes" switch per server), Skills. Search, plus a Title / Description / Params view switch. This replaces "Access to project functions", the Skills section, the MCP section and the Tools/access panel. The grid shows what the profile is actually offered, so it is easy to inspect.
- **Automations** (R): one card per automation, as in the reference Cron page: name, schedule in words plus cron, prompt preview, on/off switch, last run, then Run now, History, Edit, Delete. Follow PRs and webhooks show as cards of the same shape, with the target chat. Toggling no longer asks for confirmation; it shows an Undo toast.

**Host**
- **Model tiers** (I): named tiers, each an ordered list of models (for example Top, Workhorse, Light). A profile picks a tier. When a model's quota runs out or its provider fails as retryable, work continues on the next model in the tier, and the chat gets a one-line notice. This replaces `fallbackModels` and the per-role single model. Migration maps each current role model plus fallback to a generated tier. Telegram `/model` picks a tier.
- **Theme** (H): Claude (current), Midnight, Light, and System, which follows the OS. Themes are CSS variable sets, so adding one is a JSON object.
- **Animations** (A): off / subtle / full. Respects `prefers-reduced-motion`.
- **Hotkeys** (?): every binding in one list, with Edit.
- **Notifications**, **Remote access**, **Deploy**, **Providers**: same content. Their long descriptions move behind ⓘ.

### Removed
- **Owner setup.** Creating a project grants the whole-repository workspace and the default command profile in the same step. A grant that is later revoked or broken still fails visibly in the chat, so the "no silent fallback" rule stays.
- **Verifier profile.** The worker runs the verify skill itself and records runs with `projects_verify_run`. `checkProofRefs` still checks the proof on Ready. Review by a fresh reviewer stays. `verification.rounds` becomes the worker's repair limit.
- **Worktrees section.** The Coordinator gets the list and clean-up actions as tools, and reports in chat when it frees space. The "0 KB" button goes away with the section. Find out why `reclaimableKb` is always 0 before moving clean-up into the tool.
- **Observability tab**, for now. Per-chat tokens and cost move into a popover on the context bar. Subscription limits stay in the footer. A traces view comes back later only if it answers a specific question.
- **Knowledge tab, as it is now.** Knowledge documents become a "Notes" node under each project in the left tree and open in the center. Uploads become composer attachments. Evidence moves to Job details. The workspace path moves to Settings → General. Before deciding whether knowledge stays at all, count how often agents read knowledge documents in recent transcripts. If they almost never do, remove knowledge and rely on repo AGENTS.md.

### Hotkeys, motion, noise
- One `web/app/hotkeys.js` registry replaces the 8 `keydown` listeners. Features register named commands; bindings come from the host `ui` document. Default set: `[` list, `]` context panel, `\` Host agent, `/` focus composer, `Esc` leave focus, `1`–`9` chat N, `⌘K` palette, `⌘,` settings, `⌘.` stop the current turn, the settings letters above, and `B` to toggle queue/steer while busy.
- Motion: rows slide in as tool calls arrive, a shimmer marks agents that are working, panels open and close with short transitions, status dots pulse while a model streams.
- Noise rule for every section: a title plus at most one short line. Longer text goes into ⓘ.

### Decisions (owner, 2026-11-03)
1. Removing the verifier and Owner setup: accepted. pi-prjcts evolves fast; record the change in `docs/lean-runtime-plan.md`.
2. Agents run in YOLO mode by default. Truly dangerous actions (delete or archive a project, Approve/merge, Deploy, revoke grants, destructive git or file deletion outside a worktree) stay available to the Host agent and Coordinators but need the owner's explicit approval first. The agent asks, the owner approves or denies in the UI or Telegram, then the host runs it.
3. Knowledge stays and gets reimagined, based on a trace of real chats (see Knowledge below).
4. Theme set and hotkeys: use the defaults above.
5. Style direction: borrow from terminal UIs (herdr, Pi, Hermes): monospace tool rows and status line, a prompt glyph in the composer, keyboard hints everywhere, dense lists. Not a full terminal look.
6. Prototype: a real client at `/ui2` on the real host RPCs, with real backend parts (Host agent, tiers, per-profile tools, host `ui` document). Built in worktree `pi-prjcts-ui2`, branch `ui-2.0`.

### Order
1. **Quiet down** (cheap, no new concepts): clean up the left bar, merge questions into the transcript, move subtitles behind ⓘ, remove the chat tab strip and the Observability tab.
2. **Chat tool rows and the new Workers card.**
3. **Settings overlay**: core four per profile, Tools grid, Automations cards, removals.
4. **Model tiers** with ordered fallback and thinking level, including migration and Telegram.
5. **Host `ui` document**: themes, hotkeys registry, animations.
6. **Host agent** with tools generated from the request schema.


## Workflow


## Definition Of Done


## How You're Graded


