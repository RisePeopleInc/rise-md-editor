import { useImperativeHandle, useRef, type Ref } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

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
}: SourceEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Hold the latest callback so the editor's scroll listener (registered
  // once on mount) always invokes the current handler.
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;

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
      theme="vs-dark"
      value={content}
      onChange={(value) => onChange(value ?? '')}
      onMount={handleMount}
      options={EDITOR_OPTIONS}
    />
  );
}
