import { NextResponse } from "next/server";
import {
  detectPlatform,
  extractInstagram,
  extractYoutube,
} from "@/lib/video-extract";

export const dynamic = "force-dynamic";

/**
 * POST /api/dl/extract  { url }
 * Resolves a YouTube / Instagram link to a direct downloadable video URL.
 * The video bytes never pass through Vercel — the browser downloads
 * straight from the CDN (googlevideo / fbcdn).
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

  const platform = detectPlatform(url);
  if (!platform) {
    return NextResponse.json(
      { error: "Only YouTube and Instagram links are supported." },
      { status: 400 }
    );
  }

  try {
    const result =
      platform === "youtube"
        ? await extractYoutube(url)
        : await extractInstagram(url);
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
