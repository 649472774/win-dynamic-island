/**
 * P1 — System info (M3): battery, CPU load and memory usage.
 *
 * This is a *panel-only* module: it never owns the collapsed pill (its
 * `isActive` returns false), it just contributes a compact stats card to the
 * expanded panel's module grid. A single Rust worker pushes `system-update`
 * events (~every 2 s); we keep a tiny store and answer the first paint from
 * `get_system_info`.
 *
 * The card supports three render styles (persisted in settings, chosen from the
 * settings panel):
 *   - "inline": one dense row per stat — icon · name · thin bar · value.
 *   - "bar":    three columns of small stacked bars.
 *   - "ring" (default): three small circular gauges with the value beside the ring.
 */
import { create } from "zustand";
import type { ReactElement } from "react";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { getSystemInfo, onSystemUpdate, type SystemInfo } from "../lib/native";
import { useSettings, type GaugeStyle } from "../store/settings";

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

/** Geometry for the small circular gauge (SVG user units, r=15 in a 38px box). */
const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

/** Common data for one stat, independent of how it's drawn. */
interface StatData {
  icon: string;
  /** Short name, e.g. "电量" / "CPU" / "内存". */
  name: string;
  /** Primary readout, e.g. "85%". */
  value: string;
  pct: number;
  /** Optional detail, e.g. "9.4/16.0G" (memory). */
  sub?: string;
  warn?: boolean;
}

/** A — inline row: icon · name · thin fill bar · value · (optional detail). */
function InlineStat({ icon, name, value, pct, sub, warn }: StatData) {
  return (
    <div className="sys-row">
      <span className="sys-row-ic">{icon}</span>
      <span className="sys-row-name">{name}</span>
      <span className="sys-row-track">
        <span
          className={`sys-row-fill${warn ? " warn" : ""}`}
          style={{ width: `${clampPct(pct)}%` }}
        />
      </span>
      <span className={`sys-row-val${warn ? " warn" : ""}`}>{value}</span>
      <span className="sys-row-sub">{sub || ""}</span>
    </div>
  );
}

/** B — column: value on top, a thin fill bar, a label underneath. */
function BarStat({ icon, name, value, pct, sub, warn }: StatData) {
  return (
    <div className="sys-stat">
      <div className="sys-stat-head">
        <span className="sys-stat-icon">{icon}</span>
        <span className="sys-stat-value">{value}</span>
      </div>
      <div className="sys-bar">
        <div
          className={`sys-bar-fill${warn ? " warn" : ""}`}
          style={{ transform: `scaleX(${clampPct(pct) / 100})` }}
        />
      </div>
      <div className={`sys-stat-label${warn ? " warn" : ""}`}>{sub || name}</div>
    </div>
  );
}

/** D — small ring with the icon inside and the value/label beside it. */
function RingStat({ icon, name, value, pct, sub, warn }: StatData) {
  // The circle is rotated -90° (CSS) so 0% starts at 12 o'clock, grows clockwise.
  const offset = RING_C * (1 - clampPct(pct) / 100);
  return (
    <div className="sys-stat sys-stat-ring">
      <div className="sys-ring-wrap">
        <svg className="sys-ring" viewBox="0 0 38 38" aria-hidden="true">
          <circle className="sys-ring-track" cx="19" cy="19" r={RING_R} />
          <circle
            className={`sys-ring-fill${warn ? " warn" : ""}`}
            cx="19"
            cy="19"
            r={RING_R}
            style={{ strokeDasharray: RING_C, strokeDashoffset: offset }}
          />
        </svg>
        <span className="sys-ring-icon">{icon}</span>
      </div>
      <div className="sys-ring-text">
        <span className={`sys-ring-value${warn ? " warn" : ""}`}>{value}</span>
        <span className="sys-ring-label">{sub || name}</span>
      </div>
    </div>
  );
}

/** Compute the battery stat's display data from the current snapshot. */
function batteryData(info: SystemInfo): StatData {
  if (!info.hasBattery) {
    // Desktop / no battery: show a full "on mains" gauge.
    return { icon: "🔌", name: "电源", value: "交流电", pct: 100 };
  }
  const pct = info.batteryPercent < 0 ? 0 : info.batteryPercent;
  const icon = info.charging ? "⚡" : info.lowBattery ? "🪫" : "🔋";
  const name = info.charging ? "充电中" : info.lowBattery ? "低电量" : "电量";
  return { icon, name, value: `${pct}%`, pct, warn: info.lowBattery };
}

/** Maps each gauge style to its stat renderer. */
const STAT_RENDERER: Record<GaugeStyle, (s: StatData) => ReactElement> = {
  inline: InlineStat,
  bar: BarStat,
  ring: RingStat,
};

function SystemTile(_: IslandModuleProps) {
  const info = useSystem((s) => s.info);
  const gaugeStyle = useSettings((s) => s.gaugeStyle);

  const Stat = STAT_RENDERER[gaugeStyle];

  const memGb = (mb: number) => (mb / 1024).toFixed(1);
  const memSub =
    info.memTotalMb > 0 ? `${memGb(info.memUsedMb)}/${memGb(info.memTotalMb)}G` : undefined;

  const memStat: StatData = {
    icon: "💾",
    name: "内存",
    value: `${clampPct(info.memPercent)}%`,
    pct: info.memPercent,
    sub: memSub,
    warn: info.memPercent >= 90,
  };

  const cpuStat: StatData = {
    icon: "🖥",
    name: "CPU",
    value: `${clampPct(info.cpuPercent)}%`,
    pct: info.cpuPercent,
    warn: info.cpuPercent >= 85,
  };

  return (
    <div className={`sys-tile style-${gaugeStyle}`}>
      <Stat {...batteryData(info)} />
      <Stat {...cpuStat} />
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
