import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { PluginStatus } from "./plugin-types.ts";

/*
 * Plugin development from the CLI (`projects plugin new|check`). `new` writes a minimal plugin with its own test into an empty
 * directory anywhere; `check` loads one plugin through the host's own loader in a fresh temporary home, so it never reads or writes
 * a live home and reports exactly the status a host would record. Activating a plugin on a host stays a separate, explicit step.
 */

/** Same rule as the loader's; checked here so a scaffold never carries a name the host would refuse. */
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

const files = (name: string): Record<string, string> => ({
  "index.mjs": `// ${name}: a pi-prjcts plugin. Contract: PLUGINS.md and HostPluginApi in src/plugin-types.ts of the pi-prjcts repository.
export const greet = (who) => \`Hello, \${who || "world"}!\`;

export default {
  name: "${name}",
  version: "0.1.0",
  register(api) {
    api.provide({
      // Called as { action: "plugin", plugin: "${name}", method: "hello", params: { who } }; "read" lets agents call it without approval.
      rpc: { hello: async ({ params }) => ({ greeting: greet(typeof params?.who === "string" ? params.who : "") }) },
      rpcPolicy: { hello: "read" },
    });
  },
};
`,
  "index.test.mjs": `import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";

test("registers a read RPC that greets", async () => {
  const provided = {};
  await plugin.register({ name: plugin.name, provide: (capabilities) => Object.assign(provided, capabilities) });
  assert.equal(provided.rpcPolicy.hello, "read");
  assert.deepEqual(await provided.rpc.hello({ params: { who: "owner" } }), { greeting: "Hello, owner!" });
});
`,
  "README.md": `# ${name}

A pi-prjcts plugin. The contract is \`PLUGINS.md\` in the pi-prjcts repository.

- Test: \`node --test\` in this directory.
- Check that a host would load it: \`npm run projects -- plugin check <this directory>\` from the pi-prjcts checkout.
- Try it on a private host with a fake model: \`node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --plugin <this directory>\` from the pi-prjcts checkout, then open the printed origin and look at Plugins in the context panel.
- Activate it on a host: add this directory to that host's \`plugins.json\` and restart the host. Later changes here take effect at the next restart.
`,
});

export function scaffoldPlugin(dir: string, name = basename(resolve(dir))): { dir: string; name: string; files: string[] } {
  if (!NAME.test(name)) throw new Error(`plugin name ${JSON.stringify(name)} must match ${NAME} (lowercase letters, digits, dashes)`);
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} is not empty; choose a new or empty directory`);
  mkdirSync(target, { recursive: true });
  const content = files(name);
  for (const [file, text] of Object.entries(content)) writeFileSync(join(target, file), text, { flag: "wx" });
  return { dir: target, name, files: Object.keys(content) };
}

/** Loads only `path` with the host loader in a temporary home that is removed afterwards. Run it in its own process: it sets the home. */
export async function checkPlugin(path: string): Promise<{ ok: boolean; home: string; plugins: PluginStatus[] }> {
  const source = resolve(path);
  // The env list is ":"-separated, so such a path would load as two.
  if (source.includes(":")) throw new Error(`a plugin path cannot contain ":": ${source}`);
  const home = mkdtempSync(join(tmpdir(), "pi-plugin-check-"));
  process.env.PI_PROJECTS_HOME = home;
  process.env.PI_PROJECTS_PLUGINS = source;
  try {
    const { plugins } = await import("./plugins.ts");
    const statuses = await plugins.load();
    await plugins.close();
    return { ok: statuses.every((item) => item.state === "loaded"), home, plugins: statuses };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
