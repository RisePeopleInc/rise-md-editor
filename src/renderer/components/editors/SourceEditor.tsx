import { useImperativeHandle, useRef, type Ref } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import * as monacoNs from 'monaco-editor';
import type { editor } from 'monaco-editor';
import {
  firstImageItem,
  pickImageFiles,
  snapshotPasteItem,
  type ImageInsertion,
  type PasteImageSnapshot,
} from '../../state/imageInsert';

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
  /**
   * Monaco theme id (one of `gruvbox-{contrast}-{mode}`). Reactive — when
   * the user changes editor contrast or theme, this prop updates and
   * Monaco swaps to the matching variant.
   */
  monacoThemeId: string;
  /**
   * Image-drop callback. Called when image files are dropped onto the
   * editor; should save them and return the markdown to insert at the
   * drop position. Returning an empty array silently ignores the drop.
   */
  onImageDrop?: (files: File[]) => Promise<ImageInsertion[]>;
  /**
   * Image-paste callback. Called when an image is on the clipboard;
   * should save it and return the markdown to insert at the cursor.
   * Return null to ignore. Takes a synchronous snapshot of the
   * DataTransferItem since the item is invalidated when the paste
   * handler returns.
   */
  onImagePaste?: (snapshot: PasteImageSnapshot) => Promise<ImageInsertion | null>;
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
  monacoThemeId,
  onImageDrop,
  onImagePaste,
}: SourceEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Hold the latest callback so the editor's scroll listener (registered
  // once on mount) always invokes the current handler.
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;
  // Image-handling callbacks land in refs too — the DOM drop/paste
  // listeners are attached once on mount and need to call the current
  // closures even after re-renders.
  const onImageDropRef = useRef(onImageDrop);
  onImageDropRef.current = onImageDrop;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
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

    // -----------------------------------------------------------------
    // RAISE-11: image drop + paste interception in Source mode.
    //
    // Capture-phase listeners on Monaco's root DOM so we win against
    // Monaco's own drop/paste handling for the image case only — when
    // there's no image in the payload we let the events bubble through
    // and Monaco handles plain text as usual.
    // -----------------------------------------------------------------
    const dom = instance.getDomNode();
    if (dom) {
      const insertAt = (position: monacoNs.Position, text: string): void => {
        const range = new monacoNs.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        );
        instance.executeEdits('image-insert', [
          { range, text, forceMoveMarkers: true },
        ]);
      };

      dom.addEventListener(
        'drop',
        (event) => {
          const dt = (event as DragEvent).dataTransfer;
          if (!dt) return;
          const images = pickImageFiles(dt.files);
          if (images.length === 0) return; // Let Monaco handle plain drops.
          event.preventDefault();
          event.stopPropagation();
          const dropEvent = event as DragEvent;
          // Resolve the drop point to a model position. Falls back to
          // the current cursor if Monaco can't classify the click point.
          const target = instance.getTargetAtClientPoint(
            dropEvent.clientX,
            dropEvent.clientY,
          );
          const position = target?.position ?? instance.getPosition();
          if (!position) return;
          void (async () => {
            const handler = onImageDropRef.current;
            if (!handler) return;
            const insertions = await handler(images);
            if (insertions.length === 0) return;
            // Multiple drops stack on separate lines so each gets its
            // own paragraph in the rendered markdown.
            const text = insertions.map((i) => i.markdown).join('\n\n');
            insertAt(position, text);
            instance.focus();
          })();
        },
        { capture: true },
      );

      dom.addEventListener(
        'paste',
        (event) => {
          const clipboardData = (event as ClipboardEvent).clipboardData;
          if (!clipboardData) return;
          const item = firstImageItem(clipboardData.items);
          if (!item) return; // Plain text paste — Monaco handles it.
          // Snapshot now: DataTransferItems become "neutered" the
          // moment the paste handler returns, so reading .type or
          // calling getAsFile() across an `await` returns null/empty.
          const snapshot = snapshotPasteItem(item);
          if (!snapshot) return;
          event.preventDefault();
          event.stopPropagation();
          void (async () => {
            const handler = onImagePasteRef.current;
            if (!handler) return;
            const insertion = await handler(snapshot);
            if (!insertion) return;
            const position = instance.getPosition();
            if (!position) return;
            insertAt(position, insertion.markdown);
            instance.focus();
          })();
        },
        { capture: true },
      );
    }
  };

  return (
    <Editor
      height="100%"
      language="markdown"
      // All 6 Gruvbox variants are registered in monaco-setup.ts. The
      // active variant id flows from useThemeState in App down through
      // EditorContainer; @monaco-editor/react re-applies on prop change
      // so contrast/mode swaps happen reactively.
      theme={monacoThemeId}
      value={content}
      onChange={(value) => onChange(value ?? '')}
      onMount={handleMount}
      options={EDITOR_OPTIONS}
    />
  );
}
