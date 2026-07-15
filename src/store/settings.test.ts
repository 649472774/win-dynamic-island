import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setBluetoothObservation: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = mocks.get;
    set = vi.fn();
    save = vi.fn();
  },
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isEnabled: vi.fn(async () => false),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("../lib/native", () => ({
  getBluetoothStatus: vi.fn(),
  onBluetoothStatus: vi.fn(async () => vi.fn()),
  onBluetoothTransition: vi.fn(async () => vi.fn()),
  onGlassStatusChanged: vi.fn(async () => vi.fn()),
  setBluetoothObservation: mocks.setBluetoothObservation,
  setGlassEnabled: vi.fn(async () => ({
    requested: false,
    active: false,
    supported: true,
    renderer: "css",
    fallbackReason: null,
    intensity: "balanced",
  })),
}));

describe("settings hydration", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.setBluetoothObservation.mockReset();
  });

  it("fails closed and preserves degradation when Bluetooth settings cannot load", async () => {
    mocks.get.mockImplementation(async (key: string) => {
      if (key === "bluetooth.notifications.v1") {
        throw new Error("store unavailable");
      }
      return undefined;
    });
    mocks.setBluetoothObservation.mockResolvedValue({
      phase: "stopped",
      devices: [],
      reason: null,
    });

    const [{ useSettings }, { useBluetooth }] = await Promise.all([
      import("./settings"),
      import("./bluetooth"),
    ]);
    await useSettings.getState().hydrate();

    expect(mocks.setBluetoothObservation).toHaveBeenCalledWith(false);
    expect(useSettings.getState().bluetoothNotifications).toBe(false);
    expect(useBluetooth.getState().snapshot).toMatchObject({
      phase: "degraded",
      devices: [],
    });
  });
});
