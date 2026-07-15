import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleBluetoothSnapshot,
  handleBluetoothTransition,
  useBluetooth,
} from "./bluetooth";
import { NOTICE_PRIORITY, NoticeRuntime, noticeRuntime } from "./notices";
import type {
  BluetoothDeviceKind,
  BluetoothTransition,
} from "../lib/native";

const CONNECTED: BluetoothTransition = {
  id: "headphones",
  phase: "connected",
  atMs: 1_000,
  device: {
    id: "headphones",
    name: "Private Headphones",
    kind: "audio",
    connected: true,
    batteryPercent: 64,
  },
  reason: null,
};

describe("Bluetooth notice bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    noticeRuntime.clear();
  });

  afterEach(() => {
    noticeRuntime.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("publishes a connected transition with safe presentation data", () => {
    handleBluetoothTransition(CONNECTED, {
      enabled: true,
      showBattery: true,
      showDeviceName: true,
    });

    expect(noticeRuntime.getSnapshot().current).toMatchObject({
      id: "bluetooth:headphones",
      source: "bluetooth",
      phase: "connected",
      payload: {
        deviceName: "Private Headphones",
        batteryPercent: 64,
      },
    });
  });

  it("applies privacy and battery settings before entering the runtime", () => {
    handleBluetoothTransition(CONNECTED, {
      enabled: true,
      showBattery: false,
      showDeviceName: false,
    });

    expect(noticeRuntime.getSnapshot().current?.payload).toMatchObject({
      deviceName: "蓝牙耳机",
      batteryPercent: null,
    });
  });

  it.each([
    ["audio", "蓝牙耳机"],
    ["mouse", "蓝牙鼠标"],
    ["keyboard", "蓝牙键盘"],
    ["pen", "蓝牙触控笔"],
    ["gamepad", "蓝牙手柄"],
    ["phone", "蓝牙手机"],
    ["wearable", "蓝牙穿戴设备"],
    ["generic", "蓝牙设备"],
  ] satisfies [BluetoothDeviceKind, string][])(
    "uses a category-preserving privacy alias for %s",
    (kind, alias) => {
      handleBluetoothTransition(
        {
          ...CONNECTED,
          id: kind,
          device: CONNECTED.device ? { ...CONNECTED.device, id: kind, kind } : null,
        },
        {
          enabled: true,
          showBattery: true,
          showDeviceName: false,
        },
      );
      expect(noticeRuntime.getSnapshot().current?.payload.deviceName).toBe(alias);
    },
  );

  it("does not publish while native observation is disabled", () => {
    handleBluetoothTransition(CONNECTED, {
      enabled: false,
      showBattery: true,
      showDeviceName: true,
    });

    expect(noticeRuntime.getSnapshot().current).toBeNull();
  });

  it("does not publish low battery while battery display is disabled", () => {
    handleBluetoothTransition(
      { ...CONNECTED, phase: "lowBattery" },
      {
        enabled: true,
        showBattery: false,
        showDeviceName: true,
      },
    );

    expect(noticeRuntime.getSnapshot().current).toBeNull();
  });

  it("keeps unknown battery explicit instead of inventing a percentage", () => {
    handleBluetoothTransition(
      {
        ...CONNECTED,
        device: CONNECTED.device
          ? { ...CONNECTED.device, batteryPercent: null }
          : null,
      },
      {
        enabled: true,
        showBattery: true,
        showDeviceName: true,
      },
    );
    expect(noticeRuntime.getSnapshot().current?.payload.batteryPercent).toBeNull();
  });

  it("replaces a stale low-battery alert with the latest device state", () => {
    handleBluetoothTransition(
      { ...CONNECTED, phase: "lowBattery" },
      {
        enabled: true,
        showBattery: true,
        showDeviceName: true,
      },
    );
    expect(noticeRuntime.getSnapshot().current?.phase).toBe("low-battery");

    handleBluetoothTransition(
      {
        ...CONNECTED,
        phase: "disconnected",
        device: CONNECTED.device
          ? { ...CONNECTED.device, connected: false }
          : null,
      },
      {
        enabled: true,
        showBattery: true,
        showDeviceName: true,
      },
    );
    expect(noticeRuntime.getSnapshot().current?.phase).toBe("disconnected");
    expect(
      noticeRuntime
        .getSnapshot()
        .pending.some((notice) => notice.phase === "low-battery"),
    ).toBe(false);
  });

  it("restores prior island content after a Bluetooth notice expires", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    runtime.upsert({
      id: "hud:volume",
      source: "volume",
      kind: "hud",
      phase: "updated",
      priority: NOTICE_PRIORITY.hud,
      ttlMs: 1_600,
      payload: { kind: "volume" },
    });
    now = 600;
    runtime.upsert({
      id: "bluetooth:headphones",
      source: "bluetooth",
      kind: "lifecycle",
      phase: "connected",
      priority: NOTICE_PRIORITY.lifecycle,
      ttlMs: 3_000,
      payload: {
        deviceName: "Private Headphones",
        deviceKind: "audio",
        batteryPercent: 64,
      },
    });
    expect(runtime.getSnapshot().current?.source).toBe("bluetooth");

    now = 3_600;
    runtime.tick();
    expect(runtime.getSnapshot().current?.id).toBe("hud:volume");

    now = 4_600;
    runtime.tick();
    expect(runtime.getSnapshot().current).toBeNull();
  });

  it("keeps a settings-read degradation across native bootstrap snapshots", () => {
    handleBluetoothSnapshot(
      { phase: "stopped", devices: [], reason: null },
      {
        enabled: false,
        showBattery: true,
        showDeviceName: true,
        settingsError: "设置不可读取",
      },
    );

    expect(useBluetooth.getState().snapshot).toEqual({
      phase: "degraded",
      devices: [],
      reason: "设置不可读取",
    });
  });

  it("retains multiple native observations without publishing a baseline notice", () => {
    handleBluetoothSnapshot(
      {
        phase: "ready",
        devices: [
          {
            id: "mouse",
            name: "Mouse",
            kind: "mouse",
            connected: true,
            batteryPercent: null,
          },
          {
            id: "keyboard",
            name: "Keyboard",
            kind: "keyboard",
            connected: true,
            batteryPercent: 80,
          },
        ],
        reason: null,
      },
      {
        enabled: true,
        showBattery: true,
        showDeviceName: true,
      },
    );
    expect(
      useBluetooth.getState().snapshot.devices.map((device) => device.kind),
    ).toEqual([
      "mouse",
      "keyboard",
    ]);
    expect(noticeRuntime.getSnapshot().current).toBeNull();
  });
});
