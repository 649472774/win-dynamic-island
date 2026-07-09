//! Windows-specific window setup for the Dynamic Island overlay.
//!
//! This module owns every raw Win32 call so the rest of the app (and the
//! frontend) can stay platform agnostic. It is responsible for:
//!   * applying the Acrylic/blur backdrop (real frosted-glass effect),
//!   * positioning the window horizontally centered at the top of the monitor,
//!   * clipping the window to a rounded-rectangle *region* that matches the
//!     currently visible pill / panel. The region does double duty:
//!       1. it shapes the Acrylic backdrop into a rounded pill, and
//!       2. pixels outside the region are simply not part of the window, so
//!          mouse clicks there fall through to whatever is underneath
//!          (click-through when idle) while the pill itself stays interactive.
//!
//! Because the native window never resizes (only its region changes), the
//! WebView viewport is stable and the Motion "morph" animation on the frontend
//! runs perfectly smooth.

use std::sync::Mutex;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use serde::Deserialize;
use tauri::{Manager, PhysicalPosition, Runtime, WebviewWindow};

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, GetWindowRgnBox, SetWindowRgn};
#[cfg(windows)]
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
#[cfg(windows)]
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE,
    HWND_TOPMOST, MA_NOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_MOUSEACTIVATE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// Logical gap (in CSS pixels) between the top of the screen and the island.
pub const TOP_MARGIN: f64 = 8.0;

/// Remembers the last region we applied so the background monitor watcher can
/// re-apply it after re-centering onto a different display.
#[derive(Default)]
pub struct RegionState {
    pub last: Mutex<Option<Region>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub radius: i32,
}

/// Convert the raw handle Tauri hands us into the `windows` crate `HWND`,
/// bridging any minor version differences between Tauri's `windows` and ours.
#[cfg(windows)]
fn hwnd_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<HWND> {
    window.hwnd().ok().map(|h| HWND(h.0 as _))
}

/// Apply a full-window frosted-glass backdrop (Acrylic, falling back to blur).
///
/// **Currently unused.** On Windows 11 this accent backdrop is composited by DWM
/// across the whole window frame and is *not* clipped by our pill `SetWindowRgn`,
/// so on our fixed large overlay window it would show as an opaque grey block
/// covering the desktop. Kept for reference / future use (e.g. if we ever size
/// the native window to the pill so the backdrop *is* the pill shape).
#[cfg_attr(windows, allow(dead_code))]
pub fn apply_backdrop<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    {
        use window_vibrancy::{apply_acrylic, apply_blur};
        // A deep, slightly translucent tint keeps text readable while still
        // letting the desktop blur bleed through the edges.
        if apply_acrylic(window, Some((10, 10, 14, 90))).is_err() {
            let _ = apply_blur(window, Some((10, 10, 14, 160)));
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Subclass id for our WndProc hook (any stable per-window constant works).
#[cfg(windows)]
const SUBCLASS_ID: usize = 0xD15A_11D0;

/// Window-proc subclass that keeps the island non-activating *without* dropping
/// clicks. `WS_EX_NOACTIVATE` alone stops focus theft but, when our process is
/// not the foreground app, Windows treats the press as a pure activation attempt
/// and the WebView never receives a DOM `click`. Answering `WM_MOUSEACTIVATE`
/// with `MA_NOACTIVATE` tells Windows: do not activate my window, *but* still
/// deliver the mouse message — so the pill stays clickable while the user's
/// current app keeps keyboard focus.
#[cfg(windows)]
unsafe extern "system" fn island_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Mark the window as a non-activating tool window so clicking the island never
/// steals keyboard focus from the user's current app (`WS_EX_NOACTIVATE` plus a
/// `WM_MOUSEACTIVATE`→`MA_NOACTIVATE` subclass), and keep it out of Alt-Tab /
/// the taskbar (`WS_EX_TOOLWINDOW`, and clearing `WS_EX_APPWINDOW` which Tauri
/// sets).
///
/// This is *idempotent*: it only writes the extended style when a bit actually
/// needs changing, and `SetWindowSubclass` with the same id/proc simply refreshes
/// (never stacks). So it is safe (and side-effect free) to call repeatedly. That
/// matters because Tauri/tao finishes initializing the WebView asynchronously
/// after `setup()` and resets the extended styles; the monitor-watcher thread
/// re-invokes this shortly after launch to make the flags stick and to self-heal
/// if anything clears them later.
pub fn make_tool_window<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    unsafe {
        if let Some(hwnd) = hwnd_of(window) {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want_set = (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
            let want_clear = WS_EX_APPWINDOW.0 as isize;
            let new_ex = (ex | want_set) & !want_clear;
            if new_ex != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
            }
            // Keep the click alive even though the window never activates.
            let _ = SetWindowSubclass(hwnd, Some(island_subclass_proc), SUBCLASS_ID, 0);
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Re-assert the window's spot at the top of the always-on-top Z band.
///
/// Windows "topmost" is not a hard guarantee: another topmost window, a
/// full-screen app, or an app calling `SetForegroundWindow` can end up above
/// ours. Re-inserting at `HWND_TOPMOST` with `SWP_NOACTIVATE` (so we never steal
/// focus) and no move/resize restores the island to the front without disturbing
/// the user's active window. Cheap enough to call on every foreground change and
/// once per watcher tick; a no-op (no flicker) when we are already on top.
pub fn raise_topmost<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    unsafe {
        if let Some(hwnd) = hwnd_of(window) {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Raw handle of the island window, stashed so the (context-free) WinEvent hook
/// callback can address it. `0` until the guard is installed.
#[cfg(windows)]
static ISLAND_HWND: AtomicIsize = AtomicIsize::new(0);
/// Ensures the foreground hook is installed at most once for the app lifetime.
#[cfg(windows)]
static TOPMOST_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

/// WinEvent callback fired whenever *another* window becomes the foreground
/// window — precisely the moment something might occlude the island. Re-asserts
/// topmost instantly so the pill pops back before it can be visibly covered.
/// Event-driven, so there is no idle polling cost.
#[cfg(windows)]
unsafe extern "system" fn foreground_event_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    let raw = ISLAND_HWND.load(Ordering::Relaxed);
    if raw != 0 {
        let _ = SetWindowPos(
            HWND(raw as _),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Install a system-wide foreground hook that keeps the island reliably above
/// other windows. Idempotent (installs once). **Must be called on the main (UI)
/// thread**: `WINEVENT_OUTOFCONTEXT` callbacks are delivered through that
/// thread's message loop (tao's event loop), and the hook is bound to the
/// installing thread.
pub fn install_topmost_guard<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    unsafe {
        if let Some(hwnd) = hwnd_of(window) {
            ISLAND_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
        }
        if TOPMOST_HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        // Hook foreground changes across all processes (idprocess/idthread = 0).
        // The callback is a single atomic load + `SetWindowPos`, and foreground
        // changes are user-driven and infrequent, so idle cost stays at zero.
        // `WINEVENT_SKIPOWNPROCESS` avoids reacting to our own windows.
        let _hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        // The hook handle is intentionally leaked: it lives for the whole app.
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Clip the window to a rounded rectangle. Everything outside becomes
/// click-through and the Acrylic backdrop is shaped into the pill.
pub fn apply_region<R: Runtime>(window: &WebviewWindow<R>, r: Region) {
    #[cfg(windows)]
    unsafe {
        if let Some(hwnd) = hwnd_of(window) {
            // CreateRoundRectRgn uses the *diameter* of the corner ellipse.
            let dia = (r.radius.max(0) * 2).max(1);
            let rgn = CreateRoundRectRgn(r.x, r.y, r.x + r.w, r.y + r.h, dia, dia);
            // SetWindowRgn takes ownership of the region handle.
            SetWindowRgn(hwnd, Some(rgn), true);
        }
    }
    #[cfg(not(windows))]
    let _ = (window, r);

    if let Some(state) = window.try_state::<RegionState>() {
        *state.last.lock().unwrap() = Some(r);
    }
}
/// Re-assert the pill region if Windows has silently dropped or changed it.
///
/// `SetWindowRgn` can be cleared out from under us by tao/WebView2's asynchronous
/// initialization (the same late init that resets our extended window styles) and
/// by some system events (DPI / display / session-lock changes). When that
/// happens the window is no longer clipped to the pill, so the *entire* opaque
/// Acrylic rectangle becomes visible: an always-on-top grey block covering the
/// desktop. This heals that: it compares the live window region against the last
/// shape the frontend asked for and re-applies it *only when they differ*. The
/// cheap equality check means it never fights an in-flight morph (where the live
/// region already matches `last`) and adds no flicker.
pub fn ensure_region<R: Runtime>(window: &WebviewWindow<R>) {
    let last = match window.try_state::<RegionState>() {
        Some(state) => *state.last.lock().unwrap(),
        None => None,
    };
    let Some(r) = last else {
        return;
    };
    #[cfg(windows)]
    unsafe {
        if let Some(hwnd) = hwnd_of(window) {
            let mut box_rc = RECT::default();
            // Returns RGN_ERROR (0) when the window has *no* region set.
            let kind = GetWindowRgnBox(hwnd, &mut box_rc);
            let intact = kind.0 != 0
                && box_rc.left == r.x
                && box_rc.top == r.y
                && box_rc.right == r.x + r.w
                && box_rc.bottom == r.y + r.h;
            if !intact {
                apply_region(window, r);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = r;
}

/// After the window is first shown, tao/WebView2 keeps initializing for a short
/// while and can clear our region a beat later. Re-assert it at a brisk cadence
/// for ~2s so any such clear is corrected within ~100ms (imperceptible) instead
/// of waiting up to a full second for the monitor watcher. The burst is bounded
/// and self-terminating, so there is zero ongoing cost once the WebView settles.
fn spawn_region_settle<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Some(win) = app.get_webview_window("main") {
                ensure_region(&win);
                // The same late init can also shuffle Z-order; keep us on top.
                raise_topmost(&win);
            }
        }
    });
}
/// sits on (falling back to the primary monitor). Returns the physical top-left
/// so callers can log / react if needed.
pub fn center_top<R: Runtime>(window: &WebviewWindow<R>) {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return;
    };

    let m_pos = monitor.position();
    let m_size = monitor.size();
    let scale = monitor.scale_factor();

    let win_size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };

    let x = m_pos.x + ((m_size.width as i32 - win_size.width as i32) / 2);
    let y = m_pos.y + (TOP_MARGIN * scale).round() as i32;

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

// ---------------------------------------------------------------------------
// Tauri commands invoked from the frontend
// ---------------------------------------------------------------------------

/// Update the visible pill / panel shape. Coordinates are physical pixels
/// relative to the window's top-left. Called on mount and during morphs.
#[tauri::command]
pub fn set_island_region<R: Runtime>(window: WebviewWindow<R>, region: Region) {
    apply_region(&window, region);
}

/// Re-center the island (e.g. after the user drags it to another monitor, or on
/// a DPI change reported by the frontend).
#[tauri::command]
pub fn recenter<R: Runtime>(window: WebviewWindow<R>) {
    center_top(&window);
    if let Some(state) = window.try_state::<RegionState>() {
        if let Some(r) = *state.last.lock().unwrap() {
            apply_region(&window, r);
        }
    }
}

/// Show the window once the frontend has painted and reported its first region,
/// avoiding a flash of an unpositioned / unshaped window at startup.
///
/// We re-assert the tool-window ex-styles here: Tauri/tao finishes initializing
/// the WebView asynchronously *after* `setup()`, and that can reset the extended
/// window styles we applied earlier. Re-applying them at reveal time (once the
/// WebView has painted) makes `WS_EX_NOACTIVATE` (don't steal focus) and
/// `WS_EX_TOOLWINDOW` (stay out of Alt-Tab / taskbar) stick reliably.
#[tauri::command]
pub fn reveal_island<R: Runtime>(window: WebviewWindow<R>) {
    make_tool_window(&window);
    center_top(&window);
    let _ = window.show();
    // Assert topmost right after showing so nothing that was created while we
    // were hidden ends up above us.
    raise_topmost(&window);
    // Guard against the region being cleared by tao/WebView2's late init right
    // after the window becomes visible (which would flash the full grey box).
    ensure_region(&window);
    spawn_region_settle(&window);
}

/// Helper used by `RECT`-based comparisons in tests / future hit logic.
#[cfg(windows)]
#[allow(dead_code)]
fn rect(r: Region) -> RECT {
    RECT {
        left: r.x,
        top: r.y,
        right: r.x + r.w,
        bottom: r.y + r.h,
    }
}
