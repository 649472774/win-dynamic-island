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
  /** Currently shown transient HUD, or null. */
  hud: Hud | null;
  /** Flash a HUD of the given kind; auto-dismisses, resetting the timer if a
   *  new flash arrives (so rapid volume changes keep it visible). */
  showHud: (kind: string) => void;
  clearHud: () => void;
}

/** How long a HUD stays up after the last change. */
const HUD_MS = 1600;
let hudTimer: number | null = null;

export const useIsland = create<IslandStore>((set, get) => ({
  state: "collapsed",
  setState: (s) => {
    if (get().state !== s) set({ state: s });
  },
  toggleExpanded: () =>
    set({ state: get().state === "expanded" ? "collapsed" : "expanded" }),
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
}));
