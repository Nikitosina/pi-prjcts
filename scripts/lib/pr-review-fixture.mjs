import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
export function reviewFixture(root, workspace, core) {
  const bare = join(root, "review.git"),
    builder = join(root, "contributor"),
    gh = join(root, "gh-stub"),
    state = join(root, "review.json");
  const git = (cwd, ...args) =>
    execFileSync("/usr/bin/git", ["-C", cwd, "-c", "user.name=Review", "-c", "user.email=test@example.invalid", ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git(root, "clone", "-q", "--bare", workspace, bare);
  git(root, "clone", "-q", bare, builder);
  const url = "git@github.com:acme/review.git";
  const ssh = join(root, "ssh-stub");
  writeFileSync(ssh, `#!/bin/sh\nexec /usr/bin/git-upload-pack "${bare}"\n`, { mode: 0o755 });
  git(workspace, "remote", "add", "origin", url);
  const base = git(builder, "rev-parse", "HEAD");
  git(builder, "checkout", "-qb", "topic");
  writeFileSync(join(builder, "calendar.js"), "export const days = 7;\n");
  writeFileSync(join(builder, "calendar.md"), "Weekly calendar\n");
  writeFileSync(join(builder, "package-lock.json"), "{}\n");
  git(builder, "add", ".");
  git(builder, "commit", "-qm", "Calendar");
  const first = git(builder, "rev-parse", "HEAD");
  writeFileSync(join(builder, "calendar.js"), "export const days = 5;\n");
  git(builder, "commit", "-qam", "Use workdays");
  const second = git(builder, "rev-parse", "HEAD");
  git(builder, "checkout", "-q", "main");
  writeFileSync(join(builder, "base.txt"), "Main only\n");
  git(builder, "add", ".");
  git(builder, "commit", "-qm", "Advance main");
  const movedBase = git(builder, "rev-parse", "HEAD");
  git(builder, "push", "-q", "origin", "main");
  git(builder, "checkout", "-q", "topic");
  git(builder, "merge", "-qm", "Merge main", "main");
  const moved = git(builder, "rev-parse", "HEAD");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${join(core, "scripts/fake-gh.mjs")}" "$@"\n`, { mode: 0o755 });
  const data = {
    repo: { id: 4242, full_name: "acme/review", default_branch: "main" },
    pulls: [
      {
        number: 7,
        title: "Use workdays in the calendar",
        head: "topic",
        base: "main",
        threads: [{ path: "calendar.js", line: 1, user: "alice", body: "Should holidays count here?" }],
      },
    ],
    checks: {},
  };
  writeFileSync(state, JSON.stringify(data));
  const setup = { bare, url, builder, state, base, first, second, movedBase, moved };
  advanceReview(setup, first);
  return {
    ...setup,
    env: {
      PI_PROJECTS_GH_CLI: gh,
      FAKE_GH_STATE: state,
      FAKE_GH_CALLS: join(root, "calls.jsonl"),
      FAKE_GH_BARE: bare,
      GIT_SSH_COMMAND: `"${ssh}"`,
      GIT_SSH_VARIANT: "ssh",
      GIT_ALLOW_PROTOCOL: "ssh:file",
    },
  };
}
export function advanceReview(f, sha) {
  execFileSync("/usr/bin/git", ["-C", f.builder, "push", "-q", "origin", `+${sha}:refs/pull/7/head`], {
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
  });
  const d = JSON.parse(readFileSync(f.state));
  Object.assign(d.pulls[0], { sha, baseRefOid: sha === f.moved ? f.movedBase : f.base });
  d.checks[sha] = [{ name: "calendar tests", conclusion: "success" }];
  writeFileSync(f.state, JSON.stringify(d));
}
