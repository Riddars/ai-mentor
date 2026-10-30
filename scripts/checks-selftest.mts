/** Local check-run ordering tests. No GitHub, model, keys or network. */
import { createCheckRunConcluder, type CheckConclusion } from "@/lib/github/checks";

const sent: CheckConclusion[] = [];
const conclude = createCheckRunConcluder(async ({ conclusion }) => {
  sent.push(conclusion);
});
const update = (checkRunId: number, conclusion: CheckConclusion) => ({
  owner: "test",
  repo: "test",
  installationId: 1,
  checkRunId,
  conclusion,
  output: { title: "test", summary: "test" },
});
function check(name: string, ok: boolean): void {
  if (!ok) throw new Error(name);
  console.log(`ok  ${name}`);
}

const early = conclude(update(1, "neutral"));
const reviewed = conclude(update(1, "success"));
check("deadline can precede a successful review", (await early) && (await reviewed) && sent.join() === "neutral,success");
check("late deadline cannot erase a review", !(await conclude(update(1, "neutral"))) && sent.join() === "neutral,success");

let fail = true;
const retry = createCheckRunConcluder(async () => {
  if (fail) throw new Error("temporary GitHub failure");
});
await retry(update(2, "neutral")).catch(() => {});
fail = false;
check("failed update can be retried", await retry(update(2, "neutral")));
