/**
 * Module bootstrap. Importing this file registers all built-in modules for
 * their side effects. Add new modules here as they are implemented.
 */
import "./clock";
import "./nowplaying";
import "./system";
import "./volume";
import "./shelf";
import "./time";

export {
  getActiveModules,
  getAllModules,
  getPrimaryModule,
  getModuleById,
  refreshModuleActivities,
  registerModule,
} from "./registry";
export type { IslandModule, IslandModuleProps, ModuleActivity } from "./types";
