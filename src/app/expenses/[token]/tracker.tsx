"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EXPENSE_KINDS,
  KIND_HINTS,
  KIND_LABELS,
  formatDate,
  formatINR,
  summarize,
  type ExpenseEntry,
  type ExpenseKind,
  type ExpenseSummary,
} from "@/lib/expenses";
import styles from "./tracker.module.css";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export default function Tracker({
  token,
  friendName,
}: {
  token: string;
  friendName: string;
}) {
  const [entries, setEntries] = useState<ExpenseEntry[] | null>(null);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [kind, setKind] = useState<ExpenseKind>("her_expense");
  const [amount, setAmount] = useState("");
  const [herShare, setHerShare] = useState("");
  const [note, setNote] = useState("");
  const [entryDate, setEntryDate] = useState(todayISO());

  const headers = useCallback(
    () => ({ "x-expense-token": token, "content-type": "application/json" }),
    [token]
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/expenses", { headers: headers() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load entries.");
      const list = (json.entries ?? []) as ExpenseEntry[];
      setEntries(list);
      setSummary(json.summary ?? summarize(list));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load entries.");
    }
  }, [headers]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          kind,
          amount: amt,
          her_share: kind === "shared" ? Number(herShare) : null,
          note: note.trim(),
          entry_date: entryDate,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save.");
      setAmount("");
      setHerShare("");
      setNote("");
      setEntryDate(todayISO());
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this entry?")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/expenses/${id}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok) throw new Error("Could not delete.");
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not delete.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Expense Tracker</h1>
      <p className={styles.sub}>
        Shared with {friendName} — her balance and what she owes, always up to
        date.
      </p>

      <div className={styles.cards}>
        <div className={`${styles.card} ${styles.green}`}>
          <div className={styles.cardLabel}>💰 Her balance</div>
          <div className={styles.cardValue}>
            {summary ? formatINR(summary.her_balance) : "—"}
          </div>
          <div className={styles.cardHint}>money left</div>
        </div>
        <div className={`${styles.card} ${styles.amber}`}>
          <div className={styles.cardLabel}>🤝 She owes</div>
          <div className={styles.cardValue}>
            {summary ? formatINR(summary.she_owes) : "—"}
          </div>
          <div className={styles.cardHint}>to be repaid</div>
        </div>
      </div>

      <form onSubmit={submit} className={styles.panel}>
        <h2 className={styles.h2}>＋ Add entry</h2>
        <div className={styles.field}>
          <label className={styles.label}>Type</label>
          <select
            className={styles.input}
            value={kind}
            onChange={(e) => setKind(e.target.value as ExpenseKind)}
          >
            {EXPENSE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <p className={styles.hint}>{KIND_HINTS[kind]}</p>
        </div>
        <div className={styles.row2}>
          <div className={styles.field}>
            <label className={styles.label}>Amount (₹)</label>
            <input
              className={styles.input}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Date</label>
            <input
              className={styles.input}
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              required
            />
          </div>
        </div>
        {kind === "shared" && (
          <div className={styles.field}>
            <label className={styles.label}>Her share (₹)</label>
            <input
              className={styles.input}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={herShare}
              onChange={(e) => setHerShare(e.target.value)}
              placeholder="How much of it was hers"
              required
            />
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.label}>Note</label>
          <input
            className={styles.input}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was this for?"
            maxLength={200}
          />
        </div>
        <button type="submit" disabled={saving} className={styles.btn}>
          {saving ? "Saving…" : "Save entry"}
        </button>
      </form>

      <div className={styles.history}>
        <h2 className={styles.h2}>History</h2>
        {loadError && (
          <div className={styles.error}>
            {loadError} The database table may not be set up yet — run the
            setup SQL once in Supabase, then reload.
          </div>
        )}
        {entries !== null && entries.length === 0 && !loadError && (
          <p className={styles.sub}>
            No entries yet. Add her first top-up above to get started.
          </p>
        )}
        <ul className={styles.list}>
          {(entries ?? []).map((e) => (
            <li key={e.id} className={styles.item}>
              <div className={styles.itemMain}>
                <div className={styles.itemTitle}>
                  {e.note || KIND_LABELS[e.kind]}
                </div>
                <div className={styles.itemMeta}>
                  {KIND_LABELS[e.kind]}
                  {e.kind === "shared" && e.her_share != null
                    ? ` · her share ${formatINR(Number(e.her_share))}`
                    : ""}
                  {" · "}
                  {formatDate(e.entry_date)}
                </div>
              </div>
              <div className={styles.itemSide}>
                <span className={styles.itemAmt}>
                  {formatINR(Number(e.amount))}
                </span>
                <button
                  onClick={() => remove(e.id)}
                  disabled={deletingId === e.id}
                  aria-label="Delete entry"
                  className={styles.del}
                >
                  {deletingId === e.id ? "…" : "🗑"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
