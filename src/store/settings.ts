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
import {
  onGlassStatusChanged,
  setGlassEnabled as setNativeGlassEnabled,
  type GlassIntensity,
  type GlassStatus,
} from "../lib/native";

/**
 * How the system-info meters (CPU / memory / battery) are drawn.
 *   - "inline": one compact row per stat (icon · name · thin bar · value) — the
 *     densest, least prominent layout.
 *   - "bar":    three columns of small stacked bars.
 *   - "ring" (default): three small circular gauges with the value beside the ring.
 */
export type GaugeStyle = "inline" | "bar" | "ring";

/** Order shown in the settings-panel segmented control. */
export const GAUGE_ORDER: GaugeStyle[] = ["inline", "bar", "ring"];
export const GLASS_INTENSITY_ORDER: GlassIntensity[] = ["subtle", "balanced", "vivid"];
export type { GlassIntensity };

const DEFAULT_GAUGE: GaugeStyle = "ring";
const DEFAULT_GLASS_INTENSITY: GlassIntensity = "balanced";

/** Backing file lives under the app config dir (e.g. %APPDATA%/<id>/). */
const store = new LazyStore("settings.json");
// Bumped to .v2 so the new "ring" default replaces any previously-saved value.
const K_GAUGE = "gaugeStyle.v2";
const K_GLASS = "glass.enabled.v1";
const K_GLASS_INTENSITY = "glass.intensity.v1";

const CSS_GLASS_STATUS: GlassStatus = {
  requested: false,
  active: false,
  supported: true,
  renderer: "css",
  fallbackReason: null,
  intensity: DEFAULT_GLASS_INTENSITY,
};

let hydration: Promise<void> | null = null;
let glassRequestVersion = 0;

interface SettingsPersistenceGlobal {
  __winDynamicIslandSettingsQueue?: Promise<void>;
}

// Keep one queue across Vite HMR module replacements. Otherwise an old module
// instance can finish a stale save after the replacement has persisted a newer
// value, making settings appear to roll back during development.
const persistenceGlobal = globalThis as typeof globalThis & SettingsPersistenceGlobal;

function persistSetting(
  key: string,
  value: GaugeStyle | GlassIntensity | boolean,
): void {
  const previous =
    persistenceGlobal.__winDynamicIslandSettingsQueue ?? Promise.resolve();
  persistenceGlobal.__winDynamicIslandSettingsQueue = previous
    .then(async () => {
      await store.set(key, value);
      await store.save();
    })
    .catch((error) => {
      console.error(`Failed to persist setting "${key}"`, error);
    });
}

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
  /** User's persisted preference for the native HostBackdrop underlay. */
  glassEnabled: boolean;
  glassIntensity: GlassIntensity;
  /** Actual renderer state reported by Rust (may be a policy fallback). */
  glassStatus: GlassStatus;
  glassPending: boolean;
  setGlassEnabled: (on: boolean) => void;
  setGlassIntensity: (intensity: GlassIntensity) => void;
  /** Load persisted values + real autostart state. Call once on boot. */
  hydrate: () => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  loaded: false,
  gaugeStyle: DEFAULT_GAUGE,
  setGaugeStyle: (style) => {
    set({ gaugeStyle: style });
    persistSetting(K_GAUGE, style);
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
  glassEnabled: false,
  glassIntensity: DEFAULT_GLASS_INTENSITY,
  glassStatus: CSS_GLASS_STATUS,
  glassPending: false,
  setGlassEnabled: (on) => {
    const version = ++glassRequestVersion;
    set({
      glassEnabled: on,
      glassPending: true,
      glassStatus: {
        ...get().glassStatus,
        requested: on,
        fallbackReason: on ? "正在切换原生毛玻璃" : null,
      },
    });
    persistSetting(K_GLASS, on);
    void setNativeGlassEnabled(on, get().glassIntensity)
      .then((status) => {
        if (version === glassRequestVersion) {
          set({ glassStatus: status, glassPending: false });
        }
      })
      .catch((error) => {
        if (version === glassRequestVersion) {
          set({
            glassPending: false,
            glassStatus: {
              requested: on,
              active: false,
              supported: false,
              renderer: "css",
              fallbackReason: `原生调用失败：${String(error)}`,
              intensity: get().glassIntensity,
            },
          });
        }
      });
  },
  setGlassIntensity: (intensity) => {
    const version = ++glassRequestVersion;
    set({ glassIntensity: intensity, glassPending: true });
    persistSetting(K_GLASS_INTENSITY, intensity);
    void setNativeGlassEnabled(get().glassEnabled, intensity)
      .then((status) => {
        if (version === glassRequestVersion) {
          set({ glassStatus: status, glassPending: false });
        }
      })
      .catch((error) => {
        if (version === glassRequestVersion) {
          set({
            glassPending: false,
            glassStatus: {
              requested: get().glassEnabled,
              active: false,
              supported: false,
              renderer: "css",
              fallbackReason: `原生调用失败：${String(error)}`,
              intensity,
            },
          });
        }
      });
  },
  hydrate: async () => {
    if (get().loaded) return;
    if (hydration) return hydration;

    hydration = (async () => {
      const glassVersionAtStart = glassRequestVersion;
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

      let glassEnabled = false;
      let glassIntensity: GlassIntensity = DEFAULT_GLASS_INTENSITY;
      try {
        glassEnabled = (await store.get<boolean>(K_GLASS)) === true;
      } catch {
        /* ignore — native glass remains safely disabled */
      }
      try {
        const savedIntensity = await store.get<GlassIntensity>(K_GLASS_INTENSITY);
        if (
          savedIntensity &&
          (GLASS_INTENSITY_ORDER as string[]).includes(savedIntensity)
        ) {
          glassIntensity = savedIntensity;
        }
      } catch {
        /* ignore — balanced remains the safe default */
      }
      // A caller may have changed glass while storage was being read (for
      // example through automation during startup). Never overwrite that newer
      // request with the stale snapshot hydration started from.
      if (glassVersionAtStart !== glassRequestVersion) {
        set({ loaded: true });
        return;
      }
      set({ glassEnabled, glassIntensity, glassPending: true });
      try {
        const status = await setNativeGlassEnabled(glassEnabled, glassIntensity);
        if (glassVersionAtStart === glassRequestVersion) {
          set({ glassStatus: status, glassPending: false });
        }
      } catch (error) {
        if (glassVersionAtStart === glassRequestVersion) {
          set({
            glassPending: false,
            glassStatus: {
              requested: glassEnabled,
              active: false,
              supported: false,
              renderer: "css",
              fallbackReason: `读取原生状态失败：${String(error)}`,
              intensity: glassIntensity,
            },
          });
        }
      }
      set({ loaded: true });
    })();

    try {
      await hydration;
    } finally {
      hydration = null;
    }
  },
}));

// The tray menu can toggle autostart directly in Rust; keep our UI in sync.
void listen<boolean>("autostart-changed", (e) => {
  useSettings.setState({ autostart: e.payload });
}).catch(() => {});

void onGlassStatusChanged((status) => {
  const current = useSettings.getState();
  if (
    current.glassPending ||
    status.fallbackReason === "正在初始化原生毛玻璃"
  ) {
    return;
  }
  useSettings.setState({
    glassEnabled: status.requested,
    glassIntensity: status.intensity,
    glassStatus: status,
    glassPending: false,
  });
}).catch(() => {});
