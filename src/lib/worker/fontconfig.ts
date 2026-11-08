/**
 * Vendored Malayalam font for server-side SVG thumbnail rendering.
 *
 * The Koyeb container has no Malayalam glyphs, so sharp/librsvg rendered
 * every Malayalam title as tofu boxes (found 2026-10-12: all 140
 * all-Malayalam evergreen thumbnails were broken). This module registers
 * the repo-vendored Noto Sans Malayalam with fontconfig at startup via
 * FONTCONFIG_PATH (additive — system fonts keep working, so English
 * rendering is unaffected).
 *
 * Import this module for its side effect before any sharp SVG render:
 *   import "./fontconfig";
 * (fontconfig initializes lazily on first use, so setting the env var at
 * module load is early enough.)
 */
import fs from "fs";
import os from "os";
import path from "path";

const FONT_FILE = "NotoSansMalayalam-VF.ttf";

let registered = false;

export function ensureMalayalamFont(): void {
  if (registered) return;
  registered = true;
  try {
    const fontsDir = path.join(process.cwd(), "fonts");
    if (!fs.existsSync(path.join(fontsDir, FONT_FILE))) return;
    const confDir = path.join(os.tmpdir(), "ca-fontconfig");
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(
      path.join(confDir, "10-malayalam.conf"),
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${fontsDir}</dir>\n</fontconfig>\n`
    );
    const cur = (process.env.FONTCONFIG_PATH || "").split(":").filter(Boolean);
    if (!cur.includes(confDir)) {
      process.env.FONTCONFIG_PATH = [...cur, confDir].join(":");
    }
  } catch {
    // Non-fatal: thumbnails fall back to the previous behavior.
  }
}

ensureMalayalamFont();
