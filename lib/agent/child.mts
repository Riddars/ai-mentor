// Agent process entry: unpacks the repository, runs the agent and reports back over IPC.
// Started by lib/agent/run.ts with an environment holding only the model key.

import { mkdir } from "node:fs/promises";
import { openAICompatibleModel, runAgent } from "@/lib/agent/agent.mjs";
import type { AgentProgress, AgentReply, AgentRequest } from "@/lib/agent/protocol";
import { repositorySection } from "@/lib/agent/prompt";
import { transcript } from "@/lib/agent/transcript.mjs";
import { extractTarball, listRepoFiles, relatedFiles, repoMap } from "@/lib/agent/workspace";

const controller = new AbortController();

async function handle(request: AgentRequest): Promise<AgentReply> {
  await mkdir(request.root, { recursive: true });
  const extracted = await extractTarball(request.tarPath, request.root);
  const files = await listRepoFiles(request.root);
  const related = await relatedFiles(request.root, request.changed, files);
  const { models, model } = openAICompatibleModel(request.model);
  const result = await runAgent({
    root: request.root,
    systemPrompt: request.systemPrompt,
    userPrompt: `${request.userPrompt}\n\n${repositorySection(repoMap(files, extracted), related)}`,
    models,
    model,
    limits: request.limits,
    signal: controller.signal,
    onUsage: (tokensIn, tokensOut) => {
      const progress: AgentProgress = { type: "progress", tokensIn, tokensOut };
      process.send?.(progress);
    },
  });
  return {
    type: "result",
    text: result.text,
    error: result.error,
    steps: result.steps,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    toolCalls: result.log.calls.length,
    viewed: [...result.log.viewed].sort(),
    skipped: extracted.skipped,
    partialCopy: extracted.stoppedOn,
    transcript: transcript("Ход работы агента", result.messages),
  };
}

function reply(message: AgentReply): void {
  process.send?.(message, () => process.exit(0));
}

// The service went away: nobody will read the result, so stop spending tokens.
process.on("disconnect", () => process.exit(1));

process.on("message", (message: AgentRequest | { type: "cancel" }) => {
  if (message.type === "cancel") {
    controller.abort();
    return;
  }
  handle(message).then(reply, (error: unknown) =>
    reply({
      type: "result",
      text: "",
      error: error instanceof Error ? error.message : String(error),
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      toolCalls: 0,
      viewed: [],
      skipped: [],
      partialCopy: null,
      transcript: "",
    }),
  );
});
