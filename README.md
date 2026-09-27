# Media Downloader

Personal all-in-one toolkit: paste a YouTube or Instagram link and get downloads.

**YouTube**
- Video (MP4) — resolved via the Innertube player API (Android client), pure JS; falls back to yt-dlp if needed
- Audio — M4A direct download, or MP3 converted on the server
- Cut a clip — pick start & end times (e.g. 2:03 to 2:40)

**Instagram**
- Reels / videos (MP4), photo posts & carousels (direct image downloads)
- Audio MP3 from reels, clip cutting for videos

**How it works**
- `scripts/fetch-binaries.mjs` (postinstall) downloads the yt-dlp and ffmpeg
  static binaries into `./bin/` — never committed to git.
- `POST /api/dl/extract` resolves a link into download options.
- Direct options are CDN URLs — the browser downloads straight from
  googlevideo / fbcdn, so no media bytes pass through the host.
- `POST /api/dl/process` renders MP3s and clips on the host with ffmpeg
  (streamed back, nothing stored).

**Deploy (Koyeb)**
- Node web service, build: `npm install && npm run build`, run: `npm start`, port `3000`.
- No env vars needed.

The page is `noindex` + `robots.txt` disallows everything (personal tool, not for search engines).
