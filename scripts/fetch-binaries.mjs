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

  // 1. yt-dlp plugin (release zip). We extract it to pot-plugins/bgutil/ and
  // patch it: yt-dlp discovers plugins from any direct child of --plugin-dirs
  // that contains a yt_dlp_plugins/ package (zip or directory — see
  // yt_dlp/plugins.py candidate_plugin_paths). A directory lets us patch the
  // sources with plain string replaces (no zip tool needed on the builder).
  // Patch: _GETPOT_TIMEOUT 20s -> 90s. The token-minting node script needs
  // ~13s for a warm mint on fast hardware; on Koyeb's throttled free-tier CPU
  // a cold mint can take far longer than 20s.
  const pluginDir = path.join(rootDir, "pot-plugins");
  const extractedDir = path.join(pluginDir, "bgutil");
  const pluginZip = path.join(pluginDir, "bgutil-ytdlp-pot-provider.zip");
  const patchedMarker = path.join(extractedDir, ".patched");
  if (fs.existsSync(patchedMarker)) {
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
    // Extract (python3 is present on the builder; fall back to keeping the
    // zip unpatched if it isn't).
    let extracted = false;
    try {
      await execFileAsync(
        "python3",
        [
          "-c",
          "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
          pluginZip,
          extractedDir,
        ],
        { timeout: 60000 }
      );
      extracted = true;
    } catch {
      console.log("[fetch-binaries] python3 unavailable, keeping plugin zip as-is");
    }
    if (extracted) {
      const base = path.join(extractedDir, "yt_dlp_plugins", "extractor", "getpot_bgutil.py");
      let src = fs.readFileSync(base, "utf8");
      if (!src.includes("_GETPOT_TIMEOUT = 20.0")) {
        throw new Error("plugin source changed upstream (timeout constant not found)");
      }
      src = src.replace("_GETPOT_TIMEOUT = 20.0", "_GETPOT_TIMEOUT = 90.0");
      fs.writeFileSync(base, src);
      fs.rmSync(pluginZip); // avoid double-loading the same plugin from zip+dir
      console.log("[fetch-binaries] pot plugin extracted + patched (mint timeout 90s)");
    } else {
      console.log("[fetch-binaries] pot plugin downloaded (zip, unpatched)");
    }
    fs.writeFileSync(patchedMarker, "ok");
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
      { name: "pot-server-slim", version: POT_VERSION, private: true, type: "module", dependencies: POT_DEPS },
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
  // The yt-dlp plugin probes the script with `node generate_once.js --version`
  // under a HARDCODED 15s timeout, and skips the provider entirely if it
  // doesn't answer in time. The compiled script imports youtubei.js + jsdom at
  // module load, which blows past 15s on Koyeb's throttled free-tier CPU.
  // Fix: swap in a featherweight wrapper under the same file name (the plugin
  // requires the basename generate_once.js). It answers --version instantly
  // and delegates every real invocation to the compiled script.
  const realScript = path.join(serverDir, "build", "generate_once.real.js");
  fs.renameSync(scriptOut, realScript);
  fs.renameSync(scriptOut + ".map", realScript + ".map");
  fs.writeFileSync(
    scriptOut,
    `#!/usr/bin/env node
// Lightweight wrapper: instant --version (the yt-dlp plugin probes this under
// a hardcoded 15s timeout), delegate everything else to the real script.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "..", "package.json"), "utf8"));
    console.log(pkg.version || "${POT_VERSION}");
  } catch {
    console.log("${POT_VERSION}");
  }
  process.exit(0);
}
const r = spawnSync(process.execPath, [path.join(dir, "generate_once.real.js"), ...args], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
`
  );
  fs.chmodSync(scriptOut, 0o755);
  console.log("[fetch-binaries] pot script wrapped (instant --version)");
  // Sanity: the script must answer --version via the same node the plugin will use.
  const { stdout } = await execFileAsync("node", [scriptOut, "--version"], { timeout: 30000 });
  console.log(`[fetch-binaries] pot server OK (provider v${stdout.trim()})`);
}

main().catch((err) => {
  console.error("[fetch-binaries] FAILED:", err.message);
  process.exit(1);
});
