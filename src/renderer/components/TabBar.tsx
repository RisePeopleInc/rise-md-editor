import { useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import type { Tab } from '../state/fileState';

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function basenameOf(p: string | null): string {
  if (!p) return 'Untitled';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

function pathSegments(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

interface TabLabel {
  /** The basename, shown prominently. */
  name: string;
  /** Optional parent-dir suffix shown muted, only when needed for disambiguation. */
  suffix: string | null;
}

/**
 * Compute display labels for the tab bar so two tabs with the same
 * basename (`CLAUDE.md`, `index.ts`, `README.md`, …) can still be told
 * apart at a glance. Mirrors VS Code's "minimal differentiating
 * suffix" approach: walk up the parent directories until the joined
 * suffix is unique among the colliding group.
 *
 * - Single tab in a basename group → `name: 'CLAUDE.md', suffix: null`.
 * - Two tabs colliding in workspace-a/CLAUDE.md and workspace-b/CLAUDE.md
 *   → suffix `workspace-a` and `workspace-b`.
 * - Untitled tabs are numbered when there is more than one.
 */
export function computeTabLabels(tabs: readonly Tab[]): TabLabel[] {
  const result: TabLabel[] = new Array(tabs.length);

  // Group indices by basename so we only walk parents for actual collisions.
  const groups = new Map<string, number[]>();
  tabs.forEach((tab, i) => {
    const key = tab.path ? basenameOf(tab.path) : '__untitled__';
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });

  for (const [key, indices] of groups) {
    if (key === '__untitled__') {
      // Singletons keep "Untitled"; multiples get "Untitled 1/2/3…" in
      // tab-bar order so the user can differentiate them by position.
      if (indices.length === 1) {
        result[indices[0]!] = { name: 'Untitled', suffix: null };
      } else {
        indices.forEach((idx, n) => {
          result[idx] = { name: `Untitled ${n + 1}`, suffix: null };
        });
      }
      continue;
    }

    const name = key;
    if (indices.length === 1) {
      result[indices[0]!] = { name, suffix: null };
      continue;
    }

    // Multiple tabs share this basename — walk up segment by segment
    // until each tab's parent-suffix is unique within the group.
    const segs = indices.map((i) => pathSegments(tabs[i]!.path!));
    for (const i of indices) {
      const j = indices.indexOf(i);
      const mySegs = segs[j]!;
      // Maximum depth we can search: this path's segments minus the
      // basename. Also bound by the deepest other path in the group.
      const maxDepth = Math.max(...segs.map((s) => s.length - 1));
      let suffix: string | null = null;
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        // Take the `depth` parent segments immediately above the basename.
        const start = Math.max(0, mySegs.length - 1 - depth);
        const mine = mySegs.slice(start, mySegs.length - 1).join('/');
        const isUnique = segs.every((other, k) => {
          if (k === j) return true;
          const oStart = Math.max(0, other.length - 1 - depth);
          const otherSuffix = other.slice(oStart, other.length - 1).join('/');
          return otherSuffix !== mine;
        });
        if (isUnique) {
          suffix = mine;
          break;
        }
      }
      // Fallback: show the full parent path (rare — would require two
      // identical absolute paths, which loadFile dedupes anyway).
      if (suffix === null) {
        suffix = mySegs.slice(0, -1).join('/') || '/';
      }
      result[i] = { name, suffix };
    }
  }

  return result;
}

const DRAG_MIME = 'application/x-raise-tab-index';

export function TabBar({ tabs, activeTabId, onActivate, onClose, onReorder }: TabBarProps) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const labels = useMemo(() => computeTabLabels(tabs), [tabs]);

  if (tabs.length === 0) return null;

  const handleDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.dataTransfer.setData(DRAG_MIME, String(index));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, toIndex: number) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const fromIndex = Number(e.dataTransfer.getData(DRAG_MIME));
    setDragOverIndex(null);
    if (Number.isFinite(fromIndex) && fromIndex !== toIndex) {
      onReorder(fromIndex, toIndex);
    }
  };

  return (
    <div
      role="tablist"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-slate-800 bg-slate-950 select-none"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const isDirty = tab.content !== tab.savedContent;
        const showDropMarker = dragOverIndex === index && tab.id !== activeTabId;
        const label = labels[index]!;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
            onClick={() => onActivate(tab.id)}
            onAuxClick={(e: MouseEvent<HTMLDivElement>) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            className={[
              'group relative flex shrink-0 cursor-pointer items-center gap-2 border-r border-slate-800 px-3 py-1.5 text-xs',
              isActive
                ? 'bg-slate-800 text-slate-100'
                : 'bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-200',
              showDropMarker ? 'ring-1 ring-inset ring-brand-500' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={tab.path ?? 'Untitled'}
          >
            <span aria-hidden="true" className="text-xs opacity-70">
              ⓜ
            </span>
            <span className="flex max-w-[18rem] min-w-0 items-baseline gap-1.5">
              <span className="truncate">{label.name}</span>
              {label.suffix && (
                <span className="shrink-0 truncate text-[10px] opacity-50">
                  {label.suffix}
                </span>
              )}
            </span>
            <button
              type="button"
              aria-label={isDirty ? 'Close (unsaved changes)' : 'Close'}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={[
                'flex h-4 w-4 shrink-0 items-center justify-center rounded text-[11px] leading-none transition',
                isActive
                  ? 'text-slate-300 hover:bg-slate-700 hover:text-slate-100'
                  : 'text-slate-500 hover:bg-slate-800 hover:text-slate-200',
                isDirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              ].join(' ')}
            >
              {isDirty ? '●' : '×'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
