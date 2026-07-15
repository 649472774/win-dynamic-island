import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BluetoothNotice } from "./BluetoothStatus";
import {
  NOTICE_PRIORITY,
  type NoticeEvent,
  type NoticeKind,
  type NoticePriority,
} from "../store/notices";

function notice(
  phase: NoticeEvent["phase"],
  kind: NoticeKind,
  priority: NoticePriority,
): NoticeEvent {
  return {
    id: "bluetooth:device",
    source: "bluetooth",
    kind,
    phase,
    priority,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 3_000,
    ttlMs: 3_000,
    cooldownMs: 500,
    payload: {
      deviceName: "Surface Arc Mouse",
      deviceKind: "mouse",
      batteryPercent:
        phase === "battery-updated" || phase === "low-battery" ? 12 : null,
    },
  };
}

describe("Bluetooth transient notices", () => {
  it.each([
    ["connected", "lifecycle", NOTICE_PRIORITY.lifecycle, "已连接"],
    ["disconnected", "lifecycle", NOTICE_PRIORITY.lifecycle, "已断开"],
    ["battery-updated", "status", NOTICE_PRIORITY.lifecycle, "电量更新"],
    ["low-battery", "alert", NOTICE_PRIORITY.urgent, "电量偏低"],
    ["degraded", "service", NOTICE_PRIORITY.service, "状态暂不可用"],
  ] as const)("renders the %s event without a home module", (phase, kind, priority, label) => {
    const markup = renderToStaticMarkup(
      <BluetoothNotice notice={notice(phase, kind, priority)} />,
    );

    expect(markup).toContain(label);
    expect(markup).toContain("bt-notice");
    expect(markup).not.toContain("bt-status-row");
  });
});
