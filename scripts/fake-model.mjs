// Offline fake model for script E2Es: a private SDK agent dir whose only provider is `fake/fake-model`, served by a local
// OpenAI-completions SSE server. Call before importing the SDK: it points HOME/PI_CODING_AGENT_DIR at private dirs and sets
// PI_OFFLINE, so no owner credentials or real providers are reachable. Replies `X` to the last "Reply exactly X", else "ok".
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAKE_MODEL = 'fake/fake-model';
export async function startFakeModel(root) {
  const agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
  for (const dir of [agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const requests = [];
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
  const server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', part => { body += part; });
    req.on('end', () => {
      const input = JSON.parse(body), user = text(input.messages.findLast(m => m.role === 'user')?.content);
      const answer = /Reply exactly (\S+)/.exec(user)?.[1] ?? 'ok';
      requests.push({ at: Date.now(), model: input.model, user: user.slice(0, 300), answer });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', content: answer }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
  Object.assign(process.env, { HOME: userHome, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' });
  for (const key of Object.keys(process.env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete process.env[key];
  return { agentDir, requests, close: () => { server.closeAllConnections(); server.close(); } };
}
