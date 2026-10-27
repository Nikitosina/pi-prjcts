// E2E: provider quota failures, compact projects_workers, compact completion artifact list.
// Fake model, git project, private HOME. Failure cases: quota-status-failures.md.
// Artifact: artifacts/quota-status-<time>/report.json (+ summary.json with before/after measurements).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, delay, randomUUID } from './lib/e2e-kit.mjs';

const reports = new Map(), workersOut = new Map();
const QUOTA = { status: 429, body: { error: { message: 'Quota exceeded for quota metric GenerateContent requests: session limit, resets 5:30pm', type: 'insufficient_quota', code: 'insufficient_quota' } } };
const RATE = { status: 429, body: { error: { message: 'Too many requests, slow down', type: 'rate_limit_error' } } };
const handler = ({ role, user, results }) => {
  if (user.startsWith('[Durable work')) { reports.set(/thread ([a-f0-9-]{36})/.exec(user)?.[1], user); return say('Noted report.'); }
  if (role === 'coordinator') {
    if (results.length) { if (user.includes('MARK-W')) workersOut.set(user, results[0]); return say('Noted.'); }
    const args = /MARK-W (\{.*\})$/.exec(user)?.[1];
    return args ? call('projects_workers', JSON.parse(args)) : undefined;
  }
  if (role !== 'worker') return undefined;
  if (user.includes('FAKE-QUOTA')) return QUOTA;
  if (user.includes('FAKE-RATE')) return RATE;
  return undefined;
};
const kit = await createKit('quota-status', { handler });
const { result, rpc, eventually } = kit;
// QUOTA_STATUS_ALL=1 records every failed check instead of stopping at the first (before/after evidence).
const check = (label, ok, detail) => { try { kit.check(label, ok, detail); } catch (error) { if (!process.env.QUOTA_STATUS_ALL) throw error; (result.failedChecks ??= []).push(String(error.message).slice(0, 600)); } };
const summary = result.summary = {};

await kit.run(async () => {
  kit.initRepo();
  const id = await kit.createProject('Quota status', { workerCap: 4 });
  const scopeId = (await rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository).id;
  const submit = async text => { const threadId = randomUUID(); await rpc({ action: 'work-submit', id, threadId, requestId: randomUUID(), workspaceScopeId: scopeId, text }); return threadId; };
  const settled = async threadId => eventually(async () => (await kit.plan(id)).find(work => work.threadId === threadId && ['completed', 'failed', 'blocked'].includes(work.status)), `work of ${threadId} did not settle`, 1800);
  const waiting = async threadId => eventually(async () => (await kit.plan(id)).find(work => work.threadId === threadId && work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:')), `work of ${threadId} did not enter quota wait`, 1800);
  const workerCalls = () => result.calls.filter(c => c.role === 'worker').length;

  // Q1-Q2: a transient 429 keeps its raw reason, is classified rate_limited, and never starts a provider cooldown.
  const rate = await settled(await submit('FAKE-RATE first'));
  check('Q1 a transient 429 settles failed with the raw provider reason and a rate_limited class', rate.status === 'failed' && /^rate_limited:/.test(rate.blocker) && /Too many requests/.test(rate.blocker), rate.blocker);
  const afterRate = await settled(await submit('plain after a transient 429'));
  check('Q2 a transient 429 does not block the next admission', afterRate.status === 'completed', afterRate);

  // Fixture for Q7-Q9: eight finished works with long briefs.
  const long = 'BRIEF '.repeat(500);
  for (let index = 0; index < 8; index++) await settled(await submit(`${long}#${index}`));
  // Q10: a completion report does not list nested xcresult diagnostics.
  const withFiles = randomUUID();
  const dir = join(kit.home, id, 'artifacts', withFiles);
  for (let index = 0; index < 120; index++) { mkdirSync(join(dir, 'r5', 'run.xcresult', 'Staging', 'Diagnostics'), { recursive: true }); writeFileSync(join(dir, 'r5', 'run.xcresult', 'Staging', 'Diagnostics', `Session-${index}.log`), 'x'.repeat(1000)); }
  for (let bundle = 0; bundle < 14; bundle++) { mkdirSync(join(dir, `run${bundle}.xcresult`), { recursive: true }); writeFileSync(join(dir, `run${bundle}.xcresult`, 'Info.plist'), 'x'); }
  for (const name of ['summary.md', 'shot.png', 'report.json']) writeFileSync(join(dir, name), name);
  await rpc({ action: 'work-submit', id, threadId: withFiles, requestId: randomUUID(), workspaceScopeId: scopeId, text: 'finish with artifacts' });
  await eventually(() => reports.get(withFiles), 'no report for the artifact thread', 1800);
  const report = reports.get(withFiles);
  summary.artifacts = { reportChars: report.length, xcresultLines: (report.match(/\.xcresult\//g) ?? []).length, listRows: (report.match(/^- /gm) ?? []).length };
  check('Q10 the completion report lists top-level evidence, not nested xcresult files, and stays small', /summary\.md/.test(report) && !/\.xcresult\//.test(report) && /xcresult/.test(report) && report.length <= 2000 && summary.artifacts.listRows <= 7 && /more bundles/.test(report), summary.artifacts);
  // Q3-Q6: quota stays distinguishable, waits on the same model, and survives reopen without selecting a fallback.
  const quota = await waiting(await submit('FAKE-QUOTA first'));
  check('Q3 a quota 429 keeps its class, raw provider text and exact model while waiting', quota.status === 'queued' && /^quota_reset_wait:.*quota_exceeded:/s.test(quota.blocker) && /Quota exceeded for quota metric/.test(quota.blocker) && quota.attempt.model === 'fake/fake-model', quota.blocker);
  const before = workerCalls();
  const attempts = [];
  for (const text of ['FAKE-QUOTA again 1', 'FAKE-QUOTA again 2', 'FAKE-QUOTA again 3']) { const threadId = randomUUID(); attempts.push({ threadId, error: await kit.rejects({ action: 'work-submit', id, threadId, requestId: randomUUID(), workspaceScopeId: scopeId, text }) }); }
  for (const attempt of attempts) if (!attempt.error) await waiting(attempt.threadId);
  const refusals = attempts.map(attempt => attempt.error);
  check('Q4 new work uses its frozen model and waits after its own quota failure; no fallback is invented', refusals.every(error => error === null) && attempts.length === 3 && (await kit.plan(id)).filter(work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:')).every(work => work.attempt.model === 'fake/fake-model'), { refusals });
  await kit.restartHost();
  await rpc({ action: 'resume', id, confirm: id, recovery: 'leave-interrupted' });
  const reopenedId = await submit('FAKE-QUOTA after reopen'), reopened = await waiting(reopenedId);
  check('Q5 persisted quota recovery survives a host reopen', reopened.status === 'queued' && reopened.attempt.model === 'fake/fake-model' && workerCalls() > before, reopened);
  summary.quota = { blocker: quota.blocker, waiting: attempts.length + 2, doomedModelCalls: workerCalls() - before };

  // Q7-Q9: projects_workers rows are short; the full brief is one explicit call away.
  await rpc({ action: 'message', id, text: 'MARK-W {"all":true,"limit":100}' });
  await eventually(() => workersOut.get('MARK-W {"all":true,"limit":100}'), 'workers listing did not arrive');
  const listing = workersOut.get('MARK-W {"all":true,"limit":100}');
  const listed = JSON.parse(listing);
  const rows = listed.work;
  summary.workers = { bytes: listing.length, rows: rows.length, bytesPerRow: Math.round(listing.length / rows.length), sampleRow: rows[0] };
  check('Q7 the default list is compact: at most 520 bytes per row (771 before)', rows.length >= 3 && listing.length / rows.length <= 520, summary.workers);
  check('Q8 each row keeps id, role, status, thread, model and blocker access', rows.every(row => row.id && row.role && row.status && row.threadId && 'model' in row && 'blocker' in row), rows[0]);
  const failed = rows.find(row => row.id === quota.id) ?? (await rpc({ action: 'plan-snapshot', id })).work.find(row => row.id === quota.id);
  await rpc({ action: 'message', id, text: `MARK-W ${JSON.stringify({ workId: quota.id })}` });
  await eventually(() => workersOut.get(`MARK-W ${JSON.stringify({ workId: quota.id })}`), 'work detail did not arrive');
  const detailText = workersOut.get(`MARK-W ${JSON.stringify({ workId: quota.id })}`) ?? '', detail = (() => { try { return JSON.parse(detailText); } catch { return { error: detailText.slice(0, 300) }; } })();
  check('Q9 workId returns the full brief and the full blocker text', detail.work?.length === 1 && detail.work[0].text.length >= 'FAKE-QUOTA first'.length && /Quota exceeded for quota metric/.test(detail.work[0].blocker) && failed && (failed.blocker?.length ?? Infinity) <= 260, { failed, detail });

  // Q11: only an exhausted allowance is quota; transient outages that mention billing or quota are not.
  const { providerFailure } = await import('../src/durable-planning.ts');
  const quotaTexts = ['model_error: Quota exceeded for quota metric', 'model_error: Claude rate limit (five_hour): You\'ve hit your session limit', 'model_error: 429 insufficient_quota: You exceeded your current quota', 'model_error: Your credit balance is too low', 'model_error: Monthly usage limit reached'];
  const otherTexts = [['model_error: billing service unavailable, try again', undefined], ['model_error: 503 quota service unavailable', undefined], ['model_error: credit balance service unavailable', undefined], ['model_error: unable to retrieve available balance', undefined], ['model_error: billing limit service unavailable', undefined], ['model_error: authentication failed', undefined], ['model_error: 429 Too many requests', 'rate_limited'], ['model_error: Provider overloaded', 'rate_limited'], ['model_error: fetch failed', undefined], ['aborted', undefined]];
  check('Q11 quota texts classify as quota_exceeded; transient billing/quota outages and throttles do not', quotaTexts.every(text => providerFailure(text) === 'quota_exceeded') && otherTexts.every(([text, kind]) => providerFailure(text) === kind), { quota: quotaTexts.map(text => providerFailure(text)), other: otherTexts.map(([text]) => providerFailure(text)) });
});
