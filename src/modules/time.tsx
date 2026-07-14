import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  addStopwatchLap,
  addPomodoroTime,
  addTimerTime,
  advancePomodoro,
  createTimer,
  configurePomodoro,
  deleteTimer,
  pausePomodoro,
  pauseStopwatch,
  pauseTimer,
  resetPomodoro,
  resetStopwatch,
  resetTimer,
  startPomodoro,
  startStopwatch,
  startTimer,
  type TimeState,
  type TimerTask,
} from "../lib/native";
import ActivityRail from "../island/ActivityRail";
import { useIsland } from "../store/island";
import { useSettings } from "../store/settings";
import {
  ensureTimeStarted,
  livePomodoroRemaining,
  liveStopwatchElapsed,
  liveTimerRemaining,
  useTime,
} from "../store/time";
import type { IslandModuleProps, ModuleActivity } from "./types";
import { refreshModuleActivities, registerModule } from "./registry";

const MINUTE = 60_000;
const REVEAL = { duration: 0.18, ease: "easeOut" as const };

function formatTime(ms: number, showHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (showHours || hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

function apply(command: Promise<TimeState>, onSuccess?: () => void): void {
  void command
    .then((snapshot) => {
      useTime.getState().apply(snapshot);
      onSuccess?.();
    })
    .catch((error) => {
      useTime.setState({ error: String(error) });
    });
}

function stop(event: MouseEvent): void {
  event.stopPropagation();
}

function activityFor(snapshot: TimeState, activityId?: string) {
  if (activityId?.startsWith("time:timer:")) {
    const id = activityId.slice("time:timer:".length);
    return { kind: "timer" as const, timer: snapshot.timers.find((item) => item.id === id) };
  }
  if (activityId === "time:stopwatch") return { kind: "stopwatch" as const };
  if (activityId === "time:pomodoro") return { kind: "pomodoro" as const };
  return null;
}

function CollapsedTime({ state, activityId }: IslandModuleProps) {
  const snapshot = useTime((store) => store.snapshot);
  const activity = activityFor(snapshot, activityId);
  const running =
    activity?.kind === "timer"
      ? !!activity.timer?.running
      : activity?.kind === "stopwatch"
        ? snapshot.stopwatch.running
        : snapshot.pomodoro.running;
  const now = useClock(running);

  if (activity?.kind === "timer" && activity.timer) {
    const timer = activity.timer;
    return (
      <div className="time-compact">
        <span className={`time-status${timer.running ? " running" : ""}`} />
        <span className="time-compact-name">{timer.name}</span>
        <strong>{formatTime(liveTimerRemaining(timer, now))}</strong>
        {state === "hover" ? (
          <button
            className="time-mini-control"
            onClick={(event) => {
              stop(event);
              apply(timer.running ? pauseTimer(timer.id) : startTimer(timer.id));
            }}
            aria-label={timer.running ? `暂停${timer.name}` : `开始${timer.name}`}
          >
            {timer.running ? "Ⅱ" : "▶"}
          </button>
        ) : null}
      </div>
    );
  }

  if (activity?.kind === "stopwatch") {
    return (
      <div className="time-compact">
        <span className={`time-status stopwatch${snapshot.stopwatch.running ? " running" : ""}`} />
        <span className="time-compact-name">秒表</span>
        <strong>{formatTime(liveStopwatchElapsed(snapshot.stopwatch, now), true)}</strong>
        {state === "hover" ? (
          <button
            className="time-mini-control"
            onClick={(event) => {
              stop(event);
              apply(snapshot.stopwatch.running ? pauseStopwatch() : startStopwatch());
            }}
            aria-label={snapshot.stopwatch.running ? "暂停秒表" : "开始秒表"}
          >
            {snapshot.stopwatch.running ? "Ⅱ" : "▶"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="time-compact">
      <span className={`time-status tomato${snapshot.pomodoro.running ? " running" : ""}`} />
      <span className="time-compact-name">
        {snapshot.pomodoro.phase === "work" ? "专注" : "休息"}
      </span>
      <strong>{formatTime(livePomodoroRemaining(snapshot.pomodoro, now))}</strong>
      {state === "hover" ? (
        <button
          className="time-mini-control"
          onClick={(event) => {
            stop(event);
            apply(snapshot.pomodoro.running ? pausePomodoro() : startPomodoro());
          }}
          aria-label={snapshot.pomodoro.running ? "暂停番茄钟" : "开始番茄钟"}
        >
          {snapshot.pomodoro.running ? "Ⅱ" : "▶"}
        </button>
      ) : null}
    </div>
  );
}

function timeSummary(snapshot: TimeState, activityId?: string): { running: number; detail: string } {
  const runningTimers = snapshot.timers.filter((timer) => timer.running);
  const running =
    runningTimers.length +
    Number(snapshot.stopwatch.running) +
    Number(snapshot.pomodoro.running);
  const preferred = activityFor(snapshot, activityId);
  const preferredDetail =
    preferred?.kind === "timer" && preferred.timer
      ? `${preferred.timer.name} · ${timerStatus(preferred.timer)}`
      : preferred?.kind === "stopwatch"
        ? `秒表 · ${snapshot.stopwatch.running ? "运行中" : "已暂停"}`
        : preferred?.kind === "pomodoro"
          ? `${snapshot.pomodoro.phase === "work" ? "番茄专注" : "番茄休息"} · ${
              snapshot.pomodoro.running ? "运行中" : "已暂停"
            }`
          : null;
  const lead = runningTimers[0]?.name ??
    (snapshot.pomodoro.running
      ? snapshot.pomodoro.phase === "work"
        ? "番茄专注"
        : "番茄休息"
      : snapshot.stopwatch.running
        ? "秒表"
        : null);
  if (preferredDetail) {
    return {
      running,
      detail: running > 1 ? `${preferredDetail} · 另有 ${running - 1} 项运行中` : preferredDetail,
    };
  }
  if (lead) {
    return {
      running,
      detail: running > 1 ? `${lead} · 另有 ${running - 1} 项` : lead,
    };
  }
  const paused = snapshot.timers.find((timer) => !timer.completed);
  if (paused) return { running, detail: `${paused.name} · 已暂停` };
  if (snapshot.stopwatch.elapsedMs > 0) return { running, detail: "秒表 · 已暂停" };
  return { running, detail: "新建计时器、秒表或番茄钟" };
}

function TimeHomeEntry({ activityId }: IslandModuleProps) {
  const enabled = useSettings((store) => store.timeEnabled);
  const snapshot = useTime((store) => store.snapshot);
  const openTimeCenter = useIsland((store) => store.openTimeCenter);
  const summary = timeSummary(snapshot, activityId);
  const detail = summary.running
    ? `${summary.running} 项运行中 · ${summary.detail}`
    : enabled
      ? summary.detail
      : "活动显示已关闭 · 可在计时中心管理";
  return (
    <button
      className="time-home-entry"
      onClick={(event) => {
        stop(event);
        openTimeCenter();
      }}
      aria-label="打开计时中心"
    >
      <span className="time-home-icon" aria-hidden="true">⏱</span>
      <span className="time-home-copy">
        <strong>计时中心</strong>
        <span>{detail}</span>
      </span>
      <span className="time-home-count">{snapshot.timers.length} 个计时器</span>
      <span className="time-home-chevron" aria-hidden="true">›</span>
    </button>
  );
}

interface ActivityRowProps {
  id: string;
  kind: "timer" | "stopwatch" | "pomodoro";
  name: string;
  type: string;
  value: string;
  status: string;
  running: boolean;
  actionLabel: string;
  expanded: boolean;
  onPrimary: () => void;
  onExpand: () => void;
  children: React.ReactNode;
}

function ActivityRow({
  id,
  kind,
  name,
  type,
  value,
  status,
  running,
  actionLabel,
  expanded,
  onPrimary,
  onExpand,
  children,
}: ActivityRowProps) {
  return (
    <div className={`time-activity${expanded ? " expanded" : ""}`} data-kind={kind}>
      <div className="time-activity-row">
        <span className={`time-category time-category-${kind}`} aria-hidden="true" />
        <span className="time-activity-copy">
          <strong title={name}>{name}</strong>
          <span>{type}</span>
        </span>
        <span className="time-activity-readout">
          <strong>{value}</strong>
          <span>{status}</span>
        </span>
        <button
          className={`time-primary${running ? " running" : ""}`}
          onClick={onPrimary}
          aria-label={`${actionLabel}${name}`}
        >
          {actionLabel}
        </button>
        <button
          className="time-more"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-controls={`${id}-details`}
          aria-label={expanded ? `收起${name}操作` : `展开${name}操作`}
        >
          {expanded ? "⌃" : "•••"}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            id={`${id}-details`}
            className="time-activity-details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={REVEAL}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function timerStatus(timer: TimerTask): string {
  if (timer.completed) return "已完成";
  if (timer.running) return "运行中";
  if (timer.remainingMs < timer.durationMs) return "已暂停";
  return "未开始";
}

function TimerRow({
  timer,
  now,
  expanded,
  onExpand,
}: {
  timer: TimerTask;
  now: number;
  expanded: boolean;
  onExpand: () => void;
}) {
  const primary = timer.completed
    ? () => apply(resetTimer(timer.id))
    : () => apply(timer.running ? pauseTimer(timer.id) : startTimer(timer.id));
  return (
    <ActivityRow
      id={`timer-${timer.id}`}
      kind="timer"
      name={timer.name}
      type="计时器"
      value={formatTime(liveTimerRemaining(timer, now))}
      status={timerStatus(timer)}
      running={timer.running}
      actionLabel={timer.completed ? "重置" : timer.running ? "暂停" : "开始"}
      expanded={expanded}
      onPrimary={primary}
      onExpand={onExpand}
    >
      <div className="time-secondary-actions">
        <span>增加时间</span>
        {[1, 5, 10].map((minutes) => (
          <button key={minutes} onClick={() => apply(addTimerTime(timer.id, minutes * MINUTE))}>
            +{minutes} 分钟
          </button>
        ))}
        <button onClick={() => apply(resetTimer(timer.id))}>重置</button>
        <button className="danger" onClick={() => apply(deleteTimer(timer.id))}>删除</button>
      </div>
    </ActivityRow>
  );
}

function NewTimerForm({ onClose }: { onClose: () => void }) {
  const snapshot = useTime((store) => store.snapshot);
  const defaultMinutes = useSettings((store) => store.timerDefaultMinutes);
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(defaultMinutes);
  const [validation, setValidation] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getCurrentWindow()
      .setFocus()
      .then(() => nameInput.current?.focus())
      .catch((error) => useTime.setState({ error: String(error) }));
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const timerName = name.trim();
    if (!timerName) {
      setValidation("请输入计时器名称");
      return;
    }
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) {
      setValidation("时长应为 1–10080 分钟");
      return;
    }
    setValidation(null);
    apply(createTimer(timerName, minutes * MINUTE), onClose);
  };

  return (
    <motion.form
      className="time-create-form"
      onSubmit={submit}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={REVEAL}
      noValidate
    >
      <div className="time-create-fields">
        <label>
          <span>名称</span>
          <input
            ref={nameInput}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (validation) setValidation(null);
            }}
            placeholder={`例如：计时器 ${snapshot.timers.length + 1}`}
            aria-invalid={!!validation}
          />
        </label>
        <label>
          <span>时长（分钟）</span>
          <input
            className="time-minutes"
            type="number"
            min="1"
            max="10080"
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
            aria-invalid={!!validation}
          />
        </label>
      </div>
      <div className="time-create-footer">
        <span className="time-validation" role="alert" aria-live="assertive">
          {validation}
        </span>
        <button type="button" className="time-quiet" onClick={onClose}>取消</button>
        <button type="submit" className="time-confirm">创建计时器</button>
      </div>
    </motion.form>
  );
}

export function TimeCenter() {
  const snapshot = useTime((store) => store.snapshot);
  const error = useTime((store) => store.error);
  const openHome = useIsland((store) => store.openHome);
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pomoConfig, setPomoConfig] = useState(() => ({
    work: snapshot.pomodoro.workMs / MINUTE,
    short: snapshot.pomodoro.shortBreakMs / MINUTE,
    long: snapshot.pomodoro.longBreakMs / MINUTE,
    cycles: snapshot.pomodoro.cyclesBeforeLongBreak,
  }));
  const active =
    snapshot.timers.some((timer) => timer.running) ||
    snapshot.stopwatch.running ||
    snapshot.pomodoro.running;
  const now = useClock(active);
  const summary = timeSummary(snapshot);
  const toggleDetails = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  return (
    <div className="time-center" onClick={stop}>
      <header className="time-center-header">
        <button
          className="time-back"
          data-panel-back
          onClick={openHome}
          aria-label="返回主页"
        >
          ←
        </button>
        <div>
          <strong>计时中心</strong>
          <span>
            {summary.running
              ? `${summary.running} 项运行中 · ${snapshot.timers.length} 个计时器`
              : `${snapshot.timers.length} 个计时器 · 当前无运行活动`}
          </span>
        </div>
        <button
          className={`time-new${creating ? " active" : ""}`}
          onClick={() => {
            setCreating((current) => !current);
            setExpandedId(null);
          }}
          aria-expanded={creating}
        >
          {creating ? "收起" : "＋ 新建"}
        </button>
      </header>

      <ActivityRail state="expanded" expanded />

      <AnimatePresence initial={false}>
        {creating ? <NewTimerForm onClose={() => setCreating(false)} /> : null}
      </AnimatePresence>

      {error ? (
        <div className="time-error" role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}

      <div className="time-activity-list">
        {snapshot.timers.map((timer) => (
          <TimerRow
            key={timer.id}
            timer={timer}
            now={now}
            expanded={expandedId === `timer-${timer.id}`}
            onExpand={() => toggleDetails(`timer-${timer.id}`)}
          />
        ))}

        {!snapshot.timers.length ? (
          <div className="time-empty">
            <span aria-hidden="true">◷</span>
            <strong>尚未创建命名计时器</strong>
            <p>点击“新建”添加计时器，或直接使用秒表与番茄钟。</p>
          </div>
        ) : null}

        <ActivityRow
          id="stopwatch"
          kind="stopwatch"
          name="秒表"
          type={snapshot.stopwatch.lapsMs.length ? `${snapshot.stopwatch.lapsMs.length} 个计次` : "自由计时"}
          value={formatTime(liveStopwatchElapsed(snapshot.stopwatch, now), true)}
          status={snapshot.stopwatch.running ? "运行中" : snapshot.stopwatch.elapsedMs ? "已暂停" : "待开始"}
          running={snapshot.stopwatch.running}
          actionLabel={snapshot.stopwatch.running ? "暂停" : "开始"}
          expanded={expandedId === "stopwatch"}
          onPrimary={() =>
            apply(snapshot.stopwatch.running ? pauseStopwatch() : startStopwatch())
          }
          onExpand={() => toggleDetails("stopwatch")}
        >
          <div className="time-secondary-actions">
            <button
              onClick={() => apply(addStopwatchLap())}
              disabled={!snapshot.stopwatch.running}
            >
              计次
            </button>
            <button onClick={() => apply(resetStopwatch())}>重置</button>
          </div>
          {snapshot.stopwatch.lapsMs.length ? (
            <ol className="time-lap-list">
              {snapshot.stopwatch.lapsMs
                .map((lap, index) => ({ lap, number: index + 1 }))
                .reverse()
                .slice(0, 8)
                .map(({ lap, number }) => (
                  <li key={`${number}-${lap}`}>
                    <span>计次 {number}</span>
                    <strong>{formatTime(lap, true)}</strong>
                  </li>
                ))}
            </ol>
          ) : (
            <p className="time-detail-hint">秒表运行后可记录计次。</p>
          )}
        </ActivityRow>

        <ActivityRow
          id="pomodoro"
          kind="pomodoro"
          name={snapshot.pomodoro.phase === "work" ? "番茄专注" : "番茄休息"}
          type={`已完成 ${snapshot.pomodoro.completedWorkSessions} 次专注`}
          value={formatTime(livePomodoroRemaining(snapshot.pomodoro, now))}
          status={snapshot.pomodoro.running ? "运行中" : snapshot.pomodoro.completed ? "阶段完成" : "待开始"}
          running={snapshot.pomodoro.running}
          actionLabel={snapshot.pomodoro.running ? "暂停" : "开始"}
          expanded={expandedId === "pomodoro"}
          onPrimary={() =>
            apply(snapshot.pomodoro.running ? pausePomodoro() : startPomodoro())
          }
          onExpand={() => toggleDetails("pomodoro")}
        >
          <div className="time-secondary-actions">
            <button onClick={() => apply(advancePomodoro())}>下一阶段</button>
            <button onClick={() => apply(addPomodoroTime(5 * MINUTE))}>+5 分钟</button>
            <button onClick={() => apply(resetPomodoro())}>重置</button>
          </div>
          <form
            className="time-pomodoro-config"
            onSubmit={(event) => {
              event.preventDefault();
              apply(
                configurePomodoro(
                  pomoConfig.work * MINUTE,
                  pomoConfig.short * MINUTE,
                  pomoConfig.long * MINUTE,
                  pomoConfig.cycles,
                ),
              );
            }}
          >
            {([
              ["work", "专注"],
              ["short", "短休"],
              ["long", "长休"],
              ["cycles", "长休轮次"],
            ] as const).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="1"
                  max={key === "cycles" ? 12 : 720}
                  value={pomoConfig[key]}
                  disabled={snapshot.pomodoro.running}
                  onChange={(event) =>
                    setPomoConfig((current) => ({
                      ...current,
                      [key]: Math.max(1, Number(event.target.value) || 1),
                    }))
                  }
                />
              </label>
            ))}
            <button type="submit" disabled={snapshot.pomodoro.running}>应用设置</button>
          </form>
        </ActivityRow>

      </div>
    </div>
  );
}

function DueHud({ activityId }: IslandModuleProps) {
  const snapshot = useTime((store) => store.snapshot);
  const sound = useSettings((store) => store.timeSound);
  const dueId = activityId?.replace("time:due:", "");
  const alert = snapshot.pendingAlerts.find((item) => item.activityId === dueId);
  const acknowledged = useMemo(() => new Set<string>(), []);

  useEffect(() => {
    if (!alert || !sound || acknowledged.has(alert.activityId)) return;
    acknowledged.add(alert.activityId);
    const context = new window.AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.setValueAtTime(740, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(980, context.currentTime + 0.18);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.42);
    oscillator.onended = () => void context.close();
  }, [acknowledged, alert, sound]);

  if (!alert) return null;
  return (
    <div className="time-due" onClick={stop} role="alert" aria-live="assertive">
      <span className="time-due-icon">✓</span>
      <div className="time-due-copy">
        <strong>{alert.title}</strong>
        <span>计时完成</span>
      </div>
      {[1, 5, 10].map((minutes) => (
        <button
          key={minutes}
          onClick={() => {
            if (alert.kind === "timer") {
              apply(addTimerTime(alert.activityId.slice("time:timer:".length), minutes * MINUTE));
            } else {
              apply(addPomodoroTime(minutes * MINUTE));
            }
            void useTime.getState().acknowledge(alert.activityId);
          }}
        >
          +{minutes}
        </button>
      ))}
      <button
        className="time-due-dismiss"
        onClick={() => void useTime.getState().acknowledge(alert.activityId)}
      >
        完成
      </button>
    </div>
  );
}

function getActivities(): ModuleActivity[] {
  const { snapshot } = useTime.getState();
  if (!useSettings.getState().timeEnabled) return [];
  const activities: ModuleActivity[] = snapshot.timers.map((timer, index) => ({
    id: `time:timer:${timer.id}`,
    channel: "ongoing",
    title: timer.name,
    icon: String(index + 1),
    priority: (timer.running ? 720 : 650) - index,
  }));
  if (snapshot.stopwatch.running || snapshot.stopwatch.elapsedMs > 0) {
    activities.push({
      id: "time:stopwatch",
      channel: "ongoing",
      title: "秒表",
      icon: "S",
      priority: snapshot.stopwatch.running ? 710 : 640,
    });
  }
  if (
    snapshot.pomodoro.running ||
    snapshot.pomodoro.completed ||
    snapshot.pomodoro.completedWorkSessions > 0
  ) {
    activities.push({
      id: "time:pomodoro",
      channel: "ongoing",
      title: "番茄钟",
      icon: "P",
      priority: snapshot.pomodoro.running ? 715 : 645,
    });
  }
  return activities;
}

registerModule({
  id: "time",
  title: "计时中心",
  priority: 720,
  icon: "⏱",
  getActivities,
  Collapsed: CollapsedTime,
  Expanded: TimeHomeEntry,
  Tile: TimeHomeEntry,
  Hud: DueHud,
  hudSize: { w: 430, h: 52, r: 26 },
});

useSettings.subscribe((state, previous) => {
  if (state.timeEnabled !== previous.timeEnabled) refreshModuleActivities("time");
});

ensureTimeStarted();
