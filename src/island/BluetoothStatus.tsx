import type { NoticeEvent } from "../store/notices";
import { dismissNotice } from "../store/notices";
import { bluetoothPrivacyAlias } from "../store/bluetooth";
import { type BluetoothDeviceKind } from "../lib/native";
import { registerNoticeRenderer } from "./noticeRenderers";

const DEVICE_KINDS = new Set<string>([
  "audio",
  "mouse",
  "keyboard",
  "pen",
  "gamepad",
  "phone",
  "wearable",
  "generic",
]);

function DeviceGlyph({
  kind,
  className = "",
}: {
  kind: BluetoothDeviceKind;
  className?: string;
}) {
  let paths: React.ReactNode;
  switch (kind) {
    case "audio":
      paths = (
        <>
          <path d="M4 14v-3a8 8 0 0 1 16 0v3" />
          <path d="M4 14a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2ZM20 14a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2Z" />
        </>
      );
      break;
    case "mouse":
      paths = (
        <>
          <rect x="7" y="3" width="10" height="18" rx="5" />
          <path d="M12 3v6" />
        </>
      );
      break;
    case "keyboard":
      paths = (
        <>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10" />
        </>
      );
      break;
    case "pen":
      paths = (
        <>
          <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10Z" />
          <path d="m13.5 7 3.5 3.5M4 20l1-4.5" />
        </>
      );
      break;
    case "gamepad":
      paths = (
        <>
          <path d="M8 8h8a5 5 0 0 1 4.8 6.4l-.7 2.3a2.5 2.5 0 0 1-4.2 1l-1.2-1.3H9.3l-1.2 1.3a2.5 2.5 0 0 1-4.2-1l-.7-2.3A5 5 0 0 1 8 8Z" />
          <path d="M7 11v4M5 13h4M16.5 12h.01M18.5 14h.01" />
        </>
      );
      break;
    case "phone":
      paths = (
        <>
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
          <path d="M10 5h4M11.5 18.5h1" />
        </>
      );
      break;
    case "wearable":
      paths = (
        <>
          <path d="m9 3-1 4m7-4 1 4M9 21l-1-4m7 4 1-4" />
          <rect x="6" y="7" width="12" height="10" rx="3" />
          <path d="M12 10v3l2 1" />
        </>
      );
      break;
    case "generic":
      paths = <path d="m7 7 10 10-5 4V3l5 4L7 17" />;
      break;
  }
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths}
    </svg>
  );
}

function StatusMark({ phase }: { phase: NoticeEvent["phase"] }) {
  if (phase === "low-battery" || phase === "degraded" || phase === "error") {
    return <span className="bt-state-mark" aria-hidden="true">!</span>;
  }
  if (phase === "disconnected") {
    return <span className="bt-state-mark" aria-hidden="true">×</span>;
  }
  return <span className="bt-state-mark" aria-hidden="true">✓</span>;
}

const PHASE_LABEL: Record<NoticeEvent["phase"], string> = {
  updated: "状态更新",
  connecting: "正在连接",
  connected: "已连接",
  disconnected: "已断开",
  "battery-updated": "电量更新",
  "low-battery": "电量偏低",
  degraded: "状态暂不可用",
  error: "状态读取失败",
};

function payloadString(notice: NoticeEvent, key: string): string | null {
  const value = notice.payload[key];
  return typeof value === "string" && value ? value : null;
}

function payloadNumber(notice: NoticeEvent, key: string): number | null {
  const value = notice.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isBluetoothDeviceKind(value: unknown): value is BluetoothDeviceKind {
  return typeof value === "string" && DEVICE_KINDS.has(value);
}

function payloadDeviceKind(notice: NoticeEvent): BluetoothDeviceKind {
  const value = notice.payload.deviceKind;
  return isBluetoothDeviceKind(value) ? value : "generic";
}

export function BluetoothNotice({ notice }: { notice: NoticeEvent }) {
  const deviceKind = payloadDeviceKind(notice);
  const deviceName =
    payloadString(notice, "deviceName") ?? bluetoothPrivacyAlias(deviceKind);
  const battery = payloadNumber(notice, "batteryPercent");
  return (
    <div
      className={`bt-notice phase-${notice.phase}`}
      role={notice.phase === "low-battery" ? "alert" : "status"}
      aria-live={notice.phase === "low-battery" ? "assertive" : "polite"}
    >
      <span className="bt-notice-icon">
        <DeviceGlyph kind={deviceKind} />
        <StatusMark phase={notice.phase} />
      </span>
      <span className="bt-notice-copy">
        <span className="bt-notice-name" title={deviceName}>
          {deviceName}
        </span>
        <span className="bt-notice-state">
          {PHASE_LABEL[notice.phase]}
          {battery != null ? ` · ${Math.round(battery)}%` : ""}
        </span>
      </span>
      <button
        type="button"
        className="bt-notice-dismiss"
        aria-label="关闭蓝牙通知"
        title="关闭"
        onClick={(event) => {
          event.stopPropagation();
          dismissNotice(notice);
        }}
      >
        ×
      </button>
    </div>
  );
}

registerNoticeRenderer({
  source: "bluetooth",
  size: { w: 360, h: 52, r: 26 },
  Component: BluetoothNotice,
});
