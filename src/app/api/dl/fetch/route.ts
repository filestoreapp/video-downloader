import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/media-process";
import { recordDownload } from "@/lib/stats";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/dl/fetch?u=<cdn-url>&n=<filename>
 * Streams a source-CDN file (fbcdn / cdninstagram) through
 * the host with Content-Disposition: attachment, so the browser downloads
 * it in-app instead of opening the CDN URL in a new tab.
 *
 * SSRF protection: only the exact media hosts we generate links for are
 * allowed, https only, no credentials in the URL.
 */
const ALLOWED_HOSTS = [
  /(^|\.)fbcdn\.net$/i,
  /(^|\.)cdninstagram\.com$/i,
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("u") || "";
  const name = (searchParams.get("n") || "download").slice(0, 120);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Bad link." }, { status: 400 });
  }
  if (target.protocol !== "https:") {
    return NextResponse.json({ error: "Bad link." }, { status: 400 });
  }
  if (target.username || target.password) {
    return NextResponse.json({ error: "Bad link." }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
    return NextResponse.json({ error: "That host is not allowed." }, { status: 403 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch {
    return NextResponse.json({ error: "The source did not respond. Please try again." }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "The source did not respond. Please try again." }, { status: 502 });
  }

  const headers = new Headers({
    "Content-Disposition": contentDisposition(name),
    "Cache-Control": "no-store",
  });
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("Content-Type", ct);
  const cl = upstream.headers.get("content-length");
  if (cl) headers.set("Content-Length", cl);

  // Count the completed download (fire-and-forget; never blocks the stream).
  recordDownload("video");

  return new Response(upstream.body, { headers });
}
