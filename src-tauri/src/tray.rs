//! System tray icon + right-click menu (M4b).
//!
//! Menu: 设置 / 开机自启（可勾选）/ 退出. Left-clicking the tray icon opens the
//! settings view (same as the menu's 设置 item). The "开机自启" item reflects and
//! toggles the real autostart registry state via the autostart plugin, and also
//! notifies the frontend so its settings UI stays in sync.

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};
use tauri_plugin_autostart::ManagerExt;

/// Build the tray icon and wire its menu/click handlers. Called once from setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let settings_item = MenuItemBuilder::with_id("tray_settings", "设置").build(app)?;
    let autostart_item = CheckMenuItemBuilder::with_id("tray_autostart", "开机自启")
        .checked(autostart_on)
        .build(app)?;
    let quit_item = MenuItemBuilder::with_id("tray_quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&settings_item)
        .item(&autostart_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // `autostart_item` is moved into the menu-event closure so it can update the
    // checkmark after toggling. Menu items are Arc-backed clones, so keeping a
    // handle here is cheap and safe.
    let autostart_handle = autostart_item.clone();

    TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundle must provide a default window icon"),
        )
        .tooltip("灵动岛")
        .menu(&menu)
        // Left-click should open settings, not pop the menu; the menu is on
        // right-click. So don't let a left-click auto-open the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "tray_settings" => {
                let _ = app.emit("open-settings", ());
            }
            "tray_autostart" => {
                let mgr = app.autolaunch();
                let currently = mgr.is_enabled().unwrap_or(false);
                let _ = if currently {
                    mgr.disable()
                } else {
                    mgr.enable()
                };
                let now = mgr.is_enabled().unwrap_or(!currently);
                let _ = autostart_handle.set_checked(now);
                // Keep the frontend settings toggle in sync.
                let _ = app.emit("autostart-changed", now);
            }
            "tray_quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().emit("open-settings", ());
            }
        })
        .build(app)?;

    Ok(())
}
