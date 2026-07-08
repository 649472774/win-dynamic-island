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
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { getSystemInfo, onSystemUpdate, type SystemInfo } from "../lib/native";

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

/** A labelled meter (CPU / memory) with a thin fill bar. */
function Meter({
  icon,
  label,
  value,
  pct,
  warn,
}: {
  icon: string;
  label: string;
  value: string;
  pct: number;
  warn?: boolean;
}) {
  return (
    <div className="sys-stat">
      <div className="sys-stat-head">
        <span className="sys-stat-icon">{icon}</span>
        <span className="sys-stat-value">{value}</span>
      </div>
      <div className="sys-bar">
        <div
          className={`sys-bar-fill${warn ? " warn" : ""}`}
          style={barStyle(pct)}
        />
      </div>
      <div className="sys-stat-label">{label}</div>
    </div>
  );
}

function BatteryStat({ info }: { info: SystemInfo }) {
  if (!info.hasBattery) {
    // Desktop / no battery: just show the mains state.
    return (
      <div className="sys-stat">
        <div className="sys-stat-head">
          <span className="sys-stat-icon">🔌</span>
          <span className="sys-stat-value">交流电</span>
        </div>
        <div className="sys-bar">
          <div className="sys-bar-fill" style={barStyle(100)} />
        </div>
        <div className="sys-stat-label">电源</div>
      </div>
    );
  }
  const pct = info.batteryPercent < 0 ? 0 : info.batteryPercent;
  const icon = info.charging ? "⚡" : info.lowBattery ? "🪫" : "🔋";
  const label = info.charging ? "充电中" : info.lowBattery ? "低电量" : "电量";
  return (
    <div className="sys-stat">
      <div className="sys-stat-head">
        <span className="sys-stat-icon">{icon}</span>
        <span className="sys-stat-value">{pct}%</span>
      </div>
      <div className="sys-bar">
        <div
          className={`sys-bar-fill${info.lowBattery ? " warn" : ""}`}
          style={barStyle(pct)}
        />
      </div>
      <div className={`sys-stat-label${info.lowBattery ? " warn" : ""}`}>{label}</div>
    </div>
  );
}

function SystemTile(_: IslandModuleProps) {
  const info = useSystem((s) => s.info);
  const memGb = (mb: number) => (mb / 1024).toFixed(1);
  const memValue =
    info.memTotalMb > 0 ? `${memGb(info.memUsedMb)}/${memGb(info.memTotalMb)}G` : "—";
  return (
    <div className="sys-tile">
      <BatteryStat info={info} />
      <Meter
        icon="🖥"
        label="CPU"
        value={`${clampPct(info.cpuPercent)}%`}
        pct={info.cpuPercent}
        warn={info.cpuPercent >= 85}
      />
      <Meter
        icon="💾"
        label={memValue}
        value={`${clampPct(info.memPercent)}%`}
        pct={info.memPercent}
        warn={info.memPercent >= 90}
      />
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
