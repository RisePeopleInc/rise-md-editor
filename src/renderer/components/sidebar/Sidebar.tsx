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
  /** Close the open workspace and return to single-file mode. */
  onCloseFolder: () => void;
  onOpenFolder: () => void;
  children: ReactNode;
}

export function Sidebar({
  width,
  onWidthChange,
  onWidthCommit,
  rootName,
  onCollapseAll,
  onCloseFolder,
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
      className="relative flex h-full shrink-0 flex-col border-r border-stroke bg-surface"
      style={{ width }}
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-stroke px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-secondary">
            {rootName ?? 'No folder open'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {rootName ? (
            <>
              <button
                type="button"
                title="Collapse all folders"
                aria-label="Collapse all folders"
                onClick={onCollapseAll}
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-elevated hover:text-strong"
              >
                {/* Double up-chevron — reads as "fold everything up". */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7 L6 4 L9 7" />
                  <path d="M3 9 L6 6 L9 9" />
                </svg>
              </button>
              <button
                type="button"
                title="Close folder"
                aria-label="Close folder"
                onClick={onCloseFolder}
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-elevated hover:text-strong"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <path d="M3 3 L9 9 M9 3 L3 9" />
                </svg>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onOpenFolder}
              className="rounded bg-interaction px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-interaction-hover active:bg-interaction-active"
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
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-elevated active:bg-interaction"
      />
    </aside>
  );
}
