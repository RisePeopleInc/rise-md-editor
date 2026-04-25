import { useState, type DragEvent, type MouseEvent } from 'react';
import type { Tab } from '../state/fileState';

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function basenameOf(path: string | null): string {
  if (!path) return 'Untitled';
  return path.split(/[\\/]/).pop() || path;
}

const DRAG_MIME = 'application/x-raise-tab-index';

export function TabBar({ tabs, activeTabId, onActivate, onClose, onReorder }: TabBarProps) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

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
            <span className="max-w-[14rem] truncate">{basenameOf(tab.path)}</span>
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
