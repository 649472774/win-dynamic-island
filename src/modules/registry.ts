/**
 * Simple in-memory module registry. Modules register themselves on import; the
 * shell asks for the active set sorted by priority.
 */
import type { IslandModule } from "./types";
import {
  getActivitySnapshot,
  replaceActivitySource,
} from "../store/activities";

const registry: IslandModule[] = [];

export function registerModule(module: IslandModule): void {
  if (!registry.some((m) => m.id === module.id)) {
    registry.push(module);
    refreshModuleActivities(module.id);
  }
}

export function refreshModuleActivities(moduleId: string): void {
  const module = registry.find((item) => item.id === moduleId);
  if (!module) return;
  const active = module.isActive ? module.isActive() : true;
  const activities = module.getActivities
    ? module.getActivities()
    : module.Collapsed && active
      ? [
          {
            id: `module:${module.id}`,
            channel: module.channel ?? "ongoing",
            title: module.title,
            icon: module.icon ?? "•",
            priority: module.priority,
          },
        ]
      : [];
  replaceActivitySource(
    module.id,
    activities.map((activity) => ({
      ...activity,
      sourceId: module.id,
      moduleId: module.id,
    })),
  );
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
  const base = getActivitySnapshot().base;
  return base ? registry.find((module) => module.id === base.moduleId) : undefined;
}

export function getModuleById(id: string): IslandModule | undefined {
  return registry.find((module) => module.id === id);
}
