// Unit check: the coordinator's instructions map manager-style subagent tools onto projects_delegate/projects_worker_plan,
// even when the owner replaced the editable role text. Run: node scripts/coordinator-subagent-mapping-unit.mjs
import assert from 'node:assert/strict';
import { coordinatorInstructions, SUBAGENT_TOOL_MAPPING } from '../src/durable-runtime.ts';

const project = { id: '00000000-0000-4000-8000-000000000001', name: 'Demo', objective: 'demo', githubAuthorization: [] };
for (const custom of [undefined, 'Custom owner role text']) {
  const text = coordinatorInstructions({ ...project, prompts: custom ? { coordinator: custom } : undefined }, '', '');
  assert.ok(text.includes(SUBAGENT_TOOL_MAPPING), 'mapping is appended by code');
  for (const name of ['agent_spawn', 'agent_wait', 'agent_types', 'projects_delegate', 'projects_worker_plan', 'wait:false', 'before waiting on any', 'need no owner approval']) {
    assert.ok(text.includes(name), `instructions mention ${name}`);
  }
}
console.log('coordinator-subagent-mapping-unit ok');
