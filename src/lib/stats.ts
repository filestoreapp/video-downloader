/**
 * Download counter backed by Supabase (durable across deploys and sleeps).
 *
 * Table + RPC function are created by running supabase/snapdown-stats.sql
 * in the Supabase dashboard once. The anon key is enough: RLS lets anon
 * SELECT the single row, and the `snapdown_bump` SECURITY DEFINER function
 * performs the atomic increment.
 *
 * If SUPABASE_URL / SUPABASE_ANON_KEY are not set, every function here is a
 * silent no-op — the tracker UI hides itself and downloads are unaffected.
 */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

export interface DlStats {
  total: number;
  video: number;
  mp3: number;
  clip: number;
}

export function statsEnabled(): boolean {
  return !!SB_URL && !!SB_KEY;
}

function headers(): HeadersInit {
  return {
    apikey: SB_KEY as string,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
}

/** Fire-and-forget: record one completed download. Never throws. */
export function recordDownload(kind: "video" | "mp3" | "clip"): void {
  if (!statsEnabled()) return;
  // Don't await — the download response must not wait on the counter.
  void fetch(`${SB_URL}/rest/v1/rpc/snapdown_bump`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ kind }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {
    /* counter failures must never break a download */
  });
}

/** Read the current totals. Returns null when disabled or unreachable. */
export async function readStats(): Promise<DlStats | null> {
  if (!statsEnabled()) return null;
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/snapdown_stats?id=eq.1&select=total,video,mp3,clip`,
      { headers: headers(), signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as DlStats[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
