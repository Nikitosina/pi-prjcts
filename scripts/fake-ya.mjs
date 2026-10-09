#!/usr/bin/env node
// Fake `ya` for offline E2Es: only `ya whoami` (login from FAKE_ARC_DIR/state.json), recorded like the other fakes. Real ya is never run.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_ARC_DIR, args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ tool: 'ya', argv: args, cwd: process.cwd(), at: Date.now() }) + '\n');
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
if (args[0] === 'whoami' && !state.whoamiFails) { process.stderr.write(`Info: Getting person info for login "${state.login}" from Staff...\n`); process.stdout.write(`${state.login}\n`); process.exit(0); }
process.stderr.write(args[0] === 'whoami' ? 'Error: not authorized\n' : `unsupported fake ya command: ${args.join(' ')}\n`);
process.exit(1);
