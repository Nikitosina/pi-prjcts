// Unit checks for src/routine-script.ts: exact command, output tail, timeouts that kill the process group, failures and log pruning.
// Failure cases: scripts/routine-script-failures.md. Temp folders and /bin/zsh only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OUTPUT_BYTES, pruneRunLogs, runScript, scriptError } from "../src/routine-script.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "routine-script-unit-")));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const run = (command, extra = {}) =>
    runScript({
      command,
      cwd,
      env: { ...process.env, ROUTINE_VALUE: "from env" },
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      ...extra,
    });

  // S1: the command runs exactly, in zsh, in the given folder, with the given env.
  const exact = await run(`  printf '%s|' "$ZSH_NAME" "$PWD" "$ROUTINE_VALUE" 'a  b' ; echo "two words"  `);
  assert.equal(exact.exitCode, 0);
  assert.equal(exact.output, `zsh|${cwd}|from env|a  b|two words\n`);
  assert.equal(exact.timedOut, false);
  assert.ok(exact.durationMs >= 0);

  // S2: only the last 64 KB of output is kept, stdout and stderr together.
  const loud = await run(`for i in {1..3000}; do echo "line $i $(printf '%050d' 0)"; done; echo LAST-ERR >&2`);
  assert.equal(loud.exitCode, 0);
  assert.ok(Buffer.byteLength(loud.output) <= OUTPUT_BYTES, String(Buffer.byteLength(loud.output)));
  assert.ok(loud.truncated && loud.output.endsWith("LAST-ERR\n") && !loud.output.includes("line 1 "), loud.output.slice(-200));

  // S3: a timeout kills the whole process group, background children included.
  const pidFile = join(root, "child.pid");
  const slow = await run(`sleep 30 & echo $! > ${pidFile}; wait`, { timeoutMs: 500 });
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.exitCode, 0);
  const child = Number(readFileSync(pidFile, "utf8"));
  await delay(200);
  assert.equal(alive(child), false, "the background child died with the run");
  const abort = new AbortController();
  const aborted = run("sleep 30", { signal: abort.signal });
  await delay(200);
  abort.abort();
  const stopped = await aborted;
  assert.ok(stopped.exitCode !== 0 && stopped.durationMs < 5000, JSON.stringify(stopped));

  // S4: failures are failures.
  assert.equal((await run("exit 3")).exitCode, 3);
  assert.notEqual((await run("kill -TERM $$")).exitCode, 0);
  const missingShell = await runScript({
    command: "true",
    cwd: join(root, "missing"),
    env: process.env,
    timeoutMs: 1000,
    signal: new AbortController().signal,
  });
  assert.notEqual(missingShell.exitCode, 0, "a run that cannot start is a failure");
  assert.match(missingShell.output, /ENOENT|no such/i);

  // Settings.
  assert.equal(scriptError({ command: "make clean", timeoutMs: 600_000 }), null);
  for (const bad of [
    { command: "", timeoutMs: 600_000 },
    { command: "x".repeat(32_001), timeoutMs: 600_000 },
    { command: "ok", timeoutMs: 1000 },
    { command: "ok", timeoutMs: 7_200_001 },
  ])
    assert.notEqual(scriptError(bad), null, JSON.stringify(bad).slice(0, 60));

  // S5: pruning keeps the newest runs by name (run logs are named by start time).
  const logs = join(root, "logs");
  mkdirSync(logs);
  for (let i = 1; i <= 53; i++) writeFileSync(join(logs, `${String(1_000 + i)}.json`), String(i));
  writeFileSync(join(logs, "notes.txt"), "not a log");
  pruneRunLogs(logs, 50);
  const kept = readdirSync(logs)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(kept.length, 50);
  assert.equal(kept[0], "1004.json");
  assert.ok(existsSync(join(logs, "notes.txt")));
  pruneRunLogs(join(root, "no-logs"), 50);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("routine-script unit: all checks passed");
