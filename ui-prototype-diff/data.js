// PROTOTYPE sample data around the real PR #66 diff (data-diff.js). Threads, chat and the review map are invented for the prototype.

export const PROVIDERS = {
  github: {
    id: "github",
    name: "GitHub",
    ref: "#66",
    repo: "Nikitosina/pi-prjcts",
    base: "main",
    head: "pi/durable-c5c5106a-c7e",
    author: "Nikitosina",
    iter: (n) => `push ${n}`,
    iterShort: (n) => `v${n}`,
    iterNoun: "push",
    checks: [
      { name: "check", state: "ok", note: "tsc --noEmit · 41s" },
      { name: "format", state: "ok", note: "prettier --check · 12s" },
      { name: "verify", state: "ok", note: "14 e2e scripts · 6m 12s" },
    ],
    draftDest: "GitHub review",
    publish: "Publish review",
    publishVerbs: [
      ["comment", "Comment", "Post the drafts without a verdict."],
      ["changes", "Request changes", "Blocks merge until the author pushes again."],
      ["approve", "Approve", "Counts as an approving review."],
    ],
    resolve: "Resolve",
    viewed: "Viewed state syncs with GitHub",
    open: "Open on GitHub",
    issue: null,
    commentNoun: "review comment",
  },
  arc: {
    id: "arc",
    name: "Arcanum",
    ref: "PR 7731542",
    repo: "arcadia",
    base: "trunk",
    head: "users/nikitarat/pi-restart",
    author: "nikitarat",
    iter: (n) => `diff-set ${n}`,
    iterShort: (n) => `ds${n}`,
    iterNoun: "diff-set",
    checks: [
      { name: "Autocheck · build", state: "ok", note: "linux-release · 4m" },
      { name: "Autocheck · small tests", state: "ok", note: "1 812 passed" },
      { name: "Large tests", state: "ok", note: "plugin-catalog · 11m" },
    ],
    draftDest: "Arcanum draft",
    publish: "Publish drafts",
    publishVerbs: [["publish", "Publish drafts", "Publishes every draft on this PR at once (comment publish-drafts)."]],
    resolve: "Resolve issue",
    viewed: "Viewed state is kept by pi-prjcts: arcanum has no API for it",
    open: "Open in Arcanum",
    issue: "Issue (blocks merge)",
    commentNoun: "inline comment",
  },
};

export const WORKER = { id: "c5c5106a", title: "Restart from the plugin catalog", model: "gpt-5.5", status: "Ready" };

export const THREADS = [
  {
    id: "t1",
    path: "src/host-restart.ts",
    find: "function refuse(){",
    kind: "ai",
    axis: "Bugs",
    severity: "P1",
    resolved: false,
    issue: true,
    comments: [
      {
        who: "pr-review",
        role: "AI review · Bugs",
        when: "Nov 20, 09:02",
        body: "`refuse()` exits with code 0. The launcher reads a clean exit as a normal shutdown and does not start the host again, so a refused restart leaves no host running.\n\nExit non-zero, or fall back to a normal start on the current revision.",
      },
    ],
  },
  {
    id: "t2",
    path: "src/host-restart.ts",
    find: 'if (git("status", "--porcelain"',
    kind: "human",
    resolved: true,
    comments: [
      {
        who: "Nikitosina",
        role: "owner",
        when: "Nov 20, 08:41",
        body: "`git status` on every restart click: is that slow on a big checkout?",
      },
      {
        who: "worker c5c5106a",
        role: "worker",
        when: "Nov 20, 08:47",
        body: "About 30 ms on this checkout. It runs once on confirm and once before exec, never in a loop.",
      },
    ],
  },
  {
    id: "t3",
    path: "web/plugins.js",
    find: "if (error.refused || error.status === 403",
    kind: "ai",
    axis: "Bugs",
    severity: "P2",
    resolved: false,
    comments: [
      {
        who: "pr-review",
        role: "AI review · Bugs",
        when: "Nov 20, 09:02",
        body: "Any other failure is swallowed, including a 500 from `plugin-restart`. The page then waits 45 s for a replacement that never comes. Only a dropped connection should count as “restart in progress”.",
      },
    ],
  },
  {
    id: "t4",
    path: "web/plugins.js",
    find: "const deadline = Date.now() + 45000;",
    kind: "ai",
    axis: "Standards",
    severity: "nit",
    resolved: false,
    comments: [
      {
        who: "pr-review",
        role: "AI review · Standards",
        when: "Nov 20, 09:02",
        body: "Name the timings: `45000`, `1000` and `3000` read as magic numbers next to each other.",
      },
    ],
  },
];

export const DRAFTS = [
  {
    id: "d1",
    path: "web/plugins.js",
    find: 'throw new Error("Could not verify the restart.',
    dest: "worker",
    body: "Tell the owner what to check, not only where: “Open Settings → Plugins; the status shows which version runs.”",
  },
];

export const ANNOTATIONS = [
  {
    path: "scripts/plugin-catalog-e2e.mjs",
    find: "27 the second confirmation owns focus",
    level: "notice",
    source: "verify",
    text: "Check 27 failed on push 3 and passed on push 4 (CI annotation).",
  },
];

export const REVIEW_MAP = [
  {
    id: "intent",
    title: "What and why",
    risk: null,
    files: [],
    why: "A configured plugin loads only at the next host start. Before this PR the catalog sent the owner to Deploy. Now the catalog restarts the same host version in place, after a confirmation, and reads the loader status again.",
    checks: [
      "No Deploy, code update or agent restart authority is added",
      "Cancel does nothing",
      "Unsupported launches and unverifiable revisions refuse",
    ],
  },
  {
    id: "exec",
    title: "Restart in place",
    risk: "high",
    files: ["src/host-restart.ts", "src/host.ts"],
    why: "The host replaces its own process with `process.execve` and passes its instance id to the replacement. It refuses when Node runs with extra flags, `NODE_OPTIONS`, or a checkout that is dirty or moved since start.",
    checks: [
      "Every refusal path leaves a host running",
      "The instance id reaches the replacement",
      "The environment keeps PI_PROJECTS_HOME",
    ],
    notes: [{ find: "function refuse(){", text: "Exit code 0 here: see the open P1." }],
  },
  {
    id: "pin",
    title: "Pin the code it runs",
    risk: "high",
    files: ["src/host-checkout.ts", "src/host-assets.ts", "src/web.ts"],
    why: "Exec by path alone could start code that changed after the last check. A loader hook hashes every file under src/ and plugins/ against the git blobs of the running revision, and the web assets are served from the same blobs.",
    checks: ["The hash matches git's blob format", "web/ assets cannot drift from src/"],
  },
  {
    id: "rpc",
    title: "RPC and lifecycle",
    risk: "medium",
    files: ["src/host-server.ts", "src/plugins.ts", "src/state.ts", "src/host-agent-tools.ts"],
    why: "A new `plugin-restart` method drains work, answers, then execs. The catalog answer gains `instance`, `previous` and `sha` so the page can tell the replacement from the old host.",
    checks: ["Work drains before the exec", "The method is classified dangerous for agents"],
  },
  {
    id: "ui",
    title: "Catalog UI",
    risk: "low",
    files: ["web/plugins.js", "web/settings.js", "web/styles.css", "web/api.js"],
    why: "“Restart to enable” opens an inline confirmation with Cancel focused. After confirm the row shows progress and waits up to 45 s for a host with a new instance id and the same revision.",
    checks: ["Focus returns to the button after Cancel", "A different host or version is reported, not retried"],
  },
  {
    id: "tests",
    title: "Tests and docs",
    risk: "low",
    files: [
      "scripts/plugin-catalog-e2e.mjs",
      "scripts/plugin-catalog-unit.mjs",
      "scripts/plugin-catalog-failures.md",
      "docs/plugins/development.md",
    ],
    why: "The browser journey restarts a private host for real, with delayed plugin loading, and checks two pending confirmations and the mobile layout.",
    checks: ["The failures file lists each new refusal", "The e2e restart is real, not mocked"],
  },
];

export const API_MAP = [
  {
    feature: "Header: state, checks, review decision",
    github:
      "GraphQL `pullRequest { state isDraft mergeable reviewDecision headRefOid statusCheckRollup }`. Already read by src/github-prs.ts.",
    arc: "`arcanum pr get --fields …`, `pr active-diff`, `checks --diff-id <id>`. Already read by the Arc plugin (prs.ts).",
    host: "PrProvider.detail grows from counts to a PrReview shape.",
  },
  {
    feature: "File list, +/− and status",
    github: "REST `GET /pulls/{n}/files` (100 per page, at most 3000 files) or GraphQL `files { path additions deletions changeType }`.",
    arc: "`arcanum pr changelist --diff-id <id>`: paths and `entry_id` (needed for inline comments). Heavy and rate-limited: run one at a time, cache.",
    host: "Same list from the local diff when the PR is ours.",
  },
  {
    feature: "Diff text",
    github:
      "`patch` in /files is cut for large files and missing for binaries. Better: `git fetch origin pull/N/head` and `git diff base...head` in a host clone.",
    arc: "arcanum never returns content. `arc diff <base> <merge> -- $(arc root)/<path>` in a mounted checkout (path from the cwd!).",
    host: "One seam for both: VcsProvider.diff already returns CodeDiffParts for worker worktrees.",
  },
  {
    feature: "Expand context, full file",
    github: "`git show <head>:<path>` locally, or REST contents API at the head SHA.",
    arc: "`arc show <merge>:<path>` (path from the repo root, verbatim).",
    host: "Served lazily per hunk gap.",
  },
  {
    feature: "Iterations, “since you last looked”",
    github:
      "No iterations. Reviews carry `commit.oid`; timeline has `PULL_REQUEST_COMMIT` and `HEAD_REF_FORCE_PUSHED_EVENT`. Interdiff is local. A merge from main pollutes `git diff old new`, so diff the two PR diffs instead.",
    arc: "Native: `pr diffs --id` lists diff-sets; an xid `<a>-<b>` gives the inter-diff for changelist and comments.",
    host: "Store the last viewed head per owner and PR. Heads and diff-sets are immutable: cache by them.",
  },
  {
    feature: "Read threads",
    github: "GraphQL `reviewThreads { isResolved isOutdated path line startLine diffSide comments }`.",
    arc: "`comment list-diff --diff-id <id>` (inline), `comment list --open-issues` (blocking).",
    host: "Anchors map to the current diff; a thread whose line is gone shows as outdated.",
  },
  {
    feature: "Write comments",
    github:
      "Pending review: `addPullRequestReview`, `addPullRequestReviewThread(path, line, side, startLine)`, then `submitPullRequestReview(COMMENT | REQUEST_CHANGES | APPROVE)`. Or one REST `POST /pulls/{n}/reviews` with `comments[]`.",
    arc: "`comment post-diff --diff-id --entry-id --line --side --size --is-draft [--is-issue]`, then `comment publish-drafts --id`.",
    host: "Outward-facing: publish only from an explicit owner action with a confirmation.",
  },
  {
    feature: "Suggested change",
    github: "A ```suggestion block in the comment body; GitHub applies it as a commit.",
    arc: "`suggestion add --diff-id --commit-id`: needs a ready commit.",
    host: "Simpler for us: the suggestion goes into the worker brief and the worker commits it.",
  },
  {
    feature: "Resolve",
    github: "GraphQL `resolveReviewThread(threadId)` / `unresolveReviewThread`.",
    arc: "`comment resolve` or `edit-diff --issue-status resolved`.",
    host: "",
  },
  {
    feature: "Viewed files",
    github: "GraphQL `viewerViewedState` on changed files; `markFileAsViewed` / `unmarkFileAsViewed`.",
    arc: "Not in arcanum-go.",
    host: "Store in pi-prjcts per file and head; reset when the file changes in a later iteration.",
  },
  {
    feature: "CI findings on lines",
    github: "`GET /check-runs/{id}/annotations`: path, start_line, level, message.",
    arc: "Checks give status only; line data needs CI or Sandbox logs. No inline anchors.",
    host: "",
  },
  {
    feature: "Send to worker",
    github: "No provider call.",
    arc: "No provider call.",
    host: "Drafts become the brief of a fresh worker on the PR branch, with path:line@head anchors. Matches “after Ready, a fresh worker”.",
  },
  {
    feature: "Guided walkthrough map",
    github: "",
    arc: "",
    host: "A new optional `reviewMap` in the Ready report (steps → files and hunk ranges, why, risk). The host checks ranges against the diff.",
  },
  {
    feature: "Rate limits",
    github:
      "GraphQL 5000 points/h, REST 5000/h, secondary limits on mutations. The PR monitor already polls; the viewer must reuse its cache.",
    arc: "`pr changelist` and `comment list --with-context` are heavy: sequential only, exit 75 means back off.",
    host: "Fetch on open, not on poll; cache per head or diff-set.",
  },
];

export const CHAT = [
  {
    kind: "owner",
    time: "08:12",
    text: "Let me restart the host from the plugin catalog when a plugin is configured. No Deploy, same version.",
  },
  { kind: "tool", name: "agents", args: "spawn worker “Restart from the plugin catalog”", dur: "0.4s", worker: true },
  {
    kind: "agent",
    time: "08:12",
    html: "Started the Job. It touches host lifecycle, so I asked for a real restart in the browser journey.",
  },
  { kind: "report", status: "ready", title: "Restart the current host version from the plugin catalog", note: "17 files · verify green" },
];
