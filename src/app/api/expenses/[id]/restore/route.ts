import { NextResponse, type NextRequest } from "next/server";
import { getExpenseToken } from "@/lib/expenses";
import { restoreEntry } from "@/lib/sheet-db";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return req.headers.get("x-expense-token") === getExpenseToken();
}

/** POST /api/expenses/[id]/restore — bring a deleted entry back. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const entryId = decodeURIComponent(id).trim();
  if (!entryId) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  try {
    await restoreEntry(entryId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed." },
      { status: 500 }
    );
  }
}
