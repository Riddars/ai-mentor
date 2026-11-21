import assert from "node:assert/strict";
import { parseOverviewDraft } from "@/lib/curator/overview-draft";
const correct = JSON.stringify({summary:"tested", findings:[], notes:"one\ntwo"});
const malformed = correct.replace(',"notes"', '"notes"');
const multiline = correct.replace("\\n", "\n");
assert.equal((await parseOverviewDraft(multiline,0)).parsed?.notes,"one\ntwo");
const nestedFence = "```json\n" + JSON.stringify({summary:"checked",findings:[],notes:"The source contains ```json fences."}) + "\n```";
assert.equal((await parseOverviewDraft(nestedFence,0)).parsed?.notes,"The source contains ```json fences.");
let calls = 0;
const recovered = await parseOverviewDraft(malformed,100000,async () => ({
  provider:"test",model:"test",content: ++calls === 1 ? correct.replace("tested","invented") : correct,
  usage:{input:40,output:20}
}));
assert.equal(calls,2);
assert.equal(recovered.parsed?.summary,"tested");
assert.equal(recovered.spend.input,80);
const invalid = await parseOverviewDraft(malformed,100000,async () => ({
  provider:"test",model:"test",content:correct.replace("tested","changed"),usage:{input:1,output:1}
}));
assert.equal(invalid.parsed,null);
assert.equal(invalid.spend.input,2);
assert.equal((await parseOverviewDraft(malformed,10)).parsed,null);
console.log("ok overview draft recovery, exact content preservation and budget guard");
import { runAgentWithFallback } from "@/lib/agent/run";
import type { AgentReply } from "@/lib/agent/protocol";
process.env.LLM_FALLBACK_PROVIDER = "provod";
process.env.LLM_FALLBACK_MODEL = "test-model";
process.env.PROVOD_API_KEY = "fixture";
const response: AgentReply = { type:"result",text:"",error:null,tokensIn:100,tokensOut:20,steps:1,toolCalls:0,
  viewed:[],skipped:[],partialCopy:null,transcript:"" };
let tries = 0;
const run = await runAgentWithFallback({type:"run",root:"dummy",tarPath:"dummy",userPrompt:"review",changed:[],
  systemPrompt:"test",model:{baseUrl:"test",model:"primary"},limits:{maxToolCalls:5,maxTokens:50000,timeoutMs:60000}},
  {provider:"selectel",apiKey:"fixture"}, undefined, undefined, async request => {
    tries++;
    if (tries === 1) return {...response,error:"HTTP 503"};
    assert.equal(request.model.model,"test-model");
    assert.equal(request.limits.maxTokens,49880);
    return {...response,text:"finished"};
  });
assert.equal(run.run.provider,"provod");
assert.equal(run.run.reply.tokensIn,200);
assert.equal(tries,2);
console.log("ok router fallback preserves remaining budget and records the actual provider");
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb } from "@/lib/db";
import { runJob } from "@/lib/curator/worker";
import { addProjectNotes, enqueueOverviewJob, getProjectNotes, listDueJobs, recordAnalysis, stageJobPublication, upsertProject } from "@/lib/curator/store";
import { deliverStagedOverview, executeOverviewJob } from "@/lib/curator/overview";
import { getAnalysisDiagnostics, getJobDiagnostics, saveAnalysisDiagnostics } from "@/lib/curator/diagnostics";
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(),"overview-delivery-")),"test.db");
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
Object.assign(process.env,{LLM_PROVIDER:"selectel",CURATOR_REVIEWER:"llm",GITHUB_APP_ID:"123",GITHUB_WEBHOOK_SECRET:"test",
  GITHUB_APP_PRIVATE_KEY_BASE64:Buffer.from(generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"})).toString("base64")});
const project = upsertProject("sample","project");
enqueueOverviewJob(project,{reason:"manual"},true);
const job = listDueJobs(1)[0];
const sha = "a".repeat(40);
const id = recordAnalysis({prId:job.prId,trigger:"overview",headSha:sha,outcome:"ok"});
stageJobPublication(job.id,id,sha,"sample");
let patched = 0;
const bodies: string[] = [];
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/installation")) return Response.json({id:7});
  if (path.endsWith("/access_tokens")) return Response.json({token:"test",expires_at:"2099-01-01T00:00:00Z"});
  if (path.endsWith("/issues") && init?.method === "GET") return Response.json([{number:9,title:"Обзор проекта (AI Curator)",performed_via_github_app:{id:123}}]);
  if (path.endsWith("/issues/9") && init?.method === "PATCH") {
    patched++;
    bodies.push(JSON.parse(String(init.body)).body);
    return Response.json({});
  }
  throw new Error("Unexpected request " + path);
};
await runJob(job);
assert.equal(patched,1);
assert.equal(getDb().prepare("select status from review_jobs where id=?").get(job.id)?.status,"done");
assert.equal(getDb().prepare("select count(*) as n from analyses").get()?.n,1);
assert.ok(bodies[0].includes("sample") && bodies[0].includes(sha.slice(0,7)));
assert.equal(getDb().prepare("select attempts from review_jobs where id=?").get(job.id)?.attempts,0);
assert.equal(getDb().prepare("select publication_attempts from review_jobs where id=?").get(job.id)?.publication_attempts,1);
console.log("ok staged overview recovers an existing issue without analysis or duplicate publication");

addProjectNotes(project,"accepted notes",{analysisId:id});
const notesId = getProjectNotes(project)!.id;
const immutable = `exact saved body for ${sha}\n<!-- ai-curator-overview:${project} -->`;
stageJobPublication(job.id,id,sha,immutable,{notesId});
assert.equal(await deliverStagedOverview(job.id,7),"delivered");
assert.equal(bodies.at(-1),immutable);
const beforeSupersede = patched;
addProjectNotes(project,"human correction",{actor:"supervisor"});
assert.equal(await deliverStagedOverview(job.id,7),"superseded");
assert.equal(patched,beforeSupersede,"an older pending publication must not overwrite newer notes");
assert.equal(getAnalysisDiagnostics(id)?.delivery && (getAnalysisDiagnostics(id)!.delivery as {state:string}).state,"superseded");
assert.equal(getDb().prepare("select comment from analyses where id=?").get(id)?.comment,immutable);
assert.equal(getProjectNotes(project)?.body,"human correction");
assert.equal(getDb().prepare("select memory_sha from projects where id=?").get(project)?.memory_sha,sha);
console.log("ok immutable overview body and superseded publication preserve historical text, human notes and accepted memory");

// If a newer manual publication races an older PATCH, its repair has its own durable snapshot.
stageJobPublication(job.id,id,sha,immutable,{notesId:getProjectNotes(project)!.id});
let racingPatch = 0;
let repairBody = "";
globalThis.fetch = async (input,init) => {
  const path = new URL(String(input)).pathname;
  assert.ok(path.endsWith("/issues/9") && init?.method === "PATCH");
  racingPatch++;
  const body = JSON.parse(String(init.body)).body as string;
  if (racingPatch === 1) {
    assert.equal(body,immutable);
    addProjectNotes(project,"manual edit during PATCH",{actor:"supervisor"});
  } else if (racingPatch === 2) {
    repairBody = body;
    assert.ok(body.includes("manual edit during PATCH"));
    throw new Error("repair connection lost");
  } else assert.equal(body,repairBody,"repair retry uses the saved follow-up snapshot");
  return Response.json({});
};
await assert.rejects(deliverStagedOverview(job.id,7),/repair connection lost/);
assert.equal(getDb().prepare("select json_type(payload,'$.publicationRepair') AS kind from review_jobs where id=?").get(job.id)?.kind,"object");
assert.equal(await deliverStagedOverview(job.id,7),"superseded");
assert.equal(racingPatch,3);
assert.equal(getDb().prepare("select json_type(payload,'$.publicationRepair') AS kind from review_jobs where id=?").get(job.id)?.kind,null);
assert.equal(getDb().prepare("select comment from analyses where id=?").get(id)?.comment,immutable);
console.log("ok concurrent manual notes repair retries its immutable follow-up without rewriting historical analysis");

// A partial result ends processing without claiming full quality. Delivery does not spend model attempts.
const partialProject = upsertProject("sample","partial-project");
enqueueOverviewJob(partialProject,{reason:"manual"},true);
const partialJob = listDueJobs(100).find(item => item.projectId===partialProject)!;
const deps = {
  runCommit:async()=>{},runComment:async()=>{},concludeUnreviewed:async()=>{},concludePublished:async()=>{},reportFailure:async()=>{},
  runOverview:async (attempt: typeof partialJob) => {
    assert.equal(attempt.attempts,1);
    return {quality:"partial" as const,reason:"tool_limit"};
  },
};
await runJob(partialJob,deps);
assert.equal(getDb().prepare("select status from review_jobs where id=?").get(partialJob.id)?.status,"done");
assert.ok((getJobDiagnostics(partialJob.id)!.events as Array<Record<string,unknown>>).some(event=>event.quality==="partial" && event.reason==="tool_limit"));
const partialAnalysis = recordAnalysis({prId:partialJob.prId,trigger:"overview",headSha:sha,outcome:"ok"});
stageJobPublication(partialJob.id,partialAnalysis,sha,"saved publication");
getDb().prepare("update review_jobs set status='queued',run_after=datetime('now') where id=?").run(partialJob.id);
await runJob(listDueJobs(100).find(item=>item.id===partialJob.id)!,{...deps,runOverview:async()=>{throw new Error("temporary delivery error");}});
getDb().prepare("update review_jobs set run_after=datetime('now') where id=?").run(partialJob.id);
await runJob(listDueJobs(100).find(item=>item.id===partialJob.id)!,{...deps,runOverview:async()=>({quality:"complete" as const,publication:"delivered" as const})});
const attempts = getDb().prepare("select attempts,publication_attempts,status from review_jobs where id=?").get(partialJob.id);
assert.deepEqual({...attempts},{attempts:1,publication_attempts:2,status:"done"});
console.log("ok typed partial quality and independent bounded publication attempts");

// GitHub accepted POST but its response was lost: recover by the app marker and update one issue.
const lostProject = upsertProject("sample","lost-response");
enqueueOverviewJob(lostProject,{reason:"manual"},true);
const lostJob = listDueJobs(100).find(item=>item.projectId===lostProject)!;
const lostAnalysis = recordAnalysis({prId:lostJob.prId,trigger:"overview",headSha:sha,outcome:"ok"});
const lostBody = `saved overview\n<!-- ai-curator-overview:${lostProject} -->`;
stageJobPublication(lostJob.id,lostAnalysis,sha,lostBody,{notesId:null});
let posts = 0;
let recoveryPatches = 0;
globalThis.fetch = async (input,init) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/issues") && init?.method === "POST") {posts++;throw new Error("response lost after accepted POST");}
  if (path.endsWith("/issues") && init?.method === "GET") return Response.json([{number:22,title:"renamed",body:lostBody,performed_via_github_app:{id:123}}]);
  if (path.endsWith("/issues/22") && init?.method === "PATCH") {recoveryPatches++;assert.equal(JSON.parse(String(init.body)).body,lostBody);return Response.json({});}
  throw new Error("Unexpected recovery request "+path);
};
await assert.rejects(deliverStagedOverview(lostJob.id,7,false),/response lost/);
assert.equal(await deliverStagedOverview(lostJob.id,7,true),"delivered");
assert.equal(posts,1);
assert.equal(recoveryPatches,1);
console.log("ok lost POST response recovers exactly one issue by stable app marker");

// Restart after submitting a model request: reserve its unknown usage once, without another call.
const interruptedProject = upsertProject("sample","interrupted");
enqueueOverviewJob(interruptedProject,{reason:"manual"},true);
const interruptedJob = listDueJobs(100).find(item=>item.projectId===interruptedProject)!;
const checkpoint = { version:1,sha,spent:100000,evidence:"Retained evidence",budget:{
  maxTokens:950000,deadlineAt:Date.now()+60000,maxToolCalls:60,maxOutputChars:300000,reserveTokens:0,
  spent:{input:100000,output:0},toolCalls:2,outputChars:1000,unknownTokens:0,
  calls:[{id:"submitted-before-crash",phase:"research",provider:"fixture",model:"fixture",startedAt:Date.now(),
    status:"started",inputTokens:0,outputTokens:0,usageSource:"unknown",reservedTokens:850000}],
}};
getDb().prepare("update review_jobs set status='running',payload=? where id=?").run(JSON.stringify({reason:"manual",checkpoint}),interruptedJob.id);
globalThis.fetch = async input => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/installation")) return Response.json({id:7});
  if (path.endsWith("/interrupted")) return Response.json({default_branch:"main"});
  if (path.endsWith("/branches/main")) return Response.json({commit:{sha}});
  throw new Error("No model or archive request permitted during checkpoint exhaustion: "+path);
};
const runInterrupted = async () => executeOverviewJob({...interruptedJob,status:"running",attempts:2,
  payload:JSON.parse(getDb().prepare("select payload from review_jobs where id=?").get(interruptedJob.id)!.payload as string)});
const recoveredSpend = await runInterrupted();
assert.equal(recoveredSpend.quality,"partial");
assert.deepEqual({...getDb().prepare("select tokens_in AS input,tokens_out AS output from analyses where id=?").get(recoveredSpend.analysisId!)},
  {input:100000,output:0},"known checkpoint usage not yet recorded must survive recovery");
const repeatedRecovery = await runInterrupted();
assert.equal(repeatedRecovery.quality,"partial");
assert.deepEqual({...getDb().prepare("select tokens_in AS input,tokens_out AS output from analyses where id=?").get(repeatedRecovery.analysisId!)},
  {input:0,output:0},"already committed checkpoint usage must not be charged twice");
const recordedForJob = () => getDb().prepare(
  "select SUM(tokens_in) AS input,SUM(tokens_out) AS output from analyses where json_extract(diagnostics_json,'$.jobId')=?",
).get(interruptedJob.id);
assert.deepEqual({...recordedForJob()},{input:100000,output:0});
const restoredCheckpoint = JSON.parse(getDb().prepare("select payload from review_jobs where id=?").get(interruptedJob.id)!.payload as string).checkpoint;
assert.equal(restoredCheckpoint.budget.unknownTokens,850000,"restarts must not reserve the same submitted request twice");
assert.equal(restoredCheckpoint.budget.calls[0].status,"unknown");
assert.equal(restoredCheckpoint.budget.calls[0].completionReason,"interrupted");
// A different job at the same PR/SHA must not consume this job's durable accounting.
const otherJobAnalysis = recordAnalysis({prId:interruptedJob.prId,trigger:"overview",headSha:sha,outcome:"partial",tokensIn:77777});
saveAnalysisDiagnostics(otherJobAnalysis,{version:1,jobId:interruptedJob.id+99999});
restoredCheckpoint.budget.spent.input = 150000;
restoredCheckpoint.budget.unknownTokens = 800000;
restoredCheckpoint.spent = 150000;
getDb().prepare("update review_jobs set payload=json_set(payload,'$.checkpoint',json(?)) where id=?").run(JSON.stringify(restoredCheckpoint),interruptedJob.id);
const incrementalRecovery = await runInterrupted();
assert.equal(incrementalRecovery.quality,"partial");
assert.deepEqual({...getDb().prepare("select tokens_in AS input,tokens_out AS output from analyses where id=?").get(incrementalRecovery.analysisId!)},
  {input:50000,output:0},"restore charges only new known usage after the durable 100k");
assert.deepEqual({...recordedForJob()},{input:150000,output:0},"job accounting excludes other jobs at the same PR/SHA");
assert.equal(getProjectNotes(interruptedProject),null);
assert.equal(getDb().prepare("select memory_sha from projects where id=?").get(interruptedProject)?.memory_sha,null);
console.log("ok checkpoint restore preserves unrecorded 100k, avoids duplicate charge, records a 50k delta and keeps canonical memory unchanged");


