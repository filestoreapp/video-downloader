import { NextResponse } from "next/server";
import { runPscScrapeJob } from "@/lib/worker/psc-scrape";

/**
 * Backend worker for the current-affairs site, hosted on this Koyeb service.
 *
 * POST /api/worker
 *   Authorization: Bearer <WORKER_SECRET>
 *   { "job": "publish-due-posts" | "publish-quiz" | "psc-scrape",
 *     "slug"?: string, "dry_run"?: boolean }
 *
 * Jobs replicate the site's own backend flows server-side (Supabase
 * service-role key bypasses RLS), so scheduled work no longer depends on
 * browser automation or Vercel serverless timeouts:
 *   - publish-due-posts: flip every due `scheduled` post to `published`
 *     (the daily district series) + Telegram announcement each.
 *   - publish-quiz: flip one draft quiz (mock test) to `published` by slug
 *     + Telegram announcement.
 *   - psc-scrape: scrape keralapsc.gov.in listings, insert new PSC
 *     updates, announce each on Telegram.
 * After each job the worker asks the site to revalidate the affected
 * paths (its public pages are ISR-cached for 5 minutes).
 *
 * POST /api/worker/image (multipart: file, path, upsert)
 *   Image pipeline for the site's admin uploads: sharp WebP compression
 *   + upload to the GitHub images repo -> jsDelivr CDN URL. Keeps Vercel
 *   free of sharp and the GitHub API round-trip.
 *
 * Env (all server-side, never exposed):
 *   WORKER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID (default @Daily_CurrentAffairs_Malayalam),
 *   CA_SITE_URL, CA_REVALIDATE_URL, CA_REVALIDATE_SECRET,
 *   GITHUB_IMAGE_TOKEN (for /api/worker/image)
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WORKER_SECRET = process.env.WORKER_SECRET || "";
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHANNEL =
  process.env.TELEGRAM_CHANNEL_ID || "@Daily_CurrentAffairs_Malayalam";
const SITE_URL = (
  process.env.CA_SITE_URL || "https://currentaffairsweb.vercel.app"
).replace(/\/+$/, "");
const REVALIDATE_URL = process.env.CA_REVALIDATE_URL || "";
const REVALIDATE_SECRET = process.env.CA_REVALIDATE_SECRET || "";

const CHANNEL_LINK = "https://t.me/Daily_CurrentAffairs_Malayalam";
const CHANNEL_FOOTER = `\n\n📢 Join our channel: ${CHANNEL_LINK}`;

/** Escape text for Telegram's HTML parse mode (same as the site's esc()). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function authed(req: Request): boolean {
  if (!WORKER_SECRET) return false;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${WORKER_SECRET}`;
}

function sbHeaders(): HeadersInit {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

/** Supabase PostgREST call with the service-role key (bypasses RLS). */
async function sb(
  path: string,
  method: "GET" | "PATCH" = "GET",
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${SB_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: sbHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

async function tgSend(
  endpoint: "sendMessage" | "sendPhoto",
  payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHANNEL, parse_mode: "HTML", ...payload }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: t.slice(0, 300) };
  }
  return { ok: true };
}

/** Announce a published blog post — byte-identical format to the site's postToTelegram. */
async function announcePost(post: {
  title: string;
  slug: string;
  excerpt: string | null;
  cover_image: string | null;
}) {
  const link = `${SITE_URL}/current-affairs/${post.slug}`;
  const caption =
    `📢 <b>${esc(post.title)}</b>\n\n${esc(post.excerpt ?? "")}\n\n🔗 ${link}${CHANNEL_FOOTER}`;
  if (post.cover_image) {
    return tgSend("sendPhoto", { photo: post.cover_image, caption });
  }
  return tgSend("sendMessage", { text: caption });
}

/** Announce a published mock test — byte-identical format to the site's postMockToTelegram. */
async function announceMock(mock: {
  title: string;
  slug: string;
  description: string | null;
  questionCount: number;
  durationMinutes: number | null;
  negativeMarking: number;
}) {
  const link = `${SITE_URL}/mock-tests/${mock.slug}`;
  const marking =
    mock.negativeMarking > 0
      ? `+1 for correct, −${mock.negativeMarking} for wrong`
      : "+1 for correct, no negative marking";
  const text =
    `📝 <b>New Mock Test: ${esc(mock.title)}</b>\n\n` +
    `${mock.description ? `${esc(mock.description)}\n\n` : ""}` +
    `❓ ${mock.questionCount} questions` +
    `${mock.durationMinutes ? ` · ⏱ ${mock.durationMinutes} minutes` : ""}\n` +
    `📊 ${marking}\n\n` +
    `Take it free and see your rank 👇\n🔗 ${link}${CHANNEL_FOOTER}`;
  return tgSend("sendMessage", { text });
}

/** Ask the site to revalidate ISR paths so flipped content is live instantly. */
async function revalidate(paths: string[]): Promise<boolean> {
  if (!REVALIDATE_URL || !REVALIDATE_SECRET) return false;
  try {
    const res = await fetch(REVALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: REVALIDATE_SECRET, paths }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface DuePost {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  cover_image: string | null;
}

async function jobPublishDuePosts(dryRun: boolean) {
  const now = new Date().toISOString();
  const q = new URLSearchParams({
    select: "id,title,slug,excerpt,cover_image",
    status: "eq.scheduled",
    published_at: `lte.${now}`,
    order: "published_at.asc",
  });
  const found = await sb(`posts?${q}`);
  if (!found.ok) throw new Error(`Supabase read failed (${found.status})`);
  const posts = found.data as DuePost[];
  const published: string[] = [];
  for (const p of posts) {
    if (!dryRun) {
      const upd = await sb(`posts?id=eq.${p.id}`, "PATCH", { status: "published" });
      if (!upd.ok) throw new Error(`Flip failed for ${p.slug} (${upd.status})`);
      const tg = await announcePost(p);
      published.push(`${p.slug}${tg.ok ? "" : " (telegram FAILED)"}`);
    } else {
      published.push(`${p.slug} (dry run)`);
    }
  }
  let revalidated = false;
  if (!dryRun && posts.length) {
    revalidated = await revalidate([
      ...posts.map((p) => `/current-affairs/${p.slug}`),
      "/current-affairs",
    ]);
  }
  return { due: posts.length, published, revalidated };
}

interface QuizRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  time_limit_seconds: number | null;
  negative_marking: number;
  is_mock: boolean;
  status: string;
}

async function jobPublishQuiz(slug: string, dryRun: boolean) {
  const q = new URLSearchParams({
    select: "id,title,slug,description,time_limit_seconds,negative_marking,is_mock,status",
    slug: `eq.${slug}`,
  });
  const found = await sb(`quizzes?${q}`);
  if (!found.ok) throw new Error(`Supabase read failed (${found.status})`);
  const rows = found.data as QuizRow[];
  const quiz = rows[0];
  if (!quiz) throw new Error(`No quiz found with slug "${slug}"`);
  if (quiz.status === "published") {
    return { slug, already: true as const, published: [] as string[] };
  }
  if (quiz.status !== "draft") {
    throw new Error(`Quiz "${slug}" has status "${quiz.status}", not draft`);
  }
  const qc = await sb(
    `quiz_questions?${new URLSearchParams({ select: "id", quiz_id: `eq.${quiz.id}` })}`
  );
  const questionCount = Array.isArray(qc.data) ? qc.data.length : 0;
  const published: string[] = [];
  if (!dryRun) {
    const upd = await sb(`quizzes?id=eq.${quiz.id}`, "PATCH", { status: "published" });
    if (!upd.ok) throw new Error(`Flip failed for ${slug} (${upd.status})`);
    let tgNote = "";
    if (quiz.is_mock) {
      const tg = await announceMock({
        title: quiz.title,
        slug: quiz.slug,
        description: quiz.description,
        questionCount,
        durationMinutes:
          quiz.time_limit_seconds != null
            ? Math.round(quiz.time_limit_seconds / 60)
            : null,
        negativeMarking: quiz.negative_marking || 0,
      });
      if (!tg.ok) tgNote = " (telegram FAILED)";
    }
    published.push(`${slug}${tgNote}`);
  } else {
    published.push(`${slug} (dry run, ${questionCount} questions)`);
  }
  let revalidated = false;
  if (!dryRun) {
    revalidated = await revalidate([`/mock-tests/${slug}`, "/mock-tests"]);
  }
  return { slug, already: false as const, published, revalidated, questionCount };
}

export async function POST(req: Request) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: "Worker not configured (Supabase)." }, { status: 503 });
  }
  let body: { job?: unknown; slug?: unknown; dry_run?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const job = String(body.job || "");
  const dryRun = body.dry_run === true;

  try {
    if (job === "publish-due-posts") {
      const r = await jobPublishDuePosts(dryRun);
      return NextResponse.json({ ok: true, job, dry_run: dryRun, ...r });
    }
    if (job === "publish-quiz") {
      const slug = String(body.slug || "").trim();
      if (!slug) return NextResponse.json({ error: "slug required." }, { status: 400 });
      const r = await jobPublishQuiz(slug, dryRun);
      return NextResponse.json({ ok: true, job, dry_run: dryRun, ...r });
    }
    if (job === "psc-scrape") {
      if (!TG_TOKEN) {
        return NextResponse.json({ error: "Worker not configured (Telegram)." }, { status: 503 });
      }
      const r = await runPscScrapeJob(
        {
          sbUrl: SB_URL,
          sbKey: SB_KEY,
          tgToken: TG_TOKEN,
          tgChannel: TG_CHANNEL,
          siteUrl: SITE_URL,
          revalidateUrl: REVALIDATE_URL,
          revalidateSecret: REVALIDATE_SECRET,
        },
        dryRun
      );
      return NextResponse.json({ ok: true, job, dry_run: dryRun, ...r });
    }
    return NextResponse.json(
      { error: "Unknown job. Use publish-due-posts, publish-quiz, or psc-scrape." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Worker job failed." },
      { status: 500 }
    );
  }
}
