// Runs once when a Next.js server instance starts: starts the review queue worker.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startWorker } = await import("@/lib/curator/worker");
  startWorker();
}
