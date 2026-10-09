// Browser E2E: per-thread worker artifacts folder, coordinator list/read tools, authenticated route, inline images/videos (C7).
// Isolated host, local fake model, headless Chrome. Failure cases: scripts/artifacts-failures.md.
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay, randomUUID } from './notify-kit.mjs';

const brain = { workerSystem: [], workerResults: [], childResults: [], coordResults: [], report: '', thread: null, child: null, final: '' };
let root;
const respond = async ({ coordinator, userText, results, tools, say, call, msgs }) => {
  const system = msgs.find(m => m.role === 'system')?.content ?? '';
  if (coordinator) {
    if (/MARK-ART\b/.test(userText) && results.length === 0) return call('projects_delegate', { role: 'worker', task: 'ART-WORKER capture evidence of the feature' });
    if (userText.startsWith('[Durable work') && /ART-WORKER|artifact:/.test(userText)) {
      brain.report = userText; brain.coordResults = results;
      const thread = brain.thread = /^\[Durable work [0-9a-f-]+, worker, \w+; thread ([0-9a-f-]{36})\]/.exec(userText)?.[1] ?? brain.thread;
      const steps = [['projects_artifacts_list', { threadId: thread }], ['projects_artifacts_list', {}], ['projects_artifact_read', { threadId: thread, path: 'logs/run.log' }], ['projects_artifact_read', { threadId: thread, path: '../../project.json' }], ['projects_artifact_read', { threadId: thread, path: 'leak.txt' }], ['projects_artifact_read', { threadId: thread, path: 'shot.png' }], ['projects_artifact_read', { threadId: randomUUID(), path: 'shot.png' }]];
      if (results.length < steps.length) return call(...steps[results.length]);
      brain.final = `ART-FINAL Verified.\n\n![Screenshot](artifact:${thread}/shot.png)\n\n![Demo video](artifact:${thread}/demo.webm)\n\nLog: [run log](artifact:${thread}/logs/run.log)\n\n![Gone](artifact:${thread}/nope.png)\n\n[bad](javascript:alert(1))`;
      return say(brain.final);
    }
    return undefined;
  }
  if (!tools.includes('bash')) return undefined;
  if (/^\[Child work/.test(userText)) return say('ART-PARENT-DONE Saved shot.png, demo.webm, logs/run.log in my artifacts folder.');
  if (/ART-CHILD/.test(userText)) {
    if (results.length === 0) return call('bash', { command: 'printf "child evidence" > "$PI_ARTIFACTS_DIR/child.txt" && echo "DIR=$PI_ARTIFACTS_DIR"' });
    brain.childResults = results; return say('CHILD-DONE saved child.txt');
  }
  if (/ART-WORKER/.test(userText)) {
    brain.workerSystem.push(String(typeof system === 'string' ? system : JSON.stringify(system)));
    if (results.length === 0) return call('bash', { command: [
      'echo "DIR=$PI_ARTIFACTS_DIR"', 'echo "PWD=$(pwd)"', 'cd "$PI_ARTIFACTS_DIR"', 'mkdir -p logs',
      `cp ${root}/shot.png shot.png`, `cp ${root}/demo.webm demo.webm`, 'printf "line1\\nRUN-LOG-OK\\n" > logs/run.log',
      `ln -s ${root}/secret.txt leak.txt`, `ln -s ${root} linkdir`, 'printf x > "<img src=x onerror=window.__xss=1>.txt"',
      'dd if=/dev/zero of=big.bin bs=1 count=0 seek=600m 2>/dev/null', 'ls -la',
    ].join(' && ') });
    if (results.length === 1) { brain.workerResults = results; return call('projects_delegate_child', { role: 'worker', task: 'ART-CHILD save child evidence' }); }
    return say('Waiting for the child.');
  }
  return undefined;
};
const k = await kit('artifacts', {}, respond);
root = k.root;
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET-ARTIFACT-LEAK\n');

try {
  await k.startHost();
  const web = await rpc({ action: 'web' }), base = new URL(web.url), token = new URLSearchParams(base.hash.slice(1)).get('token');
  // Media fixtures produced by the browser itself: a PNG and a short webm (MediaRecorder from a canvas).
  const s = await openPage(`${base.origin}/`);
  await delay(800);
  const media = await evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d');
    g.fillStyle = '#c2653a'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('ARTIFACT', 80, 110);
    const png = c.toDataURL('image/png').split(',')[1];
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = e => parts.push(e.data); const done = new Promise(ok => rec.onstop = ok); rec.start(100);
    for (let i = 0; i < 12; i++) { g.fillStyle = 'hsl(' + i * 30 + ',70%,50%)'; g.fillRect(i * 20, 0, 20, 200); await new Promise(ok => setTimeout(ok, 80)); }
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()); let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    return { png, webm: btoa(bin) };
  })()`, s);
  writeFileSync(join(root, 'shot.png'), Buffer.from(media.png, 'base64'));
  writeFileSync(join(root, 'demo.webm'), Buffer.from(media.webm, 'base64'));
  check('fixtures: browser-made PNG and webm', media.png.length > 100 && media.webm.length > 1000, { png: media.png.length, webm: media.webm.length });

  const id = await k.setup('Art', k.gitRepo), other = await k.setup('Other');
  const snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  await rpc({ action: 'message', id, text: 'MARK-ART please verify the feature with evidence' });
  await eventually(() => brain.final, 'coordinator never wrote the final answer', 1200);
  const plan = await rpc({ action: 'plan-snapshot', id }).catch(() => null);
  const view = await eventually(async () => { const v = await rpc({ action: 'show', id }); return v.messages?.some(m => /ART-FINAL/.test(m.text ?? '')) && v; }, 'final answer not in Main', 300);
  const thread = brain.thread;
  const dir = join(k.home, id, 'artifacts', thread);
  const bashOut = brain.workerResults[0] ?? '';
  const childDir = /DIR=(\S+)/.exec(brain.childResults[0] ?? '')?.[1] ?? '';
  const workerDir = /DIR=(\S+)/.exec(bashOut)?.[1] ?? '', workerPwd = /PWD=(\S+)/.exec(bashOut)?.[1] ?? '';
  result.paths = { workerDir, workerPwd, childDir, expected: dir };
  check('A1 the worker folder lives in the project home, outside the worktree', workerDir.endsWith(`/artifacts/${thread}`) && workerDir.startsWith(k.home) && !workerDir.startsWith(workerPwd) && existsSync(join(workerDir, 'shot.png')), result.paths);
  check('A1 folder is private (0700)', (lstatSync(workerDir).mode & 0o777) === 0o700);
  const system = brain.workerSystem[0] ?? '';
  check('A2 the path and $PI_ARTIFACTS_DIR are in the worker instructions', system.includes(workerDir) && system.includes('PI_ARTIFACTS_DIR'), system.slice(-1500));
  check('A5/A6 no dangling projects_evidence instruction; workers told to list saved files', !/projects_evidence/.test(system) && /list the saved files/i.test(system));
  check('A3/A4 the child worker gets its own folder, not the parent\'s', childDir && childDir !== workerDir && /\/artifacts\/[0-9a-f-]{36}$/.test(childDir) && readFileSync(join(childDir, 'child.txt'), 'utf8') === 'child evidence', result.paths);
  check('A15 the settled report lists the artifacts as references and warns about the cap', brain.report.includes(`artifact:${thread}/shot.png`) && brain.report.includes(`artifact:${thread}/demo.webm`) && /cap/i.test(brain.report), brain.report.slice(-1500));
  const [list, overview, log, traversal, leak, image, foreign] = brain.coordResults;
  result.coordResults = brain.coordResults.map(r => r.slice(0, 1500));
  check('A8 coordinator lists the thread\'s files with sizes', /shot\.png/.test(list) && /logs\/run\.log/.test(list) && /demo\.webm/.test(list) && /"size"/.test(list), list?.slice(0, 1500));
  check('A8 the overview names each thread with its first task, file count and total', /"task":"ART-WORKER/.test(overview) && /"task":"ART-CHILD/.test(overview), overview);
  check('A9 the planted symlinks are skipped, never listed as files', (() => { const parsed = JSON.parse(list); return !parsed.files.some(f => /leak|linkdir/.test(f.path)) && parsed.skipped.some(f => f.path === 'leak.txt') && parsed.skipped.some(f => f.path === 'linkdir'); })() && !/TOP-SECRET/.test(list), list);
  check('A14 the listing reports the 500 MB soft cap as exceeded; nothing is deleted', /"overCap":true/.test(list) && existsSync(join(workerDir, 'big.bin')));
  check('A8 coordinator reads a text artifact', /RUN-LOG-OK/.test(log), log);
  check('A10 traversal is refused', /refused|outside|invalid|not allowed/i.test(traversal) && !/"id"/.test(traversal), traversal);
  check('A9 reading the symlink is refused', /symlink|refused|not a regular/i.test(leak) && !/TOP-SECRET/.test(leak), leak);
  check('A8 an image artifact is readable by the coordinator', /shot\.png|image/i.test(image), image);
  check('A11 an unknown thread is refused', /unknown|not a thread|refused/i.test(foreign), foreign);

  // HTTP route.
  const get = (path, auth = true) => fetch(`${base.origin}${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
  const ok = await get(`/artifacts/${id}/${thread}/shot.png`);
  const csp = ok.headers.get('content-security-policy') ?? '';
  check('A12 the route serves the image with the token', ok.status === 200 && ok.headers.get('content-type') === 'image/png' && Buffer.from(await ok.arrayBuffer()).length === Buffer.from(media.png, 'base64').length);
  check('A17 CSP allows blob media', /media-src[^;]*blob:/.test(csp), csp);
  check('A12 no token: 401', (await get(`/artifacts/${id}/${thread}/shot.png`, false)).status === 401);
  const statuses = {};
  for (const [label, path] of Object.entries({ dotdot: `/artifacts/${id}/${thread}/..%2f..%2fproject.json`, encoded: `/artifacts/${id}/${thread}/%2e%2e/%2e%2e/project.json`, symlink: `/artifacts/${id}/${thread}/leak.txt`, symdir: `/artifacts/${id}/${thread}/linkdir/secret.txt`, nul: `/artifacts/${id}/${thread}/shot.png%00`, otherProject: `/artifacts/${other}/${thread}/shot.png`, badThread: `/artifacts/${id}/not-a-uuid/shot.png` })) {
    const response = await get(path); const body = await response.text(); statuses[label] = response.status;
    if (body.includes('TOP-SECRET') || response.status === 200) throw Error(`A9/A10/A11 ${label} leaked: ${response.status}`);
  }
  result.httpRefusals = statuses;
  check('A9/A10/A11 traversal, encoded traversal, symlinks, NUL, other project and bad thread are refused over HTTP', Object.values(statuses).every(code => code >= 400), statuses);

  // Chat rendering.
  const chatUrl = new URL(web.url); chatUrl.searchParams.set('project', id);
  await send('Page.navigate', { url: chatUrl.toString() }, s);
  await waitFor(`[...document.querySelectorAll('#messages img.artifact-media')].some(i => i.complete && i.naturalWidth === 320)`, s, 'inline image');
  check('A16 the image renders inline (320 px wide)', true);
  await waitFor(`[...document.querySelectorAll('#messages video.artifact-media')].some(v => v.readyState >= 1)`, s, 'inline video metadata');
  check('A16/A17 the webm plays in a <video> player (metadata loaded)', true);
  check('A16 other files are links, fetched only on click', await evaluate(`[...document.querySelectorAll('#messages .artifact-ref[data-state=link] a')].some(a => a.textContent === 'run log') && !performance.getEntriesByType('resource').some(e => e.name.includes('run.log'))`, s));
  await waitFor(`[...document.querySelectorAll('#messages .artifact-missing')].some(n => /missing artifact/.test(n.textContent))`, s, 'missing artifact');
  check('A18 a missing file shows "missing artifact"', true);
  check('A20 javascript: links are not rendered as links', await evaluate(`![...document.querySelectorAll('#messages a')].some(a => /^javascript:/i.test(a.getAttribute('href') ?? ''))`, s));
  await delay(300); await shot('01-chat-inline-media', s);
  const fetches = () => evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes('/shot.png')).length`, s);
  const before = await fetches();
  await k.ask(id, 'main', 'MARK-PING re-render the transcript');
  await delay(1500);
  check('A19 re-rendering does not refetch the image (blob cache)', (await fetches()) === before && before >= 1, { before, after: await fetches() });

  // Activity thread pane.
  const activity = new URL(web.url); activity.searchParams.set('project', id); activity.searchParams.set('tab', 'activity');
  await send('Page.navigate', { url: activity.toString() }, s);
  await waitFor(`!!document.querySelector('[data-action="thread"][data-thread="${thread}"]')`, s, 'thread button');
  await evaluate(`document.querySelector('[data-action="thread"][data-thread="${thread}"]').click()`, s);
  await waitFor(`!!document.querySelector('#artifact-tree .artifact-file[data-path="shot.png"]')`, s, 'artifact browser files');
  await evaluate(`document.querySelector('#artifact-tree .artifact-file[data-path="shot.png"]').click()`, s);
  await waitFor(`[...document.querySelectorAll('#artifact-preview img.artifact-media')].some(i => i.naturalWidth === 320)`, s, 'artifact browser image preview');
  const pane = await evaluate(`document.querySelector('#artifact-pane').innerText`, s);
  check('A21 the artifact browser lists files with sizes, the cap warning and skipped symlinks', /run\.log/.test(pane) && /600\.0 MB/.test(pane) && /over the 500\.0 MB cap/.test(pane) && /skipped/.test(pane), pane);
  check('A20 HTML in a file name is escaped', await evaluate(`!window.__xss && !document.querySelector('#artifact-pane img[src="x"]') && document.querySelector('#artifact-pane').innerText.includes('<img src=x onerror')`, s));
  check('A22 artifacts of a completed thread stay visible', (await rpc({ action: 'artifacts-list', id, threadId: thread })).files.length >= 5);
  check('A11 artifacts-list refuses another project\'s thread', await rpc({ action: 'artifacts-list', id: other, threadId: thread }).then(() => false, error => /unknown thread/i.test(error.message)));
  await delay(300); await shot('02-thread-artifacts', s);
  // Expected refusals in this test: the missing artifact (404) issued by the chat.
  result.httpErrors = result.httpErrors.filter(e => !(e.url.includes('/artifacts/') && /nope\.png$/.test(e.url)));
  void plan; void view;
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
