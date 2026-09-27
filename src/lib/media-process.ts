/**
 * Server-side media processing: clip cutting and MP3 conversion.
 * Runs on the host with the ffmpeg static binary (./bin/ffmpeg).
 *
 * Jobs stream straight from ffmpeg's stdout — no temp files.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  ffmpegBin,
  resolveForProcess,
  sanitizeFilename,
} from "./video-extract";

export type ProcessMode = "mp3" | "clip";

export interface ProcessParams {
  url: string;
  mode: ProcessMode;
  start?: number;
  end?: number;
}

export interface ProcessedFile {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  filename: string;
  /** call after the response is fully sent */
  cleanup?: () => void;
}

const MAX_CLIP_SECONDS = 600; // 10 minutes
const JOB_TIMEOUT_MS = 8 * 60 * 1000;

function runStreaming(
  cmd: string,
  args: string[],
  timeoutMs = JOB_TIMEOUT_MS
): { webStream: ReadableStream<Uint8Array>; done: Promise<void> } {
  const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, timeoutMs);
  // Don't let the timer keep the process alive on its own.
  timer.unref?.();

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Processing failed (exit ${code}): ${stderr.slice(-300)}`));
    });
  });
  // If the consumer abandons the stream, still surface failures in logs.
  done.catch((err) => console.error("[media-process]", err.message));

  return { webStream: Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>, done };
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function processMedia(p: ProcessParams): Promise<ProcessedFile> {
  const media = await resolveForProcess(p.url);
  const base = sanitizeFilename(media.title);

  if (p.mode === "mp3") {
    // Instagram videos always have a combined video+audio stream.
    const src = media.videoUrl;
    if (!src) throw new Error("No audio found for this link.");
    const { webStream } = runStreaming(ffmpegBin(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      src,
      "-vn",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      "-f",
      "mp3",
      "pipe:1",
    ]);
    return {
      body: webStream,
      contentType: "audio/mpeg",
      filename: `${base}-audio.mp3`,
    };
  }

  if (p.mode === "clip") {
    const start = p.start ?? 0;
    const end = p.end ?? 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error("Give a valid start and end time (end after start).");
    }
    const len = end - start;
    if (len > MAX_CLIP_SECONDS) {
      throw new Error("Clips are limited to 10 minutes.");
    }
    if (media.duration && end > media.duration + 1) {
      throw new Error(`This video is only ${Math.round(media.duration)}s long.`);
    }
    if (!media.videoUrl) throw new Error("No video found for this link.");

    // Direct video URL + ffmpeg seek (no re-encode, near instant).
    // Seek to ~5s before the cut point first (fast keyframe seek), then
    // trim precisely with stream copy. Fragmented MP4 so stdout piping works.
    const pre = Math.max(0, start - 5);
    const { webStream } = runStreaming(ffmpegBin(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(pre),
      "-i",
      media.videoUrl,
      "-ss",
      String(start - pre),
      "-t",
      String(len),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "frag_keyframe+empty_moov",
      "-f",
      "mp4",
      "pipe:1",
    ]);
    return {
      body: webStream,
      contentType: "video/mp4",
      filename: `${base}-clip-${Math.round(start)}s-${Math.round(end)}s.mp4`,
    };
  }

  throw new Error("Unsupported processing mode.");
}

export { contentDisposition };
