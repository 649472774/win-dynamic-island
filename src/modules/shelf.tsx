/**
 * File Shelf (M4d) — Yoink-style.
 *
 * A temporary staging shelf living in the expanded panel. It holds *references*
 * to files (paths, not copies) plus optional text snippets, and persists to disk
 * (shelf.json) so it survives restarts until you remove items.
 *
 * How it works (mirrors macOS Yoink / Dropover):
 *   - Drag any file(s) toward the island → the moment the OS drag enters the
 *     window the island auto-expands into a big drop target (see `useShelfDrag`,
 *     wired app-level from the Island so it's always listening, even while the
 *     pill is collapsed). Let go to stash them.
 *   - "＋" opens a native file dialog (always-reliable path).
 *   - "从剪贴板添加" pulls files or text off the clipboard.
 *
 * Getting things back out:
 *   - "复制" puts the real file(s) on the clipboard as CF_HDROP — paste into any
 *     Explorer folder for a true file copy (the reliable Windows equivalent of
 *     Yoink's drag-out). Text items copy as plain text.
 *   - "打开" opens with the default app; "定位" reveals in Explorer.
 *   - File rows stay HTML5-draggable as a best-effort drag-out onto other apps.
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";
import { useIsland } from "../store/island";
import { clipboardCopyFiles, clipboardCopyText, clipboardRead, rearmDropTarget } from "../lib/native";

type ShelfKind = "file" | "text";

interface ShelfItem {
  /** Stable id: the path for files, a random uuid for text snippets. */
  id: string;
  kind: ShelfKind;
  /** Display label (basename for files, first line for text). */
  name: string;
  /** File path (file items only). */
  path?: string;
  /** Snippet body (text items only). */
  text?: string;
}

const store = new LazyStore("shelf.json");
const K_ITEMS = "items";

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function fileUrl(p: string): string {
  return "file:///" + p.replace(/\\/g, "/");
}

type FileCat =
  | "img" | "pdf" | "doc" | "sheet" | "ppt" | "zip" | "code" | "audio" | "video" | "default";

/** Derive a short badge label + color category + Chinese type name from a filename. */
function fileMeta(name: string): { badge: string; cat: FileCat; type: string } {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const groups: Array<[FileCat, string, string[]]> = [
    ["img", "图片", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "ico", "tif", "tiff"]],
    ["pdf", "PDF", ["pdf"]],
    ["doc", "文档", ["doc", "docx", "txt", "md", "rtf", "odt", "pages"]],
    ["sheet", "表格", ["xls", "xlsx", "csv", "numbers", "ods"]],
    ["ppt", "幻灯片", ["ppt", "pptx", "key", "odp"]],
    ["zip", "压缩包", ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]],
    ["code", "代码", [
      "js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "hpp",
      "cs", "rb", "php", "css", "scss", "html", "json", "yaml", "yml", "toml", "xml", "sh",
    ]],
    ["audio", "音频", ["mp3", "wav", "flac", "aac", "ogg", "m4a"]],
    ["video", "视频", ["mp4", "mov", "avi", "mkv", "webm", "flv"]],
  ];
  for (const [cat, type, exts] of groups) {
    if (exts.includes(ext)) return { badge: ext.slice(0, 4).toUpperCase(), cat, type };
  }
  return {
    badge: ext ? ext.slice(0, 4).toUpperCase() : "•",
    cat: "default",
    type: ext ? ext.toUpperCase() : "文件",
  };
}

/** First non-empty line, trimmed and clipped, for a text item's label. */
function textLabel(t: string): string {
  const line = t.split(/\r?\n/).find((l) => l.trim()) ?? t;
  const s = line.trim();
  return s.length > 40 ? s.slice(0, 40) + "…" : s || "文本片段";
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "t-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }
}

/** Normalize any persisted (possibly legacy `{path,name}`) entry into a full
 *  ShelfItem, dropping anything unusable. */
function normalize(raw: unknown): ShelfItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "text" && typeof o.text === "string") {
    return {
      id: typeof o.id === "string" ? o.id : newId(),
      kind: "text",
      name: typeof o.name === "string" ? o.name : textLabel(o.text),
      text: o.text,
    };
  }
  const path = typeof o.path === "string" ? o.path : null;
  if (!path) return null;
  return {
    id: path,
    kind: "file",
    name: typeof o.name === "string" ? o.name : baseName(path),
    path,
  };
}

function persist(items: ShelfItem[]): Promise<void> {
  return store
    .set(K_ITEMS, items)
    .then(() => store.save())
    .catch(() => {});
}

interface ShelfStore {
  items: ShelfItem[];
  hydrated: boolean;
  addFiles: (paths: string[]) => number;
  addText: (text: string) => boolean;
  remove: (id: string) => void;
  clear: () => void;
  hydrate: () => Promise<void>;
}

const useShelf = create<ShelfStore>((set, get) => ({
  items: [],
  hydrated: false,
  addFiles: (paths) => {
    const cur = get().items;
    const seen = new Set(cur.filter((i) => i.kind === "file").map((i) => i.path));
    const next = [...cur];
    let added = 0;
    for (const p of paths) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      next.push({ id: p, kind: "file", name: baseName(p), path: p });
      added++;
    }
    if (added) {
      set({ items: next });
      void persist(next);
    }
    return added;
  },
  addText: (text) => {
    const t = text?.trim();
    if (!t) return false;
    const item: ShelfItem = { id: newId(), kind: "text", name: textLabel(t), text: t };
    const next = [...get().items, item];
    set({ items: next });
    void persist(next);
    return true;
  },
  remove: (id) => {
    const next = get().items.filter((i) => i.id !== id);
    set({ items: next });
    void persist(next);
  },
  clear: () => {
    if (!get().items.length) return;
    set({ items: [] });
    void persist([]);
  },
  hydrate: async () => {
    try {
      const saved = await store.get<unknown[]>(K_ITEMS);
      if (Array.isArray(saved)) {
        const items = saved.map(normalize).filter((x): x is ShelfItem => !!x);
        set({ items });
      }
    } catch {
      /* keep empty */
    }
    set({ hydrated: true });
  },
}));

/**
 * App-level drag catcher — call this once from the always-mounted Island shell.
 *
 * The OS drag-drop modal loop never fires DOM `mouseenter`, and wry's built-in
 * `onDragDropEvent` never fires at all on our transparent (layered) window. So a
 * native `IDropTarget` in Rust (see `src-tauri/src/dragdrop.rs`) forwards the OS
 * drag gesture to us as custom Tauri events: on `shelf-drag-enter` we flip
 * `dragActive` (force-expanding the panel into a large drop target), on
 * `shelf-drop` we stash the files, and on `shelf-drag-leave` we release and let
 * the island linger-collapse.
 */
export function useShelfDrag() {
  useEffect(() => {
    if (!useShelf.getState().hydrated) void useShelf.getState().hydrate();
    // Re-arm the native drop target on every mount. A webview reload (e.g. a
    // Vite HMR full reload after editing this file) can recreate WebView2's
    // child HWND and orphan the OLE registration from the startup burst, which
    // silently breaks drag-in over the panel body. This restores it.
    void rearmDropTarget().catch(() => {});
    let alive = true;
    const uns: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      void p.then((f) => (alive ? uns.push(f) : f()));
    };

    track(listen("shelf-drag-enter", () => useIsland.getState().setDragActive(true)));
    track(listen("shelf-drag-leave", () => useIsland.getState().setDragActive(false)));
    track(
      listen<string[]>("shelf-drop", (event) => {
        useIsland.getState().setDragActive(false);
        const paths = event.payload;
        if (paths?.length) useShelf.getState().addFiles(paths);
      }),
    );

    return () => {
      alive = false;
      uns.forEach((f) => f());
    };
  }, []);
}

function ShelfTile(_props: IslandModuleProps) {
  const items = useShelf((s) => s.items);
  const addFiles = useShelf((s) => s.addFiles);
  const addText = useShelf((s) => s.addText);
  const remove = useShelf((s) => s.remove);
  const clear = useShelf((s) => s.clear);
  const [note, setNote] = useState<string>("");
  const [noteShow, setNoteShow] = useState<boolean>(false);
  const noteTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!useShelf.getState().hydrated) void useShelf.getState().hydrate();
    return () => {
      if (noteTimer.current) window.clearTimeout(noteTimer.current);
    };
  }, []);

  const flash = (msg: string) => {
    setNote(msg);
    setNoteShow(true);
    // Keep the text mounted and only toggle visibility so the pill can fade/slide
    // out cleanly (an unmount would kill the exit animation). The floating pill is
    // absolutely positioned, so showing/hiding it never reflows the panel — no
    // more "整个岛回缩抖动".
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNoteShow(false), 1400);
  };

  const fileItems = items.filter((i) => i.kind === "file");

  const pickFiles = async () => {
    try {
      const sel = await openDialog({ multiple: true, title: "添加到暂存架" });
      if (!sel) return;
      const n = addFiles(Array.isArray(sel) ? sel : [sel]);
      if (n) flash(`已添加 ${n} 个文件`);
    } catch {
      /* user cancelled or dialog unavailable */
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const data = await clipboardRead();
      if (data.files?.length) {
        const n = addFiles(data.files);
        flash(n ? `从剪贴板添加 ${n} 个文件` : "文件已在架上");
      } else if (data.text?.trim()) {
        addText(data.text);
        flash("已添加文本片段");
      } else {
        flash("剪贴板为空");
      }
    } catch {
      flash("读取剪贴板失败");
    }
  };

  const copyAll = async () => {
    try {
      if (fileItems.length) {
        await clipboardCopyFiles(fileItems.map((i) => i.path!));
        flash(`已复制 ${fileItems.length} 个文件，可粘贴到资源管理器`);
      } else {
        const text = items
          .filter((i) => i.kind === "text")
          .map((i) => i.text!)
          .join("\n");
        if (!text) return;
        await clipboardCopyText(text);
        flash("已复制全部文本");
      }
    } catch {
      flash("复制失败");
    }
  };

  const copyOne = async (it: ShelfItem) => {
    try {
      if (it.kind === "file") {
        await clipboardCopyFiles([it.path!]);
        flash("已复制文件，可粘贴到资源管理器");
      } else {
        await clipboardCopyText(it.text!);
        flash("已复制文本");
      }
    } catch {
      flash("复制失败");
    }
  };

  return (
    <div className="sys-tile shelf-tile" onClick={(e) => e.stopPropagation()}>
      <div className="shelf-head">
        <span className="shelf-title">📎 暂存架</span>
        <span className="shelf-count">{items.length ? `${items.length} 项` : ""}</span>
        <span className="shelf-head-actions">
          <button
            className="shelf-add"
            onClick={(e) => {
              e.stopPropagation();
              void pasteFromClipboard();
            }}
            title="从剪贴板添加文件 / 文本"
          >
            📋
          </button>
          <button
            className="shelf-add"
            onClick={(e) => {
              e.stopPropagation();
              void pickFiles();
            }}
            title="添加文件"
          >
            ＋
          </button>
        </span>
      </div>

      <div
        className={`shelf-toast${noteShow ? " show" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="shelf-toast-dot">●</span>
        <span className="shelf-toast-msg">{note}</span>
      </div>

      {items.length === 0 ? (
        <div className="shelf-empty">
          把文件拖向灵动岛即可暂存（拖近会自动展开），或点 ＋ / 📋 添加
        </div>
      ) : (
        <>
          <div className="shelf-cards">
            {items.map((it) => {
              if (it.kind === "file") {
                const m = fileMeta(it.name);
                return (
                  <div
                    key={it.id}
                    className="shelf-card kind-file"
                    draggable
                    title={it.path}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", it.path!);
                      e.dataTransfer.setData("text/uri-list", fileUrl(it.path!));
                    }}
                  >
                    <button
                      className="shelf-card-x"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(it.id);
                      }}
                      title="移除"
                    >
                      ✕
                    </button>
                    <span className={`shelf-badge ext-${m.cat}`}>{m.badge}</span>
                    <span className="shelf-card-name">{it.name}</span>
                    <span className="shelf-card-meta">{m.type}</span>
                    <div className="shelf-card-actions">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyOne(it);
                        }}
                        title="复制文件（粘贴到资源管理器）"
                      >
                        ⧉
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void openPath(it.path!).catch(() => {});
                        }}
                        title="打开"
                      >
                        ↗
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void revealItemInDir(it.path!).catch(() => {});
                        }}
                        title="在资源管理器中定位"
                      >
                        📁
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={it.id} className="shelf-card kind-text" title={it.text}>
                  <button
                    className="shelf-card-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(it.id);
                    }}
                    title="移除"
                  >
                    ✕
                  </button>
                  <div className="shelf-text-body">{it.text}</div>
                  <div className="shelf-text-foot">📝 文本片段 · {(it.text ?? "").trim().length} 字</div>
                  <div className="shelf-card-actions">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyOne(it);
                      }}
                      title="复制文本"
                    >
                      ⧉
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="shelf-bulk">
            <button
              onClick={(e) => {
                e.stopPropagation();
                void copyAll();
              }}
              title="复制全部（文件可粘贴到资源管理器）"
            >
              全部复制
            </button>
            <button
              className="shelf-clear"
              onClick={(e) => {
                e.stopPropagation();
                clear();
              }}
              title="清空暂存架（不会删除原文件）"
            >
              清空
            </button>
          </div>
        </>
      )}
    </div>
  );
}

registerModule({
  id: "shelf",
  title: "暂存架",
  priority: 20,
  Tile: ShelfTile,
  // Panel-only: never owns the collapsed pill.
  isActive: () => false,
});
