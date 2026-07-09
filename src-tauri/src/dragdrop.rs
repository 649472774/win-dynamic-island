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
//! cursor is over during a drag routes to us). Crucially, neither `SetWindowRgn`
//! (our click-through region clip) nor per-pixel alpha affect OLE drag-drop
//! hit-testing — the OS delivers DragEnter/Over/Drop across the window's whole
//! rectangle. That actually turns the entire top-center overlay rect into a big,
//! easy catch zone.
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

#[cfg(windows)]
mod imp {
    use tauri::{AppHandle, Emitter, Manager};

    use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
    use windows::Win32::System::Com::{
        IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
    };
    use windows::Win32::System::Ole::{
        OleInitialize, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT,
        DROPEFFECT_COPY, IDropTarget, IDropTarget_Impl,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;
    use windows_core::{implement, BOOL, Ref, Result as WinResult};

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
        let _ = OleInitialize(None);

        let target: IDropTarget = DropCatcher { app: app.clone() }.into();
        let _ = RevokeDragDrop(top);
        let _ = RegisterDragDrop(top, &target);

        let mut kids: Vec<isize> = Vec::new();
        let _ = EnumChildWindows(
            Some(top),
            Some(collect_child),
            LPARAM(&mut kids as *mut _ as isize),
        );
        for k in kids {
            let h = HWND(k as _);
            let _ = RevokeDragDrop(h);
            let _ = RegisterDragDrop(h, &target);
        }
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
        unsafe { register_pass(app, HWND(top as _)) };

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
                });
            }
        });
    }
}
