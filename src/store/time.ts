import { create } from "zustand";
import {
  getTimeState,
  markTimeAlertShown,
  onTimeEngineError,
  onTimeStateChanged,
  onTimeTaskDue,
  type DueAlert,
  type TimeState,
} from "../lib/native";
import { refreshModuleActivities } from "../modules/registry";
import { removeActivity, upsertActivity } from "./activities";
import { bumpModules } from "./modules";

const EMPTY: TimeState = {
  nowMs: 0,
  timers: [],
  stopwatch: { elapsedMs: 0, startedAtMs: null, running: false, lapsMs: [] },
  pomodoro: {
    phase: "work",
    completedWorkSessions: 0,
    workMs: 25 * 60_000,
    shortBreakMs: 5 * 60_000,
    longBreakMs: 15 * 60_000,
    cyclesBeforeLongBreak: 4,
    remainingMs: 25 * 60_000,
    deadlineMs: null,
    running: false,
    completed: false,
    alertShown: false,
  },
  pendingAlerts: [],
};

interface TimeStore {
  snapshot: TimeState;
  loaded: boolean;
  error: string | null;
  apply: (snapshot: TimeState) => void;
  acknowledge: (activityId: string) => Promise<void>;
}

function syncDueActivities(alerts: DueAlert[]): void {
  const nextIds = new Set(alerts.map((alert) => `time:due:${alert.activityId}`));
  for (const alert of alerts) {
    upsertActivity({
      id: `time:due:${alert.activityId}`,
      sourceId: "time-alerts",
      moduleId: "time",
      channel: "hud",
      title: alert.title,
      icon: "!",
      priority: 1000,
    });
  }
  const previous = useTime.getState().snapshot.pendingAlerts;
  for (const alert of previous) {
    const id = `time:due:${alert.activityId}`;
    if (!nextIds.has(id)) removeActivity(id);
  }
}

export const useTime = create<TimeStore>((set, get) => ({
  snapshot: EMPTY,
  loaded: false,
  error: null,
  apply: (snapshot) => {
    syncDueActivities(snapshot.pendingAlerts);
    set({ snapshot, loaded: true, error: null });
    refreshModuleActivities("time");
    bumpModules();
  },
  acknowledge: async (activityId) => {
    const snapshot = await markTimeAlertShown(activityId);
    removeActivity(`time:due:${activityId}`);
    get().apply(snapshot);
  },
}));

let started = false;

export function ensureTimeStarted(): void {
  if (started) return;
  started = true;
  void Promise.all([
    onTimeStateChanged(useTime.getState().apply),
    onTimeTaskDue(() => {
      void getTimeState().then(useTime.getState().apply);
    }),
    onTimeEngineError((error) => useTime.setState({ error })),
  ])
    .then(() => getTimeState())
    .then(useTime.getState().apply)
    .catch((error) => useTime.setState({ loaded: true, error: String(error) }));
}

export function liveTimerRemaining(
  timer: Pick<TimeState["timers"][number], "deadlineMs" | "remainingMs">,
  now = Date.now(),
): number {
  return timer.deadlineMs == null ? timer.remainingMs : Math.max(0, timer.deadlineMs - now);
}

export function livePomodoroRemaining(
  pomodoro: Pick<TimeState["pomodoro"], "deadlineMs" | "remainingMs">,
  now = Date.now(),
): number {
  return pomodoro.deadlineMs == null
    ? pomodoro.remainingMs
    : Math.max(0, pomodoro.deadlineMs - now);
}

export function liveStopwatchElapsed(
  stopwatch: Pick<TimeState["stopwatch"], "startedAtMs" | "elapsedMs">,
  now = Date.now(),
): number {
  return stopwatch.startedAtMs == null
    ? stopwatch.elapsedMs
    : stopwatch.elapsedMs + Math.max(0, now - stopwatch.startedAtMs);
}
