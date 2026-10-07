# Coordinator GitHub tools and `/` skills: failure cases

Found on the owner's live Mari project: the coordinator could not read or create GitHub issues itself, and a worker refused to create one because no issue tool was offered. Separately, the owner wants to invoke skills from the composer by typing `/`, as in pi and Claude Code. `scripts/coordinator-github-skills-e2e.mjs` checks these with a fake model and a fake `gh`.

## GitHub tools (coordinator)
1. With GitHub authorized, the coordinator has no tool to read an issue (title, body, labels, comments) and has to delegate a worker.
2. The coordinator cannot list or search issues and PRs in the authorized repository.
3. The coordinator cannot create an issue, comment, edit title/body, set labels/assignees/milestone, or close/reopen. The tool returns no issue URL.
4. A repository that is not authorized (or an authorization made stale by a workspace change) is still reachable. Tools must refuse it.
5. Without any GitHub authorization the tools are offered anyway and fail confusingly. They must not be offered.
6. A `gh` failure is reduced to an opaque fingerprint, so the coordinator cannot tell 404 from 422.
7. Tool rows show raw names (`projects_github_issue_write`) instead of a human label with the issue number.

## `/` skills (composer)
8. Typing `/` at the start of the composer shows nothing. A popup must list skills with descriptions, filter as you type, and support ↑/↓, Enter/Tab to pick, Esc to close.
9. Picking a skill does not insert `/skill:<name> `, or Enter while the popup is open sends the message instead of picking.
10. The global `/` shortcut (focus composer) breaks, or `/` typed mid-text opens the popup.
11. Sending `/skill:<name> args` reaches the model as the raw command instead of the expanded SKILL.md block (pi format, frontmatter stripped) followed by the args.
12. An unknown `/skill:` name is silently sent as text. It must be rejected with a clear error and the draft kept.
13. The transcript shows the full skill body as the owner's message. It must show a compact skill chip plus the args.
14. A skill that references sibling files cannot have them read. The coordinator needs a bounded read inside that skill's directory, refusing paths that escape it.
15. Skills from the repository (`.agents/skills`, `.pi/skills`), the global agent dir and pi packages are not all listed. More than 64 skills breaks the list (the owner has 89).

## Regressions to keep
16. live-chain, ui-polish, coordinator-live, github-quick-ui, coordinator-workers-ui and projects-chat-md keep passing.
