// Shared PR store of the fake Arcanum (fake-arc.mjs `arc pr ...` and fake-arcanum.mjs `ya tool arcanum ...`): FAKE_ARC_DIR/arcanum.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const prStore = dir => {
  const path = join(dir, 'arcanum.json');
  const load = () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { nextPr: 1, nextDiff: 100, prs: [], failPaths: [], rateLimit: 0 };
  const save = state => writeFileSync(path, JSON.stringify(state, null, 2));
  const view = pr => ({ id: pr.id, summary: pr.summary, description: pr.description, status: pr.status, author: pr.author, vcs: { from_branch: pr.from_branch, to_branch: 'trunk', repo_name: 'arcadia', type: 'arc' }, tickets: pr.tickets, auto_merge: pr.auto_merge, merge_allowed: mergeAllowed(pr), ...(pr.merge_commit ? { merge_commit: pr.merge_commit } : {}), url: `https://a.example.invalid/review/${pr.id}`, settings: { auto_publish: pr.published ? 'on_auto_checks_success' : 'disabled' } });
  const active = pr => pr.diffSets.at(-1);
  // Requirements: every required check of the active diff-set satisfied and the review approved for exactly that head.
  const mergeAllowed = pr => pr.status !== 'merged' && pr.approvedHead === active(pr)?.head && (pr.checks[active(pr)?.id] ?? []).every(check => !check.required || check.satisfied);
  /** A new push to the PR's source branch is a new diff-set. */
  const pushed = (state, fromBranch, head) => { const pr = state.prs.find(item => item.from_branch === fromBranch && item.status !== 'merged'); if (pr && active(pr)?.head !== head) pr.diffSets.push({ id: state.nextDiff++, head, base: pr.diffSets[0].base, merge: head, published: pr.published }); };
  return { load, save, view, active, mergeAllowed, pushed };
};
