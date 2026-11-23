import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "project-supervisors-"));
process.env.DATABASE_PATH = join(directory, "test.db");
const { getDb } = await import("@/lib/db");
const { addProjectSupervisor, createProjectManual, isSupervisorOf, listProjectSupervisors, listAllProjects, listProjectSummaries, deleteProjectCascade } = await import("@/lib/curator/store");
const db = getDb();
try {
  const addUser = db.prepare("INSERT INTO users(id,login,password_salt,password_hash,role,disabled) VALUES (?,?,?, ?,?,?)");
  for (const [id, role, disabled] of [["asya", "supervisor", 0], ["colleague", "supervisor", 0], ["other", "supervisor", 0], ["disabled", "supervisor", 1], ["head", "head", 0]] as const) {
    addUser.run(id, id, "fixture", "fixture", role, disabled);
  }
  const asya = { userId: "asya", role: "supervisor" as const }, colleague = { userId: "colleague", role: "supervisor" as const };
  const project = createProjectManual("org", "shared", "Shared", "asya");
  const foreignProject = createProjectManual("org", "foreign", "Foreign", "other");
  assert.equal(isSupervisorOf("colleague", project), false);
  assert.throws(() => addProjectSupervisor(project, "colleague", null), /Нет доступа/);
  assert.throws(() => addProjectSupervisor(foreignProject, "colleague", asya), /Нет доступа/);
  assert.throws(() => addProjectSupervisor(project, "colleague", colleague), /Нет доступа/);
  assert.equal(isSupervisorOf("colleague", project), false, "forged project/user IDs cannot grant self access");
  for (const user of ["missing", "disabled", "head", ""]) assert.throws(() => addProjectSupervisor(project, user, asya), /действующую учётную запись/);
  for (const id of [NaN, 0, -1, 1.5, 99999]) assert.throws(() => addProjectSupervisor(id, "colleague", asya), /Нет доступа/);
  addProjectSupervisor(project, "colleague", asya);
  assert.equal(isSupervisorOf("asya", project), true);
  assert.equal(isSupervisorOf("colleague", project), true);
  assert.deepEqual(listProjectSupervisors(project).sort(), ["asya", "colleague"]);
  addProjectSupervisor(project, "colleague", asya);
  assert.equal(listProjectSupervisors(project).length, 2, "repeated submission is idempotent");
  assert.deepEqual(listAllProjects("colleague").map(p => p.id), [project]);
  assert.deepEqual(listProjectSummaries("colleague").map(p => p.id), [project]);
  assert.deepEqual(listAllProjects("asya").map(p => p.id), [project]);
  addProjectSupervisor(project, "other", colleague);
  assert.equal(isSupervisorOf("other", project), true, "added colleague has the same project manager access");
  addProjectSupervisor(foreignProject, "colleague", { userId: "head", role: "head" });
  assert.equal(isSupervisorOf("colleague", foreignProject), true, "head keeps assignment privileges");
  deleteProjectCascade(project); deleteProjectCascade(foreignProject);
  console.log("ok supervisors: own-project sharing, equal visibility, no self-escalation/foreign project access, active supervisor accounts only, idempotence and head privileges");
} finally { db.close(); await rm(directory, { recursive: true, force: true }); }
