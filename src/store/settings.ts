/**
 * User settings (persisted).
 *
 * Kept intentionally tiny and self-contained. For now it persists to
 * `localStorage` (WebView2 keeps this across app restarts), which is enough to
 * make preferences stick today; M4 will migrate the backing store to the Rust
 * side (tauri-plugin-store) without changing this module's public shape.
 */
import { create } from "zustand";

/**
 * How the system-info meters (CPU / memory / battery) are drawn.
 *   - "inline": one compact row per stat (icon · name · thin bar · value) — the
 *     densest, least prominent layout; the default.
 *   - "bar":    three columns of small stacked bars.
 *   - "ring":   three small circular gauges with the value beside the ring.
 */
export type GaugeStyle = "inline" | "bar" | "ring";

/** Cycle order used by the tile's corner toggle. */
export const GAUGE_ORDER: GaugeStyle[] = ["inline", "bar", "ring"];

// v2: the option set changed (added "inline", dropped the old text-in-ring
// layout), so use a fresh key to reset everyone to the new default rather than
// honour a stale "bar"/"ring" value from the previous scheme.
const GAUGE_KEY = "di.settings.gaugeStyle.v2";
const DEFAULT_GAUGE: GaugeStyle = "inline";

function loadGaugeStyle(): GaugeStyle {
  try {
    const v = localStorage.getItem(GAUGE_KEY);
    return v && (GAUGE_ORDER as string[]).includes(v) ? (v as GaugeStyle) : DEFAULT_GAUGE;
  } catch {
    return DEFAULT_GAUGE;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — settings just won't persist */
  }
}

interface SettingsStore {
  /** Meter rendering style for the system-info tile. */
  gaugeStyle: GaugeStyle;
  setGaugeStyle: (style: GaugeStyle) => void;
  /** Advance to the next style in GAUGE_ORDER (wraps around). */
  cycleGaugeStyle: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  gaugeStyle: loadGaugeStyle(),
  setGaugeStyle: (style) => {
    persist(GAUGE_KEY, style);
    set({ gaugeStyle: style });
  },
  cycleGaugeStyle: () => {
    const cur = get().gaugeStyle;
    const next = GAUGE_ORDER[(GAUGE_ORDER.indexOf(cur) + 1) % GAUGE_ORDER.length];
    get().setGaugeStyle(next);
  },
}));
