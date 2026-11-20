import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { getAnalysis, listDueJobs, listProjectAnalyses, upsertProject, enqueueOverviewJob, getProjectNotes } from "@/lib/curator/store";
import { runJob } from "@/lib/curator/worker";
import { getDb } from "@/lib/db";

const [owner,repo,previousRun] = process.argv.slice(2);
if (!owner || !repo) throw new Error("Expected owner and repo");
const base = resolve("data", "local-overviews");
mkdirSync(base, {recursive:true});
const dir = mkdtempSync(join(base, "run-"));
process.env.DATABASE_PATH = join(dir,"review.db");
if (previousRun) {
  if (!/^run-[a-zA-Z0-9]+$/.test(previousRun)) throw new Error("Expected previous local run name");
  // SQLite backup API includes WAL contents and produces an isolated snapshot.
  const { DatabaseSync, backup } = await import("node:sqlite");
  const source = new DatabaseSync(join(base,previousRun,"review.db"),{readOnly:true});
  try { await backup(source,process.env.DATABASE_PATH); } finally { source.close(); }
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  if (url.hostname === "api.github.com" && method !== "GET" &&
      !(method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname))) {
    if (url.pathname.endsWith("/issues") && method === "POST") return Response.json({number:1});
    if (url.pathname.endsWith("/issues/1/lock") && method === "PUT") return new Response(null,{status:204});
    throw new Error("Unexpected GitHub write during local test");
  }
  return realFetch(input, init);
};
const project = upsertProject(owner,repo);
const before = listProjectAnalyses(project)[0]?.id ?? 0;
enqueueOverviewJob(project,{reason:"manual"},true);
await runJob(listDueJobs(1)[0]);
const row = listProjectAnalyses(project)[0];
const analysis = row && getAnalysis(row.id);
if (!analysis || analysis.id <= before || !["ok","partial"].includes(analysis.outcome)) throw new Error("Overview did not produce a report");
if (analysis.outcome === "partial" && getProjectNotes(project)) throw new Error("Partial review replaced project memory");
writeFileSync(join(dir,"report.md"), analysis.comment || analysis.summary || "", "utf8");
console.log(JSON.stringify({dir, outcome:analysis.outcome, sha:analysis.headSha,model:analysis.model,
  job:getDb().prepare("select status, json_extract(payload,'$.checkpoint.spent') as spent from review_jobs order by id desc limit 1").get()}));
