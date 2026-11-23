import { getDb } from "@/lib/db";
import { hashText } from "./context-parts";
import { ACTIVE_PROJECT_ANALYSIS, ensureOverviewPullRequest, saveReviewResult, type JobStatus } from "./store";
import { SNAPSHOT_POLICY_VERSION } from "./snapshot-policy";

export const AUDIT_VERSION = "project-audit-v1";
export const projectAuditEnabled = () => process.env.PROJECT_AUDIT_ENABLED === "true";
export interface ProjectMap {
  id: number; projectId: number; jobId: number; analysisId: number; sha: string; body: string; manifest: string;
}
const mapSelect = "SELECT id, project_id AS projectId, job_id AS jobId, analysis_id AS analysisId, sha, body, manifest FROM project_maps";
export function latestProjectMap(projectId: number): ProjectMap | null {
  const map = getDb().prepare(mapSelect + " WHERE project_id=? ORDER BY id DESC LIMIT 1").get(projectId) as unknown as ProjectMap ?? null;
  return hasCurrentMapPolicy(map) ? map : null;
}
export function hasCurrentMapPolicy(map: ProjectMap | null): map is ProjectMap {
  return map !== null && JSON.parse(map.manifest).version === SNAPSHOT_POLICY_VERSION;
}
export function auditMap(jobId: number): ProjectMap {
  const row = getDb().prepare(`SELECT m.id,m.project_id AS projectId,m.job_id AS jobId,m.analysis_id AS analysisId,m.sha,m.body,m.manifest
    FROM project_maps m JOIN project_audit_runs r ON r.map_id=m.id WHERE r.job_id=?`).get(jobId) as unknown as ProjectMap | undefined;
  if (!row) throw new Error("configuration_error: project map is missing");
  return row;
}
export function enqueueProjectAudit(map: ProjectMap, automatic = false): "queued" | "active" {
  return saveReviewResult(() => {
    const db = getDb();
    if (automatic && db.prepare("SELECT 1 FROM project_audit_runs WHERE map_id=? AND automatic=1").get(map.id)) return "active";
    const job = db.prepare(`INSERT INTO review_jobs(pull_request_id,kind,head_sha,payload)
      SELECT @prId,'project_audit',@sha,@payload
      WHERE @automatic OR (NOT EXISTS (${ACTIVE_PROJECT_ANALYSIS})
        AND NOT EXISTS (SELECT 1 FROM review_jobs WHERE pull_request_id=@prId AND kind='project_audit' AND status='queued'))
      RETURNING id`)
      .get({ projectId: map.projectId, prId: ensureOverviewPullRequest(map.projectId), sha: map.sha, automatic: Number(automatic),
        payload: JSON.stringify({ mapId: map.id, automatic, version: AUDIT_VERSION }) }) as { id: number } | undefined;
    if (!job) return "active";
    db.prepare("INSERT INTO project_audit_runs(job_id,map_id,automatic) VALUES (?,?,?)").run(job.id, map.id, Number(automatic));
    return "queued";
  });
}
/** Called inside the successful map transaction, before its GitHub delivery. */
export function saveProjectMap(projectId: number, jobId: number, analysisId: number, sha: string, body: string, manifest: unknown, automatic: boolean): void {
  const db = getDb();
  db.prepare("INSERT INTO project_maps(project_id,job_id,analysis_id,sha,body,manifest) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING")
    .run(projectId, jobId, analysisId, sha, body, JSON.stringify(manifest));
  if (automatic && projectAuditEnabled()) enqueueProjectAudit(latestProjectMap(projectId)!, true);
}
export interface AuditHistory {
  area?: string | null; severity?: string | null;
  id: number; status: string; title: string; description: string | null; evidence: string | null;
  locations: string | null; verify: string | null; recommendation: string | null; impact: string | null;
  history: string; updatedAt: string;
}
/** Full main/project history, including resolved and human-dismissed findings. */
export function loadAuditHistory(projectId: number): AuditHistory[] {
  return getDb().prepare(`SELECT f.id,f.status,f.area,f.severity,f.title,f.description,f.evidence,f.locations,f.verify,f.recommendation,f.impact,
    f.updated_at AS updatedAt, COALESCE((SELECT json_group_array(json_object('id',h.id,'oldStatus',h.old_status,
    'newStatus',h.new_status,'reason',h.reason,'actor',h.actor,'analysisId',h.analysis_id)) FROM finding_status_history h
    WHERE h.finding_id=f.id ORDER BY h.id),'[]') AS history
    FROM findings f JOIN pull_requests pr ON pr.id=f.pull_request_id
    WHERE pr.project_id=? AND (f.scope='project' OR pr.merged_into_default=1) ORDER BY f.id`).all(projectId) as unknown as AuditHistory[];
}
export const auditHistoryHash = (history: AuditHistory[]) => hashText(JSON.stringify(history));
export function savedAuditInput(jobId: number): unknown {
  const row = getDb().prepare("SELECT input_json FROM project_audit_runs WHERE job_id=?").get(jobId);
  return row?.input_json ? JSON.parse(String(row.input_json)) : null;
}
export function saveAuditInput(jobId: number, input: unknown): void {
  getDb().prepare("UPDATE project_audit_runs SET input_json=? WHERE job_id=? AND input_json IS NULL").run(JSON.stringify(input), jobId);
}
export function completedAudit(jobId: number): number | null {
  const row = getDb().prepare("SELECT analysis_id FROM project_audit_runs WHERE job_id=?").get(jobId);
  return row?.analysis_id == null ? null : Number(row.analysis_id);
}
export function completeAudit(jobId: number, analysisId: number): void {
  getDb().prepare("UPDATE project_audit_runs SET analysis_id=? WHERE job_id=?").run(analysisId, jobId);
}
export function latestProjectAudit(projectId: number): { status: JobStatus; lastError: string | null; sha: string; analysisId: number | null; jobId: number } | null {
  return getDb().prepare(`SELECT j.status,j.last_error AS lastError,j.head_sha AS sha,r.analysis_id AS analysisId,j.id AS jobId
    FROM review_jobs j JOIN project_audit_runs r ON r.job_id=j.id JOIN pull_requests pr ON pr.id=j.pull_request_id
    WHERE pr.project_id=? ORDER BY j.id DESC LIMIT 1`).get(projectId) as unknown as ReturnType<typeof latestProjectAudit> ?? null;
}
