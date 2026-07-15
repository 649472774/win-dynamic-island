/**
 * Central island state, kept intentionally tiny. Zustand gives us per-selector
 * subscriptions so a component only re-renders when the slice it reads changes,
 * which keeps idle CPU low.
 */
import { create } from "zustand";
import { NOTICE_PRIORITY, publishNotice } from "./notices";

export type IslandState = "collapsed" | "hover" | "expanded";

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
  /** Flash a HUD of the given kind; auto-dismisses, resetting the timer if a
   *  new flash arrives (so rapid volume changes keep it visible). */
  showHud: (kind: string) => void;
  /** True while an OS file drag is hovering the island (Yoink-style catch).
   *  Forces the panel open and blocks collapse so the user can drop. */
  dragActive: boolean;
  /** Set the drag-active flag; turning it on force-expands the panel and drops
   *  the settings view so the drop zone is front and center. */
  setDragActive: (b: boolean) => void;
  /** Expand the island straight to the module grid (used to surface the shelf). */
  openShelf: () => void;
}

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
  showHud: (kind) => {
    publishNotice({
      id: `hud:${kind}`,
      source: kind,
      kind: "hud",
      phase: "updated",
      priority: NOTICE_PRIORITY.hud,
      ttlMs: 1_600,
      refreshTtl: true,
      payload: { renderer: "module-hud", kind },
    });
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
