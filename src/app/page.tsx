"use client";

import { useState } from "react";

interface ExtractResult {
  platform: "youtube" | "instagram";
  title: string;
  thumbnail: string | null;
  downloadUrl: string;
  qualityLabel: string;
  filename: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/dl/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setResult(data as ExtractResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="wrap">
      <h1 className="title">Video Downloader</h1>
      <p className="subtitle">
        Paste a YouTube or Instagram link, get the video file.
      </p>

      <form onSubmit={handleSubmit} className="form">
        <label htmlFor="dl-url" style={{ display: "none" }}>
          Video link
        </label>
        <input
          id="dl-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://www.youtube.com/watch?v=… or https://www.instagram.com/reel/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="input"
        />
        <button type="submit" disabled={loading || !url.trim()} className="btn">
          {loading ? "Fetching video…" : "Get download link"}
        </button>
      </form>

      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}

      {result && (
        <div className="card">
          {result.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.thumbnail} alt="" />
          )}
          <div className="card-body">
            <div className="badges">
              <span className="badge">{result.platform}</span>
              <span className="badge">{result.qualityLabel}</span>
            </div>
            <p className="card-title">{result.title}</p>
            <a
              href={result.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-download"
            >
              Download video
            </a>
            <p className="tip">
              On Android, if the video opens in the player instead of
              downloading, tap the <strong>⋮</strong> menu in the player and
              choose <strong>Download</strong>. Private posts and stories are
              not supported.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
