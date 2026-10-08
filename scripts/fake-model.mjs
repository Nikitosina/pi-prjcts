// Offline fake model for script E2Es: a private SDK agent dir whose only provider is `fake/fake-model`, served by a local
// OpenAI-completions SSE server. Call before importing the SDK: it points HOME/PI_CODING_AGENT_DIR at private dirs and sets
// PI_OFFLINE, so no owner credentials or real providers are reachable. Replies `X` to the last "Reply exactly X", else "ok".
// Directives in the last user message script tool use: `FAKE-CALL <tool> <json>` (`FAKE-CALL-ONCE`: only the first request ever carrying that json calls, so a requeued attempt does not repeat itself; repeatable, one call per model turn, in order;
// ignored in worker-report turns, which quote the task; `~regex` picks the first offered tool whose name matches; `$REV` in the json becomes the last 64-hex string seen in a tool
// result), then `FAKE-SAY <text>` (default: the last tool result, so "reply with its contents" holds). Options: `models` (extra
// model ids under provider `fake`), `delayMs` (hold each reply, to overlap streams).
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAKE_MODEL = 'fake/fake-model';
export async function startFakeModel(root, { models = [], delayMs = 0 } = {}) {
  const agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
  for (const dir of [agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const requests = [], fired = new Set();
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
  const toolCall = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  const server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', part => { body += part; });
    req.on('end', () => {
      const input = JSON.parse(body), lastUser = input.messages.findLastIndex(m => m.role === 'user'), user = text(input.messages[lastUser]?.content);
      const results = input.messages.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => text(m.content));
      const calls = user.startsWith('[Durable work ') ? [] : [...user.matchAll(/FAKE-CALL(-ONCE)? (\S+) (\{.*?\})(?=\s*(?:FAKE-|$))/gm)], offered = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
      let answer = /FAKE-SAY (.*)/.exec(user)?.[1] ?? /Reply (?:with )?exactly (\S+?)[.,;]?(?:\s|$)/.exec(user)?.[1] ?? (calls.length ? results.at(-1) : undefined) ?? 'ok', frame;
      if (results.length < calls.length && !(calls[results.length][1] && fired.has(calls[results.length][3]))) {
        const [, once, wanted, json] = calls[results.length], name = wanted.startsWith('~') ? offered.find(n => new RegExp(wanted.slice(1)).test(n)) ?? wanted : wanted;
        if (once) fired.add(json);
        frame = toolCall(name, JSON.parse(json.replaceAll('$REV', results.join(' ').match(/[a-f0-9]{64}/g)?.at(-1) ?? '')));
      }
      requests.push({ at: Date.now(), model: input.model, user: user.slice(0, 300), answer, tools: offered, called: frame ? calls[results.length][3] : null });
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame ?? chunk({ role: 'assistant', content: answer }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'); }, delayMs);
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  server.unref(); // a failed script must not hang on the fake
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: ['fake-model', ...models].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 })) } } }));
  Object.assign(process.env, { HOME: userHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' });
  for (const key of Object.keys(process.env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete process.env[key];
  return { agentDir, requests, close: () => { server.closeAllConnections(); server.close(); } };
}

// `create` stores the built-in codex role defaults; pin every role to a fake model before any worker runs.
export async function pinFakeRoles(request, id, models = {}) {
  const settings = await request({ action: 'settings-snapshot', id }), all = { worker: FAKE_MODEL, scout: FAKE_MODEL, reviewer: FAKE_MODEL, ...models };
  await request({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: all } });
}
