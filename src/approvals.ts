import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { errorText, home, saveJson, type Request as RequestData } from "./state.ts";
import { fitJson } from "./response-limit.ts";
import { redactForAgent } from "./agent-redaction.ts";

export type ApprovalRequester = { kind: "host-agent" } | { kind: "coordinator"; projectId: string; chatId: string };
export type ApprovalState = "pending" | "approved" | "denied" | "done" | "failed";
/** One owner decision over one exact host request (docs/ui2-contract.md). */
export type Approval = {
  id: string;
  requestedBy: ApprovalRequester;
  action: string;
  input: RequestData;
  summary: string;
  state: ApprovalState;
  at: string;
  decidedAt?: string;
  note?: string;
  result?: unknown;
};
/** `key` makes a replayed tool call find its approval; `delivered` makes the outcome post once across restarts. */
type Stored = Approval & { key: string; delivered?: boolean };
type Store = { version: 1; approvals: Stored[] };

/** What the host lends the store: the dispatch that runs an approved request and the paths that tell people. */
export type ApprovalDeps = {
  run(request: RequestData): Promise<unknown>;
  /** Posts the outcome to the requester as a follow-up; `requestId` is stable per approval. */
  deliver(approval: Approval, text: string, requestId: string): Promise<void>;
  changed(): void;
  notify(text: string): Promise<void>;
  report(detail: string): void;
};

const KEEP_SETTLED = 200;
const RESULT_CHARS = 4_000;
let deps: ApprovalDeps | undefined;
let store: Store | undefined;
const path = () => join(home(), "approvals.json");
const load = (): Store =>
  (store ??= existsSync(path()) ? (JSON.parse(readFileSync(path(), "utf8")) as Store) : { version: 1, approvals: [] });
const save = () => {
  const current = load();
  const settled = current.approvals.filter((item) => item.state !== "pending" && item.state !== "approved" && item.delivered);
  if (settled.length > KEEP_SETTLED) {
    const drop = new Set(settled.slice(0, settled.length - KEEP_SETTLED));
    current.approvals = current.approvals.filter((item) => !drop.has(item));
  }
  saveJson(path(), current);
};
const visible = ({ key: _, delivered: __, ...approval }: Stored): Approval => approval;
const bounded = (value: unknown) => JSON.parse(fitJson(RESULT_CHARS, () => value ?? null)) as unknown;

function outcomeText(approval: Approval): string {
  const head = `[approval ${approval.id}] The owner`;
  const what = `"${approval.summary}" (${approval.action})`;
  const note = approval.note ? ` Note: ${approval.note}` : "";
  if (approval.state === "denied") return `${head} denied ${what}. It did not run.${note}`;
  const result = JSON.stringify(redactForAgent(approval.action, approval.result ?? null));
  if (approval.state === "done") return `${head} approved ${what}. The host ran it. Result: ${result}${note}`;
  return `${head} approved ${what}, and it failed: ${result}${note}`;
}

async function deliver(item: Stored): Promise<void> {
  if (!deps || item.delivered) return;
  try {
    await deps.deliver(visible(item), outcomeText(item), `approval-${item.id}`);
    item.delivered = true;
    save();
  } catch (error) {
    deps.report(`approval ${item.id} outcome not delivered: ${errorText(error)}`);
  }
}

/**
 * Host-wide owner approvals (`<home>/approvals.json`, 0600). Agents file a dangerous request; only the owner decides it.
 * An approved request runs once: it is marked approved before it runs, and one found approved after a restart is failed, never rerun.
 */
export const approvals = {
  async attach(next: ApprovalDeps): Promise<void> {
    deps = next;
    store = undefined;
    const current = load();
    let changed = false;
    for (const item of current.approvals)
      if (item.state === "approved") {
        item.state = "failed";
        item.result = { error: "The host stopped while this ran; the outcome is unknown and it was not rerun." };
        changed = true;
      }
    if (changed) save();
    for (const item of current.approvals) if (item.state !== "pending" && !item.delivered) await deliver(item);
  },
  detach(): void {
    deps = undefined;
  },
  list(): Approval[] {
    return load().approvals.map(visible).toReversed();
  },
  async request(input: { key: string; requestedBy: ApprovalRequester; request: RequestData; summary: string }): Promise<Approval> {
    if (!deps) throw new Error("Owner approvals are not available on this host");
    const current = load();
    const existing = current.approvals.find((item) => item.key === input.key);
    if (existing) return visible(existing);
    const item: Stored = {
      id: randomUUID(),
      key: input.key,
      requestedBy: input.requestedBy,
      action: input.request.action,
      input: input.request,
      summary: input.summary,
      state: "pending",
      at: new Date().toISOString(),
    };
    current.approvals.push(item);
    save();
    deps.changed();
    const who = input.requestedBy.kind === "host-agent" ? "Host agent" : "Coordinator";
    void deps
      .notify(`Pi Projects host · Approval\n${who} asks: ${input.summary}\nAction: ${item.action}\nApprove or deny in the browser.`)
      .catch(() => {});
    return visible(item);
  },
  async decide(id: string, decision: "approve" | "deny", note?: string): Promise<Approval> {
    if (!deps) throw new Error("Owner approvals are not available on this host");
    const item = load().approvals.find((candidate) => candidate.id === id);
    if (!item) throw new Error("Unknown approval");
    if (item.state !== "pending") throw new Error(`Approval is not pending: it is already ${item.state}`);
    item.decidedAt = new Date().toISOString();
    if (note?.trim()) item.note = note.trim();
    item.state = decision === "approve" ? "approved" : "denied";
    save();
    deps.changed();
    if (item.state === "approved") {
      try {
        item.result = bounded(await deps.run(item.input));
        item.state = "done";
      } catch (error) {
        item.result = { error: errorText(error) };
        item.state = "failed";
      }
      save();
      deps.changed();
    }
    await deliver(item);
    return visible(item);
  },
};
