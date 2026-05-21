import type { EditorMode } from '../../state/fileState';

interface ModeSwitcherProps {
  mode: EditorMode;
  onChange: (mode: EditorMode) => void;
}

// RAISE-60: Read mode listed first. Accelerators line up with the
// pill order — `Cmd+1`..`Cmd+4` reads left-to-right across the chips
// so the digit on the keyboard matches the chip position. The pre-
// RAISE-60 binding was Cmd+1/2/3 = WYSIWYG/Source/Split with Read
// at Cmd+0; renumbered to match the pill, since the app is still
// pre-release and the consistency win is worth the small muscle-
// memory cost.
const OPTIONS: ReadonlyArray<{ mode: EditorMode; label: string; title: string }> = [
  { mode: 'read', label: 'Read', title: 'Read (Cmd+1)' },
  { mode: 'wysiwyg', label: 'Edit', title: 'WYSIWYG (Cmd+2)' },
  { mode: 'source', label: 'Code', title: 'Source (Cmd+3)' },
  { mode: 'split', label: 'Split', title: 'Split view (Cmd+4)' },
];

export function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Editor mode"
      className="inline-flex h-7 shrink-0 overflow-hidden rounded border border-stroke bg-surface text-xs"
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
              'px-2.5 font-semibold transition',
              active
                ? 'bg-interaction text-white'
                : 'text-muted hover:bg-elevated hover:text-secondary',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
