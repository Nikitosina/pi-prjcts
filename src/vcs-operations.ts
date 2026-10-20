import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurablePlanning, type PlanningState } from "./durable-planning.ts";
import { loadProject, parse, type OperationSpec, type Project } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";
import { active, retireWorkspaceReceipt, workspaceReceipts } from "./workspace-isolation.ts";
import { isolationProvider, type WorkspaceReceipt } from "./workspace-types.ts";
import { plugins } from "./plugins.ts";
import { cli, runCli } from "./vcs.ts";
import type { ExecutionInput } from "./github-operations.ts";
import type { OperationApprovals } from "./operation-approvals.ts";
import { VcsExecutions, hasUncertainVcsOperations, type VcsExecution } from "./vcs-operation-state.ts";

export type VcsOperation = Extract<OperationSpec, { kind: "vcs" }>;
export type VcsPreview = Pick<VcsOperation, "scopeId" | "action" | "target">;
const context = BACKGROUND_CONTEXT;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const git = (checkout: string, ...args: string[]) => runCli(cli.git(), ["-C", checkout, ...args]);
const HEX = /^[0-9a-f]{40,64}$/;

/** Named operations only. The shell policy never consumes executable approval. */
export function vcsOperations(input: { root: Conversation; project: Project; approvals: OperationApprovals; mutex: { run<T>(operation: () => Promise<T>): Promise<T> }; isClosed(): boolean }) {
  const { root, approvals } = input;
  const pending = new Set<Promise<unknown>>();
  function current() {
    if (input.isClosed()) throw new Error("Project is closed");
    const project = loadProject(input.project.id);
    if (project.deleted || project.archived) throw new Error("Inactive project cannot execute VCS operations");
    return project;
  }
  async function preview(spec: VcsPreview): Promise<VcsOperation> {
    const project = current(), grant = project.workspaceAuthorization;
    const scope = grant?.scopes.find(item => item.id === spec.scopeId);
    const repository = grant?.repositories.find(item => item.repositoryId === scope?.repositoryId);
    if (!grant || grant.owner !== trustedOwner() || !scope?.wholeRepository || !repository || repository.provider !== grant.provider) throw new Error("VCS operations require an owned whole-repository workspace scope");
    const checkout = directory(repository.ownerCheckout).path;
    const plan = await root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      assertIdle(state);
      return { paused: state.paused, pausing: state.pausing };
    }, context);
    let target = spec.target, facts: object, risks: string[];
    if (spec.action === "branch-delete") {
      if (grant.provider !== "github") throw new Error("Local branch deletion is available only for Git workspaces");
      const protectedBranches = ["main", "master", "trunk", ...project.githubAuthorization?.map(item => item.baseBranch) ?? []];
      if (protectedBranches.includes(target)) throw new Error("Default and protected branches cannot be deleted");
      if ((await git(checkout, "check-ref-format", `refs/heads/${target}`)).code !== 0) throw new Error("Invalid local branch name");
      if ((await git(checkout, "symbolic-ref", "--quiet", `refs/heads/${target}`)).code === 0) throw new Error("Symbolic branch refs cannot be deleted");
      const head = await git(checkout, "rev-parse", "--verify", `refs/heads/${target}^{commit}`);
      if (head.code || !HEX.test(head.stdout.trim())) throw new Error("Local branch was not found");
      const worktrees = await git(checkout, "worktree", "list", "--porcelain");
      if (worktrees.code) throw new Error("Git worktree state is unknown");
      if (worktrees.stdout.split("\n").includes(`branch refs/heads/${target}`)) throw new Error("The branch is checked out in a worktree");
      await retainedGitHistory(checkout, head.stdout.trim());
      const ownerHead = await git(checkout, "rev-parse", "HEAD");
      if (ownerHead.code || !HEX.test(ownerHead.stdout.trim())) throw new Error("Checkout HEAD is unreadable");
      facts = { checkout: directory(checkout), head: head.stdout.trim(), ownerHead: ownerHead.stdout.trim(), worktrees: worktrees.stdout };
      risks = ["Deletes this local branch ref only. No remote branch or commit is deleted."];
    } else {
      target = resolve(target);
      if (!isAbsolute(spec.target) || target !== spec.target) throw new Error("Worktree target must be an exact absolute path");
      const approved = directory(repository.approvedRoot).path;
      if (!inside(approved, target) || target === approved || inside(checkout, target) || inside(target, checkout)) throw new Error("Target is not an isolated authorized worktree");
      const receipts = (await workspaceReceipts(root)).filter(item => item.state === "allocated" && item.workspacePath === target);
      if (receipts.length !== 1) throw new Error("Target has no unique allocated host receipt");
      const receipt = receipts[0], provider = isolationProvider(grant.provider);
      const leaseOwner = provider === "git" ? grant.owner : plugins.workspaceProvider(provider)?.leaseOwner(project);
      if (receipt.scope.projectId !== project.id || receipt.scope.repositoryId !== repository.repositoryId || receipt.scope.provider !== provider || receipt.scope.owner !== leaseOwner || receipt.scope.ownerCheckout !== repository.ownerCheckout || receipt.scope.approvedRoot !== repository.approvedRoot || !sameFiles(receipt.scope.fileOwnership, scope.files)) throw new Error("Worktree receipt no longer matches this project and scope");
      const targetIdentity = directory(target);
      const activity = await active(target);
      if (activity) throw new Error(typeof activity === "string" ? `Worktree activity is unknown: ${activity}` : "An active process is using the worktree");
      let observed: object;
      if (provider === "git") {
        if (spec.action === "worktree-remount") throw new Error("Git worktrees do not support mount recovery");
        const state = await gitWorktree(receipt);
        observed = state;
        risks = ["Removes this clean, idle host worktree without force. Its branch and commits are kept.", "An open PR does not prevent this exact approved cleanup. Local-only work still prevents removal."];
      } else {
        const plugin = plugins.workspaceProvider(provider);
        if (spec.action === "worktree-remount") {
          if (!plugin?.remountSnapshot || !plugin.remountApproved) throw new Error("The workspace provider cannot verify and execute exact approved remount");
          const snapshot = await plugin.remountSnapshot({ project, root, receipt });
          observed = { state: snapshot.state };
          risks = [...snapshot.risks, "Remount approval does not authorize removal. Inspect local changes and commits afterward; removal needs its own approval."];
        } else {
          if (!plugin?.removalSnapshot) throw new Error("The workspace provider cannot verify exact approved removal");
          const snapshot = await plugin.removalSnapshot({ project, root, receipt });
          observed = { state: snapshot.state };
          risks = ["Removes this clean, idle host worktree without force.", ...snapshot.risks];
        }
      }
      facts = { receipt, target: targetIdentity, observed };
    }
    const state = JSON.stringify({ plan, facts });
    if (state.length > 16000) throw new Error("VCS snapshot exceeds the review limit; narrow or resolve the worktree state first");
    return { kind: "vcs", provider: grant.provider, repositoryId: repository.repositoryId, scopeId: scope.id, action: spec.action, checkout, target, expectedState: hash(state), state, risks };
  }
  async function request(spec: VcsPreview & { requestId: string }) {
    const operation = await preview(spec);
    return approvals.request({ action: "operation-request", id: input.project.id, requestId: spec.requestId, operation });
  }
  async function approved(identity: ExecutionInput) {
    const record = await approvals.approved(identity);
    if (record.operation.kind !== "vcs") throw new Error("Not a VCS operation approval");
    return record.operation;
  }
  async function receipt(identity: ExecutionInput): Promise<VcsExecution | null> {
    return root.commit(async tx => {
      const row = (await tx.doc(VcsExecutions, root.id)).items.find(item => item.operationId === identity.operationId);
      if (row && row.fingerprint !== identity.fingerprint) throw new Error("VCS execution identity conflicts");
      return row ? { ...row } : null;
    }, context);
  }
  async function execute(identity: ExecutionInput): Promise<VcsExecution> {
    return input.mutex.run(async () => {
      const operation = await approved(identity);
      const prior = await receipt(identity);
      if (prior && prior.state !== "uncertain") return prior;
      if (prior) throw new Error("VCS operation outcome is uncertain; inspect it, never replay it");
      current();
      const now = await preview(operation);
      if (!sameOperation(now, operation)) throw new Error("VCS target state changed; request a fresh operation approval");
      const binding = authorizationFingerprint(current());
      await root.commit(async tx => {
        assertIdle(await tx.doc(DurablePlanning, root.id));
        if (await hasUncertainVcsOperations(tx, root.id)) throw new Error("Another VCS operation has an uncertain outcome");
        const rows = (await tx.doc(VcsExecutions, root.id)).items;
        if (rows.some(item => item.operationId === identity.operationId)) throw new Error("VCS execution was already recorded");
        rows.push({ operationId: identity.operationId, fingerprint: identity.fingerprint, state: "uncertain" });
      }, context);
      let effectStarted = false;
      try {
        // The retained uncertain receipt also fences new worker admission after a crash.
        await approved(identity);
        if (authorizationFingerprint(current()) !== binding) throw new Error("Workspace authorization changed before execution");
        const final = await preview(operation);
        if (!sameOperation(final, operation)) throw new Error("VCS target state changed before execution; the retained intent requires inspection");
        let result: string;
        if (operation.action === "branch-delete") {
          const state = parse(Type.Object({ facts: Type.Object({ head: Type.String({ pattern: "^[0-9a-f]{40,64}$" }) }) }), JSON.parse(operation.state));
          effectStarted = true;
          const out = await git(operation.checkout, "update-ref", "--no-deref", "-d", `refs/heads/${operation.target}`, state.facts.head);
          if (out.code) throw new Error("Exact-head local branch deletion failed; inspect the retained operation");
          result = `Deleted local branch ${operation.target}. Remote branches and commits were kept.`;
        } else {
          const receipt = (await workspaceReceipts(root)).find(item => item.state === "allocated" && item.workspacePath === operation.target);
          if (!receipt) throw new Error("Approved host receipt changed");
          if (receipt.scope.provider === "git") {
            if (operation.action === "worktree-remount") throw new Error("Git worktrees do not support mount recovery");
            effectStarted = true;
            const unlocked = await git(operation.checkout, "worktree", "unlock", operation.target);
            if (unlocked.code) throw new Error("Owned Git worktree unlock failed; inspect the retained operation");
            const removed = await git(operation.checkout, "worktree", "remove", operation.target);
            if (removed.code) {
              await git(operation.checkout, "worktree", "lock", "--reason", `workspace-intent:${receipt.intentId}`, operation.target);
              throw new Error("Unforced Git worktree removal failed; inspect the retained operation");
            }
          } else {
            const plugin = plugins.workspaceProvider(receipt.scope.provider);
            const apply = operation.action === "worktree-remount" ? plugin?.remountApproved : plugin?.removeApproved;
            if (!apply) throw new Error(`Workspace provider cannot perform exact approved ${operation.action}`);
            const state = parse(Type.Object({ facts: Type.Object({ observed: Type.Object({ state: Type.String() }) }) }), JSON.parse(operation.state));
            const project = current();
            effectStarted = true;
            const out = await apply.call(plugin, { project, root, receipt, state: state.facts.observed.state });
            if (!out.ok) {
              if (!out.started) effectStarted = false;
              throw new Error(`Approved ${operation.action} refused: ${out.error}`);
            }
          }
          if (operation.action === "worktree-remount") {
            result = `Remounted ${operation.target}. Inspect local changes and commits before requesting a separate removal approval. The host allocation and lease were kept.`;
          } else {
            await retireWorkspaceReceipt(root, receipt.intentId, { remove: "cleanup-unforced", cleanedAt: new Date().toISOString(), branch: receipt.scope.branch });
            result = receipt.scope.provider === "git"
              ? `Removed ${operation.target} without force. Its branch and commits were kept.`
              : `Removed ${operation.target} without force after provider retention checks. Storage and local-ref effects are recorded in the approval.`;
          }
        }
        current();
        return root.commit(async tx => {
          const rows = (await tx.doc(VcsExecutions, root.id)).items, index = rows.findIndex(row => row.operationId === identity.operationId && row.fingerprint === identity.fingerprint);
          if (index < 0 || rows[index].state !== "uncertain") throw new Error("VCS execution receipt changed");
          const done: VcsExecution = { operationId: identity.operationId, fingerprint: identity.fingerprint, state: "done", result };
          rows[index] = done;
          return { ...done };
        }, context);
      } catch (error) {
        if (!effectStarted) await root.commit(async tx => {
          const rows = (await tx.doc(VcsExecutions, root.id)).items;
          const index = rows.findIndex(row => row.operationId === identity.operationId && row.fingerprint === identity.fingerprint);
          if (index >= 0 && rows[index].state === "uncertain") rows[index] = { operationId: identity.operationId, fingerprint: identity.fingerprint, state: "failed", result: "No VCS mutation was started. Request a new operation after resolving the preflight failure." };
        }, context);
        throw error;
      }
    });
  }
  async function inspect(identity: ExecutionInput): Promise<VcsExecution> {
    await approved(identity);
    const stored = await receipt(identity);
    if (!stored) throw new Error("VCS execution has no recorded attempt");
    return stored;
  }
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  return { preview, request, execute: (identity: ExecutionInput) => track(execute(identity)), inspect, close: async () => { await Promise.allSettled([...pending]); } };
}

function assertIdle(plan: PlanningState) {
  if (plan.pausing || Object.values(plan.work).some(work => work.status === "queued" || work.status === "running" || work.status === "interrupted") || Object.values(plan.threads).some(thread => thread.activeWorkId !== null || thread.stopping)) throw new Error("VCS operations require all project workers to be settled, including children and transferred threads");
}
function directory(path: string) {
  if (!isAbsolute(path)) throw new Error("VCS paths must be absolute");
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("VCS paths must be real directories without symlink aliases");
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function sameFiles(left: readonly string[], right: readonly string[]) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }
async function retainedGitHistory(checkout: string, head: string) {
  const retained = await git(checkout, "merge-base", "--is-ancestor", head, "HEAD");
  if (retained.code === 0) return;
  const unpublished = await git(checkout, "rev-list", "--count", head, "--not", "--remotes");
  if (unpublished.code || unpublished.stdout.trim() !== "0") throw new Error("Local-only or unknown commits prevent removal");
}
async function gitWorktree(receipt: WorkspaceReceipt) {
  const path = receipt.workspacePath!;
  const [status, head, listed] = await Promise.all([git(path, "status", "--porcelain=v1", "--untracked-files=all"), git(path, "rev-parse", "HEAD"), git(receipt.scope.ownerCheckout, "worktree", "list", "--porcelain")]);
  if (status.code || status.stdout.trim()) throw new Error("Worktree is dirty or status cannot be verified");
  if (head.code || !HEX.test(head.stdout.trim()) || listed.code) throw new Error("Worktree head or ownership is unknown");
  const blocks = listed.stdout.trim().split("\n\n").filter(block => block.split("\n").includes(`worktree ${path}`));
  if (blocks.length !== 1 || !blocks[0].split("\n").includes(`locked workspace-intent:${receipt.intentId}`)) throw new Error("Git worktree lock is not held by this exact host receipt");
  await retainedGitHistory(receipt.scope.ownerCheckout, head.stdout.trim());
  return { head: head.stdout.trim(), status: status.stdout, entry: blocks[0] };
}

function sameOperation(left: VcsOperation, right: VcsOperation) {
  const sorted = (operation: VcsOperation) => JSON.stringify(Object.entries(operation).sort(([left], [right]) => left.localeCompare(right)));
  return sorted(left) === sorted(right);
}
