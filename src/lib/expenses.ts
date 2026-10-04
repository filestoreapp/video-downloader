/**
 * Private expense tracker shared between two people.
 *
 * Access is gated by EXPENSE_TOKEN (env var, never in the repo):
 * the page lives at /expenses/<token> and every /api/expenses call must
 * carry the same token in the x-expense-token header. The URL is unlisted
 * (no nav links, noindex) — treat the link itself as the password.
 */

export function getExpenseToken(): string {
  const t = process.env.EXPENSE_TOKEN;
  if (!t) throw new Error("EXPENSE_TOKEN is not set");
  return t;
}

export function getFriendName(): string {
  return process.env.FRIEND_NAME || "Friend";
}

export type ExpenseKind = "received" | "spent";

export const EXPENSE_KINDS: ExpenseKind[] = ["received", "spent"];

export const KIND_LABELS: Record<ExpenseKind, string> = {
  received: "Money received",
  spent: "Money spent",
};

export interface ExpenseEntry {
  id: number;
  created_at: string;
  entry_date: string;
  kind: ExpenseKind;
  amount: number;
  note: string;
  /** Name of the person who added the entry. */
  added_by: string;
  /** Soft delete — deleted entries live in the Deleted tab. */
  deleted: boolean;
  deleted_at: string | null;
}

export interface ExpenseSummary {
  /** received minus spent */
  balance: number;
  total_received: number;
  total_spent: number;
}

export function summarize(entries: ExpenseEntry[]): ExpenseSummary {
  let total_received = 0;
  let total_spent = 0;
  for (const e of entries) {
    if (e.deleted) continue;
    const amt = Number(e.amount) || 0;
    if (e.kind === "received") total_received += amt;
    else if (e.kind === "spent") total_spent += amt;
  }
  return {
    balance: total_received - total_spent,
    total_received,
    total_spent,
  };
}

export function formatINR(n: number): string {
  const v = Number(n) || 0;
  return (
    "₹" +
    v.toLocaleString("en-IN", {
      maximumFractionDigits: 2,
      minimumFractionDigits: v % 1 === 0 ? 0 : 2,
    })
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
