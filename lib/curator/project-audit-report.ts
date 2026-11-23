/** Public result text includes confirmed findings only; hypotheses remain in diagnostics. */
export const projectAuditSummary = (count: number) => `Поиск завершён: новых подтверждённых замечаний ${count}.`;

export function projectAuditReport(summary: string, sha: string, titles: string[]): string {
  return [summary, `Версия проекта: \`${sha}\`.`, ...titles.map(title => `- ${title}`)].join("\n\n");
}

/** Present earlier completed audits using the current policy without rewriting their history. */
export function presentProjectAudit<T extends { trigger: string; outcome: string; summary: string | null; headSha: string; comment?: string | null; rawResponse?: string | null }>(analysis: T): T {
  if (analysis.trigger !== "project_audit" || analysis.outcome !== "partial") return analysis;
  const match = /^Поиск с ограничениями: новых подтверждённых замечаний (\d+), непроверенных вопросов \d+\.$/.exec(analysis.summary ?? "");
  if (!match) return analysis; // Unknown/technical partial results must retain their failure state.
  const result = { ...analysis, outcome: "ok", summary: projectAuditSummary(Number(match[1])) };
  if ("comment" in analysis) {
    let titles: string[] = [];
    try {
      const data = JSON.parse(analysis.rawResponse ?? "null");
      if (Array.isArray(data?.result?.accepted)) titles = data.result.accepted
        .filter((finding: { title?: unknown }) => typeof finding?.title === "string").map((finding: { title: string }) => finding.title);
    } catch { /* The canonical findings remain available in the analysis changes below. */ }
    result.comment = projectAuditReport(result.summary, analysis.headSha, titles);
  }
  return result;
}
