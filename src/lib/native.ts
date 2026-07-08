/**
 * Thin wrapper around the Rust commands. Every call into the native layer goes
 * through here so UI components never touch Tauri APIs directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RegionPx {
  /** Physical-pixel offset from the window's top-left corner. */
  x: number;
  y: number;
  /** Physical-pixel size of the visible pill / panel. */
  w: number;
  h: number;
  /** Corner radius in physical pixels. */
  radius: number;
}

/** Clip the native window to the given rounded rectangle (shapes the acrylic
 *  pill and defines the interactive / click-through area). */
export function setIslandRegion(region: RegionPx): Promise<void> {
  return invoke("set_island_region", { region });
}

/** Show the window once the first region has been applied (avoids a startup
 *  flash of an unshaped window). */
export function revealIsland(): Promise<void> {
  return invoke("reveal_island");
}

/** Re-center the island on the top edge of the current primary display. */
export function recenter(): Promise<void> {
  return invoke("recenter");
}

/* --------------------------- Now Playing (M2) --------------------------- */

/** Media snapshot pushed from Rust (mirrors the `NowPlaying` struct). */
export interface NowPlaying {
  hasSession: boolean;
  title: string;
  artist: string;
  album: string;
  /** "playing" | "paused" | "stopped" | "none". */
  status: "playing" | "paused" | "stopped" | "none";
  canNext: boolean;
  canPrevious: boolean;
  canPlayPause: boolean;
  /** Position (ms) at the instant `updatedAtMs` was sampled. */
  positionMs: number;
  durationMs: number;
  /** Unix epoch ms anchor for local progress interpolation. */
  updatedAtMs: number;
  /** Changes exactly when the track changes. */
  trackId: string;
  /** When true, `cover` replaces the cached art; when false keep the previous. */
  coverChanged: boolean;
  /** Data-URL of the cover art, when known / changed. */
  cover: string | null;
}

/** Fetch the current media snapshot (used for the initial render). */
export function getNowPlaying(): Promise<NowPlaying> {
  return invoke("get_now_playing");
}

/** Subscribe to live media updates. Returns an unlisten function. */
export function onNowPlaying(cb: (np: NowPlaying) => void): Promise<UnlistenFn> {
  return listen<NowPlaying>("now-playing-update", (e) => cb(e.payload));
}

export function mediaPlayPause(): Promise<void> {
  return invoke("media_play_pause");
}

export function mediaNext(): Promise<void> {
  return invoke("media_next");
}

export function mediaPrevious(): Promise<void> {
  return invoke("media_previous");
}

/* --------------------------- System info (M3) --------------------------- */

/** Battery / CPU / memory snapshot pushed from Rust (mirrors `SystemInfo`). */
export interface SystemInfo {
  hasBattery: boolean;
  /** 0..100, or -1 when unknown / no battery. */
  batteryPercent: number;
  charging: boolean;
  onAc: boolean;
  lowBattery: boolean;
  cpuPercent: number;
  memPercent: number;
  memUsedMb: number;
  memTotalMb: number;
}

/** Fetch the current system snapshot (used for the initial render). */
export function getSystemInfo(): Promise<SystemInfo> {
  return invoke("get_system_info");
}

/** Subscribe to live system-info updates. Returns an unlisten function. */
export function onSystemUpdate(cb: (info: SystemInfo) => void): Promise<UnlistenFn> {
  return listen<SystemInfo>("system-update", (e) => cb(e.payload));
}

/* ----------------------------- Volume (M3) ----------------------------- */

/** Default-render-endpoint volume snapshot (mirrors `VolumeInfo`). */
export interface VolumeInfo {
  /** 0..100. */
  level: number;
  muted: boolean;
}

/** Fetch the current volume (used for the initial render / panel tile). */
export function getVolume(): Promise<VolumeInfo> {
  return invoke("get_volume");
}

/** Subscribe to volume changes (fires only when the level or mute changes). */
export function onVolumeChanged(cb: (info: VolumeInfo) => void): Promise<UnlistenFn> {
  return listen<VolumeInfo>("volume-changed", (e) => cb(e.payload));
}

/** Set the master volume level (0..100). */
export function setVolume(level: number): Promise<void> {
  return invoke("set_volume", { level: Math.max(0, Math.min(100, Math.round(level))) });
}

/** Mute / unmute the default render endpoint. */
export function setMuted(muted: boolean): Promise<void> {
  return invoke("set_muted", { muted });
}
