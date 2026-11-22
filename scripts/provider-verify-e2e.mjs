import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, call, say, randomUUID } from "./lib/e2e-kit.mjs";

const sha = "c".repeat(40);
const handler = ({ role, user, results }) => {
  if (role === "coordinator" && user === "START" && !results.length)
    return call("agents", {
      action: "spawn",
      role: "worker",
      title: "Proof",
      brief: "VERIFY-FAKE",
      acceptance: ["Check the candidate"],
      requestId: randomUUID(),
    });
  if (role !== "worker" || !user.includes("VERIFY-FAKE")) return say("Done.");
  const steps = [
    call("bash", { command: `echo ${sha} > .fake-revision` }),
    call("job", { action: "candidate", sha }),
    call("projects_verify_run", { command: "touch DENIED" }),
    call("projects_verify_run", { command: "test ! -e DENIED && echo proof-ok" }),
    call("job", { action: "ready", summary: "Checked", proof: ["r1"] }),
  ];
  return steps[results.length] ?? say("Done.");
};
const kit = await createKit("provider-verify", {
  handler,
  env: { PI_PROJECTS_PLUGINS: new URL("./fixtures/fake-vcs-plugin", import.meta.url).pathname },
});
const checkout = join(kit.root, "checkout");
mkdirSync(join(checkout, ".fakevcs"), { recursive: true });
kit.hostEnv.FAKE_PLUGIN_DATA = join(kit.root, "data.json");
writeFileSync(kit.hostEnv.FAKE_PLUGIN_DATA, JSON.stringify({ worktreeRoot: `${checkout}-worktrees`, prs: [], published: [] }));
kit.initRepo();
await kit.run(async () => {
  const id = await kit.createProject("Verification", { cwd: checkout, grant: false });
  const snap = await kit.rpc({ action: "owner-setup-snapshot", id });
  await kit.rpc({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: snap.workspaceRevision });
  await kit.ask(id, "START");
  const results = kit.lastCall("worker", "VERIFY-FAKE")?.results ?? [];
  kit.check(
    "worker policy refused the command before starting a run",
    results.some((text) => text.includes("Denied by fake worker")),
    results,
  );
  kit.check(
    "provider HEAD matched and the guarded command ran",
    results.some((text) => text.includes('"runId":"r1"') && text.includes("proof-ok")),
    results,
  );
  const job = (await kit.jobs(id))[0];
  kit.check(
    "Ready accepted the proof reference on the candidate",
    job?.status === "ready" && job.candidate === sha && job.ready.proof.includes("r1"),
    job,
  );
});
