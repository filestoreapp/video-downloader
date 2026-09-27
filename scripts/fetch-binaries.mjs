/**
 * postinstall: download the standalone binaries this app needs into ./bin/
 * - yt-dlp (pinned release) — Instagram + YouTube extraction engine
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

// bgutil-ytdlp-pot-provider: Proof-of-Origin token provider that defeats
// YouTube's "Sign in to confirm you're not a bot" wall for flagged IPs.
// Plugin: 3 small .py files loaded via yt-dlp --plugin-dirs.
// Provider: node script (script mode — no persistent server process needed)
// invoked by the plugin per token request; tokens are cached ~6h.
const POT_VERSION = "2.0.0";
const POT_TARBALL = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${POT_VERSION}.tar.gz`;
// The release zip is yt-dlp's documented plugin install format: it reads
// plugins straight out of the zip, so no extraction step is needed.
const POT_PLUGIN_ZIP = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${POT_VERSION}/bgutil-ytdlp-pot-provider.zip`;
// generate_once.ts needs only these; express+canvas are HTTP-server-only
// (canvas also needs native build libs — skipped on purpose).
// The @types* / extra-typings entries are compile-time only (for tsc).
const POT_DEPS = {
  axios: "^1.19.0",
  "bgutils-js": "^4.0.3",
  commander: "^15.0.0",
  jsdom: "^29.1.1",
  "proxy-agent": "^8.0.2",
  "youtubei.js": "^18.0.0",
  "@commander-js/extra-typings": "^15.0.0",
  "@types/jsdom": "^28.0.3",
  "@types/node": "^22",
};

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

  await fetchPotProvider();

  console.log("[fetch-binaries] done");
}

/** Download the bgutil POT provider (plugin + node token-minting script). */
async function fetchPotProvider() {
  const serverDir = path.join(rootDir, "pot-server");
  const scriptOut = path.join(serverDir, "build", "generate_once.js");

  // 1. yt-dlp plugin (release zip — yt-dlp loads plugins straight from the zip)
  const pluginDir = path.join(rootDir, "pot-plugins");
  const pluginZip = path.join(pluginDir, "bgutil-ytdlp-pot-provider.zip");
  if (fs.existsSync(pluginZip)) {
    console.log("[fetch-binaries] pot plugin already present, skipping");
  } else {
    fs.mkdirSync(pluginDir, { recursive: true });
    console.log(`[fetch-binaries] downloading ${POT_PLUGIN_ZIP}`);
    await execFileAsync("curl", ["-sSL", "--retry", "3", "-o", pluginZip, POT_PLUGIN_ZIP], {
      timeout: 120000,
    });
    if (fs.statSync(pluginZip).size < 5000) {
      throw new Error("plugin zip too small, likely an error page");
    }
    console.log("[fetch-binaries] pot plugin downloaded");
  }

  // 2. provider server source -> slim install -> transpile generate_once.ts
  if (fs.existsSync(scriptOut)) {
    console.log("[fetch-binaries] pot server already built, skipping");
    return;
  }
  const tar = path.join(rootDir, "pot-server.tar.gz");
  console.log(`[fetch-binaries] downloading ${POT_TARBALL}`);
  await execFileAsync("curl", ["-sSL", "--retry", "3", "-o", tar, POT_TARBALL], {
    timeout: 180000,
  });
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.mkdirSync(serverDir, { recursive: true });
  await execFileAsync(
    "tar",
    [
      "-xzf",
      tar,
      "-C",
      serverDir,
      "--strip-components=2",
      "--no-same-owner",
      `bgutil-ytdlp-pot-provider-${POT_VERSION}/server`,
    ],
    { timeout: 60000 }
  );
  fs.rmSync(tar, { force: true });
  if (!fs.existsSync(path.join(serverDir, "src", "generate_once.ts"))) {
    throw new Error("pot server source not found after extraction");
  }
  // Script mode only: drop the HTTP server entrypoint (its deps — express,
  // canvas — are intentionally not installed).
  fs.rmSync(path.join(serverDir, "src", "main.ts"), { force: true });
  // Slim package.json: only what generate_once.ts needs.
  fs.writeFileSync(
    path.join(serverDir, "package.json"),
    JSON.stringify(
      { name: "pot-server-slim", private: true, type: "module", dependencies: POT_DEPS },
      null,
      2
    )
  );
  console.log("[fetch-binaries] installing pot server deps (this takes a few minutes)...");
  await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--prefix", serverDir], {
    timeout: 900000,
  });
  console.log("[fetch-binaries] transpiling pot server...");
  await execFileAsync("npx", ["--yes", "-p", "typescript@5", "tsc", "-p", serverDir], {
    timeout: 300000,
  });
  if (!fs.existsSync(scriptOut)) throw new Error("generate_once.js not built");
  // Sanity: the script must answer --version via the same node the plugin will use.
  const { stdout } = await execFileAsync("node", [scriptOut, "--version"], { timeout: 30000 });
  console.log(`[fetch-binaries] pot server OK (provider v${stdout.trim()})`);
}

main().catch((err) => {
  console.error("[fetch-binaries] FAILED:", err.message);
  process.exit(1);
});
