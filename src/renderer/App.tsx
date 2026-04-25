import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { EditorContainer } from './components/editors/EditorContainer';
import {
  type CursorPosition,
  type SourceEditorHandle,
} from './components/editors/SourceEditor';
import { type WysiwygEditorHandle } from './components/editors/WysiwygEditor';
import { FileProvider, useFileState, type EditorMode } from './state/fileState';
import type { MenuActionEvent } from './env';

const ACCEPTED_EXTENSIONS = /\.(md|markdown|txt)$/i;

function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

// Cycle order for Cmd+\: WYSIWYG → Source → Split → WYSIWYG.
const MODE_CYCLE: EditorMode[] = ['wysiwyg', 'source', 'split'];

function nextMode(mode: EditorMode): EditorMode {
  const idx = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? 'wysiwyg';
}

function modeLabel(mode: EditorMode): 'Source' | 'WYSIWYG' | 'Split' {
  if (mode === 'wysiwyg') return 'WYSIWYG';
  if (mode === 'split') return 'Split';
  return 'Source';
}

function AppContent() {
  const file = useFileState();
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const editorRef = useRef<SourceEditorHandle>(null);
  const wysiwygRef = useRef<WysiwygEditorHandle>(null);

  const isWysiwyg = file.activeTab?.editorMode === 'wysiwyg';
  // Source-style editor (Monaco) drives undo/redo for both Source AND Split.
  const isMonacoActive = !isWysiwyg;

  // Capture the current source-editor cursor/scroll into the (about-to-leave)
  // active tab before switching, so a switch back can restore. Only Monaco
  // is exposed via editorRef today; Milkdown's cursor mapping is approximate
  // and intentionally not preserved across mode swaps (per RAISE-7 spec).
  const captureActivePosition = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const c = ed.getCursor();
    if (c) file.setActiveCursor(c);
    file.setActiveScroll(ed.getScrollTop());
  }, [file]);

  const handleSwitchTab = useCallback(
    (id: string) => {
      if (id === file.activeTabId) return;
      captureActivePosition();
      file.switchTo(id);
    },
    [file, captureActivePosition],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      void file.closeTab(id);
    },
    [file],
  );

  const handleOpenFile = useCallback(async () => {
    const result = await window.api.files.open();
    if (result) {
      file.loadFile(result.path, result.content);
      window.api.addRecent(result.path);
    }
  }, [file]);

  const handleOpenPath = useCallback(
    async (filePath: string) => {
      try {
        const result = await window.api.files.openPath(filePath);
        file.loadFile(result.path, result.content);
        window.api.addRecent(result.path);
      } catch (err) {
        window.api.showError(
          'Could not open file',
          `${filePath}\n\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [file],
  );

  const handleOpenFolder = useCallback(async () => {
    await window.api.openFolder();
  }, []);

  const handleNewFile = useCallback(() => {
    file.newFile();
  }, [file]);

  const handleCloseActive = useCallback(() => {
    void file.closeActiveTab();
  }, [file]);

  const handleNextTab = useCallback(() => {
    captureActivePosition();
    file.nextTab();
  }, [file, captureActivePosition]);

  const handlePrevTab = useCallback(() => {
    captureActivePosition();
    file.prevTab();
  }, [file, captureActivePosition]);

  const handleModeChange = useCallback(
    (mode: EditorMode) => {
      // Capture before the swap. Source ↔ Split both use Monaco but at
      // different positions in the JSX tree, so React unmounts/remounts
      // the editor on the swap; without capturing, Monaco re-instantiates
      // at (1,1) / scroll 0. The restore effect picks the captured cursor
      // back up via the editorMode dep below.
      if (isMonacoActive) captureActivePosition();
      file.setActiveEditorMode(mode);
    },
    [file, isMonacoActive, captureActivePosition],
  );

  const handleCycleMode = useCallback(() => {
    const current = file.activeTab?.editorMode;
    if (!current) return;
    if (isMonacoActive) captureActivePosition();
    file.setActiveEditorMode(nextMode(current));
  }, [file, isMonacoActive, captureActivePosition]);

  // Drag-and-drop: open the first matching file in the drop. Multi-file
  // selection waits for proper multi-select semantics — for now we treat a
  // drop as a single-file open routed through the recent-files flow.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const dropped = e.dataTransfer?.files;
      if (!dropped || dropped.length === 0) return;
      const target = Array.from(dropped).find((f) => ACCEPTED_EXTENSIONS.test(f.name));
      if (!target) return;
      const filePath = window.api.files.getPathForFile(target);
      if (!filePath) return;
      void handleOpenPath(filePath);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleOpenPath]);

  // Menu IPC dispatch.
  useEffect(() => {
    const off = window.api.onMenuAction((event: MenuActionEvent) => {
      switch (event.type) {
        case 'new':
          handleNewFile();
          break;
        case 'open-file':
          void handleOpenFile();
          break;
        case 'open-path':
          if (event.payload?.path) void handleOpenPath(event.payload.path);
          break;
        case 'open-folder':
          void window.api.openFolder();
          break;
        case 'save':
          void file.save();
          break;
        case 'save-as':
          void file.saveAs();
          break;
        case 'close-tab':
          handleCloseActive();
          break;
        case 'next-tab':
          handleNextTab();
          break;
        case 'prev-tab':
          handlePrevTab();
          break;
        case 'undo':
          if (isWysiwyg) wysiwygRef.current?.triggerUndo();
          else editorRef.current?.triggerUndo();
          break;
        case 'redo':
          if (isWysiwyg) wysiwygRef.current?.triggerRedo();
          else editorRef.current?.triggerRedo();
          break;
        case 'find':
          // Milkdown ships no built-in find UI; only the Monaco-backed modes
          // (Source / Split) get find / replace today.
          if (isMonacoActive) editorRef.current?.triggerFind();
          break;
        case 'replace':
          if (isMonacoActive) editorRef.current?.triggerReplace();
          break;
        case 'font-zoom-in':
          editorRef.current?.zoomIn();
          break;
        case 'font-zoom-out':
          editorRef.current?.zoomOut();
          break;
        case 'font-zoom-reset':
          editorRef.current?.zoomReset();
          break;
        case 'source-mode':
          file.setActiveEditorMode('source');
          break;
        case 'wysiwyg-mode':
          file.setActiveEditorMode('wysiwyg');
          break;
        case 'split-mode':
          file.setActiveEditorMode('split');
          break;
        case 'cycle-mode':
          handleCycleMode();
          break;
        default:
          break;
      }
    });
    return off;
  }, [
    file,
    isWysiwyg,
    isMonacoActive,
    handleNewFile,
    handleOpenFile,
    handleOpenPath,
    handleCloseActive,
    handleNextTab,
    handlePrevTab,
    handleCycleMode,
  ]);

  // Signal readiness once on mount, after the menu listener effect above has
  // attached. Effects run in declaration order, so the listener is bound by
  // the time main drains its queue.
  useEffect(() => {
    window.api.notifyReady();
  }, []);

  // macOS: an Electron MenuItem only takes a single accelerator, so the menu
  // registers Cmd+Option+arrows. Ctrl+Tab / Ctrl+Shift+Tab is a familiar
  // browser-style cross-platform alternate — bind it here in the renderer
  // so it works alongside the menu shortcut. Capture phase + preventDefault
  // wins over Monaco's own Tab handling.
  useEffect(() => {
    if (window.api.platform !== 'darwin') return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) handlePrevTab();
        else handleNextTab();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handleNextTab, handlePrevTab]);

  // Restore the active tab's cursor / scroll AFTER Monaco's content has
  // been updated. Re-runs on tab change AND on editor-mode change because
  // Source ↔ Split swap remounts Monaco (different parent in the JSX tree)
  // — without depending on editorMode the cursor would jump to (1,1) on
  // every Source↔Split flip. cursor/scroll values are deliberately not
  // in deps so we don't snap back on every keystroke.
  useEffect(() => {
    if (!file.activeTabId || !editorRef.current) return;
    const target = file.tabs.find((t) => t.id === file.activeTabId);
    if (!target) return;
    const id = setTimeout(() => {
      editorRef.current?.setCursor(target.cursorPosition);
      editorRef.current?.setScrollTop(target.scrollPosition);
      setCursor(target.cursorPosition);
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.activeTabId, file.activeTab?.editorMode]);

  const wordCount = useMemo(
    () => countWords(file.activeTab?.content ?? ''),
    [file.activeTab?.content],
  );

  return (
    <div className="flex h-full w-full flex-col">
      {file.tabs.length > 0 && (
        <TabBar
          tabs={file.tabs}
          activeTabId={file.activeTabId}
          onActivate={handleSwitchTab}
          onClose={handleCloseTab}
          onReorder={file.reorderTabs}
        />
      )}
      <main className="min-h-0 flex-1">
        {file.activeTab ? (
          <EditorContainer
            tab={file.activeTab}
            onContentChange={file.setContent}
            onModeChange={handleModeChange}
            onCursorChange={setCursor}
            sourceRef={editorRef}
            wysiwygRef={wysiwygRef}
          />
        ) : (
          <WelcomeScreen onOpenFile={handleOpenFile} onOpenFolder={handleOpenFolder} />
        )}
      </main>
      {file.activeTab && (
        <StatusBar
          line={cursor.line}
          column={cursor.column}
          wordCount={wordCount}
          mode={modeLabel(file.activeTab.editorMode)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <FileProvider>
      <AppContent />
    </FileProvider>
  );
}
