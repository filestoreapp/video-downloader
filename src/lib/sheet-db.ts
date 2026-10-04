import type { ExpenseEntry, ExpenseKind } from "./expenses";

/**
 * Google Sheets as the database.
 *
 * Writes go through a Google Form's public submit endpoint
 * (POST https://docs.google.com/forms/d/e/<FORM_ID>/formResponse with
 * entry.<id> params) — no Google credentials needed anywhere.
 * Reads come straight from the linked sheet as CSV
 * (https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv).
 *
 * The sheet is an append-only event log: every change (add, delete,
 * restore, purge) is a new row, and the current state is rebuilt by
 * replaying the rows in order. Deletes are soft — nothing is lost.
 *
 * Setup (done once by the user):
 *  1. Google Form with 7 short-answer questions titled exactly:
 *     Action, Entry ID, Kind, Amount, Note, Date, Added By
 *  2. Form Responses -> Link to Sheets
 *  3. Form link-sharing on; Sheet shared "Anyone with the link" (Viewer)
 */

// ---- config: filled in at setup ----
const FORM_ID = "1FAIpQLSfPD1m20UULW7hHo3RkqHLblq_PBfEliZZQZP5bru79-HFO9g";
const SHEET_ID = "1LevD8HtHRNNcqnQAH2yloEvJEFjoMcMuFGdXeZAh8Qc";
const ENTRY_IDS: Record<string, string> = {
  action: "1557255400",
  entry_id: "1747758568",
  kind: "772866870",
  amount: "528912448",
  note: "2026923092",
  date: "1977102604",
  added_by: "2036824445",
};

interface SheetEvent {
  timestamp: string;
  action: string;
  entry_id: string;
  kind: string;
  amount: string;
  note: string;
  date: string;
  added_by: string;
}

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let val = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          val += '"';
          i++;
        } else q = false;
      } else val += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") {
        row.push(val);
        val = "";
      } else if (c === "\n") {
        row.push(val);
        rows.push(row);
        row = [];
        val = "";
      } else if (c === "\r") {
        /* skip */
      } else val += c;
    }
  }
  if (val !== "" || row.length) {
    row.push(val);
    rows.push(row);
  }
  return rows;
}

async function readEvents(): Promise<SheetEvent[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet read failed (HTTP ${res.status})`);
  const rows = parseCSV(await res.text());
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const ix = head.findIndex((h) => h === name);
    if (ix < 0) throw new Error(`Sheet is missing the "${name}" column.`);
    return ix;
  };
  const iTs = col("timestamp");
  const iAction = col("action");
  const iEntryId = col("entry id");
  const iKind = col("kind");
  const iAmount = col("amount");
  const iNote = col("note");
  const iDate = col("date");
  const iAddedBy = col("added by");
  const events: SheetEvent[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => (c || "").trim() === "")) continue;
    const get = (ix: number) => (row[ix] ?? "").trim();
    events.push({
      timestamp: get(iTs),
      action: get(iAction),
      entry_id: get(iEntryId),
      kind: get(iKind),
      amount: get(iAmount),
      note: get(iNote),
      date: get(iDate),
      added_by: get(iAddedBy),
    });
  }
  return events;
}

async function appendEvent(ev: {
  action: string;
  entry_id: string;
  kind?: string;
  amount?: string;
  note?: string;
  date?: string;
  added_by?: string;
}): Promise<void> {
  const params = new URLSearchParams();
  const put = (field: string, value: string) => {
    params.set(`entry.${ENTRY_IDS[field]}`, value);
  };
  put("action", ev.action);
  put("entry_id", ev.entry_id);
  put("kind", ev.kind ?? "");
  put("amount", ev.amount ?? "");
  put("note", ev.note ?? "");
  put("date", ev.date ?? "");
  put("added_by", ev.added_by ?? "");
  const res = await fetch(
    `https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );
  if (!res.ok) throw new Error(`Form submit failed (HTTP ${res.status})`);
}

/** Wait briefly for a newly-written event to show up in sheet reads. */
async function waitForEvent(entryId: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const events = await readEvents();
      if (events.some((e) => e.entry_id === entryId)) return;
    } catch {
      /* keep waiting */
    }
  }
}

function byDateDesc(a: ExpenseEntry, b: ExpenseEntry): number {
  if (a.entry_date < b.entry_date) return 1;
  if (a.entry_date > b.entry_date) return -1;
  return a.created_at < b.created_at ? 1 : -1;
}

export async function listEntries(): Promise<{
  active: ExpenseEntry[];
  deleted: ExpenseEntry[];
}> {
  const events = await readEvents();
  const map = new Map<string, ExpenseEntry>();
  for (const ev of events) {
    const action = ev.action.trim().toLowerCase();
    if (action === "add" && ev.entry_id) {
      map.set(ev.entry_id, {
        id: ev.entry_id,
        created_at: ev.timestamp,
        entry_date: ev.date,
        kind: ev.kind.trim().toLowerCase() === "received" ? "received" : "spent",
        amount: parseFloat(ev.amount) || 0,
        note: ev.note,
        added_by: ev.added_by,
        deleted: false,
        deleted_at: null,
      });
    } else if (action === "delete") {
      const e = map.get(ev.entry_id);
      if (e) {
        e.deleted = true;
        e.deleted_at = ev.timestamp;
      }
    } else if (action === "restore") {
      const e = map.get(ev.entry_id);
      if (e) {
        e.deleted = false;
        e.deleted_at = null;
      }
    } else if (action === "purge") {
      map.delete(ev.entry_id);
    }
  }
  const all = [...map.values()];
  return {
    active: all.filter((e) => !e.deleted).sort(byDateDesc),
    deleted: all.filter((e) => e.deleted).sort(byDateDesc),
  };
}

function newId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface NewEntry {
  kind: ExpenseKind;
  amount: number;
  note: string;
  entry_date: string;
  added_by: string;
}

export async function insertEntry(e: NewEntry): Promise<ExpenseEntry> {
  const id = newId();
  const entry: ExpenseEntry = {
    id,
    created_at: new Date().toISOString(),
    entry_date: e.entry_date || todayISO(),
    kind: e.kind,
    amount: e.amount,
    note: e.note,
    added_by: e.added_by,
    deleted: false,
    deleted_at: null,
  };
  await appendEvent({
    action: "add",
    entry_id: id,
    kind: e.kind,
    amount: String(e.amount),
    note: e.note,
    date: entry.entry_date,
    added_by: e.added_by,
  });
  await waitForEvent(id);
  return entry;
}

/** Soft delete by default; permanent=true purges the entry for good. */
export async function deleteEntry(id: string, permanent = false): Promise<void> {
  if (!id) throw new Error("Invalid id.");
  await appendEvent({
    action: permanent ? "purge" : "delete",
    entry_id: id,
  });
  await waitForEvent(id);
}

export async function restoreEntry(id: string): Promise<void> {
  if (!id) throw new Error("Invalid id.");
  await appendEvent({ action: "restore", entry_id: id });
  await waitForEvent(id);
}
