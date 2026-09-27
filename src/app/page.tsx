"use client";

import { useState } from "react";

interface DirectOption {
  kind: "direct";
  id: string;
  label: string;
  sub?: string;
  url: string;
  filename: string;
}
interface ServerOption {
  kind: "server";
  id: string;
  label: string;
  sub?: string;
  mode: "mp3" | "clip" | "fullvideo";
  needsTime: boolean;
}
type DlOption = DirectOption | ServerOption;

interface ExtractResult {
  ok: true;
  platform: "youtube" | "instagram";
  title: string;
  thumbnail: string | null;
  duration: number | null;
  options: DlOption[];
}

/** "2:03" / "1:02:03" / "90" -> seconds */
function parseTime(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function filenameFromHeader(header: string | null, fallback: string): string {
  if (header) {
    const m = header.match(/filename\*=UTF-8''([^;]+)/i) || header.match(/filename="([^"]+)"/i);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
  }
  return fallback;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const [clipStart, setClipStart] = useState("");
  const [clipEnd, setClipEnd] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setError(null);
    setProcError(null);
    setResult(null);
    setClipStart("");
    setClipEnd("");
    setLoading(true);
    try {
      const res = await fetch("/api/dl/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      // The host can briefly return an HTML error page (e.g. while the
      // free-tier instance wakes from sleep). Parse defensively so the
      // user gets a retry prompt, not a JSON syntax error.
      const text = await res.text();
      let data: { error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("The server is waking up. Please try again in a few seconds.");
      }
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setResult(data as ExtractResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  /** Server-rendered option (MP3 / full video): POST, then save the blob. */
  async function runServerOption(opt: ServerOption, start?: number, end?: number) {
    if (busyId) return;
    setProcError(null);
    setBusyId(opt.id + (start !== undefined ? "-clip" : ""));
    try {
      const res = await fetch("/api/dl/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), mode: opt.mode, start, end }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Processing failed.");
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filenameFromHeader(res.headers.get("Content-Disposition"), "download");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      setProcError(err instanceof Error ? err.message : "Processing failed.");
    } finally {
      setBusyId(null);
    }
  }

  function handleClip(opt: ServerOption) {
    const start = parseTime(clipStart);
    const end = parseTime(clipEnd);
    if (start == null || end == null) {
      setProcError("Enter start and end times like 2:03 and 2:40.");
      return;
    }
    if (end <= start) {
      setProcError("End time must be after start time.");
      return;
    }
    if (end - start > 600) {
      setProcError("Clips are limited to 10 minutes.");
      return;
    }
    runServerOption(opt, Math.floor(start), Math.ceil(end));
  }

  const videos = result?.options.filter((o) => o.id.startsWith("video")) ?? [];
  const audios = result?.options.filter((o) => o.id.startsWith("audio")) ?? [];
  const photos = result?.options.filter((o) => o.id.startsWith("photo")) ?? [];
  const clipOpt = result?.options.find((o): o is ServerOption => o.kind === "server" && o.mode === "clip");

  return (
    <main className="wrap">
      <h1 className="title">Media Downloader</h1>
      <p className="subtitle">YouTube &amp; Instagram — video, audio, photos, clips.</p>

      <form onSubmit={handleSubmit} className="form">
        <label htmlFor="dl-url" style={{ display: "none" }}>
          Media link
        </label>
        <input
          id="dl-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="Paste a YouTube or Instagram link…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="input"
        />
        <button type="submit" disabled={loading || !url.trim()} className="btn">
          {loading ? "Reading link…" : "Get downloads"}
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
              {result.duration != null && (
                <span className="badge">{fmtDuration(result.duration)}</span>
              )}
            </div>
            <p className="card-title">{result.title}</p>

            {videos.length > 0 && (
              <div className="opt-section">
                <p className="opt-heading">Video</p>
                <div className="opt-list">
                  {videos.map((o) =>
                    o.kind === "direct" ? (
                      <a
                        key={o.id}
                        href={o.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="opt-btn primary"
                      >
                        <span>
                          {o.label}
                          {o.sub && <span className="sub">{o.sub}</span>}
                        </span>
                        <span className="arrow">↓</span>
                      </a>
                    ) : (
                      <button
                        key={o.id}
                        className="opt-btn primary"
                        disabled={busyId !== null}
                        onClick={() => runServerOption(o)}
                      >
                        <span>
                          {busyId === o.id ? (
                            <>
                              <span className="spinner" /> Preparing video…
                            </>
                          ) : (
                            o.label
                          )}
                          {o.sub && busyId !== o.id && <span className="sub">{o.sub}</span>}
                        </span>
                        <span className="arrow">↓</span>
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {audios.length > 0 && (
              <div className="opt-section">
                <p className="opt-heading">Audio</p>
                <div className="opt-list">
                  {audios.map((o) =>
                    o.kind === "direct" ? (
                      <a
                        key={o.id}
                        href={o.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="opt-btn"
                      >
                        <span>
                          {o.label}
                          {o.sub && <span className="sub">{o.sub}</span>}
                        </span>
                        <span className="arrow">↓</span>
                      </a>
                    ) : (
                      <button
                        key={o.id}
                        className="opt-btn"
                        disabled={busyId !== null}
                        onClick={() => runServerOption(o)}
                      >
                        <span>
                          {busyId === o.id ? (
                            <>
                              <span className="spinner" /> Converting…
                            </>
                          ) : (
                            o.label
                          )}
                          {o.sub && busyId !== o.id && <span className="sub">{o.sub}</span>}
                        </span>
                        <span className="arrow">↓</span>
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {photos.length > 0 && (
              <div className="opt-section">
                <p className="opt-heading">Photos</p>
                <div className="opt-list">
                  {photos.map(
                    (o) =>
                      o.kind === "direct" && (
                        <a
                          key={o.id}
                          href={o.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="opt-btn"
                        >
                          <span>{o.label}</span>
                          <span className="arrow">↓</span>
                        </a>
                      )
                  )}
                </div>
              </div>
            )}

            {clipOpt && (
              <div className="opt-section">
                <p className="opt-heading">Cut a clip</p>
                <div className="clip-box">
                  <div className="clip-row">
                    <input
                      className="clip-input"
                      inputMode="numeric"
                      placeholder="2:03"
                      aria-label="Clip start time"
                      value={clipStart}
                      onChange={(e) => setClipStart(e.target.value)}
                    />
                    <span className="clip-sep">to</span>
                    <input
                      className="clip-input"
                      inputMode="numeric"
                      placeholder="2:40"
                      aria-label="Clip end time"
                      value={clipEnd}
                      onChange={(e) => setClipEnd(e.target.value)}
                    />
                  </div>
                  <p className="clip-hint">
                    Times like 2:03 or 1:02:03. Max 10 minutes per clip.
                    {result.duration != null && ` Video length: ${fmtDuration(result.duration)}.`}
                  </p>
                  <button
                    className="btn"
                    style={{ marginTop: 12 }}
                    disabled={busyId !== null}
                    onClick={() => handleClip(clipOpt)}
                  >
                    {busyId === clipOpt.id + "-clip" ? (
                      <>
                        <span className="spinner" /> Cutting clip…
                      </>
                    ) : (
                      "Cut & download"
                    )}
                  </button>
                </div>
              </div>
            )}

            {procError && (
              <div role="alert" className="error">
                {procError}
              </div>
            )}

            <p className="tip">
              Video, audio (M4A) and photos download straight from the source —
              instant. MP3 and clips are prepared on the server, so they take a
              few seconds. Private posts and stories are not supported.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
