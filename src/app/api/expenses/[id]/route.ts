import { NextResponse, type NextRequest } from "next/server";
import { getExpenseToken } from "@/lib/expenses";
import { deleteEntry } from "@/lib/sheet-db";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return req.headers.get("x-expense-token") === getExpenseToken();
}

/**
 * DELETE /api/expenses/[id] — soft delete (moves to the Deleted tab).
 * DELETE /api/expenses/[id]?permanent=1 — delete forever.
 */
export async function DELETE(
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
  const permanent = req.nextUrl.searchParams.get("permanent") === "1";
  try {
    await deleteEntry(entryId, permanent);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 }
    );
  }
}
