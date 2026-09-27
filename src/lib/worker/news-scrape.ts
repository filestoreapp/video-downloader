/**
 * Daily-digest news scraper. Pulls Malayalam headlines from the big Kerala
 * news portals (server-side with cheerio — no JS rendering needed, the
 * headline markup is in the static HTML). Returns a deduped list for the
 * digest cron agent to curate into the day's Malayalam digest post.
 */
import * as cheerio from "cheerio";

export interface NewsItem {
  source: string;
  title: string;
  url: string;
}

interface Source {
  name: string;
  url: string;
  base: string;
  type: "html" | "rss";
  /** Heading selector for html sources; the anchor is resolved from a child <a> or the closest parent <a>. */
  headingSelector?: string;
}

const SOURCES: Source[] = [
  { name: "Mathrubhumi", url: "https://www.mathrubhumi.com/", base: "https://www.mathrubhumi.com", type: "html", headingSelector: "h1, h2, h3" },
  { name: "Manorama", url: "https://www.manoramaonline.com/", base: "https://www.manoramaonline.com", type: "html", headingSelector: "h1, h2, h3" },
  { name: "TwentyFour", url: "https://www.twentyfournews.com/feed", base: "https://www.twentyfournews.com", type: "rss" },
  { name: "Reporter", url: "https://reporterlive.com/", base: "https://reporterlive.com", type: "html", headingSelector: "h1, h2, h3, h4, h5" },
  { name: "Asianet", url: "https://www.asianetnews.com/rss", base: "https://www.asianetnews.com", type: "rss" },
];

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function cleanTitle(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/** Normalize for dedupe: strip punctuation/case, collapse spaces. */
function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function scrapeHtmlSource(src: Source): Promise<NewsItem[]> {
  const res = await fetch(src.url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  // Headline text lives in headings; the link is either a child <a>
  // (h2 > a) or the wrapping parent <a> (a > h5).
  $(src.headingSelector || "h1, h2, h3").each((_, el) => {
    const h = $(el);
    const title = cleanTitle(h.text());
    let a = h.find("a").first();
    if (!a.length) a = h.closest("a");
    let href = (a.attr("href") || "").trim();
    if (title.length < 25 || title.length > 220) return;
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    if (href.startsWith("/")) href = src.base + href;
    if (!href.startsWith("http")) return;
    const key = normTitle(title);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ source: src.name, title, url: href });
  });
  return items.slice(0, 25);
}

async function scrapeRssSource(src: Source): Promise<NewsItem[]> {
  const res = await fetch(src.url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  $("item").each((_, el) => {
    const it = $(el);
    const title = cleanTitle(it.find("title").text());
    const href = cleanTitle(it.find("link").text());
    if (title.length < 25 || title.length > 220) return;
    if (!href.startsWith("http")) return;
    const key = normTitle(title);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ source: src.name, title, url: href });
  });
  return items.slice(0, 25);
}

async function scrapeSource(src: Source): Promise<NewsItem[]> {
  return src.type === "rss" ? scrapeRssSource(src) : scrapeHtmlSource(src);
}

export async function runNewsScrapeJob(): Promise<{
  items: NewsItem[];
  sources_ok: string[];
  sources_failed: { source: string; error: string }[];
}> {
  const items: NewsItem[] = [];
  const sources_ok: string[] = [];
  const sources_failed: { source: string; error: string }[] = [];
  const seen = new Set<string>();

  for (const src of SOURCES) {
    try {
      const found = await scrapeSource(src);
      let added = 0;
      for (const it of found) {
        const key = normTitle(it.title);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
        added++;
      }
      sources_ok.push(`${src.name} (${added} new)`);
    } catch (err) {
      sources_failed.push({
        source: src.name,
        error: err instanceof Error ? err.message : "scrape failed",
      });
    }
  }
  return { items, sources_ok, sources_failed };
}
