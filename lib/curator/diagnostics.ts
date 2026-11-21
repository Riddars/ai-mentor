import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";

/** Diagnostics are versioned by their producer; legacy analyses have no diagnostics. */
export type AnalysisDiagnostics = Record<string, unknown>;

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function object(value: unknown): AnalysisDiagnostics | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AnalysisDiagnostics : null;
}

function parse(raw: unknown): AnalysisDiagnostics | null {
  if (typeof raw !== "string") return null;
  try { return object(JSON.parse(raw)); } catch { return null; }
}

/** Keep complete payloads within the allowance. Omission is explicit and fingerprinted. */
function encode(value: AnalysisDiagnostics, maxBytes: number, reason: string): string {
  const raw = JSON.stringify(value);
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= maxBytes) return raw;
  const metadata: AnalysisDiagnostics = {};
  for (const key of ["version", "jobId", "type", "kind", "id", "callId", "attempt", "attempts", "phase", "provider", "model", "reason", "timestamp", "startedAt", "endedAt", "usage", "limits", "delivery"]) {
    const field = value[key];
    if (field !== undefined && JSON.stringify(field).length < 8000) metadata[key] = field;
  }
  metadata.payloadOmitted = {
    reason, originalBytes: bytes, limitBytes: maxBytes,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
  return JSON.stringify(metadata);
}

/** Persist before a model request, so an interrupted request remains visible after restart. */
export function recordJobEvent(jobId: number, event: AnalysisDiagnostics): void {
  const db = getDb();
  const maxEvent = limit("DIAGNOSTICS_MAX_EVENT_BYTES", 1024 * 1024);
  const maxJob = limit("DIAGNOSTICS_MAX_JOB_BYTES", 16 * 1024 * 1024);
  const used = db.prepare(
    "SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes FROM review_diagnostic_events WHERE job_id=?",
  ).get(jobId)?.bytes as number;
  const remaining = Math.max(0, maxJob - used);
  const payload = encode(event, Math.min(maxEvent, remaining), remaining < maxEvent ? "job_storage_limit" : "event_storage_limit");
  db.prepare("INSERT INTO review_diagnostic_events(job_id, event_json) VALUES (?, ?)").run(jobId, payload);
}

export function saveAnalysisDiagnostics(analysisId: number, diagnostics: AnalysisDiagnostics): void {
  const payload = encode(diagnostics, limit("DIAGNOSTICS_MAX_ANALYSIS_BYTES", 2 * 1024 * 1024), "analysis_storage_limit");
  getDb().prepare("UPDATE analyses SET diagnostics_json=? WHERE id=?").run(payload, analysisId);
}

export function getAnalysisDiagnostics(analysisId: number): AnalysisDiagnostics | null {
  return parse(getDb().prepare("SELECT diagnostics_json FROM analyses WHERE id=?").get(analysisId)?.diagnostics_json);
}

export function getJobDiagnostics(jobId: number): AnalysisDiagnostics | null {
  if (!getDb().prepare("SELECT id FROM review_jobs WHERE id=?").get(jobId)) return null;
  const rows = getDb().prepare(
    "SELECT id, event_json, created_at AS recordedAt FROM review_diagnostic_events WHERE job_id=? ORDER BY id",
  ).all(jobId) as Array<{ id: number; event_json: string; recordedAt: string }>;
  const events = rows.map(row => ({ ...parse(row.event_json), eventId: row.id, recordedAt: row.recordedAt }));
  const pending = new Map<string, AnalysisDiagnostics>();
  for (const event of events) {
    const entry = event as AnalysisDiagnostics;
    const type = String(entry.type ?? entry.kind ?? "");
    const callId = entry.callId ?? entry.id;
    if (typeof callId !== "string" && typeof callId !== "number") continue;
    if (type === "model_call_started") pending.set(String(callId), entry);
    else if (/^model_call_(?:finished|completed|ended|failed|error)$/.test(type)) pending.delete(String(callId));
  }
  return {
    version: 1, jobId, events, unknownInFlight: [...pending.values()],
    storage: { omittedPayloads: events.filter(event => "payloadOmitted" in event).length },
  };
}

/** View helpers accept older and newer diagnostic records without inventing missing facts. */
export function diagnosticObject(value: unknown): AnalysisDiagnostics | null { return object(value); }
export function diagnosticRows(value: unknown): AnalysisDiagnostics[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is AnalysisDiagnostics => row !== null) : [];
}
