//! M6 time engine: named timers, one stopwatch, and one Pomodoro session.
//!
//! Running state is represented by absolute Unix-epoch anchors/deadlines. The
//! worker sleeps on a condition variable until the nearest deadline or a command
//! mutation, so there is no backend per-second polling and no accumulated drift.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const STATE_VERSION: u32 = 1;
const DEFAULT_WORK_MS: i64 = 25 * 60 * 1000;
const DEFAULT_SHORT_BREAK_MS: i64 = 5 * 60 * 1000;
const DEFAULT_LONG_BREAK_MS: i64 = 15 * 60 * 1000;
const DEFAULT_CYCLES: u32 = 4;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn clamp_duration(value: i64) -> i64 {
    value.clamp(1_000, 7 * 24 * 60 * 60 * 1000)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerTask {
    pub id: String,
    pub name: String,
    pub duration_ms: i64,
    pub remaining_ms: i64,
    pub deadline_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: Option<i64>,
    pub completed: bool,
    pub alert_shown: bool,
}

impl TimerTask {
    fn remaining_at(&self, now: i64) -> i64 {
        self.deadline_ms
            .map(|deadline| (deadline - now).max(0))
            .unwrap_or(self.remaining_ms.max(0))
    }

    fn running(&self) -> bool {
        self.deadline_ms.is_some() && !self.completed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopwatch {
    pub elapsed_ms: i64,
    pub started_at_ms: Option<i64>,
    pub laps_ms: Vec<i64>,
}

impl Default for Stopwatch {
    fn default() -> Self {
        Self {
            elapsed_ms: 0,
            started_at_ms: None,
            laps_ms: Vec::new(),
        }
    }
}

impl Stopwatch {
    fn elapsed_at(&self, now: i64) -> i64 {
        self.elapsed_ms
            + self
                .started_at_ms
                .map(|started| (now - started).max(0))
                .unwrap_or(0)
    }

    fn running(&self) -> bool {
        self.started_at_ms.is_some()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PomodoroPhase {
    Work,
    ShortBreak,
    LongBreak,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pomodoro {
    pub phase: PomodoroPhase,
    pub completed_work_sessions: u32,
    pub work_ms: i64,
    pub short_break_ms: i64,
    pub long_break_ms: i64,
    pub cycles_before_long_break: u32,
    pub remaining_ms: i64,
    pub deadline_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: Option<i64>,
    pub completed: bool,
    pub alert_shown: bool,
}

impl Default for Pomodoro {
    fn default() -> Self {
        Self {
            phase: PomodoroPhase::Work,
            completed_work_sessions: 0,
            work_ms: DEFAULT_WORK_MS,
            short_break_ms: DEFAULT_SHORT_BREAK_MS,
            long_break_ms: DEFAULT_LONG_BREAK_MS,
            cycles_before_long_break: DEFAULT_CYCLES,
            remaining_ms: DEFAULT_WORK_MS,
            deadline_ms: None,
            completed_at_ms: None,
            completed: false,
            alert_shown: false,
        }
    }
}

impl Pomodoro {
    fn remaining_at(&self, now: i64) -> i64 {
        self.deadline_ms
            .map(|deadline| (deadline - now).max(0))
            .unwrap_or(self.remaining_ms.max(0))
    }

    fn running(&self) -> bool {
        self.deadline_ms.is_some() && !self.completed
    }

    fn phase_duration(&self) -> i64 {
        match self.phase {
            PomodoroPhase::Work => self.work_ms,
            PomodoroPhase::ShortBreak => self.short_break_ms,
            PomodoroPhase::LongBreak => self.long_break_ms,
        }
    }

    fn advance_phase(&mut self) {
        self.phase = match self.phase {
            PomodoroPhase::Work => {
                self.completed_work_sessions = self.completed_work_sessions.saturating_add(1);
                if self.completed_work_sessions % self.cycles_before_long_break.max(1) == 0 {
                    PomodoroPhase::LongBreak
                } else {
                    PomodoroPhase::ShortBreak
                }
            }
            PomodoroPhase::ShortBreak | PomodoroPhase::LongBreak => PomodoroPhase::Work,
        };
        self.remaining_ms = self.phase_duration();
        self.deadline_ms = None;
        self.completed_at_ms = None;
        self.completed = false;
        self.alert_shown = false;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineData {
    version: u32,
    next_timer_id: u64,
    timers: Vec<TimerTask>,
    stopwatch: Stopwatch,
    pomodoro: Pomodoro,
    #[serde(skip)]
    revision: u64,
}

impl Default for EngineData {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            next_timer_id: 1,
            timers: Vec::new(),
            stopwatch: Stopwatch::default(),
            pomodoro: Pomodoro::default(),
            revision: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerSnapshot {
    pub id: String,
    pub name: String,
    pub duration_ms: i64,
    pub remaining_ms: i64,
    pub deadline_ms: Option<i64>,
    pub running: bool,
    pub completed: bool,
    pub alert_shown: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopwatchSnapshot {
    pub elapsed_ms: i64,
    pub started_at_ms: Option<i64>,
    pub running: bool,
    pub laps_ms: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroSnapshot {
    pub phase: PomodoroPhase,
    pub completed_work_sessions: u32,
    pub work_ms: i64,
    pub short_break_ms: i64,
    pub long_break_ms: i64,
    pub cycles_before_long_break: u32,
    pub remaining_ms: i64,
    pub deadline_ms: Option<i64>,
    pub running: bool,
    pub completed: bool,
    pub alert_shown: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAlert {
    pub activity_id: String,
    pub kind: String,
    pub title: String,
    pub due_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeStateSnapshot {
    pub now_ms: i64,
    pub timers: Vec<TimerSnapshot>,
    pub stopwatch: StopwatchSnapshot,
    pub pomodoro: PomodoroSnapshot,
    pub pending_alerts: Vec<DueAlert>,
}

impl EngineData {
    fn snapshot(&self, now: i64) -> TimeStateSnapshot {
        let timers = self
            .timers
            .iter()
            .map(|timer| TimerSnapshot {
                id: timer.id.clone(),
                name: timer.name.clone(),
                duration_ms: timer.duration_ms,
                remaining_ms: timer.remaining_at(now),
                deadline_ms: timer.deadline_ms,
                running: timer.running(),
                completed: timer.completed,
                alert_shown: timer.alert_shown,
            })
            .collect();
        TimeStateSnapshot {
            now_ms: now,
            timers,
            stopwatch: StopwatchSnapshot {
                elapsed_ms: self.stopwatch.elapsed_ms,
                started_at_ms: self.stopwatch.started_at_ms,
                running: self.stopwatch.running(),
                laps_ms: self.stopwatch.laps_ms.clone(),
            },
            pomodoro: PomodoroSnapshot {
                phase: self.pomodoro.phase,
                completed_work_sessions: self.pomodoro.completed_work_sessions,
                work_ms: self.pomodoro.work_ms,
                short_break_ms: self.pomodoro.short_break_ms,
                long_break_ms: self.pomodoro.long_break_ms,
                cycles_before_long_break: self.pomodoro.cycles_before_long_break,
                remaining_ms: self.pomodoro.remaining_at(now),
                deadline_ms: self.pomodoro.deadline_ms,
                running: self.pomodoro.running(),
                completed: self.pomodoro.completed,
                alert_shown: self.pomodoro.alert_shown,
            },
            pending_alerts: self.pending_alerts(),
        }
    }

    fn pending_alerts(&self) -> Vec<DueAlert> {
        let mut alerts = Vec::new();
        for timer in &self.timers {
            if timer.completed && !timer.alert_shown {
                alerts.push(DueAlert {
                    activity_id: format!("time:timer:{}", timer.id),
                    kind: "timer".into(),
                    title: timer.name.clone(),
                    due_at_ms: timer.completed_at_ms.unwrap_or(0),
                });
            }
        }
        if self.pomodoro.completed && !self.pomodoro.alert_shown {
            alerts.push(DueAlert {
                activity_id: "time:pomodoro".into(),
                kind: "pomodoro".into(),
                title: match self.pomodoro.phase {
                    PomodoroPhase::Work => "专注阶段完成",
                    PomodoroPhase::ShortBreak => "短休息完成",
                    PomodoroPhase::LongBreak => "长休息完成",
                }
                .into(),
                due_at_ms: self.pomodoro.completed_at_ms.unwrap_or(0),
            });
        }
        alerts
    }

    fn reconcile(&mut self, now: i64) -> (bool, Vec<DueAlert>) {
        let mut changed = false;
        let mut due = Vec::new();
        for timer in &mut self.timers {
            let Some(deadline) = timer.deadline_ms else {
                continue;
            };
            if deadline <= now && !timer.completed {
                timer.remaining_ms = 0;
                timer.deadline_ms = None;
                timer.completed_at_ms = Some(deadline);
                timer.completed = true;
                timer.alert_shown = false;
                due.push(DueAlert {
                    activity_id: format!("time:timer:{}", timer.id),
                    kind: "timer".into(),
                    title: timer.name.clone(),
                    due_at_ms: deadline,
                });
                changed = true;
            }
        }
        if let Some(deadline) = self.pomodoro.deadline_ms {
            if deadline <= now && !self.pomodoro.completed {
                self.pomodoro.remaining_ms = 0;
                self.pomodoro.deadline_ms = None;
                self.pomodoro.completed_at_ms = Some(deadline);
                self.pomodoro.completed = true;
                self.pomodoro.alert_shown = false;
                due.push(DueAlert {
                    activity_id: "time:pomodoro".into(),
                    kind: "pomodoro".into(),
                    title: match self.pomodoro.phase {
                        PomodoroPhase::Work => "专注阶段完成",
                        PomodoroPhase::ShortBreak => "短休息完成",
                        PomodoroPhase::LongBreak => "长休息完成",
                    }
                    .into(),
                    due_at_ms: deadline,
                });
                changed = true;
            }
        }
        (changed, due)
    }

    fn next_deadline(&self) -> Option<i64> {
        self.timers
            .iter()
            .filter_map(|timer| timer.deadline_ms)
            .chain(self.pomodoro.deadline_ms)
            .min()
    }

    fn has_running_tasks(&self) -> bool {
        self.timers.iter().any(TimerTask::running)
            || self.stopwatch.running()
            || self.pomodoro.running()
    }
}

fn load_data(path: &Path) -> EngineData {
    let backup = path.with_extension("json.bak");
    for candidate in [path, backup.as_path()] {
        if let Ok(bytes) = fs::read(candidate) {
            if let Ok(mut data) = serde_json::from_slice::<EngineData>(&bytes) {
                if data.version == STATE_VERSION {
                    data.revision = 0;
                    return data;
                }
            }
        }
    }
    EngineData::default()
}

fn persist_data(path: &Path, data: &EngineData) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "计时器状态路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建计时器目录：{error}"))?;
    let encoded =
        serde_json::to_vec_pretty(data).map_err(|error| format!("无法序列化计时器：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    fs::write(&temporary, encoded).map_err(|error| format!("无法写入计时器状态：{error}"))?;
    if path.exists() {
        let _ = fs::copy(path, &backup);
        fs::remove_file(path).map_err(|error| format!("无法替换计时器状态：{error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| format!("无法提交计时器状态：{error}"))
}

struct TimerEngine {
    app: AppHandle,
    path: PathBuf,
    data: Mutex<EngineData>,
    wake: Condvar,
}

impl TimerEngine {
    fn emit(&self, snapshot: &TimeStateSnapshot, due: &[DueAlert]) {
        let _ = self.app.emit("time-state-changed", snapshot);
        for alert in due {
            let _ = self.app.emit("time-task-due", alert);
        }
    }

    fn mutate(
        &self,
        operation: impl FnOnce(&mut EngineData, i64) -> Result<(), String>,
    ) -> Result<TimeStateSnapshot, String> {
        let now = now_ms();
        let mut guard = self
            .data
            .lock()
            .map_err(|_| "计时器状态锁已损坏".to_string())?;
        let mut next = guard.clone();
        let (_, mut due) = next.reconcile(now);
        operation(&mut next, now)?;
        let (_, after_due) = next.reconcile(now);
        due.extend(after_due);
        next.revision = guard.revision.wrapping_add(1);
        persist_data(&self.path, &next)?;
        let snapshot = next.snapshot(now);
        *guard = next;
        drop(guard);
        self.wake.notify_all();
        self.emit(&snapshot, &due);
        Ok(snapshot)
    }

    fn snapshot(&self) -> Result<TimeStateSnapshot, String> {
        let now = now_ms();
        let mut guard = self
            .data
            .lock()
            .map_err(|_| "计时器状态锁已损坏".to_string())?;
        let mut next = guard.clone();
        let (changed, due) = next.reconcile(now);
        if changed {
            next.revision = guard.revision.wrapping_add(1);
            persist_data(&self.path, &next)?;
            *guard = next;
        }
        let snapshot = guard.snapshot(now);
        drop(guard);
        if changed {
            self.wake.notify_all();
            self.emit(&snapshot, &due);
        }
        Ok(snapshot)
    }

    fn has_running_tasks(&self) -> bool {
        self.data
            .lock()
            .map(|data| data.has_running_tasks())
            .unwrap_or(false)
    }

    fn clear_all(&self) -> Result<(), String> {
        self.mutate(|data, _| {
            data.timers.clear();
            data.stopwatch = Stopwatch::default();
            let config = (
                data.pomodoro.work_ms,
                data.pomodoro.short_break_ms,
                data.pomodoro.long_break_ms,
                data.pomodoro.cycles_before_long_break,
            );
            data.pomodoro = Pomodoro {
                work_ms: config.0,
                short_break_ms: config.1,
                long_break_ms: config.2,
                cycles_before_long_break: config.3,
                remaining_ms: config.0,
                ..Pomodoro::default()
            };
            Ok(())
        })?;
        Ok(())
    }

    fn worker(self: Arc<Self>) {
        std::thread::spawn(move || loop {
            let now = now_ms();
            let (snapshot, due, deadline, revision, changed, persist_failed) = {
                let mut guard = match self.data.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                let mut next = guard.clone();
                let (changed, due) = next.reconcile(now);
                let mut committed = changed;
                let mut persist_failed = false;
                if changed {
                    next.revision = guard.revision.wrapping_add(1);
                    if let Err(error) = persist_data(&self.path, &next) {
                        committed = false;
                        persist_failed = true;
                        let _ = self.app.emit("time-engine-error", error);
                    } else {
                        *guard = next;
                    }
                }
                (
                    guard.snapshot(now),
                    if committed { due } else { Vec::new() },
                    guard.next_deadline(),
                    guard.revision,
                    committed,
                    persist_failed,
                )
            };
            if changed {
                self.emit(&snapshot, &due);
            }

            let guard = match self.data.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            if guard.revision != revision {
                continue;
            }
            match deadline {
                Some(deadline) => {
                    let wait_ms = if persist_failed {
                        1_000
                    } else {
                        (deadline - now_ms()).max(0) as u64
                    };
                    let _ = self
                        .wake
                        .wait_timeout(guard, Duration::from_millis(wait_ms));
                }
                None => {
                    let _guard = self.wake.wait(guard);
                }
            }
        });
    }
}

#[derive(Clone)]
pub struct TimerState(Arc<TimerEngine>);

pub fn init(app: &AppHandle) -> TimerState {
    let path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("time-state.json");
    let mut data = load_data(&path);
    let (changed, _) = data.reconcile(now_ms());
    if changed {
        let _ = persist_data(&path, &data);
    }
    let engine = Arc::new(TimerEngine {
        app: app.clone(),
        path,
        data: Mutex::new(data),
        wake: Condvar::new(),
    });
    engine.clone().worker();
    TimerState(engine)
}

impl TimerState {
    pub fn has_running_tasks(&self) -> bool {
        self.0.has_running_tasks()
    }

    pub fn clear_all(&self) -> Result<(), String> {
        self.0.clear_all()
    }
}

fn timer_mut<'a>(data: &'a mut EngineData, id: &str) -> Result<&'a mut TimerTask, String> {
    data.timers
        .iter_mut()
        .find(|timer| timer.id == id)
        .ok_or_else(|| format!("找不到计时器 {id}"))
}

#[tauri::command]
pub fn get_time_state(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.snapshot()
}

#[tauri::command]
pub fn create_timer(
    state: State<'_, TimerState>,
    name: String,
    duration_ms: i64,
) -> Result<TimeStateSnapshot, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("计时器名称不能为空".into());
    }
    state.0.mutate(|data, _| {
        let id = format!("timer-{}", data.next_timer_id);
        data.next_timer_id = data.next_timer_id.saturating_add(1);
        let duration = clamp_duration(duration_ms);
        data.timers.push(TimerTask {
            id,
            name,
            duration_ms: duration,
            remaining_ms: duration,
            deadline_ms: None,
            completed_at_ms: None,
            completed: false,
            alert_shown: false,
        });
        Ok(())
    })
}

#[tauri::command]
pub fn start_timer(state: State<'_, TimerState>, id: String) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        let timer = timer_mut(data, &id)?;
        if timer.completed || timer.remaining_ms <= 0 {
            timer.remaining_ms = timer.duration_ms;
            timer.completed_at_ms = None;
            timer.completed = false;
            timer.alert_shown = false;
        }
        if timer.deadline_ms.is_none() {
            timer.deadline_ms = Some(now.saturating_add(timer.remaining_ms));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn pause_timer(state: State<'_, TimerState>, id: String) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        let timer = timer_mut(data, &id)?;
        timer.remaining_ms = timer.remaining_at(now);
        timer.deadline_ms = None;
        Ok(())
    })
}

#[tauri::command]
pub fn resume_timer(state: State<'_, TimerState>, id: String) -> Result<TimeStateSnapshot, String> {
    start_timer(state, id)
}

#[tauri::command]
pub fn reset_timer(state: State<'_, TimerState>, id: String) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        let timer = timer_mut(data, &id)?;
        timer.remaining_ms = timer.duration_ms;
        timer.deadline_ms = None;
        timer.completed_at_ms = None;
        timer.completed = false;
        timer.alert_shown = false;
        Ok(())
    })
}

#[tauri::command]
pub fn delete_timer(state: State<'_, TimerState>, id: String) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        let before = data.timers.len();
        data.timers.retain(|timer| timer.id != id);
        if data.timers.len() == before {
            return Err(format!("找不到计时器 {id}"));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn add_timer_time(
    state: State<'_, TimerState>,
    id: String,
    additional_ms: i64,
) -> Result<TimeStateSnapshot, String> {
    let additional = clamp_duration(additional_ms);
    state.0.mutate(|data, now| {
        let timer = timer_mut(data, &id)?;
        if let Some(deadline) = timer.deadline_ms {
            timer.deadline_ms = Some(deadline.saturating_add(additional));
        } else if timer.completed {
            timer.remaining_ms = additional;
            timer.deadline_ms = Some(now.saturating_add(additional));
        } else {
            timer.remaining_ms = timer.remaining_ms.saturating_add(additional);
        }
        timer.completed = false;
        timer.completed_at_ms = None;
        timer.alert_shown = false;
        Ok(())
    })
}

#[tauri::command]
pub fn start_stopwatch(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        if data.stopwatch.started_at_ms.is_none() {
            data.stopwatch.started_at_ms = Some(now);
        }
        Ok(())
    })
}

#[tauri::command]
pub fn pause_stopwatch(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        data.stopwatch.elapsed_ms = data.stopwatch.elapsed_at(now);
        data.stopwatch.started_at_ms = None;
        Ok(())
    })
}

#[tauri::command]
pub fn reset_stopwatch(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        data.stopwatch = Stopwatch::default();
        Ok(())
    })
}

#[tauri::command]
pub fn add_stopwatch_lap(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        let elapsed = data.stopwatch.elapsed_at(now);
        if elapsed <= 0 {
            return Err("秒表尚未开始".into());
        }
        data.stopwatch.laps_ms.push(elapsed);
        Ok(())
    })
}

#[tauri::command]
pub fn configure_pomodoro(
    state: State<'_, TimerState>,
    work_ms: i64,
    short_break_ms: i64,
    long_break_ms: i64,
    cycles_before_long_break: u32,
) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        if data.pomodoro.running() {
            return Err("请先暂停番茄钟再修改时长".into());
        }
        data.pomodoro.work_ms = clamp_duration(work_ms);
        data.pomodoro.short_break_ms = clamp_duration(short_break_ms);
        data.pomodoro.long_break_ms = clamp_duration(long_break_ms);
        data.pomodoro.cycles_before_long_break = cycles_before_long_break.clamp(1, 12);
        data.pomodoro.remaining_ms = data.pomodoro.phase_duration();
        data.pomodoro.completed = false;
        data.pomodoro.completed_at_ms = None;
        data.pomodoro.alert_shown = false;
        Ok(())
    })
}

#[tauri::command]
pub fn start_pomodoro(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        if data.pomodoro.completed || data.pomodoro.remaining_ms <= 0 {
            data.pomodoro.advance_phase();
        }
        if data.pomodoro.deadline_ms.is_none() {
            data.pomodoro.deadline_ms = Some(now.saturating_add(data.pomodoro.remaining_ms));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn pause_pomodoro(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, now| {
        data.pomodoro.remaining_ms = data.pomodoro.remaining_at(now);
        data.pomodoro.deadline_ms = None;
        Ok(())
    })
}

#[tauri::command]
pub fn add_pomodoro_time(
    state: State<'_, TimerState>,
    additional_ms: i64,
) -> Result<TimeStateSnapshot, String> {
    let additional = clamp_duration(additional_ms);
    state.0.mutate(|data, now| {
        if let Some(deadline) = data.pomodoro.deadline_ms {
            data.pomodoro.deadline_ms = Some(deadline.saturating_add(additional));
        } else if data.pomodoro.completed {
            data.pomodoro.remaining_ms = additional;
            data.pomodoro.deadline_ms = Some(now.saturating_add(additional));
        } else {
            data.pomodoro.remaining_ms = data.pomodoro.remaining_ms.saturating_add(additional);
        }
        data.pomodoro.completed = false;
        data.pomodoro.completed_at_ms = None;
        data.pomodoro.alert_shown = false;
        Ok(())
    })
}

#[tauri::command]
pub fn resume_pomodoro(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    start_pomodoro(state)
}

#[tauri::command]
pub fn reset_pomodoro(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        data.pomodoro.remaining_ms = data.pomodoro.phase_duration();
        data.pomodoro.deadline_ms = None;
        data.pomodoro.completed_at_ms = None;
        data.pomodoro.completed = false;
        data.pomodoro.alert_shown = false;
        Ok(())
    })
}

#[tauri::command]
pub fn advance_pomodoro(state: State<'_, TimerState>) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        data.pomodoro.advance_phase();
        Ok(())
    })
}

#[tauri::command]
pub fn mark_time_alert_shown(
    state: State<'_, TimerState>,
    activity_id: String,
) -> Result<TimeStateSnapshot, String> {
    state.0.mutate(|data, _| {
        if activity_id == "time:pomodoro" {
            data.pomodoro.alert_shown = true;
            return Ok(());
        }
        let id = activity_id
            .strip_prefix("time:timer:")
            .ok_or_else(|| format!("无效的提醒活动 {activity_id}"))?;
        timer_mut(data, id)?.alert_shown = true;
        Ok(())
    })
}

#[tauri::command]
pub fn cancel_all_time_tasks(state: State<'_, TimerState>) -> Result<(), String> {
    state.clear_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timer(id: &str, deadline: i64) -> TimerTask {
        TimerTask {
            id: id.into(),
            name: id.into(),
            duration_ms: 60_000,
            remaining_ms: 60_000,
            deadline_ms: Some(deadline),
            completed_at_ms: None,
            completed: false,
            alert_shown: false,
        }
    }

    #[test]
    fn remaining_time_is_derived_from_deadline() {
        let task = timer("a", 50_000);
        assert_eq!(task.remaining_at(10_000), 40_000);
        assert_eq!(task.remaining_at(60_000), 0);
    }

    #[test]
    fn simultaneous_expiry_produces_distinct_alerts() {
        let mut data = EngineData::default();
        data.timers = vec![timer("a", 100), timer("b", 100)];
        let (changed, alerts) = data.reconcile(101);
        assert!(changed);
        assert_eq!(alerts.len(), 2);
        assert!(data.timers.iter().all(|task| task.completed));
    }

    #[test]
    fn shown_alert_does_not_reappear_after_round_trip() {
        let mut data = EngineData::default();
        let mut task = timer("a", 100);
        task.deadline_ms = None;
        task.remaining_ms = 0;
        task.completed_at_ms = Some(100);
        task.completed = true;
        task.alert_shown = true;
        data.timers.push(task);
        let encoded = serde_json::to_vec(&data).unwrap();
        let restored: EngineData = serde_json::from_slice(&encoded).unwrap();
        assert!(restored.pending_alerts().is_empty());
    }

    #[test]
    fn pending_alert_keeps_due_time_after_restart() {
        let mut data = EngineData::default();
        data.timers.push(timer("a", 100));
        data.reconcile(101);
        let encoded = serde_json::to_vec(&data).unwrap();
        let restored: EngineData = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(restored.pending_alerts()[0].due_at_ms, 100);
    }

    #[test]
    fn running_timer_survives_persistence_with_absolute_anchor() {
        let mut data = EngineData::default();
        data.timers.push(timer("a", 55_000));
        let encoded = serde_json::to_vec(&data).unwrap();
        let restored: EngineData = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(restored.timers[0].remaining_at(5_000), 50_000);
    }

    #[test]
    fn pomodoro_long_break_follows_configured_cycle() {
        let mut pomodoro = Pomodoro {
            cycles_before_long_break: 2,
            ..Pomodoro::default()
        };
        pomodoro.advance_phase();
        assert_eq!(pomodoro.phase, PomodoroPhase::ShortBreak);
        pomodoro.advance_phase();
        assert_eq!(pomodoro.phase, PomodoroPhase::Work);
        pomodoro.advance_phase();
        assert_eq!(pomodoro.phase, PomodoroPhase::LongBreak);
    }
}
