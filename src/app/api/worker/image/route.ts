import { NextResponse } from "next/server";
import { processAndUploadImage } from "@/lib/worker/image-pipeline";

/**
 * Image processing endpoint for the current-affairs site's admin uploads.
 *
 * POST /api/worker/image
 *   Authorization: Bearer <WORKER_SECRET>
 *   multipart/form-data: file (binary), path (e.g. images/2026/09/abc.webp),
 *                        upsert ("1" to overwrite an existing file)
 * -> { ok: true, url }  (jsDelivr CDN URL pinned to the commit SHA)
 *
 * sharp compression + the GitHub upload both happen here so Vercel stays
 * a pure frontend/API shell.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WORKER_SECRET = process.env.WORKER_SECRET || "";

export async function POST(req: Request) {
  if (!WORKER_SECRET || req.headers.get("authorization") !== `Bearer ${WORKER_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.GITHUB_IMAGE_TOKEN) {
    return NextResponse.json({ error: "Worker not configured (GITHUB_IMAGE_TOKEN)." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const file = form.get("file");
  const path = String(form.get("path") || "").trim();
  const upsert = String(form.get("upsert") || "") === "1";

  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "file is required." }, { status: 400 });
  }
  if (!path) {
    return NextResponse.json({ error: "path is required." }, { status: 400 });
  }
  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 25MB)." }, { status: 413 });
  }

  try {
    const input = Buffer.from(await file.arrayBuffer());
    const url = await processAndUploadImage(input, path, { upsert });
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Image processing failed." },
      { status: 500 }
    );
  }
}
