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
import { Sidebar } from './components/sidebar/Sidebar';
import { FileTree } from './components/sidebar/FileTree';
import { FileProvider, useFileState, type EditorMode } from './state/fileState';
import { useSidebarState, isOpenable } from './state/sidebarState';
import type { MenuActionEvent, TreeNode } from './env';

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

function basenameOfPath(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function AppContent() {
  const file = useFileState();
  const sidebar = useSidebarState();
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const editorRef = useRef<SourceEditorHandle>(null);
  const wysiwygRef = useRef<WysiwygEditorHandle>(null);

  const isWysiwyg = file.activeTab?.editorMode === 'wysiwyg';
  // Source-style editor (Monaco) drives undo/redo for both Source AND Split.
  const isMonacoActive = !isWysiwyg;

  // Capture the active editor's cursor/scroll into the (about-to-leave)
  // tab before switching, so a switch back can restore. Each editor has
  // its own scroll field on Tab (Monaco pixels in scrollPosition, Milkdown
  // container pixels in wysiwygScrollPosition) so the two don't collide
  // when the user crosses modes. ProseMirror cursor mapping isn't done —
  // WYSIWYG just gets scroll preservation today.
  const captureActivePosition = useCallback(() => {
    if (isWysiwyg) {
      const wy = wysiwygRef.current;
      if (!wy) return;
      file.setActiveWysiwygScroll(wy.getScrollTop());
      file.setActiveWysiwygCursorOffset(wy.getCursorOffset());
      return;
    }
    const ed = editorRef.current;
    if (!ed) return;
    const c = ed.getCursor();
    if (c) file.setActiveCursor(c);
    file.setActiveScroll(ed.getScrollTop());
  }, [file, isWysiwyg]);

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
    await sidebar.openFolderDialog();
  }, [sidebar]);

  const handleTreeContextMenu = useCallback(
    async (node: TreeNode) => {
      const action = await window.api.folder.showItemMenu({
        isDirectory: node.isDirectory,
        isMarkdown: isOpenable(node) || /\.(md|markdown)$/i.test(node.name),
      });
      if (!action) return;
      switch (action) {
        case 'open':
          if (isOpenable(node)) void handleOpenPath(node.path);
          break;
        case 'reveal':
          window.api.folder.reveal(node.path);
          break;
        case 'new-file':
          // 'new-file' / 'new-folder' only make sense on directories — the
          // context menu only offers them in that case.
          if (node.isDirectory) sidebar.startCreate(node.path, 'file');
          break;
        case 'new-folder':
          if (node.isDirectory) sidebar.startCreate(node.path, 'folder');
          break;
        case 'rename':
          sidebar.startRename(node.path);
          break;
        case 'delete': {
          const ok = await window.api.folder.confirmDelete(node.name, node.isDirectory);
          if (!ok) return;
          try {
            await window.api.folder.trash(node.path);
            // Reconcile open tabs: clean tabs close, dirty tabs become
            // Untitled so the user can rescue their working copy via Save As.
            file.relocateTabs(node.path, null);
          } catch (err) {
            window.api.showError(
              'Could not move to Trash',
              err instanceof Error ? err.message : String(err),
            );
          }
          break;
        }
      }
    },
    [handleOpenPath, sidebar, file],
  );

  const handleRenameSubmit = useCallback(
    async (oldPath: string, newName: string) => {
      sidebar.cancelEdit();
      if (newName === '') return;
      // Disallow path separators to prevent accidental moves — rename is
      // strictly a name change in this UI.
      if (newName.includes('/') || newName.includes('\\')) {
        window.api.showError(
          'Invalid name',
          'Names cannot contain "/" or "\\".',
        );
        return;
      }
      try {
        const newPath = await window.api.folder.rename(oldPath, newName);
        // Keep open tabs in sync with the rename — without this the tab
        // still points at the old path and a Cmd+S would write a ghost
        // file at the original location.
        file.relocateTabs(oldPath, newPath);
      } catch (err) {
        window.api.showError(
          'Could not rename',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [sidebar, file],
  );

  const handleCreateSubmit = useCallback(
    async (parentPath: string, kind: 'file' | 'folder', name: string) => {
      sidebar.cancelEdit();
      if (name === '') return;
      if (name.includes('/') || name.includes('\\')) {
        window.api.showError(
          'Invalid name',
          'Names cannot contain "/" or "\\".',
        );
        return;
      }
      try {
        if (kind === 'file') {
          const newPath = await window.api.folder.createFile(parentPath, name);
          void handleOpenPath(newPath);
        } else {
          await window.api.folder.createFolder(parentPath, name);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.api.showError(
          kind === 'file' ? 'Could not create file' : 'Could not create folder',
          // EEXIST is the most common failure — surface it readably.
          /EEXIST/i.test(message)
            ? `An item named "${name}" already exists in that folder.`
            : message,
        );
      }
    },
    [handleOpenPath, sidebar],
  );

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
      // Capture before the swap so cursor + scroll round-trip across
      // mode flips. captureActivePosition routes to the correct editor
      // based on the current mode (Monaco for source/split, Milkdown for
      // wysiwyg) and stores scroll into the editor-specific Tab field.
      captureActivePosition();
      file.setActiveEditorMode(mode);
    },
    [file, captureActivePosition],
  );

  const handleCycleMode = useCallback(() => {
    const current = file.activeTab?.editorMode;
    if (!current) return;
    captureActivePosition();
    file.setActiveEditorMode(nextMode(current));
  }, [file, captureActivePosition]);

  // Drag-and-drop. A dropped *folder* opens Project Mode; a dropped
  // markdown/text file opens in a tab. We can't tell which from the File
  // object alone (browsers don't expose `kind`), so we ask main to stat
  // the path. Empty drops or unsupported file types are silently ignored.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const dropped = e.dataTransfer?.files;
      if (!dropped || dropped.length === 0) return;
      const first = dropped[0];
      if (!first) return;
      const droppedPath = window.api.files.getPathForFile(first);
      if (!droppedPath) return;
      const kind = await window.api.folder.statPath(droppedPath);
      if (kind === 'directory') {
        await sidebar.openFolderByPath(droppedPath);
        return;
      }
      if (kind === 'file') {
        // Only open recognised text/markdown extensions to match the
        // explicit filter on the Open File dialog.
        const target = Array.from(dropped).find((f) =>
          ACCEPTED_EXTENSIONS.test(f.name),
        );
        if (!target) return;
        const filePath = window.api.files.getPathForFile(target);
        if (filePath) void handleOpenPath(filePath);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleOpenPath, sidebar]);

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
          handleModeChange('source');
          break;
        case 'wysiwyg-mode':
          handleModeChange('wysiwyg');
          break;
        case 'split-mode':
          handleModeChange('split');
          break;
        case 'cycle-mode':
          handleCycleMode();
          break;
        case 'toggle-sidebar':
          sidebar.toggleVisible();
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
    sidebar,
    handleNewFile,
    handleOpenFile,
    handleOpenPath,
    handleCloseActive,
    handleNextTab,
    handlePrevTab,
    handleCycleMode,
    handleModeChange,
  ]);

  // External-change reload prompt: when chokidar reports a content change
  // for a file that's currently open in a tab, ask the user if they want
  // to discard their working copy and reload from disk.
  useEffect(() => {
    const off = window.api.folder.onFileChanged(async (filePath) => {
      const tab = file.tabs.find((t) => t.path === filePath);
      if (!tab) return;
      const isDirty = tab.content !== tab.savedContent;
      const reload = await window.api.confirmFileReload(
        basenameOfPath(filePath),
        isDirty,
      );
      if (!reload) return;
      try {
        const result = await window.api.files.openPath(filePath);
        file.refreshTabFromDisk(result.path, result.content);
      } catch (err) {
        window.api.showError(
          'Could not reload file',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    return off;
  }, [file]);

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

  // Restore the active tab's cursor / scroll on TAB switches only —
  // Monaco doesn't remount across same-mode tab switches, so we apply
  // the captured cursor + scroll imperatively here. Mode switches
  // remount Monaco and are handled inside SourceEditor's onMount with
  // a dedicated 4-line offset; running this effect on editorMode change
  // would override that offset with the captured pixel scrollTop, which
  // doesn't translate cross-mode and parks the cursor right under the
  // header bar.
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
  }, [file.activeTabId]);

  const wordCount = useMemo(
    () => countWords(file.activeTab?.content ?? ''),
    [file.activeTab?.content],
  );

  return (
    <div className="flex h-full w-full">
      {sidebar.visible && (
        <Sidebar
          width={sidebar.width}
          onWidthChange={sidebar.setWidth}
          rootName={sidebar.rootPath ? basenameOfPath(sidebar.rootPath) : null}
          onCollapseAll={sidebar.collapseAll}
          onOpenFolder={handleOpenFolder}
        >
          {sidebar.rootTree && (
            <FileTree
              root={sidebar.rootTree}
              expanded={sidebar.expanded}
              onToggle={sidebar.toggleExpanded}
              onOpenFile={(p) => void handleOpenPath(p)}
              onContextMenu={handleTreeContextMenu}
              editingPath={sidebar.editingPath}
              creating={sidebar.creating}
              onRenameSubmit={(p, name) => void handleRenameSubmit(p, name)}
              onCreateSubmit={(parent, kind, name) =>
                void handleCreateSubmit(parent, kind, name)
              }
              onEditCancel={sidebar.cancelEdit}
            />
          )}
        </Sidebar>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
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
