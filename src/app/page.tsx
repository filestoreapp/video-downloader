"use client";

import { useEffect, useRef, useState } from "react";

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
  mode: "mp3" | "clip";
  needsTime: boolean;
  quality?: number;
}
type DlOption = DirectOption | ServerOption;

interface ExtractResult {
  ok: true;
  platform: "instagram";
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

type Tab = "video" | "audio" | "photos" | "clip";

const TAB_META: Record<Tab, { icon: string; label: string }> = {
  video: { icon: "🎬", label: "Video" },
  audio: { icon: "🎵", label: "Audio" },
  photos: { icon: "🖼️", label: "Photos" },
  clip: { icon: "✂️", label: "Cut clip" },
};

/** fetch with a hard timeout so a stalled request can never hang the UI. */
async function fetchWithTimeout(input: RequestInfo, init: RequestInit, ms = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function friendlyErr(err: unknown, fallback: string): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return "This is taking too long — the server may be waking up. Please try again.";
  }
  return err instanceof Error ? err.message : fallback;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState<"reading" | "waking">("reading");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [tab, setTab] = useState<Tab>("video");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const [clipStart, setClipStart] = useState("");
  const [clipEnd, setClipEnd] = useState("");
  const [dlTotal, setDlTotal] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Download tracker: total completed downloads, shown as a pill.
  // Hidden entirely when the counter backend isn't configured.
  useEffect(() => {
    fetch("/api/dl/stats")
      .then((r) => r.json())
      .then((d) => {
        if (d.enabled && typeof d.total === "number") setDlTotal(d.total);
      })
      .catch(() => {});
  }, []);

  async function handlePaste() {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) {
        setUrl(t.trim());
        inputRef.current?.focus();
      }
    } catch {
      inputRef.current?.focus();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setError(null);
    setProcError(null);
    setResult(null);
    setClipStart("");
    setClipEnd("");
    setLoading(true);
    setLoadingMsg("reading");
    // If the free-tier instance is asleep, the first request wakes it
    // (~40s). Tell the user what's happening instead of a dead spinner.
    const wakeTimer = setTimeout(() => setLoadingMsg("waking"), 10000);
    // Marker for failures worth one automatic retry: the host's proxy
    // answered instead of the app (plain "error code: 502"), which happens
    // when Instagram briefly throttles the server. Usually clears.
    class TransientError extends Error {}
    async function attemptExtract(): Promise<ExtractResult> {
      const res = await fetchWithTimeout("/api/dl/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      }, 180000); // cold PO-token mint can take ~90s on top of extraction
      // The host can briefly return an HTML error page (e.g. while the
      // free-tier instance wakes from sleep). Parse defensively so the
      // user gets a retry prompt, not a JSON syntax error.
      const text = await res.text();
      let data: { error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        if (/^error code:\s*502/i.test(text.trim()) || res.status === 502 || res.status === 503) {
          throw new TransientError("proxy");
        }
        throw new Error("The server is waking up. Please try again in a few seconds.");
      }
      if (data.error) throw new Error(data.error);
      if (!res.ok) throw new Error("Something went wrong.");
      return data as unknown as ExtractResult;
    }
    try {
      let r: ExtractResult;
      try {
        r = await attemptExtract();
      } catch (err) {
        if (err instanceof TransientError) r = await attemptExtract();
        else throw err;
      }
      setResult(r);
      const first: Tab = r.options.some((o) => o.id.startsWith("video"))
        ? "video"
        : r.options.some((o) => o.id.startsWith("audio"))
          ? "audio"
          : r.options.some((o) => o.id.startsWith("photo"))
            ? "photos"
            : "clip";
      setTab(first);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (err) {
      setError(err instanceof TransientError ? "The source was slow to respond. Please try again." : friendlyErr(err, "Something went wrong."));
    } finally {
      clearTimeout(wakeTimer);
      setLoading(false);
    }
  }

  /** In-app download: the CDN file streams through our server as an
   *  attachment, so it saves to the device instead of opening a new tab. */
  async function downloadDirect(opt: DirectOption) {
    if (busyId) return;
    setProcError(null);
    setBusyId(opt.id);
    try {
      const res = await fetchWithTimeout(
        `/api/dl/fetch?u=${encodeURIComponent(opt.url)}&n=${encodeURIComponent(opt.filename)}`,
        {},
        300000
      );
      if (!res.ok) {
        const text = await res.text();
        let msg = "Download failed. Please try again.";
        try {
          const d = JSON.parse(text);
          if (d.error) msg = d.error;
        } catch {
          msg = "The server is waking up. Please try again in a few seconds.";
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = opt.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setDlTotal((c) => (c === null ? c : c + 1));
    } catch (err) {
      setProcError(friendlyErr(err, "Download failed."));
    } finally {
      setBusyId(null);
    }
  }

  /** Server-rendered option (MP3 / HD video / clip): POST, then save the blob. */
  async function runServerOption(opt: ServerOption, start?: number, end?: number) {
    if (busyId) return;
    setProcError(null);
    setBusyId(opt.id + (start !== undefined ? "-clip" : ""));
    try {
      const res = await fetchWithTimeout(
        "/api/dl/process",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url.trim(),
            mode: opt.mode,
            start,
            end,
          }),
        },
        600000
      );
      if (!res.ok) {
        const text = await res.text();
        let msg = "Processing failed.";
        try {
          const d = JSON.parse(text);
          if (d.error) msg = d.error;
        } catch {
          msg = "The server is waking up. Please try again in a few seconds.";
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filenameFromHeader(res.headers.get("Content-Disposition"), "download");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setDlTotal((c) => (c === null ? c : c + 1));
    } catch (err) {
      setProcError(friendlyErr(err, "Processing failed."));
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

  /** seconds -> "m:ss" for the clip inputs */
  function fmtClock(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** Quick chip: clip of `dur` seconds starting at the current start (or 0). */
  function applyChip(dur: number) {
    const start = parseTime(clipStart) ?? 0;
    if (!clipStart.trim()) setClipStart(fmtClock(start));
    setClipEnd(fmtClock(start + dur));
    setProcError(null);
  }

  function chipLabel(dur: number): string {
    if (dur < 60) return `${dur}s`;
    return `${dur / 60}m`;
  }

  const videos = result?.options.filter((o) => o.id.startsWith("video")) ?? [];
  const audios = result?.options.filter((o) => o.id.startsWith("audio")) ?? [];
  const photos = result?.options.filter((o) => o.id.startsWith("photo")) ?? [];
  const clipOpt = result?.options.find(
    (o): o is ServerOption => o.kind === "server" && o.mode === "clip"
  );
  const tabs: Tab[] = [
    ...(videos.length ? ["video" as Tab] : []),
    ...(audios.length ? ["audio" as Tab] : []),
    ...(photos.length ? ["photos" as Tab] : []),
    ...(clipOpt ? ["clip" as Tab] : []),
  ];

  function focusTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => inputRef.current?.focus(), 350);
  }

  return (
    <div className="page">
      {/* ---------- header ---------- */}
      <header className="topbar">
        <div className="topbar-inner">
          <span className="logo">
            <span className="logo-badge">⬇</span> SnapDown
          </span>
          <div className="platform-chips">
            <span className="pchip ig">◎ Instagram</span>
          </div>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="hero">
        <h1>
          Download Instagram reels, videos <span className="hl">&amp;</span> photos
        </h1>
        <p className="hero-sub">
          Paste an Instagram link below and grab it in seconds — free, no
          sign-up, no watermark.
        </p>

        <form onSubmit={handleSubmit} className="urlbar">
          <span className="urlbar-icon">🔗</span>
          <label htmlFor="dl-url" className="sr">
            Media link
          </label>
          <input
            ref={inputRef}
            id="dl-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="Paste an Instagram link…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {url ? (
            <button type="button" className="urlbar-clear" onClick={() => setUrl("")} aria-label="Clear">
              ✕
            </button>
          ) : (
            <button type="button" className="urlbar-paste" onClick={handlePaste}>
              Paste
            </button>
          )}
          <button type="submit" disabled={loading || !url.trim()} className="urlbar-go">
            {loading ? (
              <>
                <span className="spinner" />{" "}
                {loadingMsg === "waking" ? "Waking up…" : "Reading…"}
              </>
            ) : (
              "Download"
            )}
          </button>
        </form>

        {loading && <LoadingCard waking={loadingMsg === "waking"} />}

        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}

        <div className="trust-row">
          <span>⚡ Instant links</span>
          <span>🎞️ HD quality</span>
          <span>🚫 No watermark</span>
        </div>
        {dlTotal !== null && (
          <p className="dl-count">
            📥 <b>{dlTotal.toLocaleString("en-IN")}</b> downloads so far
          </p>
        )}
      </section>

      {/* ---------- result ---------- */}
      {result && (
        <section ref={resultRef} className="result-wrap">
          <div className="media-card">
            <div className="media-top">
              {result.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.thumbnail} alt="" className="media-thumb" />
              )}
              <div className="media-meta">
                <div className="badges">
                  <span className={`badge ${result.platform}`}>{result.platform}</span>
                  {result.duration != null && (
                    <span className="badge dim">⏱ {fmtDuration(result.duration)}</span>
                  )}
                </div>
                <p className="media-title">{result.title}</p>
              </div>
            </div>

            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={`tab ${tab === t ? "active" : ""}`}
                  onClick={() => {
                    setTab(t);
                    setProcError(null);
                  }}
                >
                  <span className="tab-icon">{TAB_META[t].icon}</span> {TAB_META[t].label}
                </button>
              ))}
            </div>

            <div className="tab-panel">
              {tab === "video" && (
                <FormatRows
                  options={videos}
                  busyId={busyId}
                  onServer={runServerOption}
                  onDirect={downloadDirect}
                  busyLabel="Preparing video…"
                />
              )}
              {tab === "audio" && (
                <FormatRows
                  options={audios}
                  busyId={busyId}
                  onServer={runServerOption}
                  onDirect={downloadDirect}
                  busyLabel="Converting…"
                />
              )}
              {tab === "photos" && <PhotoGrid options={photos} onDirect={downloadDirect} />}
              {tab === "clip" && clipOpt && (
                <div className="clipper">
                  <div className="clip-inputs">
                    <div className="clip-field">
                      <label>Start</label>
                      <input
                        inputMode="numeric"
                        placeholder="2:03"
                        value={clipStart}
                        onChange={(e) => setClipStart(e.target.value)}
                      />
                    </div>
                    <span className="clip-to">→</span>
                    <div className="clip-field">
                      <label>End</label>
                      <input
                        inputMode="numeric"
                        placeholder="2:40"
                        value={clipEnd}
                        onChange={(e) => setClipEnd(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="clip-hint">
                    Times like <b>2:03</b> or <b>1:02:03</b>. Max 10 minutes per clip.
                    {result.duration != null && <> Video length: <b>{fmtDuration(result.duration)}</b>.</>}
                  </p>
                  <div className="chip-row">
                    {[15, 30, 60, 300].map((d) => (
                      <button key={d} type="button" className="chip" onClick={() => applyChip(d)}>
                        ⏱ {chipLabel(d)}
                      </button>
                    ))}
                  </div>
                  <div className="chip-row">
                    <button type="button" className="chip ghost" onClick={() => setClipStart("0:00")}>
                      ⇤ From start
                    </button>
                    <button
                      type="button"
                      className="chip ghost"
                      disabled={result.duration == null}
                      onClick={() => result.duration != null && setClipEnd(fmtClock(result.duration))}
                    >
                      To end ⇥
                    </button>
                  </div>
                  <button
                    className="btn-primary"
                    disabled={busyId !== null}
                    onClick={() => handleClip(clipOpt)}
                  >
                    {busyId === clipOpt.id + "-clip" ? (
                      <>
                        <span className="spinner" /> Cutting clip…
                      </>
                    ) : (
                      "✂️ Cut & download clip"
                    )}
                  </button>
                </div>
              )}
            </div>

            {procError && (
              <div role="alert" className="alert error" style={{ margin: "0 20px 20px" }}>
                {procError}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---------- tools ---------- */}
      <section className="section">
        <h2>Everything in one place</h2>
        <div className="tools-grid">
          {[
            { icon: "🎬", t: "Reel downloader", d: "Save Instagram reels and videos in MP4." },
            { icon: "🎵", t: "MP3 converter", d: "Pull just the audio from any reel as an MP3." },
            { icon: "🖼️", t: "Photo saver", d: "Download full-size photos from Instagram posts." },
            { icon: "✂️", t: "Clip cutter", d: "Cut any moment — 2:03 to 2:40 — and download it." },
          ].map((c) => (
            <button key={c.t} className="tool-card" onClick={focusTop}>
              <span className="tool-icon">{c.icon}</span>
              <span className="tool-title">{c.t}</span>
              <span className="tool-desc">{c.d}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="section">
        <h2>How it works</h2>
        <div className="steps">
          {[
            { n: "1", t: "Paste the link", d: "Copy an Instagram link and paste it above." },
            { n: "2", t: "Pick a format", d: "Choose video, audio, photos — or cut a clip by time." },
            { n: "3", t: "Download", d: "Your file starts downloading instantly. That's it." },
          ].map((s) => (
            <div key={s.n} className="step">
              <span className="step-n">{s.n}</span>
              <div>
                <p className="step-t">{s.t}</p>
                <p className="step-d">{s.d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- faq ---------- */}
      <section className="section">
        <h2>FAQ</h2>
        <div className="faq">
          {[
            {
              q: "Is it free?",
              a: "Yes — everything on this page is free with no sign-up and no watermarks.",
            },
            {
              q: "Which links are supported?",
              a: "Public Instagram reels, videos and photo posts. Private posts, stories and profile photos are not supported.",
            },
            {
              q: "Where do the files go when I tap download?",
              a: "Straight to your device — everything downloads inside this page. Nothing opens in a new tab or another site.",
            },
            {
              q: "Why do MP3s and clips take longer?",
              a: "Videos and photos download instantly. MP3s and clips are prepared on our server first, which takes a little longer.",
            },
            {
              q: "The first visit took a while to load. Why?",
              a: "The site runs on free hosting that sleeps when idle. The first visit wakes it up (about 30–40 seconds); after that it's fast.",
            },
          ].map((f) => (
            <details key={f.q} className="faq-item">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="footer">
        <p>
          <b>SnapDown</b> · Files download straight from the source. Private content
          is not supported.
        </p>
      </footer>
    </div>
  );
}

/** Animated loading state shown while the link is being resolved. */
function LoadingCard({ waking }: { waking: boolean }) {
  const steps = ["Fetching media…", "Reading video info…", "Preparing download options…"];
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (waking) return;
    const t = setInterval(() => setStep((s) => (s + 1) % steps.length), 2200);
    return () => clearInterval(t);
  }, [waking, steps.length]);
  return (
    <div className="loading-card" aria-live="polite" aria-busy="true">
      <div className="load-visual">
        <span className="load-ring" />
        <span className="load-ring r2" />
        <span className="load-arrow">⬇</span>
      </div>
      <p className="load-msg">{waking ? "Waking up the server…" : steps[step]}</p>
      <div className="load-bar">
        <span />
      </div>
      {waking && (
        <p className="wake-hint">
          The free server sleeps when idle — waking it takes about 40 seconds. Hang on…
        </p>
      )}
    </div>
  );
}

/** Rows of download options (video / audio tabs). */
function FormatRows({
  options,
  busyId,
  onServer,
  onDirect,
  busyLabel,
}: {
  options: DlOption[];
  busyId: string | null;
  onServer: (opt: ServerOption) => void;
  onDirect: (opt: DirectOption) => void;
  busyLabel: string;
}) {
  return (
    <div className="fmt-list">
      {options.map((o) =>
        o.kind === "direct" ? (
          <div key={o.id} className="fmt-row">
            <div className="fmt-info">
              <p className="fmt-label">{o.label}</p>
              {o.sub && <p className="fmt-sub">{o.sub}</p>}
            </div>
            <button className="dl-btn" disabled={busyId !== null} onClick={() => onDirect(o)}>
              {busyId === o.id ? (
                <>
                  <span className="spinner" /> Saving…
                </>
              ) : (
                "⬇ Download"
              )}
            </button>
          </div>
        ) : (
          <div key={o.id} className="fmt-row">
            <div className="fmt-info">
              <p className="fmt-label">{o.label}</p>
              {o.sub && <p className="fmt-sub">{o.sub}</p>}
            </div>
            <button className="dl-btn" disabled={busyId !== null} onClick={() => onServer(o)}>
              {busyId === o.id ? (
                <>
                  <span className="spinner" /> {busyLabel}
                </>
              ) : (
                "⬇ Download"
              )}
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** Grid of photo previews with download buttons. */
function PhotoGrid({
  options,
  onDirect,
}: {
  options: DlOption[];
  onDirect: (opt: DirectOption) => void;
}) {
  const photos = options.filter((o): o is DirectOption => o.kind === "direct");
  return (
    <div className="photo-grid">
      {photos.map((o, i) => (
        <button key={o.id} className="photo-tile" onClick={() => onDirect(o)} title={o.label}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={o.url} alt={`Photo ${i + 1}`} loading="lazy" />
          <span className="photo-dl">⬇</span>
        </button>
      ))}
    </div>
  );
}
