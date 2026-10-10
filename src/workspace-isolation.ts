import { lstatSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Value } from "typebox/value";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { cli } from "./vcs.ts";
import { plugins } from "./plugins.ts";
import type { IsolationBackend } from "./plugin-types.ts";
import { AuthorizedRepository, WorkspaceIntent, type AuthorizedRepository as Authorization, type WorkspaceIntent as Intent, type WorkspaceLease, type WorkspaceReceipt, type WorkspaceScope, type WorkspaceSnapshot } from "./workspace-types.ts";

/* Before effects: preserve crash-after-effect, dirty/foreign/active work, lease
 * changes, source/provider drift, low disk, and shared-store ambiguity. */
const Receipts = defineDoc<{ receipts: Record<string, WorkspaceReceipt> }>({ kind: "projects.workspace-isolation", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ receipts: {} }) });
export type WorkspaceIsolation = { allocate(intent: Intent): Promise<WorkspaceReceipt>; reconcile(intent: Intent): Promise<WorkspaceReceipt>; release(intent: Intent): Promise<WorkspaceReceipt>; snapshot(): Promise<WorkspaceSnapshot> };
type Command = { code: number; stdout: string; stderr: string };
type Options = { conversation: Conversation; authority: { projectId: string; owner: string }; authorizedRepositories?: readonly Authorization[]; context?: Context; /** Test-only crash seam; production must not supply it. */ afterProviderEffect?: (receipt: WorkspaceReceipt) => Promise<void> | void; /** Test-only absolute missing executable; exercises actual OS probe failure only. */ testMissingProbeExecutable?: string; /** Test-only fixed PID-only lsof framing; exercises malformed-success preservation. */ testProbeWithoutCwdNames?: boolean };  
type Facts = { facts: Record<string, string>; reason: string | null };

/** A receipt-only module: host configuration, not a model, supplies authority. */
export function workspaceIsolation(options: Options): WorkspaceIsolation {
  const context = options.context ?? BACKGROUND_CONTEXT; const allowed = options.authorizedRepositories ?? []; const authority = options.authority; if (options.testMissingProbeExecutable !== undefined) { if (!isAbsolute(options.testMissingProbeExecutable)) throw new Error("Test missing probe executable must be absolute"); if (lstatSync(options.testMissingProbeExecutable, { throwIfNoEntry: false })) throw new Error("Test missing probe executable must not exist"); }
  async function get(id: string) { return options.conversation.commit(async tx => { const x = await tx.doc(Receipts, options.conversation.id); return x.receipts[id] ? dto(x.receipts[id]) : undefined; }, context); }
  async function put(value: WorkspaceReceipt) { const out = dto(value); await options.conversation.commit(async tx => { (await tx.doc(Receipts, options.conversation.id)).receipts[out.intentId] = out; }, context); return out; }
  async function allocate(intent: Intent) {
    authorize(intent, allowed, authority); const old = await get(intent.id); if (old) { if (!sameFrozenIntent(old, intent)) throw new Error("Existing workspace receipt intent/scope differs; refusing adoption"); return old; }
    await put(receipt(intent, "prepared", {}, null, null, null)); // Durable intent precedes unsafe CLI.
    const missing = pluginMissing(intent.scope.provider); if (missing) return put(receipt(intent, "blocked", {}, null, null, missing));
    const pre = await preflight(intent.scope, false); if (pre.reason) return put(receipt(intent, "blocked", pre.facts, null, null, pre.reason));
    const effect = intent.scope.provider === "git" ? await addGit(intent, pre.facts) : await addPlugin(intent, pre.facts);
    if (effect.state === "allocated") await options.afterProviderEffect?.(dto(effect));
    return put(effect);
  }
  async function reconcile(intent: Intent) {
    authorize(intent, allowed, authority); const old = await get(intent.id); if (!old) return receipt(intent, "blocked", {}, null, null, "No prepared Durable intent exists"); if (!sameFrozenIntent(old, intent)) throw new Error("Existing workspace receipt intent/scope differs; refusing reconciliation");
    if (["blocked", "released"].includes(old.state)) return old;
    const missing = pluginMissing(intent.scope.provider); if (missing) return put(receipt(intent, old.state === "prepared" ? "blocked" : "preserved", {}, old.workspacePath, old.lease, missing));
    const pre = await preflight(intent.scope, true); if (pre.reason) return put(receipt(intent, old.state === "prepared" ? "blocked" : "preserved", pre.facts, old.workspacePath, old.lease, pre.reason));
    const actual = intent.scope.provider === "git" ? await gitEntry(intent.scope) : await backendOf(intent.scope.provider)!.entry(intent.scope);
    if (!actual || !exact(intent.scope, actual)) return put(receipt(intent, "uncertain", { ...pre.facts, ...(actual?.facts ?? {}) }, old.workspacePath, actual?.lease ?? old.lease, "Observed provider state is absent, ambiguous, or differs from the frozen intent; refusing recreation"));
    return put(receipt(intent, "allocated", { ...pre.facts, ...actual.facts }, intent.scope.workspacePath, actual.lease, null));
  }
  async function release(intent: Intent) {
    authorize(intent, allowed, authority); const old = await get(intent.id); if (!old || !["allocated", "preserved"].includes(old.state)) return receipt(intent, "blocked", {}, null, null, "Only an allocated or freshly rechecked preserved receipt can be released");
    const current = await reconcile(intent); if (current.state !== "allocated") return current;
    const probe = await active(intent.scope.workspacePath, options.testMissingProbeExecutable, options.testProbeWithoutCwdNames); if (probe) return put(receipt(intent, "preserved", current.providerFacts, current.workspacePath, current.lease, typeof probe === "string" ? `Workspace activity probe failed: ${probe}` : "An active process has this workspace as cwd"));
    const statusCommand = intent.scope.provider === "git" ? { file: cli.git(), args: ["status", "--porcelain=v1", "--untracked-files=all"] } : backendOf(intent.scope.provider)!.statusCommand();
    const status = await command(statusCommand.file, statusCommand.args, intent.scope.workspacePath);
    if (status.code || status.stdout.trim()) return put(receipt(intent, "preserved", current.providerFacts, current.workspacePath, current.lease, "Workspace is dirty or status cannot be verified"));
    if (intent.scope.provider === "git") {
      const lock = await command(cli.git(), ["worktree", "list", "--porcelain"], intent.scope.ownerCheckout); const entry = parseGit(lock.stdout, intent.scope.workspacePath);
      if (!entry || entry.locked !== `workspace-intent:${intent.id}`) return put(receipt(intent, "preserved", current.providerFacts, current.workspacePath, null, "Git lock is absent or not owned by this exact intent"));
      const unlock = await command(cli.git(), ["worktree", "unlock", intent.scope.workspacePath], intent.scope.ownerCheckout); if (unlock.code) return put(receipt(intent, "preserved", current.providerFacts, current.workspacePath, null, "Owned Git worktree could not be unlocked"));
      const remove = await command(cli.git(), ["worktree", "remove", intent.scope.workspacePath], intent.scope.ownerCheckout); if (remove.code) return put(receipt(intent, "preserved", { ...current.providerFacts, remove: short(remove.stderr) }, current.workspacePath, null, "Unforced Git removal failed after unlock; preserving work"));
      return put(receipt(intent, "released", { ...current.providerFacts, remove: "unlocked-unforced" }, null, null, null));
    }
    const out = await backendOf(intent.scope.provider)!.release(intent, current);
    return out.ok ? put(receipt(intent, "released", out.facts, null, null, null)) : put(receipt(intent, "preserved", out.facts ?? current.providerFacts, current.workspacePath, out.lease === undefined ? current.lease : out.lease, out.reason));
  }
  async function snapshot(): Promise<WorkspaceSnapshot> { return options.conversation.commit(async tx => ({ receipts: Object.values((await tx.doc(Receipts, options.conversation.id)).receipts).map(dto) }), context); }
  return { allocate, reconcile, release, snapshot };
}

function sameFrozenIntent(receipt: WorkspaceReceipt, intent: Intent): boolean { return receipt.intentId === intent.id && receipt.attemptId === intent.attemptId && JSON.stringify(receipt.scope) === JSON.stringify(intent.scope); }
function authorize(intent: Intent, allowed: readonly Authorization[], authority: { projectId: string; owner: string }) {
  if (!Value.Check(WorkspaceIntent, intent)) throw new Error("Invalid workspace intent");
  if (intent.scope.projectId !== authority.projectId || intent.scope.owner !== authority.owner) throw new Error("Workspace project or lease owner does not match host authority");
  const match = allowed.find(a => Value.Check(AuthorizedRepository, a) && a.repositoryId === intent.scope.repositoryId && a.provider === intent.scope.provider && a.approvedRoot === intent.scope.approvedRoot && a.ownerCheckout === intent.scope.ownerCheckout);
  if (!match) throw new Error("Workspace repository/scope is not authorized by host configuration");
  for (const file of intent.scope.fileOwnership) if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || !(file === match.fileOwnershipPrefix || file.startsWith(`${match.fileOwnershipPrefix}/`))) throw new Error("File ownership is outside the host-approved prefix");
}
async function preflight(s: WorkspaceScope, exists: boolean): Promise<Facts> {
  try { const owner = dir(s.ownerCheckout), root = dir(s.approvedRoot), target = resolve(realpathSync(dirname(s.workspacePath)), basename(s.workspacePath)); if (!inside(root, target) || owner === target) return { facts: {}, reason: "Workspace path escapes its approved allocation root" }; if (Boolean(lstatSync(target, { throwIfNoEntry: false })) !== exists) return { facts: { ownerCheckout: owner, workspacePath: target }, reason: exists ? "Expected workspace path is absent" : "Workspace target already exists" };
    if (s.provider === "git") { const head = await command(cli.git(), ["rev-parse", "HEAD"], owner), clean = await command(cli.git(), ["status", "--porcelain=v1", "--untracked-files=all"], owner); if (head.code || clean.code || (!exists && clean.stdout.trim() && !s.allowDirtyOwner)) return { facts: {}, reason: "Git owner is unreadable or dirty" }; return { facts: { ownerCheckout: owner, ownerHead: head.stdout.trim(), workspacePath: target }, reason: !exists && head.stdout.trim() !== s.headRevision ? "Git owner head drifted" : null }; }
    return await backendOf(s.provider)!.preflight(s, { owner, target });
  } catch (e) { return { facts: {}, reason: e instanceof Error ? e.message : String(e) }; }
}
async function addGit(i: Intent, facts: Record<string,string>) { const existing = i.scope.continueBranch ? (await command(cli.git(), ["rev-parse", "--verify", "--quiet", `refs/heads/${i.scope.branch}`], i.scope.ownerCheckout)).stdout.trim() : ""; /* A continued branch that exists locally at the intended tip is checked out as is; at any other commit it is never reset (git refuses -b). */ const x = await command(cli.git(), ["worktree", "add", "--lock", "--reason", `workspace-intent:${i.id}`, ...(existing === i.scope.baseRevision ? [i.scope.workspacePath, i.scope.branch] : ["-b", i.scope.branch, i.scope.workspacePath, i.scope.baseRevision])], i.scope.ownerCheckout); if (x.code) return receipt(i,"blocked",{...facts,add:short(x.stderr)},null,null,"Git add failed"); const found=await gitEntry(i.scope); return found&&exact(i.scope,found)?receipt(i,"allocated",{...facts,...found.facts},i.scope.workspacePath,null,null):receipt(i,"uncertain",facts,i.scope.workspacePath,null,"Git effect lacks exact receipt facts"); }
async function addPlugin(i: Intent, facts: Record<string,string>) { const out = await backendOf(i.scope.provider)!.add(i, facts); return receipt(i, out.state, out.facts, out.state === "blocked" ? null : i.scope.workspacePath, out.lease, out.reason); }
const backendOf = (provider: string): IsolationBackend | undefined => plugins.workspaceProvider(provider)?.isolation;
const pluginMissing = (provider: string): string | null => provider === "git" || backendOf(provider) ? null : `The workspace provider plugin "${provider}" is not loaded; its worktrees are kept as they are`;
async function gitEntry(s: WorkspaceScope) { const x=await command(cli.git(),["worktree","list","--porcelain"],s.ownerCheckout); const e=parseGit(x.stdout,s.workspacePath); return e?{facts:{path:e.worktree,head:e.HEAD,branch:e.branch,locked:e.locked??""},lease:null}:null; }
function exact(s:WorkspaceScope, a:{facts:Record<string,string>;lease:WorkspaceLease|null}) { return s.provider === "git" ? a.facts.path===resolve(s.workspacePath)&&a.facts.head===s.baseRevision&&a.facts.branch === `refs/heads/${s.branch}` : backendOf(s.provider)!.exact(s, a); }
function parseGit(text:string,path:string) { return text.trim().split("\n\n").map(b=>Object.fromEntries(b.split("\n").map(l=>{const [k,...v]=l.split(" ");return[k,v.join(" ")]}))).find(x=>x.worktree===resolve(path)); }
async function active(path:string, missingProbeExecutable?:string, pidOnly?:boolean):Promise<boolean|string>{const x=await command(missingProbeExecutable??"/usr/sbin/lsof",["-a","-d","cwd",pidOnly?"-Fp":"-Fn"]); if (x.code === 1 && x.stderr === "" && x.stdout === "") return false; if (x.code !== 0) return `exit ${x.code}: ${short(x.stderr)}`; if (x.stderr !== "") return `stderr: ${short(x.stderr)}`; const lines=x.stdout.split("\n"); if (x.stdout === "") return "empty successful cwd probe"; let pid=false,cwd=false,names=0,matched=false; const target=resolve(path); for(const line of lines){if(line==="")continue; if(/^p\d+$/.test(line)){if(pid&&(!cwd||names!==1))return "malformed or incomplete cwd probe records";pid=true;cwd=false;names=0;continue;} if(line==="fcwd"&&pid&&!cwd){cwd=true;continue;} if(line.startsWith("n")&&pid&&cwd){const name=line.slice(1),unreadable=/^cwd\|rtd info error: /.test(name);/* lsof reports a process whose cwd was deleted this way; it cannot be inside an existing worktree */if((!isAbsolute(name)&&!unreadable)||++names!==1)return "malformed or incomplete cwd probe records";if(!unreadable&&inside(target,resolve(name)))matched=true;continue;} return "malformed or incomplete cwd probe records";} if(!pid||!cwd||names!==1)return "malformed or incomplete cwd probe records"; return matched;}
function receipt(i:Intent,state:WorkspaceReceipt["state"],facts:Record<string,string>,path:string|null,lease:WorkspaceLease|null,reason:string|null):WorkspaceReceipt{return {intentId:i.id,attemptId:i.attemptId,state,scope:dto(i.scope),providerFacts:dto(facts),workspacePath:path,lease:lease?dto(lease):null,reason};} function dto<T>(v:T):T{return JSON.parse(JSON.stringify(v)) as T;} function dir(p:string){if(!isAbsolute(p)||lstatSync(p).isSymbolicLink())throw Error("Path must be absolute and not a symlink");return realpathSync(p);}function inside(a:string,b:string){const x=relative(a,b);return x===""||(!x.startsWith(`..${sep}`)&&x!==".."&&!isAbsolute(x));}function short(x:string){return x.trim().slice(-1000);}export function command(file:string,args:string[],cwd?:string):Promise<Command>{return new Promise(done=>{const c=spawn(file,args,{cwd,shell:false,env:{PATH:"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"},stdio:["ignore","pipe","pipe"]});let o="",e="";c.stdout.on("data",x=>o+=x);c.stderr.on("data",x=>e+=x);c.on("error",x=>done({code:-1,stdout:o,stderr:String(x)}));c.on("close",x=>done({code:x??-1,stdout:o,stderr:e}));});}
/** Every retained allocation receipt (cleanup inventory). */
export async function workspaceReceipts(conversation: Conversation, context: Context = BACKGROUND_CONTEXT): Promise<WorkspaceReceipt[]> { return conversation.commit(async tx => Object.values((await tx.doc(Receipts, conversation.id)).receipts).map(dto), context); }
/** Marks a worktree the host removed after its unforced `git worktree remove`; the branch ref is kept. */
export async function retireWorkspaceReceipt(conversation: Conversation, intentId: string, facts: Record<string, string>, context: Context = BACKGROUND_CONTEXT): Promise<void> {
  await conversation.commit(async tx => { const doc = await tx.doc(Receipts, conversation.id), old = doc.receipts[intentId]; if (!old || old.state !== "allocated") throw new Error("Only an allocated receipt can be retired"); doc.receipts[intentId] = { ...old, state: "released", providerFacts: { ...old.providerFacts, ...facts }, workspacePath: null, lease: null, reason: null }; }, context);
}
