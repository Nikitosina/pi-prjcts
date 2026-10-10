#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceCapabilities } from "../src/workspace-capabilities.ts";
import { FAKE_MODEL, startFakeModel } from "./fake-model.mjs";
const sha=x=>createHash("sha256").update(x).digest("hex");
const root=resolve("artifacts",`workspace-root-denial-${new Date().toISOString().replaceAll(":","-")}-${randomUUID()}`), control=join(root,"control"), source="src/workspace-capabilities.ts";
mkdirSync(control,{recursive:true});
const fake=await startFakeModel(root); // offline: private SDK home with only the fake model
const good=join(root,"good"), foreign=join(root,"foreign"), missing=join(root,"missing"), link=join(root,"link");
for(const dir of [good,foreign]){mkdirSync(join(dir,"owned"),{recursive:true});writeFileSync(join(dir,"owned","cas.txt"),"BASE\n");} symlinkSync(good,link);
const base={projectId:"root-e2e",repositoryId:"repo",provider:"git",workspaceId:"scope",receiptId:"receipt",attemptId:"attempt",leaseRevision:"lease",workspaceRoot:good,files:["owned/cas.txt"],expiresAt:new Date(Date.now()+120000).toISOString()};
const cases=[
 ["foreign-root",base,{...base,workspaceRoot:foreign}], ["missing-root",base,{...base,workspaceRoot:missing}], ["final-symlink",{...base,workspaceRoot:`${link}/`},base],
 ["receipt",base,{...base,receiptId:"changed"}], ["lease",base,{...base,leaseRevision:"changed"}], ["provider",base,{...base,provider:"other"}], ["files",base,{...base,files:["owned/other.txt"]}]
];
const [provider,...parts]=FAKE_MODEL.split("/"),modelId=parts.join("/");
const report={sourceBefore:sha(readFileSync(source)),cases:[]}; let harness;
const inode=path=>{try{const s=lstatSync(path,{bigint:true});return{dev:String(s.dev),ino:String(s.ino)};}catch{return null;}};
try {
 const models=await ModelRuntime.create({allowModelNetwork:false}); if(!models.getModel(provider,modelId)||!models.getProviderAuthStatus(provider).configured)throw Error("actual configured model unavailable");
 const registry=createRegistry(); harness=await Harness.open(await openNodeSqliteStorage(join(control,"durable.sqlite")),{models,registry,settings:{stream:{timeoutMs:120000},retry:{maxRetries:0}}},BACKGROUND_CONTEXT);
 for(const [name,authority,returned] of cases){
  const worker=await harness.createConversation({ownership:{kind:"conversation"}},BACKGROUND_CONTEXT), effects=[];
  const tools=await workspaceCapabilities({caller:"durable-worker",authority,binding:{role:"durable-worker",conversationId:Number(worker.id)},validateAuthority:async()=>({approved:true,authority:returned}),writeLock:{controlRoot:control,databasePath:join(control,`${name}.sqlite`)},testAfterWrite:async effect=>effects.push(effect)});
  const tool=tools.find(item=>item.name.endsWith("_write")); assert.ok(tool); registry.install(defineExtension({name:`root-denial-${name}`,tools}));
  await worker.configure({model:{provider,modelId},cwd:good,tools,instructions:`Call ${tool.name} exactly once with path owned/cas.txt, text DENIED_${name}, expectedRevision ${sha("BASE\n")}. Do not retry. Reply done.`},BACKGROUND_CONTEXT);
  const cursor=new DatabaseSync(join(control,"durable.sqlite"),{readOnly:true}).prepare("select coalesce(max(id),0) as id from entries").get().id;
  const submission=await worker.submit({type:"input",content:`Call the write tool exactly once now. FAKE-CALL ${tool.name} {"path":"owned/cas.txt","text":"DENIED_${name}","expectedRevision":"${sha("BASE\n")}"} FAKE-SAY done`,requestId:`root-denial-${name}`},BACKGROUND_CONTEXT); await submission.wait(BACKGROUND_CONTEXT);
  const db=new DatabaseSync(join(control,"durable.sqlite"),{readOnly:true}); const entries=db.prepare("select id,record from entries where id>? order by id").all(cursor); const records=JSON.stringify(entries);
  assert.match(records,/toolCall/); assert.match(records,/blocker/); assert.equal(effects.length,0); assert.equal(readFileSync(join(good,"owned","cas.txt"),"utf8"),"BASE\n");
  report.cases.push({name,conversationId:Number(worker.id),cursor,entries,effects,good:inode(good),foreign:inode(foreign),target:sha(readFileSync(join(good,"owned","cas.txt")))});
 }
 report.sourceAfter=sha(readFileSync(source)); assert.equal(report.sourceBefore,report.sourceAfter); writeFileSync(join(root,"report.json"),JSON.stringify(report,null,2)); console.log(join(root,"report.json"));
} catch(error) { writeFileSync(join(root,"report.json"),JSON.stringify({...report,error:error instanceof Error?error.stack:String(error)},null,2)); throw error; }
finally { await harness?.close(BACKGROUND_CONTEXT); fake.close(); }
