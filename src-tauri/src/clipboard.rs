//! Windows clipboard helpers for the file shelf's reliable "copy out" path.
//!
//! WebView (and the Tauri clipboard plugin) can put text / HTML / images on the
//! clipboard but *not* a file list (`CF_HDROP`). Yoink's core "get it back out"
//! gesture is dragging stashed files onto Explorer; the reliable Windows
//! equivalent is putting the real files on the clipboard as `CF_HDROP` so the
//! user can paste them straight into a folder (a true file copy). We also copy
//! plain text (`CF_UNICODETEXT`) for stashed snippets, and read both back so the
//! shelf's "从剪贴板添加" can pull files or text off the clipboard.

/// Files + text read off the clipboard (either may be empty).
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardData {
    pub files: Vec<String>,
    pub text: String,
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, POINT};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
    use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// RAII guard so `CloseClipboard` always runs, even on early returns.
    struct ClipGuard;
    impl Drop for ClipGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    unsafe fn open_clipboard() -> Result<ClipGuard, String> {
        // The clipboard is a shared global resource; another app may hold it for
        // a moment. Retry briefly before giving up.
        for _ in 0..5 {
            if OpenClipboard(None).is_ok() {
                return Ok(ClipGuard);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Err("无法打开剪贴板".into())
    }

    /// Allocate a moveable global block and fill it via `writer`, returning the
    /// handle (ownership is intended to transfer to the clipboard).
    unsafe fn alloc_global(bytes: usize, writer: impl FnOnce(*mut u8)) -> Result<HANDLE, String> {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hmem) as *mut u8;
        if ptr.is_null() {
            return Err("GlobalLock 失败".into());
        }
        writer(ptr);
        let _ = GlobalUnlock(hmem);
        Ok(HANDLE(hmem.0))
    }

    /// Put a file list on the clipboard as `CF_HDROP` (paste-able into Explorer).
    pub unsafe fn copy_files(paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Err("没有可复制的文件".into());
        }
        // Double-null-terminated wide list of paths after a DROPFILES header.
        let mut list: Vec<u16> = Vec::new();
        for p in paths {
            list.extend(to_wide(p));
            list.push(0);
        }
        list.push(0); // final terminator for the whole list

        let header = std::mem::size_of::<DROPFILES>();
        let bytes = header + list.len() * 2;
        let handle = alloc_global(bytes, |ptr| {
            let df = ptr as *mut DROPFILES;
            (*df).pFiles = header as u32;
            (*df).pt = POINT { x: 0, y: 0 };
            (*df).fNC = false.into();
            (*df).fWide = true.into();
            let dst = ptr.add(header) as *mut u16;
            std::ptr::copy_nonoverlapping(list.as_ptr(), dst, list.len());
        })?;

        let _guard = open_clipboard()?;
        EmptyClipboard().map_err(|e| e.to_string())?;
        // On success the clipboard owns the memory; do not free it.
        SetClipboardData(CF_HDROP.0 as u32, Some(handle)).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Put plain text on the clipboard as `CF_UNICODETEXT`.
    pub unsafe fn copy_text(text: &str) -> Result<(), String> {
        let mut buf = to_wide(text);
        buf.push(0);
        let bytes = buf.len() * 2;
        let handle = alloc_global(bytes, |ptr| {
            std::ptr::copy_nonoverlapping(buf.as_ptr(), ptr as *mut u16, buf.len());
        })?;

        let _guard = open_clipboard()?;
        EmptyClipboard().map_err(|e| e.to_string())?;
        SetClipboardData(CF_UNICODETEXT.0 as u32, Some(handle)).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Read a file list and/or plain text off the clipboard.
    pub unsafe fn read() -> (Vec<String>, String) {
        let mut files = Vec::new();
        let mut text = String::new();
        let Ok(_guard) = open_clipboard() else {
            return (files, text);
        };

        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
            if let Ok(h) = GetClipboardData(CF_HDROP.0 as u32) {
                let hdrop = HDROP(h.0);
                let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
                for i in 0..count {
                    let len = DragQueryFileW(hdrop, i, None) as usize;
                    if len == 0 {
                        continue;
                    }
                    let mut b = vec![0u16; len + 1];
                    let got = DragQueryFileW(hdrop, i, Some(&mut b)) as usize;
                    if got > 0 {
                        files.push(String::from_utf16_lossy(&b[..got]));
                    }
                }
            }
        }

        if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_ok() {
            if let Ok(h) = GetClipboardData(CF_UNICODETEXT.0 as u32) {
                let hmem = HGLOBAL(h.0);
                let ptr = GlobalLock(hmem) as *const u16;
                if !ptr.is_null() {
                    let mut len = 0usize;
                    while *ptr.add(len) != 0 {
                        len += 1;
                    }
                    text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                    let _ = GlobalUnlock(hmem);
                }
            }
        }

        (files, text)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Copy a list of files to the clipboard as `CF_HDROP` (paste into Explorer to
/// drop the real files there).
#[tauri::command]
pub fn clipboard_copy_files(paths: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        imp::copy_files(&paths)
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Err("仅支持 Windows".into())
    }
}

/// Copy plain text to the clipboard as `CF_UNICODETEXT`.
#[tauri::command]
pub fn clipboard_copy_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        imp::copy_text(&text)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("仅支持 Windows".into())
    }
}

/// Read files and/or text off the clipboard (used by "从剪贴板添加").
#[tauri::command]
pub fn clipboard_read() -> ClipboardData {
    #[cfg(windows)]
    unsafe {
        let (files, text) = imp::read();
        ClipboardData { files, text }
    }
    #[cfg(not(windows))]
    {
        ClipboardData::default()
    }
}
