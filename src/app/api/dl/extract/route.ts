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
    const result = await extractMedia(url);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Extraction failed. Please try again.",
      },
      { status: 502 }
    );
  }
}
