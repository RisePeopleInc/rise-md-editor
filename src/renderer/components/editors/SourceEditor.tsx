import { useImperativeHandle, useRef, type Ref } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { GRUVBOX_DARK_ID, GRUVBOX_LIGHT_ID } from '../../monaco-themes';

/**
 * Read the current resolved app theme from the `data-theme` attribute
 * the bootstrap script wrote. Used to seed Monaco with the right
 * Gruvbox variant on first mount; later theme changes flow through the
 * useThemeState hook, which calls `monaco.editor.setTheme` directly so
 * existing instances pick up the swap without re-rendering.
 */
function initialMonacoTheme(): string {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? GRUVBOX_DARK_ID : GRUVBOX_LIGHT_ID;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface SourceEditorHandle {
  triggerFind: () => void;
  triggerReplace: () => void;
  triggerUndo: () => void;
  triggerRedo: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  /** Current cursor position (1-based line/column). */
  getCursor: () => CursorPosition | null;
  /** Move the cursor and reveal it. */
  setCursor: (position: CursorPosition) => void;
  /** Current scroll offset in pixels. */
  getScrollTop: () => number;
  /** Set the scroll offset in pixels. */
  setScrollTop: (top: number) => void;
}

interface SourceEditorProps {
  ref?: Ref<SourceEditorHandle>;
  content: string;
  onChange: (value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
  /**
   * Fires whenever Monaco's vertical scroll position changes. Used by Split
   * mode to drive proportional preview-pane scroll sync.
   */
  onScrollChange?: (scrollTop: number, scrollHeight: number) => void;
  /**
   * Cursor position to apply once Monaco has finished mounting. Used to
   * preserve the cursor across mode switches that remount Monaco (Source
   * ↔ Split). Read once on mount; later changes are ignored.
   */
  initialCursor?: CursorPosition;
  /** Scroll offset to apply once Monaco has finished mounting. */
  initialScrollTop?: number;
}

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  wordWrap: 'on',
  minimap: { enabled: false },
  lineNumbers: 'on',
  fontSize: 14,
  fontFamily: MONO_STACK,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
  tabSize: 2,
};

export function SourceEditor({
  ref,
  content,
  onChange,
  onCursorChange,
  onScrollChange,
  initialCursor,
  initialScrollTop,
}: SourceEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Hold the latest callback so the editor's scroll listener (registered
  // once on mount) always invokes the current handler.
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;
  // Capture mount-time initial cursor/scroll in refs so handleMount sees
  // the values that were current when SourceEditor mounted (subsequent
  // prop changes are ignored — apply-once-on-mount semantics).
  const initialCursorRef = useRef(initialCursor);
  const initialScrollTopRef = useRef(initialScrollTop);

  const runAction = (id: string): void => {
    const ed = editorRef.current;
    if (!ed) return;
    const action = ed.getAction(id);
    action?.run();
  };

  useImperativeHandle(
    ref,
    () => ({
      // Monaco's built-in shortcuts (Cmd+F, Cmd+Z, etc.) get swallowed by the
      // Electron menu's accelerators, so we drive these actions via IPC and
      // dispatch them through Monaco's command system here.
      triggerFind: () => runAction('actions.find'),
      triggerReplace: () => runAction('editor.action.startFindReplaceAction'),
      triggerUndo: () => editorRef.current?.trigger('menu', 'undo', null),
      triggerRedo: () => editorRef.current?.trigger('menu', 'redo', null),
      zoomIn: () => runAction('editor.action.fontZoomIn'),
      zoomOut: () => runAction('editor.action.fontZoomOut'),
      zoomReset: () => runAction('editor.action.fontZoomReset'),
      getCursor: () => {
        const pos = editorRef.current?.getPosition();
        return pos ? { line: pos.lineNumber, column: pos.column } : null;
      },
      setCursor: (position) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.setPosition({ lineNumber: position.line, column: position.column });
        ed.revealPositionInCenterIfOutsideViewport({
          lineNumber: position.line,
          column: position.column,
        });
      },
      getScrollTop: () => editorRef.current?.getScrollTop() ?? 0,
      setScrollTop: (top) => editorRef.current?.setScrollTop(top),
    }),
    [],
  );

  const handleMount: OnMount = (instance) => {
    editorRef.current = instance;
    // Apply initial cursor/scroll on mount (mode swap remount only —
    // same-mode tab switches go through App's setTimeout effect against
    // the same Monaco instance). Place the caret, then explicitly scroll
    // so the cursor lands ~4 lines below the editor's visible top. That
    // gives breathing room from any chrome above the editor (mode
    // switcher, tab bar) instead of letting Monaco's built-in 1–2-line
    // "near top" padding leave the cursor flush against the bar.
    const initCur = initialCursorRef.current;
    if (initCur) {
      instance.setPosition({ lineNumber: initCur.line, column: initCur.column });
      const targetLine = Math.max(initCur.line - 4, 1);
      instance.setScrollTop(instance.getTopForLineNumber(targetLine));
    } else if (initialScrollTopRef.current !== undefined) {
      // No cursor to restore (fresh tab) — honour the raw pixel offset.
      instance.setScrollTop(initialScrollTopRef.current);
    }
    // Take focus back from whatever fired the remount (typically the
    // mode-switcher button) so the user can keep typing without an extra
    // click. focus() is async-ish; defer to the next tick so it lands
    // after Monaco's own post-create paint.
    queueMicrotask(() => instance.focus());
    const pos = instance.getPosition();
    if (pos && onCursorChange) {
      onCursorChange({ line: pos.lineNumber, column: pos.column });
    }
    instance.onDidChangeCursorPosition((e) => {
      onCursorChange?.({ line: e.position.lineNumber, column: e.position.column });
    });
    instance.onDidScrollChange((e) => {
      onScrollChangeRef.current?.(e.scrollTop, e.scrollHeight);
    });
  };

  return (
    <Editor
      height="100%"
      language="markdown"
      // Gruvbox is registered in monaco-setup.ts. The variant is chosen
      // from the current data-theme so the source editor picks the right
      // palette on first paint; later toggles call monaco.editor.setTheme
      // globally from useThemeState.
      theme={initialMonacoTheme()}
      value={content}
      onChange={(value) => onChange(value ?? '')}
      onMount={handleMount}
      options={EDITOR_OPTIONS}
    />
  );
}
