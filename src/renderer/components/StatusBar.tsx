export type EditorMode = 'Source' | 'WYSIWYG' | 'Split';

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
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-slate-800 bg-slate-900 px-3 text-xs text-slate-400 select-none">
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
