import { getRepoInstallationId } from "@/lib/github/auth";
import { withAgentRun } from "@/lib/agent/run";
import { overviewPrompt } from "@/lib/curator/prompts";
import { parseOverviewDraft } from "@/lib/curator/overview-draft";
import { verifyFindings } from "@/lib/curator/verify";
import { OVERVIEW_LIMITS } from "@/lib/curator/overview";
import { ExecutionBudget } from "@/lib/llm/execution";
const budget = new ExecutionBudget({ ...OVERVIEW_LIMITS, deadlineAt: Date.now() + OVERVIEW_LIMITS.timeoutMs });
const [owner, repo, headSha] = process.argv.slice(2);
if (!owner || !repo || !/^[a-f0-9]{40}$/.test(headSha ?? "")) throw new Error("Expected owner, repo and commit SHA");
const installationId = await getRepoInstallationId(owner, repo);
await withAgentRun({owner,repo,headSha,installationId}, {
  overview: true, changed: [], systemPrompt: overviewPrompt(), userPrompt: `Полный обзор ${owner}/${repo} на коммите ${headSha}. Предыдущих заметок и замечаний нет.`, limits: OVERVIEW_LIMITS, budget, reserveTokens: 40000,
}, async ({reply,provider,model}, root) => {
  if (reply.error) throw new Error(reply.error);
  const {parsed} = await parseOverviewDraft(reply.text, budget);
  if (!parsed?.notes) throw new Error("No valid overview with notes");
  const verified = await verifyFindings(parsed,root,undefined,budget);
  console.log(JSON.stringify({provider,model,headSha,partial: !!(reply.partialCopy || reply.partialReview),
    files:reply.viewed.length,steps:reply.steps,agentTokens:reply.tokensIn+reply.tokensOut,verification:verified.tokens,
    findings: verified.result.findings.length, summary:parsed.summary}));
});
