//! Native OLE drop target (M4f — the real "drag a file onto the island" fix).
//!
//! ## Why this exists
//! Our island window is `transparent: true`, which on Windows makes it a
//! `WS_EX_LAYERED` (per-pixel alpha) window. wry/WebView2 does **not** deliver
//! its built-in file-drop events (`onDragDropEvent` / `tauri://drag-drop`) to
//! layered windows — a long-standing OS/wry limitation (tauri-apps/wry#383). So
//! the previous `useShelfDrag` webview listener could never fire, and dragging a
//! file toward the pill did nothing.
//!
//! ## The fix
//! We register our **own** `IDropTarget` via `RegisterDragDrop` directly on the
//! window's HWND (and, best-effort, every descendant HWND so whichever one the
//! cursor is over during a drag routes to us). Per-pixel alpha does not affect
//! OLE drag hit-testing, so this reliably catches drops over the visible pill.
//!
//! ## The catch-zone problem (and the strip window)
//! OLE drag hit-testing uses `WindowFromPoint`, which **respects** `SetWindowRgn`
//! — and we clip the island to the pill shape for click-through. So the island's
//! own drop zone is only the tiny collapsed pill, which is very hard to hit. To
//! give drags a big, forgiving target we add a separate top-center **strip
//! window** (`ensure_catcher`) that carries the *same* `IDropTarget` but is **not**
//! region-clipped: layered @ alpha=1 (invisible), click-through via
//! `WM_NCHITTEST -> HTTRANSPARENT` (never eats a click or makes a dead zone, yet
//! `WindowFromPoint` still finds it so OLE drags land on it), topmost + tool-window
//! + no-activate. Result: file drag-in is caught across the whole top-center strip
//! (island width × ~220px), while clicks and hover still pass through to the pill.
//!
//! On DragEnter/Over we report `DROPEFFECT_COPY` and emit `shelf-drag-enter`
//! (the frontend force-expands into a large drop panel); on Drop we pull the
//! `CF_HDROP` file list out of the `IDataObject` and emit `shelf-drop` with the
//! paths; DragLeave/after-Drop emit `shelf-drag-leave` so the island lingers then
//! collapses. All of this runs on the main UI thread (where `RegisterDragDrop`
//! requires an OLE-initialized message-pumping thread), so the callbacks are
//! delivered by tao's event loop — zero idle cost.

use tauri::AppHandle;

/// Register the native drop target on the main window. Safe no-op off Windows.
/// Must be called from the main (UI) thread during setup.
pub fn install(app: &AppHandle) {
    #[cfg(windows)]
    imp::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Re-align the invisible drop-catcher strip to the island (call after the
/// island re-centers on a monitor / DPI change). Safe no-op off Windows.
pub fn reposition(app: &AppHandle) {
    #[cfg(windows)]
    imp::reposition(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Re-arm the native drop target: re-register the `IDropTarget` on the current
/// top-level window and all of its (possibly newly recreated) descendant HWNDs,
/// and make sure the invisible catch strip exists and is aligned.
///
/// Call this from the frontend once on every (re)load. A webview reload — e.g. a
/// Vite HMR *full* reload, which is triggered whenever `shelf.tsx` changes
/// because `useShelfDrag` is a non-component export — can recreate WebView2's
/// child render HWND and orphan the OLE registration that only ran during the
/// startup burst. `WindowFromPoint` then returns that fresh, unregistered child
/// for drops over the panel body, so drag-in silently stops working below the
/// top catch strip. Re-arming on mount re-registers the current child. Safe
/// no-op off Windows.
pub fn rearm(app: &AppHandle) {
    #[cfg(windows)]
    imp::rearm(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Frontend-invokable version of [`rearm`]. The UI calls this once on mount so
/// drag-in survives webview reloads.
#[tauri::command]
pub fn rearm_drop_target(app: AppHandle) {
    rearm(&app);
}

#[cfg(windows)]
mod imp {
    use tauri::{AppHandle, Emitter, Manager};

    use std::sync::atomic::{AtomicIsize, Ordering};

    use windows::Win32::Foundation::{
        COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINTL, RECT, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH, HBRUSH};
    use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Ole::{
        IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium,
        RevokeDragDrop, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{
        DefSubclassProc, DragQueryFileW, RemoveWindowSubclass, SetWindowSubclass, HDROP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, EnumChildWindows, GetWindowRect, RegisterClassW,
        SetLayeredWindowAttributes, SetWindowPos, ShowWindow, HTTRANSPARENT, HWND_TOPMOST,
        LWA_ALPHA, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WM_NCDESTROY, WM_NCHITTEST,
        WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };
    use windows_core::{implement, Ref, Result as WinResult, BOOL, PCWSTR};

    /// COM object receiving the OS drag-drop callbacks. Holds an `AppHandle` so
    /// it can forward the gesture to the frontend as Tauri events.
    #[implement(IDropTarget)]
    struct DropCatcher {
        app: AppHandle,
    }

    impl IDropTarget_Impl for DropCatcher_Impl {
        fn DragEnter(
            &self,
            _data: Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> WinResult<()> {
            unsafe {
                if !effect.is_null() {
                    *effect = DROPEFFECT_COPY;
                }
            }
            // Force the island open into a big drop panel while a drag hovers.
            let _ = self.app.emit("shelf-drag-enter", ());
            Ok(())
        }

        fn DragOver(
            &self,
            _keys: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> WinResult<()> {
            unsafe {
                if !effect.is_null() {
                    *effect = DROPEFFECT_COPY;
                }
            }
            Ok(())
        }

        fn DragLeave(&self) -> WinResult<()> {
            let _ = self.app.emit("shelf-drag-leave", ());
            Ok(())
        }

        fn Drop(
            &self,
            data: Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> WinResult<()> {
            unsafe {
                if !effect.is_null() {
                    *effect = DROPEFFECT_COPY;
                }
            }
            let paths = match data.ok() {
                Ok(obj) => unsafe { extract_paths(obj) },
                Err(_) => Vec::new(),
            };
            if !paths.is_empty() {
                let _ = self.app.emit("shelf-drop", paths);
            }
            // Release the transient drag state (frontend lingers, then collapses).
            let _ = self.app.emit("shelf-drag-leave", ());
            Ok(())
        }
    }

    const DROP_TARGET_SUBCLASS_ID: usize = 0x4449_4454;

    unsafe extern "system" fn drop_target_subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        subclass_id: usize,
        _ref_data: usize,
    ) -> LRESULT {
        if msg == WM_NCDESTROY {
            let _ = RevokeDragDrop(hwnd);
            let _ = RemoveWindowSubclass(hwnd, Some(drop_target_subclass_proc), subclass_id);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    unsafe fn register_target(hwnd: HWND, target: &IDropTarget) {
        let _ = RevokeDragDrop(hwnd);
        if RegisterDragDrop(hwnd, target).is_ok() {
            let _ = SetWindowSubclass(
                hwnd,
                Some(drop_target_subclass_proc),
                DROP_TARGET_SUBCLASS_ID,
                0,
            );
        }
    }

    /// Pull the dropped file list (`CF_HDROP`) out of the drag data object.
    unsafe fn extract_paths(obj: &IDataObject) -> Vec<String> {
        let fmt = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut out = Vec::new();
        if let Ok(mut medium) = obj.GetData(&fmt) {
            let hdrop = HDROP(medium.u.hGlobal.0);
            // First call with 0xFFFFFFFF returns the file count.
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; len + 1];
                let got = DragQueryFileW(hdrop, i, Some(&mut buf)) as usize;
                if got > 0 {
                    out.push(String::from_utf16_lossy(&buf[..got]));
                }
            }
            ReleaseStgMedium(&mut medium);
        }
        out
    }

    /// `EnumChildWindows` trampoline: collect descendant HWNDs into a `Vec<isize>`
    /// passed through `lparam`.
    unsafe extern "system" fn collect_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let vec = &mut *(lparam.0 as *mut Vec<isize>);
        vec.push(hwnd.0 as isize);
        BOOL(1) // keep enumerating
    }

    /// One registration pass: (re)register a fresh `IDropTarget` on the top-level
    /// window and every descendant. `RegisterDragDrop` fails if a target is
    /// already registered, so we `RevokeDragDrop` first (best-effort). WebView2
    /// may own some child HWNDs; registering there is best-effort and errors are
    /// ignored — the top-level registration is the reliable catch-all.
    unsafe fn register_pass(app: &AppHandle, top: HWND) {
        // Idempotent: returns S_FALSE if the thread is already OLE-initialized.
        // RPC_E_CHANGED_MODE (0x80010106) means the thread is MTA, not STA —
        // RegisterDragDrop then fails, which would explain "drag-in never works".
        let _ = OleInitialize(None);

        let target: IDropTarget = DropCatcher { app: app.clone() }.into();
        register_target(top, &target);

        let mut kids: Vec<isize> = Vec::new();
        let _ = EnumChildWindows(
            Some(top),
            Some(collect_child),
            LPARAM(&mut kids as *mut _ as isize),
        );
        for k in &kids {
            let h = HWND(*k as _);
            register_target(h, &target);
        }
    }

    // ---- Dedicated invisible drop-catcher window ---------------------------
    //
    // The island window is region-clipped to the pill (`SetWindowRgn`), and OLE
    // drag hit-testing uses `WindowFromPoint`, which *respects* that clip — so the
    // island by itself only catches drops on the tiny visible pill. To give drags
    // a big, forgiving target we add a separate top-center strip window that is:
    //   * NOT region-clipped (its whole rect catches drops),
    //   * layered @ alpha=1 (present for hit-testing, invisible to the eye),
    //   * click-through via `WM_NCHITTEST -> HTTRANSPARENT` (never eats a click or
    //     makes a dead zone; `WindowFromPoint` still returns it, so OLE drags are
    //     delivered to its `IDropTarget`),
    //   * topmost + tool-window + no-activate (out of Alt-Tab/taskbar, no focus).
    // Both windows carry the same `IDropTarget`, so their z-order never matters.
    static CATCHER: AtomicIsize = AtomicIsize::new(0);
    /// Height (physical px) of the top-center catch strip.
    const STRIP_H: i32 = 220;

    unsafe extern "system" fn catcher_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_NCHITTEST {
            // Pass every click through to whatever is underneath (the pill, or
            // the app behind us) while staying a valid OLE drop target.
            return LRESULT(HTTRANSPARENT as isize);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Align the catch strip across the top-center of the island's monitor,
    /// horizontally matching the island window.
    unsafe fn position_over_island(catcher: HWND, island: HWND) {
        let mut r = RECT::default();
        if GetWindowRect(island, &mut r).is_ok() {
            let w = (r.right - r.left).max(200);
            let _ = SetWindowPos(
                catcher,
                Some(HWND_TOPMOST),
                r.left,
                0,
                w,
                STRIP_H,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    /// Create (once) the invisible click-through drop-catcher window and register
    /// our `IDropTarget` on it. Idempotent — a no-op once created.
    unsafe fn ensure_catcher(app: &AppHandle, island: HWND) {
        if CATCHER.load(Ordering::Relaxed) != 0 {
            return;
        }
        let hinstance: HINSTANCE = match GetModuleHandleW(PCWSTR::null()) {
            Ok(h) => HINSTANCE(h.0),
            Err(_) => return,
        };
        // Null-terminated wide class name; kept alive for both calls below.
        let class: Vec<u16> = "DI_DropCatcher\0".encode_utf16().collect();
        let class_name = PCWSTR(class.as_ptr());
        let wc = WNDCLASSW {
            lpfnWndProc: Some(catcher_wndproc),
            hInstance: hinstance,
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            lpszClassName: class_name,
            ..Default::default()
        };
        // "Class already exists" is harmless on a repeated install pass.
        let _ = RegisterClassW(&wc);

        let created = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            class_name,
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            10,
            10,
            None,
            None,
            Some(hinstance),
            None,
        );
        let catcher = match created {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[dragdrop] CreateWindowExW(catcher) failed: {:?}", e);
                return;
            }
        };
        // alpha = 1/255: visually imperceptible but a real hit-test target.
        let _ = SetLayeredWindowAttributes(catcher, COLORREF(0), 1, LWA_ALPHA);
        let _ = ShowWindow(catcher, SW_SHOWNOACTIVATE);
        position_over_island(catcher, island);

        let target: IDropTarget = DropCatcher { app: app.clone() }.into();
        register_target(catcher, &target);
        CATCHER.store(catcher.0 as isize, Ordering::Relaxed);
    }

    /// Re-align the catch strip after a monitor / DPI / primary-display change.
    /// Scheduled onto the main (UI) thread that owns the window.
    pub fn reposition(app: &AppHandle) {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            let c = CATCHER.load(Ordering::Relaxed);
            if c == 0 {
                return;
            }
            if let Some(win) = a.get_webview_window("main") {
                if let Ok(h) = win.hwnd() {
                    position_over_island(HWND(c as _), HWND(h.0 as _));
                }
            }
        });
    }

    /// Re-register the drop target on the current top-level + descendant HWNDs
    /// and realign the catch strip. Runs on the main (UI) thread. See the public
    /// [`super::rearm`] doc for why this is needed after webview reloads.
    pub fn rearm(app: &AppHandle) {
        let handle = app.clone();
        let inner = app.clone();
        let _ = handle.run_on_main_thread(move || unsafe {
            if let Some(win) = inner.get_webview_window("main") {
                if let Ok(h) = win.hwnd() {
                    let top = HWND(h.0 as _);
                    register_pass(&inner, top);
                    ensure_catcher(&inner, top);
                    let c = CATCHER.load(Ordering::Relaxed);
                    if c != 0 {
                        position_over_island(HWND(c as _), top);
                    }
                }
            }
        });
    }

    pub fn install(app: &AppHandle) {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let Ok(handle) = win.hwnd() else {
            return;
        };
        let top = handle.0 as isize;

        // Immediate pass — we are on the main thread during setup, and the
        // top-level HWND already exists.
        unsafe {
            register_pass(app, HWND(top as _));
            ensure_catcher(app, HWND(top as _));
        }

        // WebView2 finishes initializing asynchronously *after* setup and can
        // create/reset child HWNDs. Re-run a few passes on the main thread so
        // whichever HWND ends up under the cursor during a drag is covered. The
        // burst is bounded and self-terminating (zero ongoing cost).
        let app = app.clone();
        std::thread::spawn(move || {
            for ms in [300u64, 800, 1500, 2500] {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                let app_inner = app.clone();
                let _ = app.run_on_main_thread(move || unsafe {
                    register_pass(&app_inner, HWND(top as _));
                    // Idempotent; also realigns the strip after any late centering.
                    ensure_catcher(&app_inner, HWND(top as _));
                });
            }
        });
    }
}
