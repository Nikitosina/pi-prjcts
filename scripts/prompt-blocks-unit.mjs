// Unit checks for src/prompt-blocks.ts: defaults, legacy overrides, validation, ordering and frames (scripts/prompt-blocks-failures.md B1–B10).
import assert from "node:assert/strict";
import {
  BUILTIN_PROMPT_BLOCKS,
  PROMPT_BLOCK_LIMITS,
  PROMPT_TARGETS,
  composePrompt,
  legacyEditorText,
  normalizePromptBlocks,
  projectBehavior,
  resolvePromptBlocks,
  taskHelperBehavior,
} from "../src/prompt-blocks.ts";
import {
  COORDINATOR_CONTEXT_RULES,
  DEFAULT_ROLE_PROMPTS,
  HOST_AGENT_PROMPT,
  SHARED_ROLE_RULES,
  TASK_HELPER_PROMPT,
  taskHelperFrame,
} from "../src/role-prompts.ts";

const project = (extra = {}) => ({ name: "Demo", objective: "Build it", ...extra });
const ids = (target) => BUILTIN_PROMPT_BLOCKS[target].map((block) => block.id);
const defaults = (target) => BUILTIN_PROMPT_BLOCKS[target].map((block) => ({ id: block.id, enabled: true }));
const refused = (target, list, pattern, label) => assert.throws(() => normalizePromptBlocks(target, list), pattern, label);

// B1: nothing saved is today's text, byte for byte.
for (const role of ["coordinator", "worker", "scout", "reviewer"])
  assert.equal(projectBehavior(project(), role).text, DEFAULT_ROLE_PROMPTS[role], `B1 ${role} default`);
assert.equal(resolvePromptBlocks("host").text, HOST_AGENT_PROMPT, "B1 host default");
assert.equal(projectBehavior(project(), "taskHelper").text, TASK_HELPER_PROMPT, "B1 task helper default");
const helper = (p, access, standing) => composePrompt(taskHelperFrame(p, access, standing, "\nSUFFIX"), taskHelperBehavior(p));
assert.equal(
  helper(project(), "maintain", "STANDING"),
  `You are a task helper for Demo. Project instructions: Build it\n\nRepository instructions (frozen for this thread):\nSTANDING\n\n${TASK_HELPER_PROMPT}\n${SHARED_ROLE_RULES} You may write revision-checked knowledge topics with projects_knowledge_write.\nSUFFIX`,
  "B1 task helper instructions",
);
assert.equal(
  helper(project(), "read-only", ""),
  `You are a task helper for Demo. Project instructions: Build it\n\n${TASK_HELPER_PROMPT}\n${SHARED_ROLE_RULES}\nSUFFIX`,
  "B1 task helper without repository instructions",
);
for (const target of PROMPT_TARGETS) assert.equal(resolvePromptBlocks(target).customized, false, `B1 ${target} not customized`);

// B2: a legacy override is the exact old text, marked legacy, and reaches task helpers as owner worker instructions.
const legacy = project({ prompts: { worker: "OWNER WORKER TEXT", scout: "S" } });
const legacyWorker = projectBehavior(legacy, "worker");
assert.equal(legacyWorker.text, "OWNER WORKER TEXT", "B2 legacy text");
assert.ok(legacyWorker.legacy && legacyWorker.customized, "B2 legacy flagged");
assert.deepEqual(
  legacyWorker.blocks.filter((block) => block.enabled).map((block) => [block.id, block.kind]),
  [["custom:legacy", "custom"]],
  "B2 legacy shows as one custom block over disabled built-ins",
);
assert.equal(projectBehavior(legacy, "coordinator").text, DEFAULT_ROLE_PROMPTS.coordinator, "B2 other roles keep defaults");
assert.ok(
  helper(legacy, "maintain", "").includes(`Build it\n\nOwner worker instructions:\nOWNER WORKER TEXT\n\n${TASK_HELPER_PROMPT}\n`),
  "B2 task helper owner instructions",
);

// B3: the list order is the order; disabled text is gone.
const [first, second, ...rest] = ids("worker");
const custom = { id: "custom:style", name: "Style", enabled: true, text: "Prefer small commits." };
const saved = normalizePromptBlocks("worker", [
  custom,
  { id: second, enabled: true },
  { id: first, enabled: false },
  ...rest.map((id) => ({ id, enabled: true })),
]);
const ordered = resolvePromptBlocks("worker", saved);
const texts = BUILTIN_PROMPT_BLOCKS.worker.map((block) => block.text);
assert.equal(ordered.text, ["Prefer small commits.", texts[1], ...texts.slice(2)].join("\n"), "B3 order and disabled");
assert.deepEqual(
  ordered.blocks.map((block) => block.id),
  ["custom:style", second, first, ...rest],
  "B3 resolved order",
);
assert.ok(ordered.customized && !ordered.legacy, "B3 customized");
assert.equal(
  taskHelperBehavior(project({ promptBlocks: { worker: saved } })).startsWith("Owner worker instructions:\nPrefer small commits.\n\n"),
  true,
  "B3 custom worker blocks reach task helpers",
);

// B4: refusals.
const list = defaults("worker");
refused("worker", [...list, { id: first, enabled: true }], /duplicate/i, "B4 duplicate");
refused("worker", [...list, { id: "made-up", enabled: true }], /unknown/i, "B4 unknown built-in");
refused("worker", list.slice(1), /missing/i, "B4 missing built-in");
refused("worker", [...list, { id: "custom:", name: "x", enabled: true, text: "x" }], /custom block id/i, "B4 bad custom id");
refused("worker", [...list, { id: "custom:a", enabled: true, text: "x" }], /name/i, "B4 custom without name");
refused("worker", [...list, { id: "custom:a", name: "x", enabled: true }], /text/i, "B4 custom without text");
refused("worker", [{ ...list[0], name: "Renamed" }, ...list.slice(1)], /name/i, "B4 built-in rename");
const many = Array.from({ length: PROMPT_BLOCK_LIMITS.maxCustom + 1 }, (_, n) => ({
  id: `custom:c${n}`,
  name: `C${n}`,
  enabled: false,
  text: "x",
}));
refused("worker", [...list, ...many], /custom blocks/i, "B4 too many custom blocks");
const big = "x".repeat(PROMPT_BLOCK_LIMITS.maxBlockChars);
refused(
  "worker",
  [...list, ...[1, 2, 3].map((n) => ({ id: `custom:big${n}`, name: `Big ${n}`, enabled: true, text: big }))],
  /characters/i,
  "B4 aggregate limit",
);
refused("worker", [...list, { id: "custom:big", name: "Big", enabled: true, text: big + "x" }], /characters/i, "B4 block limit");

// B5: default text is no override; a default list stores nothing.
const restored = normalizePromptBlocks(
  "worker",
  BUILTIN_PROMPT_BLOCKS.worker.map((block, n) => ({ id: block.id, enabled: n !== 0, text: block.text })),
);
assert.ok(
  restored.every((block) => !("text" in block)),
  "B5 default text is not stored",
);
assert.equal(normalizePromptBlocks("worker", defaults("worker")), undefined, "B5 the default list stores nothing");

// B6: a list saved before a new built-in existed still gets it, at its default position.
const older = defaults("worker").filter((block) => block.id !== second);
older.unshift(custom);
const upgraded = resolvePromptBlocks("worker", older);
assert.deepEqual(
  upgraded.blocks.map((block) => block.id),
  ["custom:style", first, second, ...rest],
  "B6 missing built-in inserted",
);
assert.ok(upgraded.blocks.find((block) => block.id === second).enabled, "B6 inserted built-in enabled");

// B7: a frame composes exactly and does not depend on behavior.
const frame = { before: "HOST\n\nREPO", lead: "\n\n", after: "\n\nSKILLS\nWORKSPACE" };
assert.equal(composePrompt(frame, "ROLE"), "HOST\n\nREPO\n\nROLE\n\nSKILLS\nWORKSPACE", "B7 compose");
assert.equal(composePrompt(frame, ""), "HOST\n\nREPO\n\nSKILLS\nWORKSPACE", "B7 empty behavior");

// B8: authority stays out of every block.
for (const target of PROMPT_TARGETS)
  for (const block of BUILTIN_PROMPT_BLOCKS[target])
    assert.ok(!block.text.includes(SHARED_ROLE_RULES) && !block.text.includes(COORDINATOR_CONTEXT_RULES), `B8 ${target}.${block.id}`);

// B9: every built-in block is editable behavior, including the Host agent's own.
for (const target of PROMPT_TARGETS)
  assert.ok(
    BUILTIN_PROMPT_BLOCKS[target].every((block) => !("locked" in block)),
    `B9 ${target} has no locked blocks`,
  );
const hostOff = normalizePromptBlocks(
  "host",
  defaults("host").map((block, n) => ({ ...block, enabled: n !== 1 })),
);
assert.equal(
  resolvePromptBlocks("host", hostOff).text,
  HOST_AGENT_PROMPT.split("\n")
    .filter((_, n) => n !== 1)
    .join("\n"),
  "B9 host block off",
);

// B10: the coordinator's context habits are an editable block; the generated contract keeps only the fact and the guard.
const OLD_CONTEXT_RULES = `Every tool answer stays in this chat until compaction. Read an agent's report first, then only the evidence it points to: one diff path, one artifact, one transcript ref. Read files and diffs by path and line range, not whole trees. Brief agents with refs they can open (branch, commit, file paths, artifact and report refs) instead of pasting source or logs. A skill or file you read fully in this chat stays in context while it is unchanged: you need not reread it. Read it again after a compaction or /reload, when it or your instructions changed, when your earlier read was partial, or when a skill, instruction or task requires it. These habits never replace a required skill read, proof or evidence check.`;
const habits = BUILTIN_PROMPT_BLOCKS.coordinator.find((block) => block.id === "context");
assert.ok(habits && !("locked" in habits), "B10 context habits are an editable coordinator block");
const generated = `${COORDINATOR_CONTEXT_RULES}\n${DEFAULT_ROLE_PROMPTS.coordinator}`;
for (const sentence of OLD_CONTEXT_RULES.split(/(?<=\.) /)) {
  const where = [COORDINATOR_CONTEXT_RULES.includes(sentence), habits.text.includes(sentence)];
  assert.ok(generated.split(sentence).length === 2 || sentence.startsWith("These habits"), `B10 "${sentence.slice(0, 40)}" appears once`);
  assert.ok(where.filter(Boolean).length <= 1, `B10 "${sentence.slice(0, 40)}" is in one place`);
}
assert.ok(
  habits.text.startsWith("Read an agent's report first") && habits.text.includes("when a skill, instruction or task requires it."),
  "B10 habits moved",
);
assert.ok(
  COORDINATOR_CONTEXT_RULES.includes("Every tool answer stays in this chat until compaction") &&
    /never replaces? a required skill read, proof or evidence check/.test(COORDINATOR_CONTEXT_RULES) &&
    !COORDINATOR_CONTEXT_RULES.includes("Read an agent's report first"),
  "B10 the contract keeps the fact and the guard only",
);
const legacyCoordinator = projectBehavior(project({ prompts: { coordinator: "OLD COORD" } }), "coordinator");
assert.equal(legacyCoordinator.text, `OLD COORD\n${habits.text}`, "B10 a legacy coordinator override keeps the habits it ran with");
assert.equal(
  projectBehavior(project({ prompts: { coordinator: legacyEditorText(project(), "coordinator") } }), "coordinator").text,
  DEFAULT_ROLE_PROMPTS.coordinator,
  "B10 saving the older editor's default text back as an override keeps the default behavior, without doubled habits",
);
const habitsOff = normalizePromptBlocks(
  "coordinator",
  defaults("coordinator").map((block) => ({ ...block, enabled: block.id !== "context" })),
);
assert.ok(!resolvePromptBlocks("coordinator", habitsOff).text.includes(habits.text), "B10 habits can be turned off");

console.log("prompt-blocks-unit: ok");
