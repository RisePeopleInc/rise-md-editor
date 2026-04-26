import { useCallback, type MouseEvent, type ReactNode } from 'react';

const MIN_WIDTH = 180;
const MAX_WIDTH = 400;

interface SidebarProps {
  width: number;
  onWidthChange: (width: number) => void;
  /** Persist the final width once the resize gesture ends. */
  onWidthCommit: (width: number) => void;
  rootName: string | null;
  onCollapseAll: () => void;
  onOpenFolder: () => void;
  children: ReactNode;
}

export function Sidebar({
  width,
  onWidthChange,
  onWidthCommit,
  rootName,
  onCollapseAll,
  onOpenFolder,
  children,
}: SidebarProps) {
  // Mouse-driven horizontal resize on the right edge. Document-level
  // listeners so dragging past the edge doesn't lose tracking; cleaned up
  // on mouseup or by AbortController if the component unmounts mid-drag.
  // Only the final width is persisted (onWidthCommit) — onWidthChange
  // fires every mousemove for visual feedback, so committing on each
  // would mean ~60 disk writes/sec via electron-store.
  const handleResizeStart = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let lastWidth = startWidth;
      const ac = new AbortController();
      document.addEventListener(
        'mousemove',
        (ev) => {
          const next = Math.max(
            MIN_WIDTH,
            Math.min(MAX_WIDTH, startWidth + (ev.clientX - startX)),
          );
          lastWidth = next;
          onWidthChange(next);
        },
        { signal: ac.signal },
      );
      document.addEventListener(
        'mouseup',
        () => {
          ac.abort();
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          // Persist the final width — only one electron-store write per
          // gesture, regardless of how many pixels the user dragged.
          if (lastWidth !== startWidth) onWidthCommit(lastWidth);
        },
        { signal: ac.signal },
      );
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, onWidthChange, onWidthCommit],
  );

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-slate-800 bg-slate-950"
      style={{ width }}
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-slate-300">
            {rootName ?? 'No folder open'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {rootName ? (
            <button
              type="button"
              title="Collapse all"
              onClick={onCollapseAll}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden
                fill="currentColor"
              >
                <path d="M2 5h8v2H2z" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenFolder}
              className="rounded bg-brand-500 px-2 py-0.5 text-[11px] font-medium text-slate-50 hover:bg-brand-600"
            >
              Open Folder
            </button>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-slate-700 active:bg-brand-500"
      />
    </aside>
  );
}
