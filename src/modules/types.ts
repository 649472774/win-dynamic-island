/**
 * The pluggable "island module" contract. Every feature (Now Playing, Volume,
 * Battery, Shelf, ...) implements this so the shell can render it without
 * knowing any specifics. New modules just call `registerModule`.
 */
import type { FC } from "react";
import type { IslandState } from "../store/island";

export interface IslandModuleProps {
  state: IslandState;
}

export interface IslandModule {
  /** Stable unique id. */
  id: string;
  /** Human-readable title (shown in the expanded panel). */
  title: string;
  /** Higher priority modules win the collapsed slot and sort first. */
  priority: number;
  /** Compact renderer for the collapsed / hover pill. Omit for panel-only
   *  modules that never own the pill. */
  Collapsed?: FC<IslandModuleProps>;
  /** Full renderer shown at the top of the expanded panel when this module is
   *  the primary (pill-owning) one. */
  Expanded?: FC<IslandModuleProps>;
  /** Optional compact card rendered in the expanded panel's module grid,
   *  regardless of pill ownership (e.g. battery / system stats). */
  Tile?: FC<IslandModuleProps>;
  /** Optional: return false to hide the module from the pill / active set.
   *  Panel-only modules (with just a `Tile`) return false so they never win
   *  the collapsed slot. */
  isActive?: () => boolean;
}
