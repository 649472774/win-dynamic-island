/**
 * User settings (persisted).
 *
 * Kept intentionally tiny and self-contained. For now it persists to
 * `localStorage` (WebView2 keeps this across app restarts), which is enough to
 * make preferences stick today; M4 will migrate the backing store to the Rust
 * side (tauri-plugin-store) without changing this module's public shape.
 */
import { create } from "zustand";

/** How the system-info meters (CPU / memory / battery) are drawn. */
export type GaugeStyle = "bar" | "ring";

const GAUGE_KEY = "di.settings.gaugeStyle";

function loadGaugeStyle(): GaugeStyle {
  try {
    return localStorage.getItem(GAUGE_KEY) === "ring" ? "ring" : "bar";
  } catch {
    return "bar";
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
  toggleGaugeStyle: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  gaugeStyle: loadGaugeStyle(),
  setGaugeStyle: (style) => {
    persist(GAUGE_KEY, style);
    set({ gaugeStyle: style });
  },
  toggleGaugeStyle: () =>
    get().setGaugeStyle(get().gaugeStyle === "bar" ? "ring" : "bar"),
}));
