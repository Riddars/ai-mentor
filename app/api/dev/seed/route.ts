import { NextResponse } from "next/server";
import { seedDemo } from "@/lib/dev/seed";
import { getViewer } from "@/lib/users";

// Demo data loader for local testing. Open in development; elsewhere it needs
// ALLOW_DEV_SEED=1 *and* a signed-in head — it creates accounts with known
// passwords and rewrites every demo-org project.
async function allowed(): Promise<boolean> {
  if (process.env.NODE_ENV === "development") return true;
  if (process.env.ALLOW_DEV_SEED !== "1") return false;
  const viewer = await getViewer();
  return viewer?.role === "head";
}

export async function POST() {
  if (!(await allowed())) {
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  }
  const result = await seedDemo();
  return NextResponse.json(result);
}
