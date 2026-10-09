import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTool, type Conversation, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { loadProject, type ArcAuthorization, type Project } from "./state.ts";
import { authorizationFingerprint } from "./workspace-authorization.ts";
import { DurablePlanning } from "./durable-planning.ts";
import { arcanum } from "./arcanum.ts";
import { arcTicket } from "./arc-worker-policy.ts";
import { cli, runCli } from "./vcs.ts";

/** Receipts of PRs this project opened in Arcadia (the Arc counterpart of projects.github-writes). `uncertain` is written before `arc pr create`. */
type Receipt = { key: string; branch: string; head: string; marker: string; state: "uncertain" | "done"; scopeId: string; conversationId: number; workId: string; taskId: number; callId: string; publish: boolean; at: string; pullRequest?: number; url?: string; verified?: boolean; ticket?: string | null; ticketLinked?: boolean };
const Writes = defineDoc<{ items: Receipt[] }>({ kind: "projects.arc-writes", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function hasUncertainArcWrites(tx: Tx, root: Conversation["id"]): Promise<boolean> { return (await tx.doc(Writes, root)).items.some(item => item.state === "uncertain"); }
/** PRs this project opened and verified: the only ones it follows, fixes and merges. */
export async function arcPublishedPullRequests(root: Conversation): Promise<Array<{ number: number; branch: string; head: string; conversationId: number; scopeId: string }>> {
  return root.commit(async tx => (await tx.doc(Writes, root.id)).items.flatMap(row => row.state === "done" && row.verified && row.pullRequest ? [{ number: row.pullRequest, branch: row.branch, head: row.head, conversationId: row.conversationId, scopeId: row.scopeId }] : []), BACKGROUND_CONTEXT);
}
export async function arcWriteSnapshot(root: Conversation, options: { offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Arc receipt page");
  return root.commit(async tx => { const rows = (await tx.doc(Writes, root.id)).items; const items = rows.slice(offset, offset + limit).map(row => ({ ...row })); return { items, total: rows.length, nextOffset: offset + items.length < rows.length ? offset + items.length : null }; }, BACKGROUND_CONTEXT);
}

type Pr = { id: number; summary?: string; description?: string; status?: string; author?: { name?: string; uid?: string } | null; vcs?: { from_branch?: string } | null; tickets?: string[]; merge_allowed?: boolean; auto_merge?: string; merge_commit?: string };
type ListRow = { id: number; description?: string; vcs?: { from_branch?: string } | null };
type Active = { id: number; published?: boolean; commit_ids?: { head?: string; base?: string } | null };

export async function arcWorkerTools(input: { project: Project; root: Conversation; workDir: string; branch: string; controlRoot: string; workspaceId: string; conversationId: number; scopeId: string; workId: string; authorization: ArcAuthorization; isClosed?: () => boolean }): Promise<ToolRegistration[]> {
  const auth = Object.freeze({ ...input.authorization }), root = input.root, key = hash(input.workspaceId).slice(0, 16);
  const remoteBranch = `users/${auth.login}/${input.branch}`, ticket = arcTicket(input.branch) ?? null, resource = `pr:${input.branch}`;
  async function check(api: ToolExecutionApi, context: Context) {
    context.abortSignal?.throwIfAborted();
    if (input.isClosed?.()) throw new Error("Project runtime is closing");
    const current = loadProject(input.project.id);
    if (Number(api.conversationId) !== input.conversationId || current.archived || current.deleted || JSON.stringify(current.arcAuthorization) !== JSON.stringify(auth) || auth.workspaceRevision !== authorizationFingerprint(current)) throw new Error("Arcadia publication authority changed; reopen the project");
    await api.commit(async tx => { const plan = await tx.doc(DurablePlanning, root.id), work = plan.work[input.workId]; if (plan.paused || plan.pausing || !work || work.status !== "running" || work.workspaceScopeId !== input.scopeId || plan.threads[work.threadId]?.activeWorkId !== work.id || Number(work.conversationId) !== input.conversationId) throw new Error("Arcadia publication requires the active scoped worker"); }, context);
  }
  /** The worktree must be on the worker's own branch with everything committed. */
  async function localHead(): Promise<string> {
    const info = await runCli(cli.arc(), ["info", "--json"], input.workDir);
    let facts: { branch?: string; hash?: string } = {};
    try { facts = JSON.parse(info.stdout); } catch { /* reported below */ }
    if (info.code || facts.branch !== input.branch || !facts.hash) throw new Error(`The worktree is not on ${input.branch}; check out your branch first`);
    const status = await runCli(cli.arc(), ["status", "--short"], input.workDir);
    if (status.code || status.stdout.trim()) throw new Error("The worktree has uncommitted changes; commit them first");
    return facts.hash;
  }
  async function verify(number: number, head: string, publish: boolean, marker: string): Promise<Pr> {
    const pr = await arcanum<Pr>(["pr", "get", "--id", String(number)]);
    const active = await arcanum<Active>(["pr", "active-diff", "--id", String(number), "--fields", "+commit_ids(head)"]);
    const author = pr.author?.name === auth.login || pr.author?.uid === auth.login;
    if (!author || pr.vcs?.from_branch !== remoteBranch || active.commit_ids?.head !== head || !pr.description?.includes(marker) || (!publish && active.published === true)) throw new Error(`Arcanum PR ${number} does not match this worker's branch and head (author ${pr.author?.name}, branch ${pr.vcs?.from_branch}, head ${active.commit_ids?.head}); not recorded as verified`);
    return pr;
  }
  async function observe(marker: string): Promise<number | null> {
    const rows = await arcanum<{ pull_requests: ListRow[] }>(["pr", "list", "--from-branch", remoteBranch, "--fields", "+description"]);
    return rows.pull_requests.find(row => row.description?.includes(marker))?.id ?? null;
  }
  const openDraftPr = defineTool({
    name: `projects_arc_${key}_open_draft_pr`,
    description: `After you commit your worker branch ${input.branch} with arc, push it to Arcadia and open its PR (a draft against trunk unless publish is true; set publish only when your task explicitly asks to publish or send to review). The host verifies the PR (author, branch users/${auth.login}/${input.branch}, head equals your HEAD) and links ticket${ticket ? ` ${ticket}` : "s named by the branch"}. Calling it again after you pushed new commits updates the existing PR. title: one line, at most 200 characters. body: the description.`,
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ maxLength: 8000 }), publish: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    replay: "unsafe",
    async execute(args, api: ToolExecutionApi, context) {
      if (/[\r\n]/.test(args.title)) throw new Error("The title must be a single line");
      await check(api, context);
      const head = await localHead(), publish = args.publish === true;
      const prior = await api.commit(async tx => (await tx.doc(Writes, root.id)).items.filter(row => row.branch === input.branch && row.scopeId === input.scopeId).map(row => ({ ...row })).at(-1) ?? null, context);
      if (prior?.state === "uncertain") {
        const found = await observe(prior.marker);
        if (found === null) throw new Error("A previous Arc PR creation is uncertain and no PR with its marker exists; inspect Arcadia before retrying");
        await verify(found, prior.head, prior.publish, prior.marker);
        await api.commit(async tx => { const row = (await tx.doc(Writes, root.id)).items.find(item => item.key === prior.key); if (row) Object.assign(row, { state: "done", pullRequest: found, verified: true }); }, context);
        return result({ pullRequest: found, recovered: true });
      }
      if (prior?.state === "done" && prior.pullRequest) return result(await update(prior, head, api, context));
      const marker = `pi-projects-effect:${hash(JSON.stringify({ project: input.project.id, resource, head, title: args.title, body: args.body })).slice(0, 32)}`;
      const record: Receipt = { key: marker.slice("pi-projects-effect:".length), branch: input.branch, head, marker, state: "uncertain", scopeId: input.scopeId, conversationId: input.conversationId, workId: input.workId, taskId: Number(api.taskId), callId: api.callId, publish, at: new Date().toISOString(), ticket };
      await api.commit(async tx => { const ledger = await tx.doc(Writes, root.id); if (ledger.items.length >= 4096) throw new Error("Arc receipt limit reached"); if (ledger.items.some(row => row.key === record.key)) return; ledger.items.push(record); }, context);
      await check(api, context);
      // Real line breaks via -F; the first line is the title. `arc pr create` pushes the branch itself.
      const dir = join(input.controlRoot, "arc-pr"); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${record.key}.md`); writeFileSync(file, `${args.title}\n\n${args.body}\n\n<!-- ${marker} -->\n`, { mode: 0o600 });
      const created = await runCli(cli.arc(), ["pr", "create", publish ? "--publish" : "--publish=disabled", "--no-commits", "-F", file, "--json"], input.workDir);
      let number = idFrom(created.stdout);
      if (created.code && number === null) throw new Error(`arc pr create failed (${created.stderr.trim().slice(-300) || `exit ${created.code}`}); the receipt stays uncertain until inspected`);
      number ??= await observe(marker).catch(() => null);
      if (number === null) throw new Error("arc pr create finished but its PR was not found; the receipt stays uncertain until inspected");
      let verified = true, problem = "";
      try { await verify(number, head, publish, marker); } catch (error) { verified = false; problem = (error as Error).message; }
      let ticketLinked = false;
      if (ticket && verified) ticketLinked = await arcanum(["pr", "link-tickets", "--id", String(number), "--ticket", ticket]).then(() => true, () => false);
      await api.commit(async tx => { const row = (await tx.doc(Writes, root.id)).items.find(item => item.key === record.key); if (!row) throw new Error("Arc receipt vanished"); Object.assign(row, { state: "done", pullRequest: number, url: `arcanum:${number}`, verified, ticketLinked }); }, context);
      if (!verified) throw new Error(problem);
      return result({ pullRequest: number, draft: !publish, branch: remoteBranch, head, ticket, ticketLinked });
    },
  });
  /** New commits are pushed by the worker; the host re-verifies the PR at the new head. */
  async function update(prior: Receipt, head: string, api: ToolExecutionApi, context: Context) {
    if (head !== prior.head) {
      const pushed = await runCli(cli.arc(), ["push"], input.workDir);
      if (pushed.code) throw new Error(`arc push failed: ${pushed.stderr.trim().slice(-300)}`);
    }
    const pr = await verify(prior.pullRequest!, head, prior.publish, prior.marker);
    await api.commit(async tx => { const row = (await tx.doc(Writes, root.id)).items.find(item => item.key === prior.key); if (row) { row.head = head; row.verified = true; /* the thread now maintaining the PR receives its follow-ups */ row.conversationId = input.conversationId; row.workId = input.workId; } }, context);
    return { pullRequest: prior.pullRequest, updated: head !== prior.head, head, status: pr.status };
  }
  const prStatus = defineTool({
    name: `projects_arc_${key}_pr_status`,
    description: `Read the PR this worker opened for ${input.branch}: status, merge readiness, checks of the active diff-set and comment count. Read-only.`,
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "safe",
    async execute(_args, api: ToolExecutionApi, context) {
      await check(api, context);
      const row = await api.commit(async tx => (await tx.doc(Writes, root.id)).items.filter(item => item.branch === input.branch && item.state === "done" && item.pullRequest).map(item => ({ ...item })).at(-1) ?? null, context);
      if (!row?.pullRequest) throw new Error("No PR was opened for this branch yet");
      const pr = await arcanum<Pr>(["pr", "get", "--id", String(row.pullRequest), "--fields", "+merge_allowed,auto_merge,merge_commit"]);
      const active = await arcanum<Active>(["pr", "active-diff", "--id", String(row.pullRequest)]);
      const checks = await arcanum<{ checks: Array<{ key?: { system?: string; type?: string } | null; status?: string; required?: boolean; satisfied?: boolean }> }>(["checks", "--diff-id", String(active.id)]);
      const comments = await arcanum<unknown[]>(["comment", "list", "--id", String(row.pullRequest)]);
      return result({ pullRequest: row.pullRequest, status: pr.status, mergeAllowed: pr.merge_allowed ?? false, autoMerge: pr.auto_merge, checks: checks.checks.slice(0, 50).map(item => ({ system: item.key?.system, type: item.key?.type, status: item.status, required: item.required, satisfied: item.satisfied })), comments: comments.length });
    },
  });
  return [openDraftPr, prStatus];
}
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
function idFrom(stdout: string): number | null {
  for (const line of stdout.split("\n").reverse()) {
    try { const value = JSON.parse(line) as Record<string, unknown>; const id = value.id ?? value.pr_id ?? value.pull_request_id ?? value.number; if (typeof id === "number") return id; } catch { /* not JSON */ }
  }
  const match = /(?:review|pull[-_ ]?request|PR)\D{0,12}(\d{3,})/i.exec(stdout);
  return match ? Number(match[1]) : null;
}
