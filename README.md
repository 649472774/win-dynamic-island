# Dynamic Island · Windows 灵动岛

**简体中文** ｜ [English](./README.en.md)

一个受 Apple Dynamic Island 启发的 Windows 桌面「灵动岛」悬浮窗应用。基于 **Tauri v2** 构建：
Rust 负责所有 Windows 原生能力（窗口定位、置顶、毛玻璃、区域裁剪、非激活点击），
前端用 **React + Vite + TypeScript + Motion + Zustand** 负责渲染与形变动画。

> 当前进度：**M1–M4 全部完成**；**M5A Windows 原生真实毛玻璃技术预览已完成**。
> M5B Liquid Glass 外观增强与可选 M5C 真实折射尚未开始。详见文末路线图。

---

## ✨ 已实现（M1）

- **无边框 / 透明背景 / 始终置顶** 的悬浮窗，固定在**主显示器顶部水平居中**。
- **安全玻璃回退**：默认使用自包含的 CSS 深色半透明材质（深色底 + 细描边 + 阴影 + 内高光），
  圆角 ≥ 22px；M5A 可在设置中启用独立原生 underlay，获得真实桌面实时模糊。
  > 说明：仍然**不**对固定大主窗口应用整窗 Acrylic。该旧做法不受 `SetWindowRgn` 可靠裁剪，会把
  > 760×900 窗口糊成灰块挡住桌面。M5A 只在独立 underlay 的当前胶囊区域内绘制玻璃。
- **三态状态机 + 形变动画**（Motion spring，200–350ms，60fps）：
  1. **Collapsed** —— 细长胶囊，仅显示极简信息（当前为时钟占位模块）。
  2. **Hover** —— 悬停时轻微放大，显示预览信息。
  3. **Expanded** —— 点击展开为完整面板，网格陈列各功能模块入口。
- **不抢焦点**：点击灵动岛**不会**夺走你当前应用的键盘焦点（见下方「关键设计」）。
- **空闲鼠标穿透**：胶囊以外的像素点击会穿透到下层窗口；胶囊本身始终可交互。
- **不在任务栏显示**（`skipTaskbar` + `WS_EX_TOOLWINDOW`，并清除 `WS_EX_APPWINDOW`）。
- **高 DPI 与多显示器**：读取主显示器缩放定位；后台低频监视，显示器/分辨率变化时自动重新居中。
- **低占用**：原生窗口固定尺寸永不 resize，无动画时零渲染；空闲 CPU ≈ 0%，内存约 10MB（前端进程）。

---

## 🎵 已实现（M2 · Now Playing）

通过 Windows **SMTC**（`GlobalSystemMediaTransportControlsSessionManager`）读取系统当前媒体会话，
灵动岛实时呈现「正在播放」：

- **收起态胶囊**：小封面（或 🎵 回退图标）+ 歌名 + 播放时跳动的均衡器动画。有音乐在放时，
  Now Playing 模块自动「接管」胶囊（优先级高于时钟）。
- **展开面板**：封面 / 歌名 / 歌手 / 专辑 + **本地插值的平滑进度条**（含 `当前 / 总时长`）+
  **上一首 ⏮ / 播放暂停 ⏯ / 下一首 ⏭** 控制按钮（按会话能力自动禁用不可用项）。
- **实时联动**：切歌、暂停/播放、进度推进均由 Rust 事件推送即时刷新；点击控制按钮直接驱动
  系统播放器（网易云 / QQ音乐 / Spotify / 浏览器等任意注册了 SMTC 的应用）。
- **封面优雅降级**：部分播放器（尤其国内音乐 App）不向 SMTC 暴露缩略图，或在切歌瞬间给出损坏数据；
  此时封面**自动回退为 🎵**，绝不显示浏览器的「碎图」占位符。

> 实现要点：Rust 侧用**独立 MTA 线程**持有单个 `SessionManager`，以**自适应低频轮询**
> （播放中 1s / 其它 2s）+ 签名去重的方式读取并 `emit` 事件，空闲时几乎零开销；异步 WinRT 调用
> 用轻量 `block_on` 适配（`windows-future` 0.3 已移除阻塞式 `.get()`）。详见 `src-tauri/src/media.rs`。

- **低占用**：无媒体会话时不推送、不渲染；封面仅在**切歌**时解码一次并缓存。

| 依赖 | 版本 / 说明 |
| --- | --- |
| Windows | 11（M5A 原生 HostBackdrop）；不可用或系统禁用透明效果时自动回退 CSS |
| Node.js | ≥ 18（开发用 v24 验证通过） |
| Rust | 稳定版 + **MSVC** 工具链（`x86_64-pc-windows-msvc`） |
| WebView2 | Windows 11 已内置；如缺失请安装 Evergreen Runtime |
| Tauri CLI | 已作为 `devDependency`，无需全局安装 |

---

## 🚀 安装与运行

```powershell
# 1) 安装前端依赖
npm install

# 2) 开发模式（热重载；首次会编译 Rust 依赖，耗时较长属正常）
npm run tauri dev

# 3) 打包发布版（生成安装包与可执行文件）
npm run tauri build
```

启动后，屏幕**顶部正中**会出现一枚玻璃质感胶囊。

### 🔍 如何测试 M1

1. **收起态**：默认显示细长胶囊（时钟 + 脉冲圆点）。
2. **悬停**：鼠标移到胶囊上 → 胶囊轻微放大（Hover）。
3. **展开**：点击胶囊 → 形变为完整面板，显示「灵动岛」标题与模块网格
   （Now Playing / 音量 HUD / 电量·系统 / 文件暂存架，标注所属里程碑）。
4. **收起**：鼠标移开 → 面板平滑收回胶囊。
5. **不抢焦点**：先点开一个应用（如 Excel）保持前台，再点击灵动岛 —— 该应用**仍是前台窗口**，
   焦点未被夺走。
6. **鼠标穿透**：胶囊之外的桌面/窗口可正常点击，说明透明区域已穿透。
7. **任务栏**：任务栏**不出现**本应用图标。
8. **多显示器 / 缩放**：切换主显示器或更改缩放，灵动岛会自动重新居中到顶部。

### 🔍 如何测试 M2（Now Playing）

1. 打开任意注册了 SMTC 的播放器并播放音乐（网易云 / QQ音乐 / Spotify / Groove /
   浏览器里的 YouTube·Bilibili 皆可）。
2. **收起态**：胶囊自动切换为「小封面/🎵 + 歌名 + 均衡器动画」，随切歌实时更新。
3. **展开**：点击胶囊 → 面板显示 封面 / 歌名 / 歌手 / 进度条 / 控制按钮。
4. **控制**：点 ⏮ / ⏯ / ⏭ → 系统播放器随之上一首 / 暂停播放 / 下一首，面板状态同步翻转
   （暂停后主按钮变 ▶，进度条与均衡器停止）。
5. **封面回退**：若你的播放器不暴露封面，胶囊/面板会显示 🎵 占位而非碎图——属正常降级。
6. **低占用**：关闭所有播放器（无媒体会话）后，任务管理器中本应用空闲 CPU 应回落至 ≈ 0%。

### 🔍 如何测试 M4（文件暂存架 Shelf，Yoink 式）

**设计初衷**：暂存架是一个「拖拽中转站」——从一个窗口往另一个窗口搬文件时，先把文件**临时搁**在灵动岛上，
腾出手去切换目标文件夹 / 应用，再从岛上取回。它只存**文件路径引用**（不复制文件本体），因此「移除 / 清空」
**不会删除**你的原始文件。灵感来自 macOS 的 Yoink / Dropover（iPhone 灵动岛本身并无此功能）。

1. **拖入自动展开（核心）**：从资源管理器/桌面**按住文件拖向屏幕顶部的灵动岛** ——
   一旦拖动进入窗口区域，灵动岛会**自动展开**成大面板并显示「📎 松开鼠标放入暂存架」蒙层，**松手**即暂存。
   > 原理：应用在 Rust 侧注册了**原生 OLE 拖放目标**（`IDropTarget`）——这是必须自己实现的原因：
   > wry 内置的拖放事件在**透明（分层）窗口**上不会触发。系统拖放命中用 `WindowFromPoint`，它**会**
   > 受圆角裁剪（`SetWindowRgn`）影响。应用另挂一个承载相同目标的**隐形异形 catcher**，其真实 HWND Region
   > 与当前胶囊逐帧同步并紧贴主窗后方：胶囊外完全不参与鼠标命中，胶囊内普通指针直接到 WebView；
   > OLE 目标则同时注册在主窗、子窗和 catcher 上。
   > 请把文件拖到**可见胶囊**上；进入后岛会自动展开，后续落点也随面板一起扩大。
2. **备用添加**：展开面板 → 暂存架卡片右上角 **＋**（打开文件对话框）或 **📋**（从剪贴板添加文件/文本）。
3. **取回 · 复制到资源管理器（可靠路径）**：点某项的 **⧉** 或底部「全部复制」——文件会以 `CF_HDROP`
   放入剪贴板，到**任意文件夹里 Ctrl+V** 即完成一次**真实的文件复制**（这是 Windows 上等价于 Yoink「拖出」的可靠做法）。
4. **取回 · 打开 / 定位**：**↗** 用默认程序打开，**📁** 在资源管理器中定位。
5. **拖出（尽力而为）**：文件行可直接用鼠标拖到其它应用（HTML5 拖放，投递路径/URI）；
   拖到资源管理器不保证生成副本时，请改用第 3 步的「复制→粘贴」。
6. **文本片段**：📋 添加的文本以 📝 行显示，**⧉** 复制文本、**✕** 移除。
7. **持久化**：暂存内容写入 `shelf.json`，**重启后仍在**，直到你移除 / 清空。
8. **托盘 & 设置**：托盘图标右键有「设置 / 开机自启 / 退出」；**右键胶囊**打开应用内设置面板
   （浏览器默认右键菜单已屏蔽）；设置项（系统信息样式 / 毛玻璃开关与强度 / 开机自启）重启保留。

> **已知边界**：① 「拖入」由原生 `IDropTarget` + 与岛同形的隐形 catcher 接管，初始落点为可见胶囊；个别来源（受 DRM 保护的项、
> 非 `CF_HDROP` 的虚拟文件）可能无法解析路径，此时用 ＋ / 📋 作为可靠入口；
> ② 「拖出」到资源管理器为尽力而为，可靠替代 = 复制（CF_HDROP）后粘贴；
> ③ 开发态开机自启注册表指向 dev 目标 exe，打包后自动为正式路径。

---

## 🪟 M5A · Windows 原生真实毛玻璃（技术预览）

- 使用公开的 `Windows.UI.Composition`、`DesktopWindowTarget` 与 `CreateHostBackdropBrush`，
  在独立 `DI_GlassUnderlay` Win32 窗口中实时采样岛后方桌面；额外叠加轻量 Gaussian blur 与深色 tint。
- underlay 始终位于 Tauri 主窗正下方，使用 tool-window / no-activate / click-through，
  不进任务栏、不抢焦点；其位置、尺寸、圆角和真实 HWND Region 与主岛逐帧同步。
- underlay 与 OLE catcher 都按当前胶囊执行 `SetWindowRgn`，胶囊外不会形成透明点击或拖放死区。
- 设置提供**淡雅 / 平衡 / 明显**三档真实原生强度，技术预览默认关闭、默认强度为**平衡**，写入
  `settings.json`；无需重启即可切换。
- 遵循 Windows「透明效果」与高对比度策略：策略关闭、API 初始化失败或资源异常时，明确显示降级原因并
  切换为不透底的深色安全材质；后台会尝试恢复瞬态资源错误。
- M5A 不捕获屏幕、不把桌面像素传给 JavaScript，也不使用私有 DWM 属性；M5B/M5C 尚未包含。

### 🔍 如何测试 M5A

1. 右键灵动岛打开设置，开启「真实毛玻璃」；把文字密集网页或视频移到岛后方，确认背景随滚动/播放实时变化。
2. 依次切换「淡雅 / 平衡 / 明显」，确认三档透出强度即时变化；重启应用后设置仍保留。
3. 验证收起 / 悬停 / 展开 / 音量 HUD / 设置页，玻璃边缘与圆角始终贴合，岛外桌面仍可点击。
4. 从资源管理器把文件直接拖到可见胶囊，确认岛自动展开并可落入暂存架。
5. 在 Windows 设置中关闭「透明效果」，确认设置页显示回退原因且岛变为深色实底；恢复后原生玻璃自动回来。

---

## 🏗️ 项目结构

```
dynamic-island/
├─ src/                      # 前端（React）
│  ├─ main.tsx               # 入口，挂载 App 并引入全局样式
│  ├─ App.tsx                # 仅渲染 <Island/>
│  ├─ island/Island.tsx      # 灵动岛外壳：三态状态机 + Motion 形变 + 区域上报
│  ├─ store/island.ts        # Zustand 全局状态（state / region / 动作）
│  ├─ modules/               # 可插拔「岛内组件」系统
│  │  ├─ types.ts            #   IslandModule 接口（id / priority / Collapsed / Expanded）
│  │  ├─ registry.ts         #   模块注册与按优先级排序
│  │  ├─ clock.tsx           #   M1 演示模块（时钟）
│  │  ├─ nowplaying.tsx      #   M2 模块（SMTC 正在播放：收起/展开视图 + 控制）
│  │  ├─ system.tsx          #   M3 模块（电量/CPU/内存，单行/条形/环形三种样式）
│  │  ├─ volume.tsx          #   M3 模块（音量 HUD 滑条 + 展开态 Tile）
│  │  ├─ shelf.tsx           #   M4 模块（Yoink 式文件暂存架 + useShelfDrag 拖入钩子）
│  │  └─ index.ts            #   注册入口
│  ├─ lib/native.ts          # 封装与 Rust 的 invoke/event 通信
│  └─ styles/global.css      # 透明背景、玻璃质感、圆角与面板样式
└─ src-tauri/                # 后端（Rust）
   ├─ src/
   │  ├─ lib.rs              # 应用入口、command 注册、setup、显示器监视线程、托盘
   │  ├─ window.rs           # 所有 Win32 逻辑（居中/置顶/区域裁剪/非激活点击）
   │  ├─ media.rs            # M2：SMTC 工作线程 + Now Playing 读取与控制命令
   │  ├─ system.rs           # M3：电量/CPU/内存低频事件推送
   │  ├─ volume.rs           # M3：WASAPI 音量事件回调 + 读写/静音
   │  ├─ clipboard.rs        # M4：剪贴板 CF_HDROP 文件复制 / CF_UNICODETEXT 文本 / 读取
   │  ├─ dragdrop.rs         # M4f：原生 OLE 拖放目标（IDropTarget）与同形隐形 catcher
   │  └─ glass.rs            # M5A：HostBackdrop Composition underlay、策略回退与生命周期
   ├─ tauri.conf.json        # 窗口配置（760×900、透明、无边框、置顶、隐藏待定位）
   └─ Cargo.toml
```

### 前后端通信约定

Rust 侧封装全部 Windows API，通过 `#[tauri::command]` 暴露调用；前端在 `lib/native.ts` 统一封装
`invoke`，组件不直接触碰底层。当前 M1 提供的命令：

- `set_island_region({x,y,w,h,radius})` —— 前端测量可见胶囊的物理像素矩形后上报，Rust 用其裁剪窗口区域。
- `reveal_island()` —— 首帧区域就绪后再显示窗口，避免启动闪烁。
- `recenter()` —— 重新计算并居中到主显示器顶部。

M2（Now Playing）新增：

- `get_now_playing()` —— 返回当前媒体会话快照（首帧渲染用），并触发一次刷新推送。
- `media_play_pause()` / `media_next()` / `media_previous()` —— 驱动系统播放器的播放暂停 / 下一首 / 上一首。
- 事件 `now-playing-update` —— Rust 轮询到状态变化时推送最新快照，前端订阅刷新。

M4（暂存架取回）新增：

- `clipboard_copy_files([paths])` —— 将真实文件以 `CF_HDROP` 放入剪贴板，可在资源管理器 Ctrl+V 得到副本。
- `clipboard_copy_text(text)` —— 将文本以 `CF_UNICODETEXT` 放入剪贴板。
- `clipboard_read()` —— 读取剪贴板中的文件列表 / 文本（供「从剪贴板添加」）。
- 拖入由 Rust 侧原生 `IDropTarget`（`dragdrop.rs`，经 `RegisterDragDrop` 注册到窗口及其子 HWND）接管：
  拖动进入即 `emit("shelf-drag-enter")`、放下时解析 `CF_HDROP` 路径并 `emit("shelf-drop", paths)`、
  离开 `emit("shelf-drag-leave")`；前端 `useShelfDrag()` 监听这三个事件驱动 `dragActive` 与入架
  （详见 `modules/shelf.tsx`）。**之所以自实现**：wry 内置的 `onDragDropEvent` 在透明（分层）窗口上不触发。
  又因 OLE 命中判定（`WindowFromPoint`）**会**受 `SetWindowRgn` 影响，另建一个**同形隐形 catcher**
  （`ensure_catcher`：`WS_EX_LAYERED` alpha=1 + `WM_NCHITTEST→HTTRANSPARENT`）承载同一拖放目标；
  catcher 的真实 Region 由 `sync_region()` 与可见胶囊逐帧同步，随显示器切换由 `reposition()` 跟随对齐。

M5A（原生毛玻璃）新增：

- `set_glass_enabled(enabled, intensity)` / `get_glass_status()` —— 启停原生 underlay、设置三档强度并读取实际状态。
- 事件 `glass-status-changed` —— 推送 active / fallback、renderer、降级原因与当前强度；前端仅在
  `active=true` 时降低 WebView 覆盖层透明度，否则使用安全回退。

### 模块系统

新增「岛内组件」只需实现 `IslandModule` 接口并 `register()`，外壳按 `priority` 决定收起态展示哪个、
展开态如何排布。M2–M4 的功能都将作为独立模块接入，无需改动外壳。

---

## 🔑 关键设计说明

- **固定大窗 + 区域裁剪**：原生窗口固定为 760×900 透明画布**永不 resize**；用
  `CreateRoundRectRgn` + `SetWindowRgn` 动态裁剪出与当前胶囊/面板一致的圆角矩形区域。
  这一招同时解决三件事：① 区域外像素自动**穿透**到下层窗口；② 区域内保留原生 DOM 悬停/点击；
  ③ WebView 视口稳定，形变动画顺滑 60fps。
  > 注意：`SetWindowRgn` 只裁剪**命中测试与 GDI 绘制**，**不**裁剪 DWM 的 Acrylic 背景合成——
  > 这正是我们不使用整窗 Acrylic 的原因（否则整窗灰块盖住桌面）。
- **独立玻璃 underlay**：M5A 不碰 WebView2 内部 Composition 树，而是建立无激活、全点击穿透的配对
  HWND，只在同步后的胶囊 Region 内绘制 HostBackdrop；Z-order 始终夹在主岛与其它应用之间。
- **不抢焦点又能点击（核心难点）**：仅设 `WS_EX_NOACTIVATE` 会导致——当本进程非前台时，
  Windows 把点击当成「激活尝试」吞掉，WebView 收不到 DOM click。解决方案是**子类化窗口过程**，
  对 `WM_MOUSEACTIVATE` 返回 `MA_NOACTIVATE`：告诉系统「别激活我，但请照常投递鼠标消息」。
  于是胶囊可点击、面板可展开，而用户当前应用的键盘焦点**丝毫不动**。
- **样式与区域自愈**：tao/WebView2 会在 `setup()` 之后异步初始化并重置扩展样式、
  甚至清掉我们设的窗口区域（DPI/显示器/锁屏等系统事件亦可能触发）。因此扩展样式、子类化与
  **窗口区域**都在后台监视线程里**幂等地周期性重申**（区域仅在检测到丢失/变化时才重设，避免打断形变）；
  窗口首次显示后再以 ~100ms 节奏短时补打 2 秒，确保初始化期的清除被**瞬时**修复。
  没有这层自愈，区域一旦丢失会留下一块**看不见但会拦截点击**的整窗矩形。

---

## ⚠️ 已知取舍

- 圆角区域裁剪由 GDI 实现，边缘为硬裁剪、无抗锯齿，放大观察圆角可能有轻微锯齿；
  视觉上叠加了内层 CSS 圆角以缓解。
- 逐区域穿透依赖窗口区域裁剪 + 前端悬停，鼠标极快掠过时理论上有毫秒级延迟，实测无感。
- M5A 原生效果依赖 Windows 11 的公开 Composition HostBackdrop 与系统透明策略；不满足时自动使用深色实底。
- M5A 只做真实背景采样与模糊，不会让背景线条发生几何弯曲；Liquid Glass 高光属于 M5B，真实折射仅为可选 M5C。
- 首次 `cargo build` 需拉取并编译 Rust 依赖，耗时较长，属正常现象（后续增量编译约 10s）。

---

## 🗺️ 路线图

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| **M1** | 脚手架 + 顶部居中透明置顶胶囊 + 三态形变动画 | ✅ 已完成 |
| **M2** | Now Playing（SMTC：歌名/歌手/封面/进度 + 上一首/播放暂停/下一首） | ✅ 已完成 |
| **M3** | 音量 HUD（音量变化短暂展开滑条自动收起）+ 电量/CPU/内存 | ✅ 已完成 |
| **M4** | 文件暂存架 Shelf（Yoink 式拖入自动展开）+ 托盘菜单 + 设置持久化 + 开机自启 + 右键设置 | ✅ 已完成 |
| **M5A** | 独立 Windows Composition underlay + HostBackdrop 真实毛玻璃 + 三档强度与安全回退 | ✅ 已完成（技术预览） |
| **M5B** | Liquid Glass 动态高光、内反射与边缘质感 | ⏸ 未开始 |
| **M5C** | D3D11/HLSL 真实背景折射 | ⏸ 可选实验阶段 |

---

## 📄 许可

私有项目脚手架，暂未指定开源许可。
