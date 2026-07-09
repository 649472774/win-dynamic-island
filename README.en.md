# Dynamic Island · Windows 灵动岛

[简体中文](./README.md) ｜ **English**

A Windows desktop "Dynamic Island" floating-pill app inspired by Apple's Dynamic Island. Built on **Tauri v2**:
Rust handles all native Windows capabilities (window positioning, always-on-top, glass effect, region clipping,
non-activating clicks), while the frontend — **React + Vite + TypeScript + Motion + Zustand** — handles rendering
and morph animations.

> Current status: **M1–M4 are all complete** (transparent topmost pill + three-state morph, Now Playing / SMTC,
> Volume HUD + battery / system info, File Shelf + tray + settings persistence + launch-at-startup). See the roadmap at the end.

---

## ✨ Implemented (M1)

- A **borderless / transparent / always-on-top** floating window, pinned to the **horizontal center at the top of the primary monitor**.
- **Dark glass pill**: the pill is a **self-contained dark translucent glass** surface (CSS dark base + thin stroke + shadow
  + inner highlight); the desktop still shows faintly through it, with corner radius ≥ 22px.
  > Note: system-wide Acrylic is deliberately **not** used. On Win11, Acrylic is composited by DWM over the **entire window**
  > and **cannot** be clipped by the pill's `SetWindowRgn`, which would smear the whole 760×480 window into a gray block
  > covering the desktop. So the pill renders its own glass look while the rest of the window stays fully transparent and
  > click-through (see "Key Design" and "Known Trade-offs").
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
| Windows | 11 (best Acrylic effect; Windows 10 1809+ also works, with slight visual differences) |
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
   > `WindowFromPoint`, which **is** affected by our rounded-corner clipping (`SetWindowRgn`), so registering only on the pill makes
   > the drop zone just that tiny pill and hard to hit. To fix this, a separate **invisible top-strip window** (island width × ~220px,
   > transparent, click-through, not region-clipped) hosts the same drop target, enlarging the drop zone to the **entire top strip** —
   > easy to hit, without affecting click/hover pass-through to the pill.
2. **Backup add**: expanded panel → the shelf card's top-right **＋** (opens a file dialog) or **📋** (add file/text from clipboard).
3. **Retrieve · copy to Explorer (reliable path)**: click an item's **⧉** or "Copy all" at the bottom — the file is placed on the
   clipboard as `CF_HDROP`, and **Ctrl+V in any folder** completes a **real file copy** (the reliable Windows equivalent of Yoink's "drag out").
4. **Retrieve · open / reveal**: **↗** opens with the default program, **📁** reveals in Explorer.
5. **Drag out (best-effort)**: file rows can be dragged directly to other apps (HTML5 drag, delivering path/URI); when dragging to
   Explorer doesn't produce a copy, use "copy → paste" from step 3.
6. **Text snippets**: text added via 📋 shows as a 📝 row; **⧉** copies the text, **✕** removes it.
7. **Persistence**: shelf content is written to `shelf.json` and **survives restarts** until you remove / clear it.
8. **Tray & Settings**: the tray icon's right-click menu has "Settings / Launch at startup / Quit"; **right-clicking the pill**
   opens the in-app settings panel (the browser's default context menu is suppressed); settings (system-info style / autostart)
   persist to `settings.json` and survive restarts.

> **Known boundaries**: ① drag-in is handled by the native `IDropTarget` + top-strip catcher window, with the drop zone being a full
> top-center strip; some sources (DRM-protected items, non-`CF_HDROP` virtual files) may fail to resolve a path — use ＋ / 📋 as
> reliable entry points; ② drag-out to Explorer is best-effort, with the reliable alternative being copy (CF_HDROP) then paste;
> ③ in dev mode the autostart registry entry points to the dev target exe; after packaging it becomes the proper path automatically.

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
   │  └─ clipboard.rs        # M4: clipboard CF_HDROP file copy / CF_UNICODETEXT text / read
   │  └─ dragdrop.rs         # M4f: native OLE drop target (IDropTarget) so a transparent window can catch file drag-in
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
  a transparent (layered) window. And because OLE hit-testing (`WindowFromPoint`) **is** clipped by `SetWindowRgn` down to the pill,
  a separate **invisible top-strip window** (`ensure_catcher`: `WS_EX_LAYERED` alpha=1 + `WM_NCHITTEST→HTTRANSPARENT` click-through,
  no region clip) hosts the same drop target to enlarge the drop zone to the full top strip; it follows monitor changes via `reposition()`.

### Module System

Adding a new "in-island component" only requires implementing the `IslandModule` interface and calling `register()`; the shell
decides which module to show when collapsed and how to arrange them when expanded, by `priority`. All M2–M4 features plug in as
independent modules without touching the shell.

---

## 🔑 Key Design Notes

- **Fixed large window + region clipping**: the native window is a fixed 760×480 transparent canvas that **never resizes**;
  `CreateRoundRectRgn` + `SetWindowRgn` dynamically clip a rounded rectangle matching the current pill/panel. This one trick solves
  three things at once: ① pixels outside the region automatically **pass through** to the window below; ② native DOM hover/click is
  preserved inside the region; ③ the WebView viewport is stable, keeping morph animation at a smooth 60fps.
  > Note: `SetWindowRgn` only clips **hit-testing and GDI drawing**, **not** DWM's Acrylic background compositing — which is exactly
  > why we don't use whole-window Acrylic (otherwise a gray block covers the desktop).
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
- **No "live desktop blur" for now**: for the reasons above, no system-level real-time Acrylic blur is done behind the pill (dark
  translucent glass is used instead). If true desktop blur is really needed, a future option is to resize the native window
  **frame-by-frame with the pill** (window = pill), at the cost of possible WebView2 reflow flicker during morphs — the opposite
  trade-off to today's "fixed large window that never resizes"; to be evaluated in a later milestone.
- The first `cargo build` must fetch and compile Rust dependencies and takes a while — this is normal (subsequent incremental builds ~10s).

---

## 🗺️ Roadmap

| Milestone | Content | Status |
| --- | --- | --- |
| **M1** | Scaffold + top-centered transparent topmost pill + three-state morph animation | ✅ Done |
| **M2** | Now Playing (SMTC: title/artist/cover/progress + previous/play-pause/next) | ✅ Done |
| **M3** | Volume HUD (a volume change briefly expands a slider that auto-collapses) + battery/CPU/memory | ✅ Done |
| **M4** | File Shelf (Yoink-style auto-expand on drag-in) + tray menu + settings persistence + launch at startup + right-click settings | ✅ Done |

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
