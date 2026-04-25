import type { EditorMode } from '../../state/fileState';

interface ModeSwitcherProps {
  mode: EditorMode;
  onChange: (mode: EditorMode) => void;
}

const OPTIONS: ReadonlyArray<{ mode: EditorMode; label: string; title: string }> = [
  { mode: 'wysiwyg', label: 'Edit', title: 'WYSIWYG (Cmd+1)' },
  { mode: 'source', label: 'Code', title: 'Source (Cmd+2)' },
  { mode: 'split', label: 'Split', title: 'Split view (Cmd+3)' },
];

export function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Editor mode"
      className="inline-flex h-7 shrink-0 overflow-hidden rounded border border-slate-700 bg-slate-900 text-xs"
    >
      {OPTIONS.map((opt) => {
        const active = opt.mode === mode;
        return (
          <button
            key={opt.mode}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => onChange(opt.mode)}
            className={[
              'px-2.5 font-medium transition',
              active
                ? 'bg-slate-700 text-slate-50'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
