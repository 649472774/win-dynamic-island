/**
 * P1 — System info (M3): battery, CPU load and memory usage.
 *
 * This is a *panel-only* module: it never owns the collapsed pill (its
 * `isActive` returns false), it just contributes a compact stats card to the
 * expanded panel's module grid. A single Rust worker pushes `system-update`
 * events (~every 2 s); we keep a tiny store and answer the first paint from
 * `get_system_info`.
 */
import { create } from "zustand";
import type { MouseEvent } from "react";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { getSystemInfo, onSystemUpdate, type SystemInfo } from "../lib/native";
import { useSettings } from "../store/settings";

const EMPTY: SystemInfo = {
  hasBattery: false,
  batteryPercent: -1,
  charging: false,
  onAc: true,
  lowBattery: false,
  cpuPercent: 0,
  memPercent: 0,
  memUsedMb: 0,
  memTotalMb: 0,
};

interface SysStore {
  info: SystemInfo;
  set: (info: SystemInfo) => void;
}

const useSystem = create<SysStore>((set) => ({
  info: EMPTY,
  set: (info) => set({ info }),
}));

// One-time bootstrap on import: seed the initial snapshot, then subscribe.
let started = false;
function ensureStarted(): void {
  if (started) return;
  started = true;
  void getSystemInfo()
    .then((info) => useSystem.getState().set(info))
    .catch(() => {});
  void onSystemUpdate((info) => useSystem.getState().set(info));
}
ensureStarted();

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Horizontal fill via transform (avoids animating layout width). */
const barStyle = (pct: number) => ({ transform: `scaleX(${clampPct(pct) / 100})` });

/** Geometry for the circular gauge (SVG user units). */
const RING_R = 24;
const RING_C = 2 * Math.PI * RING_R;

/** Common data for one stat, independent of how it's drawn. */
interface StatData {
  icon: string;
  label: string;
  value: string;
  pct: number;
  warn?: boolean;
}

/** Bar variant: value on top, a thin fill bar, label underneath. */
function BarStat({ icon, label, value, pct, warn }: StatData) {
  return (
    <div className="sys-stat">
      <div className="sys-stat-head">
        <span className="sys-stat-icon">{icon}</span>
        <span className="sys-stat-value">{value}</span>
      </div>
      <div className="sys-bar">
        <div className={`sys-bar-fill${warn ? " warn" : ""}`} style={barStyle(pct)} />
      </div>
      <div className={`sys-stat-label${warn ? " warn" : ""}`}>{label}</div>
    </div>
  );
}

/** Ring variant: a circular gauge with the icon + value in the centre. */
function RingStat({ icon, label, value, pct, warn }: StatData) {
  // Fill the arc by "unrolling" the dash from a full circumference. The circle is
  // rotated -90° (in CSS) so 0% starts at 12 o'clock and grows clockwise.
  const offset = RING_C * (1 - clampPct(pct) / 100);
  return (
    <div className="sys-stat sys-stat-ring">
      <div className="sys-ring-wrap">
        <svg className="sys-ring" viewBox="0 0 56 56" aria-hidden="true">
          <circle className="sys-ring-track" cx="28" cy="28" r={RING_R} />
          <circle
            className={`sys-ring-fill${warn ? " warn" : ""}`}
            cx="28"
            cy="28"
            r={RING_R}
            style={{ strokeDasharray: RING_C, strokeDashoffset: offset }}
          />
        </svg>
        <div className="sys-ring-center">
          <span className="sys-ring-icon">{icon}</span>
          <span className={`sys-ring-value${warn ? " warn" : ""}`}>{value}</span>
        </div>
      </div>
      <div className={`sys-stat-label${warn ? " warn" : ""}`}>{label}</div>
    </div>
  );
}

/** Compute the battery stat's display data from the current snapshot. */
function batteryData(info: SystemInfo): StatData {
  if (!info.hasBattery) {
    // Desktop / no battery: show a full "on mains" gauge.
    return { icon: "🔌", label: "电源", value: "交流电", pct: 100 };
  }
  const pct = info.batteryPercent < 0 ? 0 : info.batteryPercent;
  const icon = info.charging ? "⚡" : info.lowBattery ? "🪫" : "🔋";
  const label = info.charging ? "充电中" : info.lowBattery ? "低电量" : "电量";
  return { icon, label, value: `${pct}%`, pct, warn: info.lowBattery };
}

function SystemTile(_: IslandModuleProps) {
  const info = useSystem((s) => s.info);
  const gaugeStyle = useSettings((s) => s.gaugeStyle);
  const toggleGaugeStyle = useSettings((s) => s.toggleGaugeStyle);

  const Stat = gaugeStyle === "ring" ? RingStat : BarStat;
  const ring = gaugeStyle === "ring";

  const memGb = (mb: number) => (mb / 1024).toFixed(1);
  const memValue =
    info.memTotalMb > 0 ? `${memGb(info.memUsedMb)}/${memGb(info.memTotalMb)}G` : "—";

  // In both modes the value is the percentage; the used/total sits under the
  // bar (bar mode) or beneath the ring as the label (ring mode).
  const memStat: StatData = {
    icon: "💾",
    value: `${clampPct(info.memPercent)}%`,
    label: memValue,
    pct: info.memPercent,
    warn: info.memPercent >= 90,
  };

  const onToggle = (e: MouseEvent) => {
    // Don't let the click bubble to the pill (which would collapse the panel).
    e.stopPropagation();
    toggleGaugeStyle();
  };

  return (
    <div className={`sys-tile${ring ? " ring" : ""}`}>
      <button
        className="sys-toggle"
        onClick={onToggle}
        title={ring ? "切换为条形" : "切换为环形"}
        aria-label="切换占用条样式"
      >
        {ring ? "▭" : "◍"}
      </button>
      <Stat {...batteryData(info)} />
      <Stat
        icon="🖥"
        label="CPU"
        value={`${clampPct(info.cpuPercent)}%`}
        pct={info.cpuPercent}
        warn={info.cpuPercent >= 85}
      />
      <Stat {...memStat} />
    </div>
  );
}

registerModule({
  id: "system",
  title: "系统",
  // Panel-only: never wins the collapsed pill (isActive === false), so priority
  // is only used for ordering within the expanded grid / footer.
  priority: 50,
  Tile: SystemTile,
  isActive: () => false,
});
