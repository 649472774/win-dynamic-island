mod media;
mod system;
mod window;

use tauri::Manager;

use window::RegionState;

/// Periodically watch the primary monitor. If its geometry or scale factor
/// changes (display added/removed, resolution or DPI change, primary display
/// switched) we re-center the island so it always hugs the top-center of the
/// current primary display. Runs at a low frequency to keep idle CPU near zero.
fn spawn_monitor_watcher(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut signature: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let Some(win) = app.get_webview_window("main") else {
                continue;
            };
            // Re-assert the non-activating tool-window styles. Tauri resets the
            // extended styles during async WebView init (after `setup`), so we
            // (re)apply here — it's idempotent and only writes when a bit needs
            // changing, so this both makes the flags stick shortly after launch
            // and self-heals if anything clears them later.
            window::make_tool_window(&win);
            // Re-assert the pill region too. The region clip can be dropped by
            // the same async WebView init / system events that reset the styles;
            // if it is, the whole opaque Acrylic rectangle shows as a grey block.
            // `ensure_region` only re-applies when the live region no longer
            // matches, so this self-heals without ever disturbing a live morph.
            window::ensure_region(&win);
            if let Ok(Some(monitor)) = win.primary_monitor() {
                let p = monitor.position();
                let s = monitor.size();
                let sig = (p.x, p.y, s.width, s.height, monitor.scale_factor().to_bits());
                if signature.is_some() && signature != Some(sig) {
                    window::center_top(&win);
                    if let Some(state) = win.try_state::<RegionState>() {
                        if let Some(r) = *state.last.lock().unwrap() {
                            window::apply_region(&win, r);
                        }
                    }
                }
                signature = Some(sig);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(RegionState::default())
        .invoke_handler(tauri::generate_handler![
            window::set_island_region,
            window::recenter,
            window::reveal_island,
            media::get_now_playing,
            media::media_play_pause,
            media::media_next,
            media::media_previous,
            system::get_system_info,
        ])
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("main window must exist");

            // Order matters: shape/behaviour first, then position, then the
            // frontend reveals the window once it has painted.
            // NOTE: We deliberately do *not* apply a full-window Acrylic/blur
            // backdrop here. On Windows 11 the accent-acrylic DWM backdrop is
            // composited across the entire window frame and ignores the pill
            // `SetWindowRgn` clip, so it would paint the whole 760x480 window as
            // an opaque grey block over the desktop (the region only clips
            // hit-testing, not the DWM backdrop). The pill instead renders as a
            // self-contained translucent glass capsule in CSS, keeping the rest
            // of the window fully transparent and click-through.
            window::make_tool_window(&win);
            window::center_top(&win);

            // Start the Now Playing (SMTC) worker and expose its state.
            let media_state = media::init(app.handle());
            app.manage(media_state);

            // Start the system-info (battery / CPU / memory) sampler.
            let system_state = system::init(app.handle());
            app.manage(system_state);

            spawn_monitor_watcher(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
