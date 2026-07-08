/**
 * The Dynamic Island shell.
 *
 * A single motion element "morphs" between three states (collapsed / hover /
 * expanded). The native window itself never resizes — instead, on every
 * animation frame we report the pill's physical-pixel rectangle to Rust, which
 * clips the window to that rounded shape. That keeps the morph perfectly smooth
 * (stable WebView viewport) while giving us a real acrylic pill and automatic
 * click-through everywhere outside it.
 */
import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useIsland, type IslandState } from "../store/island";
import { useModulesVersion } from "../store/modules";
import { recenter, revealIsland, setIslandRegion } from "../lib/native";
import { getAllModules, getPrimaryModule } from "../modules";
import "../modules"; // ensure built-in modules register

/** Target geometry per state, in CSS pixels. */
const SIZES: Record<IslandState, { w: number; h: number; r: number }> = {
  collapsed: { w: 220, h: 38, r: 19 },
  hover: { w: 260, h: 44, r: 22 },
  expanded: { w: 520, h: 384, r: 30 },
};

/** Geometry for a transient HUD (e.g. the volume slider) over the pill. */
const HUD_SIZE = { w: 300, h: 46, r: 23 };

/** Spring tuned for a snappy ~250–320ms morph at 60fps. */
const MORPH: Transition = { type: "spring", stiffness: 380, damping: 32, mass: 0.9 };
const FADE: Transition = { duration: 0.16, ease: "easeOut" };

export default function Island() {
  const state = useIsland((s) => s.state);
  const setState = useIsland((s) => s.setState);
  const toggleExpanded = useIsland((s) => s.toggleExpanded);
  const hud = useIsland((s) => s.hud);
  // Re-evaluate the active module set when a module's activeness flips (e.g.
  // music starts/stops) even if the island state itself hasn't changed.
  useModulesVersion((s) => s.v);

  const pillRef = useRef<HTMLDivElement>(null);
  const revealed = useRef(false);
  const collapseTimer = useRef<number | null>(null);

  const allModules = getAllModules();
  const tiles = allModules.filter((m) => m.Tile);
  const primary = getPrimaryModule();
  const expanded = state === "expanded";
  // A HUD overrides the collapsed / hover pill, but never the expanded panel.
  const hudModule = hud ? allModules.find((m) => m.id === hud.kind) : undefined;
  const showingHud = !expanded && !!hudModule?.Hud;

  const size = showingHud ? HUD_SIZE : SIZES[state];

  /** Measure the pill and push its rounded rect (in physical px) to Rust. */
  const reportRegion = useCallback(() => {
    const el = pillRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || size.r;
    void setIslandRegion({
      x: Math.round(rect.left * dpr),
      y: Math.round(rect.top * dpr),
      w: Math.round(rect.width * dpr),
      h: Math.round(rect.height * dpr),
      radius: Math.round(radius * dpr),
    })
      .then(() => {
        if (!revealed.current) {
          revealed.current = true;
          void revealIsland();
        }
      })
      .catch(() => {});
  }, [size.r]);

  // Apply the initial region as soon as the pill has painted.
  useEffect(() => {
    reportRegion();
  }, [reportRegion]);

  // Re-measure and re-center on DPI / resolution changes.
  useEffect(() => {
    const onResize = () => {
      reportRegion();
      void recenter();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reportRegion]);

  const clearCollapse = () => {
    if (collapseTimer.current) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  };

  const scheduleCollapse = () => {
    clearCollapse();
    collapseTimer.current = window.setTimeout(() => setState("collapsed"), 160);
  };

  const onEnter = () => {
    clearCollapse();
    if (state === "collapsed") setState("hover");
  };

  const onLeave = () => {
    // Leaving the pill region also means the OS cursor left the window; give a
    // short grace period so edge jitter doesn't flip the state.
    if (state !== "collapsed") scheduleCollapse();
  };

  const onClick = () => {
    clearCollapse();
    toggleExpanded();
  };

  return (
    <div className="island-root">
      <motion.div
        ref={pillRef}
        className={`island-pill state-${state}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={onClick}
        initial={false}
        animate={{ width: size.w, height: size.h, borderRadius: size.r }}
        transition={MORPH}
        onUpdate={reportRegion}
      >
        <AnimatePresence mode="wait" initial={false}>
          {expanded ? (
            <motion.div
              key="expanded"
              className="pill-content expanded"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={FADE}
            >
              <header className="panel-header">
                <span className="panel-title">灵动岛</span>
                <span className="panel-hint">移开鼠标即可收起</span>
              </header>

              {primary?.Expanded ? <primary.Expanded state={state} /> : null}

              <div className="module-grid">
                {tiles.map((m) => {
                  const Tile = m.Tile!;
                  return <Tile key={m.id} state={state} />;
                })}
                {UPCOMING.map((m) => (
                  <div className="module-chip" key={m.id}>
                    <span className="chip-icon">{m.icon}</span>
                    <span className="chip-label">{m.label}</span>
                    <span className="chip-soon">{m.soon}</span>
                  </div>
                ))}
              </div>

              <footer className="panel-footer">
                已加载模块：{allModules.map((m) => m.title).join("、")}
              </footer>
            </motion.div>
          ) : showingHud ? (
            <motion.div
              key={`hud-${hud!.kind}`}
              className="pill-content hud"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={FADE}
            >
              {(() => {
                const HudView = hudModule!.Hud!;
                return <HudView state={state} />;
              })()}
            </motion.div>
          ) : (
            <motion.div
              key="collapsed"
              className="pill-content collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={FADE}
            >
              {primary?.Collapsed ? <primary.Collapsed state={state} /> : null}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/** Placeholder cards showing the roadmap of upcoming modules (M4). */
const UPCOMING = [
  { id: "shelf", icon: "📎", label: "文件暂存架", soon: "M4" },
];
