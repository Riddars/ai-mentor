import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { databasePath, getConfig } from "@/lib/config";
import { workerStalled } from "@/lib/curator/worker";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STARTUP_GRACE_S = 60;
const MIN_FREE_BYTES = 1024 ** 3;

// Problem codes only: the endpoint is public, so error details go to the log.
type Problem = "config" | "db" | "worker_stalled" | "disk";

function check(code: Problem, probe: () => boolean, problems: Problem[]): void {
  try {
    if (probe()) return;
    console.warn(`[health] ${code}`);
  } catch (error) {
    console.warn(`[health] ${code}:`, error instanceof Error ? error.message : error);
  }
  problems.push(code);
}

export async function GET() {
  const problems: Problem[] = [];
  let reviewer: string | null = null;
  check(
    "config",
    () => {
      reviewer = getConfig().reviewer;
      return true;
    },
    problems,
  );
  // Reads the schema page, so a lost or unreadable file fails even with a cached handle.
  check(
    "db",
    () => getDb().prepare("SELECT count(*) FROM sqlite_master").get() !== undefined,
    problems,
  );
  if (reviewer === "llm" && process.uptime() >= STARTUP_GRACE_S) {
    check("worker_stalled", () => !workerStalled(), problems);
  }
  check(
    "disk",
    () => {
      const fs = statfsSync(
        dirname(resolve(/* turbopackIgnore: true */ process.cwd(), databasePath())),
      );
      return fs.bavail * fs.bsize >= MIN_FREE_BYTES;
    },
    problems,
  );

  if (problems.length) return Response.json({ status: "error", problems }, { status: 503 });
  return Response.json({ status: "ok" });
}
