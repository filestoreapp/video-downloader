/**
 * Server-side media extraction for the personal all-in-one downloader.
 *
 * YouTube: primary path is the pure-JS Innertube ANDROID player request,
 * which returns progressive (video+audio in one file) MP4 URLs plus
 * audio-only adaptive streams. If that fails, falls back to the yt-dlp
 * binary (audio direct URL; video merged server-side on demand).
 *
 * Instagram: extracted with the yt-dlp standalone binary (./bin/yt-dlp).
 * Handles reels/videos (progressive MP4), photo posts and carousels
 * (direct image URLs).
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

export type Platform = "youtube" | "instagram";

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
  mode: "mp3" | "clip" | "fullvideo" | "hdvideo";
  needsTime: boolean;
  /** requested video height for hdvideo mode (e.g. 720) */
  quality?: number;
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
  /** best direct audio-only URL, if available */
  audioUrl: string | null;
  /** video-only DASH MP4 streams (YouTube fast path), for HD muxing */
  dashVideo: { url: string; height: number }[];
  /** original URL — needed for yt-dlp server-side modes */
  sourceUrl: string;
  /** true when the YouTube fast path failed and yt-dlp must render video */
  youtubeFallback: boolean;
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

async function ytdlpJson(url: string, timeoutMs = 30000): Promise<unknown> {
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
    if (/registered users|login|cookies|private/i.test(msg)) {
      throw new Error("This post is private or needs login. Only public posts work.");
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
// YouTube
// ---------------------------------------------------------------------------

const YT_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const YT_ANDROID_VERSION = "20.10.38";

interface YtFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  qualityLabel?: string;
  bitrate?: number;
  height?: number;
}

function dashHeight(f: YtFormat): number {
  if (typeof f.height === "number" && f.height > 0) return f.height;
  const m = /(\d{3,4})p/.exec(f.qualityLabel || "");
  return m ? Number(m[1]) : 0;
}

async function resolveYoutubeFast(url: string): Promise<ResolvedMedia> {
  const videoId = extractYoutubeId(url);
  if (!videoId) throw new Error("Could not find a YouTube video ID in that link.");

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
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error("YouTube did not respond.");
  const data = await res.json();
  if (data?.playabilityStatus?.status !== "OK") {
    throw new Error(
      data?.playabilityStatus?.reason ||
        "This video is private, deleted, or otherwise unavailable."
    );
  }

  const progressive: YtFormat[] = (data?.streamingData?.formats ?? []).filter(
    (f: YtFormat) => f.url
  );
  const adaptive: YtFormat[] = (data?.streamingData?.adaptiveFormats ?? []).filter(
    (f: YtFormat) => f.url
  );
  const audio: YtFormat[] = adaptive.filter((f: YtFormat) =>
    (f.mimeType || "").startsWith("audio/")
  );
  // Video-only DASH MP4 streams for the HD mux options.
  const dashVideo = adaptive
    .filter((f: YtFormat) => (f.mimeType || "").startsWith("video/mp4"))
    .map((f) => ({ url: f.url as string, height: dashHeight(f) }))
    .filter((v) => v.height > 0)
    .sort((a, b) => b.height - a.height);
  if (!progressive.length && !audio.length) {
    throw new Error("No downloadable stream found for this video.");
  }
  progressive.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  audio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const details = data?.videoDetails ?? {};
  const thumbs: { url: string }[] = details?.thumbnail?.thumbnails ?? [];
  const title: string = details?.title || "youtube-video";
  const duration = details?.lengthSeconds ? Number(details.lengthSeconds) : null;

  return {
    platform: "youtube",
    title,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    duration,
    videoUrl: progressive.length ? (progressive[0].url as string) : null,
    videoLabel: progressive.length ? progressive[0].qualityLabel || "Video" : null,
    audioUrl: audio.length ? (audio[0].url as string) : null,
    dashVideo,
    sourceUrl: url,
    youtubeFallback: false,
  };
}

interface YtDlpFormat {
  url?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  abr?: number;
}

async function resolveYoutubeFallback(url: string): Promise<ResolvedMedia> {
  const data = (await ytdlpJson(url, 45000)) as {
    title?: string;
    thumbnail?: string;
    duration?: number;
    formats?: YtDlpFormat[];
  };
  const formats = data.formats ?? [];
  const audio = formats.filter(
    (f) =>
      !!f.url &&
      (f.vcodec === "none" || f.vcodec == null) &&
      !!f.acodec &&
      f.acodec !== "none"
  );
  audio.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  if (!formats.length) {
    throw new Error("No downloadable stream found for this video.");
  }
  return {
    platform: "youtube",
    title: data.title || "youtube-video",
    thumbnail: data.thumbnail || null,
    duration: typeof data.duration === "number" ? data.duration : null,
    videoUrl: null,
    videoLabel: null,
    audioUrl: audio.length ? (audio[0].url as string) : null,
    dashVideo: [],
    sourceUrl: url,
    youtubeFallback: true,
  };
}

export async function resolveYoutube(url: string): Promise<ResolvedMedia> {
  try {
    return await resolveYoutubeFast(url);
  } catch {
    // Fast path failed (e.g. network-level block) — yt-dlp is more robust.
    return await resolveYoutubeFallback(url);
  }
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
  const platform = detectPlatform(url);
  if (!platform) throw new Error("Only YouTube and Instagram links are supported.");

  if (platform === "youtube") {
    const m = await resolveYoutube(url);
    const base = sanitizeFilename(m.title);
    const options: DlOption[] = [];
    if (m.videoUrl) {
      const q = (m.videoLabel || "").trim();
      options.push({
        kind: "direct",
        id: "video",
        label: q && q !== "Video" ? `Video · ${q} MP4` : "Video · MP4",
        sub: "saves to your device",
        url: m.videoUrl,
        filename: `${base}.mp4`,
      });
    } else {
      options.push(
        serverOption("video", "Video · MP4", "prepared on the server — takes a minute", "fullvideo")
      );
    }
    // HD qualities: mux the DASH video-only stream with audio server-side.
    const hdHeights = [...new Set(m.dashVideo.map((v) => v.height))]
      .filter((h) => h === 480 || h === 720 || h === 1080)
      .sort((a, b) => b - a);
    for (const h of hdHeights) {
      options.push({
        kind: "server",
        id: `video-${h}p`,
        label: `Video · ${h}p${h >= 720 ? " HD" : ""} MP4`,
        sub: "best quality — prepared on the server",
        mode: "hdvideo",
        needsTime: false,
        quality: h,
      });
    }
    if (m.audioUrl) {
      options.push({
        kind: "direct",
        id: "audio-m4a",
        label: "Audio · M4A",
        sub: "saves to your device",
        url: m.audioUrl,
        filename: `${base}.m4a`,
      });
    }
    options.push(serverOption("audio-mp3", "Audio · MP3", "converted on the server", "mp3"));
    options.push(serverOption("clip", "Cut a clip", "pick start & end times", "clip", true));
    return {
      ok: true,
      platform,
      title: m.title,
      thumbnail: m.thumbnail,
      duration: m.duration,
      options,
    };
  }

  // Instagram — a single yt-dlp call, then branch on the shape.
  if (!extractInstagramShortcode(url)) {
    throw new Error("Paste a link to a reel, video, or photo post.");
  }
  const data = (await ytdlpJson(url)) as IgData;
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
      for (const u of imageUrlsOf(e)) {
        photos += 1;
        options.push({
          kind: "direct",
          id: `photo-${photos}`,
          label: `Photo ${photos}`,
          sub: "saves to your device",
          url: u,
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
      imgs.forEach((u, i) => {
        options.push({
          kind: "direct",
          id: `photo-${i}`,
          label: imgs.length > 1 ? `Photo ${i + 1}` : "Photo",
          sub: "saves to your device",
          url: u,
          filename: `${fname}-${i + 1}.jpg`,
        });
      });
      duration = null;
    }
  }

  return { ok: true, platform, title, thumbnail, duration, options };
}

/**
 * Re-resolve a URL for server-side processing. Never trust client-sent
 * stream URLs — always fetch fresh ones here.
 */
export async function resolveForProcess(url: string): Promise<ResolvedMedia> {
  const platform = detectPlatform(url);
  if (platform === "youtube") return resolveYoutube(url);
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
    audioUrl: null,
    dashVideo: [],
    sourceUrl: url,
    youtubeFallback: false,
  };
}
