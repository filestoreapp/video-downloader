# Video Downloader

Personal tool: paste a YouTube or Instagram link, get the video file.

- YouTube: resolved via the Innertube player API (Android client) — pure JS, no binary.
- Instagram: resolved with the yt-dlp standalone binary (fetched at install time by `scripts/fetch-ytdlp.mjs`, never committed).

The browser downloads straight from the video CDN (googlevideo / fbcdn) — no video bytes pass through the host.

Deploys on Vercel as-is. The page is `noindex` + `robots.txt` disallows everything (personal tool, not for search engines).
