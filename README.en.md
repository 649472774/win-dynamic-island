# Dynamic Island · Windows 灵动岛

[简体中文](./README.md) ｜ **English**

A Windows desktop "Dynamic Island" floating-pill app inspired by Apple's Dynamic Island. Built on **Tauri v2**:
Rust handles all native Windows capabilities (window positioning, always-on-top, glass effect, region clipping,
non-activating clicks), while the frontend — **React + Vite + TypeScript + Motion + Zustand** — handles rendering
and morph animations.

> Current status: **M1–M4 are complete**. The **M5A native Windows live-glass technical preview is complete**.
> M5B Liquid Glass styling and optional M5C refraction have not started.

---

## ✨ Implemented (M1)

- A **borderless / transparent / always-on-top** floating window, pinned to the **horizontal center at the top of the primary monitor**.
- **Safe glass fallback**: the default is a self-contained dark translucent CSS material (dark base + thin stroke + shadow
  + inner highlight), with corner radius ≥ 22px. M5A optionally adds a separate native underlay for real live desktop blur.
  > Whole-window Acrylic is still deliberately avoided: it is not reliably clipped by `SetWindowRgn` and can turn the fixed
  > 760×900 window into a gray block. M5A paints glass only inside the current pill region on an independent underlay.
- **Three-state machine + morph animation** (Motion spring, 200–350ms, 60fps):
  1. **Collapsed** — a slim pill showing only minimal info (currently a clock placeholder module).
  2. **Hover** — slightly enlarges on hover to show a preview.
  3. **Expanded** — click to morph into a full panel with a grid of feature-module entries.
- **Never steals focus**: clicking the island does **not** take keyboard focus away from your current app (see "Key Design").
- **Idle click-through**: clicks on pixels outside the pill pass through to the window below; the pill itself is always interactive.
- **Hidden from the taskbar** (`skipTaskbar` + `WS_EX_TOOLWINDOW`, plus clearing `WS_EX_APPWINDOW`).
- **High DPI & multi-monitor**: positions using the primary monitor's scale; a low-frequency background watcher re-centers
  automatically when the monitor / resolution changes.
- **Low footprint**: the native window has a fixed size and never resizes; zero rendering when idle. Idle CPU ≈ 0%,
  memory ~10MB (frontend process).

---

## 🎵 Implemented (M2 · Now Playing)

Using Windows **SMTC** (`GlobalSystemMediaTransportControlsSessionManager`), the island reads the current system media
session and shows "Now Playing" in real time:

- **Collapsed pill**: small cover art (or a 🎵 fallback icon) + track title + an equalizer animation while playing.
  When music is playing, the Now Playing module automatically "takes over" the pill (higher priority than the clock).
- **Expanded panel**: cover / title / artist / album + a **locally interpolated smooth progress bar** (with `current / total`)
  + **previous ⏮ / play-pause ⏯ / next ⏭** controls (unavailable actions are auto-disabled per session capabilities).
- **Live sync**: track changes, pause/play, and progress are pushed instantly via Rust events; clicking a control drives
  the system player directly (NetEase / QQ Music / Spotify / browser — any app that registers with SMTC).
- **Graceful cover fallback**: some players (especially Chinese music apps) don't expose thumbnails to SMTC, or emit
  corrupt data at the moment of a track change; the cover then **falls back to 🎵** and never shows a broken-image placeholder.

> Implementation note: on the Rust side a dedicated **MTA thread** holds a single `SessionManager` and reads/`emit`s events
> via **adaptive low-frequency polling** (1s while playing / 2s otherwise) + signature dedup, so idle overhead is near zero.
> Async WinRT calls are adapted with a lightweight `block_on` (`windows-future` 0.3 removed the blocking `.get()`).
> See `src-tauri/src/media.rs`.

- **Low footprint**: no push/render when there's no media session; cover art is decoded once per track change and cached.

| Dependency | Version / Note |
| --- | --- |
| Windows | 11 for M5A HostBackdrop; unsupported or policy-disabled systems automatically use the CSS fallback |
| Node.js | ≥ 18 (verified with v24 in development) |
| Rust | Stable + **MSVC** toolchain (`x86_64-pc-windows-msvc`) |
| WebView2 | Built into Windows 11; install the Evergreen Runtime if missing |
| Tauri CLI | Included as a `devDependency`; no global install needed |

---

## 🚀 Install & Run

```powershell
# 1) Install frontend dependencies
npm install

# 2) Dev mode (hot reload; the first run compiles Rust deps and takes a while — this is normal)
npm run tauri dev

# 3) Build a release (produces installers and an executable)
npm run tauri build
```

After launch, a glass pill appears at the **top center** of the screen.

### 🔍 How to test M1

1. **Collapsed**: a slim pill shows by default (clock + pulsing dot).
2. **Hover**: move the mouse over the pill → it enlarges slightly (Hover).
3. **Expanded**: click the pill → it morphs into a full panel showing the "Dynamic Island" title and a module grid
   (Now Playing / Volume HUD / Battery·System / File Shelf, each labeled with its milestone).
4. **Collapse**: move the mouse away → the panel smoothly retracts into the pill.
5. **No focus stealing**: bring an app to the foreground (e.g. Excel), then click the island — that app **remains** the
   foreground window; focus is not taken.
6. **Click-through**: the desktop/windows outside the pill click normally, proving the transparent area passes through.
7. **Taskbar**: the app's icon does **not** appear in the taskbar.
8. **Multi-monitor / scaling**: switch the primary monitor or change scaling — the island re-centers to the top automatically.

### 🔍 How to test M2 (Now Playing)

1. Open any SMTC-registered player and play music (NetEase / QQ Music / Spotify / Groove / YouTube·Bilibili in a browser
   all work).
2. **Collapsed**: the pill switches to "small cover/🎵 + title + equalizer animation" and updates live as tracks change.
3. **Expanded**: click the pill → the panel shows cover / title / artist / progress bar / controls.
4. **Controls**: click ⏮ / ⏯ / ⏭ → the system player goes previous / pauses-plays / next, and the panel state flips in sync
   (the main button becomes ▶ after pausing; the progress bar and equalizer stop).
5. **Cover fallback**: if your player doesn't expose a cover, the pill/panel shows a 🎵 placeholder instead of a broken image — this is normal graceful degradation.
6. **Low footprint**: after closing all players (no media session), the app's idle CPU in Task Manager should drop back to ≈ 0%.

### 🔍 How to test M4 (File Shelf, Yoink-style)

**Design intent**: the shelf is a "drag-and-drop waystation" — when moving files from one window to another, you temporarily
**park** them on the island, free your hands to switch the target folder / app, then grab them back from the island. It stores
only **file path references** (it does not copy the file itself), so "Remove / Clear" **does not delete** your original files.
Inspired by macOS's Yoink / Dropover (the iPhone Dynamic Island itself has no such feature).

1. **Auto-expand on drag-in (core)**: from Explorer/Desktop, **hold a file and drag it toward the island at the top of the screen** —
   as soon as the drag enters the window area, the island **auto-expands** into a large panel showing a "📎 Release to drop into the shelf"
   overlay; **release** to park it.
   > How it works: the app registers a **native OLE drop target** (`IDropTarget`) on the Rust side — this must be self-implemented
   > because wry's built-in drop events don't fire on a **transparent (layered) window**. System drag-drop hit-testing uses
   > `WindowFromPoint`, which **is** affected by rounded-corner clipping (`SetWindowRgn`). A separate **invisible shaped catcher**
   > hosts the same target, mirrors the island's real HWND region every frame, and stays directly behind the main window. It does not
   > participate in pointer hit-testing outside the pill, while ordinary input reaches WebView2 directly. OLE targets remain registered
   > on the main window, child windows, and catcher. Drag onto the **visible pill**;
   > once entered, the island expands and the drop region grows with it.
2. **Backup add**: expanded panel → the shelf card's top-right **＋** (opens a file dialog) or **📋** (add file/text from clipboard).
3. **Retrieve · copy to Explorer (reliable path)**: click an item's **⧉** or "Copy all" at the bottom — the file is placed on the
   clipboard as `CF_HDROP`, and **Ctrl+V in any folder** completes a **real file copy** (the reliable Windows equivalent of Yoink's "drag out").
4. **Retrieve · open / reveal**: **↗** opens with the default program, **📁** reveals in Explorer.
5. **Drag out (best-effort)**: file rows can be dragged directly to other apps (HTML5 drag, delivering path/URI); when dragging to
   Explorer doesn't produce a copy, use "copy → paste" from step 3.
6. **Text snippets**: text added via 📋 shows as a 📝 row; **⧉** copies the text, **✕** removes it.
7. **Persistence**: shelf content is written to `shelf.json` and **survives restarts** until you remove / clear it.
8. **Tray & Settings**: the tray icon's right-click menu has "Settings / Launch at startup / Quit"; **right-clicking the pill**
   opens the in-app settings panel (the browser's default context menu is suppressed); system-info style, native-glass
   preference/intensity, and autostart survive restarts.

> **Known boundaries**: ① drag-in is handled by the native `IDropTarget` + a shaped invisible catcher, with the initial drop zone matching
> the visible pill; some sources (DRM-protected items, non-`CF_HDROP` virtual files) may fail to resolve a path — use ＋ / 📋 as
> reliable entry points; ② drag-out to Explorer is best-effort, with the reliable alternative being copy (CF_HDROP) then paste;
> ③ in dev mode the autostart registry entry points to the dev target exe; after packaging it becomes the proper path automatically.

---

## 🪟 M5A · Native Windows Live Glass (technical preview)

- Uses the public `Windows.UI.Composition`, `DesktopWindowTarget`, and `CreateHostBackdropBrush` APIs in a separate
  `DI_GlassUnderlay` Win32 window, with a light Gaussian blur and dark tint.
- The underlay stays directly beneath the Tauri window and uses tool-window / no-activate / click-through behavior. Its position,
  size, corner radius, and real HWND region follow the island every frame.
- Both the underlay and OLE catcher receive the current pill-shaped `SetWindowRgn`, so neither creates an invisible click/drop dead zone.
- Settings expose three real native intensities — **Subtle / Balanced / Vivid**. The preview defaults off, Balanced is the safe
  default intensity, and changes persist in `settings.json`.
- Windows Transparency Effects and High Contrast are respected. Policy/API/resource failures report a reason and switch to an
  opaque dark fallback; transient resource failures are retried in the background.
- M5A performs no screen capture, sends no desktop pixels to JavaScript, and uses no private DWM attributes. M5B/M5C are not included.

### 🔍 How to test M5A

1. Right-click the island, enable "Native glass," then place a text-heavy page or video behind it and verify the material updates live.
2. Switch Subtle / Balanced / Vivid and verify the strength changes immediately and survives a restart.
3. Check Collapsed / Hover / Expanded / Volume HUD / Settings: the glass edge must track the island and outside pixels stay clickable.
4. Drag a file from Explorer directly onto the visible pill; the island should auto-expand and accept the drop.
5. Disable Windows "Transparency effects": the UI should report the fallback and become a solid dark surface; restoring the policy
   should restore native glass automatically.

---

## 🏗️ Project Structure

```
dynamic-island/
├─ src/                      # Frontend (React)
│  ├─ main.tsx               # Entry: mounts App and imports global styles
│  ├─ App.tsx                # Renders only <Island/>
│  ├─ island/Island.tsx      # Island shell: three-state machine + Motion morph + region reporting
│  ├─ store/island.ts        # Zustand global state (state / region / actions)
│  ├─ modules/               # Pluggable "in-island component" system
│  │  ├─ types.ts            #   IslandModule interface (id / priority / Collapsed / Expanded)
│  │  ├─ registry.ts         #   Module registration and priority ordering
│  │  ├─ clock.tsx           #   M1 demo module (clock)
│  │  ├─ nowplaying.tsx      #   M2 module (SMTC Now Playing: collapsed/expanded views + controls)
│  │  ├─ system.tsx          #   M3 module (battery/CPU/memory, inline/bar/ring styles)
│  │  ├─ volume.tsx          #   M3 module (Volume HUD slider + expanded Tile)
│  │  ├─ shelf.tsx           #   M4 module (Yoink-style File Shelf + useShelfDrag drag-in hook)
│  │  └─ index.ts            #   Registration entry
│  ├─ lib/native.ts          # Wraps invoke/event communication with Rust
│  └─ styles/global.css      # Transparent background, glass look, radii and panel styles
└─ src-tauri/                # Backend (Rust)
   ├─ src/
   │  ├─ lib.rs              # App entry, command registration, setup, monitor watcher thread, tray
   │  ├─ window.rs           # All Win32 logic (centering/topmost/region clipping/non-activating clicks)
   │  ├─ media.rs            # M2: SMTC worker thread + Now Playing read & control commands
   │  ├─ system.rs           # M3: low-frequency battery/CPU/memory event push
   │  ├─ volume.rs           # M3: WASAPI volume event callback + read/write/mute
   │  ├─ clipboard.rs        # M4: clipboard CF_HDROP file copy / CF_UNICODETEXT text / read
   │  ├─ dragdrop.rs         # M4f: native OLE drop target (IDropTarget) + shaped invisible catcher
   │  └─ glass.rs            # M5A: HostBackdrop Composition underlay, policy fallback, and lifecycle
   ├─ tauri.conf.json        # Window config (760×900, transparent, borderless, topmost, hidden until positioned)
   └─ Cargo.toml
```

### Frontend–Backend Contract

The Rust side wraps all Windows APIs and exposes them via `#[tauri::command]`; the frontend centralizes `invoke` in
`lib/native.ts` so components never touch the low level directly. Commands provided in M1:

- `set_island_region({x,y,w,h,radius})` — the frontend measures the visible pill's physical-pixel rectangle and reports it;
  Rust uses it to clip the window region.
- `reveal_island()` — show the window only after the first region is ready, avoiding a startup flash.
- `recenter()` — recompute and center to the top of the primary monitor.

Added in M2 (Now Playing):

- `get_now_playing()` — return a snapshot of the current media session (for first-frame render) and trigger one refresh push.
- `media_play_pause()` / `media_next()` / `media_previous()` — drive the system player's play-pause / next / previous.
- Event `now-playing-update` — Rust pushes the latest snapshot when polling detects a state change; the frontend subscribes and refreshes.

Added in M4 (shelf retrieval):

- `clipboard_copy_files([paths])` — place real files on the clipboard as `CF_HDROP`, so Ctrl+V in Explorer yields a copy.
- `clipboard_copy_text(text)` — place text on the clipboard as `CF_UNICODETEXT`.
- `clipboard_read()` — read the file list / text from the clipboard (for "add from clipboard").
- Drag-in is handled by the native `IDropTarget` on the Rust side (`dragdrop.rs`, registered via `RegisterDragDrop` on the window
  and its child HWNDs): on drag enter it `emit`s `"shelf-drag-enter"`, on drop it parses `CF_HDROP` paths and `emit`s
  `"shelf-drop", paths`, and on leave `"shelf-drag-leave"`; the frontend `useShelfDrag()` listens to these three events to drive
  `dragActive` and shelving (see `modules/shelf.tsx`). **Why self-implemented**: wry's built-in `onDragDropEvent` doesn't fire on
  a transparent (layered) window. Because OLE hit-testing (`WindowFromPoint`) **is** affected by `SetWindowRgn`, a separate
  **shaped invisible catcher** (`ensure_catcher`: `WS_EX_LAYERED` alpha=1 + `WM_NCHITTEST→HTTRANSPARENT`) hosts the same target.
  `sync_region()` mirrors the visible island region every frame, while `reposition()` follows monitor changes.

Added in M5A (native glass):

- `set_glass_enabled(enabled, intensity)` / `get_glass_status()` — enable the underlay, select one of three strengths, and read
  the effective native/fallback state.
- Event `glass-status-changed` — reports active/fallback state, renderer, reason, and intensity. The frontend only reduces its
  overlay opacity when `active=true`; every other state uses the safe fallback.

### Module System

Adding a new "in-island component" only requires implementing the `IslandModule` interface and calling `register()`; the shell
decides which module to show when collapsed and how to arrange them when expanded, by `priority`. All M2–M4 features plug in as
independent modules without touching the shell.

---

## 🔑 Key Design Notes

- **Fixed large window + region clipping**: the native window is a fixed 760×900 transparent canvas that **never resizes**;
  `CreateRoundRectRgn` + `SetWindowRgn` dynamically clip a rounded rectangle matching the current pill/panel. This one trick solves
  three things at once: ① pixels outside the region automatically **pass through** to the window below; ② native DOM hover/click is
  preserved inside the region; ③ the WebView viewport is stable, keeping morph animation at a smooth 60fps.
  > Note: `SetWindowRgn` only clips **hit-testing and GDI drawing**, **not** DWM's Acrylic background compositing — which is exactly
  > why we don't use whole-window Acrylic (otherwise a gray block covers the desktop).
- **Independent glass underlay**: M5A does not modify WebView2's internal Composition tree. It pairs a non-activating,
  fully click-through HWND with the main window and paints HostBackdrop only inside the synchronized pill region.
- **Clickable yet never steals focus (the core challenge)**: setting only `WS_EX_NOACTIVATE` causes a problem — when this process
  isn't foreground, Windows treats a click as an "activation attempt" and swallows it, so the WebView never receives the DOM click.
  The solution is to **subclass the window procedure** and return `MA_NOACTIVATE` for `WM_MOUSEACTIVATE`: telling the system
  "don't activate me, but deliver mouse messages as usual." The pill stays clickable and the panel expands, while the user's current
  app keeps its keyboard focus **untouched**.
- **Style & region self-healing**: tao/WebView2 initialize asynchronously after `setup()` and may reset the extended styles, or even
  clear our window region (DPI/monitor/lock-screen and other system events can trigger this too). So the extended styles, subclassing,
  and **window region** are all **idempotently re-asserted periodically** in a background watcher thread (the region is only reset when
  a loss/change is detected, to avoid interrupting morphs); after the window is first shown, it's briefly re-applied at a ~100ms cadence
  for 2 seconds to **instantly** fix any clearing during initialization. Without this self-healing layer, a lost region would leave an
  **invisible but click-blocking** full-window rectangle.

---

## ⚠️ Known Trade-offs

- Rounded-corner region clipping is done by GDI with hard, non-anti-aliased edges, so magnified corners may show slight jaggies;
  an inner CSS corner radius is layered on to mitigate this visually.
- Per-region pass-through relies on window-region clipping + frontend hover; sweeping the mouse extremely fast has a theoretical
  millisecond-scale delay, imperceptible in practice.
- M5A requires Windows 11's public Composition HostBackdrop path and an enabled transparency policy; otherwise it uses a solid fallback.
- M5A samples and blurs the real background but does not geometrically bend background lines. Liquid Glass highlights belong to M5B;
  real refraction remains the optional M5C experiment.
- The first `cargo build` must fetch and compile Rust dependencies and takes a while — this is normal (subsequent incremental builds ~10s).

---

## 🗺️ Roadmap

| Milestone | Content | Status |
| --- | --- | --- |
| **M1** | Scaffold + top-centered transparent topmost pill + three-state morph animation | ✅ Done |
| **M2** | Now Playing (SMTC: title/artist/cover/progress + previous/play-pause/next) | ✅ Done |
| **M3** | Volume HUD (a volume change briefly expands a slider that auto-collapses) + battery/CPU/memory | ✅ Done |
| **M4** | File Shelf (Yoink-style auto-expand on drag-in) + tray menu + settings persistence + launch at startup + right-click settings | ✅ Done |
| **M5A** | Independent Windows Composition underlay + HostBackdrop live glass + three strengths and safe fallback | ✅ Complete (technical preview) |
| **M5B** | Liquid Glass highlights, inner reflections, and edge treatment | ⏸ Not started |
| **M5C** | D3D11/HLSL real background refraction | ⏸ Optional experiment |

---

## 🔒 Privacy

The app only reads media sessions, volume, battery, and system usage **locally** for display; it does not connect to the network
or upload any data. The file shelf only records references to files you actively put in.

---

## 🙏 Acknowledgements & Disclaimer

- Inspired by Apple's Dynamic Island and macOS; the file shelf borrows its interaction from [Yoink](https://eternalstorms.at/yoink/).
- This project has **no affiliation with or endorsement from** Apple Inc. "Dynamic Island" is a trademark of its respective owner
  and is referenced here only to describe the inspiration.

---

## 📄 License

Private project scaffold; no open-source license specified yet. If open-sourcing, **MIT** or **Apache-2.0** is recommended
(add a `LICENSE` file at the repository root).
