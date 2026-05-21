// RAISE-60: added 'Read' alongside the existing labels. The
// statusbar shows a single string, so the label union is just the
// rendered text — not the same union as `EditorMode` in fileState.
export type EditorMode = 'Read' | 'Source' | 'WYSIWYG' | 'Split';

interface StatusBarProps {
  /**
   * Cursor line / column. RAISE-60 follow-up made these optional:
   * Read mode has no cursor, and WYSIWYG mode has a ProseMirror
   * position offset rather than a source line/column (mapping
   * offset → line would mean running the markdown serializer on
   * every keystroke, way too expensive for a stat that doesn't
   * belong in formatted-editing mode). When omitted, the Ln/Col
   * cell renders blank so the statusbar layout doesn't shift.
   */
  line?: number;
  column?: number;
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
  // Reserve the same horizontal slot whether we render Ln/Col or not,
  // so swapping modes doesn't shift the centered word-count or the
  // right-aligned encoding/mode labels.
  const showLineCol = line !== undefined && column !== undefined;
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-stroke bg-surface px-3 text-xs text-muted select-none">
      <div className="flex-1 text-left tabular-nums">
        {showLineCol ? `Ln ${line}, Col ${column}` : ' '}
      </div>
      <div className="flex-1 text-center tabular-nums">{wordCount.toLocaleString()} words</div>
      <div className="flex flex-1 justify-end gap-3">
        <span>{encoding}</span>
        <span>{mode}</span>
      </div>
    </footer>
  );
}
