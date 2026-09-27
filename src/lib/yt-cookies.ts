import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Optional YouTube login cookies, supplied as the YT_COOKIES env var in
 * Netscape cookies.txt format (exported from a logged-in browser session).
 *
 * Why: YouTube intermittently serves a "Sign in to confirm you're not a bot"
 * wall to datacenter IPs. A real logged-in session bypasses it for both the
 * Innertube fast path (Cookie header) and the yt-dlp fallback (--cookies).
 *
 * Cookies expire (typically every few weeks/months) and then need
 * re-exporting. Nothing breaks when the var is absent — the site just works
 * without it until YouTube's bot check hits.
 */

const COOKIE_PATH = path.join(os.tmpdir(), "yt-cookies.txt");
let fileCache: { raw: string; path: string } | null = null;
let headerCache: { raw: string; header: string } | null = null;

function rawCookies(): string | null {
  const raw = (process.env.YT_COOKIES || "").trim();
  return raw ? raw : null;
}

/** Path to a cookies.txt file for yt-dlp's --cookies flag, or null. */
export function getYtCookieFile(): string | null {
  const raw = rawCookies();
  if (!raw) return null;
  if (fileCache?.raw !== raw) {
    fs.writeFileSync(COOKIE_PATH, raw + "\n", { mode: 0o600 });
    fileCache = { raw, path: COOKIE_PATH };
  }
  return fileCache.path;
}

/** Cookie header value for youtube.com requests, or null. */
export function getYtCookieHeader(): string | null {
  const raw = rawCookies();
  if (!raw) return null;
  if (headerCache?.raw !== raw) {
    const pairs: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split("\t");
      if (parts.length < 7) continue;
      const domain = parts[0].replace(/^#HttpOnly_/, "");
      if (
        domain.includes("youtube.com") ||
        domain.includes("youtu.be") ||
        domain.includes("googlevideo.com")
      ) {
        const name = parts[5]?.trim();
        const value = parts[6]?.trim();
        if (name) pairs.push(`${name}=${value ?? ""}`);
      }
    }
    headerCache = { raw, header: pairs.join("; ") };
  }
  return headerCache.header || null;
}

/** Extra argv to prepend to a yt-dlp invocation, or []. */
export function ytDlpCookieArgs(): string[] {
  const f = getYtCookieFile();
  return f ? ["--cookies", f] : [];
}

/** True when a YouTube session is configured on the server. */
export function hasYtCookies(): boolean {
  return rawCookies() !== null;
}
