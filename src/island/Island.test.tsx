import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../modules", () => ({
  getAllModules: () => [],
  getPrimaryModule: () => null,
}));
vi.mock("../modules/shelf", () => ({
  useShelfDrag: () => {},
}));

import Island from "./Island";
import { getNoticeRenderer } from "./noticeRenderers";
import { useIsland } from "../store/island";
import { useBluetooth } from "../store/bluetooth";
import type { BluetoothSnapshot } from "../lib/native";

const MOUSE = {
  id: "mouse",
  name: "Mouse",
  kind: "mouse" as const,
  connected: true,
  batteryPercent: null,
};

const SNAPSHOTS: Array<[string, BluetoothSnapshot]> = [
  ["no devices", { phase: "ready", devices: [], reason: null }],
  ["one device", { phase: "ready", devices: [MOUSE], reason: null }],
  [
    "multiple devices",
    {
      phase: "ready",
      devices: [
        MOUSE,
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
  ],
  [
    "degraded service",
    { phase: "degraded", devices: [], reason: "Watcher stopped" },
  ],
];

describe("expanded home", () => {
  afterEach(() => {
    useIsland.setState({ state: "collapsed", settingsOpen: false });
    useBluetooth.setState({
      snapshot: { phase: "stopped", devices: [], reason: null },
    });
  });

  it.each(SNAPSHOTS)("renders no Bluetooth surface for %s", (_, snapshot) => {
    useIsland.setState({ state: "expanded", settingsOpen: false });
    useBluetooth.setState({ snapshot });

    const markup = renderToStaticMarkup(<Island />);

    expect(markup).not.toContain("bt-status-row");
    expect(markup).not.toContain("当前蓝牙设备");
    expect(markup).not.toContain("打开 Windows 蓝牙设置");
  });
});

describe("transient notice providers", () => {
  it("registers the Bluetooth renderer without a persistent home component", () => {
    expect(getNoticeRenderer("bluetooth")?.Component).toBeTypeOf("function");
  });
});
