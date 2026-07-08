//! System volume HUD (M3).
//!
//! We watch the **default render endpoint** volume and push a `volume-changed`
//! event whenever it changes (master level or mute). The frontend turns that
//! into a transient HUD (a slider that pops in and auto-collapses).
//!
//! Detection is fully **event-driven**: we implement the COM interface
//! `IAudioEndpointVolumeCallback` and register it with the endpoint, so the OS
//! calls us only when the volume actually changes — zero idle polling, which
//! keeps us within the "< 1% idle CPU" budget. A dedicated worker thread owns
//! the COM objects for their whole lifetime and, at a very low frequency (3s),
//! notices if the user switched the default output device and re-binds.
//!
//! `get_volume` answers the very first paint; `set_volume` / `set_muted` let the
//! HUD slider drive the system volume back.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::AppHandle;

/// Current master volume of the default render endpoint. camelCase for JS.
#[derive(Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// Master volume 0..=100.
    pub level: i32,
    /// Whether the endpoint is muted.
    pub muted: bool,
}

/// Shared latest snapshot, readable by commands.
pub struct VolumeState {
    pub shared: Arc<Mutex<VolumeInfo>>,
    /// Sender to ask the worker thread to apply a change (level/mute) on the
    /// COM-affine thread that owns the endpoint interface.
    #[cfg(windows)]
    pub tx: std::sync::mpsc::Sender<imp::Cmd>,
}

/// Return the most recent volume snapshot (used for the initial render).
#[tauri::command]
pub fn get_volume(state: tauri::State<'_, VolumeState>) -> VolumeInfo {
    *state.shared.lock().unwrap()
}

/// Set the master volume level (0..=100).
#[tauri::command]
pub fn set_volume(state: tauri::State<'_, VolumeState>, level: i32) {
    #[cfg(windows)]
    {
        let _ = state.tx.send(imp::Cmd::SetLevel(level.clamp(0, 100)));
    }
    #[cfg(not(windows))]
    {
        let _ = (state, level);
    }
}

/// Set the mute state of the default render endpoint.
#[tauri::command]
pub fn set_muted(state: tauri::State<'_, VolumeState>, muted: bool) {
    #[cfg(windows)]
    {
        let _ = state.tx.send(imp::Cmd::SetMuted(muted));
    }
    #[cfg(not(windows))]
    {
        let _ = (state, muted);
    }
}

/// Start the volume watcher worker and return the shared state to `manage`.
pub fn init(app: &AppHandle) -> VolumeState {
    let shared = Arc::new(Mutex::new(VolumeInfo::default()));

    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel::<imp::Cmd>();
        let worker_shared = shared.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            imp::run(app, worker_shared, rx);
        });
        VolumeState { shared, tx }
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        VolumeState { shared }
    }
}

#[cfg(windows)]
pub mod imp {
    use super::VolumeInfo;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use windows::Win32::Media::Audio::Endpoints::{
        IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
    };
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows_core::{implement, Result as WinResult, PCWSTR};

    /// A request from a command handler to mutate the endpoint on this thread.
    pub enum Cmd {
        SetLevel(i32),
        SetMuted(bool),
    }

    /// COM object implementing the endpoint volume-change callback. Holds a
    /// handle to emit events and the shared snapshot to keep it fresh.
    #[implement(IAudioEndpointVolumeCallback)]
    struct VolCallback {
        app: AppHandle,
        shared: Arc<Mutex<VolumeInfo>>,
    }

    impl IAudioEndpointVolumeCallback_Impl for VolCallback_Impl {
        fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> WinResult<()> {
            if data.is_null() {
                return Ok(());
            }
            let d = unsafe { &*data };
            let info = VolumeInfo {
                level: ((d.fMasterVolume * 100.0).round() as i32).clamp(0, 100),
                muted: d.bMuted.as_bool(),
            };
            if let Ok(mut guard) = self.shared.lock() {
                *guard = info;
            }
            let _ = self.app.emit("volume-changed", info);
            Ok(())
        }
    }

    pub fn run(app: AppHandle, shared: Arc<Mutex<VolumeInfo>>, rx: std::sync::mpsc::Receiver<Cmd>) {
        unsafe {
            // Multi-threaded apartment: the callback is delivered on an OS audio
            // thread, and we never pump a message loop here.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        // Rebind loop: (re)acquire the default endpoint, register the callback,
        // then park until the default device changes, draining set commands.
        loop {
            match bind(&app, &shared) {
                Ok(bound) => {
                    park(&bound, &rx);
                    // Device changed (or park asked to rebind): unregister and loop.
                    unsafe {
                        let _ = bound.endpoint.UnregisterControlChangeNotify(&bound.callback);
                    }
                }
                Err(_) => {
                    // No default device yet (e.g. no audio hardware). Retry slowly.
                    std::thread::sleep(Duration::from_millis(3000));
                }
            }
        }
    }

    /// A live binding to the current default render endpoint.
    struct Bound {
        endpoint: IAudioEndpointVolume,
        callback: IAudioEndpointVolumeCallback,
        device_id: String,
    }

    fn bind(app: &AppHandle, shared: &Arc<Mutex<VolumeInfo>>) -> WinResult<Bound> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let device_id = pwstr_to_string(device.GetId()?);
            let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;

            // Seed the shared snapshot silently (no event → no HUD on startup).
            let level = ((endpoint.GetMasterVolumeLevelScalar()? * 100.0).round() as i32)
                .clamp(0, 100);
            let muted = endpoint.GetMute()?.as_bool();
            if let Ok(mut guard) = shared.lock() {
                *guard = VolumeInfo { level, muted };
            }

            let callback: IAudioEndpointVolumeCallback = VolCallback {
                app: app.clone(),
                shared: shared.clone(),
            }
            .into();
            endpoint.RegisterControlChangeNotify(&callback)?;

            Ok(Bound {
                endpoint,
                callback,
                device_id,
            })
        }
    }

    /// Park on the current binding: apply incoming set-commands promptly and, at
    /// a low frequency, notice a default-device switch (then return to rebind).
    fn park(bound: &Bound, rx: &std::sync::mpsc::Receiver<Cmd>) {
        loop {
            // Wait up to 3s for a command; timeout drives the device-change check.
            match rx.recv_timeout(Duration::from_millis(3000)) {
                Ok(cmd) => apply(bound, cmd),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if default_render_id() != Some(bound.device_id.clone()) {
                        return; // device changed → rebind
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // Sender dropped (app shutting down): park quietly.
                    std::thread::sleep(Duration::from_millis(3000));
                }
            }
        }
    }

    fn apply(bound: &Bound, cmd: Cmd) {
        unsafe {
            match cmd {
                Cmd::SetLevel(level) => {
                    let scalar = (level as f32 / 100.0).clamp(0.0, 1.0);
                    let _ = bound
                        .endpoint
                        .SetMasterVolumeLevelScalar(scalar, std::ptr::null());
                }
                Cmd::SetMuted(muted) => {
                    let _ = bound.endpoint.SetMute(muted, std::ptr::null());
                }
            }
        }
    }

    /// Current default render device id, or None if there is none.
    fn default_render_id() -> Option<String> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .ok()?;
            Some(pwstr_to_string(device.GetId().ok()?))
        }
    }

    /// Copy a COM-allocated wide string into a Rust String and free it.
    unsafe fn pwstr_to_string(p: windows_core::PWSTR) -> String {
        if p.0.is_null() {
            return String::new();
        }
        let s = PCWSTR(p.0).to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}
