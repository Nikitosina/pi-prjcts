// The "Coordinator GitHub CLI (gh)" project setting: full access by default, saved off through settings-update. Its classic inbox
// control was retired on 2026-11-04 (docs/classic-retirement.md); the setting is changed through settings-update or the Host agent.
import { createKit } from "./lib/e2e-kit.mjs";
const kit = await createKit("coordinator-gh-ui");
const { check, rpc } = kit;
kit.initRepo();
await kit.run(async () => {
  const id = await kit.createProject("Mari");
  check("default is full access", (await rpc({ action: "settings-snapshot", id })).values.githubCli === "full");
  await kit.updateSettings(id, { githubCli: "none" });
  check("off persists", (await rpc({ action: "settings-snapshot", id })).values.githubCli === "none");
});
