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

async function download(url, dest) {
  console.log(`[fetch-binaries] downloading ${url}`);
  await execFileAsync("curl", ["-sSL", "--retry", "3", "-o", dest, url], {
    timeout: 300000,
  });
  const size = fs.statSync(dest).size;
  if (size < 1_000_000) {
    throw new Error(`download too small (${size} bytes), likely an error page: ${url}`);
  }
  console.log(`[fetch-binaries] saved ${(size / 1e6).toFixed(1)} MB -> ${dest}`);
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
    await download(FFMPEG_URL, tar);
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
