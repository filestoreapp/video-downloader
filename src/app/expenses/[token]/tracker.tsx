"use client";

import { useCallback, useEffect, useState } from "react";
import {
  KIND_LABELS,
  formatDate,
  formatINR,
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

const KIND_OPTIONS: { value: ExpenseKind; label: string }[] = [
  { value: "received", label: "Money received" },
  { value: "spent", label: "Money spent" },
];

const PAGE_SIZE = 10;

function pageNumbers(cur: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set(
    [1, 2, cur - 1, cur, cur + 1, total - 1, total].filter(
      (n) => n >= 1 && n <= total
    )
  );
  const arr = [...keep].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  arr.forEach((n, i) => {
    if (i > 0 && n - (arr[i - 1] as number) > 1) out.push("…");
    out.push(n);
  });
  return out;
}

export default function Tracker({
  token,
  friendName,
}: {
  token: string;
  friendName: string;
}) {
  const [entries, setEntries] = useState<ExpenseEntry[]>([]);
  const [deleted, setDeleted] = useState<ExpenseEntry[]>([]);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [tab, setTab] = useState<"entries" | "deleted">("entries");
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [kind, setKind] = useState<ExpenseKind>("spent");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [entryDate, setEntryDate] = useState(todayISO());
  const [name, setName] = useState("");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("expense_name");
      if (saved) setName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const headers = useCallback(
    () => ({ "x-expense-token": token, "content-type": "application/json" }),
    [token]
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/expenses", { headers: headers() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load entries.");
      setEntries((json.entries ?? []) as ExpenseEntry[]);
      setDeleted((json.deleted ?? []) as ExpenseEntry[]);
      setSummary((json.summary ?? null) as ExpenseSummary | null);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load entries."
      );
    }
  }, [headers]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      alert("Please enter your name.");
      return;
    }
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
          note: note.trim(),
          entry_date: entryDate,
          added_by: trimmedName,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save.");
      try {
        window.localStorage.setItem("expense_name", trimmedName);
      } catch {
        /* ignore */
      }
      setAmount("");
      setNote("");
      setEntryDate(todayISO());
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const softDelete = async (id: string) => {
    if (!confirm("Delete this entry? It will move to the Deleted tab.")) return;
    setBusyId(id);
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
      setBusyId(null);
    }
  };

  const restore = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/expenses/${id}/restore`, {
        method: "POST",
        headers: headers(),
      });
      if (!res.ok) throw new Error("Could not restore.");
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not restore.");
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (id: string) => {
    if (!confirm("Delete this entry forever? This cannot be undone.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/expenses/${id}?permanent=1`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok) throw new Error("Could not delete.");
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not delete.");
    } finally {
      setBusyId(null);
    }
  };

  const showing = tab === "entries" ? entries : deleted;
  const totalPages = Math.max(1, Math.ceil(showing.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = showing.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  const switchTab = (t: "entries" | "deleted") => {
    setTab(t);
    setPage(1);
  };

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Expense Tracker</h1>
      <p className={styles.sub}>Shared with {friendName}.</p>

      <div className={`${styles.card} ${styles.balanceCard}`}>
        <div className={styles.cardLabel}>Balance amt</div>
        <div className={styles.balanceValue}>
          {summary ? formatINR(summary.balance) : "—"}
        </div>
      </div>

      <div className={styles.cards}>
        <div className={`${styles.card} ${styles.red}`}>
          <div className={styles.cardLabel}>Total spent</div>
          <div className={styles.cardValue}>
            {summary ? formatINR(summary.total_spent) : "—"}
          </div>
        </div>
        <div className={`${styles.card} ${styles.green}`}>
          <div className={styles.cardLabel}>Total received</div>
          <div className={styles.cardValue}>
            {summary ? formatINR(summary.total_received) : "—"}
          </div>
        </div>
      </div>

      <div className={styles.tabs}>
        <button
          type="button"
          className={tab === "entries" ? styles.tabActive : styles.tab}
          onClick={() => switchTab("entries")}
        >
          Entries ({entries.length})
        </button>
        <button
          type="button"
          className={tab === "deleted" ? styles.tabActive : styles.tab}
          onClick={() => switchTab("deleted")}
        >
          Deleted ({deleted.length})
        </button>
      </div>

      {loadError && <div className={styles.error}>{loadError}</div>}

      {showing.length === 0 && !loadError && (
        <p className={styles.sub}>
          {tab === "entries"
            ? "No entries yet. Add the first one below."
            : "No deleted entries."}
        </p>
      )}

      <ul className={styles.list}>
        {pageItems.map((e) => (
          <li key={e.id} className={styles.item}>
            <div className={styles.itemMain}>
              <div className={styles.itemTitle}>
                {e.note || KIND_LABELS[e.kind] || "Entry"}
              </div>
              <div className={styles.itemMeta}>
                {KIND_LABELS[e.kind] || e.kind}
                {" · "}
                {formatDate(e.entry_date)}
                {" · Added by "}
                {e.added_by || "—"}
              </div>
            </div>
            <div className={styles.itemSide}>
              <span
                className={
                  e.kind === "received" ? styles.amtIn : styles.amtOut
                }
              >
                {e.kind === "received" ? "+" : "−"}
                {formatINR(Number(e.amount))}
              </span>
              {tab === "entries" ? (
                <button
                  onClick={() => softDelete(e.id)}
                  disabled={busyId === e.id}
                  aria-label="Delete entry"
                  className={styles.del}
                >
                  {busyId === e.id ? "…" : "🗑"}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => restore(e.id)}
                    disabled={busyId === e.id}
                    className={styles.restore}
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => purge(e.id)}
                    disabled={busyId === e.id}
                    aria-label="Delete forever"
                    className={styles.del}
                  >
                    {busyId === e.id ? "…" : "🗑"}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.pageBtn}
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
            aria-label="Previous page"
          >
            ‹ Prev
          </button>
          {pageNumbers(safePage, totalPages).map((n, i) =>
            n === "…" ? (
              <span key={`e${i}`} className={styles.pageEllipsis}>
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                className={
                  n === safePage ? styles.pageBtnActive : styles.pageBtn
                }
                onClick={() => setPage(n)}
              >
                {n}
              </button>
            )
          )}
          <button
            type="button"
            className={styles.pageBtn}
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
            aria-label="Next page"
          >
            Next ›
          </button>
        </div>
      )}

      <form onSubmit={submit} className={styles.panel}>
        <h2 className={styles.h2}>＋ Add entry</h2>
        <div className={styles.seg}>
          {KIND_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setKind(o.value)}
              className={`${styles.segBtn} ${
                kind === o.value ? styles.segActive : ""
              } ${o.value === "received" ? styles.segIn : styles.segOut}`}
            >
              {o.label}
            </button>
          ))}
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
        <div className={styles.field}>
          <label className={styles.label}>Your name</label>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Who is adding this?"
            maxLength={50}
            required
          />
        </div>
        <button type="submit" disabled={saving} className={styles.btn}>
          {saving ? "Saving…" : "Save entry"}
        </button>
      </form>
    </div>
  );
}
