/**
 * File Shelf (M4d).
 *
 * A panel-only module: a drop zone in the expanded panel where files can be
 * stashed temporarily and retrieved later. Items persist to disk (shelf.json)
 * so the shelf survives restarts until the user removes them.
 *
 * Getting files back:
 *   - "打开" opens the file with its default app.
 *   - "定位" reveals it in File Explorer.
 *   - Items are HTML5-draggable as a best-effort drag-out (drops the path as
 *     text / file URI; true OLE file drag-out onto Explorer is a future add).
 *
 * Stashing files: OS drag-drop onto the expanded panel, or the "添加文件"
 * button (native file dialog) as a always-reliable path.
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { registerModule } from "./registry";
import type { IslandModuleProps } from "./types";

interface ShelfItem {
  path: string;
  name: string;
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

function persist(items: ShelfItem[]): Promise<void> {
  return store
    .set(K_ITEMS, items)
    .then(() => store.save())
    .catch(() => {});
}

interface ShelfStore {
  items: ShelfItem[];
  hydrated: boolean;
  add: (paths: string[]) => void;
  remove: (path: string) => void;
  hydrate: () => Promise<void>;
}

const useShelf = create<ShelfStore>((set, get) => ({
  items: [],
  hydrated: false,
  add: (paths) => {
    const cur = get().items;
    const seen = new Set(cur.map((i) => i.path));
    const next = [...cur];
    for (const p of paths) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      next.push({ path: p, name: baseName(p) });
    }
    if (next.length !== cur.length) {
      set({ items: next });
      void persist(next);
    }
  },
  remove: (path) => {
    const next = get().items.filter((i) => i.path !== path);
    set({ items: next });
    void persist(next);
  },
  hydrate: async () => {
    try {
      const saved = await store.get<ShelfItem[]>(K_ITEMS);
      if (Array.isArray(saved)) set({ items: saved });
    } catch {
      /* keep empty */
    }
    set({ hydrated: true });
  },
}));

function ShelfTile(_props: IslandModuleProps) {
  const items = useShelf((s) => s.items);
  const add = useShelf((s) => s.add);
  const remove = useShelf((s) => s.remove);
  const [over, setOver] = useState(false);
  // `add` is a stable zustand action, but capture via ref so the drop listener
  // effect can run exactly once (not re-subscribe on every render).
  const addRef = useRef(add);
  addRef.current = add;

  useEffect(() => {
    if (!useShelf.getState().hydrated) void useShelf.getState().hydrate();
    let un: (() => void) | undefined;
    let alive = true;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") setOver(true);
        else if (p.type === "leave") setOver(false);
        else if (p.type === "drop") {
          setOver(false);
          if (p.paths?.length) addRef.current(p.paths);
        }
      })
      .then((f) => {
        if (alive) un = f;
        else f();
      });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  const pickFiles = async () => {
    try {
      const sel = await openDialog({ multiple: true, title: "添加到暂存架" });
      if (!sel) return;
      addRef.current(Array.isArray(sel) ? sel : [sel]);
    } catch {
      /* user cancelled or dialog unavailable */
    }
  };

  return (
    <div
      className={`sys-tile shelf-tile${over ? " drag-over" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="shelf-head">
        <span className="shelf-title">📎 暂存架</span>
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
      </div>

      {items.length === 0 ? (
        <div className="shelf-empty">拖拽文件到这里暂存，或点击 ＋ 添加</div>
      ) : (
        <ul className="shelf-list">
          {items.map((it) => (
            <li
              key={it.path}
              className="shelf-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", it.path);
                e.dataTransfer.setData("text/uri-list", fileUrl(it.path));
              }}
            >
              <span className="shelf-file-icon">📄</span>
              <span className="shelf-file-name" title={it.path}>
                {it.name}
              </span>
              <span className="shelf-item-actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void openPath(it.path).catch(() => {});
                  }}
                  title="打开"
                >
                  ↗
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void revealItemInDir(it.path).catch(() => {});
                  }}
                  title="在资源管理器中定位"
                >
                  📁
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(it.path);
                  }}
                  title="移除"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
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
