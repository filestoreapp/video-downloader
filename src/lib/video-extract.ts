/**
 * Server-side media extraction for the personal Instagram downloader.
 *
 * Instagram reels, videos, photo posts and carousels are extracted with the
 * yt-dlp standalone binary (./bin/yt-dlp).
 *
 * Direct CDN URLs go straight to the browser (zero host bandwidth).
 * Clips and MP3 conversions are rendered on the host with the ffmpeg
 * static binary (./bin/ffmpeg) — see lib/media-process.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type Platform = "instagram";

// A download option shown to the user.
export interface DirectOption {
  kind: "direct";
  id: string;
  label: string;
  sub?: string;
  url: string;
  filename: string;
}
export interface ServerOption {
  kind: "server";
  id: string;
  label: string;
  sub?: string;
  mode: "mp3" | "clip";
  needsTime: boolean;
}
export type DlOption = DirectOption | ServerOption;

export interface ExtractOk {
  ok: true;
  platform: Platform;
  title: string;
  thumbnail: string | null;
  /** seconds, when known */
  duration: number | null;
  options: DlOption[];
}

/** Fully resolved media — internal; the process endpoint re-resolves it. */
export interface ResolvedMedia {
  platform: Platform;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  /** best direct video URL (progressive MP4), if available */
  videoUrl: string | null;
  videoLabel: string | null;
  /** original URL — needed for yt-dlp server-side modes */
  sourceUrl: string;
}

export function extractInstagramShortcode(u: string): string | null {
  const m = u.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function sanitizeFilename(name: string): string {
  const clean = (name || "media")
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, "-");
  return clean || "media";
}

function bin(name: "yt-dlp" | "ffmpeg"): string {
  const p = path.join(process.cwd(), "bin", name);
  if (!fs.existsSync(p)) {
    throw new Error("Downloader engine is still starting. Please try again in a minute.");
  }
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    /* best effort */
  }
  return p;
}

export function ytdlpBin(): string {
  return bin("yt-dlp");
}
export function ffmpegBin(): string {
  return bin("ffmpeg");
}

async function ytdlpJson(url: string, timeoutMs = 25000): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ytdlpBin(),
      ["--no-download", "--no-warnings", "-j", url],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }
    ));
  } catch (err) {
    const msg = String(
      (err as { stderr?: unknown }).stderr ?? (err as Error).message ?? err
    );
    console.error(`[ytdlp] FAIL :: ${msg.slice(0, 300).replace(/\n/g, " | ")}`);
    if (/private|login|rate-limit|429/i.test(msg)) {
      throw new Error(
        "This post is private or Instagram is throttling the server. Only public posts work — please try again in a bit."
      );
    }
    if (/unsupported url/i.test(msg)) {
      throw new Error("That link is not supported.");
    }
    throw new Error("The source did not respond. Please try again.");
  }
  const firstJson = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!firstJson) throw new Error("Could not read this link.");
  return JSON.parse(firstJson);
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

interface IgFormat {
  url?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number | null;
}

interface IgData {
  _type?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  url?: string;
  ext?: string;
  formats?: IgFormat[];
  entries?: IgData[];
}

const isCombinedVideo = (f: IgFormat) =>
  !!f.url && (f.vcodec ?? "unknown") !== "none" && (f.acodec ?? "unknown") !== "none";

function imageUrlsOf(d: IgData): string[] {
  const out = new Set<string>();
  const isImgExt = (e?: string) => !!e && /^(jpg|jpeg|png|webp)$/i.test(e);
  if (d.url && (isImgExt(d.ext) || /\.(jpe?g|png|webp)(\?|$)/i.test(d.url))) {
    out.add(d.url);
  }
  for (const f of d.formats ?? []) {
    if (f.url && isImgExt(f.ext)) out.add(f.url);
  }
  return [...out];
}

function bestVideoOf(d: IgData): { url: string; label: string } | null {
  const all = d.formats ?? [];
  const progressive = all.filter((f) => f.ext === "mp4" && isCombinedVideo(f));
  const combined = all.filter(isCombinedVideo);
  const pool = progressive.length ? progressive : combined;
  if (!pool.length) return null;
  pool.sort((a, b) => (b.height || 0) - (a.height || 0));
  const best = pool[0];
  return { url: best.url as string, label: best.height ? `${best.height}p` : "Video" };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function serverOption(
  id: string,
  label: string,
  sub: string,
  mode: ServerOption["mode"],
  needsTime = false
): ServerOption {
  return { kind: "server", id, label, sub, mode, needsTime };
}

export async function extractMedia(url: string): Promise<ExtractOk> {
  const u = url.trim();
  if (!/instagram\.com/i.test(u)) {
    if (/(?:youtube\.com|youtu\.be)/i.test(u)) {
      throw new Error("YouTube links are no longer supported — this site downloads Instagram only.");
    }
    throw new Error("Paste an Instagram link — a reel, video, or photo post.");
  }
  if (!extractInstagramShortcode(u)) {
    throw new Error("Paste a link to a reel, video, or photo post.");
  }
  const data = (await ytdlpJson(u)) as IgData;
  const title = data.title || "instagram-post";
  const fname = sanitizeFilename(title);
  const thumbnail = data.thumbnail || null;
  const options: DlOption[] = [];
  let duration: number | null = typeof data.duration === "number" ? data.duration : null;

  if (data._type === "playlist" && data.entries?.length) {
    // Carousel / album — direct downloads per item only.
    let photos = 0;
    let videos = 0;
    data.entries.forEach((e) => {
      const v = bestVideoOf(e);
      if (v) {
        videos += 1;
        options.push({
          kind: "direct",
          id: `video-${videos}`,
          label: `Video ${videos} · ${v.label} MP4`,
          sub: "saves to your device",
          url: v.url,
          filename: `${fname}-video${videos}.mp4`,
        });
        return;
      }
      for (const img of imageUrlsOf(e)) {
        photos += 1;
        options.push({
          kind: "direct",
          id: `photo-${photos}`,
          label: `Photo ${photos}`,
          sub: "saves to your device",
          url: img,
          filename: `${fname}-photo${photos}.jpg`,
        });
      }
    });
    if (!options.length) throw new Error("No downloadable video or photo found in this post.");
  } else {
    const v = bestVideoOf(data);
    if (v) {
      const vq = v.label !== "Video" ? ` · ${v.label}` : "";
      options.push({
        kind: "direct",
        id: "video",
        label: `Video${vq} MP4`,
        sub: "saves to your device",
        url: v.url,
        filename: `${fname}.mp4`,
      });
      options.push(serverOption("audio-mp3", "Audio · MP3", "converted on the server", "mp3"));
      options.push(serverOption("clip", "Cut a clip", "pick start & end times", "clip", true));
    } else {
      const imgs = imageUrlsOf(data);
      if (!imgs.length) throw new Error("No downloadable video or photo found in this post.");
      imgs.forEach((img, i) => {
        options.push({
          kind: "direct",
          id: `photo-${i}`,
          label: imgs.length > 1 ? `Photo ${i + 1}` : "Photo",
          sub: "saves to your device",
          url: img,
          filename: `${fname}-${i + 1}.jpg`,
        });
      });
      duration = null;
    }
  }

  return { ok: true, platform: "instagram", title, thumbnail, duration, options };
}

/**
 * Re-resolve a URL for server-side processing. Never trust client-sent
 * stream URLs — always fetch fresh ones here.
 */
export async function resolveForProcess(url: string): Promise<ResolvedMedia> {
  if (!/instagram\.com/i.test(url)) {
    throw new Error("Only Instagram links are supported.");
  }
  if (!extractInstagramShortcode(url)) {
    throw new Error("Paste a link to a reel, video, or photo post.");
  }
  const data = (await ytdlpJson(url)) as IgData;
  const v = bestVideoOf(data);
  if (!v) throw new Error("This needs a video post — photos have no audio to convert.");
  return {
    platform: "instagram",
    title: data.title || "instagram-post",
    thumbnail: data.thumbnail || null,
    duration: typeof data.duration === "number" ? data.duration : null,
    videoUrl: v.url,
    videoLabel: v.label,
    sourceUrl: url,
  };
}
