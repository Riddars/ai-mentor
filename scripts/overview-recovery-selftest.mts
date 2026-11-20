import assert from "node:assert/strict";
import { parseOverviewDraft } from "@/lib/curator/overview-draft";
const correct = JSON.stringify({summary:"tested", findings:[], notes:"one\ntwo"});
const malformed = correct.replace(',"notes"', '"notes"');
const multiline = correct.replace("\\n", "\n");
assert.equal((await parseOverviewDraft(multiline,0)).parsed?.notes,"one\ntwo");
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
import { enqueueOverviewJob, listDueJobs, recordAnalysis, stageJobPublication, upsertProject } from "@/lib/curator/store";
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
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/installation")) return Response.json({id:7});
  if (path.endsWith("/access_tokens")) return Response.json({token:"test",expires_at:"2099-01-01T00:00:00Z"});
  if (path.endsWith("/issues") && init?.method === "GET") return Response.json([{number:9,title:"Обзор проекта (AI Curator)",performed_via_github_app:{id:123}}]);
  if (path.endsWith("/issues/9") && init?.method === "PATCH") {patched++; return Response.json({});}
  throw new Error("Unexpected request " + path);
};
await runJob(job);
assert.equal(patched,1);
assert.equal(getDb().prepare("select status from review_jobs where id=?").get(job.id)?.status,"done");
assert.equal(getDb().prepare("select count(*) as n from analyses").get()?.n,1);
console.log("ok staged overview recovers an existing issue without analysis or duplicate publication");


