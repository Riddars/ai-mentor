import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { isOpenStatus, severityLabel, severityRank } from "@/lib/format";
import { githubRequest } from "@/lib/github/api";
import { getInstallationToken, getRepoInstallationId } from "@/lib/github/auth";
import { publicText } from "@/lib/github/public-text";
import { hashText } from "./context-parts";
import { listAllProjects, listProjectFindings, type FindingRow, type ProjectDetail } from "./store";

const TITLE = "Открытые замечания к проекту";
const ISSUE_BODY_LIMIT = 65_536;
type Repository = Pick<ProjectDetail, "owner" | "repo">;
type Publication = { number: number; bodyHash: string };
type GitHubIssue = { number: number; body?: string; performed_via_github_app?: { id: number }; pull_request?: unknown };

function publication(projectId: number): Publication | undefined {
  return getDb().prepare("SELECT issue_number AS number, body_hash AS bodyHash FROM project_findings_issues WHERE project_id=?")
    .get(projectId) as Publication | undefined;
}

export function projectFindingsIssueNumber(projectId: number): number | null {
  return publication(projectId)?.number ?? null;
}

function sourceLink(repository: Repository, location: FindingRow["locations"][number]) {
  const { target, detail, kind } = location;
  const path = target.split("/");
  if (kind === "other" || path.some(part => !part || part === "." || part === "..") || /[\\\u0000-\u001f]/.test(target)) {
    return publicText([target, detail].filter(Boolean).join(" · "));
  }
  const lines = !/\.ipynb$/i.test(target) ? /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(detail?.trim() ?? "") : null;
  const anchor = lines ? `#L${lines[1]}${lines[2] ? `-L${lines[2]}` : ""}` : "";
  const url = `https://github.com/${repository.owner}/${repository.repo}/blob/HEAD/${path.map(encodeURIComponent).join("/")}${anchor}`;
  const label = publicText(target).replace(/[\[\]\x60]/g, "\\$&");
  return `[${label}](${url})${detail ? ` · ${publicText(detail)}` : ""}`;
}

export function renderProjectFindingsIssue(project: Pick<ProjectDetail, "id" | "owner" | "repo">, rows: FindingRow[]): string {
  const findings = rows.filter(f => f.scope === "project" && isOpenStatus(f.status))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id - b.id);
  const blocks = [
    `<!-- ai-curator-project-findings:${project.id} -->`,
    `**Открытых замечаний в основной ветке: ${findings.length}.**`,
    "Куратор обновляет этот список по результатам проверок. Если исправление ждёт слияния, замечание остаётся в списке до подтверждения в основной ветке. Вопросы по замечаниям можно обсудить с руководителем проекта.",
  ];
  if (!findings.length) blocks.push("Открытых замечаний сейчас нет.");
  for (const finding of findings) {
    const title = finding.title.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/@/g, "@\u200b");
    const fields = [
      ["Что не так", finding.description],
      ["На чём основано", finding.evidence],
      ["Почему важно", finding.impact],
      ["Что поправить", finding.recommendation],
      ["Как проверить исправление", finding.verify],
    ].flatMap(([label, value]) => value ? [`**${label}**\n\n${publicText(value)}`] : []);
    if (finding.locations.length) {
      fields.splice(1, 0, "**Где смотреть**\n\n" + finding.locations.map(location => `- ${sourceLink(project, location)}`).join("\n"));
    }
    const pending = finding.status === "pending" ? " · ждёт подтверждения после слияния" : "";
    blocks.push(`<details>\n<summary>№${finding.id} · ${severityLabel(finding.severity)} · ${title}${pending}</summary>\n\n${fields.join("\n\n")}\n\n</details>`);
  }
  return blocks.join("\n\n");
}

function eligible(projectId: number): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM pull_requests pr WHERE pr.project_id=? AND (
    EXISTS (SELECT 1 FROM analyses a WHERE a.pull_request_id=pr.id AND a.trigger='overview' AND a.outcome='ok')
    OR EXISTS (SELECT 1 FROM findings f WHERE f.pull_request_id=pr.id AND f.scope='project')
  ) LIMIT 1`).get(projectId));
}

async function syncProjectIssue(project: ProjectDetail): Promise<void> {
  const previous = publication(project.id);
  if (!previous && !eligible(project.id)) return;
  const body = renderProjectFindingsIssue(project, listProjectFindings(project.id));
  const bodyHash = hashText(body);
  if (previous?.bodyHash === bodyHash) return;
  if (body.length > ISSUE_BODY_LIMIT) throw new Error("Список замечаний превышает предел размера GitHub Issue");
  const token = await getInstallationToken(await getRepoInstallationId(project.owner, project.repo));
  const base = `/repos/${project.owner}/${project.repo}/issues`;
  const payload = { title: TITLE, body };
  let number = previous?.number;
  if (number !== undefined) {
    try {
      await githubRequest(`${base}/${number}`, { method: "PATCH", token, body: { ...payload, state: "open" } });
    } catch (error) {
      if (!(error instanceof Error && / failed: (404|410) /.test(error.message))) throw error;
      number = undefined;
    }
  }
  if (number === undefined) {
    // Recover a successful POST whose response or local save was interrupted.
    for (let page = 1; ; page++) {
      const issues = await githubRequest<GitHubIssue[]>(`${base}?state=all&per_page=100&page=${page}`, { token });
      const match = issues.find(issue => !issue.pull_request &&
        String(issue.performed_via_github_app?.id) === getConfig().appId &&
        issue.body?.includes(`<!-- ai-curator-project-findings:${project.id} -->`));
      if (match) {
        number = match.number;
        await githubRequest(`${base}/${number}`, { method: "PATCH", token, body: { ...payload, state: "open" } });
        break;
      }
      if (issues.length < 100) break;
    }
    if (number === undefined) number = (await githubRequest<GitHubIssue>(base, { method: "POST", token, body: payload })).number;
  }
  getDb().prepare(`INSERT INTO project_findings_issues(project_id, issue_number, body_hash) VALUES (?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET issue_number=excluded.issue_number, body_hash=excluded.body_hash`)
    .run(project.id, number, bodyHash);
}

export async function syncProjectFindingsIssues(): Promise<void> {
  for (const project of listAllProjects()) {
    try {
      await syncProjectIssue(project);
    } catch (error) {
      console.warn(`[findings issue] ${project.owner}/${project.repo}:`, error instanceof Error ? error.message : String(error));
    }
  }
}
