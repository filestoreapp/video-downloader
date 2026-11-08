/**
 * postinstall: download the standalone binaries this app needs into ./bin/
 * - yt-dlp (pinned release) — Instagram extraction engine
 * - ffmpeg (BtbN static build) — clip cutting + MP3 conversion
 *
 * Idempotent: skips anything already present. Koyeb runs `npm install`
 * (and therefore this script) at build time.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(rootDir, "bin");

const YTDLP_VERSION = "2026.08.19";
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux`;
// BtbN static ffmpeg builds (GitHub releases, "latest" is a stable symlink URL)
const FFMPEG_URL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

async function download(url, dest, extraArgs = []) {
  console.log(`[fetch-binaries] downloading ${url}`);
  try {
    await execFileAsync("curl", ["-sSL", "--retry", "3", "-o", dest, ...extraArgs, url], {
      timeout: 300000,
    });
  } catch (err) {
    console.warn(`[fetch-binaries] download failed: ${err.message}`);
    return false;
  }
  const size = fs.statSync(dest).size;
  if (size < 1_000_000) {
    console.warn(`[fetch-binaries] download too small (${size} bytes), likely an error page: ${url}`);
    return false;
  }
  console.log(`[fetch-binaries] saved ${(size / 1e6).toFixed(1)} MB -> ${dest}`);
  return true;
}

/**
 * Fallback for the BtbN ffmpeg tarball via the GitHub API asset endpoint.
 * The plain github.com release-download URL 504s from time to time
 * (2026-11-08: 5 consecutive 504s broke the Koyeb build), while
 * api.github.com keeps working — resolving the asset id there and
 * downloading with Accept: application/octet-stream gets the same file.
 */
async function downloadFfmpegViaApi(dest) {
  const assetName = "ffmpeg-master-latest-linux64-gpl.tar.xz";
  try {
    const { stdout } = await execFileAsync("curl", [
      "-sSL",
      "--retry", "3",
      "https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/latest",
    ], { timeout: 60000 });
    const release = JSON.parse(stdout);
    const asset = (release.assets || []).find((a) => a.name === assetName);
    if (!asset) {
      console.warn(`[fetch-binaries] API fallback: asset ${assetName} not found in latest release`);
      return false;
    }
    console.log(`[fetch-binaries] API fallback: asset ${asset.id} (${(asset.size / 1e6).toFixed(1)} MB)`);
    return download(
      `https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/assets/${asset.id}`,
      dest,
      ["-H", "Accept: application/octet-stream"]
    );
  } catch (err) {
    console.warn(`[fetch-binaries] API fallback failed: ${err.message}`);
    return false;
  }
}

async function main() {
  fs.mkdirSync(binDir, { recursive: true });

  const ytdlp = path.join(binDir, "yt-dlp");
  if (fs.existsSync(ytdlp)) {
    console.log("[fetch-binaries] yt-dlp already present, skipping");
  } else {
    await download(YTDLP_URL, ytdlp);
    fs.chmodSync(ytdlp, 0o755);
  }

  const ffmpeg = path.join(binDir, "ffmpeg");
  if (fs.existsSync(ffmpeg)) {
    console.log("[fetch-binaries] ffmpeg already present, skipping");
  } else {
    const tar = path.join(binDir, "ffmpeg.tar.xz");
    // Primary URL first, then the GitHub API asset endpoint. If both fail,
    // warn and continue: ffmpeg is only used for clip cutting / MP3
    // conversion, so a missing binary must never block the whole deploy
    // (a GitHub release-download outage did exactly that on 2026-11-08).
    const ok = (await download(FFMPEG_URL, tar)) || (await downloadFfmpegViaApi(tar));
    if (!ok) {
      console.warn("[fetch-binaries] WARNING: ffmpeg download failed from all sources — continuing without it; clip cutting / MP3 conversion will be unavailable until ffmpeg is installed.");
      fs.rmSync(tar, { force: true });
      console.log("[fetch-binaries] done (without ffmpeg)");
      return;
    }
    // Archive layout: ffmpeg-master-latest-linux64-gpl/bin/ffmpeg.
    // --no-same-owner: the tarball stores uid/gid 1001; chown fails on
    // hosts where we can't change ownership (Koyeb, containers).
    await execFileAsync(
      "tar",
      [
        "-xJf",
        tar,
        "-C",
        binDir,
        "--strip-components=2",
        "--no-same-owner",
        "--wildcards",
        "*/bin/ffmpeg",
      ],
      { timeout: 180000 }
    );
    fs.rmSync(tar, { force: true });
    if (!fs.existsSync(ffmpeg)) throw new Error("ffmpeg binary not found after extraction");
    fs.chmodSync(ffmpeg, 0o755);
    const { stdout } = await execFileAsync(ffmpeg, ["-version"]);
    console.log("[fetch-binaries]", stdout.split("\n")[0]);
  }

  console.log("[fetch-binaries] done");
}


main().catch((err) => {
  console.error('[fetch-binaries] FAILED:', err.message);
  process.exit(1);
});
