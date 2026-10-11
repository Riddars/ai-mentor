/**
 * Free checks of the project memory: scope of findings across parallel PRs, closing rules,
 * PR chains, daily token budgets and the public comment text. A temporary database, no
 * network, no keys.
 *
 *   npx tsx scripts/store-selftest.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "curator-store-test-"));
// Set before the database module is loaded: it reads the path when the connection opens.
process.env.DATABASE_PATH = join(dir, "test.db");

const scope = await import("@/lib/curator/scope");
const store = await import("@/lib/curator/store");
const { publicText, renderComment } = await import("@/lib/curator/review");
const { runJob } = await import("@/lib/curator/worker");
const { getDb } = await import("@/lib/db");

type Location = { kind: "file" | "document" | "data" | "other"; target: string; detail?: string | null };

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- scope helpers ---------------------------------------------------------------------

const patch = "@@ -1,3 +1,4 @@\n line one\n-old two\n+new two\n+new three\n line four\n@@ -20,2 +21,2 @@\n ctx\n+added 22";
const added = scope.addedLines(patch);
check("patch: added lines found", [...added].sort((a, b) => a - b).join(",") === "2,3,22", [...added].join(","));

const changed = scope.changedLines([
  { filename: "src/train.py", patch },
  { filename: "notebooks/eda.ipynb", patch: "@@ -1 +1 @@\n+{}" },
  { filename: "data/big.csv" },
]);
const file = (target: string, detail?: string): Location => ({ kind: "file", target, detail });
check("scope: cited lines added by the PR → branch", scope.findingScope([file("src/train.py", "3")], changed, false) === "branch");
check("scope: old lines of a changed file → project", scope.findingScope([file("src/train.py", "10-12")], changed, false) === "project");
check("scope: untouched file → project", scope.findingScope([file("src/data.py", "5")], changed, false) === "project");
check("scope: changed notebook → branch", scope.findingScope([file("notebooks/eda.ipynb", "40")], changed, false) === "branch");
check("scope: no cited places → branch", scope.findingScope([{ kind: "other", target: "логика выводов" }], changed, false) === "branch");
check("scope: merged into main → project", scope.findingScope([file("src/train.py", "3")], changed, true) === "project");
check("scope: changed file without line numbers → branch", scope.findingScope([file("src/train.py")], changed, false) === "branch");
check("scope: free-text document → no place", scope.findingScope([{ kind: "document", target: "раздел про данные" }], changed, false) === "branch");
const files = new Set(changed.keys());
check("fix visible: cited file changed", scope.fixVisible([file("src/train.py", "50")], files));
check("fix not visible: cited file untouched", !scope.fixVisible([file("src/data.py", "5")], files));
check("fix visible: no cited places", scope.fixVisible([], files));

// --- public comment text ---------------------------------------------------------------

const cleaned = publicText("См. @student и [ссылку](https://evil.example/x), ещё https://x.example и www.y.example; почта a@b.ru");
check("public text: mention defused", cleaned.includes("@​student") && !/(^|\s)@student/.test(cleaned), cleaned);
check("public text: markdown link reduced to its text", cleaned.includes("ссылку") && !cleaned.includes("evil.example"), cleaned);
check("public text: bare URLs not linked", cleaned.includes("`https://x.example`") && cleaned.includes("`www.y.example`"), cleaned);
check("public text: e-mail left as is", cleaned.includes("a@b.ru"), cleaned);
const code = publicText("Код `@torch.no_grad()` и `https://a.example`, затем `x`@alice\n```\n@decorator\n```");
check("public text: code spans and blocks untouched", code.includes("`@torch.no_grad()`") && code.includes("`https://a.example`") && code.includes("\n@decorator\n"), code);
check("public text: mention right after a code span defused", code.includes("`x`@\u200balice"), code);

// --- memory: parallel PRs --------------------------------------------------------------

const db = getDb();
const projectId = store.createProjectManual("org", "proj");
const pr = (number: number, headRef: string, baseRef = "main") =>
  store.upsertPullRequest(projectId, number, { state: "open", headSha: `sha${number}`, headRef, baseRef, mergedIntoDefault: false });
const analysis = (prId: number) =>
  store.recordAnalysis({ prId, headSha: `sha${prId}`, trigger: "commit", outcome: "ok", mode: "diff", tokensIn: 10, tokensOut: 5 });
const finding = (title: string, locations: Location[], status: "open" | "closed" = "open", priorId: number | null = null) => ({
  priorId,
  status,
  title,
  locations,
});
const changes = (...paths: Array<[string, number[] | null]>): Map<string, Set<number> | null> =>
  new Map(paths.map(([p, lines]) => [p, lines ? new Set(lines) : null]));
const reconcile = (
  prId: number,
  findings: ReturnType<typeof finding>[],
  changed: Map<string, Set<number> | null>,
  fixesFinal = false,
) =>
  store.applyReconciliation(prId, analysis(prId), { summary: "", findings }, {
    allowedPriorIds: new Set(findings.map((f) => f.priorId).filter((id): id is number => id !== null)),
    allowNew: true,
    fixesFinal,
    changed,
  });
const row = (id: number) =>
  db.prepare("SELECT status, scope, pull_request_id AS prId, resolved_by_pr_id AS resolvedBy FROM findings WHERE id = @id").get({ id }) as {
    status: string;
    scope: string;
    prId: number;
    resolvedBy: number | null;
  };
const idOf = (title: string) => (db.prepare("SELECT id FROM findings WHERE title = @title").get({ title }) as { id: number }).id;
const visibleTo = (prId: number) => store.loadOpenFindings(prId).map((f) => f.title);

const prA = pr(1, "feat-a");
const prB = pr(2, "feat-b");
reconcile(prA, [
  finding("leak in A's new code", [file("src/split.py", "4")]),
  finding("old bug in data.py", [file("src/data.py", "10")]),
  finding("second old bug", [file("src/metrics.py", "3")]),
], changes(["src/split.py", [4, 5]]));
const leak = idOf("leak in A's new code");
const oldBug = idOf("old bug in data.py");
const second = idOf("second old bug");
check("new finding in added lines is a branch finding", row(leak).scope === "branch");
check("new finding outside the PR's changes is a project finding", row(oldBug).scope === "project");
check("parallel PR does not see another PR's branch finding", !visibleTo(prB).includes("leak in A's new code"), visibleTo(prB).join(", "));
check("parallel PR sees project findings", visibleTo(prB).includes("old bug in data.py"));

// B claims A's branch finding is fixed: refused even if the id slips through.
reconcile(prB, [finding("x", [], "closed", leak)], changes(["src/split.py", [1]]));
check("parallel PR cannot close another PR's branch finding", row(leak).status === "open", row(leak).status);

// B fixes the project finding (changes data.py): pending, owned by B.
reconcile(prB, [finding("x", [], "closed", oldBug)], changes(["src/data.py", [10]]));
check("project finding fixed in a PR → pending", row(oldBug).status === "pending" && row(oldBug).resolvedBy === prB);
check("a PR does not see a fix pending in another PR", !visibleTo(prA).includes("old bug in data.py"));
reconcile(prA, [finding("x", [], "open", oldBug)], changes(["src/split.py", [4]]));
check("another PR cannot reopen a pending fix", row(oldBug).status === "pending" && row(oldBug).resolvedBy === prB);

// B calls the second project finding fixed without touching its file: not accepted.
const result = reconcile(prB, [finding("x", [], "closed", second)], changes(["src/other.py", [1]]));
check("fix not visible in the PR's changes is not accepted", row(second).status === "open" && result.kept.some((k) => k.fixNotCounted));
const comment = renderComment({ summary: "s", findings: [] }, result.statusChanges, undefined, { kept: result.kept });
check("comment says the fix was not counted", comment.includes("не засчитано как исправленное"), comment);

// A is merged into main: its branch findings become the project's.
store.recordPullRequestClosed(prA, "merged-default");
check("merge into main makes branch findings project ones", row(leak).scope === "project");
check("after the merge other PRs see them", visibleTo(prB).includes("leak in A's new code"));

// A finding raised by the review of an already merged PR belongs to the project at once.
reconcile(prA, [finding("found after merge", [file("src/split.py", "4")])], changes(["src/split.py", [4]]), true);
check("finding of a review after the merge is a project finding", row(idOf("found after merge")).scope === "project");

// B is closed without merge: its pending fix goes back to open.
store.recordPullRequestClosed(prB, "closed");
check("closing without merge reopens the PR's pending fixes", row(oldBug).status === "open" && row(oldBug).resolvedBy === null);

// --- PR chains -------------------------------------------------------------------------

const prD = pr(4, "feat-d");
const prC = pr(3, "feat-c", "feat-d");
reconcile(prC, [finding("bug in C", [file("src/c.py", "1")])], changes(["src/c.py", [1]]));
reconcile(prC, [finding("x", [], "closed", oldBug)], changes(["src/data.py", [10]]));
const bugC = idOf("bug in C");
store.upsertPullRequest(projectId, 3, { state: "merged", mergedIntoDefault: false });
store.recordPullRequestClosed(prC, "merged-other");
check("merge into another PR's branch hands findings over", row(bugC).prId === prD && row(bugC).scope === "branch");
check("…and its pending fixes", row(oldBug).status === "pending" && row(oldBug).resolvedBy === prD);

// The receiving PR opens only after the merge.
const prE = pr(5, "feat-e", "feat-f");
reconcile(prE, [finding("bug in E", [file("src/e.py", "1")])], changes(["src/e.py", [1]]));
store.upsertPullRequest(projectId, 5, { state: "merged", mergedIntoDefault: false });
store.recordPullRequestClosed(prE, "merged-other");
check("without a receiving PR the findings wait", row(idOf("bug in E")).prId === prE);
const prF = pr(6, "feat-f");
check("a PR opened later takes them over", store.adoptMergedBranchFindings(prF) === 1 && row(idOf("bug in E")).prId === prF);

// --- project counters ------------------------------------------------------------------

const prG = pr(7, "feat-g");
reconcile(prG, [
  finding("branch finding of an abandoned PR", [file("src/g.py", "1")]),
  finding("project finding of an abandoned PR", [file("src/old.py", "1")]),
], changes(["src/g.py", [1]]));
const before = store.listProjectSummaries()[0].openFindings;
store.upsertPullRequest(projectId, 7, { state: "closed" });
store.recordPullRequestClosed(prG, "closed");
const after = store.listProjectSummaries()[0].openFindings;
check("closing without merge drops only its branch findings from the counters", after === before - 1, `${before} → ${after}`);

// --- review fixes ----------------------------------------------------------------------

// A finding given to the model but closed meanwhile is not raised again as a new one.
const prI = pr(9, "feat-i");
reconcile(prI, [finding("race finding", [file("src/i.py", "1")])], changes(["src/i.py", [1]]));
const race = idOf("race finding");
db.prepare("UPDATE findings SET status = 'dismissed' WHERE id = @id").run({ id: race });
const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n;
reconcile(prI, [finding("race finding", [file("src/i.py", "1")], "closed", race)], changes(["src/i.py", [1]]));
const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n;
check("a prior finding closed meanwhile is not duplicated", countAfter === countBefore && row(race).status === "dismissed");

// A PR merged into main takes over findings of PRs merged into its branch before it.
const prK = pr(11, "feat-k");
const prL = pr(12, "feat-l", "feat-k");
reconcile(prL, [finding("bug in L", [file("src/l.py", "1")])], changes(["src/l.py", [1]]));
store.upsertPullRequest(projectId, 12, { state: "merged", mergedIntoDefault: false });
db.prepare("UPDATE pull_requests SET state = 'merged', merged_into_default = 1 WHERE id = @id").run({ id: prK });
store.recordPullRequestClosed(prK, "merged-default");
const bugL = row(idOf("bug in L"));
const branchL = (db.prepare("SELECT branch FROM findings WHERE id = @id").get({ id: idOf("bug in L") }) as { branch: string | null }).branch;
check("merge into main collects findings left in its branch", bugL.prId === prK && bugL.scope === "project", JSON.stringify(bugL));
check("handed-over findings carry the new branch", branchL === "feat-k", String(branchL));

// --- daily token budgets ---------------------------------------------------------------

process.env.TOKENS_PER_PROJECT_DAY = "1000";
const prH = pr(8, "feat-h");
store.recordAnalysis({ prId: prH, headSha: "old", trigger: "commit", outcome: "error", tokensIn: 900, tokensOut: 200 });
const { jobId } = store.enqueueCommitJob({ prId: prH, headSha: "sha8", payload: {}, delayMs: 0, deadlineMs: 60_000 });
store.setJobCheckRun(jobId as number, 42);
const job = store.listDueJobs(10).find((j) => j.id === jobId);
let ran = false;
let note = "";
await runJob(job!, {
  runCommit: async () => {
    ran = true;
  },
  runComment: async () => {
    ran = true;
  },
  concludeUnreviewed: async (_job, summary) => {
    note = summary;
  },
  reportFailure: async () => {},
});
const state = db.prepare("SELECT status, check_concluded AS concluded, run_after > datetime('now') AS later FROM review_jobs WHERE id = @id").get({
  id: jobId,
}) as { status: string; concluded: number; later: number };
check("over the project budget the review does not run", !ran);
check("…the check is concluded \"not reviewed\"", note.includes("бюджет токенов проекта") && state.concluded === 1, note);
check("…and the job waits in the queue", state.status === "queued" && state.later === 1);
check("failed analyses count toward the budget", store.recentTokens(projectId) >= 1100, String(store.recentTokens(projectId)));

process.env.TOKENS_PER_PROJECT_DAY = "0";
process.env.TOKENS_PER_DAY = "0";
db.prepare("UPDATE review_jobs SET run_after = datetime('now', '-1 minute'), check_concluded = 0 WHERE id = @id").run({ id: jobId });
const again = store.listDueJobs(10).find((j) => j.id === jobId);
await runJob(again!, {
  runCommit: async () => {
    ran = true;
  },
  runComment: async () => {},
  concludeUnreviewed: async () => {},
  reportFailure: async () => {},
});
check("a zero budget means no limit", ran);

db.close();
rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
