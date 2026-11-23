import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, call, say } from "./lib/e2e-kit.mjs";
const fake = new URL("./fixtures/fake-vcs-plugin", import.meta.url).pathname;
let candidate;
const kit = await createKit("ready-files", {
  env: { PI_PROJECTS_PLUGINS: fake },
  handler: ({ role, user, results }) => {
    if (role === "coordinator" && user.startsWith("Report files") && !results.length)
      return call("agents", { action: "spawn", role: "worker", title: user, brief: user, acceptance: ["Report files"] });
    if (role === "worker" && !results.length) return call("job", { action: "ready", summary: "Checked.", candidate });
    return say("Done.");
  },
});
const git = (...args) => kit.git(kit.workspace, ...args);
kit.initRepo();
writeFileSync(join(kit.workspace, "deleted"), "deleted content");
git("add", ".");
git("commit", "-qm", "common base");
git("checkout", "-qb", "topic");
git("rm", "deleted");
git("mv", "README.md", "renamed");
git("commit", "-qm", "rename");
git("checkout", "-q", "main");
writeFileSync(join(kit.workspace, "upstream-only"), "base advanced");
git("add", ".");
git("commit", "-qm", "advance base");
git("checkout", "-q", "topic");
for (let i = 0; i < 24; i++) writeFileSync(join(kit.workspace, `z-${i}`), "");
git("add", ".");
git("commit", "-qm", "many additions");
const root = git("rev-list", "--max-parents=0", "HEAD");
candidate = git("rev-parse", "HEAD");
git("checkout", "-q", "main");
git("tag", "main", candidate);
const checkout = join(kit.root, "provider");
mkdirSync(join(checkout, ".fakevcs"), { recursive: true });
kit.hostEnv.FAKE_PLUGIN_DATA = join(kit.root, "fake.json");
writeFileSync(kit.hostEnv.FAKE_PLUGIN_DATA, JSON.stringify({ prs: [], published: [], worktreeRoot: checkout + "-worktrees" }));
await kit.run(async () => {
  async function report(id, name) {
    await kit.ask(id, "Report files " + name);
    const job = (await kit.jobs(id)).at(-1);
    kit.check(name + " reached Ready", job.status === "ready", job);
    return job.ready.files;
  }
  const id = await kit.createProject("Git");
  const files = await report(id, "git");
  kit.check(
    "Git compares the pinned candidate against the merge base, with rename and cap",
    files?.includes("R100\tREADME.md\trenamed") &&
      files.includes("A\tz-0") &&
      files.includes("D\tdeleted") &&
      files.includes("6 omitted") &&
      !files.includes("upstream-only"),
    files,
  );
  const page = await kit.openPage(await kit.webUrl(id));
  await page.waitFor("document.querySelector('[data-worker-history]')", "history");
  await page.evaluate("document.querySelector('[data-worker-history]').click()");
  await page.waitFor("document.querySelector('#workers .w-title')", "worker");
  await page.evaluate("document.querySelector('#workers .w-title').click()");
  await page.waitFor("document.querySelector('.report-card')?.innerText.includes('6 omitted')", "focused Ready report");
  await page.shot("ready-files", { force: true });
  candidate = "0".repeat(40);
  kit.check("Unreadable candidate does not block Ready", (await report(id, "unknown")) === "unavailable");
  candidate = root;
  const provider = await kit.createProject("Plugin", { cwd: checkout });
  const pluginFiles = await report(provider, "plugin");
  kit.check("Provider reads the requested candidate", pluginFiles === `A\t${candidate}\nD\told`, pluginFiles);
  candidate = "0".repeat(40);
  kit.check("Hook failure is advisory", (await report(provider, "failed hook")) === "unavailable");
  candidate = root;
  kit.hostEnv.FAKE_OLD_VCS = "1";
  await kit.restartHost();
  kit.check("Older plugin still reaches Ready", (await report(provider, "old plugin")) === "unavailable");
});
