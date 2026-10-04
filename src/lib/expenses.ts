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

export type ExpenseKind =
  | "topup" // her money handed over to hold
  | "her_expense" // spent from her money, on her
  | "shared" // he paid for both; her share becomes debt
  | "repayment" // she paid him back
  | "settle"; // debt cleared out of her balance

export const EXPENSE_KINDS: ExpenseKind[] = [
  "topup",
  "her_expense",
  "shared",
  "repayment",
  "settle",
];

export const KIND_LABELS: Record<ExpenseKind, string> = {
  topup: "Money added",
  her_expense: "Spent from her money",
  shared: "Shared expense (I paid)",
  repayment: "She repaid me",
  settle: "Settled from her balance",
};

export const KIND_HINTS: Record<ExpenseKind, string> = {
  topup: "She gave you money to hold for her.",
  her_expense: "You spent her money on something for her.",
  shared: "You paid for both of you — enter her share below.",
  repayment: "She paid you back (cash / UPI).",
  settle: "Clear what she owes using money from her balance.",
};

export interface ExpenseEntry {
  id: number;
  created_at: string;
  entry_date: string;
  kind: ExpenseKind;
  amount: number;
  her_share: number | null;
  note: string;
}

export interface ExpenseSummary {
  /** Money of hers currently held — "how much money left". */
  her_balance: number;
  /** What she owes him — "how much she owes to me". */
  she_owes: number;
}

export function summarize(entries: ExpenseEntry[]): ExpenseSummary {
  let her_balance = 0;
  let she_owes = 0;
  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    switch (e.kind) {
      case "topup":
        her_balance += amt;
        break;
      case "her_expense":
        her_balance -= amt;
        break;
      case "shared":
        she_owes += Number(e.her_share) || 0;
        break;
      case "repayment":
        she_owes -= amt;
        break;
      case "settle":
        her_balance -= amt;
        she_owes -= amt;
        break;
    }
  }
  return { her_balance, she_owes };
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
