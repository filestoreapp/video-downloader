import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { ExpenseEntry, ExpenseKind } from "./expenses";

/**
 * Ledger storage: an ENCRYPTED JSON file in the filestoreapp/images repo,
 * read and written through the GitHub Contents API with the repo-scoped
 * GITHUB_IMAGE_TOKEN (already in the service env, server-only).
 *
 * Why this shape:
 * - Keeps the tracker's data fully separate from the Supabase project that
 *   backs the PSC site (per the user's "use something else as database").
 * - The repo is public, so the file is AES-256-GCM encrypted with a key
 *   derived from EXPENSE_TOKEN (server-only). Browsing the repo reveals
 *   nothing but ciphertext.
 * - At this scale (two people, a few entries a day) a versioned JSON file
 *   is more than enough — and every change is audited as a commit.
 */

const GH_REPO = "filestoreapp/images";
const GH_PATH = "data/ledger.json";
const GH_BRANCH = "main";

function ledgerKey(): Buffer {
  const t = process.env.EXPENSE_TOKEN;
  if (!t) throw new Error("Missing EXPENSE_TOKEN env var");
  return createHash("sha256").update(t, "utf8").digest();
}

function encryptLedger(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ledgerKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptLedger(b64: string): string {
  const raw = Buffer.from(b64, "base64");
  if (raw.length < 28) throw new Error("Ledger file is corrupt");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    ledgerKey(),
    raw.subarray(0, 12)
  );
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

function ghToken(): string {
  const p = process.env.GITHUB_IMAGE_TOKEN;
  if (!p) throw new Error("Missing GITHUB_IMAGE_TOKEN env var");
  return p;
}

async function ghApi(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${ghToken()}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface LedgerFile {
  entries: ExpenseEntry[];
  sha: string | null;
}

async function readLedger(): Promise<LedgerFile> {
  const res = await ghApi(
    "GET",
    `/repos/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`
  );
  if (res.status === 404) return { entries: [], sha: null };
  if (!res.ok) throw new Error(`Ledger read failed (HTTP ${res.status})`);
  const data = await res.json();
  const stored = Buffer.from(data.content as string, "base64").toString("utf8");
  const entries = JSON.parse(decryptLedger(stored)) as ExpenseEntry[];
  if (!Array.isArray(entries)) throw new Error("Ledger file is corrupt");
  return { entries, sha: data.sha as string };
}

async function writeLedger(
  entries: ExpenseEntry[],
  sha: string | null
): Promise<void> {
  const stored = encryptLedger(JSON.stringify(entries));
  const content = Buffer.from(stored, "utf8").toString("base64");
  const payload: Record<string, unknown> = {
    message: "Update expense ledger",
    content,
    branch: GH_BRANCH,
  };
  if (sha) payload.sha = sha;
  const res = await ghApi(
    "PUT",
    `/repos/${GH_REPO}/contents/${GH_PATH}`,
    payload
  );
  // 409 (sha mismatch) or 422: someone else wrote concurrently
  if (res.status === 409 || res.status === 422)
    throw new Error("LEDGER_CONFLICT");
  if (!res.ok) throw new Error(`Ledger write failed (HTTP ${res.status})`);
}

/** Read-modify-write with one retry on conflicting concurrent writes. */
async function mutate(
  fn: (entries: ExpenseEntry[]) => ExpenseEntry[]
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { entries, sha } = await readLedger();
    try {
      await writeLedger(fn(entries), sha);
      return;
    } catch (err) {
      lastErr = err;
      if (
        err instanceof Error &&
        err.message === "LEDGER_CONFLICT" &&
        attempt === 0
      ) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function nextId(entries: ExpenseEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const n = Number(e.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listEntries(): Promise<ExpenseEntry[]> {
  const { entries } = await readLedger();
  return [...entries].sort((a, b) => {
    if (a.entry_date < b.entry_date) return 1;
    if (a.entry_date > b.entry_date) return -1;
    return Number(b.id) - Number(a.id);
  });
}

export interface NewEntry {
  kind: ExpenseKind;
  amount: number;
  her_share: number | null;
  note: string;
  entry_date: string;
}

export async function insertEntry(e: NewEntry): Promise<ExpenseEntry> {
  const entry: ExpenseEntry = {
    id: 0, // assigned inside mutate
    created_at: new Date().toISOString(),
    entry_date: e.entry_date || todayISO(),
    kind: e.kind,
    amount: e.amount,
    her_share: e.her_share,
    note: e.note,
  };
  await mutate((entries) => {
    entry.id = nextId(entries);
    return [...entries, entry];
  });
  return entry;
}

export async function deleteEntry(id: number): Promise<void> {
  await mutate((entries) =>
    entries.filter((e) => Number(e.id) !== Number(id))
  );
}
