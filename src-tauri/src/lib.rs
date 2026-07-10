mod clipboard;
mod dragdrop;
mod glass;
mod media;
mod system;
mod tray;
mod volume;
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
            // Re-evaluate Windows transparency/high-contrast policy and heal
            // the native underlay after display/session changes.
            glass::reconcile(&win);
            // Safety net for staying on top: the foreground WinEvent hook handles
            // the common case (another app coming forward) instantly, but some
            // windows appear topmost without a foreground event. Re-asserting here
            // (a no-op when already on top) covers those without added flicker.
            window::raise_topmost(&win);
            if let Ok(Some(monitor)) = win.primary_monitor() {
                let p = monitor.position();
                let s = monitor.size();
                let sig = (
                    p.x,
                    p.y,
                    s.width,
                    s.height,
                    monitor.scale_factor().to_bits(),
                );
                if signature.is_some() && signature != Some(sig) {
                    window::center_top(&win);
                    if let Some(state) = win.try_state::<RegionState>() {
                        if let Some(r) = *state.last.lock().unwrap() {
                            window::apply_region(&win, r);
                        }
                    }
                    // Keep the invisible drag-catcher strip aligned with the
                    // island after it re-centers on the new monitor.
                    dragdrop::reposition(win.app_handle());
                }
                signature = Some(sig);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(RegionState::default())
        .manage(glass::GlassState::default())
        .invoke_handler(tauri::generate_handler![
            window::set_island_region,
            window::recenter,
            window::reveal_island,
            media::get_now_playing,
            media::media_play_pause,
            media::media_next,
            media::media_previous,
            media::media_seek,
            system::get_system_info,
            volume::get_volume,
            volume::set_volume,
            volume::set_muted,
            clipboard::clipboard_copy_files,
            clipboard::clipboard_copy_text,
            clipboard::clipboard_read,
            dragdrop::rearm_drop_target,
            glass::get_glass_status,
            glass::set_glass_enabled,
        ])
        .setup(|app| {
            glass::register_main_thread();
            let win = app
                .get_webview_window("main")
                .expect("main window must exist");

            // Order matters: shape/behaviour first, then position, then the
            // frontend reveals the window once it has painted.
            // NOTE: We deliberately do *not* apply a full-window Acrylic/blur
            // backdrop here. On Windows 11 the accent-acrylic DWM backdrop is
            // composited across the entire window frame and ignores the pill
            // `SetWindowRgn` clip, so it would paint the whole 760x900 window as
            // an opaque grey block over the desktop (the region only clips
            // hit-testing, not the DWM backdrop). The pill instead renders as a
            // self-contained translucent glass capsule in CSS, keeping the rest
            // of the window fully transparent and click-through.
            window::make_tool_window(&win);
            window::center_top(&win);
            // Keep the island reliably above other windows. Installs a
            // foreground WinEvent hook (must run on this main/UI thread so its
            // out-of-context callbacks are pumped by tao's event loop) and
            // asserts topmost now.
            window::install_topmost_guard(&win);
            window::raise_topmost(&win);

            // Register a native OLE drop target (M4f). wry's built-in file-drop
            // events never fire on our transparent (layered) window, so we roll
            // our own IDropTarget here on the main/UI thread. This is what makes
            // "drag a file onto the island" actually work.
            dragdrop::install(app.handle());

            let glass_app = app.handle().clone();
            win.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    glass::shutdown(&glass_app);
                }
            });

            // Start the Now Playing (SMTC) worker and expose its state.
            let media_state = media::init(app.handle());
            app.manage(media_state);

            // Start the system-info (battery / CPU / memory) sampler.
            let system_state = system::init(app.handle());
            app.manage(system_state);

            // Start the volume watcher (event-driven HUD).
            let volume_state = volume::init(app.handle());
            app.manage(volume_state);

            spawn_monitor_watcher(app.handle());

            // System tray icon + menu (设置 / 开机自启 / 退出).
            tray::init(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
