/**
 * Simple in-memory module registry. Modules register themselves on import; the
 * shell asks for the active set sorted by priority.
 */
import type { IslandModule } from "./types";

const registry: IslandModule[] = [];

export function registerModule(module: IslandModule): void {
  if (!registry.some((m) => m.id === module.id)) {
    registry.push(module);
  }
}

export function getActiveModules(): IslandModule[] {
  return registry
    .filter((m) => (m.isActive ? m.isActive() : true))
    .sort((a, b) => b.priority - a.priority);
}

/** Every registered module, sorted by priority (used for the panel grid and
 *  the "loaded modules" footer, independent of pill ownership). */
export function getAllModules(): IslandModule[] {
  return [...registry].sort((a, b) => b.priority - a.priority);
}

/** The single module that owns the collapsed pill (highest priority active). */
export function getPrimaryModule(): IslandModule | undefined {
  return getActiveModules()[0];
}
