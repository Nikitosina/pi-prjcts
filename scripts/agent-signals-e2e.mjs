// Agent signals: the glued-words and source-write detectors, the warnings bash and projects_bg_start add, and a long
// projects_bg_status wait that a queued message ends early. Bare Pi Durable Harness, faux model, temp folders only.
// Failure cases: scripts/agent-signals-failures.md.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBackgroundCommands } from "../src/background-commands.ts";
import { coordinatorExecutionTools } from "../src/coordinator-execution.ts";
import { gluedWords, gluedWordsWarning } from "../src/glued-words.ts";
import { ResourceLeases } from "../src/resource-leases.ts";
import { sourceWrites } from "../src/source-writes.ts";
import { workerEnvironmentTools } from "../src/worker-environment-tools.ts";

// ── Glued words (G1-G3, G5).
const latin = "Couldmerelykeepownedsessionrunningwhilelocaldebugandrenewlease";
const cyrillic = "атомарнопосуществующемуledger,далееперераспределениерезервов";
assert.deepEqual(gluedWords(`Plan: ${latin} next.`), [latin]);
assert.deepEqual(gluedWords(`Шаг: ${cyrillic}.`), [`${cyrillic}.`]);
assert.deepEqual(gluedWords("x".repeat(50)), [], "50 characters is the limit, not a suspect");
assert.deepEqual(gluedWords("ж".repeat(51)), ["ж".repeat(51)], "counted in characters");
const sha40 = "0123456789abcdef0123456789abcdef01234567",
  sha64 = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
for (const clean of [
  `Commit ${sha40} and ${sha64}.`,
  `Tip ${sha64}), then ${sha64.toUpperCase()},`,
  "Id 6f1c2a9e-0b7d-4c3e-9a51-2d4e6f8a0b1c and 6f1c2a9e0b7d4c3e9a512d4e6f8a0b1c6f1c2a9e0b7d4c3e9a512d4e6f8a0b1c",
  "Read src/very/long/path/to/some/module/that/is/deeply/nested/file-name-here.ts now",
  "See https://github.com/Nikitosina/pi-prjcts/pull/37/files#diff-0123456789abcdef",
  "Call some_very_long_identifier_name_that_keeps_going_and_going_forever()",
  "Set PI_PROJECTS_STALL_TICK_MS=thirtythousandmillisecondsisthedefaultvaluehere",
  "Inline `Couldmerelykeepownedsessionrunningwhilelocaldebugandrenewlease` code",
  "Fenced:\n```\nCouldmerelykeepownedsessionrunningwhilelocaldebugandrenewlease\n```\nend",
  "Arrow mover→YKTextOutputEditor→interceptor is fine",
])
  assert.deepEqual(gluedWords(clean), [], clean);
assert.equal(gluedWordsWarning("All words are spaced."), null);
const many = Array.from({ length: 7 }, (_, n) => `${String.fromCharCode(97 + n)}${"glued".repeat(14)}`).join(" ");
const warning = gluedWordsWarning(many);
assert.ok(warning, "a warning for glued words");
assert.match(warning, /normal spacing/i);
const listed = [...warning.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.equal(listed.length, 5, "at most 5 suspects are listed");
assert.ok(
  listed.every((item) => [...item].length <= 61),
  "each suspect is cut to about 60 characters",
);

// ── Source writes through bash (S1-S7, S11).
const flagged = [
  "sed -i 's/a/b/' src/x.ts",
  "sed -i '' 's/a/b/' src/x.ts",
  "sed -i.bak -e 's/a/b/' src/x.ts",
  "sed -Ei 's/a/b/' x.ts",
  "sed -n -i '1p' x",
  "sed --in-place 's/a/b/' x",
  "sed --in-place=.orig -e s/a/b/ x",
  "sed -e 's/a/b/' -i x",
  "find src -name '*.ts' -exec sed -i 's/a/b/' {} +",
  "grep -rl foo src | xargs sed -i 's/foo/bar/'",
  "bash -c \"sed -i 's/a/b/' x\"",
  "cd src && sed -i 's/a/b/' x.ts",
  "true; gsed -i s/a/b/ x",
  "/usr/bin/sed -i s/a/b/ x 2>/dev/null",
  "sed -i 's/a/b/' /tmp/a.txt src/b.ts",
  "perl -pi -e 's/a/b/' x",
  "perl -i -pe 's/a/b/' x",
  "perl -pi.bak -e 's/a/b/' x",
  "perl -0777 -pi -e 's/a/b/s' x",
  "perl -0pi -e 's/a/b/s' x",
  "python3 - <<'EOF'\nfrom pathlib import Path\np = Path('src/a.ts')\ns = p.read_text()\np.write_text(s.replace('a', 'b'))\nEOF",
  "python3 -c \"open('src/x.ts','w').write('x')\"",
  'python -c \'import re;f=open("a.txt", "a");f.write("x")\'',
  'python3 <<EOF\nwith open(path, "r+") as f:\n    f.write(x)\nEOF',
  "python3 -c \"open(p, mode='w', encoding='utf8').write(s)\"",
  "python3 -c \"Path('src/a.py').write_bytes(b'')\"",
  "node -e \"require('fs').writeFileSync('src/a.ts', s)\"",
  "node - <<'EOF'\nconst fs = require('fs');\nfs.appendFileSync(p, 'x');\nEOF",
  'node -e "await fs.promises.writeFile(p, s)"',
  "python3 -c \"open('/tmp/a','w'); open('src/b','w')\"",
  "python3 -c \"open(p,'w')\"",
];
for (const command of flagged) assert.equal(sourceWrites(command).kind, "source-write", `flagged: ${command}`);
const clean = [
  "sed -n '1,20p' src/x.ts",
  "sed 's/a/b/' x > /tmp/y",
  'grep -r "sed -i" src',
  "echo sed -i x; echo perl -pi x",
  "git log --format=%s | sed -e 's/i/x/' -e 's/in/out/'",
  "sed -f script.sed file",
  "sed -i 's/a/b/' /tmp/x.txt /private/tmp/y",
  "sed -i '' s/a/b/ \"$PI_WORKSPACE_CACHE/x\" ${PI_WORKSPACE_CACHE}/y $TMPDIR/z",
  "perl -ne 'print if /i/' x",
  "perl -MList::Util=sum -e 'print sum(1)'",
  "perl -le 'print 1'",
  "perl -pi -e 's/a/b/' /tmp/x",
  "python3 -c \"import json;print(json.load(open('package.json'))['name'])\"",
  "python3 - <<'EOF'\nfor line in open('a.txt', 'r'):\n    print(line)\nEOF",
  "python3 -c \"from pathlib import Path; print(Path('x').read_text())\"",
  "python3 -c \"print(open('a', encoding='utf-8').read())\"",
  "node -e \"console.log(require('fs').readFileSync('package.json','utf8'))\"",
  "python3 -c \"open('/tmp/out.txt','w').write('x')\"",
  "python3 -c \"import os;open(os.environ['PI_WORKSPACE_CACHE']+'/x','w')\"",
  "node -e \"require('fs').writeFileSync('/tmp/x.json', s)\"",
  "python3 -m pytest tests",
  "python3 tools/gen.py --write",
  "npm test",
];
for (const command of clean) assert.equal(sourceWrites(command).kind, "none", `not flagged: ${command}`);
for (const malformed of ["sed -i 's/a/b x", "python3 <<EOF\nopen('x','w')", "bash -c", "sed", "perl -", "node -e", ""])
  assert.doesNotThrow(() => sourceWrites(malformed), malformed);

// ── Wiring on a Harness: bash and projects_bg_start warn (S8-S10); a long projects_bg_status wait ends on a queued message (Q1-Q6).
const dir = mkdtempSync(join(tmpdir(), "agent-signals-"));
const work = join(dir, "work");
mkdirSync(work);
const model = { provider: "faux", modelId: "faux-1" };
const AGENT = "6f1c2a9e-0b7d-4c3e-9a51-2d4e6f8a0b1c";
const background = createBackgroundCommands({ controlRoot: dir });
const execution = coordinatorExecutionTools({ controlRoot: dir, target: async () => ({ cwd: work, scope: AGENT }) });
const environment = workerEnvironmentTools({
  projectId: "project-1",
  leases: new ResourceLeases(),
  background,
  target: () => ({ threadId: AGENT, cwd: work, env: process.env, guard: (command) => command }),
});
const Signals = defineExtension({ name: "signals", tools: [...execution.tools, ...environment] });

const text = (content) =>
  typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const results = [],
  seen = new Set();
const waitArgs = { tailLines: 5 };
function route(request) {
  const messages = request.messages.filter((message) => message.role !== "system");
  const last = messages.at(-1);
  const brief = text(messages.findLast((message) => message.role === "user").content);
  // Every result once, under the input that led to it (a steer is placed after the result it interrupted).
  let owner = "";
  for (const message of messages) {
    if (message.role === "user") owner = text(message.content);
    if (message.role === "toolResult" && !seen.has(message.toolCallId)) {
      seen.add(message.toolCallId);
      results.push({ brief: owner, name: message.toolName, text: text(message.content), isError: message.isError });
    }
  }
  const result = last.role === "toolResult" ? text(last.content) : "";
  const steps = messages.slice(messages.findLastIndex((message) => message.role === "user") + 1).filter((m) => m.role === "toolResult");
  if (brief === "EDIT" && !steps.length)
    return call("bash", { command: "printf 'a\\n' > f.txt && sed -i.bak 's/a/b/' f.txt && cat f.txt" });
  if (brief === "READ" && !steps.length) return call("bash", { command: "sed -n 1p f.txt" });
  if (brief === "BGEDIT") {
    if (!steps.length) return call("projects_bg_start", { command: "sed -i.bak 's/b/c/' f.txt", label: "edit" });
    if (steps.length === 1) return call("projects_bg_status", { id: JSON.parse(result).id, waitSeconds: 30 });
  }
  if (brief.startsWith("BGWAIT")) {
    if (!steps.length) return call("projects_bg_start", { command: "sleep 60", label: "long" });
    if (steps.length === 1) waitArgs.id = JSON.parse(result).id;
    if (steps.length === 1) return call("projects_bg_status", { id: waitArgs.id, waitSeconds: 1801 });
    if (steps.length === 2) return call("projects_bg_status", { id: waitArgs.id, waitSeconds: 1800 });
    if (brief === "BGWAIT-FOLLOWUP" && steps.length === 3) return call("projects_bg_status", { id: waitArgs.id, waitSeconds: 3 });
  }
  return fauxAssistantMessage([fauxText("Done.")]);
}
const models = createModels();
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 200 }, () => route));
const registry = createRegistry();
registry.install(Signals);
const harness = await Harness.open(
  await openNodeSqliteStorage(join(dir, "session.sqlite")),
  { models, registry, settings: { followUpMode: "all", steeringMode: "all", retry: { maxRetries: 0 } } },
  context,
);
harness.resume();
const root = await harness.root(context, { agent: { model, cwd: work, instructions: "signals", extensions: [Signals] } });
const ask = async (content) => (await root.submit({ type: "input", content }, context)).wait(context);
const until = async (check, what, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(20)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`Timed out: ${what}`);
};
const within = (promise, what, ms = 15_000) =>
  Promise.race([promise, delay(ms).then(() => Promise.reject(new Error(`Timed out: ${what}`)))]);
const of = (brief) => results.filter((item) => item.brief === brief);

try {
  // S8, S9: the command runs and prints as before; the model sees one warning line after it.
  await ask("EDIT");
  const [edit] = of("EDIT");
  assert.equal(edit.isError, false, edit.text);
  assert.match(edit.text, /^b\n/, "the command ran and its output is unchanged");
  assert.equal(readFileSync(join(work, "f.txt"), "utf8"), "b\n");
  assert.match(edit.text, /<harness>\n\[warn\] .*edit tool.*str\.replace.*\n<\/harness>$/s, edit.text);
  await ask("READ");
  assert.doesNotMatch(of("READ")[0].text, /<harness>/, "read-only sed gets no warning");

  // S10: a background command gets the same warning and still runs.
  await ask("BGEDIT");
  assert.match(of("BGEDIT")[0].text, /\[warn\] .*edit tool/);
  assert.equal(readFileSync(join(work, "f.txt"), "utf8"), "c\n", "the background command ran");

  // Q1, Q2, Q5: 1801 s is refused, 1800 s is accepted; a steer ends the wait early with the command still running.
  const waiting = async () =>
    ((await harness.snapshot(LiveDoc, root.id, context))?.tools ?? []).some(
      (slot) => slot.name === "projects_bg_status" && slot.status === "running",
    );
  const steered = await root.submit({ type: "input", content: "BGWAIT" }, context);
  await until(waiting, "the steer wait started");
  const steerAt = Date.now();
  await root.submit({ type: "input", content: "Owner steer", whenBusy: "steer" }, context);
  await within(steered.wait(context), "a steer ends the 1800 s wait");
  const [refused, steerWait] = of("BGWAIT").slice(1);
  assert.equal(refused.isError, true, "waitSeconds above 1800 is refused");
  assert.ok(Date.now() - steerAt < 8000, "the steer ended the wait early");
  const steerStatus = JSON.parse(steerWait.text);
  assert.equal(steerStatus.state, "running");
  assert.match(steerStatus.note, /message/i);
  assert.ok(
    (await root.entries({}, 50, undefined, context)).items.some((entry) => text(entry.model?.[0]?.content ?? "") === "Owner steer"),
    "the steer reached the conversation",
  );
  await background.killThread(AGENT);

  // Q3, Q4: a follow-up ends a wait too; a later wait is not ended by the follow-up already queued.
  const followed = await root.submit({ type: "input", content: "BGWAIT-FOLLOWUP" }, context);
  await until(async () => of("BGWAIT-FOLLOWUP").length === 2 && (await waiting()), "the follow-up wait started");
  const followAt = Date.now();
  const followUp = await root.submit({ type: "input", content: "Owner follow-up", whenBusy: "followUp" }, context);
  await until(() => of("BGWAIT-FOLLOWUP").length === 3, "the follow-up ended the wait");
  assert.ok(Date.now() - followAt < 8000);
  assert.equal(JSON.parse(of("BGWAIT-FOLLOWUP")[2].text).state, "running");
  assert.match(JSON.parse(of("BGWAIT-FOLLOWUP")[2].text).note, /follow-up/i);
  const againAt = Date.now();
  await until(() => of("BGWAIT-FOLLOWUP").length === 4, "the next wait ran out");
  assert.ok(Date.now() - againAt >= 2500, "an already queued follow-up does not end the next wait");
  assert.equal(JSON.parse(of("BGWAIT-FOLLOWUP")[3].text).note, undefined);
  await followed.wait(context);
  await followUp.wait(context);
  await background.killThread(AGENT);
} finally {
  await background.killAll();
  await harness.close(context);
  rmSync(dir, { recursive: true, force: true });
}
console.log("agent-signals-e2e: ok");
