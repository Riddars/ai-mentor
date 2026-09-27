import { getConfig } from "@/lib/config";
import { verifySignature } from "@/lib/github/verify";
import { CHECK_NAME, concludeCheckRun, createCheckRun } from "@/lib/github/checks";
import { handlePullRequest } from "@/lib/curator/simulate";
import { startCommitReview } from "@/lib/curator/review";
import {
  findProjectForRepository,
  forgetEvent,
  recordEventOnce,
  resolvePendingOnClose,
  saveReplyAndEnqueue,
  supersedeCommitJobs,
  upsertPullRequest,
} from "@/lib/curator/store";

export const runtime = "nodejs";

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

// Who counts as a project member on GitHub: only their PRs are reviewed and only their
// comments are taken as student replies. Repositories are public, so anyone else could
// otherwise dismiss findings or spend model requests.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export async function POST(req: Request) {
  const rawBody = await req.text();

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("[webhook] service not configured:", error);
    return new Response("Service not configured", { status: 500 });
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature, config.webhookSecret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");
  const payload = JSON.parse(rawBody);

  // Идемпотентность на входе: память ведёт только llm-ревьюер, поэтому и дедуп
  // доставок держим там же. Повторную доставку того же события молча пропускаем.
  const dedup = config.reviewer === "llm" && deliveryId ? deliveryId : null;
  if (dedup) {
    const isNew = recordEventOnce(dedup, event, payload.action ?? null);
    if (!isNew) {
      return Response.json({ ok: true, duplicate: true });
    }
  }
  // On a 500, forget the delivery so a manual redelivery is not treated as a duplicate.
  const failed = (message: string, error: unknown) => {
    console.error(`[webhook] ${message}:`, error);
    if (dedup) forgetEvent(dedup);
    return new Response("Handler error", { status: 500 });
  };

  const isPullRequest = event === "pull_request";
  const isComment = event === "issue_comment";
  const isRerun =
    event === "check_run" &&
    payload.action === "rerequested" &&
    payload.check_run?.name === CHECK_NAME;
  if (!isPullRequest && !isComment && !isRerun) {
    return Response.json({ ok: true });
  }

  // Ворота подключения: разбираются только проекты, подключённые в управлении.
  // Незнакомый репозиторий игнорируем целиком (без check-run — защита ветки для
  // него не настраивается). См. принятые решения.md.
  const owner: string | undefined = payload.repository?.owner?.login;
  const repo: string | undefined = payload.repository?.name;
  const repoId: number | null = payload.repository?.id ?? null;
  const project = owner && repo ? findProjectForRepository(repoId, owner, repo) : null;
  if (!project) {
    return Response.json({ ok: true, ignored: "not connected" });
  }

  if (isPullRequest && payload.action === "closed") {
    // Состояние PR нужно панели (слит / закрыт без слияния); разбора здесь нет. Второй
    // шаг закрытия замечаний: исправление окончательно только после слияния в основную ветку.
    const pr = payload.pull_request;
    const prId = upsertPullRequest(project.id, pr.number, {
      author: pr.user?.login ?? null,
      title: pr.title ?? null,
      state: pr.merged ? "merged" : "closed",
    });
    resolvePendingOnClose(
      prId,
      !pr.merged
        ? "closed"
        : pr.base?.ref === payload.repository?.default_branch
          ? "merged-default"
          : "merged-other",
    );
    // Closed without merge: its code never lands, a waiting review is pointless. A merged
    // PR keeps its queued review — the findings still matter.
    if (!pr.merged && payload.installation?.id !== undefined) {
      for (const checkRunId of supersedeCommitJobs(prId)) {
        await concludeCheckRun({
          owner: project.owner,
          repo: project.repo,
          installationId: payload.installation.id,
          checkRunId,
          conclusion: "success",
          output: { title: "AI Curator", summary: "Pull request закрыт без слияния — разбор не нужен." },
        }).catch((error) => console.error(`[webhook] failed to conclude check ${checkRunId}:`, error));
      }
    }
    return Response.json({ ok: true, closed: true });
  }

  const isReviewEvent = isPullRequest && REVIEW_ACTIONS.has(payload.action);
  if (isReviewEvent) {
    // opened / synchronize / reopened / ready_for_review all mean the PR is open — record
    // it in both reviewer modes so a reopened PR does not stay "closed" in memory.
    upsertPullRequest(project.id, payload.pull_request.number, {
      author: payload.pull_request.user?.login ?? null,
      title: payload.pull_request.title ?? null,
      state: "open",
      headSha: payload.pull_request.head?.sha ?? null,
    });
  }

  // Cases where the required check is concluded at once, without a review, so that it
  // does not block the merge: a paused project, a PR from outside the project, a draft.
  const skipReason =
    project.status === "paused"
      ? "Проект на паузе — разбор не выполняется."
      : isReviewEvent && !TRUSTED_ASSOCIATIONS.has(payload.pull_request.author_association)
        ? "Автор pull request не участник проекта — разбор не выполняется."
        : isReviewEvent && payload.pull_request.draft
          ? "Черновик — разбор после перевода в «готов к ревью»."
          : null;
  if (skipReason) {
    if (isReviewEvent && payload.installation?.id !== undefined) {
      try {
        const args = {
          owner: project.owner,
          repo: project.repo,
          installationId: payload.installation.id as number,
        };
        const checkRunId = await createCheckRun({ ...args, headSha: payload.pull_request.head.sha });
        await concludeCheckRun({
          ...args,
          checkRunId,
          conclusion: "success",
          output: { title: "AI Curator", summary: skipReason },
        });
      } catch (error) {
        return failed("failed to conclude skipped check", error);
      }
    }
    return Response.json({ ok: true, ignored: skipReason });
  }

  if (isReviewEvent) {
    try {
      await handlePullRequest(payload);
    } catch (error) {
      return failed("failed to handle pull_request", error);
    }
  } else if (
    isComment &&
    config.reviewer === "llm" &&
    payload.action === "created" &&
    payload.issue?.pull_request &&
    payload.sender?.type !== "Bot" &&
    TRUSTED_ASSOCIATIONS.has(payload.comment?.author_association) &&
    payload.installation?.id !== undefined
  ) {
    // Ответ студента без нового коммита: сохраняем сразу (повтор задачи его не потеряет),
    // сверку по объяснению выполнит очередь (без check-run).
    saveReplyAndEnqueue({
      prId: upsertPullRequest(project.id, payload.issue.number),
      commentId: payload.comment.id,
      login: payload.comment.user?.login ?? null,
      body: payload.comment.body ?? "",
      payload: {
        owner: project.owner,
        repo: project.repo,
        prNumber: payload.issue.number,
        installationId: payload.installation.id,
        commentId: payload.comment.id,
      },
    });
  } else if (isRerun && config.reviewer === "llm" && payload.installation?.id !== undefined) {
    // «Re-run» у проверки в GitHub — разобрать этот коммит заново.
    const prNumber: number | undefined = payload.check_run.pull_requests?.[0]?.number;
    if (prNumber !== undefined) {
      try {
        await startCommitReview(
          {
            owner: project.owner,
            repo: project.repo,
            prNumber,
            headSha: payload.check_run.head_sha,
            installationId: payload.installation.id,
          },
          "rerun",
        );
      } catch (error) {
        return failed("failed to rerun review", error);
      }
    }
  }

  return Response.json({ ok: true });
}
