/**
 * Exam-hub auto-sync (phase 1) — keeps the /exams hubs fresh from the
 * hourly PSC scrape, using listing metadata only (no PDF reading).
 *
 * After psc-scrape inserts new rows, each row with a category number is
 * matched against the exams table:
 *  - exact category-number match  -> in-cycle update (conservative rules
 *    below) + tag the psc_update row with exam_slug (powers hub linking)
 *  - notification with an UNKNOWN category number whose title matches a
 *    hub's keywords -> reported as a suggestion for human review, NEVER
 *    auto-applied (e.g. "LD CLERK (BY TRANSFER)" must not hijack the
 *    LDC hub)
 *
 * In-cycle rules (only ever fill gaps / move status forward, never
 * overwrite what a human set):
 *  - notifications / examination_notification: fill notification_date if empty
 *  - result_notifications: status -> completed, result_date if empty
 *  - shortlists / rankedlist: status -> completed
 *  - exam_programme / interviews / syllabus: nothing (exam dates and
 *    question-paper codes live inside PDFs — phase 2)
 */

interface Ctx {
  sbUrl: string;
  sbKey: string;
  tgToken: string;
  tgChannel: string;
  siteUrl: string;
  revalidateUrl: string;
  revalidateSecret: string;
}

export interface HubSyncRow {
  id: string | null; // null in dry-run (row not inserted yet)
  source: string;
  title: string;
  category_number: string | null;
  published_on: string | null; // yyyy-mm-dd
}

export interface HubSyncResult {
  /** Human-readable change lines, e.g. "Police Constable: status -> completed (Result Notification 563/2025)" */
  changes: string[];
  /** psc_update rows tagged with exam_slug */
  tagged: number;
  /** new-cycle candidates needing human review */
  suggestions: string[];
  /** ISR paths the caller should revalidate */
  revalidatePaths: string[];
}

interface ExamRow {
  slug: string;
  name: string;
  short_name: string | null;
  category_no: string | null;
  notification_date: string | null;
  result_date: string | null;
  status: string;
}

const SOURCE_LABELS: Record<string, string> = {
  notifications: "Notification",
  examination_notification: "Examination Notification",
  syllabus: "Syllabus",
  exam_programme: "Exam Programme",
  result_notifications: "Result Notification",
  shortlists: "Short List",
  rankedlist: "Ranked List",
  interviews: "Interview Schedule",
};

/** Keyword fingerprints per hub, used ONLY for new-cycle suggestions. */
const HUB_KEYWORDS: { slug: string; name: string; include: RegExp[]; exclude?: RegExp[] }[] = [
  {
    slug: "ldc",
    name: "Lower Division Clerk",
    include: [/LOWER DIVISION CLERK/i, /\bLD\.?\s*CLERK\b/i],
    exclude: [/BY TRANSFER/i],
  },
  {
    slug: "lgs",
    name: "Last Grade Servants",
    include: [/LAST GRADE SERVANTS?/i, /\bLGS\b/i],
  },
  {
    slug: "university-assistant",
    name: "University Assistant",
    include: [/UNIVERSITY ASSISTANT/i],
  },
  {
    slug: "police-constable",
    name: "Police Constable",
    include: [/POLICE CONSTABLE/i, /ARMED POLICE/i],
  },
];

function normCat(v: string | null | undefined): string {
  return (v || "").toUpperCase().replace(/\s+/g, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sbHeaders(ctx: Ctx): HeadersInit {
  return {
    apikey: ctx.sbKey,
    Authorization: `Bearer ${ctx.sbKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

export async function syncExamHubs(
  ctx: Ctx,
  rows: HubSyncRow[],
  dryRun: boolean
): Promise<HubSyncResult> {
  const result: HubSyncResult = { changes: [], tagged: 0, suggestions: [], revalidatePaths: [] };
  if (rows.length === 0) return result;

  let exams: ExamRow[] = [];
  try {
    const res = await fetch(
      `${ctx.sbUrl}/rest/v1/exams?select=slug,name,short_name,category_no,notification_date,result_date,status`,
      { headers: { apikey: ctx.sbKey, Authorization: `Bearer ${ctx.sbKey}` } }
    );
    if (!res.ok) return result;
    exams = (await res.json()) as ExamRow[];
  } catch {
    return result; // never fail the scrape because the sync broke
  }
  if (exams.length === 0) return result;

  const byCat = new Map<string, ExamRow>();
  for (const e of exams) {
    const c = normCat(e.category_no);
    if (c) byCat.set(c, e);
  }

  const tagIds: string[] = [];

  for (const row of rows) {
    const cat = normCat(row.category_number);
    const exam = cat ? byCat.get(cat) : undefined;
    const label = SOURCE_LABELS[row.source] ?? row.source;

    if (exam) {
      if (row.id) tagIds.push(row.id);
      const patch: Record<string, string> = {};
      const notes: string[] = [];

      switch (row.source) {
        case "notifications":
        case "examination_notification":
          if (!exam.notification_date && row.published_on) {
            patch.notification_date = row.published_on;
            notes.push(`notification date → ${row.published_on}`);
          }
          break;
        case "result_notifications":
          if (exam.status !== "completed") {
            patch.status = "completed";
            notes.push("status → completed");
          }
          if (!exam.result_date && row.published_on) {
            patch.result_date = row.published_on;
            notes.push(`result date → ${row.published_on}`);
          }
          break;
        case "shortlists":
        case "rankedlist":
          if (exam.status !== "completed") {
            patch.status = "completed";
            notes.push("status → completed");
          }
          break;
        default:
          break; // exam_programme / interviews / syllabus: PDF-gated (phase 2)
      }

      if (notes.length > 0) {
        const line = `${exam.name}: ${notes.join(", ")} (${label}${cat ? ` ${cat}` : ""})${dryRun ? " [would apply]" : ""}`;
        result.changes.push(line);
        if (!dryRun) {
          try {
            const pr = await fetch(
              `${ctx.sbUrl}/rest/v1/exams?${new URLSearchParams({ slug: `eq.${exam.slug}` })}`,
              { method: "PATCH", headers: sbHeaders(ctx), body: JSON.stringify(patch) }
            );
            if (pr.ok && !result.revalidatePaths.includes(`/exams/${exam.slug}`)) {
              result.revalidatePaths.push(`/exams/${exam.slug}`);
            }
          } catch {
            /* best-effort */
          }
        } else if (!result.revalidatePaths.includes(`/exams/${exam.slug}`)) {
          result.revalidatePaths.push(`/exams/${exam.slug}`);
        }
      }
      continue;
    }

    // No hub carries this category number — possible NEW exam cycle?
    if (
      (row.source === "notifications" || row.source === "examination_notification") &&
      cat
    ) {
      const hub = HUB_KEYWORDS.find(
        (h) =>
          h.include.some((re) => re.test(row.title)) &&
          !(h.exclude || []).some((re) => re.test(row.title))
      );
      if (hub) {
        result.suggestions.push(
          `${hub.name}: possible new cycle ${cat} — "${row.title}" (hub not auto-updated; review first)`
        );
      }
    }
  }

  // Tag matched updates with the hub slug (powers the hub's linked-updates).
  if (!dryRun && tagIds.length > 0) {
    const catOf = new Map<string, string>();
    for (const row of rows) {
      if (!row.id) continue;
      const exam = byCat.get(normCat(row.category_number));
      if (exam) catOf.set(row.id, exam.slug);
    }
    for (const [id, slug] of catOf) {
      try {
        const tr = await fetch(`${ctx.sbUrl}/rest/v1/psc_updates?id=eq.${id}`, {
          method: "PATCH",
          headers: sbHeaders(ctx),
          body: JSON.stringify({ exam_slug: slug }),
        });
        if (tr.ok) result.tagged += 1;
      } catch {
        /* best-effort */
      }
    }
  }

  // One compact public note when hubs actually changed.
  if (!dryRun && (result.changes.length > 0 || result.suggestions.length > 0)) {
    const lines = result.changes.map((c) => `• ${esc(c)}`);
    for (const s of result.suggestions.slice(0, 3)) {
      lines.push(`👀 ${esc(s)}`);
    }
    const text =
      `🎓 <b>Exam hubs auto-updated</b>\n\n${lines.join("\n")}` +
      `\n\n📢 Join our channel: https://t.me/Daily_CurrentAffairs_Malayalam`;
    try {
      await fetch(`https://api.telegram.org/bot${ctx.tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: ctx.tgChannel, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      /* best-effort */
    }
  }

  return result;
}
