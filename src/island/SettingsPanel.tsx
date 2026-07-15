/**
 * Settings view shown inside the expanded panel (M4e / Plan A).
 *
 * Reached via right-click on the island or the tray's "设置" item (both call
 * `openSettings`). Deliberately a first-party panel rather than a pluggable
 * island module, since it configures the shell itself.
 */
import { useIsland } from "../store/island";
import { openBluetoothSettings } from "../lib/native";
import {
  GAUGE_ORDER,
  GLASS_INTENSITY_ORDER,
  useSettings,
  type GaugeStyle,
  type GlassIntensity,
} from "../store/settings";

const GAUGE_LABEL: Record<GaugeStyle, string> = {
  inline: "单行",
  bar: "条形",
  ring: "环形",
};

const GLASS_INTENSITY_LABEL: Record<GlassIntensity, string> = {
  subtle: "淡雅",
  balanced: "平衡",
  vivid: "明显",
};

export default function SettingsPanel() {
  const closeSettings = useIsland((s) => s.closeSettings);
  const loaded = useSettings((s) => s.loaded);
  const gaugeStyle = useSettings((s) => s.gaugeStyle);
  const setGaugeStyle = useSettings((s) => s.setGaugeStyle);
  const autostart = useSettings((s) => s.autostart);
  const setAutostart = useSettings((s) => s.setAutostart);
  const glassEnabled = useSettings((s) => s.glassEnabled);
  const glassIntensity = useSettings((s) => s.glassIntensity);
  const glassStatus = useSettings((s) => s.glassStatus);
  const glassPending = useSettings((s) => s.glassPending);
  const setGlassEnabled = useSettings((s) => s.setGlassEnabled);
  const setGlassIntensity = useSettings((s) => s.setGlassIntensity);
  const glassBusy = !loaded || glassPending;
  const bluetoothNotifications = useSettings((s) => s.bluetoothNotifications);
  const bluetoothShowBattery = useSettings((s) => s.bluetoothShowBattery);
  const bluetoothShowDeviceName = useSettings((s) => s.bluetoothShowDeviceName);
  const bluetoothPending = useSettings((s) => s.bluetoothPending);
  const setBluetoothNotifications = useSettings(
    (s) => s.setBluetoothNotifications,
  );
  const setBluetoothShowBattery = useSettings(
    (s) => s.setBluetoothShowBattery,
  );
  const setBluetoothShowDeviceName = useSettings(
    (s) => s.setBluetoothShowDeviceName,
  );
  const bluetoothBusy = !loaded || bluetoothPending;

  const glassDescription = !loaded
    ? "正在读取本地设置"
    : glassPending
      ? "正在切换 Windows 原生合成器"
      : glassStatus.active
        ? "已启用 · 桌面背景实时模糊"
        : glassEnabled && glassStatus.fallbackReason
          ? `已回退 · ${glassStatus.fallbackReason}`
          : "Windows 11 真实毛玻璃（技术预览）";

  return (
    <div className="settings-panel">
      <header className="panel-header">
        <span className="panel-title">设置</span>
        <button
          className="settings-close"
          onClick={(e) => {
            e.stopPropagation();
            closeSettings();
          }}
          title="返回"
        >
          ✕
        </button>
      </header>

      <div className="settings-body" onClick={(e) => e.stopPropagation()}>
        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">系统信息样式</span>
            <span className="settings-desc">占用条的显示方式</span>
          </div>
          <div className="seg">
            {GAUGE_ORDER.map((g) => (
              <button
                key={g}
                className={`seg-item${g === gaugeStyle ? " active" : ""}`}
                onClick={() => setGaugeStyle(g)}
              >
                {GAUGE_LABEL[g]}
              </button>
            ))}
          </div>
        </section>

        <div className="settings-group-label">蓝牙设备提醒</div>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">启用蓝牙设备提醒</span>
            <span className="settings-desc">观察已配对设备的连接状态</span>
          </div>
          <button
            className={`switch${bluetoothNotifications ? " on" : ""}`}
            role="switch"
            aria-checked={bluetoothNotifications}
            aria-label="启用蓝牙设备提醒"
            disabled={bluetoothBusy}
            onClick={() => setBluetoothNotifications(!bluetoothNotifications)}
          >
            <span className="switch-knob" />
          </button>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">Windows 蓝牙设置</span>
            <span className="settings-desc">配对与设备管理由 Windows 提供</span>
          </div>
          <button
            type="button"
            className="settings-escape-action"
            aria-label="打开 Windows 蓝牙设置"
            onClick={() => {
              void openBluetoothSettings().catch((error) => {
                console.error("Failed to open Windows Bluetooth settings", error);
              });
            }}
          >
            打开
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 17 17 7M8 7h9v9" />
            </svg>
          </button>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">显示电量</span>
            <span className="settings-desc">仅在 Windows 提供电量时显示</span>
          </div>
          <button
            className={`switch${bluetoothShowBattery ? " on" : ""}`}
            role="switch"
            aria-checked={bluetoothShowBattery}
            aria-label="显示蓝牙设备电量"
            disabled={bluetoothBusy || !bluetoothNotifications}
            onClick={() => setBluetoothShowBattery(!bluetoothShowBattery)}
          >
            <span className="switch-knob" />
          </button>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">显示设备名称</span>
            <span className="settings-desc">关闭后使用鼠标、键盘等类别别名</span>
          </div>
          <button
            className={`switch${bluetoothShowDeviceName ? " on" : ""}`}
            role="switch"
            aria-checked={bluetoothShowDeviceName}
            aria-label="显示蓝牙设备名称"
            disabled={bluetoothBusy || !bluetoothNotifications}
            onClick={() => setBluetoothShowDeviceName(!bluetoothShowDeviceName)}
          >
            <span className="switch-knob" />
          </button>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">玻璃强度</span>
            <span className="settings-desc">调整背景透出与暗色 tint</span>
          </div>
          <div className="seg">
            {GLASS_INTENSITY_ORDER.map((intensity) => (
              <button
                key={intensity}
                className={`seg-item${intensity === glassIntensity ? " active" : ""}`}
                disabled={glassBusy}
                onClick={() => setGlassIntensity(intensity)}
              >
                {GLASS_INTENSITY_LABEL[intensity]}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">真实毛玻璃</span>
            <span
              className={`settings-desc${glassEnabled && !glassStatus.active ? " degraded" : ""}`}
            >
              {glassDescription}
            </span>
          </div>
          <button
            className={`switch${glassEnabled ? " on" : ""}${glassEnabled && !glassStatus.active ? " degraded" : ""}`}
            role="switch"
            aria-checked={glassEnabled}
            aria-label="真实毛玻璃"
            disabled={glassBusy}
            onClick={() => setGlassEnabled(!glassEnabled)}
            title={glassDescription}
          >
            <span className="switch-knob" />
          </button>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">开机自启</span>
            <span className="settings-desc">登录 Windows 时自动启动灵动岛</span>
          </div>
          <button
            className={`switch${autostart ? " on" : ""}`}
            role="switch"
            aria-checked={autostart}
            aria-label="开机自启"
            onClick={() => setAutostart(!autostart)}
            title={autostart ? "已开启" : "已关闭"}
          >
            <span className="switch-knob" />
          </button>
        </section>
      </div>

      <footer className="panel-footer">右键灵动岛或托盘图标可随时打开设置</footer>
    </div>
  );
}
