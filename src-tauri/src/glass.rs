use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

use crate::window::{Region, RegionState};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GlassIntensity {
    Subtle,
    #[default]
    Balanced,
    Vivid,
}

impl GlassIntensity {
    fn code(self) -> u8 {
        match self {
            Self::Subtle => 0,
            Self::Balanced => 1,
            Self::Vivid => 2,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Subtle,
            2 => Self::Vivid,
            _ => Self::Balanced,
        }
    }

    fn tint_alpha(self) -> u8 {
        match self {
            Self::Subtle => 132,
            Self::Balanced => 104,
            Self::Vivid => 72,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassStatus {
    pub requested: bool,
    pub active: bool,
    pub supported: bool,
    pub renderer: String,
    pub fallback_reason: Option<String>,
    pub intensity: GlassIntensity,
}

impl GlassStatus {
    fn disabled() -> Self {
        Self {
            requested: false,
            active: false,
            supported: cfg!(windows),
            renderer: "css".into(),
            fallback_reason: None,
            intensity: current_intensity(),
        }
    }

    fn initializing() -> Self {
        Self {
            requested: true,
            active: false,
            supported: true,
            renderer: "css".into(),
            fallback_reason: Some("正在初始化原生毛玻璃".into()),
            intensity: current_intensity(),
        }
    }

    fn waiting_for_geometry() -> Self {
        Self {
            requested: true,
            active: false,
            supported: true,
            renderer: "css".into(),
            fallback_reason: Some("等待灵动岛完成首帧布局".into()),
            intensity: current_intensity(),
        }
    }

    fn waiting_for_reveal() -> Self {
        Self {
            requested: true,
            active: false,
            supported: true,
            renderer: "css".into(),
            fallback_reason: Some("等待灵动岛主窗口完成首帧显示".into()),
            intensity: current_intensity(),
        }
    }

    fn active() -> Self {
        Self {
            requested: true,
            active: true,
            supported: true,
            renderer: "windows-host-backdrop".into(),
            fallback_reason: None,
            intensity: current_intensity(),
        }
    }

    fn fallback(supported: bool, reason: impl Into<String>) -> Self {
        Self {
            requested: true,
            active: false,
            supported,
            renderer: "css".into(),
            fallback_reason: Some(reason.into()),
            intensity: current_intensity(),
        }
    }
}

pub struct GlassState {
    status: Mutex<GlassStatus>,
}

impl Default for GlassState {
    fn default() -> Self {
        Self {
            status: Mutex::new(GlassStatus::disabled()),
        }
    }
}

impl GlassState {
    fn get(&self) -> GlassStatus {
        self.status
            .lock()
            .expect("glass status mutex poisoned")
            .clone()
    }

    fn set(&self, status: GlassStatus) -> bool {
        let mut current = self.status.lock().expect("glass status mutex poisoned");
        if *current == status {
            return false;
        }
        *current = status;
        true
    }
}

static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();
static REQUESTED: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static INIT_FAILED: AtomicBool = AtomicBool::new(false);
static MAIN_REVEALED: AtomicBool = AtomicBool::new(false);
static UNDERLAY_HWND: AtomicIsize = AtomicIsize::new(0);
static INTENSITY: AtomicU8 = AtomicU8::new(GlassIntensity::Balanced as u8);

fn current_intensity() -> GlassIntensity {
    GlassIntensity::from_code(INTENSITY.load(Ordering::Relaxed))
}

pub fn register_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn on_main_thread() -> bool {
    MAIN_THREAD
        .get()
        .is_some_and(|id| *id == std::thread::current().id())
}

fn publish<R: Runtime>(app: &AppHandle<R>, status: GlassStatus) -> GlassStatus {
    if let Some(state) = app.try_state::<GlassState>() {
        if state.set(status.clone()) {
            if let Err(error) = app.emit("glass-status-changed", status.clone()) {
                eprintln!("[glass] failed to emit status update: {error}");
            }
        }
    }
    status
}

#[tauri::command]
pub fn get_glass_status(state: State<'_, GlassState>) -> GlassStatus {
    state.get()
}

#[tauri::command]
pub async fn set_glass_enabled(
    app: AppHandle,
    enabled: bool,
    intensity: GlassIntensity,
) -> GlassStatus {
    INTENSITY.store(intensity.code(), Ordering::SeqCst);
    REQUESTED.store(enabled, Ordering::SeqCst);
    INIT_FAILED.store(false, Ordering::SeqCst);

    if !enabled {
        ACTIVE.store(false, Ordering::SeqCst);
    }

    let pending = if enabled {
        GlassStatus::initializing()
    } else {
        GlassStatus::disabled()
    };
    publish(&app, pending);

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let app_for_main = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let status = set_enabled_on_main(&app_for_main, enabled);
        publish(&app_for_main, status.clone());
        let _ = sender.send(status);
    }) {
        let status = GlassStatus::fallback(false, format!("无法切换到 Windows UI 线程：{error}"));
        INIT_FAILED.store(true, Ordering::SeqCst);
        return publish(&app, status);
    }

    match tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(5))
    })
    .await
    {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let status = GlassStatus::fallback(false, format!("原生毛玻璃初始化超时：{error}"));
            INIT_FAILED.store(true, Ordering::SeqCst);
            publish(&app, status)
        }
        Err(error) => {
            let status = GlassStatus::fallback(false, format!("原生毛玻璃任务失败：{error}"));
            INIT_FAILED.store(true, Ordering::SeqCst);
            publish(&app, status)
        }
    }
}

fn set_enabled_on_main<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> GlassStatus {
    #[cfg(windows)]
    {
        if enabled {
            return imp::enable(app, current_region(app));
        }
        imp::disable();
        GlassStatus::disabled()
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        if enabled {
            GlassStatus::fallback(false, "真实毛玻璃仅支持 Windows 11")
        } else {
            GlassStatus::disabled()
        }
    }
}

fn current_region<R: Runtime>(app: &AppHandle<R>) -> Option<Region> {
    let window = app.get_webview_window("main")?;
    let state = window.try_state::<RegionState>()?;
    let region = *state.last.lock().expect("region mutex poisoned");
    region
}

pub fn sync_region<R: Runtime>(window: &WebviewWindow<R>, region: Region) {
    if !REQUESTED.load(Ordering::Relaxed) || INIT_FAILED.load(Ordering::Relaxed) {
        return;
    }
    #[cfg(windows)]
    {
        let app = window.app_handle().clone();
        if on_main_thread() {
            let status = imp::update_region_or_enable(&app, region);
            publish(&app, status);
            return;
        }
        let app_for_main = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let status = imp::update_region_or_enable(&app_for_main, region);
            publish(&app_for_main, status);
        }) {
            let status = GlassStatus::fallback(false, format!("无法同步毛玻璃形状：{error}"));
            INIT_FAILED.store(true, Ordering::SeqCst);
            publish(&app, status);
        }
    }
    #[cfg(not(windows))]
    let _ = (window, region);
}

pub fn sync_window<R: Runtime>(window: &WebviewWindow<R>) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    #[cfg(windows)]
    {
        let app = window.app_handle().clone();
        if on_main_thread() {
            if let Err(error) = imp::sync_window(window) {
                imp::fail(&app, error);
            }
            return;
        }
        let app_for_main = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Some(window) = app_for_main.get_webview_window("main") {
                if let Err(error) = imp::sync_window(&window) {
                    imp::fail(&app_for_main, error);
                }
            }
        }) {
            imp::fail(&app, format!("无法同步毛玻璃窗口：{error}"));
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

pub fn reconcile<R: Runtime>(window: &WebviewWindow<R>) {
    if !REQUESTED.load(Ordering::Relaxed) || INIT_FAILED.load(Ordering::Relaxed) {
        return;
    }
    #[cfg(windows)]
    {
        let app = window.app_handle().clone();
        let app_for_main = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let status = imp::enable(&app_for_main, current_region(&app_for_main));
            publish(&app_for_main, status);
        }) {
            imp::fail(&app, format!("无法恢复毛玻璃窗口：{error}"));
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

pub fn reveal<R: Runtime>(window: &WebviewWindow<R>) {
    MAIN_REVEALED.store(true, Ordering::SeqCst);
    if !REQUESTED.load(Ordering::Relaxed) || INIT_FAILED.load(Ordering::Relaxed) {
        return;
    }
    #[cfg(windows)]
    {
        let app = window.app_handle().clone();
        if on_main_thread() {
            let status = imp::enable(&app, current_region(&app));
            publish(&app, status);
        } else {
            let app_for_main = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let status = imp::enable(&app_for_main, current_region(&app_for_main));
                publish(&app_for_main, status);
            }) {
                imp::fail(&app, format!("无法显示毛玻璃窗口：{error}"));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    REQUESTED.store(false, Ordering::SeqCst);
    ACTIVE.store(false, Ordering::SeqCst);
    MAIN_REVEALED.store(false, Ordering::SeqCst);
    #[cfg(windows)]
    {
        if on_main_thread() {
            imp::shutdown();
            return;
        }
        let _ = app.run_on_main_thread(imp::shutdown);
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
pub fn pair_under_main_raw(main: windows::Win32::Foundation::HWND) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let underlay = UNDERLAY_HWND.load(Ordering::Relaxed);
    if underlay != 0 {
        unsafe {
            let _ =
                imp::align_under_main(windows::Win32::Foundation::HWND(underlay as _), main, true);
        }
    }
}

#[cfg(not(windows))]
pub fn pair_under_main_raw(_main: ()) {}

#[cfg(windows)]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::mem::size_of;
    use std::sync::atomic::Ordering;

    use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
    use windows::Foundation::{IPropertyValue, PropertyValue};
    use windows::Graphics::Effects::{
        IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectSource_Impl, IGraphicsEffect_Impl,
    };
    use windows::System::DispatcherQueueController;
    use windows::Win32::Foundation::{
        GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
    };
    use windows::Win32::Graphics::Dwm::{
        DwmFlush, DwmSetWindowAttribute, DWMWA_USE_HOSTBACKDROPBRUSH,
    };
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
    use windows::Win32::System::WinRT::Graphics::Direct2D::{
        IGraphicsEffectD2D1Interop, IGraphicsEffectD2D1Interop_Impl,
        GRAPHICS_EFFECT_PROPERTY_MAPPING, GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT,
    };
    use windows::Win32::System::WinRT::{
        CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE,
        DQTYPE_THREAD_CURRENT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowRect, IsWindow, RegisterClassW,
        SetWindowPos, ShowWindow, HTTRANSPARENT, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
        WM_NCHITTEST, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };
    use windows::UI::Color;
    use windows::UI::Composition::Desktop::DesktopWindowTarget;
    use windows::UI::Composition::{
        CompositionBrush, CompositionColorBrush, CompositionEffectSourceParameter,
        CompositionGeometricClip, CompositionRoundedRectangleGeometry, Compositor, ContainerVisual,
        SpriteVisual,
    };
    use windows::UI::ViewManagement::{AccessibilitySettings, UISettings};
    use windows_core::{
        implement, Error, Interface, Result as WinResult, BOOL, GUID, HRESULT, HSTRING, PCWSTR,
    };
    use windows_numerics::{Vector2, Vector3};

    use super::{
        current_intensity, GlassIntensity, GlassStatus, ACTIVE, INIT_FAILED, MAIN_REVEALED,
        UNDERLAY_HWND,
    };
    use crate::window::Region;

    const CLSID_D2D1_GAUSSIAN_BLUR: GUID = GUID::from_u128(0x1FEB6D69_2FE6_4AC9_8C58_1D7F93E7A6A5);
    const EXTRA_BLUR: f32 = 5.0;

    thread_local! {
        static RUNTIME: RefCell<Option<GlassRuntime>> = const { RefCell::new(None) };
        // A thread can host only one DispatcherQueue. Keep its controller alive
        // across recoverable Composition/runtime rebuilds.
        static DISPATCHER: RefCell<Option<DispatcherQueueController>> = const { RefCell::new(None) };
    }

    #[derive(Debug)]
    struct GlassFailure {
        supported: bool,
        reason: String,
    }

    impl GlassFailure {
        fn policy(reason: impl Into<String>) -> Self {
            Self {
                supported: true,
                reason: reason.into(),
            }
        }

        fn api(step: &str, error: impl std::fmt::Display) -> Self {
            Self {
                supported: false,
                reason: format!("{step}：{error}"),
            }
        }
    }

    fn source_name() -> HSTRING {
        HSTRING::from("backdrop")
    }

    fn invalid_argument() -> Error {
        Error::from_hresult(HRESULT(0x8007_0057_u32 as i32))
    }

    #[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
    struct GaussianBlurDescription {
        radius: Cell<f32>,
        name: Cell<HSTRING>,
        source: CompositionEffectSourceParameter,
    }

    impl GaussianBlurDescription {
        fn create(radius: f32) -> WinResult<IGraphicsEffect> {
            let source = CompositionEffectSourceParameter::Create(&source_name())?;
            Ok(Self {
                radius: Cell::new(radius),
                name: Cell::new(HSTRING::new()),
                source,
            }
            .into())
        }
    }

    impl IGraphicsEffect_Impl for GaussianBlurDescription_Impl {
        fn Name(&self) -> WinResult<HSTRING> {
            let name = self.name.take();
            let result = name.clone();
            self.name.set(name);
            Ok(result)
        }

        fn SetName(&self, name: &HSTRING) -> WinResult<()> {
            self.name.set(name.clone());
            Ok(())
        }
    }

    impl IGraphicsEffectSource_Impl for GaussianBlurDescription_Impl {}

    impl IGraphicsEffectD2D1Interop_Impl for GaussianBlurDescription_Impl {
        fn GetEffectId(&self) -> WinResult<GUID> {
            Ok(CLSID_D2D1_GAUSSIAN_BLUR)
        }

        fn GetNamedPropertyMapping(
            &self,
            name: &PCWSTR,
            index: *mut u32,
            mapping: *mut GRAPHICS_EFFECT_PROPERTY_MAPPING,
        ) -> WinResult<()> {
            let name = unsafe { name.to_string().unwrap_or_default() };
            if !name.eq_ignore_ascii_case("BlurAmount") || index.is_null() || mapping.is_null() {
                return Err(invalid_argument());
            }
            unsafe {
                *index = 0;
                *mapping = GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT;
            }
            Ok(())
        }

        fn GetPropertyCount(&self) -> WinResult<u32> {
            Ok(3)
        }

        fn GetProperty(&self, index: u32) -> WinResult<IPropertyValue> {
            let value = match index {
                0 => PropertyValue::CreateSingle(self.radius.get())?,
                1 => PropertyValue::CreateUInt32(0)?,
                2 => PropertyValue::CreateUInt32(1)?,
                _ => return Err(invalid_argument()),
            };
            value.cast()
        }

        fn GetSource(&self, index: u32) -> WinResult<IGraphicsEffectSource> {
            if index != 0 {
                return Err(invalid_argument());
            }
            self.source.cast()
        }

        fn GetSourceCount(&self) -> WinResult<u32> {
            Ok(1)
        }
    }

    struct GlassRuntime {
        main_hwnd: HWND,
        hwnd: HWND,
        root: ContainerVisual,
        pill: ContainerVisual,
        geometry: CompositionRoundedRectangleGeometry,
        backdrop: SpriteVisual,
        tint: SpriteVisual,
        _clip: CompositionGeometricClip,
        _backdrop_brush: CompositionBrush,
        _tint_brush: CompositionBrush,
        tint_color_brush: CompositionColorBrush,
        target: DesktopWindowTarget,
        _compositor: Compositor,
    }

    struct CreatedWindow(Option<HWND>);

    impl Drop for CreatedWindow {
        fn drop(&mut self) {
            if let Some(hwnd) = self.0.take() {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
            }
        }
    }

    unsafe fn ensure_dispatcher() -> Result<(), GlassFailure> {
        DISPATCHER.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_some() {
                return Ok(());
            }

            let options = DispatcherQueueOptions {
                dwSize: size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_NONE,
            };
            *slot = Some(
                CreateDispatcherQueueController(options)
                    .map_err(|error| GlassFailure::api("创建 DispatcherQueue 失败", error))?,
            );
            Ok(())
        })
    }

    impl GlassRuntime {
        unsafe fn create(main_hwnd: HWND, intensity: GlassIntensity) -> Result<Self, GlassFailure> {
            let mut main_rect = RECT::default();
            GetWindowRect(main_hwnd, &mut main_rect)
                .map_err(|error| GlassFailure::api("读取主窗口位置失败", error))?;

            let module = GetModuleHandleW(PCWSTR::null())
                .map_err(|error| GlassFailure::api("读取模块句柄失败", error))?;
            let hinstance = HINSTANCE(module.0);
            let class: Vec<u16> = "DI_GlassUnderlay\0".encode_utf16().collect();
            let class_name = PCWSTR(class.as_ptr());
            let window_class = WNDCLASSW {
                lpfnWndProc: Some(underlay_wndproc),
                hInstance: hinstance,
                lpszClassName: class_name,
                ..Default::default()
            };
            let _ = RegisterClassW(&window_class);

            let width = (main_rect.right - main_rect.left).max(1);
            let height = (main_rect.bottom - main_rect.top).max(1);
            let hwnd = CreateWindowExW(
                WS_EX_NOREDIRECTIONBITMAP
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOPMOST
                    | WS_EX_TRANSPARENT,
                class_name,
                PCWSTR::null(),
                WS_POPUP,
                main_rect.left,
                main_rect.top,
                width,
                height,
                None,
                None,
                Some(hinstance),
                None,
            )
            .map_err(|error| GlassFailure::api("创建玻璃 underlay 失败", error))?;
            let mut window_guard = CreatedWindow(Some(hwnd));

            let enable = BOOL(1);
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_HOSTBACKDROPBRUSH,
                &enable as *const BOOL as *const _,
                size_of::<BOOL>() as u32,
            )
            .map_err(|error| GlassFailure::api("启用 HostBackdropBrush 失败", error))?;

            ensure_dispatcher()?;
            let compositor = Compositor::new()
                .map_err(|error| GlassFailure::api("创建 Compositor 失败", error))?;
            let interop: ICompositorDesktopInterop = compositor
                .cast()
                .map_err(|error| GlassFailure::api("获取 Desktop interop 失败", error))?;
            let target = interop
                .CreateDesktopWindowTarget(hwnd, false)
                .map_err(|error| GlassFailure::api("创建 DesktopWindowTarget 失败", error))?;

            let root = compositor
                .CreateContainerVisual()
                .map_err(|error| GlassFailure::api("创建根 Visual 失败", error))?;
            root.SetSize(Vector2 {
                X: width as f32,
                Y: height as f32,
            })
            .map_err(|error| GlassFailure::api("设置根 Visual 尺寸失败", error))?;

            let pill = compositor
                .CreateContainerVisual()
                .map_err(|error| GlassFailure::api("创建胶囊 Visual 失败", error))?;
            let geometry = compositor
                .CreateRoundedRectangleGeometry()
                .map_err(|error| GlassFailure::api("创建圆角裁剪失败", error))?;
            let clip = compositor
                .CreateGeometricClipWithGeometry(&geometry)
                .map_err(|error| GlassFailure::api("创建几何裁剪失败", error))?;
            pill.SetClip(&clip)
                .map_err(|error| GlassFailure::api("绑定圆角裁剪失败", error))?;

            let backdrop = compositor
                .CreateSpriteVisual()
                .map_err(|error| GlassFailure::api("创建背景 Visual 失败", error))?;
            let host = compositor
                .CreateHostBackdropBrush()
                .map_err(|error| GlassFailure::api("创建 HostBackdropBrush 失败", error))?;
            let host: CompositionBrush = host
                .cast()
                .map_err(|error| GlassFailure::api("转换 HostBackdropBrush 失败", error))?;
            let blur = GaussianBlurDescription::create(EXTRA_BLUR)
                .map_err(|error| GlassFailure::api("创建 Gaussian blur 描述失败", error))?;
            let blur_factory = compositor
                .CreateEffectFactory(&blur)
                .map_err(|error| GlassFailure::api("创建 Gaussian blur factory 失败", error))?;
            let blur_brush = blur_factory
                .CreateBrush()
                .map_err(|error| GlassFailure::api("创建 Gaussian blur brush 失败", error))?;
            blur_brush
                .SetSourceParameter(&source_name(), &host)
                .map_err(|error| GlassFailure::api("绑定 HostBackdrop 源失败", error))?;
            let backdrop_brush: CompositionBrush = blur_brush
                .cast()
                .map_err(|error| GlassFailure::api("转换 Gaussian blur brush 失败", error))?;
            backdrop
                .SetBrush(&backdrop_brush)
                .map_err(|error| GlassFailure::api("绑定背景 brush 失败", error))?;

            let tint = compositor
                .CreateSpriteVisual()
                .map_err(|error| GlassFailure::api("创建 tint Visual 失败", error))?;
            let tint_color_brush: CompositionColorBrush = compositor
                .CreateColorBrushWithColor(Color {
                    A: intensity.tint_alpha(),
                    R: 8,
                    G: 10,
                    B: 16,
                })
                .map_err(|error| GlassFailure::api("创建 tint brush 失败", error))?;
            let tint_brush: CompositionBrush = tint_color_brush
                .cast()
                .map_err(|error| GlassFailure::api("转换 tint brush 失败", error))?;
            tint.SetBrush(&tint_brush)
                .map_err(|error| GlassFailure::api("绑定 tint brush 失败", error))?;

            pill.Children()
                .and_then(|children| children.InsertAtBottom(&backdrop))
                .map_err(|error| GlassFailure::api("插入背景 Visual 失败", error))?;
            pill.Children()
                .and_then(|children| children.InsertAtTop(&tint))
                .map_err(|error| GlassFailure::api("插入 tint Visual 失败", error))?;
            root.Children()
                .and_then(|children| children.InsertAtTop(&pill))
                .map_err(|error| GlassFailure::api("插入胶囊 Visual 失败", error))?;
            target
                .SetRoot(&root)
                .map_err(|error| GlassFailure::api("提交 Composition 根节点失败", error))?;

            UNDERLAY_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
            window_guard.0 = None;

            Ok(Self {
                main_hwnd,
                hwnd,
                root,
                pill,
                geometry,
                backdrop,
                tint,
                _clip: clip,
                _backdrop_brush: backdrop_brush,
                _tint_brush: tint_brush,
                tint_color_brush,
                target,
                _compositor: compositor,
            })
        }

        unsafe fn update_region(&self, region: Region) -> Result<(), String> {
            let diameter = (region.radius.max(0) * 2).max(1);
            let native_region = CreateRoundRectRgn(
                region.x,
                region.y,
                region.x + region.w,
                region.y + region.h,
                diameter,
                diameter,
            );
            if native_region.0.is_null() {
                return Err(format!(
                    "创建 underlay 裁剪区域失败：Win32 {}",
                    GetLastError().0
                ));
            }
            if SetWindowRgn(self.hwnd, Some(native_region), false) == 0 {
                let error = GetLastError();
                let _ = DeleteObject(HGDIOBJ(native_region.0));
                return Err(format!("裁剪 underlay 命中区域失败：Win32 {}", error.0));
            }

            let size = Vector2 {
                X: region.w.max(1) as f32,
                Y: region.h.max(1) as f32,
            };
            self.pill
                .SetOffset(Vector3 {
                    X: region.x as f32,
                    Y: region.y as f32,
                    Z: 0.0,
                })
                .map_err(|error| format!("同步胶囊位置失败：{error}"))?;
            self.pill
                .SetSize(size)
                .map_err(|error| format!("同步胶囊尺寸失败：{error}"))?;
            self.geometry
                .SetSize(size)
                .map_err(|error| format!("同步圆角裁剪尺寸失败：{error}"))?;
            let radius = region.radius.max(0) as f32;
            self.geometry
                .SetCornerRadius(Vector2 {
                    X: radius,
                    Y: radius,
                })
                .map_err(|error| format!("同步圆角半径失败：{error}"))?;
            self.backdrop
                .SetSize(size)
                .map_err(|error| format!("同步背景尺寸失败：{error}"))?;
            self.tint
                .SetSize(size)
                .map_err(|error| format!("同步 tint 尺寸失败：{error}"))?;
            Ok(())
        }

        fn set_intensity(&self, intensity: GlassIntensity) -> Result<(), String> {
            self.tint_color_brush
                .SetColor(Color {
                    A: intensity.tint_alpha(),
                    R: 8,
                    G: 10,
                    B: 16,
                })
                .map_err(|error| format!("更新玻璃 tint 失败：{error}"))
        }

        unsafe fn sync_window(&self) -> Result<(), String> {
            let mut rect = RECT::default();
            GetWindowRect(self.main_hwnd, &mut rect)
                .map_err(|error| format!("读取主窗口位置失败：{error}"))?;
            let width = (rect.right - rect.left).max(1);
            let height = (rect.bottom - rect.top).max(1);
            self.root
                .SetSize(Vector2 {
                    X: width as f32,
                    Y: height as f32,
                })
                .map_err(|error| format!("同步根 Visual 尺寸失败：{error}"))?;
            align_under_main(self.hwnd, self.main_hwnd, ACTIVE.load(Ordering::Relaxed))?;
            Ok(())
        }

        unsafe fn show(&self) -> Result<(), String> {
            align_under_main(self.hwnd, self.main_hwnd, true)?;
            DwmFlush().map_err(|error| format!("提交 DWM 玻璃帧失败：{error}"))
        }

        unsafe fn hide(&self) {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
        }
    }

    impl Drop for GlassRuntime {
        fn drop(&mut self) {
            unsafe {
                let _ = self.target.Close();
                let _ = ShowWindow(self.hwnd, SW_HIDE);
                let _ = DestroyWindow(self.hwnd);
            }
            UNDERLAY_HWND.store(0, Ordering::SeqCst);
        }
    }

    unsafe extern "system" fn underlay_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_NCHITTEST {
            return LRESULT(HTTRANSPARENT as isize);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    fn check_policy() -> Result<(), GlassFailure> {
        let accessibility = AccessibilitySettings::new()
            .map_err(|error| GlassFailure::api("读取高对比度设置失败", error))?;
        if accessibility
            .HighContrast()
            .map_err(|error| GlassFailure::api("读取高对比度状态失败", error))?
        {
            return Err(GlassFailure::policy(
                "Windows 高对比度已开启，已回退为深色实底",
            ));
        }

        let ui =
            UISettings::new().map_err(|error| GlassFailure::api("读取透明效果设置失败", error))?;
        if !ui
            .AdvancedEffectsEnabled()
            .map_err(|error| GlassFailure::api("读取透明效果状态失败", error))?
        {
            return Err(GlassFailure::policy(
                "Windows 透明效果已关闭，已回退为深色材质",
            ));
        }
        Ok(())
    }

    fn main_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, GlassFailure> {
        window
            .hwnd()
            .map(|hwnd| HWND(hwnd.0 as _))
            .map_err(|error| GlassFailure::api("读取主窗口 HWND 失败", error))
    }

    pub fn enable<R: Runtime>(app: &AppHandle<R>, region: Option<Region>) -> GlassStatus {
        if let Err(failure) = check_policy() {
            RUNTIME.with(|slot| {
                if let Some(runtime) = slot.borrow().as_ref() {
                    unsafe { runtime.hide() };
                }
            });
            ACTIVE.store(false, Ordering::SeqCst);
            return GlassStatus::fallback(failure.supported, failure.reason);
        }

        let Some(window) = app.get_webview_window("main") else {
            INIT_FAILED.store(true, Ordering::SeqCst);
            return GlassStatus::fallback(false, "找不到主窗口");
        };
        let main = match main_hwnd(&window) {
            Ok(hwnd) => hwnd,
            Err(failure) => {
                INIT_FAILED.store(true, Ordering::SeqCst);
                return GlassStatus::fallback(failure.supported, failure.reason);
            }
        };
        let intensity = current_intensity();

        let result: Result<bool, GlassFailure> = RUNTIME.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.as_ref().is_some_and(|runtime| {
                runtime.main_hwnd.0 != main.0 || !unsafe { IsWindow(Some(runtime.hwnd)).as_bool() }
            }) {
                slot.take();
            }
            if slot.is_none() {
                *slot = Some(unsafe { GlassRuntime::create(main, intensity) }?);
            }
            let runtime = slot.as_ref().expect("glass runtime was just created");
            runtime
                .set_intensity(intensity)
                .map_err(|reason| GlassFailure::api("更新玻璃强度失败", reason))?;
            unsafe { runtime.sync_window() }
                .map_err(|reason| GlassFailure::api("同步 underlay 失败", reason))?;
            if let Some(region) = region {
                unsafe { runtime.update_region(region) }
                    .map_err(|reason| GlassFailure::api("同步毛玻璃形状失败", reason))?;
                if !MAIN_REVEALED.load(Ordering::Relaxed) {
                    unsafe { runtime.hide() };
                    ACTIVE.store(false, Ordering::SeqCst);
                    return Ok(false);
                }
                ACTIVE.store(true, Ordering::SeqCst);
                unsafe { runtime.show() }
                    .map_err(|reason| GlassFailure::api("显示毛玻璃失败", reason))?;
                Ok(true)
            } else {
                unsafe { runtime.hide() };
                ACTIVE.store(false, Ordering::SeqCst);
                Ok(false)
            }
        });

        match result {
            Ok(true) => {
                INIT_FAILED.store(false, Ordering::SeqCst);
                GlassStatus::active()
            }
            Ok(false) if region.is_some() => GlassStatus::waiting_for_reveal(),
            Ok(false) => GlassStatus::waiting_for_geometry(),
            Err(failure) => {
                ACTIVE.store(false, Ordering::SeqCst);
                INIT_FAILED.store(!failure.supported, Ordering::SeqCst);
                GlassStatus::fallback(failure.supported, failure.reason)
            }
        }
    }

    pub fn update_region_or_enable<R: Runtime>(app: &AppHandle<R>, region: Region) -> GlassStatus {
        if ACTIVE.load(Ordering::Relaxed) {
            let runtime_invalid = RUNTIME.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .is_none_or(|runtime| !unsafe { IsWindow(Some(runtime.hwnd)).as_bool() })
            });
            if runtime_invalid {
                ACTIVE.store(false, Ordering::SeqCst);
                return enable(app, Some(region));
            }

            let result = RUNTIME.with(|slot| {
                let slot = slot.borrow();
                let runtime = slot
                    .as_ref()
                    .ok_or_else(|| "毛玻璃运行时不存在".to_string())?;
                unsafe { runtime.update_region(region) }
            });
            return match result {
                Ok(()) => GlassStatus::active(),
                Err(error) => fail(app, error),
            };
        }
        enable(app, Some(region))
    }

    pub fn disable() {
        RUNTIME.with(|slot| {
            if let Some(runtime) = slot.borrow().as_ref() {
                unsafe { runtime.hide() };
            }
        });
        ACTIVE.store(false, Ordering::SeqCst);
        INIT_FAILED.store(false, Ordering::SeqCst);
    }

    pub fn sync_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        let main = main_hwnd(window).map_err(|failure| failure.reason)?;
        RUNTIME.with(|slot| {
            let slot = slot.borrow();
            let runtime = slot
                .as_ref()
                .ok_or_else(|| "毛玻璃运行时不存在".to_string())?;
            if runtime.main_hwnd.0 != main.0 {
                return Err("主窗口 HWND 已变化，需要重建毛玻璃".into());
            }
            unsafe { runtime.sync_window() }
        })
    }

    pub fn fail<R: Runtime>(app: &AppHandle<R>, error: String) -> GlassStatus {
        eprintln!("[glass] {error}");
        RUNTIME.with(|slot| {
            slot.borrow_mut().take();
        });
        ACTIVE.store(false, Ordering::SeqCst);
        // Runtime failures can be transient (display reset, session resume, or a
        // destroyed underlay HWND). Keep reconciliation enabled so the watcher
        // can rebuild on the next tick. Creation/API failures still set
        // INIT_FAILED in `enable` to avoid retrying an unsupported path forever.
        INIT_FAILED.store(false, Ordering::SeqCst);
        super::publish(
            app,
            GlassStatus::fallback(true, format!("{error}；将在后台自动重试")),
        )
    }

    pub fn shutdown() {
        RUNTIME.with(|slot| {
            slot.borrow_mut().take();
        });
        DISPATCHER.with(|slot| {
            if let Some(dispatcher) = slot.borrow_mut().take() {
                if let Err(error) = dispatcher.ShutdownQueueAsync() {
                    eprintln!("[glass] 无法关闭 DispatcherQueue：{error}");
                }
            }
        });
        ACTIVE.store(false, Ordering::SeqCst);
        UNDERLAY_HWND.store(0, Ordering::SeqCst);
    }

    pub unsafe fn align_under_main(underlay: HWND, main: HWND, show: bool) -> Result<(), String> {
        let mut rect = RECT::default();
        GetWindowRect(main, &mut rect).map_err(|error| format!("读取主窗口位置失败：{error}"))?;
        let flags = if show {
            SWP_NOACTIVATE | SWP_SHOWWINDOW
        } else {
            SWP_NOACTIVATE
        };
        SetWindowPos(
            underlay,
            Some(main),
            rect.left,
            rect.top,
            (rect.right - rect.left).max(1),
            (rect.bottom - rect.top).max(1),
            flags,
        )
        .map_err(|error| format!("同步 underlay 位置与层级失败：{error}"))
    }
}
