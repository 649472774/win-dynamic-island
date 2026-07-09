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
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
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

/**
 * Shared drag-to-set behaviour for any volume track element. Returns a ref to
 * attach to the track plus pointer handlers that map the cursor's X position to
 * 0–100% and push it straight back to the system volume. All events stop
 * propagation so a scrub never bubbles up to the pill's expand/collapse toggle.
 */
function useVolumeDrag() {
  const ref = useRef<HTMLDivElement>(null);
  const pctFromClientX = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clampPct(((clientX - r.left) / r.width) * 100);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    void setVolume(pctFromClientX(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) {
      e.stopPropagation();
      void setVolume(pctFromClientX(e.clientX));
    }
  };
  return { ref, onPointerDown, onPointerMove };
}

/** Speaker glyph reflecting the current level / mute. */
function speakerIcon(level: number, muted: boolean): string {
  if (muted || level <= 0) return "🔇";
  if (level < 34) return "🔈";
  if (level < 67) return "🔉";
  return "🔊";
}

/** Draggable / clickable volume track (drives the system volume back). */
function Slider({ level, muted }: { level: number; muted: boolean }) {
  const drag = useVolumeDrag();
  const fill = muted ? 0 : clampPct(level);
  return (
    <div
      className="vol-track"
      ref={drag.ref}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
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

/** Compact card for the expanded panel's grid — draggable to set volume. */
function VolumeTile(_: IslandModuleProps) {
  const info = useVolume((s) => s.info);
  const fill = info.muted ? 0 : clampPct(info.level);
  const drag = useVolumeDrag();
  return (
    <div className="sys-stat vol-tile">
      <div className="sys-stat-head">
        <button
          className="vol-tile-speaker"
          title={info.muted ? "取消静音" : "静音"}
          onClick={(e) => {
            e.stopPropagation();
            void setMuted(!info.muted);
          }}
        >
          {speakerIcon(info.level, info.muted)}
        </button>
        <span className="sys-stat-value">
          {info.muted ? "静音" : `${clampPct(info.level)}%`}
        </span>
      </div>
      <div
        className="vol-tile-track"
        ref={drag.ref}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="vol-tile-rail">
          <div className="sys-bar-fill" style={{ transform: `scaleX(${fill / 100})` }} />
        </div>
      </div>
      <div className="sys-stat-label">音量 · 可拖动</div>
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
