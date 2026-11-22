import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "map-notes-acceptance-"));
process.env.DATABASE_PATH = join(directory, "test.db");
const { getDb } = await import("@/lib/db");
const { addProjectNotes, createProjectManual, getProjectNotes, NOTES_MAX_CHARS } = await import("@/lib/curator/store");
const { decodeMapAnswer } = await import("@/lib/curator/map-pipeline");
const { buildReviewPrompt } = await import("@/lib/curator/context");
const raw: string[] = [];
for (const path of process.argv.slice(2)) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const row of db.prepare("SELECT part_id,response_json FROM context_pipeline_parts WHERE part_id LIKE 'map-raw:%' OR part_id LIKE 'format-state:map:%'").all()) {
      const answer = JSON.parse(String(row.response_json));
      raw.push(String(row.part_id).startsWith("format-state:") ? JSON.parse(answer.content).answer.content : answer.content);
    }
  } finally { db.close(); }
}
if (!raw.length) raw.push(JSON.stringify({ summary: "Valid map", findings: [], notes: "### Суть\n### Карта репозитория\n### Путь данных\n### Сознательные решения\n" + "я".repeat(6600) }));
try {
  const project = createProjectManual("fixture", "map");
  for (const text of raw) {
    const parsed = decodeMapAnswer(text);
    assert.ok(parsed, "semantically valid stored map must not fail at the former6000 UI cap");
    assert.ok(parsed.notes.length > 6000 && parsed.notes.length < NOTES_MAX_CHARS);
    addProjectNotes(project, parsed.notes, { strict: true });
    assert.equal(getProjectNotes(project)?.body, parsed.notes.trim(), "entire original map retained without clipping");
    const edited = parsed.notes.trim() + "\nУточнение руководителя.";
    addProjectNotes(project, edited, { actor: "supervisor", strict: true });
    assert.equal(getProjectNotes(project)?.body, edited);
    const prompt = buildReviewPrompt({ prNumber: 1, prior: [], dismissed: [], notes: edited, notesByPerson: true,
      research: null, plan: null, prBody: "fixture", replies: [], changes: "fixture" });
    assert.ok(prompt.includes(edited), "PR receives the complete map, including supervisor edit");
    assert.throws(() => addProjectNotes(project, "x".repeat(NOTES_MAX_CHARS + 1), { strict: true }), /storage allowance/);
    assert.equal(getProjectNotes(project)?.body, edited, "oversized write cannot silently change good notes");
  }
  console.log(`ok map notes: ${raw.length} saved/synthetic responses validated, fully stored, edited and passed into PR context without model calls`);
} finally { getDb().close(); await rm(directory, { recursive: true, force: true }); }
