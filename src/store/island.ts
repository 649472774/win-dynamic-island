/**
 * Central island state, kept intentionally tiny. Zustand gives us per-selector
 * subscriptions so a component only re-renders when the slice it reads changes,
 * which keeps idle CPU low.
 */
import { create } from "zustand";

export type IslandState = "collapsed" | "hover" | "expanded";
export type ExpandedPanel = "home" | "settings" | "time";

/** A transient overlay shown briefly over the pill (e.g. the volume slider).
 *  `kind` maps to a module id whose `Hud` renderer draws it. */
export interface Hud {
  kind: string;
}

interface IslandStore {
  state: IslandState;
  setState: (s: IslandState) => void;
  toggleExpanded: () => void;
  /** Current route within the expanded island. */
  panel: ExpandedPanel;
  /** Return to the expanded home surface. */
  openHome: () => void;
  /** Expand the island and show the settings view. */
  openSettings: () => void;
  /** Expand the island and show the dedicated Time Center. */
  openTimeCenter: () => void;
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
   *  focused routes so the drop zone is front and center. */
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
      // Leaving the expanded panel always resets its internal route.
      set(s === "expanded" ? { state: s } : { state: s, panel: "home" });
    }
  },
  toggleExpanded: () =>
    set(
      get().state === "expanded"
        ? { state: "collapsed", panel: "home" }
        : { state: "expanded" },
    ),
  panel: "home",
  openHome: () => set({ state: "expanded", panel: "home" }),
  openSettings: () => set({ state: "expanded", panel: "settings" }),
  openTimeCenter: () => set({ state: "expanded", panel: "time" }),
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
        ? { dragActive: true, state: "expanded", panel: "home" }
        : { dragActive: false },
    ),
  openShelf: () => set({ state: "expanded", panel: "home" }),
}));
