# Delegation defaults: failure cases

Found with a real coordinator on `pi-prjcts`:
- The owner granted "Let workers edit this repo". The coordinator then delegated a worker without `workspaceScopeId`. The worker ran with no edit tools and still reported `completed`.
- The coordinator had no `projects_question` tool, because `decisionAccess` defaults to `none`.

`scripts/delegate-defaults-e2e.mjs` checks these with a fake model.

## Default scope
1. A worker is delegated without a scope while exactly one whole-repository scope exists, and it still gets no scope, so it can't edit.
2. The default is applied to scout or reviewer, which are read-only and must stay that way.
3. The default is applied when there are two or more scopes. The choice would be ambiguous, so it must stay explicit.
4. The default is applied to a folder-limited scope. Only whole-repository grants qualify.
5. An explicit `workspaceScopeId` is overridden.
6. The admission receipt does not show the scope that was chosen, so the coordinator can't tell.
7. With no grant at all, delegation behaves differently than before. It must still admit unscoped.

## Question default
8. A new project's coordinator lacks `projects_question`.
9. An existing project with no stored `decisionAccess` silently gains questions. Existing projects must stay untouched.
10. An owner who explicitly sets `decisionAccess: none` still gets the tool.
11. A question from the coordinator does not appear in the web Needs-you card with its choices.

## Answer delivery
Also found with the real coordinator: after the owner answered, it kept waiting forever. Delivery was manual.

12. Answering a question in the web UI does not wake the coordinator.
13. The coordinator gets the answer without the question it answers.
14. A wake-up fails (paused or archived project), the answer is lost, or the answer action errors.
15. A raw answer UUID document (`research/legacy/<id>.md`) appears in the rail Knowledge card.
