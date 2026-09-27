import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ytDlpPotArgs } from "@/lib/video-extract";

const execFileAsync = promisify(execFile);

// Temporary diagnostics for the PO-token rollout. Reports whether the
// postinstall artifacts exist and how the plugin probe behaves.
// ?url=<video-url> runs the exact yt-dlp fallback command and returns stderr.
export async function GET(req: Request) {
  const root = process.cwd();
  const out: Record<string, unknown> = { root, node: process.version };
  const t = async (label: string, fn: () => Promise<unknown>) => {
    const start = Date.now();
    try {
      out[label] = { ok: true, ms: Date.now() - start, result: await fn() };
    } catch (e) {
      out[label] = { ok: false, ms: Date.now() - start, error: String(e).slice(0, 200) };
    }
  };
  const bin = path.join(root, "bin", "yt-dlp");
  await t("ytdlp_exists", async () => fs.existsSync(bin));
  await t("ytdlp_version", async () => {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 15000 });
    return stdout.trim();
  });
  const plugPy = path.join(root, "pot-plugins", "bgutil", "yt_dlp_plugins", "extractor", "getpot_bgutil.py");
  await t("plugin_py_exists", async () => fs.existsSync(plugPy));
  await t("plugin_timeout", async () =>
    fs.existsSync(plugPy)
      ? (fs.readFileSync(plugPy, "utf8").match(/_GETPOT_TIMEOUT = ([\d.]+)/) || [])[1] || "?"
      : "missing"
  );
  const script = path.join(root, "pot-server", "build", "generate_once.js");
  await t("script_exists", async () => fs.existsSync(script));
  await t("script_version_ms", async () => {
    const s = Date.now();
    const { stdout } = await execFileAsync("node", [script, "--version"], { timeout: 20000 });
    return `${stdout.trim()} in ${Date.now() - s}ms`;
  });
  await t("real_script_help", async () => {
    // Exercises the REAL script (all heavy imports). If the slim npm
    // install is broken this fails fast with MODULE_NOT_FOUND instead.
    const s = Date.now();
    try {
      const { stdout } = await execFileAsync(
        "node", [path.join(root, "pot-server", "build", "generate_once.real.js"), "--help"],
        { timeout: 90000 }
      );
      return `imports OK in ${Date.now() - s}ms, help lines: ${stdout.split("\n").length}`;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return `IMPORT FAIL in ${Date.now() - s}ms: ${String(err.stderr ?? err.message).slice(0, 400).replace(/\n/g, " | ")}`;
    }
  });
  await t("plugin_load", async () => {
    const { stdout, stderr } = await execFileAsync(
      bin,
      [
        "--plugin-dirs", path.join(root, "pot-plugins"),
        "--extractor-args", `youtubepot-bgutilscript:server_home=${path.join(root, "pot-server")}`,
        "--verbose", "--no-download", "--print", "%(title)s",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      ],
      { timeout: 60000 }
    );
    const potLines = (stdout + stderr).split("\n").filter((l) => /pot/i.test(l)).slice(0, 6);
    return potLines;
  });
  const testUrl = new URL(req.url).searchParams.get("url");
  if (testUrl && /^https?:\/\//.test(testUrl)) {
    await t("extract_stderr", async () => {
      try {
        const { stdout } = await execFileAsync(
          bin,
          [
            ...ytDlpPotArgs(),
            "--verbose", "--no-download", "--no-warnings", "-j", testUrl,
          ],
          { timeout: 150000, maxBuffer: 32 * 1024 * 1024 }
        );
        const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
        return line ? `OK title=${JSON.parse(line).title?.slice(0, 60)}` : "OK but no JSON";
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        const lines = String(err.stderr ?? err.message).split("\n");
        const kept = lines.filter((l) => /pot|PO Token|provider|generate_once|node|fetch_pot|Fetching|token/i.test(l));
        return `FAIL: args=${JSON.stringify(ytDlpPotArgs())} kept=${JSON.stringify(kept.slice(0, 25))} tail=${lines.slice(-3).join(" | ").slice(0, 500)}`;
      }
    });
  }
  return NextResponse.json(out);
}
