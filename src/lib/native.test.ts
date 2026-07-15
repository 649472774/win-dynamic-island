import { describe, expect, it } from "vitest";
import {
  isBluetoothDeviceSnapshot,
  isBluetoothSnapshot,
  isBluetoothTransition,
  type BluetoothDeviceKind,
} from "./native";

const DEVICE_KINDS: BluetoothDeviceKind[] = [
  "audio",
  "mouse",
  "keyboard",
  "pen",
  "gamepad",
  "phone",
  "wearable",
  "generic",
];

describe("Bluetooth native payload validation", () => {
  it.each(DEVICE_KINDS)("accepts the closed %s device kind", (kind) => {
    expect(
      isBluetoothDeviceSnapshot({
        id: `bt-${kind}`,
        name: "Paired device",
        kind,
        connected: true,
        batteryPercent: null,
      }),
    ).toBe(true);
  });

  it("rejects erased kinds and invalid battery values", () => {
    expect(
      isBluetoothDeviceSnapshot({
        id: "bt-unknown",
        name: "Paired device",
        kind: "trackball",
        connected: true,
        batteryPercent: null,
      }),
    ).toBe(false);
    expect(
      isBluetoothDeviceSnapshot({
        id: "bt-mouse",
        name: "Paired device",
        kind: "mouse",
        connected: true,
        batteryPercent: 101,
      }),
    ).toBe(false);
  });

  it("validates bounded snapshots and transition envelopes", () => {
    const device = {
      id: "bt-mouse",
      name: "Mouse",
      kind: "mouse",
      connected: true,
      batteryPercent: 72,
    };
    expect(
      isBluetoothSnapshot({
        phase: "ready",
        devices: [device],
        reason: null,
      }),
    ).toBe(true);
    expect(
      isBluetoothTransition({
        id: "bt-mouse",
        phase: "connected",
        atMs: 1_000,
        device,
        reason: null,
      }),
    ).toBe(true);
    expect(
      isBluetoothTransition({
        id: "bt-mouse",
        phase: "invented",
        atMs: 1_000,
        device,
        reason: null,
      }),
    ).toBe(false);
  });
});
