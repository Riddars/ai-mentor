import { getDb } from "@/lib/db";
import type { ChatResult } from "@/lib/llm/chat";

export interface PipelineStore {
  load(id: string, requestHash: string): ChatResult | null;
  save(id: string, requestHash: string, answer: ChatResult): void;
}
/** Scope binds the job, revisions, model and prompts; results never cross jobs implicitly. */
export function sqlitePipelineStore(scope: string, jobId?: number): PipelineStore {
  return {
    load(id, requestHash) {
      const row = getDb().prepare("SELECT response_json FROM context_pipeline_parts WHERE scope=? AND part_id=? AND request_hash=?").get(scope, id, requestHash);
      if (!row) return null;
      const answer = JSON.parse(String(row.response_json)) as ChatResult;
      if (typeof answer.content !== "string" || typeof answer.provider !== "string" || typeof answer.model !== "string") throw new Error("Corrupt pipeline checkpoint");
      return answer;
    },
    save(id, requestHash, answer) {
      getDb().prepare("INSERT INTO context_pipeline_parts(scope,part_id,request_hash,response_json,job_id) VALUES (?,?,?,?,?) ON CONFLICT(scope,part_id) DO UPDATE SET request_hash=excluded.request_hash,response_json=excluded.response_json,job_id=COALESCE(excluded.job_id,context_pipeline_parts.job_id)")
        .run(scope, id, requestHash, JSON.stringify(answer), jobId ?? null);
    },
  };
}
export function memoryPipelineStore(): PipelineStore {
  const parts = new Map<string, ChatResult>();
  return { load: (id, hash) => parts.get(id + hash) ?? null, save: (id, hash, answer) => { parts.set(id + hash, answer); } };
}
