/**
 * Demo module for M1: a live clock. Also serves as the reference example for
 * how to author an island module.
 */
import { useEffect, useState } from "react";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";

const pad = (n: number) => n.toString().padStart(2, "0");
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function CollapsedClock(_: IslandModuleProps) {
  const now = useNow();
  return (
    <div className="mod-clock-collapsed">
      <span className="pulse-dot" />
      <span className="clock-time">
        {pad(now.getHours())}:{pad(now.getMinutes())}
      </span>
    </div>
  );
}

function ExpandedClock(_: IslandModuleProps) {
  const now = useNow();
  return (
    <div className="mod-clock-expanded">
      <div className="big-time">
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span className="seconds">{pad(now.getSeconds())}</span>
      </div>
      <div className="big-date">
        {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 ·{" "}
        {WEEKDAYS[now.getDay()]}
      </div>
    </div>
  );
}

registerModule({
  id: "clock",
  title: "时钟",
  priority: 10,
  Collapsed: CollapsedClock,
  Expanded: ExpandedClock,
});
