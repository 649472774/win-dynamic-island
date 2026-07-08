/**
 * Central island state, kept intentionally tiny. Zustand gives us per-selector
 * subscriptions so a component only re-renders when the slice it reads changes,
 * which keeps idle CPU low.
 */
import { create } from "zustand";

export type IslandState = "collapsed" | "hover" | "expanded";

interface IslandStore {
  state: IslandState;
  setState: (s: IslandState) => void;
  toggleExpanded: () => void;
}

export const useIsland = create<IslandStore>((set, get) => ({
  state: "collapsed",
  setState: (s) => {
    if (get().state !== s) set({ state: s });
  },
  toggleExpanded: () =>
    set({ state: get().state === "expanded" ? "collapsed" : "expanded" }),
}));
