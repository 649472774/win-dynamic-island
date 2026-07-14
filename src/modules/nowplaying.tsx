/**
 * P0 — Now Playing (SMTC).
 *
 * Renders the current Windows media session: cover / title / artist / album,
 * a progress bar, and previous / play-pause / next controls. The Rust worker
 * pushes `now-playing-update` events (and answers `get_now_playing` for the
 * first paint); this module keeps a small local store and interpolates the
 * progress bar locally so it advances smoothly between the ~1 Hz updates.
 */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { refreshModuleActivities, registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { bumpModules } from "../store/modules";
import {
  getNowPlaying,
  mediaNext,
  mediaPlayPause,
  mediaPrevious,
  mediaSeek,
  onNowPlaying,
  type NowPlaying,
} from "../lib/native";

const EMPTY: NowPlaying = {
  hasSession: false,
  title: "",
  artist: "",
  album: "",
  status: "none",
  canNext: false,
  canPrevious: false,
  canPlayPause: false,
  canSeek: false,
  positionMs: 0,
  durationMs: 0,
  updatedAtMs: 0,
  trackId: "",
  coverChanged: true,
  cover: null,
};

/**
 * Now Playing owns the collapsed pill only while music is actually *playing*.
 * A paused session — whether an intentional pause, or a player that was
 * "closed" but left a lingering paused SMTC session behind (many music apps
 * minimize to a background/tray process that keeps its session in "Paused") —
 * should yield back to the clock instead of hogging the island forever. We keep
 * the pill for a short grace period after playback stops so quick pauses / gaps
 * between tracks don't flap the pill to the clock and back.
 */
const STOP_GRACE_MS = 6000;

function isPlaying(np: NowPlaying): boolean {
  return np.hasSession && np.status === "playing";
}

/** Pending "yield back to the clock" timer, armed when playback stops. */
let graceTimer: ReturnType<typeof setTimeout> | undefined;

interface NPStore {
  np: NowPlaying;
  /** Retained cover art (updates only carry the blob when the track changes). */
  cover: string | null;
  /**
   * Whether `cover` has been confirmed decodable. We validate every new cover
   * with an off-screen `Image()` and only flip this true once it loads, so the
   * visible <img> is never mounted with an undecodable src (which WebView2 would
   * render as the "broken image" glyph). This also sidesteps a Chromium quirk
   * where a re-mounted <img> for an already-cached decode failure never fires
   * `onError`, leaving the broken glyph stuck on screen.
   */
  coverOk: boolean;
  /** Whether Now Playing currently owns the collapsed pill. */
  active: boolean;
  apply: (next: NowPlaying) => void;
}

/**
 * Validate a cover data-URL off-screen; publish `coverOk` only when it decodes.
 * A monotonic token guards against out-of-order results when covers change fast.
 */
let coverToken = 0;
function validateCover(url: string | null): void {
  const token = ++coverToken;
  if (!url) {
    useNP.setState({ coverOk: false });
    return;
  }
  const probe = new Image();
  const settle = (ok: boolean) => {
    if (token === coverToken) useNP.setState({ coverOk: ok });
  };
  probe.onload = () => settle(probe.naturalWidth > 0);
  probe.onerror = () => settle(false);
  probe.src = url;
  // A cached data-URL may already be resolved synchronously; catch that too.
  if (probe.complete) settle(probe.naturalWidth > 0);
}

const useNP = create<NPStore>((set, get) => ({
  np: EMPTY,
  cover: null,
  coverOk: false,
  active: false,
  apply: (next) => {
    const prevActive = get().active;
    const prevCover = get().cover;
    const cover = next.coverChanged ? next.cover : prevCover;
    const coverChanged = cover !== prevCover;

    let active: boolean;
    if (isPlaying(next)) {
      // Playing → take/keep the pill immediately; cancel any pending yield.
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      active = true;
    } else if (prevActive) {
      // Was showing music, now paused / stopped / gone: hold the pill briefly,
      // then fall back to the clock unless playback resumes within the grace.
      active = true;
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          if (!isPlaying(get().np)) {
            set({ active: false });
            refreshModuleActivities("now-playing");
            bumpModules();
          }
        }, STOP_GRACE_MS);
      }
    } else {
      // Not playing and we weren't showing music → stay on the clock. Also
      // covers startup with a lingering paused session (no pill takeover).
      active = false;
    }

    // On a cover change, drop to the placeholder immediately (coverOk=false) and
    // re-validate; the probe flips coverOk back on once the new art decodes.
    set({ np: next, cover, active, coverOk: coverChanged ? false : get().coverOk });
    if (coverChanged) validateCover(cover);
    // Flip the collapsed-pill owner as soon as activeness changes.
    if (prevActive !== active) {
      refreshModuleActivities("now-playing");
      bumpModules();
    }
  },
}));

// One-time bootstrap on import: seed the initial snapshot, then subscribe.
let started = false;
function ensureStarted(): void {
  if (started) return;
  started = true;
  void getNowPlaying()
    .then((np) => useNP.getState().apply(np))
    .catch(() => {});
  void onNowPlaying((np) => useNP.getState().apply(np));
}
ensureStarted();

/** Current position with local interpolation applied (smooth progress bar). */
function liveMs(np: NowPlaying): number {
  const delta = np.status === "playing" ? Date.now() - np.updatedAtMs : 0;
  const v = np.positionMs + Math.max(0, delta);
  if (np.durationMs > 0) return Math.min(v, np.durationMs);
  return Math.max(0, v);
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Wrap a control so clicking it doesn't also toggle the island expand/collapse. */
function control(fn: () => Promise<void>) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    void fn().catch(() => {});
  };
}

/**
 * Interactive seek bar. Shows the current position, total duration, and — when
 * the session reports it's seekable — a draggable thumb that lets the user
 * scrub. While dragging we optimistically show the scrubbed position, then send
 * the seek to Rust on release. All pointer/click events stop propagation so a
 * scrub never bubbles up to the pill's expand/collapse toggle.
 */
function ProgressBar({ np }: { np: NowPlaying }) {
  const dur = np.durationMs;
  const seekable = np.canSeek && dur > 0;
  const barRef = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);

  const pos = scrub != null ? scrub : liveMs(np);
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;

  const posFromClientX = (clientX: number): number => {
    const el = barRef.current;
    if (!el || dur <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.min(dur, Math.max(0, frac * dur));
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!seekable) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setScrub(posFromClientX(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (scrub == null) return;
    e.stopPropagation();
    setScrub(posFromClientX(e.clientX));
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    if (scrub == null) return;
    e.stopPropagation();
    const target = scrub;
    setScrub(null);
    void mediaSeek(target).catch(() => {});
  };

  return (
    <div className="np-progress">
      <span className="np-time np-time-l">{fmt(pos)}</span>
      <div
        ref={barRef}
        className={`np-bar${seekable ? " seekable" : ""}${scrub != null ? " dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="np-bar-track">
          <div className="np-bar-fill" style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        {seekable ? (
          <div className="np-bar-thumb" style={{ left: `${pct}%` }} />
        ) : null}
      </div>
      <span className="np-time np-time-r">{dur > 0 ? fmt(dur) : "--:--"}</span>
    </div>
  );
}

/**
 * Cover art with a graceful fallback to a music note. Rendering is gated on the
 * store's `coverOk` flag (set by an off-screen probe in `validateCover`), so the
 * visible <img> is only ever mounted with a src we've confirmed decodes — the
 * browser's broken-image glyph can never appear, for any player.
 */
function CoverArt({
  cover,
  coverOk,
  variant,
}: {
  cover: string | null;
  coverOk: boolean;
  variant: "mini" | "full";
}) {
  const imgClass = variant === "mini" ? "np-cover-mini" : "np-cover";
  if (cover && coverOk) {
    return (
      <img
        className={imgClass}
        src={cover}
        alt=""
        // Belt-and-suspenders: if a validated image ever fails at paint, drop
        // back to the placeholder instead of showing a broken glyph.
        onError={() => useNP.setState({ coverOk: false })}
      />
    );
  }
  return variant === "mini" ? (
    <span className="np-icon" aria-hidden="true">
      🎵
    </span>
  ) : (
    <div className="np-cover np-cover-empty" aria-hidden="true">
      🎵
    </div>
  );
}

function CollapsedNowPlaying(_: IslandModuleProps) {
  const np = useNP((s) => s.np);
  const cover = useNP((s) => s.cover);
  const coverOk = useNP((s) => s.coverOk);
  return (
    <div className="mod-np-collapsed">
      <CoverArt cover={cover} coverOk={coverOk} variant="mini" />
      <span className="np-title-mini">{np.title || "正在播放"}</span>
      {np.status === "playing" ? (
        <span className="np-eq" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </div>
  );
}

/* Rounded transport icons (borderless, round-joined strokes) — replaces the
   emoji glyphs so the buttons match the island's glass style. Side buttons use
   the 22px set; the main play/pause uses the larger 30px set (V5 size hierarchy). */
function IconPrev() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <rect x="5.4" y="5.5" width="2.6" height="13" rx="1.3" stroke="none" />
      <path d="M19 6.4 L10 12 L19 17.6 Z" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M5 6.4 L14 12 L5 17.6 Z" />
      <rect x="16" y="5.5" width="2.6" height="13" rx="1.3" stroke="none" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M8 5.5 L18.5 12 L8 18.5 Z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.6" y="5.2" width="3.6" height="13.6" rx="1.8" />
      <rect x="13.8" y="5.2" width="3.6" height="13.6" rx="1.8" />
    </svg>
  );
}

function ExpandedNowPlaying({ state }: IslandModuleProps) {
  const np = useNP((s) => s.np);
  const cover = useNP((s) => s.cover);
  const coverOk = useNP((s) => s.coverOk);
  const expanded = state === "expanded";

  // Re-render a few times a second for a smooth bar — but only while the panel
  // is open and actually playing, so idle CPU stays at zero.
  const [, force] = useState(0);
  useEffect(() => {
    if (!expanded || np.status !== "playing") return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [expanded, np.status, np.trackId]);

  const playing = np.status === "playing";

  return (
    <div className="mod-np-expanded">
      <div className="np-main">
        <CoverArt cover={cover} coverOk={coverOk} variant="full" />
        {/* Right column beside the art: metadata on top, transport controls
            below — fills the previously-empty space to the right of the cover. */}
        <div className="np-side">
          <div className="np-meta">
            <div className="np-title" title={np.title}>
              {np.title || "未在播放"}
            </div>
            <div className="np-artist" title={np.artist}>
              {np.artist || (np.hasSession ? "" : "打开任意播放器试试")}
            </div>
          </div>

          <div className="np-controls">
            <button
              className="np-btn"
              disabled={!np.canPrevious}
              onClick={control(mediaPrevious)}
              aria-label="上一首"
            >
              <IconPrev />
            </button>
            <button
              className="np-btn np-btn-main"
              disabled={!np.canPlayPause}
              onClick={control(mediaPlayPause)}
              aria-label={playing ? "暂停" : "播放"}
            >
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <button
              className="np-btn"
              disabled={!np.canNext}
              onClick={control(mediaNext)}
              aria-label="下一首"
            >
              <IconNext />
            </button>
          </div>
        </div>
      </div>

      <ProgressBar np={np} />
    </div>
  );
}

registerModule({
  id: "now-playing",
  title: "正在播放",
  // Above the clock (10) so music owns the collapsed pill while it's active.
  priority: 100,
  icon: "♪",
  channel: "ongoing",
  Collapsed: CollapsedNowPlaying,
  Expanded: ExpandedNowPlaying,
  isActive: () => useNP.getState().active,
});
