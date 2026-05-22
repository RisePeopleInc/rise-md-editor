// RAISE-75: the status bar previously had its own local `EditorMode`
// union typed as the DISPLAY names ('Read' | 'Source' | 'WYSIWYG' |
// 'Split'), which drifted from the actual user-visible labels after
// RAISE-60's rename (Source → Code, WYSIWYG → Edit). Now consumes
// the internal `EditorMode` union from fileState and resolves to the
// user-visible label via the shared `MODE_LABELS` map — same source
// of truth as the ModeSwitcher pill.
import { MODE_LABELS, type EditorMode } from '../state/fileState';

interface StatusBarProps {
  /**
   * Cursor line / column. RAISE-60 follow-up made these optional:
   * Read mode has no cursor, and Edit (WYSIWYG / Milkdown) mode has
   * a ProseMirror position offset rather than a source line/column
   * (mapping offset → line would mean running the markdown serializer
   * on every keystroke, way too expensive for a stat that doesn't
   * belong in formatted-editing mode). When omitted, the Ln/Col cell
   * renders blank so the statusbar layout doesn't shift.
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
  mode = 'source',
}: StatusBarProps) {
  // Reserve the same horizontal slot whether we render Ln/Col or not,
  // so swapping modes doesn't shift the centered word-count or the
  // right-aligned encoding/mode labels.
  const showLineCol = line !== undefined && column !== undefined;
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-stroke bg-surface px-3 text-xs text-muted select-none">
      <div className="flex-1 text-left tabular-nums">
        {showLineCol ? `Ln ${line}, Col ${column}` : ' '}
      </div>
      <div className="flex-1 text-center tabular-nums">{wordCount.toLocaleString()} words</div>
      <div className="flex flex-1 justify-end gap-3">
        <span>{encoding}</span>
        <span>{MODE_LABELS[mode]}</span>
      </div>
    </footer>
  );
}
