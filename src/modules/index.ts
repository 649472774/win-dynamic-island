/**
 * Module bootstrap. Importing this file registers all built-in modules for
 * their side effects. Add new modules here as they are implemented.
 */
import "./clock";
import "./nowplaying";
import "./system";
import "./volume";

export {
  getActiveModules,
  getAllModules,
  getPrimaryModule,
  registerModule,
} from "./registry";
export type { IslandModule, IslandModuleProps } from "./types";
