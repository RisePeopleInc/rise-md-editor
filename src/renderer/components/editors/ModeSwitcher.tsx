import type { EditorMode } from '../../state/fileState';

interface ModeSwitcherProps {
  mode: EditorMode;
  onChange: (mode: EditorMode) => void;
}

// RAISE-60: Read mode listed first. The user's framing was "the
// reading mode is the simplest thing — surface it leftmost so the
// reading-as-default OS-open path matches the leftmost pill chip."
// The accelerator block (`Cmd+0`/+1/+2/+3) is contiguous; existing
// Cmd+1/2/3 muscle memory for WYSIWYG/Source/Split is preserved.
const OPTIONS: ReadonlyArray<{ mode: EditorMode; label: string; title: string }> = [
  { mode: 'read', label: 'Read', title: 'Read (Cmd+0)' },
  { mode: 'wysiwyg', label: 'Edit', title: 'WYSIWYG (Cmd+1)' },
  { mode: 'source', label: 'Code', title: 'Source (Cmd+2)' },
  { mode: 'split', label: 'Split', title: 'Split view (Cmd+3)' },
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
