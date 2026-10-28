// Structural guard: ordinary dependency lookups must not allocate retained history per edge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/durable-planning.ts', import.meta.url), 'utf8');
const helper = source.match(/function dependencyResult\([\s\S]*?\n  }\n  async function dispatch/)?.[0];
assert.ok(helper, 'dependency resolver exists');
assert.doesNotMatch(helper, /Object\.values\(state\.work\)|history\.slice\(/, 'dependency resolver must not allocate history or suffix per edge');
console.log('PASS dependency resolution uses per-dispatch history, not per-edge allocation');
