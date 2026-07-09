/**
 * Central island state, kept intentionally tiny. Zustand gives us per-selector
 * subscriptions so a component only re-renders when the slice it reads changes,
 * which keeps idle CPU low.
 */
import { create } from "zustand";

export type IslandState = "collapsed" | "hover" | "expanded";

/** A transient overlay shown briefly over the pill (e.g. the volume slider).
 *  `kind` maps to a module id whose `Hud` renderer draws it. */
export interface Hud {
  kind: string;
}

interface IslandStore {
  state: IslandState;
  setState: (s: IslandState) => void;
  toggleExpanded: () => void;
  /** Whether the expanded panel is showing the settings view. */
  settingsOpen: boolean;
  /** Expand the island and show the settings view. */
  openSettings: () => void;
  /** Leave the settings view (stays expanded, back to modules). */
  closeSettings: () => void;
  /** Currently shown transient HUD, or null. */
  hud: Hud | null;
  /** Flash a HUD of the given kind; auto-dismisses, resetting the timer if a
   *  new flash arrives (so rapid volume changes keep it visible). */
  showHud: (kind: string) => void;
  clearHud: () => void;
  /** True while an OS file drag is hovering the island (Yoink-style catch).
   *  Forces the panel open and blocks collapse so the user can drop. */
  dragActive: boolean;
  /** Set the drag-active flag; turning it on force-expands the panel and drops
   *  the settings view so the drop zone is front and center. */
  setDragActive: (b: boolean) => void;
  /** Expand the island straight to the module grid (used to surface the shelf). */
  openShelf: () => void;
}

/** How long a HUD stays up after the last change. */
const HUD_MS = 1600;
let hudTimer: number | null = null;

export const useIsland = create<IslandStore>((set, get) => ({
  state: "collapsed",
  setState: (s) => {
    if (get().state !== s) {
      // Leaving the expanded panel always drops the settings view.
      set(s === "expanded" ? { state: s } : { state: s, settingsOpen: false });
    }
  },
  toggleExpanded: () =>
    set(
      get().state === "expanded"
        ? { state: "collapsed", settingsOpen: false }
        : { state: "expanded" },
    ),
  settingsOpen: false,
  openSettings: () => set({ state: "expanded", settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  hud: null,
  showHud: (kind) => {
    if (hudTimer !== null) window.clearTimeout(hudTimer);
    set({ hud: { kind } });
    hudTimer = window.setTimeout(() => {
      hudTimer = null;
      set({ hud: null });
    }, HUD_MS);
  },
  clearHud: () => {
    if (hudTimer !== null) {
      window.clearTimeout(hudTimer);
      hudTimer = null;
    }
    set({ hud: null });
  },
  dragActive: false,
  setDragActive: (b) =>
    set(
      b
        ? { dragActive: true, state: "expanded", settingsOpen: false }
        : { dragActive: false },
    ),
  openShelf: () => set({ state: "expanded", settingsOpen: false }),
}));
