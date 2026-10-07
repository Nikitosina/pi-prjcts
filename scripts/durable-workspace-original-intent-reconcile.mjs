#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceIsolation } from "../src/workspace-isolation.ts";

const prior=resolve("artifacts/durable-workspace-arc-2026-10-03T07-06-25.450Z-fb408302-3245-4e0c-880a-c6d3972cc95d");
const state=join(prior,"state","bb8c9cb0-ffa0-4abe-9b5a-bc9ec681aed7","durable.sqlite");
const output=resolve("artifacts",`durable-workspace-original-intent-reconcile-${new Date().toISOString().replaceAll(":","-")}`);
const ids=["c1a87ed9-6da6-4ff6-8b20-f9d93f40a6f3","d80cfe33-dd77-453d-8727-d86eaa0526e7"];
const sha=p=>createHash("sha256").update(readFileSync(p)).digest("hex");
const save=value=>{mkdirSync(output,{recursive:true});writeFileSync(join(output,"report.json"),JSON.stringify(value,null,2)+"\n")};
const list=names=>Object.fromEntries(names.map(name=>[name,execFileSync("/usr/local/bin/arc-wt",["list",name,"--porcelain","--verbose"],{encoding:"utf8"})]));
let harness;
try {
  const beforeHash=sha(state), failedReport=join(prior,"report.json"), failedReportHash=sha(failedReport);
  const readOnly=new DatabaseSync(state,{readOnly:true});
  const doc=readOnly.prepare("select id, record from documents where kind = ?").get('"projects.workspace-isolation"');
  assert.ok(doc,"workspace isolation document missing");
  const rootConversationId=JSON.parse(doc.record).scope.conversationId;
  assert.ok(Number.isSafeInteger(rootConversationId),"persisted root conversation ID missing");
  const taskRows=readOnly.prepare("select id, record from tasks").all();
  const activeTasks=taskRows.filter(row=>{try { const r=JSON.parse(row.record); return !["completed","aborted","failed","terminal"].includes(r.state?.status) && !["completed","aborted","failed","terminal"].includes(r.status); } catch { return true; }});
  assert.equal(activeTasks.length,0,"persisted tasks are not terminal; refusing harness open");
  const revisions=readOnly.prepare("select seq, content from document_revisions where document_id = ? order by seq").all(doc.id);
  const receipts=new Map();
  for(const row of revisions){try { const patch=JSON.parse(row.content); if(Array.isArray(patch)) for(const operation of patch) if(operation[0]==="s"&&operation[1]?.[0]==="receipts"&&ids.includes(operation[1][1])) receipts.set(operation[1][1],operation[2]); } catch {} }
  assert.equal(receipts.size,2,"original frozen receipts missing");
  const beforeReceipts=Object.fromEntries([...receipts]);
  const inventoryBefore=list(Object.values(beforeReceipts).map(r=>r.scope.workspaceName));
  const models=await ModelRuntime.create({allowModelNetwork:false});
  harness=await Harness.open(await openNodeSqliteStorage(state),{models,registry:createRegistry()},BACKGROUND_CONTEXT);
  const root=await harness.conversation(rootConversationId,BACKGROUND_CONTEXT);
  assert.ok(root,"persisted root conversation unavailable");
  const first=beforeReceipts[ids[0]];
  const isolation=workspaceIsolation({conversation:root,authority:{projectId:first.scope.projectId,owner:first.scope.owner},authorizedRepositories:[{repositoryId:"arcadia",provider:"arc",approvedRoot:first.scope.approvedRoot,ownerCheckout:first.scope.ownerCheckout,fileOwnershipPrefix:"junk/nikitarat/pi-projects-e2e"}]});
  const after=[];
  for(const id of ids){const frozen=beforeReceipts[id];const intent={id:frozen.intentId,attemptId:frozen.attemptId,action:"allocate",scope:frozen.scope}; const receipt=await isolation.reconcile(intent); assert.equal(receipt.state,"allocated"); assert.equal(receipt.intentId,frozen.intentId);assert.equal(receipt.attemptId,frozen.attemptId);assert.deepEqual(receipt.scope,frozen.scope);after.push(receipt);}
  const inventoryAfter=list(Object.values(beforeReceipts).map(r=>r.scope.workspaceName)); assert.deepEqual(inventoryAfter,inventoryBefore,"provider inventory changed during reconcile");
  await harness.close(BACKGROUND_CONTEXT);harness=undefined;
  save({ok:true,prior,failedReportHash,beforeHash,afterHash:sha(state),rootConversationId,activeTaskCount:activeTasks.length,beforeReceipts,after,inventoryBefore,inventoryAfter,modelDispatches:0});
  console.log(join(output,"report.json"));
} catch(error) { save({ok:false,error:error instanceof Error?error.stack:String(error)}); throw error; }
finally { await harness?.close(BACKGROUND_CONTEXT); }
