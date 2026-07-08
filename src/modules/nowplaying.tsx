/**
 * P0 — Now Playing (SMTC).
 *
 * Renders the current Windows media session: cover / title / artist / album,
 * a progress bar, and previous / play-pause / next controls. The Rust worker
 * pushes `now-playing-update` events (and answers `get_now_playing` for the
 * first paint); this module keeps a small local store and interpolates the
 * progress bar locally so it advances smoothly between the ~1 Hz updates.
 */
import { useEffect, useState, type MouseEvent } from "react";
import { create } from "zustand";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { bumpModules } from "../store/modules";
import {
  getNowPlaying,
  mediaNext,
  mediaPlayPause,
  mediaPrevious,
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
  /** Whether Now Playing currently owns the collapsed pill. */
  active: boolean;
  apply: (next: NowPlaying) => void;
}

const useNP = create<NPStore>((set, get) => ({
  np: EMPTY,
  cover: null,
  active: false,
  apply: (next) => {
    const prevActive = get().active;
    const cover = next.coverChanged ? next.cover : get().cover;

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
            bumpModules();
          }
        }, STOP_GRACE_MS);
      }
    } else {
      // Not playing and we weren't showing music → stay on the clock. Also
      // covers startup with a lingering paused session (no pill takeover).
      active = false;
    }

    set({ np: next, cover, active });
    // Flip the collapsed-pill owner as soon as activeness changes.
    if (prevActive !== active) bumpModules();
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
 * Cover art with a graceful fallback. Some players expose a thumbnail reference
 * that yields no (or a transient / malformed) image; rather than show the
 * browser's broken-image glyph we fall back to a music note. `key={cover}`
 * resets the failure flag whenever the art changes.
 */
function CoverArt({ cover, variant }: { cover: string | null; variant: "mini" | "full" }) {
  const [failed, setFailed] = useState(false);
  // A new cover URL deserves a fresh attempt. Without this, once `failed` latches
  // (e.g. a transient/corrupt thumbnail at a track switch), the fallback branch is
  // shown and the keyed <img> never re-mounts — so the collapsed mini icon stays
  // stuck on 🎵 even after real art arrives, until the whole component re-mounts
  // (which only happened via expand→collapse). Resetting on `cover` change makes it self-heal.
  useEffect(() => {
    setFailed(false);
  }, [cover]);
  const imgClass = variant === "mini" ? "np-cover-mini" : "np-cover";
  if (cover && !failed) {
    return (
      <img
        key={cover}
        className={imgClass}
        src={cover}
        alt=""
        onError={() => setFailed(true)}
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
  return (
    <div className="mod-np-collapsed">
      <CoverArt cover={cover} variant="mini" />
      <span className="np-title-mini">{np.title || "正在播放"}</span>
      {np.status === "playing" ? (
        <span className="np-eq" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </div>
  );
}

function ExpandedNowPlaying({ state }: IslandModuleProps) {
  const np = useNP((s) => s.np);
  const cover = useNP((s) => s.cover);
  const expanded = state === "expanded";

  // Re-render a few times a second for a smooth bar — but only while the panel
  // is open and actually playing, so idle CPU stays at zero.
  const [, force] = useState(0);
  useEffect(() => {
    if (!expanded || np.status !== "playing") return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [expanded, np.status, np.trackId]);

  const pos = liveMs(np);
  const dur = np.durationMs;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const playing = np.status === "playing";

  return (
    <div className="mod-np-expanded">
      <div className="np-main">
        <CoverArt cover={cover} variant="full" />
        <div className="np-meta">
          <div className="np-title" title={np.title}>
            {np.title || "未在播放"}
          </div>
          <div className="np-artist" title={np.artist}>
            {np.artist || (np.hasSession ? "" : "打开任意播放器试试")}
          </div>
          {np.album ? (
            <div className="np-album" title={np.album}>
              {np.album}
            </div>
          ) : null}
        </div>
      </div>

      <div className="np-progress">
        <div className="np-bar">
          <div
            className="np-bar-fill"
            style={{ transform: `scaleX(${pct / 100})` }}
          />
        </div>
        <div className="np-times">
          <span>{fmt(pos)}</span>
          <span>{dur > 0 ? fmt(dur) : "--:--"}</span>
        </div>
      </div>

      <div className="np-controls">
        <button
          className="np-btn"
          disabled={!np.canPrevious}
          onClick={control(mediaPrevious)}
          aria-label="上一首"
        >
          ⏮
        </button>
        <button
          className="np-btn np-btn-main"
          disabled={!np.canPlayPause}
          onClick={control(mediaPlayPause)}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          className="np-btn"
          disabled={!np.canNext}
          onClick={control(mediaNext)}
          aria-label="下一首"
        >
          ⏭
        </button>
      </div>
    </div>
  );
}

registerModule({
  id: "now-playing",
  title: "正在播放",
  // Above the clock (10) so music owns the collapsed pill while it's active.
  priority: 100,
  Collapsed: CollapsedNowPlaying,
  Expanded: ExpandedNowPlaying,
  isActive: () => useNP.getState().active,
});
