# Skill profiles (hierarchical picker, index + on-demand bodies): failure cases, written before implementation

Covers C6. Verified by `scripts/skill-profiles-e2e.mjs` unless marked (inspection).

## Defaults
- S1 A project without saved profiles (new or existing) still gives workers every configured skill (89 for the owner) instead of only the repository skills.
- S2 The default is computed from a stale or wrong source (global or package skills land in "All profiles").
- S3 An existing project file without the new field fails to load or its settings revision check breaks the UI.

## Effective sets
- S4 A role gets skills of another role (worker additions leak to scouts, coordinator additions to workers).
- S5 "All profiles" skills are missing from a role.
- S6 Child threads get a different set from their role (a child worker misses the worker additions).
- S7 A saved name that no longer exists breaks prompt building or the tool instead of being ignored.

## Prompts
- S8 Prompts still inline skill bodies or list skills outside the effective set (the 34 KB worker prompt).
- S9 The coordinator gets no skill index at all.
- S10 Whole-repository workers still get the old "Configured Pi skills" list of every configured skill.

## On-demand reading
- S11 The skill-read tool reads a skill outside the caller's effective set (a scout reads a worker-only skill).
- S12 A path escapes the skill directory (`..`, absolute, symlink out).
- S13 Workers or scouts do not get the tool at all (only the coordinator).
- S14 The coordinator can no longer read references of a skill the owner invoked with `/skill:` when that skill is outside its profile.
- S15 Existing worker threads break: changing the worker binding (tool names, grants fingerprint) makes their binding revision differ, so follow-ups fail with "Scoped worker binding revision changed". (inspection + E2E follow-up on a thread created before a settings change)

## Settings and UI
- S16 `settings-update` accepts unknown roles or non-string names, or saving skills without an idle project corrupts state.
- S17 The picker lists only some skills, is not searchable, or not grouped by source.
- S18 Saving the picker does not persist, or a reload shows the default again.
- S19 The owner `/` composer picker is filtered by profiles (it must still list everything).
- S20 The picker breaks the 390 px layout.

## Old grant model
- S21 The old worker-skill grant path (`projects_skill_read`, grant dialog, grant RPCs) still runs alongside profiles, so there are two competing models.
