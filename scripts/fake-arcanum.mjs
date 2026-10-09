#!/usr/bin/env node
// Fake `ya tool arcanum` (arcanum-go) for offline E2Es; answers from the PR store shared with fake-arc.mjs (FAKE_ARC_DIR/arcanum.json).
// Shapes follow the real `--json-schema` of pr get / pr list / pr active-diff / checks / comment list. Fault injection in the store:
// failPaths (an argv containing one of them fails with a REMOTE_ERROR, exit 65) and rateLimit (n calls fail with RATE_LIMITED, exit 75).
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { prStore } from './lib/fake-pr-state.mjs';

const dir = process.env.FAKE_ARC_DIR, args = process.argv.slice(2), prs = prStore(dir);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ tool: 'arcanum', argv: args, cwd: process.cwd(), at: Date.now() }) + '\n');
const envelope = (code, message, exit) => { process.stdout.write(JSON.stringify({ error: { code, message } }) + '\n'); process.exit(exit); };
const out = value => { process.stdout.write(JSON.stringify(value) + '\n'); process.exit(0); };
const store = prs.load();
if (store.rateLimit > 0) { store.rateLimit--; prs.save(store); envelope('RATE_LIMITED', 'too many requests', 75); }
if ((store.failPaths ?? []).some(part => args.join(' ').includes(part))) envelope('REMOTE_ERROR', 'backend unavailable', 65);
const flag = (name, list = args) => { const at = list.indexOf(name); return at < 0 ? undefined : list[at + 1]; };
const all = (name, list = args) => list.flatMap((value, at) => value === name ? [list[at + 1]] : []);
const [group, sub] = args;
const find = () => store.prs.find(item => item.id === Number(flag('--id'))) ?? envelope('NOT_FOUND', `pull request ${flag('--id')} not found`, 65);
const diffOf = id => { for (const pr of store.prs) { const diff = pr.diffSets.find(item => item.id === Number(id)); if (diff) return { pr, diff }; } return envelope('NOT_FOUND', 'diff-set not found', 65); };
if (group === 'pr' && sub === 'get') out(prs.view(find()));
if (group === 'pr' && sub === 'active-diff') { const pr = find(), diff = prs.active(pr); out({ id: diff.id, pull_request_id: pr.id, published: diff.published, commit_ids: { base: diff.base, head: diff.head, merge: diff.merge }, has_conflicts: pr.conflicts === true }); }
if (group === 'pr' && sub === 'list') {
  const from = flag('--from-branch'), issue = flag('--issue'), author = flag('--author'), published = flag('--published'), under = flag('--path'), offset = Number(flag('--offset') ?? 0), size = store.pageSize ?? 100;
  const rows = store.prs.filter(pr => pr.status !== 'merged' && pr.status !== 'discarded' && (!from || pr.from_branch === from) && (!issue || pr.tickets.includes(issue)) && (!author || pr.author.name === author) && (published === undefined || String(pr.published) === published) && (!under || (pr.paths ?? []).some(path => path === under || path.startsWith(under + '/'))));
  const page = rows.slice(offset, offset + size);
  out({ pull_requests: page.map(pr => ({ id: pr.id, summary: pr.summary, description: pr.description, ownership: { author: pr.author }, vcs: { from_branch: pr.from_branch, to_branch: 'trunk', repo_name: 'arcadia', type: 'arc' }, active_diff_set: { id: prs.active(pr).id, commit_ids: { base: prs.active(pr).base, head: prs.active(pr).head, merge: prs.active(pr).merge }, has_conflicts: pr.conflicts === true }, updated_at: pr.updated_at ?? '2026-10-09T00:00:00Z', labels: [], checks: (pr.checks[prs.active(pr).id] ?? []).map(check => ({ required: check.required, satisfied: check.satisfied, status: check.status, system: check.system, type: check.type })) })), has_next: offset + size < rows.length, next_offset: offset + size < rows.length ? offset + size : null });
}
if (group === 'pr' && sub === 'link-tickets') { const pr = find(); pr.tickets = [...new Set([...pr.tickets, ...all('--ticket')])]; prs.save(store); out({ id: pr.id, tickets: pr.tickets }); }
if (group === 'pr' && sub === 'auto-merge') { const pr = find(); const on = args[2] === 'enable'; if (on && pr.auto_merge !== 'disabled') out({ id: pr.id, status: 'noop' }); pr.auto_merge = on ? 'on_satisfied_requirements' : 'disabled'; if (on && prs.mergeAllowed(pr)) { pr.status = 'merged'; pr.merge_commit = prs.active(pr).head; } prs.save(store); out({ id: pr.id, status: on ? 'enabled' : 'disabled' }); }
if (group === 'checks') { const { diff } = diffOf(flag('--diff-id')); const pr = diffOf(flag('--diff-id')).pr; out({ checks: (pr.checks[diff.id] ?? []).map(check => ({ key: { system: check.system, type: check.type }, status: check.status, required: check.required, satisfied: check.satisfied, description: check.description ?? '' })) }); }
if (group === 'comment' && sub === 'list') out(find().comments.filter(comment => !args.includes('--open-issues') || comment.issue_status === 'open').map((comment, index) => ({ id: comment.id ?? index + 1, content: comment.content, author: { name: comment.author ?? 'reviewer', uid: comment.author ?? 'reviewer' }, created_at: comment.created_at ?? '2026-10-02T00:00:00Z', published_at: comment.created_at ?? '2026-10-02T00:00:00Z', is_draft: comment.is_draft === true, issue_status: comment.issue_status ?? 'not_issue', ...(comment.review_system ? { review_system: comment.review_system } : {}) })));
envelope('INVALID_ARGS', `unsupported fake arcanum command: ${args.join(' ')}`, 64);
