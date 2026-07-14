/**
 * Settings view shown inside the expanded panel (M4e / Plan A).
 *
 * Reached via right-click on the island or the tray's "设置" item (both call
 * `openSettings`). Deliberately a first-party panel rather than a pluggable
 * island module, since it configures the shell itself.
 */
import { useIsland } from "../store/island";
import { refreshModuleActivities } from "../modules";
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
  const openHome = useIsland((s) => s.openHome);
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
  const timeEnabled = useSettings((s) => s.timeEnabled);
  const setTimeEnabled = useSettings((s) => s.setTimeEnabled);
  const timerDefaultMinutes = useSettings((s) => s.timerDefaultMinutes);
  const setTimerDefaultMinutes = useSettings((s) => s.setTimerDefaultMinutes);
  const timeSound = useSettings((s) => s.timeSound);
  const setTimeSound = useSettings((s) => s.setTimeSound);
  const glassBusy = !loaded || glassPending;

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
    <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
      <header className="panel-header">
        <span className="panel-title">设置</span>
        <button
          className="settings-close"
          data-panel-back
          onClick={(e) => {
            e.stopPropagation();
            openHome();
          }}
          title="返回"
          aria-label="返回主页"
        >
          ←
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
            <span className="settings-name">计时活动</span>
            <span className="settings-desc">在灵动岛显示计时器、秒表与番茄钟</span>
          </div>
          <button
            className={`switch${timeEnabled ? " on" : ""}`}
            role="switch"
            aria-checked={timeEnabled}
            onClick={() => {
              setTimeEnabled(!timeEnabled);
              queueMicrotask(() => refreshModuleActivities("time"));
            }}
            title={timeEnabled ? "已开启" : "已关闭"}
          >
            <span className="switch-knob" />
          </button>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">默认计时</span>
            <span className="settings-desc">新建计时器的默认分钟数</span>
          </div>
          <label className="settings-number">
            <input
              type="number"
              min="1"
              max="720"
              value={timerDefaultMinutes}
              onChange={(event) => setTimerDefaultMinutes(Number(event.target.value))}
              aria-label="默认计时分钟"
            />
            <span>分钟</span>
          </label>
        </section>

        <section className="settings-row">
          <div className="settings-label">
            <span className="settings-name">完成提示音</span>
            <span className="settings-desc">计时活动到期时播放本地提示音</span>
          </div>
          <button
            className={`switch${timeSound ? " on" : ""}`}
            role="switch"
            aria-checked={timeSound}
            onClick={() => setTimeSound(!timeSound)}
            title={timeSound ? "已开启" : "已静音"}
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
