/**
 * Kerala PSC scraper, ported from the current-affairs site's
 * src/lib/psc-scraper/ so the recurring scrape runs on this worker
 * instead of Vercel serverless (gov.in pages are slow and flaky —
 * serverless timeouts made the site-side cron unreliable).
 *
 * Job: scrape all sources -> dedupe by source_url against `psc_updates`
 * -> insert new rows -> Telegram announcement per new row ->
 * ask the site to revalidate /psc-updates.
 *
 * Env (injected by the caller): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, CA_SITE_URL,
 * CA_REVALIDATE_URL, CA_REVALIDATE_SECRET.
 */
import * as cheerio from "cheerio";

export interface ScrapeSummary {
  ranAt: string;
  results: { source: string; label: string; fetched: number; inserted: number; error: string | null }[];
  totalInserted: number;
  revalidated: boolean;
  pageViewsPruned: number | null;
}

interface Ctx {
  sbUrl: string;
  sbKey: string;
  tgToken: string;
  tgChannel: string;
  siteUrl: string;
  revalidateUrl: string;
  revalidateSecret: string;
}

// ---------------------------------------------------------------- sources

type PscSourceKey =
  | "notifications"
  | "examination_notification"
  | "syllabus"
  | "exam_programme"
  | "result_notifications"
  | "shortlists"
  | "rankedlist"
  | "interviews";

interface PscSource {
  key: PscSourceKey;
  label: string;
  url: string;
  layout: "table" | "link-list";
}

const PSC_SOURCES: PscSource[] = [
  { key: "notifications", label: "Notifications (Gazette)", url: "https://www.keralapsc.gov.in/notifications?tid=All&page=0", layout: "table" },
  { key: "examination_notification", label: "Examination Notifications", url: "https://www.keralapsc.gov.in/examination-notification?page=0", layout: "table" },
  { key: "syllabus", label: "Postwise Syllabus", url: "https://www.keralapsc.gov.in/syllabus1?page=0", layout: "table" },
  { key: "exam_programme", label: "Examination Programme", url: "https://www.keralapsc.gov.in/examinations?tid=All&page=0", layout: "link-list" },
  { key: "result_notifications", label: "Result Notifications", url: "https://www.keralapsc.gov.in/result-notifications?page=0", layout: "table" },
  { key: "shortlists", label: "Short Lists", url: "https://www.keralapsc.gov.in/shortlists?page=0", layout: "table" },
  { key: "rankedlist", label: "Ranked Lists", url: "https://www.keralapsc.gov.in/rankedlist?page=0", layout: "table" },
  { key: "interviews", label: "Interview Schedule", url: "https://www.keralapsc.gov.in/interviews?page=0", layout: "table" },
];

const SOURCE_LABELS: Record<PscSourceKey, string> = {
  notifications: "Notification",
  examination_notification: "Examination Notification",
  syllabus: "Syllabus",
  exam_programme: "Exam Programme",
  result_notifications: "Result Notification",
  shortlists: "Short List",
  rankedlist: "Ranked List",
  interviews: "Interview Schedule",
};

// ---------------------------------------------------------------- parsing

interface ScrapedItem {
  source: PscSourceKey;
  title: string;
  source_url: string;
  pdf_url: string | null;
  category_number: string | null;
  published_on: string | null;
}

const BASE_URL = "https://www.keralapsc.gov.in";

function absolutize(href: string): string {
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return href;
  }
}

function isPdfHref(href: string): boolean {
  return /\.pdf($|\?)/i.test(href);
}

function parseDdMmYyyy(text: string): string | null {
  const m = text.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function dateFromFileUrl(href: string): string | null {
  const m = href.match(/\/sites\/default\/files\/(\d{4})-(\d{2})\//);
  if (!m) return null;
  const [, yyyy, mm] = m;
  return `${yyyy}-${mm}-01`;
}

function parseTablePage(html: string, source: PscSourceKey): ScrapedItem[] {
  const $ = cheerio.load(html);
  const items: ScrapedItem[] = [];
  const seen = new Set<string>();

  $("table").each((_, table) => {
    const $table = $(table);
    $table.find("tbody tr, tr").each((__, tr) => {
      const $tr = $(tr);
      if ($tr.find("th").length > 0) return;

      const links = $tr
        .find("a[href]")
        .toArray()
        .map((a) => ({
          href: absolutize($(a).attr("href") || ""),
          text: $(a).text().trim(),
        }))
        .filter((l) => l.href);

      if (links.length === 0) return;

      const titleLink =
        links.find((l) => l.text.length > 0 && !isPdfHref(l.href)) ?? links[0];
      const pdfLink = links.find((l) => isPdfHref(l.href));

      const cellTexts = $tr
        .find("td")
        .toArray()
        .map((td) => $(td).text().trim())
        .filter(Boolean);

      const title = titleLink.text || cellTexts[0] || "";
      const sourceUrl = titleLink.href;
      if (!title || !sourceUrl || seen.has(sourceUrl)) return;
      seen.add(sourceUrl);

      let publishedOn: string | null = null;
      for (const text of [...cellTexts].reverse()) {
        publishedOn = parseDdMmYyyy(text);
        if (publishedOn) break;
      }
      if (!publishedOn && pdfLink) publishedOn = dateFromFileUrl(pdfLink.href);

      const categoryText = cellTexts.find(
        (t) => /CAT\.?\s*NO/i.test(t) && t !== title
      );

      items.push({
        source,
        title,
        source_url: sourceUrl,
        pdf_url: pdfLink ? pdfLink.href : isPdfHref(sourceUrl) ? sourceUrl : null,
        category_number: categoryText ?? null,
        published_on: publishedOn,
      });
    });
  });

  return items;
}

function parseLinkListPage(html: string, source: PscSourceKey): ScrapedItem[] {
  const $ = cheerio.load(html);
  const items: ScrapedItem[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, a) => {
    const href = absolutize($(a).attr("href") || "");
    if (!/\/sites\/default\/files\/\d{4}-\d{2}\//.test(href)) return;
    if (!isPdfHref(href)) return;
    if (seen.has(href)) return;
    seen.add(href);

    const title = $(a).text().trim() || $(a).attr("title")?.trim() || "";
    if (!title) return;

    items.push({
      source,
      title,
      source_url: href,
      pdf_url: href,
      category_number: null,
      published_on: dateFromFileUrl(href),
    });
  });

  return items;
}

// ---------------------------------------------------------------- supabase + telegram

function sbHeaders(ctx: Ctx): HeadersInit {
  return {
    apikey: ctx.sbKey,
    Authorization: `Bearer ${ctx.sbKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

const CHANNEL_FOOTER = `\n\n📢 Join our channel: https://t.me/Daily_CurrentAffairs_Malayalam`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function postPscUpdateToTelegram(
  ctx: Ctx,
  item: { id: string; source: PscSourceKey; title: string }
): Promise<boolean> {
  const label = SOURCE_LABELS[item.source] ?? item.source;
  const link = `${ctx.siteUrl}/psc-updates/${item.id}`;
  const text = `📢 <b>New ${esc(label)}</b>\n\n${esc(item.title)}\n\n🔗 ${link}${CHANNEL_FOOTER}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${ctx.tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ctx.tgChannel, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function revalidateSite(ctx: Ctx, paths: string[]): Promise<boolean> {
  if (!ctx.revalidateUrl || !ctx.revalidateSecret) return false;
  try {
    const res = await fetch(ctx.revalidateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: ctx.revalidateSecret, paths }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the job

async function fetchSourceHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.text();
}

export async function runPscScrapeJob(ctx: Ctx, dryRun: boolean): Promise<ScrapeSummary> {
  const results: ScrapeSummary["results"] = [];
  let totalInserted = 0;

  const scraped = await Promise.all(
    PSC_SOURCES.map(async (source) => {
      try {
        const html = await fetchSourceHtml(source.url);
        const items =
          source.layout === "table"
            ? parseTablePage(html, source.key)
            : parseLinkListPage(html, source.key);
        return { source, items, error: null as string | null };
      } catch (err) {
        return {
          source,
          items: [] as ScrapedItem[],
          error: err instanceof Error ? err.message : "Unknown scrape error",
        };
      }
    })
  );

  for (const { source, items, error } of scraped) {
    const fail = (err: string | null) =>
      results.push({
        source: source.key,
        label: source.label,
        fetched: items.length,
        inserted: 0,
        error: err,
      });
    if (error || items.length === 0) {
      fail(error);
      continue;
    }

    // Dedupe against what's already stored. Each value must be
    // percent-encoded: PostgREST parses the `in.(...)` list after the
    // query string is decoded, so a raw `&` or `,` inside a URL would
    // corrupt the filter and make existing rows look new.
    const inList = items
      .map((i) => encodeURIComponent(`"${i.source_url.replace(/"/g, "")}"`))
      .join(",");
    const sel = await fetch(
      `${ctx.sbUrl}/rest/v1/psc_updates?select=source_url&source_url=in.(${inList})`,
      { headers: { apikey: ctx.sbKey, Authorization: `Bearer ${ctx.sbKey}` } }
    );
    if (!sel.ok) {
      fail(`Supabase select failed (${sel.status})`);
      continue;
    }
    const existing = (await sel.json()) as { source_url: string }[];
    const existingUrls = new Set(existing.map((r) => r.source_url));
    const newItems = items.filter((i) => !existingUrls.has(i.source_url));

    if (newItems.length === 0) {
      fail(null);
      continue;
    }

    if (dryRun) {
      results.push({
        source: source.key,
        label: source.label,
        fetched: items.length,
        inserted: 0,
        error: `dry run — would insert ${newItems.length}`,
      });
      continue;
    }

    const ins = await fetch(`${ctx.sbUrl}/rest/v1/psc_updates`, {
      method: "POST",
      headers: sbHeaders(ctx),
      body: JSON.stringify(
        newItems.map((i) => ({
          source: i.source,
          title: i.title,
          source_url: i.source_url,
          pdf_url: i.pdf_url,
          category_number: i.category_number,
          published_on: i.published_on,
        }))
      ),
    });
    if (!ins.ok) {
      // 409 = unique conflict: the row appeared between our dedupe check
      // and the insert (or the check missed it). Treat as already-stored
      // and skip it rather than failing the whole source.
      if (ins.status === 409) {
        results.push({
          source: source.key,
          label: source.label,
          fetched: items.length,
          inserted: 0,
          error: "already stored (409 on insert, skipped)",
        });
        continue;
      }
      fail(`Supabase insert failed (${ins.status})`);
      continue;
    }
    const inserted = (await ins.json()) as { id: string; source: PscSourceKey; title: string }[];
    totalInserted += inserted.length;

    for (const row of inserted) {
      const ok = await postPscUpdateToTelegram(ctx, row);
      if (ok) {
        await fetch(`${ctx.sbUrl}/rest/v1/psc_updates?id=eq.${row.id}`, {
          method: "PATCH",
          headers: sbHeaders(ctx),
          body: JSON.stringify({ telegram_posted: true }),
        });
      }
    }

    results.push({
      source: source.key,
      label: source.label,
      fetched: items.length,
      inserted: inserted.length,
      error: null,
    });
  }

  let revalidated = false;
  if (!dryRun && totalInserted > 0) {
    revalidated = await revalidateSite(ctx, ["/psc-updates", "/", "/admin/psc-updates"]);
  }

  // Retention: page_views grows one row per visit — prune rows older
  // than 90 days so the table can't eat the free-tier database quota.
  // Best-effort: never fail the scrape if the RPC isn't installed yet.
  let pageViewsPruned: number | null = null;
  if (!dryRun) {
    try {
      const prune = await fetch(`${ctx.sbUrl}/rest/v1/rpc/prune_page_views`, {
        method: "POST",
        headers: sbHeaders(ctx),
        body: JSON.stringify({ retention_days: 90 }),
        signal: AbortSignal.timeout(30000),
      });
      if (prune.ok) pageViewsPruned = (await prune.json()) as number;
    } catch {
      pageViewsPruned = null;
    }
  }

  return { ranAt: new Date().toISOString(), results, totalInserted, revalidated, pageViewsPruned };
}
