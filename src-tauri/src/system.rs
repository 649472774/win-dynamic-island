//! System info (M3): battery, CPU load and memory usage.
//!
//! A single low-frequency worker thread samples the three metrics every couple
//! of seconds and pushes a `system-update` event to the frontend. The metrics
//! are all cheap Win32 calls (no COM, no allocations), so the idle cost is
//! negligible — well within the "< 1% idle CPU" budget.
//!
//! - Battery / charging state: `GetSystemPowerStatus`
//! - Memory load:              `GlobalMemoryStatusEx`
//! - CPU load:                 `GetSystemTimes` (busy vs. idle delta between
//!                             two samples)
//!
//! The frontend also has a `get_system_info` command for the very first paint
//! so it doesn't have to wait up to one poll interval for the first event.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::AppHandle;

/// Snapshot of the machine's power / load state. Serialized to the frontend as
/// camelCase JSON.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// Whether a battery is present (desktops report `false`).
    pub has_battery: bool,
    /// Battery charge 0..=100, or -1 when unknown / no battery.
    pub battery_percent: i32,
    /// Currently charging.
    pub charging: bool,
    /// Running on AC power (mains connected).
    pub on_ac: bool,
    /// Convenience flag: on battery, not charging, and <= 20%.
    pub low_battery: bool,
    /// Overall CPU load 0..=100 (averaged over the last sample interval).
    pub cpu_percent: i32,
    /// Physical memory in use 0..=100.
    pub mem_percent: i32,
    /// Used physical memory in MB.
    pub mem_used_mb: i32,
    /// Total physical memory in MB.
    pub mem_total_mb: i32,
}

/// Shared latest snapshot, readable by the `get_system_info` command.
pub struct SystemState {
    pub shared: Arc<Mutex<SystemInfo>>,
}

/// Return the most recent system snapshot (used for the initial render).
#[tauri::command]
pub fn get_system_info(state: tauri::State<'_, SystemState>) -> SystemInfo {
    state.shared.lock().unwrap().clone()
}

/// Start the background sampler and return the shared state to be `manage`d.
pub fn init(app: &AppHandle) -> SystemState {
    let shared = Arc::new(Mutex::new(SystemInfo::default()));
    let worker_shared = shared.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        imp::run(app, worker_shared);
    });
    SystemState { shared }
}

#[cfg(windows)]
mod imp {
    use super::SystemInfo;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;

    /// A prior CPU-time sample (100ns units): idle, kernel (incl. idle), user.
    type CpuSample = (u64, u64, u64);

    pub fn run(app: AppHandle, shared: Arc<Mutex<SystemInfo>>) {
        let mut prev: Option<CpuSample> = None;
        loop {
            let info = read(&mut prev);
            if let Ok(mut guard) = shared.lock() {
                *guard = info.clone();
            }
            let _ = app.emit("system-update", &info);
            std::thread::sleep(Duration::from_millis(2000));
        }
    }

    fn read(prev: &mut Option<CpuSample>) -> SystemInfo {
        let mut info = SystemInfo::default();
        info.battery_percent = -1;

        // --- Battery / power ------------------------------------------------
        unsafe {
            let mut status = SYSTEM_POWER_STATUS::default();
            if GetSystemPowerStatus(&mut status).is_ok() {
                // BatteryFlag bit 128 = "no system battery".
                let no_battery = status.BatteryFlag & 128 != 0;
                info.has_battery = !no_battery && status.BatteryFlag != 255;
                info.on_ac = status.ACLineStatus == 1;
                // BatteryFlag bit 8 = charging.
                info.charging = status.BatteryFlag & 8 != 0;
                if status.BatteryLifePercent != 255 {
                    info.battery_percent = status.BatteryLifePercent as i32;
                }
                info.low_battery = info.has_battery
                    && !info.charging
                    && info.battery_percent >= 0
                    && info.battery_percent <= 20;
            }
        }

        // --- Memory ---------------------------------------------------------
        unsafe {
            let mut mem = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                ..Default::default()
            };
            if GlobalMemoryStatusEx(&mut mem).is_ok() {
                info.mem_percent = mem.dwMemoryLoad as i32;
                let used = mem.ullTotalPhys.saturating_sub(mem.ullAvailPhys);
                info.mem_used_mb = (used / (1024 * 1024)) as i32;
                info.mem_total_mb = (mem.ullTotalPhys / (1024 * 1024)) as i32;
            }
        }

        // --- CPU (delta of busy vs. idle since last sample) -----------------
        unsafe {
            let mut idle = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            if GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_ok() {
                let sample = (ft(idle), ft(kernel), ft(user));
                if let Some((pi, pk, pu)) = *prev {
                    let idle_d = sample.0.saturating_sub(pi);
                    // Kernel time includes idle time, so total = kernel + user.
                    let total_d = sample.1.saturating_sub(pk) + sample.2.saturating_sub(pu);
                    if total_d > 0 {
                        let busy = total_d.saturating_sub(idle_d);
                        info.cpu_percent = ((busy * 100 + total_d / 2) / total_d) as i32;
                        info.cpu_percent = info.cpu_percent.clamp(0, 100);
                    }
                }
                *prev = Some(sample);
            }
        }

        info
    }

    /// Pack a FILETIME into a 64-bit 100ns tick count.
    fn ft(f: FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | (f.dwLowDateTime as u64)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::SystemInfo;
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;

    pub fn run(_app: AppHandle, _shared: Arc<Mutex<SystemInfo>>) {
        // Non-Windows: leave defaults; nothing to sample.
    }
}
