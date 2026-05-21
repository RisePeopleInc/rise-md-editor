// RAISE-60: added 'Read' alongside the existing labels. The
// statusbar shows a single string, so the label union is just the
// rendered text — not the same union as `EditorMode` in fileState.
export type EditorMode = 'Read' | 'Source' | 'WYSIWYG' | 'Split';

interface StatusBarProps {
  line: number;
  column: number;
  wordCount: number;
  encoding?: string;
  mode?: EditorMode;
}

export function StatusBar({
  line,
  column,
  wordCount,
  encoding = 'UTF-8',
  mode = 'Source',
}: StatusBarProps) {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-stroke bg-surface px-3 text-xs text-muted select-none">
      <div className="flex-1 text-left tabular-nums">
        Ln {line}, Col {column}
      </div>
      <div className="flex-1 text-center tabular-nums">{wordCount.toLocaleString()} words</div>
      <div className="flex flex-1 justify-end gap-3">
        <span>{encoding}</span>
        <span>{mode}</span>
      </div>
    </footer>
  );
}
