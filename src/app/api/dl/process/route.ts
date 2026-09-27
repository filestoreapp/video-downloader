import { NextResponse } from "next/server";
import {
  processMedia,
  contentDisposition,
  type ProcessMode,
} from "@/lib/media-process";
import { recordDownload } from "@/lib/stats";

export const dynamic = "force-dynamic";
// Long enough for a 10-minute clip render; ignored on plain Node hosts.
export const maxDuration = 300;

/**
 * POST /api/dl/process  { url, mode: "mp3" | "clip", start?, end? }
 * Renders the file on the host and streams it back as a download.
 * Stream URLs are always re-resolved server-side — client input is only
 * the page URL plus mode/times.
 */
export async function POST(req: Request) {
  let body: {
    url?: unknown;
    mode?: unknown;
    start?: unknown;
    end?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const url = String(body.url || "").trim();
  const mode = body.mode as ProcessMode;
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "Paste an Instagram link first." }, { status: 400 });
  }
  if (mode !== "mp3" && mode !== "clip") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const start = body.start === undefined ? undefined : Number(body.start);
  const end = body.end === undefined ? undefined : Number(body.end);
  if (mode === "clip" && (start === undefined || end === undefined)) {
    return NextResponse.json({ error: "Give a start and end time for the clip." }, { status: 400 });
  }

  try {
    const file = await processMedia({ url, mode, start, end });
    // Count the completed render (fire-and-forget).
    recordDownload(mode);
    // Wrap the stream so temp files are deleted once the body is consumed.
    const headers = new Headers({
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition(file.filename),
      "Cache-Control": "no-store",
    });
    if (!file.cleanup) {
      return new Response(file.body, { headers });
    }
    const cleanup = file.cleanup;
    const tracked = file.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush() {
          // Runs after the last chunk is delivered.
          setTimeout(cleanup, 1000);
        },
      })
    );
    return new Response(tracked, { headers });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Processing failed. Please try again.",
      },
      { status: 502 }
    );
  }
}
