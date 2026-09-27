import { NextResponse } from "next/server";
import { extractMedia } from "@/lib/video-extract";

export const dynamic = "force-dynamic";

/**
 * POST /api/dl/extract  { url }
 * Resolves a YouTube / Instagram link into download options.
 * `direct` options are CDN URLs — the browser downloads straight from the
 * CDN (googlevideo / fbcdn), so no media bytes pass through the host.
 * `server` options (MP3, clip, full-video fallback) are rendered by
 * POST /api/dl/process on the host with ffmpeg / yt-dlp.
 */
export async function POST(req: Request) {
  let url = "";
  try {
    const body = await req.json();
    url = (body?.url || "").toString().trim();
  } catch {
    /* ignore malformed body */
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "Paste a YouTube or Instagram link first." },
      { status: 400 }
    );
  }

  try {
    const t0 = Date.now();
    const result = await extractMedia(url);
    console.log(`[extract] ok ${result.platform} in ${Date.now() - t0}ms :: ${url.slice(0, 80)}`);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Extraction failed. Please try again.";
    console.error(`[extract] FAIL :: ${url.slice(0, 80)} :: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
