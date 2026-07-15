//! Passive paired-Bluetooth lifecycle observation for M7.
//!
//! This module watches the classic and low-energy AssociationEndpoint selectors
//! for already-paired physical devices. It never starts discovery, pairs,
//! connects, opens GATT, or controls Bluetooth. Windows' public `IsConnected`
//! property is the sole connection signal; because no trustworthy "connecting"
//! property exists, that phase is intentionally not synthesized.

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const LOW_BATTERY_THRESHOLD: u8 = 20;
const LOW_BATTERY_RECOVERY: u8 = 25;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BluetoothDeviceKind {
    Audio,
    Mouse,
    Keyboard,
    Pen,
    Gamepad,
    Phone,
    Wearable,
    #[default]
    Generic,
}

impl BluetoothDeviceKind {
    fn disconnect_debounce(self) -> Duration {
        match self {
            Self::Mouse | Self::Keyboard | Self::Pen => Duration::from_millis(1_500),
            Self::Gamepad => Duration::from_millis(1_200),
            _ => Duration::from_millis(900),
        }
    }

    fn specificity(self) -> u8 {
        match self {
            Self::Generic => 0,
            Self::Wearable => 1,
            Self::Phone => 2,
            Self::Audio => 3,
            Self::Pen => 4,
            Self::Gamepad => 5,
            Self::Keyboard => 6,
            Self::Mouse => 7,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDeviceSnapshot {
    pub id: String,
    pub name: String,
    pub kind: BluetoothDeviceKind,
    pub connected: bool,
    pub battery_percent: Option<u8>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BluetoothServicePhase {
    Starting,
    Ready,
    NoDevice,
    Degraded,
    Unsupported,
    #[default]
    Stopped,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothSnapshot {
    pub phase: BluetoothServicePhase,
    pub devices: Vec<BluetoothDeviceSnapshot>,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BluetoothTransitionPhase {
    Connected,
    Disconnected,
    BatteryUpdated,
    LowBattery,
    Degraded,
    WatcherStopped,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothTransition {
    pub id: String,
    pub phase: BluetoothTransitionPhase,
    pub at_ms: u64,
    pub device: Option<BluetoothDeviceSnapshot>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Observation {
    watcher_id: String,
    stable_id: String,
    name: String,
    kind: BluetoothDeviceKind,
    connected: bool,
    battery_percent: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BluetoothProtocol {
    Classic,
    LowEnergy,
}

impl BluetoothProtocol {
    fn key(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::LowEnergy => "ble",
        }
    }
}

#[derive(Clone, Debug)]
struct ObservationEvidence {
    protocol: BluetoothProtocol,
    endpoint_id: String,
    name: String,
    paired: Option<bool>,
    connected: Option<bool>,
    container_id: Option<String>,
    address: Option<String>,
    cod_major: Option<u16>,
    cod_minor: Option<u16>,
    appearance: Option<u16>,
    battery_percent: Option<u8>,
}

fn observation_from_evidence(evidence: ObservationEvidence) -> Option<Observation> {
    if evidence.paired != Some(true) || evidence.connected.is_none() {
        return None;
    }
    let name = evidence.name.trim();
    if name.is_empty() || evidence.endpoint_id.trim().is_empty() {
        return None;
    }

    let identity = evidence
        .container_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("container:{}", value.to_ascii_lowercase()))
        .or_else(|| {
            evidence
                .address
                .as_deref()
                .map(normalize_address)
                .filter(|value| !value.is_empty())
                .map(|value| format!("address:{}:{value}", evidence.protocol.key()))
        })
        .unwrap_or_else(|| {
            format!(
                "endpoint:{}:{}",
                evidence.protocol.key(),
                evidence.endpoint_id.to_ascii_lowercase()
            )
        });

    Some(Observation {
        watcher_id: watcher_key(evidence.protocol, &evidence.endpoint_id),
        stable_id: opaque_device_id(&identity),
        name: name.chars().take(120).collect(),
        kind: classify_device(
            evidence.appearance,
            evidence.cod_major,
            evidence.cod_minor,
            name,
        ),
        connected: evidence.connected.unwrap_or(false),
        battery_percent: evidence.battery_percent.filter(|value| *value <= 100),
    })
}

fn watcher_key(protocol: BluetoothProtocol, endpoint_id: &str) -> String {
    format!("{}:{endpoint_id}", protocol.key())
}

fn normalize_address(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .flat_map(char::to_lowercase)
        .collect()
}

fn opaque_device_id(identity: &str) -> String {
    let hash = identity
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("bt-{hash:016x}")
}

fn classify_device(
    appearance: Option<u16>,
    cod_major: Option<u16>,
    cod_minor: Option<u16>,
    name: &str,
) -> BluetoothDeviceKind {
    classify_appearance(appearance)
        .or_else(|| classify_cod(cod_major, cod_minor))
        .or_else(|| classify_name(name))
        .unwrap_or_default()
}

fn classify_appearance(appearance: Option<u16>) -> Option<BluetoothDeviceKind> {
    let appearance = appearance?;
    let category = appearance >> 6;
    let subcategory = appearance & 0x3f;
    match (category, subcategory) {
        (15, 1) => Some(BluetoothDeviceKind::Keyboard),
        (15, 2 | 9) => Some(BluetoothDeviceKind::Mouse),
        (15, 3 | 4) => Some(BluetoothDeviceKind::Gamepad),
        (15, 5 | 7) => Some(BluetoothDeviceKind::Pen),
        (1, _) => Some(BluetoothDeviceKind::Phone),
        (3 | 7, _) => Some(BluetoothDeviceKind::Wearable),
        (40..=43, _) => Some(BluetoothDeviceKind::Audio),
        _ => None,
    }
}

fn classify_cod(major: Option<u16>, minor: Option<u16>) -> Option<BluetoothDeviceKind> {
    match major? {
        2 => Some(BluetoothDeviceKind::Phone),
        4 => Some(BluetoothDeviceKind::Audio),
        5 => {
            let minor = minor.unwrap_or_default();
            match (minor & 0x30, minor & 0x0f) {
                (_, 1 | 2) => Some(BluetoothDeviceKind::Gamepad),
                (_, 5) => Some(BluetoothDeviceKind::Pen),
                (0x20, _) => Some(BluetoothDeviceKind::Mouse),
                (0x10 | 0x30, _) => Some(BluetoothDeviceKind::Keyboard),
                _ => None,
            }
        }
        7 => Some(BluetoothDeviceKind::Wearable),
        _ => None,
    }
}

fn classify_name(name: &str) -> Option<BluetoothDeviceKind> {
    let name = name.to_lowercase();
    let has = |terms: &[&str]| terms.iter().any(|term| name.contains(term));
    if has(&["mouse", "touchpad", "鼠标", "触控板"]) {
        Some(BluetoothDeviceKind::Mouse)
    } else if has(&["keyboard", "键盘"]) {
        Some(BluetoothDeviceKind::Keyboard)
    } else if has(&["stylus", "digital pen", "触控笔"]) {
        Some(BluetoothDeviceKind::Pen)
    } else if has(&["gamepad", "controller", "joystick", "xbox", "手柄"]) {
        Some(BluetoothDeviceKind::Gamepad)
    } else if has(&["headphone", "headset", "earbud", "speaker", "耳机", "音箱"]) {
        Some(BluetoothDeviceKind::Audio)
    } else if has(&["phone", "手机"]) {
        Some(BluetoothDeviceKind::Phone)
    } else if has(&["watch", "smart band", "手表", "手环"]) {
        Some(BluetoothDeviceKind::Wearable)
    } else {
        None
    }
}

#[derive(Clone, Debug)]
struct DeviceRecord {
    snapshot: BluetoothDeviceSnapshot,
    low_alerted: bool,
    last_observed_ms: u64,
}

#[derive(Clone, Debug)]
struct PendingDisconnect {
    device: BluetoothDeviceSnapshot,
    deadline_ms: u64,
}

#[derive(Default)]
struct TransitionReducer {
    baseline: bool,
    devices: HashMap<String, DeviceRecord>,
    watcher_to_stable: HashMap<String, String>,
    interfaces: HashMap<String, Observation>,
    pending_disconnects: HashMap<String, PendingDisconnect>,
}

impl TransitionReducer {
    fn begin_baseline(&mut self) {
        self.baseline = true;
        self.devices.clear();
        self.pending_disconnects.clear();
        self.watcher_to_stable.clear();
        self.interfaces.clear();
    }

    fn finish_baseline(&mut self) {
        self.baseline = false;
        self.devices.retain(|_, device| device.snapshot.connected);
    }

    fn observe(&mut self, observation: Observation, now_ms: u64) -> Vec<BluetoothTransition> {
        let previous_stable_id = self.watcher_to_stable.insert(
            observation.watcher_id.clone(),
            observation.stable_id.clone(),
        );
        let previous_interface = self
            .interfaces
            .insert(observation.watcher_id.clone(), observation.clone());

        let identity_refined = previous_stable_id
            .as_ref()
            .is_some_and(|stable_id| stable_id != &observation.stable_id);
        let identity_previous = previous_stable_id
            .filter(|stable_id| stable_id != &observation.stable_id)
            .and_then(|stable_id| {
                self.reconcile_refined_identity(
                    &stable_id,
                    &observation.stable_id,
                    previous_interface.as_ref(),
                    &observation,
                )
            });
        let previous =
            identity_previous.or_else(|| self.devices.get(&observation.stable_id).cloned());
        let next = self.aggregate(&observation.stable_id, &observation);
        let mut low_alerted = previous
            .as_ref()
            .map(|record| record.low_alerted)
            .unwrap_or(false);
        if next
            .battery_percent
            .is_some_and(|battery| battery >= LOW_BATTERY_RECOVERY)
        {
            low_alerted = false;
        }
        self.devices.insert(
            observation.stable_id.clone(),
            DeviceRecord {
                snapshot: next.clone(),
                low_alerted,
                last_observed_ms: now_ms,
            },
        );

        if self.baseline {
            return Vec::new();
        }

        let resumed_before_disconnect = next.connected
            && self
                .pending_disconnects
                .get(&next.id)
                .is_some_and(|pending| identity_refined || pending.deadline_ms > now_ms);
        if resumed_before_disconnect {
            self.pending_disconnects.remove(&next.id);
        }
        let mut events = self.flush(now_ms);
        let was_connected = previous
            .as_ref()
            .map(|record| record.snapshot.connected)
            .unwrap_or(false);

        if was_connected && !next.connected {
            let deadline_ms = now_ms + next.kind.disconnect_debounce().as_millis() as u64;
            self.pending_disconnects.insert(
                next.id.clone(),
                PendingDisconnect {
                    device: next,
                    deadline_ms,
                },
            );
            return events;
        }
        if next.connected {
            if !was_connected && !resumed_before_disconnect {
                events.push(transition(
                    BluetoothTransitionPhase::Connected,
                    now_ms,
                    Some(next.clone()),
                    None,
                ));
            }
        }

        if next.connected {
            let previous_battery = previous.and_then(|record| record.snapshot.battery_percent);
            if previous_battery != next.battery_percent {
                if let Some(battery) = next.battery_percent {
                    let record = self.devices.get_mut(&next.id).expect("device inserted");
                    if battery <= LOW_BATTERY_THRESHOLD && !record.low_alerted {
                        record.low_alerted = true;
                        events.push(transition(
                            BluetoothTransitionPhase::LowBattery,
                            now_ms,
                            Some(next),
                            None,
                        ));
                    } else if was_connected {
                        events.push(transition(
                            BluetoothTransitionPhase::BatteryUpdated,
                            now_ms,
                            Some(next),
                            None,
                        ));
                    }
                }
            }
        }

        events
    }

    fn reconcile_refined_identity(
        &mut self,
        previous_id: &str,
        refined_id: &str,
        previous_interface: Option<&Observation>,
        refined_fallback: &Observation,
    ) -> Option<DeviceRecord> {
        let previous_record = self.devices.get(previous_id).cloned();
        let refined_record = self.devices.get(refined_id).cloned();
        let moved_record = previous_interface
            .map(|interface| DeviceRecord {
                snapshot: BluetoothDeviceSnapshot {
                    id: refined_id.to_string(),
                    name: interface.name.clone(),
                    kind: interface.kind,
                    connected: interface.connected,
                    battery_percent: interface.battery_percent,
                },
                low_alerted: previous_record
                    .as_ref()
                    .is_some_and(|record| record.low_alerted),
                last_observed_ms: previous_record
                    .as_ref()
                    .map(|record| record.last_observed_ms)
                    .unwrap_or_default(),
            })
            .or_else(|| previous_record.clone());
        let transition_previous = match (moved_record, refined_record) {
            (Some(mut previous), Some(refined)) => {
                previous.snapshot.connected |= refined.snapshot.connected;
                previous.snapshot.battery_percent = previous
                    .snapshot
                    .battery_percent
                    .or(refined.snapshot.battery_percent);
                previous.low_alerted |= refined.low_alerted;
                previous.last_observed_ms = previous.last_observed_ms.max(refined.last_observed_ms);
                Some(previous)
            }
            (Some(previous), None) => Some(previous),
            (None, Some(refined)) => Some(refined),
            (None, None) => None,
        };

        if self
            .interfaces
            .values()
            .any(|interface| interface.stable_id == previous_id)
        {
            if let Some(fallback) = previous_interface {
                let aggregate = self.aggregate(previous_id, fallback);
                if let Some(record) = self.devices.get_mut(previous_id) {
                    record.snapshot = aggregate.clone();
                }
                if aggregate.connected {
                    self.pending_disconnects.remove(previous_id);
                } else if let Some(pending) = self.pending_disconnects.get_mut(previous_id) {
                    pending.device = aggregate;
                }
            }
        } else {
            self.devices.remove(previous_id);
            if let Some(mut pending) = self.pending_disconnects.remove(previous_id) {
                pending.device = self.aggregate(refined_id, refined_fallback);
                if let Some(refined_pending) = self.pending_disconnects.get_mut(refined_id) {
                    refined_pending.deadline_ms =
                        refined_pending.deadline_ms.max(pending.deadline_ms);
                    refined_pending.device = pending.device;
                } else {
                    self.pending_disconnects
                        .insert(refined_id.to_string(), pending);
                }
            }
        }

        transition_previous
    }

    fn remove_watcher_id(&mut self, watcher_id: &str, now_ms: u64) -> Vec<BluetoothTransition> {
        let Some(stable_id) = self.watcher_to_stable.remove(watcher_id) else {
            return Vec::new();
        };
        let Some(removed) = self.interfaces.remove(watcher_id) else {
            return Vec::new();
        };
        if self
            .interfaces
            .values()
            .any(|interface| interface.stable_id == stable_id && interface.connected)
        {
            let aggregate = self.aggregate(&stable_id, &removed);
            if let Some(record) = self.devices.get_mut(&stable_id) {
                record.snapshot = aggregate;
            }
            return Vec::new();
        }
        if self.baseline {
            if self
                .interfaces
                .values()
                .any(|interface| interface.stable_id == stable_id)
            {
                let aggregate = self.aggregate(&stable_id, &removed);
                if let Some(record) = self.devices.get_mut(&stable_id) {
                    record.snapshot = aggregate;
                }
            } else {
                self.devices.remove(&stable_id);
                self.pending_disconnects.remove(&stable_id);
            }
            return Vec::new();
        }
        let Some(record) = self.devices.get_mut(&stable_id) else {
            return Vec::new();
        };
        if !record.snapshot.connected {
            return Vec::new();
        }
        record.snapshot.connected = false;
        self.pending_disconnects.insert(
            stable_id,
            PendingDisconnect {
                device: record.snapshot.clone(),
                deadline_ms: now_ms + record.snapshot.kind.disconnect_debounce().as_millis() as u64,
            },
        );
        Vec::new()
    }

    fn aggregate(&self, stable_id: &str, fallback: &Observation) -> BluetoothDeviceSnapshot {
        let interfaces: Vec<&Observation> = self
            .interfaces
            .values()
            .filter(|interface| interface.stable_id == stable_id)
            .collect();
        let kind = interfaces
            .iter()
            .copied()
            .map(|interface| interface.kind)
            .max_by_key(|kind| kind.specificity())
            .unwrap_or(fallback.kind);
        let preferred = interfaces
            .iter()
            .copied()
            .find(|interface| interface.connected && interface.kind == kind)
            .or_else(|| {
                interfaces
                    .iter()
                    .copied()
                    .find(|interface| interface.kind == kind)
            })
            .or_else(|| {
                interfaces
                    .iter()
                    .copied()
                    .find(|interface| interface.connected)
            })
            .or_else(|| interfaces.first().copied())
            .unwrap_or(fallback);
        BluetoothDeviceSnapshot {
            id: stable_id.to_string(),
            name: preferred.name.clone(),
            kind,
            connected: interfaces.iter().any(|interface| interface.connected),
            battery_percent: interfaces
                .iter()
                .filter(|interface| interface.connected)
                .find_map(|interface| interface.battery_percent),
        }
    }

    fn flush(&mut self, now_ms: u64) -> Vec<BluetoothTransition> {
        let due: Vec<String> = self
            .pending_disconnects
            .iter()
            .filter(|(_, pending)| pending.deadline_ms <= now_ms)
            .map(|(id, _)| id.clone())
            .collect();
        due.into_iter()
            .filter_map(|id| {
                self.pending_disconnects.remove(&id).map(|pending| {
                    transition(
                        BluetoothTransitionPhase::Disconnected,
                        now_ms,
                        Some(pending.device),
                        None,
                    )
                })
            })
            .collect()
    }

    fn next_deadline_ms(&self) -> Option<u64> {
        self.pending_disconnects
            .values()
            .map(|pending| pending.deadline_ms)
            .min()
    }

    fn snapshot(&self, phase: BluetoothServicePhase, reason: Option<String>) -> BluetoothSnapshot {
        let mut devices: Vec<_> = self
            .devices
            .iter()
            .filter_map(|(id, record)| {
                if record.snapshot.connected {
                    Some((record.last_observed_ms, record.snapshot.clone()))
                } else {
                    self.pending_disconnects.get(id).map(|pending| {
                        let mut device = pending.device.clone();
                        device.connected = true;
                        (record.last_observed_ms, device)
                    })
                }
            })
            .collect();
        devices.sort_by(|(a_ms, a), (b_ms, b)| {
            b_ms.cmp(a_ms)
                .then(a.name.cmp(&b.name))
                .then(a.id.cmp(&b.id))
        });
        BluetoothSnapshot {
            phase,
            devices: devices.into_iter().map(|(_, device)| device).collect(),
            reason,
        }
    }

    fn operational_phase(&self) -> BluetoothServicePhase {
        if self
            .snapshot(BluetoothServicePhase::Ready, None)
            .devices
            .is_empty()
        {
            BluetoothServicePhase::NoDevice
        } else {
            BluetoothServicePhase::Ready
        }
    }
}

fn transition(
    phase: BluetoothTransitionPhase,
    at_ms: u64,
    device: Option<BluetoothDeviceSnapshot>,
    reason: Option<String>,
) -> BluetoothTransition {
    BluetoothTransition {
        id: device
            .as_ref()
            .map(|value| value.id.clone())
            .unwrap_or_else(|| "bluetooth:service".to_string()),
        phase,
        at_ms,
        device,
        reason,
    }
}

enum Command {
    SetEnabled(bool, mpsc::Sender<Result<BluetoothSnapshot, String>>),
    Shutdown,
}

enum WorkerMessage {
    Command(Command),
    #[cfg(windows)]
    Added(
        u64,
        BluetoothProtocol,
        windows::Devices::Enumeration::DeviceInformation,
    ),
    #[cfg(windows)]
    Updated(
        u64,
        BluetoothProtocol,
        windows::Devices::Enumeration::DeviceInformationUpdate,
    ),
    #[cfg(windows)]
    Removed(
        u64,
        BluetoothProtocol,
        windows::Devices::Enumeration::DeviceInformationUpdate,
    ),
    EnumerationCompleted(u64, BluetoothProtocol),
    WatcherStopped(u64, BluetoothProtocol, bool),
}

pub struct BluetoothState {
    shared: Arc<Mutex<BluetoothSnapshot>>,
    tx: mpsc::Sender<WorkerMessage>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[tauri::command]
pub fn get_bluetooth_status(state: tauri::State<'_, BluetoothState>) -> BluetoothSnapshot {
    state.shared.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_bluetooth_observation(
    state: tauri::State<'_, BluetoothState>,
    enabled: bool,
) -> Result<BluetoothSnapshot, String> {
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .tx
        .send(WorkerMessage::Command(Command::SetEnabled(
            enabled, reply_tx,
        )))
        .map_err(|_| "Bluetooth watcher thread is unavailable".to_string())?;
    reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Bluetooth watcher did not respond".to_string())?
}

pub fn shutdown(state: &BluetoothState) {
    let _ = state.tx.send(WorkerMessage::Command(Command::Shutdown));
    if let Some(worker) = state.worker.lock().unwrap().take() {
        let _ = worker.join();
    }
}

pub fn init(app: &AppHandle) -> BluetoothState {
    let shared = Arc::new(Mutex::new(BluetoothSnapshot::default()));
    let (tx, rx) = mpsc::channel();
    let worker_shared = shared.clone();
    let worker_tx = tx.clone();
    let worker_app = app.clone();
    let worker = std::thread::spawn(move || worker(worker_app, worker_shared, worker_tx, rx));
    #[cfg(debug_assertions)]
    schedule_debug_injection(app, shared.clone());
    BluetoothState {
        shared,
        tx,
        worker: Mutex::new(Some(worker)),
    }
}

#[cfg(debug_assertions)]
fn schedule_debug_injection(app: &AppHandle, shared: Arc<Mutex<BluetoothSnapshot>>) {
    let Ok(requested_phase) = std::env::var("M7_BLUETOOTH_DEBUG_PHASE") else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let delay_ms = std::env::var("M7_BLUETOOTH_DEBUG_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(2_000);
        std::thread::sleep(Duration::from_millis(delay_ms));
        let phase = requested_phase.trim().to_ascii_lowercase();
        let name = std::env::var("M7_BLUETOOTH_DEBUG_NAME")
            .unwrap_or_else(|_| "Surface Arc Mouse".to_string());
        let kind = std::env::var("M7_BLUETOOTH_DEBUG_KIND")
            .ok()
            .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
                "audio" => Some(BluetoothDeviceKind::Audio),
                "mouse" => Some(BluetoothDeviceKind::Mouse),
                "keyboard" => Some(BluetoothDeviceKind::Keyboard),
                "pen" => Some(BluetoothDeviceKind::Pen),
                "gamepad" => Some(BluetoothDeviceKind::Gamepad),
                "phone" => Some(BluetoothDeviceKind::Phone),
                "wearable" => Some(BluetoothDeviceKind::Wearable),
                "generic" => Some(BluetoothDeviceKind::Generic),
                _ => None,
            })
            .unwrap_or(BluetoothDeviceKind::Mouse);
        let battery = match phase.as_str() {
            "low-battery" => Some(12),
            "unknown-battery" => None,
            _ => Some(68),
        };
        let device = BluetoothDeviceSnapshot {
            id: "debug-device".to_string(),
            name,
            kind,
            connected: phase != "disconnected",
            battery_percent: battery,
        };
        let snapshot = match phase.as_str() {
            "degraded" => BluetoothSnapshot {
                phase: BluetoothServicePhase::Degraded,
                devices: Vec::new(),
                reason: Some("Deterministic debug watcher state".to_string()),
            },
            "no-device" => BluetoothSnapshot {
                phase: BluetoothServicePhase::NoDevice,
                devices: Vec::new(),
                reason: Some("debug:no-device".to_string()),
            },
            "multiple" => BluetoothSnapshot {
                phase: BluetoothServicePhase::Ready,
                devices: vec![
                    device.clone(),
                    BluetoothDeviceSnapshot {
                        id: "debug-keyboard".to_string(),
                        name: "Surface Keyboard".to_string(),
                        kind: BluetoothDeviceKind::Keyboard,
                        connected: true,
                        battery_percent: None,
                    },
                ],
                reason: Some("debug:multiple".to_string()),
            },
            _ => BluetoothSnapshot {
                phase: BluetoothServicePhase::Ready,
                devices: if device.connected {
                    vec![device.clone()]
                } else {
                    Vec::new()
                },
                reason: Some(format!("debug:{phase}")),
            },
        };
        update_shared(&app, &shared, snapshot);

        let transition_phase = match phase.as_str() {
            "connected" | "unknown-battery" => Some(BluetoothTransitionPhase::Connected),
            "disconnected" => Some(BluetoothTransitionPhase::Disconnected),
            "battery-updated" => Some(BluetoothTransitionPhase::BatteryUpdated),
            "low-battery" => Some(BluetoothTransitionPhase::LowBattery),
            "degraded" => Some(BluetoothTransitionPhase::Degraded),
            _ => None,
        };
        if let Some(transition_phase) = transition_phase {
            emit_transitions(
                &app,
                vec![transition(
                    transition_phase,
                    now_ms(),
                    (!matches!(transition_phase, BluetoothTransitionPhase::Degraded))
                        .then_some(device),
                    matches!(transition_phase, BluetoothTransitionPhase::Degraded)
                        .then(|| "Deterministic debug watcher state".to_string()),
                )],
            );
        }
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn update_shared(
    app: &AppHandle,
    shared: &Arc<Mutex<BluetoothSnapshot>>,
    snapshot: BluetoothSnapshot,
) {
    if let Ok(mut guard) = shared.lock() {
        *guard = snapshot.clone();
    }
    if let Err(error) = app.emit("bluetooth-status", snapshot) {
        eprintln!("Failed to emit Bluetooth status: {error}");
    }
}

fn emit_transitions(app: &AppHandle, events: Vec<BluetoothTransition>) {
    for event in events {
        if let Err(error) = app.emit("bluetooth-transition", event) {
            eprintln!("Failed to emit Bluetooth transition: {error}");
        }
    }
}

#[cfg(not(windows))]
fn worker(
    app: AppHandle,
    shared: Arc<Mutex<BluetoothSnapshot>>,
    _tx: mpsc::Sender<WorkerMessage>,
    rx: mpsc::Receiver<WorkerMessage>,
) {
    while let Ok(WorkerMessage::Command(command)) = rx.recv() {
        match command {
            Command::SetEnabled(enabled, reply) => {
                let snapshot = BluetoothSnapshot {
                    phase: if enabled {
                        BluetoothServicePhase::Unsupported
                    } else {
                        BluetoothServicePhase::Stopped
                    },
                    devices: Vec::new(),
                    reason: enabled.then(|| "Bluetooth observation requires Windows".to_string()),
                };
                update_shared(&app, &shared, snapshot.clone());
                let _ = reply.send(Ok(snapshot));
            }
            Command::Shutdown => break,
        }
    }
}

#[cfg(windows)]
fn worker(
    app: AppHandle,
    shared: Arc<Mutex<BluetoothSnapshot>>,
    tx: mpsc::Sender<WorkerMessage>,
    rx: mpsc::Receiver<WorkerMessage>,
) {
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    struct RoApartment;
    impl Drop for RoApartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }

    let _apartment = match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        Ok(()) => RoApartment,
        Err(error) => {
            let reason = format!("Unable to initialize Bluetooth WinRT apartment: {error}");
            update_shared(
                &app,
                &shared,
                BluetoothSnapshot {
                    phase: BluetoothServicePhase::Degraded,
                    devices: Vec::new(),
                    reason: Some(reason.clone()),
                },
            );
            emit_transitions(
                &app,
                vec![transition(
                    BluetoothTransitionPhase::Degraded,
                    now_ms(),
                    None,
                    Some(reason),
                )],
            );
            return;
        }
    };

    let mut reducer = TransitionReducer::default();
    let mut watchers: Option<imp::WatcherSet> = None;
    let mut watcher_generation = 0_u64;
    let mut enabled = false;
    let mut service_phase = BluetoothServicePhase::Stopped;
    let mut restart_at_ms: Option<u64> = None;

    loop {
        let now = now_ms();
        if enabled && watchers.is_none() && restart_at_ms.is_none_or(|deadline| deadline <= now) {
            reducer.begin_baseline();
            let starting = reducer.snapshot(BluetoothServicePhase::Starting, None);
            update_shared(&app, &shared, starting);
            watcher_generation = watcher_generation.wrapping_add(1);
            match imp::WatcherSet::start(tx.clone(), watcher_generation) {
                Ok(active) => {
                    watchers = Some(active);
                    service_phase = BluetoothServicePhase::Starting;
                    restart_at_ms = None;
                }
                Err(error) => {
                    let reason = format!("Unable to start Bluetooth watcher: {error}");
                    service_phase = BluetoothServicePhase::Degraded;
                    update_shared(
                        &app,
                        &shared,
                        reducer.snapshot(service_phase, Some(reason.clone())),
                    );
                    emit_transitions(
                        &app,
                        vec![transition(
                            BluetoothTransitionPhase::Degraded,
                            now,
                            None,
                            Some(reason),
                        )],
                    );
                    restart_at_ms = Some(now + 5_000);
                }
            }
        }

        let deadline = [reducer.next_deadline_ms(), restart_at_ms]
            .into_iter()
            .flatten()
            .min();
        let wait = deadline
            .map(|value| Duration::from_millis(value.saturating_sub(now).max(1)))
            .unwrap_or(Duration::from_secs(3600));

        match rx.recv_timeout(wait) {
            Ok(WorkerMessage::Command(Command::SetEnabled(next, reply))) => {
                enabled = next;
                restart_at_ms = None;
                if !enabled {
                    watchers = None;
                    reducer = TransitionReducer::default();
                    service_phase = BluetoothServicePhase::Stopped;
                    let snapshot = reducer.snapshot(service_phase, None);
                    update_shared(&app, &shared, snapshot.clone());
                    let _ = reply.send(Ok(snapshot));
                } else if watchers.is_some() {
                    let snapshot = reducer.snapshot(service_phase, None);
                    let _ = reply.send(Ok(snapshot));
                } else {
                    let snapshot = reducer.snapshot(BluetoothServicePhase::Starting, None);
                    let _ = reply.send(Ok(snapshot));
                }
            }
            Ok(WorkerMessage::Command(Command::Shutdown)) => {
                drop(watchers.take());
                break;
            }
            Ok(WorkerMessage::Added(generation, protocol, info)) => {
                if let Some(active) = watchers
                    .as_mut()
                    .filter(|active| active.generation() == generation)
                {
                    if let Some(observation) = active.register_added(protocol, info) {
                        emit_transitions(&app, reducer.observe(observation, now_ms()));
                        if matches!(
                            service_phase,
                            BluetoothServicePhase::Ready | BluetoothServicePhase::NoDevice
                        ) {
                            service_phase = reducer.operational_phase();
                        }
                        update_shared(&app, &shared, reducer.snapshot(service_phase, None));
                    }
                }
            }
            Ok(WorkerMessage::Updated(generation, protocol, update)) => {
                if let Some(active) = watchers
                    .as_mut()
                    .filter(|active| active.generation() == generation)
                {
                    if let Some(observation) = active.apply_update(protocol, &update) {
                        emit_transitions(&app, reducer.observe(observation, now_ms()));
                        if matches!(
                            service_phase,
                            BluetoothServicePhase::Ready | BluetoothServicePhase::NoDevice
                        ) {
                            service_phase = reducer.operational_phase();
                        }
                        update_shared(&app, &shared, reducer.snapshot(service_phase, None));
                    }
                }
            }
            Ok(WorkerMessage::Removed(generation, protocol, update)) => {
                if let Some(active) = watchers
                    .as_mut()
                    .filter(|active| active.generation() == generation)
                {
                    if let Some(watcher_id) = active.remove(protocol, &update) {
                        emit_transitions(&app, reducer.remove_watcher_id(&watcher_id, now_ms()));
                        if matches!(
                            service_phase,
                            BluetoothServicePhase::Ready | BluetoothServicePhase::NoDevice
                        ) {
                            service_phase = reducer.operational_phase();
                        }
                        update_shared(&app, &shared, reducer.snapshot(service_phase, None));
                    }
                }
            }
            Ok(WorkerMessage::EnumerationCompleted(generation, protocol)) => {
                if watchers
                    .as_mut()
                    .filter(|active| active.generation() == generation)
                    .is_some_and(|active| active.mark_completed(protocol))
                {
                    reducer.finish_baseline();
                    service_phase = reducer.operational_phase();
                    update_shared(&app, &shared, reducer.snapshot(service_phase, None));
                }
            }
            Ok(WorkerMessage::WatcherStopped(generation, _protocol, aborted)) => {
                if enabled
                    && watchers
                        .as_ref()
                        .is_some_and(|active| active.generation() == generation)
                {
                    watchers = None;
                    reducer.begin_baseline();
                    let reason = if aborted {
                        "Bluetooth watcher aborted; retrying"
                    } else {
                        "Bluetooth watcher stopped; retrying"
                    }
                    .to_string();
                    service_phase = BluetoothServicePhase::Degraded;
                    update_shared(
                        &app,
                        &shared,
                        reducer.snapshot(service_phase, Some(reason.clone())),
                    );
                    emit_transitions(
                        &app,
                        vec![transition(
                            BluetoothTransitionPhase::WatcherStopped,
                            now_ms(),
                            None,
                            Some(reason),
                        )],
                    );
                    restart_at_ms = Some(now_ms() + 2_000);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                emit_transitions(&app, reducer.flush(now_ms()));
                if matches!(
                    service_phase,
                    BluetoothServicePhase::Ready | BluetoothServicePhase::NoDevice
                ) {
                    service_phase = reducer.operational_phase();
                }
                update_shared(&app, &shared, reducer.snapshot(service_phase, None));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::mpsc;

    use windows::Devices::Bluetooth::{BluetoothDevice, BluetoothLEDevice};
    use windows::Devices::Enumeration::{
        DeviceInformation, DeviceInformationKind, DeviceInformationUpdate, DeviceWatcher,
        DeviceWatcherStatus,
    };
    use windows::Foundation::{IPropertyValue, PropertyType, TypedEventHandler};
    use windows_collections::IIterable;
    use windows_core::{IInspectable, Interface, HSTRING};

    use super::{
        observation_from_evidence, watcher_key, BluetoothProtocol, Observation,
        ObservationEvidence, WorkerMessage,
    };

    const IS_CONNECTED: &str = "System.Devices.Aep.IsConnected";
    const IS_PAIRED: &str = "System.Devices.Aep.IsPaired";
    const CONTAINER_ID: &str = "System.Devices.Aep.ContainerId";
    const DEVICE_ADDRESS: &str = "System.Devices.Aep.DeviceAddress";
    const COD_MAJOR: &str = "System.Devices.Aep.Bluetooth.Cod.Major";
    const COD_MINOR: &str = "System.Devices.Aep.Bluetooth.Cod.Minor";
    const BLE_APPEARANCE: &str = "System.Devices.Aep.Bluetooth.Le.Appearance";
    const BATTERY_LIFE: &str = "System.Devices.BatteryLife";

    pub struct WatcherSet {
        generation: u64,
        classic: WatcherRegistration,
        low_energy: WatcherRegistration,
        classic_completed: bool,
        low_energy_completed: bool,
    }

    impl WatcherSet {
        pub fn start(
            tx: mpsc::Sender<WorkerMessage>,
            generation: u64,
        ) -> windows_core::Result<Self> {
            let classic_selector = BluetoothDevice::GetDeviceSelectorFromPairingState(true)?;
            let ble_selector = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)?;
            let classic = WatcherRegistration::new(
                BluetoothProtocol::Classic,
                &classic_selector,
                tx.clone(),
                generation,
            )?;
            let low_energy = WatcherRegistration::new(
                BluetoothProtocol::LowEnergy,
                &ble_selector,
                tx,
                generation,
            )?;

            classic.start()?;
            low_energy.start()?;
            Ok(Self {
                generation,
                classic,
                low_energy,
                classic_completed: false,
                low_energy_completed: false,
            })
        }

        pub fn generation(&self) -> u64 {
            self.generation
        }

        pub fn register_added(
            &mut self,
            protocol: BluetoothProtocol,
            info: DeviceInformation,
        ) -> Option<Observation> {
            self.registration_mut(protocol).register_added(info)
        }

        pub fn apply_update(
            &mut self,
            protocol: BluetoothProtocol,
            update: &DeviceInformationUpdate,
        ) -> Option<Observation> {
            self.registration_mut(protocol).apply_update(update)
        }

        pub fn remove(
            &mut self,
            protocol: BluetoothProtocol,
            update: &DeviceInformationUpdate,
        ) -> Option<String> {
            self.registration_mut(protocol).remove(update)
        }

        pub fn mark_completed(&mut self, protocol: BluetoothProtocol) -> bool {
            match protocol {
                BluetoothProtocol::Classic => self.classic_completed = true,
                BluetoothProtocol::LowEnergy => self.low_energy_completed = true,
            }
            self.classic_completed && self.low_energy_completed
        }

        fn registration_mut(&mut self, protocol: BluetoothProtocol) -> &mut WatcherRegistration {
            match protocol {
                BluetoothProtocol::Classic => &mut self.classic,
                BluetoothProtocol::LowEnergy => &mut self.low_energy,
            }
        }
    }

    pub struct WatcherRegistration {
        protocol: BluetoothProtocol,
        watcher: DeviceWatcher,
        added: Option<i64>,
        updated: Option<i64>,
        removed: Option<i64>,
        completed: Option<i64>,
        stopped: Option<i64>,
        devices: HashMap<String, DeviceInformation>,
    }

    impl WatcherRegistration {
        fn new(
            protocol: BluetoothProtocol,
            selector: &HSTRING,
            tx: mpsc::Sender<WorkerMessage>,
            generation: u64,
        ) -> windows_core::Result<Self> {
            let properties: IIterable<HSTRING> = vec![
                HSTRING::from(IS_CONNECTED),
                HSTRING::from(IS_PAIRED),
                HSTRING::from(CONTAINER_ID),
                HSTRING::from(DEVICE_ADDRESS),
                HSTRING::from(COD_MAJOR),
                HSTRING::from(COD_MINOR),
                HSTRING::from(BLE_APPEARANCE),
                HSTRING::from(BATTERY_LIFE),
            ]
            .into();
            let watcher = DeviceInformation::CreateWatcherWithKindAqsFilterAndAdditionalProperties(
                selector,
                &properties,
                DeviceInformationKind::AssociationEndpoint,
            )?;

            let mut registration = Self {
                protocol,
                watcher,
                added: None,
                updated: None,
                removed: None,
                completed: None,
                stopped: None,
                devices: HashMap::new(),
            };

            let added_tx = tx.clone();
            registration.added =
                Some(registration.watcher.Added(&TypedEventHandler::<
                    DeviceWatcher,
                    DeviceInformation,
                >::new(move |_, info| {
                    if let Some(info) = info.cloned() {
                        let _ = added_tx.send(WorkerMessage::Added(generation, protocol, info));
                    }
                    Ok(())
                }))?);
            let updated_tx = tx.clone();
            registration.updated =
                Some(registration.watcher.Updated(&TypedEventHandler::<
                    DeviceWatcher,
                    DeviceInformationUpdate,
                >::new(move |_, update| {
                    if let Some(update) = update.cloned() {
                        let _ =
                            updated_tx.send(WorkerMessage::Updated(generation, protocol, update));
                    }
                    Ok(())
                }))?);
            let removed_tx = tx.clone();
            registration.removed =
                Some(registration.watcher.Removed(&TypedEventHandler::<
                    DeviceWatcher,
                    DeviceInformationUpdate,
                >::new(move |_, update| {
                    if let Some(update) = update.cloned() {
                        let _ =
                            removed_tx.send(WorkerMessage::Removed(generation, protocol, update));
                    }
                    Ok(())
                }))?);
            let completed_tx = tx.clone();
            registration.completed = Some(registration.watcher.EnumerationCompleted(
                &TypedEventHandler::<DeviceWatcher, IInspectable>::new(move |_, _| {
                    let _ = completed_tx
                        .send(WorkerMessage::EnumerationCompleted(generation, protocol));
                    Ok(())
                }),
            )?);
            registration.stopped =
                Some(registration.watcher.Stopped(&TypedEventHandler::<
                    DeviceWatcher,
                    IInspectable,
                >::new(move |sender, _| {
                    let aborted = sender.as_ref().and_then(|watcher| watcher.Status().ok())
                        == Some(DeviceWatcherStatus::Aborted);
                    let _ = tx.send(WorkerMessage::WatcherStopped(generation, protocol, aborted));
                    Ok(())
                }))?);
            Ok(registration)
        }

        fn start(&self) -> windows_core::Result<()> {
            self.watcher.Start()
        }

        fn register_added(&mut self, info: DeviceInformation) -> Option<Observation> {
            let raw_id = info.Id().ok()?.to_string_lossy();
            cache_before_projection(&mut self.devices, raw_id, info, |info| {
                observation_from_info(self.protocol, info)
            })
        }

        fn apply_update(&mut self, update: &DeviceInformationUpdate) -> Option<Observation> {
            let id = update.Id().ok()?.to_string_lossy();
            let info = self.devices.get(&id)?;
            info.Update(update).ok()?;
            observation_from_info(self.protocol, info)
        }

        fn remove(&mut self, update: &DeviceInformationUpdate) -> Option<String> {
            let id = update.Id().ok()?.to_string_lossy();
            self.devices.remove(&id);
            Some(watcher_key(self.protocol, &id))
        }
    }

    pub(super) fn cache_before_projection<T, R>(
        items: &mut HashMap<String, T>,
        key: String,
        item: T,
        project: impl FnOnce(&T) -> Option<R>,
    ) -> Option<R> {
        let result = project(&item);
        items.insert(key, item);
        result
    }

    impl Drop for WatcherRegistration {
        fn drop(&mut self) {
            if self.watcher.Status().is_ok_and(|status| {
                status == DeviceWatcherStatus::Started
                    || status == DeviceWatcherStatus::EnumerationCompleted
            }) {
                let _ = self.watcher.Stop();
            }
            if let Some(token) = self.added.take() {
                let _ = self.watcher.RemoveAdded(token);
            }
            if let Some(token) = self.updated.take() {
                let _ = self.watcher.RemoveUpdated(token);
            }
            if let Some(token) = self.removed.take() {
                let _ = self.watcher.RemoveRemoved(token);
            }
            if let Some(token) = self.completed.take() {
                let _ = self.watcher.RemoveEnumerationCompleted(token);
            }
            if let Some(token) = self.stopped.take() {
                let _ = self.watcher.RemoveStopped(token);
            }
        }
    }

    fn observation_from_info(
        protocol: BluetoothProtocol,
        info: &DeviceInformation,
    ) -> Option<Observation> {
        let endpoint_id = info.Id().ok()?.to_string_lossy();
        let properties = info.Properties().ok()?;
        observation_from_evidence(ObservationEvidence {
            protocol,
            endpoint_id,
            name: info.Name().ok()?.to_string_lossy(),
            paired: get_bool(&properties, IS_PAIRED),
            connected: get_bool(&properties, IS_CONNECTED),
            container_id: get_guid(&properties, CONTAINER_ID),
            address: get_string(&properties, DEVICE_ADDRESS),
            cod_major: get_u16(&properties, COD_MAJOR),
            cod_minor: get_u16(&properties, COD_MINOR),
            appearance: get_u16(&properties, BLE_APPEARANCE),
            battery_percent: get_u8(&properties, BATTERY_LIFE),
        })
    }

    fn lookup(
        properties: &windows_collections::IMapView<HSTRING, IInspectable>,
        key: &str,
    ) -> Option<IPropertyValue> {
        properties.Lookup(&HSTRING::from(key)).ok()?.cast().ok()
    }

    fn get_bool(
        properties: &windows_collections::IMapView<HSTRING, IInspectable>,
        key: &str,
    ) -> Option<bool> {
        lookup(properties, key)?.GetBoolean().ok()
    }

    fn get_u8(
        properties: &windows_collections::IMapView<HSTRING, IInspectable>,
        key: &str,
    ) -> Option<u8> {
        let value = lookup(properties, key)?;
        match value.Type().ok()? {
            PropertyType::UInt8 => value.GetUInt8().ok(),
            PropertyType::Int16 => value.GetInt16().ok().and_then(|v| u8::try_from(v).ok()),
            PropertyType::UInt16 => value.GetUInt16().ok().and_then(|v| u8::try_from(v).ok()),
            PropertyType::Int32 => value.GetInt32().ok().and_then(|v| u8::try_from(v).ok()),
            PropertyType::UInt32 => value.GetUInt32().ok().and_then(|v| u8::try_from(v).ok()),
            _ => None,
        }
    }

    fn get_u16(
        properties: &windows_collections::IMapView<HSTRING, IInspectable>,
        key: &str,
    ) -> Option<u16> {
        let value = lookup(properties, key)?;
        match value.Type().ok()? {
            PropertyType::UInt8 => value.GetUInt8().ok().map(u16::from),
            PropertyType::UInt16 => value.GetUInt16().ok(),
            PropertyType::UInt32 => value
                .GetUInt32()
                .ok()
                .and_then(|number| u16::try_from(number).ok()),
            _ => None,
        }
    }

    fn get_string(
        properties: &windows_collections::IMapView<HSTRING, IInspectable>,
        key: &str,
    ) -> Option<String> {
        lookup(properties, key)?
            .GetString()
            .ok()
            .map(|value| value.to_string_lossy())
    }

    fn get_guid(
        properties: &windows_collections::IMapView<HSTRING, IInspectable>,
        key: &str,
    ) -> Option<String> {
        lookup(properties, key)?
            .GetGuid()
            .ok()
            .map(|value| format!("{value:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(id: &str, connected: bool, battery: Option<u8>) -> Observation {
        observation_kind(id, connected, battery, BluetoothDeviceKind::Generic)
    }

    fn observation_kind(
        id: &str,
        connected: bool,
        battery: Option<u8>,
        kind: BluetoothDeviceKind,
    ) -> Observation {
        Observation {
            watcher_id: format!("watcher:{id}"),
            stable_id: id.to_string(),
            name: "Bluetooth device".to_string(),
            kind,
            connected,
            battery_percent: battery,
        }
    }

    fn evidence(
        protocol: BluetoothProtocol,
        endpoint_id: &str,
        container_id: Option<&str>,
    ) -> ObservationEvidence {
        ObservationEvidence {
            protocol,
            endpoint_id: endpoint_id.to_string(),
            name: "Paired device".to_string(),
            paired: Some(true),
            connected: Some(true),
            container_id: container_id.map(str::to_string),
            address: Some("AA:BB:CC:DD:EE:FF".to_string()),
            cod_major: None,
            cod_minor: None,
            appearance: None,
            battery_percent: None,
        }
    }

    #[test]
    fn classifies_every_supported_device_kind() {
        assert_eq!(
            classify_device(Some(41 << 6), None, None, ""),
            BluetoothDeviceKind::Audio
        );
        assert_eq!(
            classify_device(Some((15 << 6) | 2), None, None, ""),
            BluetoothDeviceKind::Mouse
        );
        assert_eq!(
            classify_device(Some((15 << 6) | 1), None, None, ""),
            BluetoothDeviceKind::Keyboard
        );
        assert_eq!(
            classify_device(Some((15 << 6) | 7), None, None, ""),
            BluetoothDeviceKind::Pen
        );
        assert_eq!(
            classify_device(Some((15 << 6) | 4), None, None, ""),
            BluetoothDeviceKind::Gamepad
        );
        assert_eq!(
            classify_device(Some(1 << 6), None, None, ""),
            BluetoothDeviceKind::Phone
        );
        assert_eq!(
            classify_device(Some(3 << 6), None, None, ""),
            BluetoothDeviceKind::Wearable
        );
        assert_eq!(
            classify_device(None, None, None, "Unclassified accessory"),
            BluetoothDeviceKind::Generic
        );
    }

    #[test]
    fn classifies_classic_mouse_keyboard_and_other_cod_devices() {
        assert_eq!(
            classify_device(None, Some(5), Some(0x20), ""),
            BluetoothDeviceKind::Mouse
        );
        assert_eq!(
            classify_device(None, Some(5), Some(0x10), ""),
            BluetoothDeviceKind::Keyboard
        );
        assert_eq!(
            classify_device(None, Some(5), Some(0x02), ""),
            BluetoothDeviceKind::Gamepad
        );
        assert_eq!(
            classify_device(None, Some(5), Some(0x05), ""),
            BluetoothDeviceKind::Pen
        );
        assert_eq!(
            classify_device(None, Some(4), Some(6), ""),
            BluetoothDeviceKind::Audio
        );
        assert_eq!(
            classify_device(None, Some(2), None, ""),
            BluetoothDeviceKind::Phone
        );
        assert_eq!(
            classify_device(None, Some(7), None, ""),
            BluetoothDeviceKind::Wearable
        );
    }

    #[test]
    fn metadata_hints_are_conservative_fallbacks() {
        assert_eq!(
            classify_device(None, None, None, "Travel Mouse"),
            BluetoothDeviceKind::Mouse
        );
        assert_eq!(
            classify_device(None, None, None, "Xbox Wireless Controller"),
            BluetoothDeviceKind::Gamepad
        );
        assert_eq!(
            classify_device(None, None, None, "Ordinary Accessory"),
            BluetoothDeviceKind::Generic
        );
    }

    #[test]
    fn filters_unpaired_pseudo_and_unobservable_endpoints() {
        let mut unpaired = evidence(BluetoothProtocol::LowEnergy, "one", Some("container"));
        unpaired.paired = Some(false);
        assert!(observation_from_evidence(unpaired).is_none());

        let mut pseudo = evidence(BluetoothProtocol::Classic, "adapter", Some("local"));
        pseudo.connected = None;
        assert!(observation_from_evidence(pseudo).is_none());

        let mut unnamed = evidence(BluetoothProtocol::LowEnergy, "service", None);
        unnamed.name.clear();
        assert!(observation_from_evidence(unnamed).is_none());
    }

    #[test]
    fn stable_identity_aggregates_protocols_by_container_then_separates_addresses() {
        let classic = observation_from_evidence(evidence(
            BluetoothProtocol::Classic,
            "classic",
            Some("shared-container"),
        ))
        .unwrap();
        let ble = observation_from_evidence(evidence(
            BluetoothProtocol::LowEnergy,
            "ble",
            Some("shared-container"),
        ))
        .unwrap();
        assert_eq!(classic.stable_id, ble.stable_id);
        assert!(classic.stable_id.starts_with("bt-"));
        assert!(!classic.stable_id.contains("shared-container"));

        let classic_address = observation_from_evidence(evidence(
            BluetoothProtocol::Classic,
            "classic-address",
            None,
        ))
        .unwrap();
        let ble_address =
            observation_from_evidence(evidence(BluetoothProtocol::LowEnergy, "ble-address", None))
                .unwrap();
        assert_ne!(classic_address.stable_id, ble_address.stable_id);
    }

    #[test]
    fn refined_identity_migrates_one_watcher_without_a_ghost_or_reconnect() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let initial = observation("endpoint-id", true, None);
        assert_eq!(
            reducer.observe(initial.clone(), 0)[0].phase,
            BluetoothTransitionPhase::Connected
        );

        let mut refined = initial;
        refined.stable_id = "container-id".to_string();
        assert!(reducer.observe(refined, 100).is_empty());

        let snapshot = reducer.snapshot(BluetoothServicePhase::Ready, None);
        assert_eq!(snapshot.devices.len(), 1);
        assert_eq!(snapshot.devices[0].id, "container-id");
        assert!(!reducer.devices.contains_key("endpoint-id"));
    }

    #[test]
    fn refined_identity_carries_pending_disconnect_into_rapid_reconnect() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let initial = observation("endpoint-id", true, None);
        reducer.observe(initial.clone(), 0);

        let mut sleeping = initial.clone();
        sleeping.connected = false;
        assert!(reducer.observe(sleeping, 100).is_empty());

        let mut refined = initial;
        refined.stable_id = "container-id".to_string();
        assert!(reducer.observe(refined, 1_000).is_empty());
        assert!(reducer.flush(2_000).is_empty());
        assert!(!reducer.pending_disconnects.contains_key("endpoint-id"));
        assert_eq!(
            reducer.snapshot(BluetoothServicePhase::Ready, None).devices[0].id,
            "container-id"
        );
    }

    #[test]
    fn refined_identity_cancels_pending_disconnect_when_merging_connected_records() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let initial = observation("endpoint-id", true, None);
        let target = observation("container-id", true, None);
        reducer.observe(initial.clone(), 0);
        reducer.observe(target, 10);

        let mut sleeping = initial.clone();
        sleeping.connected = false;
        reducer.observe(sleeping, 100);

        let mut refined = initial;
        refined.stable_id = "container-id".to_string();
        assert!(reducer.observe(refined, 200).is_empty());
        assert!(!reducer.pending_disconnects.contains_key("container-id"));
        assert!(reducer.flush(2_000).is_empty());
        assert_eq!(
            reducer
                .snapshot(BluetoothServicePhase::Ready, None)
                .devices
                .len(),
            1
        );
    }

    #[test]
    fn partial_identity_refinement_preserves_a_disconnected_sibling_deadline() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let first = observation("endpoint-id", true, None);
        let mut sibling = first.clone();
        sibling.watcher_id = "watcher:sibling".to_string();
        reducer.observe(first.clone(), 0);
        reducer.observe(sibling.clone(), 10);

        let mut first_sleeping = first.clone();
        first_sleeping.connected = false;
        reducer.observe(first_sleeping, 100);
        sibling.connected = false;
        reducer.observe(sibling, 200);

        let mut refined = first;
        refined.stable_id = "container-id".to_string();
        reducer.observe(refined, 300);
        assert!(reducer.pending_disconnects.contains_key("endpoint-id"));
        assert_eq!(
            reducer.flush(1_100)[0]
                .device
                .as_ref()
                .expect("disconnected sibling")
                .id,
            "endpoint-id"
        );
    }

    #[test]
    fn partial_refinement_does_not_reschedule_a_target_disconnect() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let target = observation("container-id", true, None);
        reducer.observe(target.clone(), 0);
        let mut target_sleeping = target;
        target_sleeping.connected = false;
        reducer.observe(target_sleeping, 100);

        let mut moved = observation("endpoint-id", false, None);
        let mut sibling = moved.clone();
        sibling.watcher_id = "watcher:sibling".to_string();
        sibling.connected = true;
        reducer.observe(moved.clone(), 200);
        reducer.observe(sibling, 210);

        moved.stable_id = "container-id".to_string();
        let events = reducer.observe(moved, 1_000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].phase, BluetoothTransitionPhase::Disconnected);
        assert!(!reducer.pending_disconnects.contains_key("container-id"));
        assert!(reducer.flush(2_000).is_empty());
    }

    #[test]
    fn merging_pending_identities_keeps_the_later_disconnect_deadline() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let target = observation("container-id", true, None);
        reducer.observe(target.clone(), 0);
        let mut target_sleeping = target;
        target_sleeping.connected = false;
        reducer.observe(target_sleeping, 100);

        let source = observation("endpoint-id", true, None);
        reducer.observe(source.clone(), 200);
        let mut source_sleeping = source.clone();
        source_sleeping.connected = false;
        reducer.observe(source_sleeping, 500);

        let mut refined = source;
        refined.stable_id = "container-id".to_string();
        refined.connected = false;
        assert!(reducer.observe(refined, 600).is_empty());
        assert!(reducer.flush(1_000).is_empty());
        assert_eq!(
            reducer.flush(1_400)[0].phase,
            BluetoothTransitionPhase::Disconnected
        );
    }

    #[test]
    fn incomplete_added_endpoint_remains_cached_for_later_update() {
        let mut cache = HashMap::new();
        let initial =
            imp::cache_before_projection(&mut cache, "endpoint".to_string(), false, |ready| {
                ready.then_some("observed")
            });

        assert_eq!(initial, None);
        *cache.get_mut("endpoint").expect("cached endpoint") = true;
        assert_eq!(
            cache
                .get("endpoint")
                .and_then(|ready| ready.then_some("observed")),
            Some("observed")
        );
    }

    #[test]
    fn startup_baseline_is_silent() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        assert!(reducer
            .observe(observation("one", true, None), 0)
            .is_empty());
        reducer.finish_baseline();
        assert_eq!(
            reducer
                .snapshot(BluetoothServicePhase::Ready, None)
                .devices
                .len(),
            1
        );
    }

    #[test]
    fn baseline_removal_does_not_retain_a_device_without_interfaces() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        let device = observation("one", true, None);
        reducer.observe(device.clone(), 0);
        assert!(reducer.remove_watcher_id(&device.watcher_id, 10).is_empty());
        reducer.finish_baseline();

        assert!(reducer
            .snapshot(BluetoothServicePhase::NoDevice, None)
            .devices
            .is_empty());
        assert!(!reducer.devices.contains_key(&device.stable_id));
    }

    #[test]
    fn emits_connected_and_debounced_disconnected() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        let connected = reducer.observe(observation("one", true, None), 0);
        assert_eq!(connected[0].phase, BluetoothTransitionPhase::Connected);

        assert!(reducer
            .observe(observation("one", false, None), 100)
            .is_empty());
        assert!(reducer.flush(999).is_empty());
        assert_eq!(
            reducer.flush(1_000)[0].phase,
            BluetoothTransitionPhase::Disconnected
        );
    }

    #[test]
    fn rapid_reconnect_cancels_both_flapping_notices() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        reducer.observe(observation("one", true, None), 0);
        reducer.observe(observation("one", false, None), 100);
        assert!(reducer
            .observe(observation("one", true, None), 500)
            .is_empty());
        assert!(reducer.flush(2_000).is_empty());
    }

    #[test]
    fn reconnect_at_disconnect_deadline_emits_both_final_states() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        reducer.observe(observation("one", true, None), 0);
        reducer.observe(observation("one", false, None), 100);

        let events = reducer.observe(observation("one", true, None), 1_000);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].phase, BluetoothTransitionPhase::Disconnected);
        assert_eq!(events[1].phase, BluetoothTransitionPhase::Connected);
    }

    #[test]
    fn hid_sleep_wake_uses_longer_debounce_without_inactivity_inference() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        reducer.observe(
            observation_kind("mouse", true, None, BluetoothDeviceKind::Mouse),
            0,
        );
        reducer.observe(
            observation_kind("mouse", false, None, BluetoothDeviceKind::Mouse),
            100,
        );
        assert!(reducer.flush(1_599).is_empty());
        assert_eq!(
            reducer.flush(1_600)[0].phase,
            BluetoothTransitionPhase::Disconnected
        );

        reducer.observe(
            observation_kind("mouse", true, None, BluetoothDeviceKind::Mouse),
            2_000,
        );
        reducer.observe(
            observation_kind("mouse", false, None, BluetoothDeviceKind::Mouse),
            2_100,
        );
        assert!(reducer
            .observe(
                observation_kind("mouse", true, None, BluetoothDeviceKind::Mouse),
                3_000,
            )
            .is_empty());
        assert!(reducer.flush(5_000).is_empty());
    }

    #[test]
    fn repeated_updates_and_unknown_battery_are_silent() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        reducer.observe(observation("one", true, None), 0);
        reducer.finish_baseline();
        assert!(reducer
            .observe(observation("one", true, None), 100)
            .is_empty());
    }

    #[test]
    fn newly_available_battery_emits_update_after_connected_baseline() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        reducer.observe(observation("one", true, None), 0);
        reducer.finish_baseline();
        let events = reducer.observe(observation("one", true, Some(72)), 100);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].phase, BluetoothTransitionPhase::BatteryUpdated);
    }

    #[test]
    fn low_battery_alerts_once_per_hysteresis_band() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        reducer.observe(observation("one", true, Some(40)), 0);
        reducer.finish_baseline();

        let first = reducer.observe(observation("one", true, Some(20)), 10);
        assert_eq!(first[0].phase, BluetoothTransitionPhase::LowBattery);
        assert!(reducer
            .observe(observation("one", true, Some(18)), 20)
            .iter()
            .all(|event| event.phase != BluetoothTransitionPhase::LowBattery));

        reducer.observe(observation("one", true, Some(25)), 30);
        let second = reducer.observe(observation("one", true, Some(19)), 40);
        assert_eq!(
            second
                .iter()
                .filter(|event| event.phase == BluetoothTransitionPhase::LowBattery)
                .count(),
            1
        );
    }

    #[test]
    fn restart_baseline_does_not_reannounce_devices() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        reducer.observe(observation("one", true, None), 0);
        reducer.begin_baseline();
        assert!(reducer
            .observe(observation("one", true, None), 1_000)
            .is_empty());
        reducer.finish_baseline();
        assert!(reducer.flush(5_000).is_empty());
    }

    #[test]
    fn duplicate_interfaces_share_one_logical_connection() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        reducer.observe(observation("one", true, None), 0);
        let mut companion = observation("one", false, Some(72));
        companion.watcher_id = "watcher:companion".to_string();
        reducer.observe(companion.clone(), 0);
        reducer.finish_baseline();

        companion.connected = false;
        assert!(reducer.observe(companion, 100).is_empty());
        assert!(reducer.flush(2_000).is_empty());
        assert_eq!(
            reducer
                .snapshot(BluetoothServicePhase::Ready, None)
                .devices
                .len(),
            1
        );
    }

    #[test]
    fn specific_classification_survives_connected_generic_companion() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        let mut classic = observation_kind("shared", false, None, BluetoothDeviceKind::Audio);
        classic.watcher_id = "classic:endpoint".to_string();
        reducer.observe(classic, 0);
        let mut ble = observation_kind("shared", true, None, BluetoothDeviceKind::Generic);
        ble.watcher_id = "ble:endpoint".to_string();
        reducer.observe(ble, 1);
        reducer.finish_baseline();
        assert_eq!(
            reducer.snapshot(BluetoothServicePhase::Ready, None).devices[0].kind,
            BluetoothDeviceKind::Audio
        );
    }

    #[test]
    fn removing_one_interface_keeps_connection_until_final_interface_is_removed() {
        let mut reducer = TransitionReducer::default();
        reducer.begin_baseline();
        let mut classic = observation("shared", true, None);
        classic.watcher_id = "classic:endpoint".to_string();
        reducer.observe(classic, 0);
        let mut ble = observation("shared", true, None);
        ble.watcher_id = "ble:endpoint".to_string();
        reducer.observe(ble, 0);
        reducer.finish_baseline();

        assert!(reducer
            .remove_watcher_id("classic:endpoint", 100)
            .is_empty());
        assert!(reducer.flush(2_000).is_empty());
        assert!(reducer.remove_watcher_id("ble:endpoint", 2_100).is_empty());
        assert_eq!(
            reducer.flush(3_000)[0].phase,
            BluetoothTransitionPhase::Disconnected
        );
    }

    #[test]
    fn baseline_reset_models_radio_off_without_disconnect_flood() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        reducer.observe(observation("one", true, None), 0);
        reducer.begin_baseline();
        assert!(reducer.flush(5_000).is_empty());
        assert!(reducer
            .snapshot(
                BluetoothServicePhase::Degraded,
                Some("radio off".to_string())
            )
            .devices
            .is_empty());
    }

    #[test]
    fn battery_unknown_sentinel_is_not_fabricated_as_full() {
        let mut unknown = evidence(BluetoothProtocol::LowEnergy, "mouse", Some("mouse"));
        unknown.battery_percent = Some(101);
        assert_eq!(
            observation_from_evidence(unknown).unwrap().battery_percent,
            None
        );
    }

    #[test]
    fn operational_phase_tracks_live_connections_after_debounce() {
        let mut reducer = TransitionReducer::default();
        reducer.finish_baseline();
        assert_eq!(reducer.operational_phase(), BluetoothServicePhase::NoDevice);
        reducer.observe(observation("one", true, None), 0);
        assert_eq!(reducer.operational_phase(), BluetoothServicePhase::Ready);
        reducer.observe(observation("one", false, None), 100);
        assert_eq!(reducer.operational_phase(), BluetoothServicePhase::Ready);
        reducer.flush(999);
        assert_eq!(reducer.operational_phase(), BluetoothServicePhase::Ready);
        reducer.flush(1_000);
        assert_eq!(reducer.operational_phase(), BluetoothServicePhase::NoDevice);
    }
}
