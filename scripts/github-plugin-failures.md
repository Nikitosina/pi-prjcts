# GitHub plugin, stage 1 (Coordinator GitHub tools): failure cases

The Coordinator GitHub tools (`projects_github_issue_read`, `projects_github_issues`, `projects_github_issue_write`, `projects_github_pr`) move from core into the bundled `plugins/github` module. Core loads it as the built-in `github` plugin, the same identity that already holds the GitHub PR provider. `scripts/github-plugin-e2e.mjs` checks these with a fresh home, a fake model and a fake `gh`. Written before the move.

## Identity and activation
1. The tools still live in core: no `github` plugin status is reported, or its `provides` lacks `coordinatorTools`.
2. The move creates a second identity: two `github` status rows, two registry entries, or the PR provider and the tools under different names.
3. A configured plugin (plugins.json or `PI_PROJECTS_PLUGINS`) can take the `github` name, or listing `plugins/github` there loads the tools twice. It must be refused and the built-in must stay loaded.
4. Activation needs a plugins.json entry, so an existing authorized project silently loses the tools after the update. The built-in must load with no configuration.

## Plugin absent
5. Without the built-in (a failed load, or a registry that never loaded it), the GitHub PR provider disappears too. It must stay.
6. Without the built-in, the project fails to open, or the GitHub tools are still offered. The project must open, the tools must not be offered, and a call must end as unavailable without any `gh` call.
7. After the built-in loads again, an authorized project gets the tools back with no owner action.

## Recorded-call compatibility
8. A tool name, description, parameter schema, replay policy or execution mode differs from the core implementation (`scripts/fixtures/github-coordinator-tools.json`, captured from it before the move).
9. The Durable extension name `projects.coordinator-github` changes, so conversations recorded before the move no longer find the extension.
10. The tools are installed only where they are offered, so a recorded call in a project without a current authorization cannot resolve to a refusal.

## Authorization (unchanged rules, checked on every call)
11. A caller that is not a Coordinator conversation reaches GitHub.
12. No authorization, an authorization of another owner, or one made stale by a workspace change (fingerprint differs) reaches GitHub.
13. An authorization revoked after the tools were created keeps working until a reload. The next call must refuse.
14. A repository that is not authorized, or a missing `repository` with several authorized, reaches GitHub.
15. An archived or deleted project reaches GitHub.
16. A write reaches the API although the repository's numeric id no longer matches the authorization.
17. Refusals leave the `gh` call log empty; the authorized read and write send exactly the calls the core implementation sent.

## Offering and settings
18. `applies` differs from the old rule (offered exactly while the project has a GitHub authorization).
19. The tools move to the Plugins group in Tools/access, so a saved `group:github` switch-off no longer applies. They must stay in the GitHub group.
20. The GitHub integration prompt block changes id or becomes `plugin:github`, so an owner's edited block is lost. It must stay the built-in `github` block.
