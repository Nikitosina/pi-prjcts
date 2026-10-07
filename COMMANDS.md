# Fixed worker command profiles

Implementation scope approved by the owner: fixed command IDs/argv in owned worktrees, limits and receipts; no coordinator shell or model-supplied arguments. Repository code is trusted input, not OS-sandboxed. Existing projects receive no command permissions by default. Deployment/destructive profiles require a separate exact approval; declaring a profile does not supply that approval.

## Failure cases recorded before implementation

- Wrong project confirmation or stale revision changes no grant.
- Unknown, cross-repository or provider-mismatched scopes are denied.
- Missing/changed executable, nonregular executable or changing bytes are denied.
- Executable-close failure must not hide a primary read/identity failure, and must not turn a successful inspection into permission to launch.
- Executable under a mutable repository/workspace root is denied.
- Model-supplied arguments, cwd, executable or environment are unavailable.
- Disabled/missing profile produces a visible blocker.
- Changed profile invalidates frozen bindings rather than silently retargeting a thread.
- Nonempty NODE_OPTIONS or PI_PACKAGE_DIR is refused, not cleared.
- Expired/changed lease, wrong work/thread/conversation or stopped work denies launch.
- Deployment/destructive launch without matching executable approval is denied.
- Approval for another profile revision, effect, scope, thread, allocation or request UUID is denied; a fresh request UUID cannot reuse the old approval.
- Existing plain approvals remain non-executable; answers cannot grant authority.
- Generic operation execution cannot turn a command approval into a GitHub merge.
- Lost response/crash retains uncertainty; it never permits blind execution replay.
- Timeout/pause/close cancels the owned child and drains it; no historical/raw PIDs.
- Concurrent requests share resource admission; they cannot duplicate a recorded launch.
- Output is bounded untrusted data, not authority. Receipts retain native identities and hashes, not credentials or arbitrary environment dumps.

### Output-artifact failure cases (recorded before implementation)

- Captured bytes must remain distinct from full-stream hashes when output is truncated; invalid UTF-8 must not alter the retained bytes.
- Each new launch claims one artifact ID before spawn; retries reuse the original reference, never regenerate output.
- Artifact/cancellation failures retain the launch and observed result as uncertain; artifact presence supplies no retry permission.
- Native provenance must identify command output, not invent a workspace source file.
- Result snapshots must detach nested SDK document values before returning or rewriting receipts.

### Owner-inspection failure cases (recorded before implementation)

- Wrong project confirmation, unknown key or an active settlement cannot finalize an intent.
- Missing/mismatched artifact, native identity, output observation or artifact hash cannot clear uncertainty.
- Timeout, cancellation, signal termination or unknown descendants stay uncertain; absence never proves termination.
- Only an observed normal exit/spawn failure with matching native-linked artifact can finalize the original receipt; inspection launches nothing and preserves original task/call/approval identity.

### Direct-command minimum-risk failure cases (recorded before implementation)

- Recognized deletion tools, Git history/delete/force flags, and direct GH DELETE operations cannot run as workspace-effect profiles.
- Direct `gh pr merge` cannot bypass the PR/head-bound executor, even with a generic command approval.
- Direct GH REST PR/branch merge endpoints cannot replace the head-bound executor, including percent-encoded fixed arguments.
- Direct GH GraphQL endpoints cannot hide merge/auto-merge mutations in inline arguments or mutable input files. Profiles must use the scoped provider tools instead.
- Direct Git worktree remove/prune cannot bypass retained-resource ownership checks, even with generic command approval.
- Registration and launch both apply these checks; existing unsafe profiles cannot retain launch access after the policy changes.
- These checks are conservative recognition, not semantic classification of arbitrary wrappers or owner-trusted repository code.

## Current status

`command-profile-set` requires project confirmation and the revision from `command-profiles-snapshot`. It pins a regular executable outside mutable repository/workspace roots (maximum 128 MiB), exact decimal physical identity and SHA256; fixed argv, declared effect, exact existing repository scopes, output bound and timeout are stored in the project. Changes require an idle cached owner and close it outside the project lock. Registration opens no additional storage owner. Enabled workspace-effect profiles are attached only to authorized scoped workers. No coordinator command tools exist. Worker parameters contain a request UUID only; fixed argv/cwd/environment cannot be changed by the model. Direct Git/GitHub executables in Arc profiles, and direct Arc/Arcanum executables in GitHub profiles, are rejected. Minimum-risk checks run at registration and launch: recognized deletion tools, Git history/delete/force forms and direct GH DELETE cannot use workspace-effect grants. Direct `gh pr merge`, literal REST PR/branch merge endpoints, and direct GH GraphQL endpoints are unavailable through profiles, so generic command approvals cannot replace PR/head-bound approval. The endpoint check also decodes percent-encoded fixed arguments. Direct GraphQL reads are conservatively blocked along with mutations because opaque/mutable body files cannot be classified here; use scoped provider inspection tools. Recognized inline `mergePullRequest`/`enablePullRequestAutoMerge` forms are blocked too. These new checks are unverified; no profile registration/launch, GH calls or tests ran. Git worktree remove/prune and explicit Git safety-hook overrides are unavailable through profiles. Existing profiles failing these checks show a blocker and cannot launch. This is conservative direct-command recognition, not semantic inspection of trusted wrappers, interpreters or repository code. Deployment/destructive profiles propose a separate `kind: command` operation bound to profile revision, exact scope/thread, allocation receipt/attempt and request UUID. They cannot launch until the recorded owner decision includes `execution: true` and matching project confirmation. A profile grant, plain approval without execution, or a question answer supplies no such permission. Approval is rechecked before intent admission. These operations execute only through their bound worker tool, not the GitHub merge executor.

For an explicitly authorized local Git workflow, fixed profiles can stage/commit/push in their allocated task branch. The separate `localPublication` read-only bridge must verify the local/remote head and assigned changes before PR tools can consume it; see `GITHUB-LOCAL.md`. This path has not been executed or verified.

Arc command execution remains deferred/read-only. Arc profiles may be retained disabled, but cannot be enabled or executed; approvals cannot override this restriction. Direct VCS executable/provider mismatches are rejected. Fixed wrapper/repository code remains owner-trusted, not semantically classified or OS-sandboxed. A follow-up must reuse the original command request UUID; a new UUID proposes a new approval.

Executable inspection now closes its handle before returning a usable program identity. If inspection and close both fail, an `AggregateError` retains both errors; a close-only failure also denies the identity. Bounds/hash/physical-identity checks are unchanged. This cleanup change is unverified; no executable inspections, registrations, launches or tests ran.

## Executor implementation (unverified)

The executor rechecks active work, conversation/scope/provider, project grants, lease expiry, workspace physical identity and executable hash. It shares the physical mutation lock with file-CAS tools and refuses nonempty NODE_OPTIONS/PI_PACKAGE_DIR. Only a small inherited process environment is passed; model environment overrides are unavailable. Exact request UUID/profile/resource retries return completed hashes/status without repeating the process. Owner-facing profile snapshots include fixed argv/program identity so an approval can be inspected against its exact profile revision; worker catalogs do not receive configurable argv. An unresolved resource blocks new commands, scoped file writes and GitHub publication; read-only inspection remains possible.

The native-linked `projects.command-intents` journal records uncertainty before spawn and links any consumed approval ID/fingerprint. A fresh detached child group is signalled only while its captured leader is still live. Signalling stops at leader exit; pipe draining is bounded and lingering descendants retain uncertainty. Concurrent closes share a single drain. Output is capped; timeout, cancellation, output overflow or unproven group termination retain uncertainty. No historical PID is retained for later signalling. Programs must be trusted foreground commands, not daemonize/escape their group. This is not an OS sandbox: repository code, interpreters, system libraries and child programs remain trusted inputs. Owned process-group drain uncertainty makes runtime close fail and retains resources.

Pause cancels active commands; runtime close/startup cleanup drains command execution and result-settlement promises outside admission/control locks. New file/publication callbacks also reject closing runtimes. Automatic schedule/event work holds on `uncertain-command`. `command-intents-snapshot` pages detached selected receipts/observations (native task/call identity, profile revision, outcome and output hashes). The command journal retains output hashes, an observed result and a reserved artifact ID, not raw output/argv/environment. New launches capture bounded actual stdout/stderr bytes in a native-linked JSON library artifact using base64; captured-byte hashes are separate from full-stream hashes. Command-output provenance is tagged as such, not represented as a workspace source file. The artifact contains profile revision and command identity, not argv/environment. Native tool conversations also retain their bounded output result. Completed retries reuse the original artifact reference without re-running or regenerating output. Artifact-write failure retains the observed result and uncertain intent; a reserved ID without an artifact hash is not evidence that capture finished. Artifact presence never authorizes a retry. `command-intent-inspect` requires project confirmation and an exact intent key. It launches nothing. With no active settlement, only recorded normal termination/spawn failure plus a hash-checked artifact carrying the exact native command/task/call identity can finalize the original receipt. Timeout, cancellation, signal termination, missing artifacts and unknown descendants stay uncertain. Finalization reports `effectsVerified: false`: it records execution termination, not deployment correctness or permission for another run. Same-request retries still reuse the original result. Unknown outcomes are not cleared by absence and no retry/cleanup permission is implied.

No commands, E2Es, typechecks or verification were run. This implementation is unverified. Credentials must not be placed in profile argv; no credential/environment values are copied by registration. Metadata registration is not execution acceptance.
