import { create } from "zustand";
import {
  getBluetoothStatus,
  onBluetoothStatus,
  onBluetoothTransition,
  type BluetoothDeviceKind,
  type BluetoothSnapshot,
  type BluetoothTransition,
} from "../lib/native";
import {
  NOTICE_PRIORITY,
  publishNotice,
  sourceRemovedNotice,
  type NoticeKind,
} from "./notices";

const STOPPED: BluetoothSnapshot = {
  phase: "stopped",
  devices: [],
  reason: null,
};

interface BluetoothStore {
  snapshot: BluetoothSnapshot;
  setSnapshot: (snapshot: BluetoothSnapshot) => void;
}

export const useBluetooth = create<BluetoothStore>((set) => ({
  snapshot: STOPPED,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

export interface BluetoothNoticePreferences {
  enabled: boolean;
  showBattery: boolean;
  showDeviceName: boolean;
  settingsError?: string | null;
}

const DEVICE_ALIAS: Record<BluetoothDeviceKind, string> = {
  audio: "蓝牙耳机",
  mouse: "蓝牙鼠标",
  keyboard: "蓝牙键盘",
  pen: "蓝牙触控笔",
  gamepad: "蓝牙手柄",
  phone: "蓝牙手机",
  wearable: "蓝牙穿戴设备",
  generic: "蓝牙设备",
};

export function bluetoothPrivacyAlias(kind: BluetoothDeviceKind): string {
  return DEVICE_ALIAS[kind];
}

function publicDeviceName(
  transition: BluetoothTransition,
  preferences: BluetoothNoticePreferences,
): string {
  const kind = transition.device?.kind ?? "generic";
  if (!preferences.showDeviceName) return bluetoothPrivacyAlias(kind);
  return transition.device?.name.trim() || bluetoothPrivacyAlias(kind);
}

export function handleBluetoothTransition(
  transition: BluetoothTransition,
  preferences: BluetoothNoticePreferences,
): void {
  if (!preferences.enabled) return;

  const phase = transition.phase;
  if (
    (phase === "batteryUpdated" || phase === "lowBattery") &&
    !preferences.showBattery
  ) {
    return;
  }
  const isServiceEvent = phase === "degraded" || phase === "watcherStopped";
  const kind: NoticeKind =
    phase === "lowBattery"
      ? "alert"
      : isServiceEvent
        ? "service"
        : phase === "batteryUpdated"
          ? "status"
          : "lifecycle";
  const noticeId = isServiceEvent
    ? "bluetooth:service"
    : `bluetooth:${transition.id}`;
  if (!isServiceEvent) {
    for (const priorKind of ["alert", "status", "lifecycle"] as const) {
      if (priorKind !== kind) {
        sourceRemovedNotice({
          id: noticeId,
          source: "bluetooth",
          kind: priorKind,
        });
      }
    }
  }
  publishNotice({
    id: noticeId,
    source: "bluetooth",
    kind,
    phase:
      phase === "batteryUpdated"
        ? "battery-updated"
        : phase === "lowBattery"
          ? "low-battery"
          : phase === "watcherStopped"
            ? "degraded"
            : phase,
    priority:
      phase === "lowBattery"
        ? NOTICE_PRIORITY.urgent
        : isServiceEvent
          ? NOTICE_PRIORITY.service
          : NOTICE_PRIORITY.lifecycle,
    ttlMs: phase === "lowBattery" ? 5_000 : isServiceEvent ? 4_200 : 3_000,
    cooldownMs: phase === "lowBattery" ? 60_000 : 500,
    payload: {
      deviceName: publicDeviceName(transition, preferences),
      deviceKind: transition.device?.kind ?? "generic",
      batteryPercent:
        phase !== "disconnected" &&
        preferences.showBattery &&
        transition.device?.batteryPercent != null
          ? transition.device.batteryPercent
          : null,
      reason: transition.reason ? "蓝牙状态暂不可用" : null,
    },
  });
}

export function setBluetoothDegraded(reason: string): void {
  useBluetooth.getState().setSnapshot({
    phase: "degraded",
    devices: [],
    reason,
  });
}

export function handleBluetoothSnapshot(
  snapshot: BluetoothSnapshot,
  preferences: BluetoothNoticePreferences,
): void {
  if (preferences.settingsError) {
    setBluetoothDegraded(preferences.settingsError);
  } else {
    useBluetooth.getState().setSnapshot(snapshot);
  }
}

export async function startBluetoothBridge(
  getPreferences: () => BluetoothNoticePreferences,
): Promise<() => void> {
  let lastDebugMarker: string | null = null;
  const invalidPayload = (error: Error) => {
    setBluetoothDegraded(`蓝牙状态数据无效：${error.message}`);
  };
  const [stopStatus, stopTransition] = await Promise.all([
    onBluetoothStatus((snapshot) => {
      handleBluetoothSnapshot(snapshot, getPreferences());
      if (
        import.meta.env.DEV &&
        snapshot.reason?.startsWith("debug:") &&
        snapshot.reason !== lastDebugMarker
      ) {
        lastDebugMarker = snapshot.reason;
        const phase = snapshot.reason.slice("debug:".length);
        const transitionPhase =
          phase === "unknown-battery"
            ? "connected"
            : phase === "battery-updated"
              ? "batteryUpdated"
              : phase === "low-battery"
                ? "lowBattery"
                : phase;
        if (
          transitionPhase === "connected" ||
          transitionPhase === "disconnected" ||
          transitionPhase === "batteryUpdated" ||
          transitionPhase === "lowBattery" ||
          transitionPhase === "degraded"
        ) {
          handleBluetoothTransition(
            {
              id: snapshot.devices[0]?.id ?? "debug-device",
              phase: transitionPhase,
              atMs: Date.now(),
              device:
                snapshot.devices[0] ??
                (transitionPhase === "degraded"
                  ? null
                  : {
                      id: "debug-device",
                      name: "Surface Arc Mouse",
                      kind: "mouse",
                      connected: false,
                      batteryPercent: null,
                    }),
              reason:
                transitionPhase === "degraded"
                  ? "Deterministic debug watcher state"
                  : null,
            },
            getPreferences(),
          );
        }
      }
    }, invalidPayload),
    onBluetoothTransition((transition) =>
      handleBluetoothTransition(transition, getPreferences()),
    invalidPayload),
  ]);

  try {
    handleBluetoothSnapshot(await getBluetoothStatus(), getPreferences());
  } catch (error) {
    setBluetoothDegraded(`无法读取蓝牙状态：${String(error)}`);
  }

  return () => {
    stopStatus();
    stopTransition();
  };
}
