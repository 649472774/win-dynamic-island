/**
 * A tiny "modules changed" signal.
 *
 * The registry decides which module owns the collapsed pill via each module's
 * `isActive()`. That set is read during the shell's render, but the shell only
 * re-renders when the island `state` slice changes. When a module's activeness
 * flips for an external reason (music starts/stops, a HUD appears), we need the
 * shell to re-evaluate the primary module *now*. Modules call `bumpModules()`
 * on such transitions and the shell subscribes to `v`, forcing a re-render.
 */
import { create } from "zustand";

interface ModulesVersionStore {
  /** Monotonic counter; bumped whenever the active module set may have changed. */
  v: number;
  bump: () => void;
}

export const useModulesVersion = create<ModulesVersionStore>((set, get) => ({
  v: 0,
  bump: () => set({ v: get().v + 1 }),
}));

/** Notify the shell that the active module set may have changed. */
export function bumpModules(): void {
  useModulesVersion.getState().bump();
}
