/**
 * Image pipeline for the current-affairs site, running on this worker so
 * Vercel doesn't burn serverless CPU on sharp or wait on the GitHub API.
 * Flow: compress any upload to WebP (max 1600px, q80) -> PUT to the
 * public filestoreapp/images repo -> return a jsDelivr CDN URL pinned
 * to the commit SHA (immutable, never a stale-cache problem).
 *
 * Env: GITHUB_IMAGE_TOKEN (fine-grained PAT, Contents read/write on the
 * images repo only).
 */
import sharp from "sharp";

const REPO = "filestoreapp/images";
const BRANCH = "main";

/** Only these repo prefixes may be written — never let a caller write anywhere else. */
const ALLOWED_PREFIXES = ["images/", "auto-thumbnails/"];

export function isAllowedImagePath(path: string): boolean {
  const clean = path.replace(/^\/+/, "");
  if (clean.includes("..")) return false;
  return ALLOWED_PREFIXES.some((p) => clean.startsWith(p));
}

export async function compressImage(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

function cdnUrl(path: string, commitSha: string) {
  return `https://cdn.jsdelivr.net/gh/${REPO}@${commitSha}/${path}`;
}

export async function uploadToImageCdn(
  buffer: Buffer,
  path: string,
  opts: { upsert?: boolean } = {}
): Promise<string> {
  const token = process.env.GITHUB_IMAGE_TOKEN;
  if (!token) {
    throw new Error("Worker not configured (GITHUB_IMAGE_TOKEN).");
  }
  if (!isAllowedImagePath(path)) {
    throw new Error(`Refusing to write outside allowed image paths: ${path}`);
  }
  const cleanPath = path.replace(/^\/+/, "");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const apiUrl = `https://api.github.com/repos/${REPO}/contents/${cleanPath}`;

  let sha: string | undefined;
  if (opts.upsert) {
    const existing = await fetch(`${apiUrl}?ref=${BRANCH}`, { headers });
    if (existing.ok) {
      sha = (await existing.json()).sha;
    }
  }

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `Upload ${cleanPath}`,
      content: buffer.toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Image upload failed (GitHub ${res.status}): ${body.slice(0, 200)}`);
  }
  const commitSha = (await res.json()).commit.sha as string;
  return cdnUrl(cleanPath, commitSha);
}

/** One call: compress + upload. What the site's admin upload actions use. */
export async function processAndUploadImage(
  input: Buffer,
  path: string,
  opts: { upsert?: boolean } = {}
): Promise<string> {
  const compressed = await compressImage(input);
  return uploadToImageCdn(compressed, path, opts);
}
