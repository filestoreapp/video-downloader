/**
 * Server-side video extraction for the personal video downloader.
 *
 * YouTube: talked to directly via the Innertube player API with the ANDROID
 * client, which returns a progressive (video+audio in one file) MP4 stream
 * URL. Pure JS, no binary, ~1s.
 *
 * Instagram: extracted with the yt-dlp standalone binary (./bin/yt-dlp,
 * fetched at install time by scripts/fetch-ytdlp.mjs). Instagram serves an
 * empty app shell to server-side HTML fetches, so the binary's internal
 * API-based extractor is the reliable path.
 *
 * Both return a direct CDN URL; the browser downloads the file straight
 * from the CDN, so no video bytes ever pass through the host.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type Platform = "youtube" | "instagram";

export interface ExtractResult {
  platform: Platform;
  title: string;
  thumbnail: string | null;
  downloadUrl: string;
  qualityLabel: string;
  filename: string;
}

export function detectPlatform(rawUrl: string): Platform | null {
  const u = rawUrl.trim();
  if (/(?:youtube\.com|youtu\.be)/i.test(u)) return "youtube";
  if (/instagram\.com/i.test(u)) return "instagram";
  return null;
}

export function extractYoutubeId(u: string): string | null {
  const m = u.match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

export function extractInstagramShortcode(u: string): string | null {
  const m = u.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function sanitizeFilename(name: string): string {
  const clean = (name || "video")
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, "-");
  return clean || "video";
}

// ---------------------------------------------------------------------------
// YouTube (Innertube ANDROID client)
// ---------------------------------------------------------------------------

const YT_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const YT_ANDROID_VERSION = "20.10.38";

interface YtFormat {
  itag?: number;
  url?: string;
  qualityLabel?: string;
  bitrate?: number;
  contentLength?: string;
}

export async function extractYoutube(url: string): Promise<ExtractResult> {
  const videoId = extractYoutubeId(url);
  if (!videoId) {
    throw new Error("Could not find a YouTube video ID in that link.");
  }

  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${YT_API_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `com.google.android.youtube/${YT_ANDROID_VERSION} (Linux; U; Android 14) gzip`,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: YT_ANDROID_VERSION,
            androidSdkVersion: 34,
            hl: "en",
            gl: "US",
          },
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error("YouTube did not respond. Please try again.");
  }
  const data = await res.json();
  const playability = data?.playabilityStatus?.status;
  if (playability !== "OK") {
    const reason =
      data?.playabilityStatus?.reason ||
      "This video is private, deleted, or otherwise unavailable.";
    throw new Error(reason);
  }

  const formats: YtFormat[] = (data?.streamingData?.formats ?? []).filter(
    (f: YtFormat) => f.url
  );
  if (!formats.length) {
    throw new Error("No downloadable stream found for this video.");
  }
  // Progressive formats carry video+audio in one file; take the best one.
  formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const best = formats[0];

  const details = data?.videoDetails ?? {};
  const thumbs: { url: string }[] = details?.thumbnail?.thumbnails ?? [];
  const title: string = details?.title || "youtube-video";

  return {
    platform: "youtube",
    title,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    downloadUrl: best.url as string,
    qualityLabel: best.qualityLabel || "Video",
    filename: sanitizeFilename(title) + ".mp4",
  };
}

// ---------------------------------------------------------------------------
// Instagram (yt-dlp binary)
// ---------------------------------------------------------------------------

function ytdlpBin(): string {
  const p = path.join(process.cwd(), "bin", "yt-dlp");
  if (!fs.existsSync(p)) {
    throw new Error("Downloader engine is still starting. Please try again in a minute.");
  }
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    /* best effort — the binary is usually already executable */
  }
  return p;
}

interface IgFormat {
  url?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number | null;
}

export async function extractInstagram(url: string): Promise<ExtractResult> {
  const shortcode = extractInstagramShortcode(url);
  if (!shortcode) {
    throw new Error("Could not find an Instagram post or reel in that link.");
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ytdlpBin(),
      ["--no-download", "--no-warnings", "-j", url],
      { timeout: 25000, maxBuffer: 16 * 1024 * 1024 }
    ));
  } catch (err) {
    const msg = String(
      (err as { stderr?: unknown }).stderr ?? (err as Error).message ?? err
    );
    if (/registered users|login|cookies/i.test(msg)) {
      throw new Error(
        "This Instagram post is private or needs login. Only public posts work."
      );
    }
    if (/unsupported url/i.test(msg)) {
      throw new Error("That does not look like an Instagram post link.");
    }
    throw new Error("Instagram did not respond. Please try again.");
  }

  const firstJson = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!firstJson) {
    throw new Error("Could not read this Instagram post.");
  }
  const data = JSON.parse(firstJson);
  const allFormats: IgFormat[] = data.formats ?? [];
  // A format is "combined" (single file with video+audio) when neither codec
  // is explicitly 'none'. Instagram's progressive mp4s (ids 1/2/3) sometimes
  // omit codec fields entirely — treat missing as acceptable, since the
  // DASH-split entries always mark their missing side as 'none'.
  const isCombined = (f: IgFormat) =>
    !!f.url &&
    (f.vcodec ?? "unknown") !== "none" &&
    (f.acodec ?? "unknown") !== "none";
  const progressive = allFormats.filter((f) => f.ext === "mp4" && isCombined(f));
  const combined = allFormats.filter(isCombined);
  const formats = progressive.length ? progressive : combined;
  if (!formats.length) {
    throw new Error("No downloadable video found in this post.");
  }
  formats.sort((a, b) => (b.height || 0) - (a.height || 0));
  const best = formats[0];
  const title: string = data.title || "instagram-video";

  return {
    platform: "instagram",
    title,
    thumbnail: data.thumbnail || null,
    downloadUrl: best.url as string,
    qualityLabel: best.height ? `${best.height}p` : "Video",
    filename: sanitizeFilename(title) + ".mp4",
  };
}
