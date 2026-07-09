/**
 * User settings (persisted to disk via tauri-plugin-store).
 *
 * The public shape stays synchronous (components read `gaugeStyle` etc.
 * directly) — we hydrate the zustand store asynchronously from the on-disk
 * store on boot, and write-through on every change. `autostart` is sourced from
 * the autostart plugin (the registry Run key is the single source of truth),
 * not the JSON file, so it can't drift from the real OS state.
 */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  enable as autostartEnable,
  disable as autostartDisable,
  isEnabled as autostartIsEnabled,
} from "@tauri-apps/plugin-autostart";
import { listen } from "@tauri-apps/api/event";

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

const DEFAULT_GAUGE: GaugeStyle = "inline";

/** Backing file lives under the app config dir (e.g. %APPDATA%/<id>/). */
const store = new LazyStore("settings.json");
const K_GAUGE = "gaugeStyle";

interface SettingsStore {
  /** Whether the initial async hydrate from disk has completed. */
  loaded: boolean;
  /** Meter rendering style for the system-info tile. */
  gaugeStyle: GaugeStyle;
  setGaugeStyle: (style: GaugeStyle) => void;
  /** Advance to the next style in GAUGE_ORDER (wraps around). */
  cycleGaugeStyle: () => void;
  /** Launch on Windows login (reflects the real autostart plugin state). */
  autostart: boolean;
  setAutostart: (on: boolean) => void;
  /** Load persisted values + real autostart state. Call once on boot. */
  hydrate: () => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  loaded: false,
  gaugeStyle: DEFAULT_GAUGE,
  setGaugeStyle: (style) => {
    set({ gaugeStyle: style });
    void store
      .set(K_GAUGE, style)
      .then(() => store.save())
      .catch(() => {
        /* store unavailable (e.g. non-tauri) — in-memory only */
      });
  },
  cycleGaugeStyle: () => {
    const cur = get().gaugeStyle;
    const next = GAUGE_ORDER[(GAUGE_ORDER.indexOf(cur) + 1) % GAUGE_ORDER.length];
    get().setGaugeStyle(next);
  },
  autostart: false,
  setAutostart: (on) => {
    // Optimistic: flip the UI now, then apply to the registry. Re-read to
    // reflect the true result if the OS call fails.
    set({ autostart: on });
    void (on ? autostartEnable() : autostartDisable())
      .then(() => autostartIsEnabled())
      .then((real) => set({ autostart: real }))
      .catch(() => {
        void autostartIsEnabled()
          .then((real) => set({ autostart: real }))
          .catch(() => {});
      });
  },
  hydrate: async () => {
    try {
      const g = await store.get<GaugeStyle>(K_GAUGE);
      if (g && (GAUGE_ORDER as string[]).includes(g)) set({ gaugeStyle: g });
    } catch {
      /* ignore — keep defaults */
    }
    try {
      const on = await autostartIsEnabled();
      set({ autostart: on });
    } catch {
      /* ignore */
    }
    set({ loaded: true });
  },
}));

// The tray menu can toggle autostart directly in Rust; keep our UI in sync.
void listen<boolean>("autostart-changed", (e) => {
  useSettings.setState({ autostart: e.payload });
}).catch(() => {});
