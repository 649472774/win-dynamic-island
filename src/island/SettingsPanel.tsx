/**
 * Settings view shown inside the expanded panel (M4e / Plan A).
 *
 * Reached via right-click on the island or the tray's "设置" item (both call
 * `openSettings`). Deliberately a first-party panel rather than a pluggable
 * island module, since it configures the shell itself.
 */
import { useIsland } from "../store/island";
import { GAUGE_ORDER, useSettings, type GaugeStyle } from "../store/settings";

const GAUGE_LABEL: Record<GaugeStyle, string> = {
  inline: "单行",
  bar: "条形",
  ring: "环形",
};

export default function SettingsPanel() {
  const closeSettings = useIsland((s) => s.closeSettings);
  const gaugeStyle = useSettings((s) => s.gaugeStyle);
  const setGaugeStyle = useSettings((s) => s.setGaugeStyle);
  const autostart = useSettings((s) => s.autostart);
  const setAutostart = useSettings((s) => s.setAutostart);

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

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">开机自启</span>
            <span className="settings-desc">登录 Windows 时自动启动灵动岛</span>
          </div>
          <button
            className={`switch${autostart ? " on" : ""}`}
            role="switch"
            aria-checked={autostart}
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
