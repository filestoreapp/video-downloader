import { NextResponse, type NextRequest } from "next/server";
import { getExpenseToken, EXPENSE_KINDS, summarize } from "@/lib/expenses";
import { listEntries, insertEntry } from "@/lib/expense-db";
import type { ExpenseKind } from "@/lib/expenses";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return req.headers.get("x-expense-token") === getExpenseToken();
}

/** GET /api/expenses — active entries + deleted entries + summary. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { active, deleted } = await listEntries();
    return NextResponse.json({
      entries: active,
      deleted,
      summary: summarize(active),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Read failed." },
      { status: 500 }
    );
  }
}

/** POST /api/expenses — add one entry. */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const kind = body?.kind as ExpenseKind | undefined;
  const amount = Number(body?.amount);
  const note = String(body?.note ?? "").slice(0, 200);
  const addedBy = String(body?.added_by ?? "")
    .trim()
    .slice(0, 50);
  const entryDate =
    typeof body?.entry_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.entry_date)
      ? body.entry_date
      : new Date().toISOString().slice(0, 10);

  if (!kind || !EXPENSE_KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid entry type." }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "Amount must be greater than zero." },
      { status: 400 }
    );
  }
  if (!addedBy) {
    return NextResponse.json(
      { error: "Enter your name." },
      { status: 400 }
    );
  }

  try {
    const entry = await insertEntry({
      kind,
      amount,
      note,
      entry_date: entryDate,
      added_by: addedBy,
    });
    return NextResponse.json({ entry });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Write failed." },
      { status: 500 }
    );
  }
}
