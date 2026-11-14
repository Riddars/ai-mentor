/** Offline inactivity acceptance: real SQLite, worker entry points, mocked GitHub only. */
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "curator-inactivity-"));
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({format:"pem",type:"pkcs8"});
Object.assign(process.env, { DATABASE_PATH:join(dir,"db"), GITHUB_APP_ID:"1", GITHUB_WEBHOOK_SECRET:"test",
  GITHUB_APP_PRIVATE_KEY_BASE64:Buffer.from(key).toString("base64"), CURATOR_REVIEWER:"llm", LLM_PROVIDER:"openai",OPENAI_API_KEY:"fixture",LLM_MODEL:"fixture" });
delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const {getDb} = await import("@/lib/db");
const store = await import("@/lib/curator/store");
const activity = await import("@/lib/curator/inactivity");
const db = getDb();
const realFetch = globalThis.fetch;
const now = new Date("2026-11-14T12:00:00Z");
let lastPush = "2026-01-01T00:00:00Z";
let comments: Array<{updated_at:string; user:{type:string;login:string}}> = [];
let issues: Array<{number:number;created_at:string;updated_at:string;user:{type:string;login:string}}> = [];
let timeline: Array<{created_at:string;actor:{type:string;login:string}}> = [];
let broken = false;
let onRepo: (()=>void) | null = null;
let changeOnSecondGet = false;
let repoGets = 0;
let posts = 0;
let prState = "open";
let onComments: (()=>void) | null = null;
let loseResponse = false;
const posted: string[] = [];
const human = {type:"User",login:"student"};
const bot = {type:"Bot",login:"curator[bot]"};
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  assert.equal(u.hostname, "api.github.com");
  if (broken) throw new Error("GitHub unavailable");
  const path = u.pathname;
  if(path.endsWith("/installation")) return Response.json({id:1});
  if(path.endsWith("/access_tokens")) return Response.json({token:"fixture",expires_at:"2099-01-01"});
  if(path.endsWith("/repo")) {
    repoGets++;
    onRepo?.(); onRepo=null;
    return Response.json({created_at:"2025-01-01T00:00:00Z",pushed_at:lastPush,
      updated_at:changeOnSecondGet && repoGets % 2 === 0 ? "2026-11-14T11:00:00Z":"2026-01-01T00:00:00Z"});
  }
  if(path.endsWith("/issues/comments") || path.endsWith("/pulls/comments")) return Response.json(comments);
  if(path.endsWith("/issues")) return Response.json(issues);
  if(path.endsWith("/timeline")) return Response.json(timeline);
  if(path.includes("/check-runs")) return Response.json({id:1});
  if(path.endsWith("/pulls/1")) return Response.json({state:prState,number:1,head:{sha:"abc",ref:"work"},base:{ref:"main"},user:human,draft:false,updated_at:"2026-11-14T12:00:00Z"});
  if(path.endsWith("/issues/1/comments")) {
    if(init?.method === "POST") {
      posts++;
      posted.push(JSON.parse(String(init.body)).body);
      if(loseResponse) {loseResponse=false; throw new Error("Response lost after successful POST");}
      return Response.json({id:posts});
    }
    onComments?.(); onComments=null;
    return Response.json(posted.map(body=>({body,user:bot,performed_via_github_app:{id:1}})));
  }
  throw new Error("Unexpected GitHub request: " + u);
};
const id = store.createProjectManual("org","repo");
function reset() {
  db.prepare("UPDATE projects SET status='active',activity_at=NULL,activity_checked_at=NULL,created_at='2026-01-01',activity_revision=0,pause_reason=NULL WHERE id=?").run(id);
  lastPush="2026-01-01T00:00:00Z"; comments=[];issues=[];timeline=[];broken=false;onRepo=null;changeOnSecondGet=false;repoGets=0;
}
try {
  assert.equal(activity.inactivityCutoff(new Date("2026-04-30T12:00:00Z")).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(activity.inactivityCutoff(new Date("2024-04-30T12:00:00Z")).toISOString(), "2024-02-29T12:00:00.000Z");
  reset(); await activity.checkInactiveProjects(now);
  assert.equal(store.getProject(id)?.status,"paused");
  assert.equal(store.projectActivity(id)?.reason,"inactivity");
  reset(); lastPush="2026-10-01T00:00:00Z"; await activity.checkInactiveProjects(now);
  assert.equal(store.getProject(id)?.status,"active");
  reset(); comments=[{updated_at:"2026-10-01T00:00:00Z",user:human}]; await activity.checkInactiveProjects(now);
  assert.equal(store.getProject(id)?.status,"active");
  reset(); comments=[{updated_at:"2026-10-01T00:00:00Z",user:bot}];
  issues=[{number:3,created_at:"2026-01-01T00:00:00Z",updated_at:"2026-10-01T00:00:00Z",user:human}];
  timeline=[{created_at:"2026-10-01T00:00:00Z",actor:bot}]; await activity.checkInactiveProjects(now);
  assert.equal(store.getProject(id)?.status,"paused", "AI comments do not prolong project activity");
  reset(); timeline=[{created_at:"2026-10-01T00:00:00Z",actor:human}];
  issues=[{number:3,created_at:"2026-01-01T00:00:00Z",updated_at:"2026-10-01T00:00:00Z",user:human}];
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active");
  reset(); issues=[{number:3,created_at:"2026-01-01T00:00:00Z",updated_at:"2026-11-01T00:00:00Z",user:human}];
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active", "unexplained PR body edit is activity");
  reset(); broken=true; await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active");
  reset(); onRepo=()=>store.recordProjectActivity(id,"2026-11-14T10:00:00Z");
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active", "webhook wins race");
  reset(); changeOnSecondGet=true; await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active");
  reset(); db.prepare("UPDATE projects SET created_at='2026-11-01' WHERE id=?").run(id);
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active");
  reset(); db.prepare("UPDATE projects SET activity_at='2026-09-14T12:00:00Z' WHERE id=?").run(id);
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active", "exactly two months is not older");
  reset();
  const pr = store.upsertPullRequest(id, 99);
  db.prepare("INSERT INTO review_jobs(pull_request_id,kind,payload,status) VALUES (?,'commit','{}','running')").run(pr);
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active", "running review prevents pause");
  db.prepare("DELETE FROM review_jobs WHERE pull_request_id=?").run(pr);
  reset(); onRepo=()=>store.setProjectStatus(id,"active");
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active", "resume wins activity scan race");
  reset(); comments=Array.from({length:100},()=>({updated_at:"2026-10-01T00:00:00Z",user:bot}));
  await activity.checkInactiveProjects(now); assert.equal(store.getProject(id)?.status,"active", "truncated activity scan is not inactivity proof");
  reset(); store.setProjectStatus(id,"paused"); await activity.checkInactiveProjects(now);
  assert.equal(store.projectActivity(id)?.reason,"manual");
  loseResponse=true;
  await assert.rejects(activity.notifyPausedPullRequest({projectId:id,number:1,installationId:1}));
  assert.equal(store.pendingPauseNotices().length,1);
  await activity.retryPauseNotifications();
  await activity.notifyPausedPullRequest({projectId:id,number:1,installationId:1});
  assert.equal(posts,1); assert.equal(store.pendingPauseNotices().length,0);
  assert.equal(store.getProject(id)?.status,"paused");
  db.prepare("DELETE FROM pause_notifications").run(); posted.length=0; posts=0;
  onComments=()=>store.setProjectStatus(id,"active");
  await activity.notifyPausedPullRequest({projectId:id,number:1,installationId:1});
  assert.equal(posts,0,"resume during comment lookup cancels obsolete notice");
  assert.equal(store.pauseNoticeSent(id,1),false);
  store.setProjectStatus(id,"paused");
  db.prepare("DELETE FROM pause_notifications").run(); posted.length=0; posts=0;
  prState="closed";
  await activity.notifyPausedPullRequest({projectId:id,number:1,installationId:1});
  assert.equal(store.pauseNoticeSent(id,1),false);
  prState="open";
  store.queuePauseNotice(id,1);
  store.setProjectStatus(id,"active");
  await activity.retryPauseNotifications();
  assert.equal(store.pauseNoticeSent(id,1),false);
  store.setProjectStatus(id,"paused");
  const {POST} = await import("@/app/api/github/webhook/route");
  const payload={action:"opened",sender:human,installation:{id:1},repository:{id:123,name:"repo",owner:{login:"org"}},
    pull_request:{number:1,head:{sha:"abc",ref:"work"},base:{ref:"main"},user:human,state:"open",draft:false,updated_at:"2026-11-14T12:00:00Z"}};
  const raw=JSON.stringify(payload);
  for(const delivery of ["pause-first","pause-first","pause-second"]) {
    const response=await POST(new Request("http://fixture/api/github/webhook",{method:"POST",body:raw,headers:{
      "x-github-event":"pull_request","x-github-delivery":delivery,
      "x-hub-signature-256":"sha256="+createHmac("sha256","test").update(raw).digest("hex")}}));
    assert.equal(response.status,200);
  }
  assert.equal(posts,1,"signed paused webhooks only post once");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM review_jobs").get()?.n,0,"no model work for paused PR");
  for(let number=2;number<=12;number++) store.queuePauseNotice(id,number);
  const warn=console.warn; console.warn=()=>{};
  try { await activity.retryPauseNotifications(); } finally {console.warn=warn;}
  assert.equal(store.pendingPauseNotices()[0]?.number,12,"failures do not starve other notices");
  store.setProjectStatus(id,"active");
  await activity.checkInactiveProjects(new Date()); assert.equal(store.getProject(id)?.status,"active");
  store.deleteProjectCascade(id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pause_notifications").get()?.n,0);
  console.log("ok inactivity, calendar boundary, human/bot activity, API failure, races, connection/resume grace, durable deduplicated pause notices, cascade");
} finally {
  globalThis.fetch=realFetch;
  db.close();
  rmSync(dir,{recursive:true,force:true,maxRetries:3});
}
