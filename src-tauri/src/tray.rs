//! System tray icon + right-click menu (M4b).
//!
//! Menu: 设置 / 开机自启（可勾选）/ 退出. Left-clicking the tray icon opens the
//! settings view (same as the menu's 设置 item). The "开机自启" item reflects and
//! toggles the real autostart registry state via the autostart plugin, and also
//! notifies the frontend so its settings UI stays in sync.

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::timer::TimerState;

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
                let Some(timer) = app.try_state::<TimerState>() else {
                    app.exit(0);
                    return;
                };
                if !timer.has_running_tasks() {
                    app.exit(0);
                    return;
                }
                let app = app.clone();
                app.dialog()
                    .message("仍有计时任务正在运行。退出将取消全部计时器、秒表和番茄钟。")
                    .title("确认退出")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "退出并取消".into(),
                        "继续运行".into(),
                    ))
                    .show(move |confirmed| {
                        if confirmed {
                            let result = app
                                .try_state::<TimerState>()
                                .ok_or_else(|| "计时引擎尚未就绪".to_string())
                                .and_then(|timer| timer.clear_all());
                            if let Err(error) = result {
                                app.dialog()
                                    .message(format!(
                                        "无法取消计时任务，应用将继续运行。\n\n{error}"
                                    ))
                                    .title("退出失败")
                                    .kind(MessageDialogKind::Error)
                                    .buttons(MessageDialogButtons::Ok)
                                    .show(|_| {});
                                return;
                            }
                            app.exit(0);
                        }
                    });
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
