// Fake OpenAI-completions provider for verification runs. Usage: node fake-provider.mjs <port-file> <request-log>
// Answers every model call with `VERIFY-FAKE-REPLY: <last user message>` and appends one JSON line per call to <request-log>.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const [portFile, requestLog] = process.argv.slice(2);
if (!portFile || !requestLog) { console.error('usage: node fake-provider.mjs <port-file> <request-log>'); process.exit(2); }
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
  let body = ''; req.setEncoding('utf8'); req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body || '{}'), messages = input.messages ?? [];
    const user = text(messages.findLast(m => m.role === 'user')?.content);
    appendFileSync(requestLog, JSON.stringify({ at: new Date().toISOString(), model: input.model, tools: (input.tools ?? []).map(t => t.function?.name), user }) + '\n');
    if (input.model === 'fake-model' && messages.some(m => text(m.content).includes('VERIFY-QUOTA-RECOVERY-WORK'))) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Quota exceeded: session limit reached', type: 'insufficient_quota', code: 'insufficient_quota' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: `VERIFY-FAKE-REPLY: ${user.slice(0, 200)}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
