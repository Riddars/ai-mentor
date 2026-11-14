import { rulesetJson } from "@/lib/github/setup";
import { getViewer } from "@/lib/users";

export const runtime = "nodejs";

/** Download only; importing the file in GitHub is an administrator's action. */
export async function GET() {
  if (!(await getViewer())) return new Response("Требуется вход.", { status: 401 });
  return new Response(rulesetJson(), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ai-curator-ruleset.json"',
      "Cache-Control": "no-store",
    },
  });
}
