import type { ExpenseEntry, ExpenseKind } from "./expenses";

/**
 * Supabase access for the expense ledger, via raw REST (same pattern as
 * src/lib/worker/psc-scrape.ts). Server-only: uses the service-role key,
 * which bypasses RLS. The expense_ledger table has no anon policies, so
 * every read/write flows through here, behind the token check in the
 * /api/expenses routes.
 */

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function sbHeaders(): HeadersInit {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

function checkConfigured() {
  if (!SB_URL || !SB_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  }
}

const COLS = "id,created_at,entry_date,kind,amount,her_share,note";

export async function listEntries(): Promise<ExpenseEntry[]> {
  checkConfigured();
  const res = await fetch(
    `${SB_URL}/rest/v1/expense_ledger?select=${COLS}&order=entry_date.desc&order=id.desc&limit=500`,
    { headers: sbHeaders(), cache: "no-store" }
  );
  if (!res.ok) throw new Error(`Ledger read failed (HTTP ${res.status})`);
  return (await res.json()) as ExpenseEntry[];
}

export interface NewEntry {
  kind: ExpenseKind;
  amount: number;
  her_share: number | null;
  note: string;
  entry_date: string;
}

export async function insertEntry(e: NewEntry): Promise<ExpenseEntry> {
  checkConfigured();
  const res = await fetch(`${SB_URL}/rest/v1/expense_ledger?select=${COLS}`, {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify({
      kind: e.kind,
      amount: e.amount,
      her_share: e.her_share,
      note: e.note,
      entry_date: e.entry_date,
    }),
  });
  if (!res.ok) throw new Error(`Ledger write failed (HTTP ${res.status})`);
  const rows = (await res.json()) as ExpenseEntry[];
  return rows[0];
}

export async function deleteEntry(id: number): Promise<void> {
  checkConfigured();
  const res = await fetch(`${SB_URL}/rest/v1/expense_ledger?id=eq.${id}`, {
    method: "DELETE",
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`Ledger delete failed (HTTP ${res.status})`);
}
