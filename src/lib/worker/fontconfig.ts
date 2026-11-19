/**
 * Vendored Malayalam font for server-side SVG thumbnail rendering.
 *
 * The Koyeb container has no Malayalam glyphs, so sharp/librsvg rendered
 * every Malayalam title as tofu boxes. This module registers the
 * repo-vendored Noto Sans Malayalam with fontconfig at startup.
 *
 * How: write a small fonts.conf that <include>s the system config (so
 * system fonts keep working and English rendering is unaffected) and adds
 * ./fonts as an extra font dir, then point FONTCONFIG_FILE at it.
 *
 * Fixed 2026-11-19: the first version only added a directory holding
 * "10-malayalam.conf" to FONTCONFIG_PATH. fontconfig only loads
 * "fonts.conf" from FONTCONFIG_PATH, so that file was never read and
 * thumbnails stayed tofu. FONTCONFIG_FILE with an absolute path is what
 * actually takes effect.
 *
 * Import this module for its side effect before any sharp SVG render:
 *   import "./fontconfig";
 * (fontconfig initializes lazily on the first text render, so setting the
 * env var at module load is early enough.)
 */
import fs from "fs";
import os from "os";
import path from "path";

const FONT_FILE = "NotoSansMalayalam-VF.ttf";
const SYSTEM_CONF_CANDIDATES = ["/etc/fonts/fonts.conf", "/usr/local/etc/fonts/fonts.conf"];
// Safety net in case the system fonts.conf lives elsewhere: scan the usual
// system font dirs directly too (missing dirs are ignored by fontconfig).
const SYSTEM_FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts"];

let registered = false;

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ensureMalayalamFont(): void {
  if (registered) return;
  registered = true;
  try {
    const fontsDir = path.join(process.cwd(), "fonts");
    if (!fs.existsSync(path.join(fontsDir, FONT_FILE))) return;
    const confDir = path.join(os.tmpdir(), "ca-fontconfig");
    const confFile = path.join(confDir, "fonts.conf");
    if (process.env.FONTCONFIG_FILE === confFile) return;
    fs.mkdirSync(path.join(confDir, "cache"), { recursive: true });

    // Chain to whatever config would otherwise have been used.
    const prev = process.env.FONTCONFIG_FILE;
    const base = prev && path.isAbsolute(prev) ? [prev] : SYSTEM_CONF_CANDIDATES;
    const includes = base
      .map((p) => `  <include ignore_missing="yes">${xmlEsc(p)}</include>`)
      .join("\n");

    fs.writeFileSync(
      confFile,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${includes}\n${SYSTEM_FONT_DIRS.map((d) => `  <dir>${xmlEsc(d)}</dir>`).join("\n")}\n  <dir>${xmlEsc(fontsDir)}</dir>\n  <cachedir>${xmlEsc(path.join(confDir, "cache"))}</cachedir>\n</fontconfig>\n`
    );
    process.env.FONTCONFIG_FILE = confFile;
  } catch {
    // Non-fatal: thumbnails fall back to the previous behavior.
  }
}

ensureMalayalamFont();
