import { NextResponse } from "next/server";
import { readStats, statsEnabled } from "@/lib/stats";

export const dynamic = "force-dynamic";

/** GET /api/dl/stats — total download counts for the tracker pill. */
export async function GET() {
  if (!statsEnabled()) {
    return NextResponse.json({ enabled: false });
  }
  const s = await readStats();
  if (!s) {
    return NextResponse.json({ enabled: false });
  }
  return NextResponse.json({ enabled: true, ...s });
}
