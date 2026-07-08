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
  /** Compact renderer for the collapsed / hover pill. */
  Collapsed: FC<IslandModuleProps>;
  /** Full renderer for the expanded panel. */
  Expanded: FC<IslandModuleProps>;
  /** Optional: return false to hide the module when it has nothing to show. */
  isActive?: () => boolean;
}
