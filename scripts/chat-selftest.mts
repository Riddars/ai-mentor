import { emptyResponseMetadata } from "@/lib/llm/chat";

const metadata = emptyResponseMetadata("selectel", "test-model", {
  id: "response-123",
  choices: [{ message: { content: "   ", reasoning_content: "private reasoning" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
}, "gateway-456");
const output = JSON.stringify(metadata);
if (!output.includes('"contentLength":3') || !output.includes('"finishReason":"stop"') ||
    !output.includes('"gatewayRequestId":"gateway-456"') || !output.includes('"hasReasoningContent":true') ||
    output.includes("private reasoning")) throw new Error("Empty-response diagnostics contain wrong or private data");
console.log("chat diagnostics checks passed");
