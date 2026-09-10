import { NextResponse } from "next/server";
import { seedDemo } from "@/lib/dev/seed";

// Demo data loader for local testing. Disabled unless explicitly allowed.
function allowed(): boolean {
  return process.env.ALLOW_DEV_SEED === "1" || process.env.NODE_ENV === "development";
}

export async function POST() {
  if (!allowed()) {
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  }
  const result = await seedDemo();
  return NextResponse.json(result);
}
