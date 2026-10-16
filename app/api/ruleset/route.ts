import { getConfig } from "@/lib/config";
import { rulesetJson } from "@/lib/github/setup";
import { getViewer } from "@/lib/users";

export const runtime = "nodejs";

/** The main-branch ruleset of a project repository, to import in GitHub. */
export async function GET() {
  if (!(await getViewer())) return new Response("Требуется вход.", { status: 401 });
  return new Response(rulesetJson(getConfig().appId), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ai-curator-ruleset.json"',
    },
  });
}
