import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createKit } from "./lib/e2e-kit.mjs";
const kit = await createKit("network-gate", { env: { PI_PROJECTS_PLUGINS: join(process.cwd(), "scripts/fixtures/network-gate.mjs") } });
const sample = (good) => writeFileSync(join(kit.home, "fake-vpn"), good ? "up" : "down");
await kit.run(async () => {
  kit.initRepo();
  const make = async (name) => {
    const cwd = join(kit.root, name);
    mkdirSync(cwd);
    kit.initRepo(cwd);
    return kit.createProject(name, { cwd });
  };
  sample(true);
  const a = await make("auto"),
    b = await make("override"),
    c = await make("manual"),
    d = await make("disabled");
  const rpc = (action, id) => kit.rpc({ action, id });
  const paused = async (id) => (await rpc("jobs-snapshot", id)).paused;
  const status = () => kit.rpc({ action: "plugin", plugin: "network-gate", method: "status", id: a });
  await rpc("pause", c);
  await kit.rpc({ action: "project-plugin", id: d, plugin: "network-gate", enabled: false });
  sample(false);
  await kit.eventually(async () => (await status()).paused.length === 2, "plugin claimed two projects");
  assert.equal(await paused(a), true);
  assert.equal(await paused(d), false);
  await rpc("resume", b);
  await rpc("pause", b);
  await kit.restartHost();
  await kit.eventually(async () => (await status()).paused.join() === a, "manual override survived restart");
  sample(true);
  await kit.eventually(async () => !(await paused(a)), "claimed project resumed");
  assert.equal(await paused(b), true);
  assert.equal(await paused(c), true);
  assert.deepEqual((await status()).paused, []);
});
