/**
 * P0 — Volume HUD (M3).
 *
 * A *panel-only* module (never owns the collapsed pill) that additionally
 * provides a transient **HUD**: whenever the system volume changes, the Rust
 * `volume-changed` event fires and we flash a compact slider over the pill for
 * ~1.6s (auto-dismissing), matching the spec's "短暂展开显示滑条后自动收起".
 *
 * The backend detection is fully event-driven (a COM `IAudioEndpointVolume`
 * callback), so there is zero idle polling here — we only react to real changes.
 */
import { useRef } from "react";
import { create } from "zustand";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { useIsland } from "../store/island";
import {
  getVolume,
  onVolumeChanged,
  setMuted,
  setVolume,
  type VolumeInfo,
} from "../lib/native";

const EMPTY: VolumeInfo = { level: 0, muted: false };

interface VolStore {
  info: VolumeInfo;
  set: (info: VolumeInfo) => void;
}

const useVolume = create<VolStore>((set) => ({
  info: EMPTY,
  set: (info) => set({ info }),
}));

// One-time bootstrap: seed the current level silently, then subscribe. Real
// changes both refresh the store and flash the HUD (the seed does neither).
let started = false;
function ensureStarted(): void {
  if (started) return;
  started = true;
  void getVolume()
    .then((info) => useVolume.getState().set(info))
    .catch(() => {});
  void onVolumeChanged((info) => {
    useVolume.getState().set(info);
    useIsland.getState().showHud("volume");
  });
}
ensureStarted();

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Speaker glyph reflecting the current level / mute. */
function speakerIcon(level: number, muted: boolean): string {
  if (muted || level <= 0) return "🔇";
  if (level < 34) return "🔈";
  if (level < 67) return "🔉";
  return "🔊";
}

/** Draggable / clickable volume track (drives the system volume back). */
function Slider({ level, muted }: { level: number; muted: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pctFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return level;
    const r = el.getBoundingClientRect();
    return clampPct(((clientX - r.left) / r.width) * 100);
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    void setVolume(pctFromClientX(e.clientX));
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) void setVolume(pctFromClientX(e.clientX));
  };
  const fill = muted ? 0 : clampPct(level);
  return (
    <div
      className="vol-track"
      ref={trackRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
    >
      <div className="vol-fill" style={{ transform: `scaleX(${fill / 100})` }} />
    </div>
  );
}

/** Transient HUD: speaker (mute toggle) + slider + percentage. */
function VolumeHud(_: IslandModuleProps) {
  const info = useVolume((s) => s.info);
  const shown = info.muted ? "静音" : `${clampPct(info.level)}%`;
  return (
    <div className="vol-hud" onClick={(e) => e.stopPropagation()}>
      <button
        className="vol-speaker"
        title={info.muted ? "取消静音" : "静音"}
        onClick={(e) => {
          e.stopPropagation();
          void setMuted(!info.muted);
        }}
      >
        {speakerIcon(info.level, info.muted)}
      </button>
      <Slider level={info.level} muted={info.muted} />
      <span className={`vol-pct${info.muted ? " muted" : ""}`}>{shown}</span>
    </div>
  );
}

/** Compact card for the expanded panel's grid. */
function VolumeTile(_: IslandModuleProps) {
  const info = useVolume((s) => s.info);
  const fill = info.muted ? 0 : clampPct(info.level);
  return (
    <div className="sys-stat vol-tile">
      <div className="sys-stat-head">
        <span className="sys-stat-icon">{speakerIcon(info.level, info.muted)}</span>
        <span className="sys-stat-value">{info.muted ? "静音" : `${clampPct(info.level)}%`}</span>
      </div>
      <div className="sys-bar">
        <div className="sys-bar-fill" style={{ transform: `scaleX(${fill / 100})` }} />
      </div>
      <div className="sys-stat-label">音量</div>
    </div>
  );
}

registerModule({
  id: "volume",
  title: "音量",
  // Panel-only + HUD: never owns the collapsed pill.
  priority: 40,
  Tile: VolumeTile,
  Hud: VolumeHud,
  isActive: () => false,
});
