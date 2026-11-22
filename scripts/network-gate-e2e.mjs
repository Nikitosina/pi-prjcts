import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  await kit.eventually(async () => !(await status()).paused.includes(b), "noticed manual resume");
  for (const enabled of [false, true]) {
    await kit.rpc({ action: "project-plugin", id: b, plugin: "network-gate", enabled });
    await kit.delay(700);
  }
  assert.equal(await paused(b), false, "switch must not undo the owner resume");
  await kit.stopHost();
  const file = join(kit.home, "plugins", "network-gate", "outage.json");
  const episode = JSON.parse(readFileSync(file, "utf8"));
  // Simulate losing the plugin acknowledgment on either side of the Durable pause commit.
  episode.projects[b] = "claiming";
  episode.projects[d] = "claiming";
  writeFileSync(file, JSON.stringify(episode));
  kit.startHost();
  await kit.waitHost();
  await kit.rpc({ action: "project-plugin", id: d, plugin: "network-gate", enabled: true });
  await kit.eventually(async () => await paused(d), "interrupted claim retried");
  assert.equal(await paused(b), false, "a repeated claim did not override a resume");
  await rpc("resume", d);
  await rpc("pause", b);
  await kit.eventually(async () => (await status()).paused.join() === a, "manual override survived restart");
  sample(true);
  await kit.eventually(async () => !(await paused(a)), "claimed project resumed");
  assert.equal(await paused(b), true);
  assert.equal(await paused(c), true);
  assert.deepEqual((await status()).paused, []);
});
