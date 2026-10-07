import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { defineDoc, type Conversation, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { loadProject, parse } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";
import type { OperationApprovals } from "./operation-approvals.ts";
import type { scheduleRuntime } from "./durable-schedule.ts";
import { DurablePlanning } from "./durable-planning.ts";
import { githubPublishedHead } from "./github-worker.ts";
import { githubCli } from "./github-authorization.ts";

export type ExecutionInput = { id: string; operationId: string; fingerprint: string; confirm: string };
type Identity = { operationId: string; fingerprint: string; repositoryId: string; numericId: number; pullRequest: number; expectedHead: string; marker: string };
type Execution = Identity & ({ state: "uncertain" } | { state: "done"; mergeCommit: string });
const Executions = defineDoc<{ items: Execution[] }>({ kind: "projects.github-operations", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });
export async function hasUncertainGithubOperations(tx: Tx, root: Conversation["id"]): Promise<boolean> {
  return (await tx.doc(Executions, root)).items.some(item => item.state === "uncertain");
}
const Sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const Repo = Type.Object({ id: Type.Integer({ minimum: 1 }), full_name: Type.String() });
const Pr = Type.Object({ number: Type.Integer({ minimum: 1 }), state: Type.String(), merged: Type.Boolean(), merge_commit_sha: Type.Union([Sha, Type.Null()]), head: Type.Object({ sha: Sha, ref: Type.String(), repo: Repo }), base: Type.Object({ ref: Type.String(), repo: Repo }) });
const Commit = Type.Object({ sha: Sha, commit: Type.Object({ message: Type.String() }) });
const MergeResult = Type.Object({ sha: Sha, merged: Type.Boolean() });
const run = promisify(execFile);
const fingerprint = (error: unknown) => createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex");

export function githubOperations(root: Conversation, projectId: string, approvals: OperationApprovals, schedules: ReturnType<typeof scheduleRuntime>, isClosed: () => boolean) {
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  async function get(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const result = await run(githubCli(), ["api", "--hostname", "github.com", "--method", "GET", path], { signal, timeout: 15000, maxBuffer: 1048576, encoding: "utf8" });
    const data: unknown = JSON.parse(result.stdout);
    return data;
  }
  function put(path: string, body: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = execFile(githubCli(), ["api", "--hostname", "github.com", "--method", "PUT", path, "--input", "-"], { signal, timeout: 15000, maxBuffer: 1048576, encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { const data: unknown = JSON.parse(stdout); accept(data); } catch (error) { reject(error); }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(body));
    });
  }
  async function target(input: ExecutionInput) {
    const approval = await approvals.approved(input), project = loadProject(projectId);
    if (approval.operation.kind === "command") throw new Error("Approved commands execute only through their scoped worker tool");
    if (approval.operation.provider !== "github") throw new Error("Arc operation execution remains unavailable");
    if (approval.operation.kind !== "merge") throw new Error("Auto-merge cannot enforce the approved head atomically; execution unavailable");
    const publication = project.githubAuthorization?.find(item => item.repositoryId === approval.operation.repositoryId && item.owner === trustedOwner() && item.workspaceRevision === authorizationFingerprint(project));
    if (!publication) throw new Error("Operation requires the current immutable GitHub publication binding");
    return { approval, publication, operation: approval.operation };
  }
  async function readPr(identity: Identity, signal: AbortSignal) {
    const path = `repos/${identity.repositoryId}`;
    const repository = parse(Repo, await get(path, signal));
    if (repository.id !== identity.numericId || repository.full_name !== identity.repositoryId) throw new Error("GitHub operation repository identity changed");
    const pr = parse(Pr, await get(`${path}/pulls/${identity.pullRequest}`, signal));
    if (pr.number !== identity.pullRequest || pr.head.repo.id !== identity.numericId || pr.base.repo.id !== identity.numericId || pr.head.repo.full_name !== identity.repositoryId || pr.base.repo.full_name !== identity.repositoryId || pr.head.sha !== identity.expectedHead) throw new Error("GitHub operation PR identity or approved head changed");
    return pr;
  }
  async function executeOwned(input: ExecutionInput, signal: AbortSignal) {
    if (isClosed()) throw new Error("Project is closed");
    const { approval, publication, operation } = await target(input);
    const identity: Identity = { operationId: approval.id, fingerprint: approval.fingerprint, repositoryId: publication.repositoryId, numericId: publication.numericId, pullRequest: operation.pullRequest, expectedHead: operation.expectedHead, marker: `pi-projects-approved:${approval.id}:${approval.fingerprint}` };
    const prior = await root.commit(async tx => {
      const items = (await tx.doc(Executions, root.id)).items;
      const item = items.find(row => row.operationId === identity.operationId);
      if (item && item.fingerprint !== identity.fingerprint) throw new Error("Operation execution intent conflicts");
      return item ? { ...item } : null;
    }, BACKGROUND_CONTEXT);
    if (prior?.state === "done") return prior;
    if (prior) throw new Error("Operation outcome is uncertain; inspect before any retry");
    const published = await githubPublishedHead(root, { scopeId: operation.scopeId, numericId: publication.numericId, pullRequest: identity.pullRequest });
    if (published.sha !== identity.expectedHead || !published.branch.startsWith(publication.branchPrefix)) throw new Error("Operation head is not the scope's latest owned publication");
    const pr = await readPr(identity, signal);
    if (pr.state !== "open" || pr.merged || pr.head.ref !== published.branch || pr.base.ref !== publication.baseBranch) throw new Error("Operation requires an open PR on the owned task branch and authorized base");
    let response: Promise<unknown> | undefined;
    await schedules.mutex.run(async () => {
      signal.throwIfAborted();
      if (isClosed()) throw new Error("Project is closed");
      await target(input);
      const current = await githubPublishedHead(root, { scopeId: operation.scopeId, numericId: publication.numericId, pullRequest: identity.pullRequest });
      if (current.sha !== identity.expectedHead || current.branch !== published.branch) throw new Error("Publication changed after operation approval");
      await root.commit(async tx => {
        const planning = await tx.doc(DurablePlanning, root.id), items = (await tx.doc(Executions, root.id)).items;
        if (planning.paused || planning.pausing) throw new Error("Project plan is paused; operation admission is denied");
        if (items.some(row => row.operationId === identity.operationId || (row.numericId === identity.numericId && row.pullRequest === identity.pullRequest && row.state === "uncertain"))) throw new Error("Operation resource has a retained execution intent; inspect before retry");
        if (items.length >= 4096) throw new Error("Operation execution receipt limit reached");
        items.push({ ...identity, state: "uncertain" });
      }, BACKGROUND_CONTEXT);
      response = put(`repos/${identity.repositoryId}/pulls/${identity.pullRequest}/merge`, { sha: identity.expectedHead, merge_method: "squash", commit_title: `Approved project merge ${identity.operationId}`, commit_message: identity.marker }, signal);
      void response.catch(() => {});
    });
    if (!response) throw new Error("Operation transport was not admitted");
    const result = parse(MergeResult, await response);
    if (!result.merged) throw new Error("Merge did not return a completed effect");
    if (isClosed() || signal.aborted) throw new Error("Operation response requires recovery inspection");
    return root.commit(async tx => {
      const items = (await tx.doc(Executions, root.id)).items, index = items.findIndex(row => row.operationId === identity.operationId);
      if (index < 0 || items[index].state !== "uncertain") throw new Error("Operation receipt changed");
      const done: Execution = { ...identity, state: "done", mergeCommit: result.sha };
      items[index] = done;
      return { ...done };
    }, BACKGROUND_CONTEXT);
  }
  async function inspectOwned(input: ExecutionInput, signal: AbortSignal) {
    await target(input);
    const record = await root.commit(async tx => {
      const item = (await tx.doc(Executions, root.id)).items.find(row => row.operationId === input.operationId && row.fingerprint === input.fingerprint);
      if (!item) throw new Error("Operation execution receipt is missing");
      return { ...item };
    }, BACKGROUND_CONTEXT);
    if (record.state === "done") return record;
    const pr = await readPr(record, signal);
    if (!pr.merged || !pr.merge_commit_sha) return { ...record, observedMerged: pr.merged };
    const commit = parse(Commit, await get(`repos/${record.repositoryId}/commits/${pr.merge_commit_sha}`, signal));
    if (commit.sha !== pr.merge_commit_sha || !commit.commit.message.split("\n").includes(record.marker)) return { ...record, observedMerged: true, markerMatched: false };
    await target(input);
    return root.commit(async tx => {
      const items = (await tx.doc(Executions, root.id)).items, index = items.findIndex(row => row.operationId === record.operationId && row.fingerprint === record.fingerprint);
      if (index < 0) throw new Error("Operation receipt changed");
      const done: Execution = { ...record, state: "done", mergeCommit: commit.sha };
      items[index] = done;
      return { ...done };
    }, BACKGROUND_CONTEXT);
  }
  function launch(input: ExecutionInput, inspect: boolean) {
    const controller = new AbortController();
    controllers.add(controller);
    const task = (inspect ? inspectOwned(input, controller.signal) : executeOwned(input, controller.signal)).catch(error => { throw new Error(`GitHub approved operation failed; inspect any retained intent before retry; fingerprint ${fingerprint(error)}`); });
    active.add(task);
    return task.finally(() => { controllers.delete(controller); active.delete(task); });
  }
  function abort() { for (const controller of controllers) controller.abort(); }
  async function close() { abort(); await Promise.allSettled([...active]); }
  return { execute: (input: ExecutionInput) => launch(input, false), inspect: (input: ExecutionInput) => launch(input, true), abort, close };
}
