import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/users";
import {
  getAnalysis,
  getProject,
  isSupervisorOf,
  listAnalysisChanges,
  type AnalysisMode,
} from "@/lib/curator/store";
import { diagnosticPhaseLabel, diagnosticReasonLabel, deliveryLabel, findingStatusLabel, formatDuration, fullDate, outcomeLabel, prLabel, triggerLabel } from "@/lib/format";
import { diagnosticObject, diagnosticRows, getAnalysisDiagnostics } from "@/lib/curator/diagnostics";
import { AppHeader, PageShell } from "@/components/AppHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CollapsibleCard } from "@/components/ui/Collapsible";

export const dynamic = "force-dynamic";

const MODE_LABEL: Record<AnalysisMode, string> = {
  diff: "по изменениям",
  agent: "агент",
  agent_fallback: "по изменениям после сбоя агента",
  context: "по полному diff",
};

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string; aid: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const { id, aid } = await params;
  const projectId = Number(id);
  const analysis = getAnalysis(Number(aid));
  if (!analysis || analysis.projectId !== projectId) notFound();
  if (viewer.role === "supervisor" && !isSupervisorOf(viewer.userId, projectId)) {
    notFound();
  }

  const project = getProject(projectId);
  if (!project) notFound();
  const repoUrl = `https://github.com/${project.owner}/${project.repo}`;
  const changes = listAnalysisChanges(analysis.id);
  const materials = analysis.materials;
  const omitted = materials?.omitted ?? [];
  const sent = (materials?.files ?? []).filter((f) => !omitted.includes(f));
  const model = [analysis.provider, analysis.model].filter(Boolean).join(" / ");
  const diagnostics = getAnalysisDiagnostics(analysis.id);
  const calls = diagnosticRows(diagnostics?.calls);
  const research = diagnosticObject(diagnostics?.research);
  const delivery = diagnosticObject(diagnostics?.delivery);
  const limits = diagnosticObject(diagnostics?.limits);
  const budget = diagnosticObject(diagnostics?.budget);
  const questions = diagnosticRows(research?.questions);
  const requestDuration = calls.reduce((total, call) => total + (typeof call.durationMs === "number" ? call.durationMs :
    typeof call.startedAt === "number" && typeof call.endedAt === "number" ? Math.max(0,call.endedAt-call.startedAt) : 0),0);
  const duration = typeof diagnostics?.durationMs === "number" ? diagnostics.durationMs : requestDuration || null;
  const reason = analysis.trigger === "project_audit" && analysis.outcome === "ok" && diagnostics?.reason === "limited"
    ? "completed" : typeof diagnostics?.reason === "string" ? diagnostics.reason : null;
  const deliveryState = typeof diagnostics?.delivery === "string" ? diagnostics.delivery :
    typeof delivery?.state === "string" ? delivery.state : typeof delivery?.status === "string" ? delivery.status : null;
  const unresolved: Array<Record<string, unknown>> = analysis.trigger === "project_audit" ? [] : [...questions.filter(question => ["pending", "blocked", "unresolved"].includes(String(question.status))),
    ...(Array.isArray(diagnostics?.unresolved) ? diagnostics.unresolved.filter((q): q is string => typeof q === "string").map(question => ({ question })) : [])];
  const verification = diagnosticObject(diagnostics?.verification);
  const toolCalls = research?.toolCalls ?? budget?.toolCalls;
  const reads = diagnosticRows(research?.reads);
  const gaps = Array.isArray(research?.gaps) ? research.gaps.filter((gap): gap is string => typeof gap === "string") : [];
  const numberText = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ru-RU") : "—";

  return (
    <>
      <AppHeader viewer={viewer} />
      <PageShell>
        <Breadcrumbs
          items={[
            { label: "Проекты", href: "/" },
            { label: project.name ?? project.repo, href: `/projects/${projectId}` },
            { label: "Разбор" },
          ]}
        />

        <div className="mt-2 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Разбор {fullDate(analysis.createdAt)}</h1>
            {analysis.outcome !== "ok" && (
              <Badge tone={analysis.outcome === "error" ? "red" : "amber"}>
                {outcomeLabel(analysis.outcome, analysis.trigger)}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {analysis.prNumber !== null && analysis.prNumber > 0 && (
              <a href={`${repoUrl}/pull/${analysis.prNumber}`} target="_blank" rel="noreferrer" className="hover:underline">
                PR #{analysis.prNumber}
              </a>
            )}
            <span>{triggerLabel(analysis.trigger)}</span>
            <a
              href={`${repoUrl}/commit/${analysis.headSha}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs hover:underline"
            >
              {analysis.headSha.slice(0, 7)}
            </a>
            {model && <span>{model}</span>}
          </div>
          {analysis.summary && <p className="mt-3 text-sm">{analysis.summary}</p>}
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-5 lg:col-span-2">
            {diagnostics && (
              <Card className="shadow-card">
                <CardHeader><CardTitle>Результат проверки</CardTitle></CardHeader>
                <CardBody className="flex flex-col gap-4 pt-0 text-sm">
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
                    {reason && <><dt className="text-muted-foreground">Причина завершения</dt><dd>{diagnosticReasonLabel(reason)}</dd></>}
                    {duration !== null && <><dt className="text-muted-foreground">{typeof diagnostics.durationMs === "number" ? "Длительность" : "Время запросов"}</dt><dd>{formatDuration(duration)}</dd></>}
                    {typeof (diagnostics.attempt ?? diagnostics.attempts) === "number" && <><dt className="text-muted-foreground">Модельная попытка</dt><dd>{numberText(diagnostics.attempt ?? diagnostics.attempts)}</dd></>}
                    {typeof toolCalls === "number" && <><dt className="text-muted-foreground">Вызовы инструментов</dt><dd>{numberText(toolCalls)}{typeof limits?.maxToolCalls === "number" ? ` / ${numberText(limits.maxToolCalls)}` : ""}</dd></>}
                    {reads.length > 0 && <><dt className="text-muted-foreground">Сохранённые фрагменты</dt><dd>{reads.length}</dd></>}
                    {typeof budget?.unknownTokens === "number" && budget.unknownTokens > 0 && <><dt className="text-muted-foreground">Резерв запросов с неизвестным расходом</dt><dd>{numberText(budget.unknownTokens)}</dd></>}
                    {typeof limits?.maxTokens === "number" && <><dt className="text-muted-foreground">Бюджет токенов</dt><dd>{numberText(limits.maxTokens)}</dd></>}
                    {typeof limits?.timeoutMs === "number" && <><dt className="text-muted-foreground">Лимит времени</dt><dd>{formatDuration(limits.timeoutMs)}</dd></>}
                    {deliveryState && <><dt className="text-muted-foreground">Публикация</dt><dd>{deliveryLabel(deliveryState)}</dd></>}
                    {typeof verification?.checked === "boolean" && <><dt className="text-muted-foreground">Перепроверка находок</dt><dd>{verification.checked ? "Завершена" : "Не завершена"}</dd></>}
                  </dl>
                  {calls.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <caption className="pb-2 text-left font-medium">Расход задачи по запросам</caption>
                        <thead><tr className="border-b border-border text-muted-foreground"><th className="py-2 pr-3 font-normal">Этап / провайдер / модель</th><th className="py-2 px-2 text-right font-normal">Вход / выход</th><th className="py-2 pl-2 text-right font-normal">Время</th></tr></thead>
                        <tbody>{calls.map((call, index) => {
                          const usage = diagnosticObject(call.usage);
                          const input = usage?.input ?? call.inputTokens ?? call.tokensIn;
                          const output = usage?.output ?? call.outputTokens ?? call.tokensOut;
                          const source = call.usageSource ?? usage?.source;
                          const cacheRead = usage?.cacheRead ?? call.cacheReadTokens;
                          const cacheWrite = usage?.cacheWrite ?? call.cacheWriteTokens;
                          const callDuration = typeof call.durationMs === "number" ? call.durationMs : typeof call.endedAt === "number" && typeof call.startedAt === "number" ? call.endedAt-call.startedAt : null;
                          return <tr key={String(call.id ?? call.callId ?? index)} className="border-b border-border last:border-0">
                            <td className="py-2 pr-3"><span>{diagnosticPhaseLabel(String(call.phase ?? ""))}</span><span className="block text-muted-foreground">{[call.provider, call.model].filter(value => typeof value === "string").join(" / ") || "—"}</span>{typeof call.error === "string" && <span className="mt-1 block max-w-lg break-words text-amber">{call.error}</span>}</td>
                            <td className="py-2 px-2 text-right tabular-nums whitespace-nowrap">{source === "unknown" ? "Неизвестно" : `${numberText(input)} / ${numberText(output)}`}{source === "estimated" || source === "estimate" ? <span className="block text-muted-foreground">оценка</span> : null}{typeof cacheRead === "number" && cacheRead > 0 ? <span className="block text-muted-foreground">из кэша: {numberText(cacheRead)}</span> : null}{typeof cacheWrite === "number" && cacheWrite > 0 ? <span className="block text-muted-foreground">в кэш: {numberText(cacheWrite)}</span> : null}{call.payloadOmitted ? <span className="block text-amber">материалы не сохранены полностью</span> : null}</td>
                            <td className="py-2 pl-2 text-right whitespace-nowrap">{callDuration !== null ? formatDuration(callDuration) : "—"}</td>
                          </tr>;
                        })}</tbody>
                      </table>
                    </div>
                  )}
                  {unresolved.length > 0 && <div><p className="mb-1 font-medium">Осталось проверить</p><ul className="list-disc pl-5">{unresolved.map((question, index) => <li key={index}>{String(question.question ?? question.title ?? question.text ?? "Существенный вопрос")}{typeof question.reason === "string" ? ` — ${question.reason}` : ""}</li>)}</ul></div>}
                  {gaps.length > 0 && <div><p className="mb-1 font-medium">Пробелы проверки</p><ul className="list-disc pl-5">{gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></div>}
                  {typeof delivery?.error === "string" && <p className="text-amber">{delivery.error}</p>}
                  {diagnostics.payloadOmitted ? <p className="text-amber">Подробные материалы не сохранены: достигнут лимит хранения диагностики.</p> : null}
                </CardBody>
              </Card>
            )}
            {analysis.comment && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle>{analysis.trigger === "project_audit" ? "Поиск проблем проекта" : analysis.trigger === "overview" ? analysis.outcome === "partial" ? "Черновик частичного обзора" : "Текст обзора" : "Комментарий в pull request"}</CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                  <Markdown>{analysis.comment}</Markdown>
                </CardBody>
              </Card>
            )}
            {analysis.agentLog && (
              <CollapsibleCard title="Как работал агент">
                <div className="max-h-[40rem] overflow-auto">
                  <Markdown>{analysis.agentLog}</Markdown>
                </div>
              </CollapsibleCard>
            )}
            {analysis.rawResponse && (
              <CollapsibleCard title="Ответ модели как есть">
                <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap">
                  <code>{analysis.rawResponse}</code>
                </pre>
              </CollapsibleCard>
            )}
            {changes.length > 0 && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle>Изменения по замечаниям</CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                  <ul className="flex flex-col divide-y divide-border text-sm">
                    {changes.map((c, i) => (
                      <li key={i} className="py-2.5 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <Link
                            href={`/projects/${projectId}/findings/${c.findingId}`}
                            className="font-medium hover:underline"
                          >
                            {c.title}
                          </Link>
                          <Badge tone={c.oldStatus === null ? "primary" : "neutral"}>
                            {c.oldStatus === null ? "новое" : findingStatusLabel(c.newStatus)}
                          </Badge>
                        </div>
                        {c.prNumber !== analysis.prNumber && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {c.prNumber === 0 ? "найдено полным обзором" : `найдено в ${prLabel(c.prNumber)}`}
                          </p>
                        )}
                        {c.reason && <p className="mt-0.5 text-xs text-muted-foreground">{c.reason}</p>}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            )}
          </div>

          {materials && (
            <Card className="h-fit shadow-card">
              <CardHeader>
                <CardTitle>Что получила модель</CardTitle>
              </CardHeader>
              <CardBody className="flex flex-col gap-3 pt-0 text-sm">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">Изменённые файлы</p>
                  {sent.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {sent.map((f) => (
                        <li key={f} className="font-mono text-xs break-all">
                          {f}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">—</p>
                  )}
                </div>
                {(omitted.length > 0 || (materials.unlisted ?? 0) > 0 || (materials.truncated && !materials.omitted)) && (
                  <div>
                    <p className="mb-1 text-xs text-amber">Не переданы модели из-за объёма</p>
                    {omitted.length > 0 && (
                      <ul className="flex flex-col gap-0.5">
                        {omitted.map((f) => (
                          <li key={f} className="font-mono text-xs break-all">
                            {f}
                          </li>
                        ))}
                      </ul>
                    )}
                    {(materials.unlisted ?? 0) > 0 && (
                      <p className="text-xs">ещё {materials.unlisted} файлов сверх лимита списка</p>
                    )}
                    {materials.truncated && !materials.omitted && (
                      <p className="text-xs">часть изменений обрезана</p>
                    )}
                  </div>
                )}
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">RESEARCH.md</dt>
                  <dd>{materials.researchDoc ? "есть" : "нет"}</dd>
                  {materials.planDoc !== undefined && (
                    <>
                      <dt className="text-muted-foreground">PLAN.md</dt>
                      <dd>{materials.planDoc ? "есть" : "нет"}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Открытые замечания проекта</dt>
                  <dd className="tabular-nums">{materials.priorFindings}</dd>
                  {materials.dismissedFindings !== undefined && (
                    <>
                      <dt className="text-muted-foreground">Снятые замечания</dt>
                      <dd className="tabular-nums">{materials.dismissedFindings}</dd>
                    </>
                  )}
                  {materials.notes !== undefined && (
                    <>
                      <dt className="text-muted-foreground">Заметки о проекте</dt>
                      <dd>{materials.notes ? "есть" : "нет"}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Ответы студента</dt>
                  <dd className="tabular-nums">{materials.studentResponses}</dd>
                  {analysis.mode && (
                    <>
                      <dt className="text-muted-foreground">Режим</dt>
                      <dd>{analysis.trigger === "project_audit" ? "по исходникам проекта" : MODE_LABEL[analysis.mode]}</dd>
                    </>
                  )}
                  {analysis.tokensIn !== null && (
                    <>
                      <dt className="text-muted-foreground">{diagnostics ? "Токены этой попытки, вход / выход" : "Токены, вход / выход"}</dt>
                      <dd className="tabular-nums">
                        {analysis.tokensIn.toLocaleString("ru-RU")} / {(analysis.tokensOut ?? 0).toLocaleString("ru-RU")}
                      </dd>
                    </>
                  )}
                </dl>
                {analysis.viewedFiles && (
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Прочитано агентом ({analysis.viewedFiles.length})
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {analysis.viewedFiles.map((f) => (
                        <li key={f} className="font-mono text-xs break-all">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </PageShell>
    </>
  );
}
