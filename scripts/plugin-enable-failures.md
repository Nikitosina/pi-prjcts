# Failure modes: per-project plugin enable and disable

Written before the code. Unit: `scripts/plugin-gate-unit.mjs` (the gate in `src/plugin-gate.ts`, no host). E2E: `scripts/plugin-enable-e2e.mjs` (fake model, private HOME, fixture `scripts/fixtures/gated-plugin`; no live host). Owner decision: a plugin that has active work in the project, or that the project's checkout needs, cannot be disabled; nothing is force-stopped and nothing is unloaded globally.

Refusal
1. Disable is accepted while the plugin has a running RPC, tool call or lifecycle task in this project, so the work loses its plugin halfway. The call is refused with a reason naming the plugin and the work; the project record is unchanged.
2. Disable is accepted for a plugin the project's workspace grant needs (provider `github`, or a provider plugin's workspace id). The call is refused with the reason "required by this project's checkout".
3. A call starts in the same tick as the disable: the disable looks at the work count, then the call begins, and a call runs on a disabled plugin. The count check and the stored flag are one synchronous step, and a call after the flag is refused.
4. An unknown or not loaded plugin name is stored. It is refused.

Enforcement for existing threads
5. A thread that already holds the plugin's tools (a frozen worker tool set, a coordinator chat) keeps running them after the disable. Every tool call checks the flag when it executes and fails with "plugin is disabled in this project".
6. A plugin RPC or web route answers for a project that disabled it. Both refuse with the same reason.
7. A background step (Workspace cleanup, Storage usage) of the plugin runs for a disabled project. It is skipped.
8. New workers get the tools of a disabled plugin, or the coordinator prompt names them. Offers and prompt blocks follow the flag.

Isolation and data
9. Disabling in one project disables it in another. The flag is per project.
10. Disabling deletes or rewrites the plugin's stored files for the project. Nothing is touched; enabling again restores the previous behavior.
11. A failed disable (refused) changes the flag, or an enable of an enabled plugin writes again. Both are no-ops.
12. The `plugins` snapshot for a project does not tell the UI which plugins are off or locked, so the toggle cannot explain itself. Each entry has `enabled` and `lock` (a reason or null).

Merge, lifecycle and background work (added in the PR53 repair pass, before the code)
13. A merge call (inspect, markReady, merge, enableAutoMerge, pullMain) of a plugin runs outside the gate: a disable is accepted while an approval merges, and a disabled plugin still merges. Merge providers handed to the approver and to pull-main run each method through the project gate, GitHub's built-in included. Unit: `gate.methods`.
14. The lifecycle pause taken to check a disable is resumed at once, so the plugin restarts its background work in a project that just turned it off. The pause stays held while the plugin is off and is released only by enabling it again. A plugin whose pause refuses blocks the disable and holds nothing.
15. A held pause leaks into another project or survives the enable. It is keyed by project and plugin, and the enable releases it once.
16. A PR monitor or follow tick runs plugin code for a disabled project. The PR and follow providers answer through the gate (a disabled plugin's list and observe never run); the fixture counts calls across a tick interval.
17. Raw VCS access (`findVcsRoot`, `plugins.vcsProviders()`) is path-based, not per project; a project whose folder is a checkout of the plugin's kind cannot disable it (case 2), so a disabled VCS plugin is never one a project's checkout uses. A project with no such checkout never reaches it.
18. A disable whose project save fails leaves the plugin's lifecycle pause held while the plugin is still on (found in the PR53 recheck pass; e2e 14b red before the fix). `setEnabled` takes the save, keeps the pause only after it succeeds and releases it when it throws.
19. After a host restart a disabled plugin's pause is not held (the restart forgets it), so the plugin restarts background work for the project. The host retakes the pause of every project's disabled plugin when plugins finish loading; a refusing plugin stays gated by the flag. e2e 19 (red before the fix).
20. A follow provider's `published` runs for a disabled project, or an `observe` that began before the disable delivers its result after it and the batch records the plugin's items. `published` goes through the gate with the project; `observe` results go through `gate.settled`, which refuses a result that arrives after the flag. Unit: `gate.settled`.
21. The simulator's host-wide hourly prune runs while every project has the plugin off. The timer runs only when some project has it on (`api.projects.list()`, `hourlyPruneApplies`); the cleanup step is already gated per project. Unit: `workspace-cleanup-unit` T5.
