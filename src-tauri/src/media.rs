//! Now Playing (SMTC) integration.
//!
//! Reads the current media session through the Windows System Media Transport
//! Controls (`GlobalSystemMediaTransportControlsSessionManager`) and exposes it
//! to the frontend as:
//!   * a pushed `now-playing-update` event whenever the state meaningfully
//!     changes (track / play-pause / ~1 Hz position while playing), and
//!   * a `get_now_playing` command for the initial render.
//! Playback control (previous / play-pause / next) is exposed as commands.
//!
//! ## Threading / performance
//! All WinRT work happens on **one dedicated MTA thread** so we never touch COM
//! apartments from Tauri's command pool. That thread owns the session manager
//! and drives an *adaptive poll*: it wakes on a command, or after a timeout of
//! 1 s while music is playing (to keep the progress bar in sync) / 2 s otherwise.
//! When nothing is playing the poll is a single cheap WinRT call, so idle CPU
//! stays well under 1 %. The frontend interpolates the progress bar locally from
//! `position_ms` + wall-clock delta, so smooth progress needs no extra traffic.
//!
//! Event-driven `PlaybackInfoChanged` subscriptions would cut external-change
//! latency below the poll interval; that's a deliberate future optimization.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// A snapshot of the current media session, shared with the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// Whether any media session is currently available.
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "playing" | "paused" | "stopped" | "none".
    pub status: String,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_play_pause: bool,
    /// Playback position (ms) at the instant `updated_at_ms` was sampled.
    pub position_ms: i64,
    pub duration_ms: i64,
    /// Unix epoch ms when `position_ms` was read — the frontend anchors its
    /// local interpolation to this so the progress bar advances smoothly.
    pub updated_at_ms: i64,
    /// Stable hash of title+artist+album; changes exactly when the track does.
    pub track_id: String,
    /// True when `cover` in this payload should replace the frontend's cached
    /// art (i.e. the track identity changed). When false, `cover` is omitted and
    /// the frontend keeps whatever it had — this avoids re-sending the (large)
    /// base64 image on every ~1 Hz position tick.
    pub cover_changed: bool,
    /// Data-URL of the cover art (`data:image/jpeg;base64,...`), when known.
    pub cover: Option<String>,
}

impl Default for NowPlaying {
    fn default() -> Self {
        NowPlaying {
            has_session: false,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            status: "none".into(),
            can_next: false,
            can_previous: false,
            can_play_pause: false,
            position_ms: 0,
            duration_ms: 0,
            updated_at_ms: 0,
            track_id: String::new(),
            cover_changed: true,
            cover: None,
        }
    }
}

/// Commands sent to the media worker thread.
pub enum MediaCmd {
    /// Re-read and (if changed) re-emit the current snapshot.
    Refresh,
    PlayPause,
    Next,
    Previous,
}

/// Shared, always-current full snapshot (with cover) for `get_now_playing`.
pub struct MediaShared {
    pub latest: Mutex<NowPlaying>,
}

/// Tauri-managed handle to the media subsystem.
pub struct MediaState {
    tx: Mutex<Sender<MediaCmd>>,
    shared: Arc<MediaShared>,
}

impl MediaState {
    fn send(&self, cmd: MediaCmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn track_hash(title: &str, artist: &str, album: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    title.hash(&mut h);
    0u8.hash(&mut h);
    artist.hash(&mut h);
    0u8.hash(&mut h);
    album.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Signature used to decide whether a change is worth emitting. Excludes
/// `updated_at_ms` (always changes) and the cover blob; buckets the position so
/// a playing track emits ~1 Hz but a paused one stays quiet (idle-friendly).
fn signature(n: &NowPlaying) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        n.has_session,
        n.status,
        n.track_id,
        n.duration_ms,
        n.can_next,
        n.can_previous,
        n.can_play_pause,
        n.position_ms / 500,
        n.cover_changed as u8,
    )
}

// ---------------------------------------------------------------------------
// Public API: spawn + Tauri commands
// ---------------------------------------------------------------------------

/// Initialize the media subsystem: create the worker thread and return the
/// Tauri-managed state. Call once from `setup`.
pub fn init(app: &AppHandle) -> MediaState {
    let (tx, rx) = std::sync::mpsc::channel::<MediaCmd>();
    let shared = Arc::new(MediaShared {
        latest: Mutex::new(NowPlaying::default()),
    });
    spawn_worker(app.clone(), rx, shared.clone());
    MediaState {
        tx: Mutex::new(tx),
        shared,
    }
}

#[tauri::command]
pub fn get_now_playing(state: State<'_, MediaState>) -> NowPlaying {
    // Return the cached snapshot instantly, and nudge the worker to re-read so
    // a fresh `now-playing-update` event follows shortly after the frontend
    // mounts (covers the case where a track started before the UI subscribed).
    let snapshot = state.shared.latest.lock().unwrap().clone();
    state.send(MediaCmd::Refresh);
    snapshot
}

#[tauri::command]
pub fn media_play_pause(state: State<'_, MediaState>) {
    state.send(MediaCmd::PlayPause);
}

#[tauri::command]
pub fn media_next(state: State<'_, MediaState>) {
    state.send(MediaCmd::Next);
}

#[tauri::command]
pub fn media_previous(state: State<'_, MediaState>) {
    state.send(MediaCmd::Previous);
}

// ---------------------------------------------------------------------------
// Worker thread
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn spawn_worker(app: AppHandle, rx: Receiver<MediaCmd>, shared: Arc<MediaShared>) {
    std::thread::spawn(move || {
        win::run(app, rx, shared);
    });
}

#[cfg(not(windows))]
fn spawn_worker(_app: AppHandle, rx: Receiver<MediaCmd>, _shared: Arc<MediaShared>) {
    // Non-Windows: drain commands so senders never block; no media backend.
    std::thread::spawn(move || while rx.recv().is_ok() {});
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use windows::core::{Interface, RuntimeType};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProps,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    };
    use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows_future::{AsyncStatus, IAsyncOperation};

    /// Block the current (MTA worker) thread until a WinRT async op completes.
    ///
    /// windows-rs 0.3's `IAsyncOperation` is async-only (no inherent `get()`),
    /// so we poll `Status()` and then fetch `GetResults()`. SMTC operations are
    /// local IPC that finish in well under a frame, and this only runs on our
    /// dedicated worker thread, so a short poll is cheap and never blocks the UI.
    fn block_on<T: RuntimeType>(op: IAsyncOperation<T>) -> windows::core::Result<T> {
        loop {
            match op.Status()? {
                AsyncStatus::Started => std::thread::sleep(Duration::from_millis(4)),
                _ => return op.GetResults(),
            }
        }
    }

    pub fn run(app: AppHandle, rx: Receiver<MediaCmd>, shared: Arc<MediaShared>) {
        // WinRT needs an initialized apartment on this thread. MTA lets SMTC's
        // async operations complete without us pumping a message loop.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        // The manager is agile and long-lived; hold it for the app's lifetime.
        let manager = match SessionManager::RequestAsync().and_then(block_on) {
            Ok(m) => m,
            Err(_) => {
                // SMTC unavailable (very old Windows, or request failed). Leave
                // the default "no session" snapshot; the module stays inactive.
                while rx.recv().is_ok() {}
                return;
            }
        };

        let mut last_sig = String::new();
        let mut last_track_id = String::new();
        let mut playing = false;

        // Read once immediately so `get_now_playing` has real data at startup.
        emit_cycle(
            &app,
            &manager,
            &shared,
            &mut last_sig,
            &mut last_track_id,
            &mut playing,
        );

        loop {
            let timeout = if playing {
                Duration::from_millis(1000)
            } else {
                Duration::from_millis(2000)
            };
            match rx.recv_timeout(timeout) {
                Ok(cmd) => {
                    match cmd {
                        MediaCmd::PlayPause => control(&manager, Ctrl::PlayPause),
                        MediaCmd::Next => control(&manager, Ctrl::Next),
                        MediaCmd::Previous => control(&manager, Ctrl::Previous),
                        // Force the next read to emit even if nothing changed, so
                        // a frontend that subscribed late still receives current
                        // state.
                        MediaCmd::Refresh => last_sig.clear(),
                    }
                    // A control usually only takes effect a beat later; a short
                    // settle read makes our own button presses feel instant.
                    std::thread::sleep(Duration::from_millis(60));
                    emit_cycle(
                        &app,
                        &manager,
                        &shared,
                        &mut last_sig,
                        &mut last_track_id,
                        &mut playing,
                    );
                }
                Err(RecvTimeoutError::Timeout) => {
                    emit_cycle(
                        &app,
                        &manager,
                        &shared,
                        &mut last_sig,
                        &mut last_track_id,
                        &mut playing,
                    );
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    enum Ctrl {
        PlayPause,
        Next,
        Previous,
    }

    fn control(manager: &SessionManager, which: Ctrl) {
        let Some(session) = current_session(manager) else {
            return;
        };
        match which {
            Ctrl::PlayPause => {
                if let Ok(op) = session.TryTogglePlayPauseAsync() {
                    let _ = block_on(op);
                }
            }
            Ctrl::Next => {
                if let Ok(op) = session.TrySkipNextAsync() {
                    let _ = block_on(op);
                }
            }
            Ctrl::Previous => {
                if let Ok(op) = session.TrySkipPreviousAsync() {
                    let _ = block_on(op);
                }
            }
        }
    }

    /// Resolve the current session, treating both an `Err` and a null interface
    /// (no active player) as "none".
    fn current_session(manager: &SessionManager) -> Option<Session> {
        let session = manager.GetCurrentSession().ok()?;
        if session.as_raw().is_null() {
            return None;
        }
        Some(session)
    }

    /// Read the live snapshot, update the shared cache, and emit if it changed.
    fn emit_cycle(
        app: &AppHandle,
        manager: &SessionManager,
        shared: &Arc<MediaShared>,
        last_sig: &mut String,
        last_track_id: &mut String,
        playing: &mut bool,
    ) {
        let (emit_payload, full, is_playing) = read(manager, last_track_id);
        *playing = is_playing;

        // Keep the always-full snapshot for the initial `get_now_playing`.
        if let Ok(mut guard) = shared.latest.lock() {
            *guard = full;
        }

        let sig = signature(&emit_payload);
        if sig != *last_sig {
            *last_sig = sig;
            let _ = app.emit("now-playing-update", &emit_payload);
        }
    }

    /// Returns `(emit_payload, full_snapshot, is_playing)`.
    ///
    /// `emit_payload` carries the cover only when the track identity changed;
    /// `full_snapshot` always carries the last-known cover (for `get_now_playing`).
    fn read(manager: &SessionManager, last_track_id: &mut String) -> (NowPlaying, NowPlaying, bool) {
        // Cache the last cover so we don't re-decode the thumbnail every tick.
        thread_local! {
            static COVER: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
            // How many times we've tried to fetch the current track's thumbnail.
            // Some players (esp. domestic music apps) expose the SMTC thumbnail a
            // beat *after* the metadata, so we retry across ticks until it lands.
            static ATTEMPTS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
        }

        let Some(session) = current_session(manager) else {
            *last_track_id = String::new();
            COVER.with(|c| *c.borrow_mut() = None);
            ATTEMPTS.with(|a| a.set(0));
            let none = NowPlaying::default();
            return (none.clone(), none, false);
        };

        // Playback status + capabilities.
        let (status, is_playing, can_next, can_prev, can_pp) = match session.GetPlaybackInfo() {
            Ok(info) => {
                let st = info.PlaybackStatus().unwrap_or(PlaybackStatus::Closed);
                let (label, is_playing) = match st {
                    PlaybackStatus::Playing => ("playing", true),
                    PlaybackStatus::Paused => ("paused", false),
                    _ => ("stopped", false),
                };
                let (n, p, pp) = match info.Controls() {
                    Ok(c) => (
                        c.IsNextEnabled().unwrap_or(false),
                        c.IsPreviousEnabled().unwrap_or(false),
                        c.IsPlayEnabled().unwrap_or(false)
                            || c.IsPauseEnabled().unwrap_or(false)
                            || c.IsPlayPauseToggleEnabled().unwrap_or(false),
                    ),
                    Err(_) => (false, false, false),
                };
                (label, is_playing, n, p, pp)
            }
            Err(_) => ("stopped", false, false, false, false),
        };

        // Timeline (position / duration), in ms.
        let (position_ms, duration_ms) = match session.GetTimelineProperties() {
            Ok(t) => {
                let pos = t.Position().map(|d| d.Duration / 10_000).unwrap_or(0);
                let end = t.EndTime().map(|d| d.Duration / 10_000).unwrap_or(0);
                (pos.max(0), end.max(0))
            }
            Err(_) => (0, 0),
        };

        // Metadata (title / artist / album / cover). On a track-identity change
        // we forget the old art and (re)start acquisition; `cover_changed` marks
        // any cycle where the frontend's cached art must change. Because a player
        // may publish the thumbnail slightly after the metadata, we keep retrying
        // `read_cover` on later ticks (up to MAX_COVER_ATTEMPTS) until valid art
        // arrives, then push it once — instead of locking in an early empty/broken
        // thumbnail for the whole track.
        const MAX_COVER_ATTEMPTS: u32 = 10;
        let mut cover_changed = false;
        let (title, artist, album) = match session
            .TryGetMediaPropertiesAsync()
            .and_then(block_on)
        {
            Ok(props) => {
                let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
                let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
                let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();
                let track_id = track_hash(&title, &artist, &album);
                if track_id != *last_track_id {
                    // New track: drop stale art immediately (frontend falls back to
                    // the placeholder) and restart the acquisition attempts.
                    *last_track_id = track_id;
                    COVER.with(|c| *c.borrow_mut() = None);
                    ATTEMPTS.with(|a| a.set(0));
                    cover_changed = true;
                }
                // Keep trying until we have valid art (a cheap no-op afterwards).
                let have_cover = COVER.with(|c| c.borrow().is_some());
                if !have_cover {
                    let n = ATTEMPTS.with(|a| {
                        let v = a.get() + 1;
                        a.set(v);
                        v
                    });
                    if n <= MAX_COVER_ATTEMPTS {
                        if let Some(cover) = read_cover(&props) {
                            COVER.with(|c| *c.borrow_mut() = Some(cover));
                            cover_changed = true;
                        }
                    }
                }
                (title, artist, album)
            }
            Err(_) => (String::new(), String::new(), String::new()),
        };

        let track_id = track_hash(&title, &artist, &album);
        let updated_at_ms = now_unix_ms();
        let cover_now = COVER.with(|c| c.borrow().clone());

        let base = NowPlaying {
            has_session: true,
            title,
            artist,
            album,
            status: status.to_string(),
            can_next,
            can_previous: can_prev,
            can_play_pause: can_pp,
            position_ms,
            duration_ms,
            updated_at_ms,
            track_id,
            // Emitted payload: send the cover only on the identity-change cycle.
            cover_changed,
            cover: if cover_changed { cover_now.clone() } else { None },
        };

        // Full snapshot for `get_now_playing`: always carries the current cover.
        let full = NowPlaying {
            cover_changed: true,
            cover: cover_now,
            ..base.clone()
        };

        (base, full, is_playing)
    }

    /// Decode the session thumbnail into a `data:` URL, or `None` when there is
    /// no usable art yet. Bounded in size so a pathological cover can't blow up
    /// IPC, and validated by magic bytes so we never hand the WebView an
    /// undecodable blob (which would render as the browser's "broken image").
    fn read_cover(props: &MediaProps) -> Option<String> {
        let thumb: IRandomAccessStreamReference = props.Thumbnail().ok()?;
        let stream = block_on(thumb.OpenReadAsync().ok()?).ok()?;
        let size = stream.Size().ok()?;
        // Reject empty / implausibly tiny / oversized thumbnails. Many players
        // briefly expose a 0-byte (or placeholder) thumbnail right after the
        // metadata changes; treating those as "not ready" lets the caller retry.
        if size < 100 || size > 6_000_000 {
            return None;
        }
        let input = stream.GetInputStreamAt(0).ok()?;
        let reader = DataReader::CreateDataReader(&input).ok()?;
        block_on(reader.LoadAsync(size as u32).ok()?).ok()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).ok()?;
        // Derive the MIME from the magic bytes rather than trusting ContentType
        // (some players report it incorrectly). Unknown/garbage → None → retry.
        let mime = sniff_image_mime(&buf)?;
        Some(format!("data:{};base64,{}", mime, STANDARD.encode(&buf)))
    }

    /// Identify a raster image by its leading magic bytes; returns the canonical
    /// MIME type, or `None` if the buffer is not a recognized image format.
    fn sniff_image_mime(buf: &[u8]) -> Option<&'static str> {
        if buf.len() >= 3 && buf[..3] == [0xFF, 0xD8, 0xFF] {
            return Some("image/jpeg");
        }
        if buf.len() >= 8 && buf[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
            return Some("image/png");
        }
        if buf.len() >= 6 && (&buf[..6] == b"GIF87a" || &buf[..6] == b"GIF89a") {
            return Some("image/gif");
        }
        if buf.len() >= 2 && &buf[..2] == b"BM" {
            return Some("image/bmp");
        }
        if buf.len() >= 12 && &buf[..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
            return Some("image/webp");
        }
        None
    }
}
