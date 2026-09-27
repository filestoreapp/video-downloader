/**
 * postinstall: download the pinned yt-dlp standalone binary for this
 * machine's platform into ./bin/yt-dlp.
 *
 * On Vercel the build runs on linux/x64, and next.config.ts's
 * outputFileTracingIncludes bundles ./bin/yt-dlp into the
 * /api/dl/extract serverless function, where the Instagram extractor
 * spawns it. The binary is gitignored — it is fetched fresh on every
 * install, never committed.
 */
import { createWriteStream, chmodSync, mkdirSync, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.08.19";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(__dirname, "..", "bin");
const binPath = path.join(binDir, "yt-dlp");

function assetName() {
  if (process.platform === "linux" && process.arch === "x64") return "yt-dlp_linux";
  if (process.platform === "darwin" && process.arch === "arm64") return "yt-dlp_macos";
  if (process.platform === "darwin" && process.arch === "x64") return "yt-dlp_macos_legacy";
  if (process.platform === "win32") return "yt-dlp.exe";
  return null;
}

const asset = assetName();
if (!asset) {
  console.log(`[fetch-ytdlp] skipping: unsupported platform ${process.platform}/${process.arch}`);
  process.exit(0);
}
if (existsSync(binPath)) {
  console.log("[fetch-ytdlp] binary already present, skipping");
  process.exit(0);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${asset}`;
console.log(`[fetch-ytdlp] downloading ${url}`);
mkdirSync(binDir, { recursive: true });
const res = await fetch(url);
if (!res.ok || !res.body) {
  throw new Error(`[fetch-ytdlp] download failed: HTTP ${res.status}`);
}
await finished(Readable.fromWeb(res.body).pipe(createWriteStream(binPath)));
chmodSync(binPath, 0o755);
console.log("[fetch-ytdlp] done");
