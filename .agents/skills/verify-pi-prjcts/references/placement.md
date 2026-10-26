# Why this skill lives in `.agents/skills`

Read only when moving, renaming or re-pointing this skill.

- `.cursor` is not a root the Pi SDK catalog scans; `.agents/skills` (project-local) is, and so is worker repository-skill discovery.
- Worker discovery (`src/worker-skill-discovery.ts`) throws on a symlinked entry inside `.agents/skills`. The canonical copy therefore has to be real files there.
- `.cursor/skills/verify-pi-prjcts` is a symlink back to the canonical folder, for tools that look in `.cursor`. Nothing scans `.cursor` here, so the symlink is harmless.
- `node scripts/verify-skill-discovery-unit.mjs` (repo root) asserts all of this.
