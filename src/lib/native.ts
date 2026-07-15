/**
 * Thin wrapper around the Rust commands. Every call into the native layer goes
 * through here so UI components never touch Tauri APIs directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

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

/* --------------------- Bluetooth device observation (M7) --------------------- */

export type BluetoothServicePhase =
  | "starting"
  | "ready"
  | "noDevice"
  | "degraded"
  | "unsupported"
  | "stopped";

export type BluetoothDeviceKind =
  | "audio"
  | "mouse"
  | "keyboard"
  | "pen"
  | "gamepad"
  | "phone"
  | "wearable"
  | "generic";

export interface BluetoothDeviceSnapshot {
  id: string;
  name: string;
  kind: BluetoothDeviceKind;
  connected: boolean;
  batteryPercent: number | null;
}

export interface BluetoothSnapshot {
  phase: BluetoothServicePhase;
  devices: BluetoothDeviceSnapshot[];
  reason: string | null;
}

export type BluetoothTransitionPhase =
  | "connected"
  | "disconnected"
  | "batteryUpdated"
  | "lowBattery"
  | "degraded"
  | "watcherStopped";

export interface BluetoothTransition {
  id: string;
  phase: BluetoothTransitionPhase;
  atMs: number;
  device: BluetoothDeviceSnapshot | null;
  reason: string | null;
}

const BLUETOOTH_SERVICE_PHASES = new Set<string>([
  "starting",
  "ready",
  "noDevice",
  "degraded",
  "unsupported",
  "stopped",
]);
const BLUETOOTH_DEVICE_KINDS = new Set<string>([
  "audio",
  "mouse",
  "keyboard",
  "pen",
  "gamepad",
  "phone",
  "wearable",
  "generic",
]);
const BLUETOOTH_TRANSITION_PHASES = new Set<string>([
  "connected",
  "disconnected",
  "batteryUpdated",
  "lowBattery",
  "degraded",
  "watcherStopped",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isBluetoothDeviceSnapshot(
  value: unknown,
): value is BluetoothDeviceSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    BLUETOOTH_DEVICE_KINDS.has(value.kind) &&
    typeof value.connected === "boolean" &&
    (value.batteryPercent === null ||
      (typeof value.batteryPercent === "number" &&
        Number.isInteger(value.batteryPercent) &&
        value.batteryPercent >= 0 &&
        value.batteryPercent <= 100))
  );
}

export function isBluetoothSnapshot(value: unknown): value is BluetoothSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.phase === "string" &&
    BLUETOOTH_SERVICE_PHASES.has(value.phase) &&
    Array.isArray(value.devices) &&
    value.devices.length <= 128 &&
    value.devices.every(isBluetoothDeviceSnapshot) &&
    isNullableString(value.reason)
  );
}

export function isBluetoothTransition(
  value: unknown,
): value is BluetoothTransition {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.phase === "string" &&
    BLUETOOTH_TRANSITION_PHASES.has(value.phase) &&
    typeof value.atMs === "number" &&
    Number.isFinite(value.atMs) &&
    value.atMs >= 0 &&
    (value.device === null || isBluetoothDeviceSnapshot(value.device)) &&
    isNullableString(value.reason)
  );
}

function requireBluetoothSnapshot(value: unknown): BluetoothSnapshot {
  if (!isBluetoothSnapshot(value)) {
    throw new Error("Native Bluetooth source returned an invalid status payload");
  }
  return value;
}

function requireBluetoothTransition(value: unknown): BluetoothTransition {
  if (!isBluetoothTransition(value)) {
    throw new Error("Native Bluetooth source returned an invalid transition payload");
  }
  return value;
}

export async function getBluetoothStatus(): Promise<BluetoothSnapshot> {
  return requireBluetoothSnapshot(await invoke<unknown>("get_bluetooth_status"));
}

export async function setBluetoothObservation(
  enabled: boolean,
): Promise<BluetoothSnapshot> {
  return requireBluetoothSnapshot(
    await invoke<unknown>("set_bluetooth_observation", { enabled }),
  );
}

export function onBluetoothStatus(
  cb: (status: BluetoothSnapshot) => void,
  onInvalid: (error: Error) => void,
): Promise<UnlistenFn> {
  return listen<unknown>("bluetooth-status", (event) => {
    try {
      cb(requireBluetoothSnapshot(event.payload));
    } catch (error) {
      onInvalid(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function onBluetoothTransition(
  cb: (transition: BluetoothTransition) => void,
  onInvalid: (error: Error) => void,
): Promise<UnlistenFn> {
  return listen<unknown>("bluetooth-transition", (event) => {
    try {
      cb(requireBluetoothTransition(event.payload));
    } catch (error) {
      onInvalid(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function openBluetoothSettings(): Promise<void> {
  return openUrl("ms-settings:bluetooth");
}

/* ----------------------- Native glass underlay (M5A) ----------------------- */

export type GlassIntensity = "subtle" | "balanced" | "vivid";

export interface GlassStatus {
  /** Desired setting, even when Windows policy forces a CSS fallback. */
  requested: boolean;
  /** True only while the native HostBackdrop underlay is actually visible. */
  active: boolean;
  /** Whether the public Windows Composition path initialized successfully. */
  supported: boolean;
  /** "windows-host-backdrop" while active, otherwise "css". */
  renderer: string;
  fallbackReason: string | null;
  intensity: GlassIntensity;
}

export function getGlassStatus(): Promise<GlassStatus> {
  return invoke("get_glass_status");
}

export function setGlassEnabled(
  enabled: boolean,
  intensity: GlassIntensity,
): Promise<GlassStatus> {
  return invoke("set_glass_enabled", { enabled, intensity });
}

export function onGlassStatusChanged(
  cb: (status: GlassStatus) => void,
): Promise<UnlistenFn> {
  return listen<GlassStatus>("glass-status-changed", (event) => cb(event.payload));
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
  /** Whether the session supports seeking (drag the progress bar to a position). */
  canSeek: boolean;
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

/** Seek the active session to an absolute position (ms from the track start). */
export function mediaSeek(positionMs: number): Promise<void> {
  return invoke("media_seek", { positionMs: Math.max(0, Math.round(positionMs)) });
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

/* ------------------------- Clipboard / Shelf (M4) ------------------------- */

/** Files + text read off the clipboard (mirrors Rust `ClipboardData`). */
export interface ClipboardData {
  files: string[];
  text: string;
}

/** Put real files on the clipboard as CF_HDROP — the user can then paste them
 *  into Explorer to get a true file copy (Yoink-style "get it back out"). */
export function clipboardCopyFiles(paths: string[]): Promise<void> {
  return invoke("clipboard_copy_files", { paths });
}

/** Put plain text on the clipboard (for stashed text snippets). */
export function clipboardCopyText(text: string): Promise<void> {
  return invoke("clipboard_copy_text", { text });
}

/** Read files and/or text off the clipboard (used by "从剪贴板添加"). */
export function clipboardRead(): Promise<ClipboardData> {
  return invoke("clipboard_read");
}

/** Re-register the native OLE drop target on the current window + child HWNDs.
 *  Called once on UI mount so file drag-in survives webview reloads (a Vite HMR
 *  full reload can recreate WebView2's child HWND and orphan the drop target). */
export function rearmDropTarget(): Promise<void> {
  return invoke("rearm_drop_target");
}
