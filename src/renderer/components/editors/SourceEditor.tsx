import {
  useImperativeHandle,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { getMarkdownFromClipboard } from '../../state/clipboardPaste';
import {
  firstImageItem,
  pickImageFiles,
  snapshotPasteItem,
  type ImageInsertion,
  type PasteImageSnapshot,
} from '../../state/imageInsert';
import type { WordWrap } from '../../env';

export interface CursorPosition {
  line: number;
  column: number;
}

export interface SourceEditorHandle {
  triggerFind: () => void;
  triggerReplace: () => void;
  triggerUndo: () => void;
  triggerRedo: () => void;
  /**
   * Select the entire document. `webContents.selectAll()` (the role used
   * by Electron context menus) doesn't reach Monaco's internal selection
   * model, so we expose a Monaco-specific path for the context-menu's
   * Select All item.
   */
  selectAll: () => void;
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
  /**
   * RAISE-42: read the currently-selected text from Monaco's
   * selection model. Returns the selected source string, or
   * empty if the selection is collapsed / nothing's selected.
   * Used by the Export-to-PDF flow's "Selection only" range —
   * `window.getSelection()` doesn't reach Monaco's internal
   * selection (Monaco renders custom DOM that doesn't always
   * map to the document selection), so the source-mode export
   * needs this dedicated path.
   */
  getSelectionText: () => string;
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
   * Word-wrap mode. Reactive — toggling `View → Word Wrap` updates this
   * prop and a `useEffect` calls `editor.updateOptions({ wordWrap })`,
   * preserving cursor + scroll position rather than remounting.
   */
  wordWrap: WordWrap;
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

// `wordWrap` lives outside this constant because it's user-controllable
// (View → Word Wrap, persisted per RAISE-27); see `optionsForWordWrap`
// below and the live-update effect in the component body.
const BASE_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  lineNumbers: 'on',
  fontSize: 14,
  fontFamily: MONO_STACK,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection',
  tabSize: 2,
  // RAISE-28: Monaco's web-rendered context menu uses
  // `document.execCommand('paste')` which is restricted in modern
  // Electron — Paste from that menu silently fails. Disabling it lets
  // our wrapper-level Electron-native menu (registered below) handle
  // right-click instead, where role:'paste' actually works.
  contextmenu: false,
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
  wordWrap,
  onImageDrop,
  onImagePaste,
}: SourceEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Stable options identity per wordWrap value. `@monaco-editor/react`
  // diffs the `options` prop and calls `editor.updateOptions(...)` on
  // change — that's how live wordWrap toggles take effect (cursor +
  // scroll position preserved, no remount). Without `useMemo`, every
  // render would create a new options object and trigger redundant
  // updateOptions calls.
  const editorOptions = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({ ...BASE_EDITOR_OPTIONS, wordWrap }),
    [wordWrap],
  );
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
      // Monaco's selectAll for the right-click context menu (RAISE-28).
      // We can't go through `runAction('editor.action.selectAll')` —
      // that command is registered as a global `MultiCommand` rather
      // than an `EditorAction`, so `editor.getAction(...)` returns
      // undefined and the call silently no-ops. Setting the selection
      // to the model's full range is direct and equivalent in effect.
      selectAll: () => {
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return;
        ed.setSelection(model.getFullModelRange());
        ed.focus();
      },
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
      getSelectionText: () => {
        const ed = editorRef.current;
        const model = ed?.getModel();
        const sel = ed?.getSelection();
        if (!ed || !model || !sel || sel.isEmpty()) return '';
        return model.getValueInRange(sel);
      },
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
    // RAISE-31: source-view `// line comment` highlighting.
    //
    // Monaco's built-in markdown tokenizer already handles
    // `<!-- ... -->` (inherited from the embedded HTML grammar), so
    // those render as comments out of the box. `// foo` is *not*
    // standard markdown — Obsidian / iA Writer convention — and
    // Monaco's tokenizer doesn't know about it. Replacing the
    // tokenizer wholesale would mean re-implementing Monaco's
    // entire markdown grammar; instead we layer on top via a
    // Monaco decorations collection.
    //
    // Apply an `inlineClassName: 'rise-md-source-comment'` decoration
    // to every line whose first non-whitespace chars are `//`.
    // CSS rule in `milkdown.css` paints those ranges in the muted
    // comment colour. `editor.createDecorationsCollection()` (the
    // non-deprecated Monaco API) tracks the decoration IDs
    // internally and replaces them atomically on each `.set(...)`
    // — no churn on the model when content shifts incrementally.
    //
    // Refresh on every content change. `onDidChangeModelContent`
    // fires for every keystroke / paste / programmatic edit;
    // scanning all lines is O(n) line-count and only does work on
    // matches, so the cost is dominated by Monaco's own work.
    // -----------------------------------------------------------------
    const commentDecorations = instance.createDecorationsCollection();
    const refreshCommentDecorations = (): void => {
      const model = instance.getModel();
      if (!model) return;
      const lineCount = model.getLineCount();
      const decorations: monaco.editor.IModelDeltaDecoration[] = [];
      for (let line = 1; line <= lineCount; line++) {
        const text = model.getLineContent(line);
        // Match the same shape as the WYSIWYG plugin:
        // `^[ \t]*//` — leading whitespace allowed, `//` mid-line
        // is NOT a comment (URL guard).
        if (/^[ \t]*\/\//.test(text)) {
          decorations.push({
            range: new monaco.Range(line, 1, line, text.length + 1),
            options: {
              inlineClassName: 'rise-md-source-comment',
              stickiness:
                monaco.editor.TrackedRangeStickiness
                  .AlwaysGrowsWhenTypingAtEdges,
            },
          });
        }
      }
      commentDecorations.set(decorations);
    };
    refreshCommentDecorations();
    instance.onDidChangeModelContent(() => {
      refreshCommentDecorations();
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
      const insertAt = (position: monaco.Position, text: string): void => {
        const range = new monaco.Range(
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
          // RAISE-39: image-only paste path. Skip when text/html
          // is also present — Word / Excel / browser / PowerPoint
          // clipboards bundle a screenshot alongside the rich
          // content, and we want the text in those cases.
          const hasHtml = !!clipboardData.getData('text/html');
          const item = hasHtml
            ? null
            : firstImageItem(clipboardData.items);
          if (item) {
            // Snapshot now: DataTransferItems become "neutered"
            // the moment the paste handler returns, so reading
            // .type or calling getAsFile() across an `await`
            // returns null/empty.
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
            return;
          }

          // RAISE-39: text/rich-text paste. Route through the
          // shared clipboard helper so the source editor benefits
          // from the same Google-Docs-cleanup + Turndown-fallback
          // pipeline as WYSIWYG. Without this intervention,
          // Monaco's default paste pulls `text/plain` verbatim —
          // which for Google Docs is markdown with cosmetic
          // over-escapes (`\.`, `\#`) AND broken double-wrapped
          // links, and for Word / browser pages is an unstyled
          // text dump that's lost all structure.
          //
          // We only preventDefault when we have a useful markdown
          // string to insert. If the helper returns null (truly
          // empty clipboard), we let Monaco fall through to its
          // default no-op so we don't break anything.
          const markdown = getMarkdownFromClipboard(clipboardData);
          if (markdown == null) return;
          event.preventDefault();
          event.stopPropagation();
          const selection = instance.getSelection();
          const range = selection
            ? new monaco.Range(
                selection.startLineNumber,
                selection.startColumn,
                selection.endLineNumber,
                selection.endColumn,
              )
            : (() => {
                const pos = instance.getPosition();
                if (!pos) return null;
                return new monaco.Range(
                  pos.lineNumber,
                  pos.column,
                  pos.lineNumber,
                  pos.column,
                );
              })();
          if (!range) return;
          instance.executeEdits('paste', [
            { range, text: markdown, forceMoveMarkers: true },
          ]);
          instance.focus();
        },
        { capture: true },
      );
    }
  };

  // RAISE-28: wrap Monaco in a div so we can attach our Electron-native
  // context menu via React's onContextMenu. Monaco's own menu was
  // disabled above (BASE_EDITOR_OPTIONS.contextmenu = false) because
  // its Paste implementation is broken under modern Electron.
  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const editor = editorRef.current;
    if (editor) {
      // Focus Monaco synchronously so role:'paste' / role:'cut' / etc.
      // have a target webContents-side. Without this the very first
      // right-click (before Monaco was clicked into) finds the menu
      // items disabled.
      editor.focus();
    }
    const sel = editor?.getSelection();
    const hasSelection = !!sel && !sel.isEmpty();
    void window.api.contextMenu.showEditor({
      mode: 'source',
      hasSelection,
    });
  };

  return (
    <div className="h-full w-full" onContextMenu={handleContextMenu}>
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
        options={editorOptions}
      />
    </div>
  );
}
