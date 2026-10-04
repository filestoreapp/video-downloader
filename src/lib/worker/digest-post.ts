/**
 * Daily-digest post jobs for the current-affairs site.
 *
 * Flow (approval-gated, per the site owner's rule):
 *   1. cron agent calls `news-scrape`, curates the headlines into a Malayalam
 *      digest, then calls the worker `create-post` job -> post saved as DRAFT.
 *   2. The owner reviews the draft (admin edit link) and approves.
 *   3. On approval the agent calls the worker `publish-post` job -> branded
 *      thumbnail is generated, the draft flips to published, Telegram fires,
 *      and the site revalidates. Nothing ever publishes without approval.
 */
import sharp from "sharp";
import { compressImage, uploadToImageCdn } from "./image-pipeline";

/** Freedom-fighter series posts live at clean top-level URLs (no /current-affairs/ prefix). */
function postPublicPath(slug: string): string {
  return slug === "indian-freedom-fighters" || slug.startsWith("freedom-fighter-")
    ? `/${slug}`
    : `/current-affairs/${slug}`;
}


export interface WorkerCtx {
  sbUrl: string;
  sbKey: string;
  tgToken: string;
  tgChannel: string;
  siteUrl: string;
  revalidateUrl: string;
  revalidateSecret: string;
}

function sbHeaders(ctx: WorkerCtx): HeadersInit {
  return {
    apikey: ctx.sbKey,
    Authorization: `Bearer ${ctx.sbKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function sb(
  ctx: WorkerCtx,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${ctx.sbUrl}/rest/v1/${path}`, {
    method,
    headers: sbHeaders(ctx),
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function tgSend(
  ctx: WorkerCtx,
  endpoint: "sendMessage" | "sendPhoto",
  payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${ctx.tgToken}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ctx.tgChannel, parse_mode: "HTML", ...payload }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: t.slice(0, 300) };
  }
  return { ok: true };
}

async function revalidate(ctx: WorkerCtx, paths: string[]): Promise<boolean> {
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

/** Today's date in IST, e.g. "28 September 2026". */
function istDateLong(d = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/** Slug-safe date: 2026-09-28 (IST). */
export function istDateSlug(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // en-CA => YYYY-MM-DD
}

export interface CreatePostInput {
  title: string;
  slug: string;
  excerpt?: string;
  content_html: string;
  category_slug?: string;
  tags?: string[];
}

/**
 * Create a post as DRAFT. Idempotent on slug: if a post with the slug
 * already exists it is returned untouched (never overwritten).
 */
export async function createDraftPost(ctx: WorkerCtx, input: CreatePostInput) {
  const slug = input.slug.trim().toLowerCase();
  if (!slug) throw new Error("slug required.");

  const existing = await sb(
    ctx,
    `posts?${new URLSearchParams({ select: "id,slug,status,title", slug: `eq.${slug}` })}`
  );
  if (!existing.ok) throw new Error(`Supabase read failed (${existing.status})`);
  const rows = existing.data as { id: string; slug: string; status: string; title: string }[];
  if (rows.length > 0) {
    return { id: rows[0].id, slug: rows[0].slug, status: rows[0].status, already: true as const };
  }

  let category_id: string | null = null;
  if (input.category_slug) {
    const cat = await sb(
      ctx,
      `categories?${new URLSearchParams({ select: "id", slug: `eq.${input.category_slug}` })}`
    );
    const cats = (cat.ok ? cat.data : []) as { id: string }[];
    if (cats.length > 0) category_id = cats[0].id;
  }

  const ins = await sb(ctx, "posts", "POST", {
    title: input.title,
    slug,
    excerpt: input.excerpt || null,
    content_html: input.content_html,
    content_markdown: null,
    editor_mode: "richtext",
    cover_image: null,
    category_id,
    tags: input.tags || [],
    status: "draft",
    published_at: null,
    meta_title: input.title,
    meta_description: input.excerpt || null,
    author_id: null,
  });
  if (!ins.ok) {
    if (ins.status === 409) {
      // Raced with another creator — treat as already-existing.
      return { id: "", slug, status: "draft", already: true as const };
    }
    throw new Error(`Post insert failed (${ins.status}): ${JSON.stringify(ins.data).slice(0, 200)}`);
  }
  const created = (ins.data as { id: string }[])[0];
  return { id: created.id, slug, status: "draft", already: false as const };
}

/**
 * Delete a post by slug — only drafts can be deleted here (safety guard).
 * Used to clean up rejected digest drafts.
 */
export async function deleteDraftPost(ctx: WorkerCtx, slug: string) {
  const found = await sb(
    ctx,
    `posts?${new URLSearchParams({ select: "id,status", slug: `eq.${slug}` })}`
  );
  if (!found.ok) throw new Error(`Supabase read failed (${found.status})`);
  const rows = found.data as { id: string; status: string }[];
  const post = rows[0];
  if (!post) throw new Error(`No post found with slug "${slug}"`);
  if (post.status !== "draft") {
    throw new Error(`Refusing to delete post "${slug}" with status "${post.status}" — drafts only.`);
  }
  const del = await sb(ctx, `posts?id=eq.${post.id}`, "DELETE");
  if (!del.ok) throw new Error(`Delete failed (${del.status})`);
  return { slug, deleted: true as const };
}

export interface UpdatePostInput {
  title?: string;
  excerpt?: string;
  content_html?: string;
  category_slug?: string;
  tags?: string[];
  cover_image?: string;
}

/**
 * Update a post's content fields by slug (any status — draft, scheduled or
 * published). Used to revise posts without the admin panel, e.g. translating
 * an already-published post. Revalidates the site's affected paths.
 */
export async function updatePost(ctx: WorkerCtx, slug: string, input: UpdatePostInput) {
  const found = await sb(
    ctx,
    `posts?${new URLSearchParams({ select: "id,slug,status", slug: `eq.${slug}` })}`
  );
  if (!found.ok) throw new Error(`Supabase read failed (${found.status})`);
  const rows = found.data as { id: string; slug: string; status: string }[];
  const post = rows[0];
  if (!post) throw new Error(`No post found with slug "${slug}"`);

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined && input.title.trim()) {
    patch.title = input.title.trim();
    patch.meta_title = input.title.trim();
  }
  if (input.excerpt !== undefined) {
    patch.excerpt = input.excerpt || null;
    patch.meta_description = input.excerpt || null;
  }
  if (input.content_html !== undefined && input.content_html.trim()) {
    patch.content_html = input.content_html;
    patch.content_markdown = null;
    patch.editor_mode = "richtext";
  }
  if (input.category_slug !== undefined) {
    let category_id: string | null = null;
    if (input.category_slug) {
      const cat = await sb(
        ctx,
        `categories?${new URLSearchParams({ select: "id", slug: `eq.${input.category_slug}` })}`
      );
      const cats = (cat.ok ? cat.data : []) as { id: string }[];
      if (cats.length > 0) category_id = cats[0].id;
    }
    patch.category_id = category_id;
  }
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.cover_image !== undefined) patch.cover_image = input.cover_image || null;
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

  const upd = await sb(ctx, `posts?id=eq.${post.id}`, "PATCH", patch);
  if (!upd.ok)
    throw new Error(`Update failed (${upd.status}): ${JSON.stringify(upd.data).slice(0, 200)}`);

  const revalidated = await revalidate(ctx, [
    `/current-affairs/${post.slug}`,
    "/current-affairs",
    "/",
  ]);
  return { slug: post.slug, updated: true as const, revalidated };
}
async function makeDigestThumbnail(dateLong: string): Promise<Buffer> {
  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#052e22"/><stop offset="0.55" stop-color="#0b4a33"/><stop offset="1" stop-color="#0e6b45"/>
</linearGradient>
</defs>
<rect width="1200" height="630" fill="url(#g)"/>
<circle cx="1050" cy="90" r="220" fill="#ffffff" opacity="0.06"/>
<circle cx="120" cy="580" r="160" fill="#ffffff" opacity="0.05"/>
<rect x="80" y="120" width="72" height="10" rx="5" fill="#fbbf24"/>
<text x="80" y="230" font-family="Verdana, Geneva, sans-serif" font-size="92" font-weight="bold" fill="#ffffff" letter-spacing="2">DAILY CURRENT</text>
<text x="80" y="330" font-family="Verdana, Geneva, sans-serif" font-size="92" font-weight="bold" fill="#ffffff" letter-spacing="2">AFFAIRS</text>
<text x="80" y="420" font-family="Verdana, Geneva, sans-serif" font-size="44" fill="#fbbf24">${esc(dateLong)}</text>
<text x="80" y="500" font-family="Verdana, Geneva, sans-serif" font-size="30" fill="#d1fae5">Kerala PSC • currentaffairsweb</text>
</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return compressImage(png);
}

/**
 * Publish a draft post by slug: generate+upload the branded thumbnail,
 * flip to published, announce on Telegram, revalidate the site.
 */
export async function publishDraftPost(ctx: WorkerCtx, slug: string) {
  const found = await sb(
    ctx,
    `posts?${new URLSearchParams({ select: "id,title,slug,excerpt,cover_image,status", slug: `eq.${slug}` })}`
  );
  if (!found.ok) throw new Error(`Supabase read failed (${found.status})`);
  const rows = found.data as {
    id: string;
    title: string;
    slug: string;
    excerpt: string | null;
    cover_image: string | null;
    status: string;
  }[];
  const post = rows[0];
  if (!post) throw new Error(`No post found with slug "${slug}"`);
  if (post.status === "published") {
    return { slug, already: true as const, published: [] as string[] };
  }
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new Error(`Post "${slug}" has status "${post.status}" — only draft/scheduled can be published here.`);
  }

  // Branded thumbnail (best-effort: publish anyway if generation fails).
  let coverImage = post.cover_image;
  let thumbNote = "";
  if (!coverImage) {
    try {
      const buf = await makeDigestThumbnail(istDateLong());
      coverImage = await uploadToImageCdn(buf, `auto-thumbnails/${slug}.webp`, { upsert: true });
    } catch (err) {
      thumbNote = ` (thumbnail failed: ${err instanceof Error ? err.message.slice(0, 80) : "error"})`;
    }
  }

  const upd = await sb(ctx, `posts?id=eq.${post.id}`, "PATCH", {
    status: "published",
    published_at: new Date().toISOString(),
    cover_image: coverImage,
  });
  if (!upd.ok) throw new Error(`Publish flip failed (${upd.status})`);

  const link = `${ctx.siteUrl}${postPublicPath(post.slug)}`;
  const caption =
    `📢 <b>${esc(post.title)}</b>\n\n${esc(post.excerpt ?? "")}\n\n🔗 ${link}\n\n📢 Join our channel: https://t.me/Daily_CurrentAffairs_Malayalam`;
  const tg = coverImage
    ? await tgSend(ctx, "sendPhoto", { photo: coverImage, caption })
    : await tgSend(ctx, "sendMessage", { text: caption });

  const revalidated = await revalidate(ctx, [
    `/current-affairs/${post.slug}`,
    "/current-affairs",
    "/",
  ]);
  return {
    slug,
    already: false as const,
    published: [`${slug}${tg.ok ? "" : " (telegram FAILED)"}${thumbNote}`],
    revalidated,
  };
}

export interface QuizQuestionInput {
  question: string;
  options: string[];
  correct_index: number;
  explanation?: string;
}

export interface CreateQuizInput {
  title: string;
  slug: string;
  description?: string;
  /** Digest post slug — resolved to quizzes.post_id so the quiz links back to the post. */
  post_slug?: string;
  category_slug?: string;
  difficulty?: string;
  time_limit_seconds?: number | null;
  questions: QuizQuestionInput[];
  status?: "draft" | "published";
}

/**
 * Create a quiz (with questions) linked to a digest post. Idempotent on
 * slug: if a quiz with the slug already exists it is returned untouched
 * (never overwritten, questions never duplicated).
 */
export async function createQuiz(ctx: WorkerCtx, input: CreateQuizInput) {
  const slug = input.slug.trim().toLowerCase();
  if (!slug) throw new Error("slug required.");
  if (!input.title?.trim()) throw new Error("title required.");
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length === 0) throw new Error("at least one question is required.");
  for (const [i, q] of questions.entries()) {
    if (!q.question?.trim()) throw new Error(`question ${i + 1}: text required.`);
    if (!Array.isArray(q.options) || q.options.length < 2)
      throw new Error(`question ${i + 1}: at least 2 options required.`);
    if (
      typeof q.correct_index !== "number" ||
      q.correct_index < 0 ||
      q.correct_index >= q.options.length
    )
      throw new Error(`question ${i + 1}: correct_index out of range.`);
  }

  const existing = await sb(
    ctx,
    `quizzes?${new URLSearchParams({ select: "id,slug,status,title", slug: `eq.${slug}` })}`
  );
  if (!existing.ok) throw new Error(`Supabase read failed (${existing.status})`);
  const rows = existing.data as { id: string; slug: string; status: string; title: string }[];
  if (rows.length > 0) {
    const qc = await sb(
      ctx,
      `quiz_questions?${new URLSearchParams({ select: "id", quiz_id: `eq.${rows[0].id}` })}`
    );
    const count = Array.isArray(qc.data) ? qc.data.length : 0;
    return { id: rows[0].id, slug: rows[0].slug, status: rows[0].status, already: true as const, questions: count };
  }

  let post_id: string | null = null;
  if (input.post_slug) {
    const p = await sb(
      ctx,
      `posts?${new URLSearchParams({ select: "id", slug: `eq.${input.post_slug.trim().toLowerCase()}` })}`
    );
    const prows = (p.ok ? p.data : []) as { id: string }[];
    if (prows.length > 0) post_id = prows[0].id;
  }

  let category_id: string | null = null;
  if (input.category_slug) {
    const cat = await sb(
      ctx,
      `categories?${new URLSearchParams({ select: "id", slug: `eq.${input.category_slug}` })}`
    );
    const cats = (cat.ok ? cat.data : []) as { id: string }[];
    if (cats.length > 0) category_id = cats[0].id;
  }

  const status = input.status === "published" ? "published" : "draft";
  const ins = await sb(ctx, "quizzes", "POST", {
    title: input.title.trim(),
    slug,
    description: input.description || null,
    post_id,
    category_id,
    difficulty: input.difficulty || "medium",
    time_limit_seconds: input.time_limit_seconds ?? null,
    is_mock: false,
    is_pyq: false,
    negative_marking: 0,
    status,
  });
  if (!ins.ok) {
    if (ins.status === 409) {
      return { id: "", slug, status: "draft", already: true as const, questions: 0 };
    }
    throw new Error(`Quiz insert failed (${ins.status}): ${JSON.stringify(ins.data).slice(0, 200)}`);
  }
  const quizId = ((ins.data as { id: string }[])[0] || {}).id;
  if (!quizId) throw new Error("Quiz insert returned no id.");

  const qrows = questions.map((q, i) => ({
    quiz_id: quizId,
    question: q.question.trim(),
    options: q.options.map((o) => String(o)),
    correct_index: q.correct_index,
    explanation: q.explanation || null,
    position: i,
  }));
  const qins = await sb(ctx, "quiz_questions", "POST", qrows);
  if (!qins.ok) {
    // Roll back the quiz shell so a retry stays clean.
    await sb(ctx, `quizzes?id=eq.${quizId}`, "DELETE").catch(() => {});
    throw new Error(
      `Question insert failed (${qins.status}): ${JSON.stringify(qins.data).slice(0, 200)}`
    );
  }

  const revalidated = await revalidate(ctx, ["/quiz", `/quiz/${slug}`]);
  return { id: quizId, slug, status, already: false as const, questions: qrows.length, revalidated };
}
