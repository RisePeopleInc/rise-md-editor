import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { WorkspaceBanner } from './components/WorkspaceBanner';
import { TemplateHintBanner } from './components/TemplateHintBanner';
import { UpdateBanner } from './components/UpdateBanner';
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
import { useThemeState } from './state/themeState';
import { useUpdateState } from './state/updateState';
import {
  processImageDrop,
  processImagePaste,
  type ImageInsertion,
  type PasteImageSnapshot,
} from './state/imageInsert';
import type { MenuActionEvent, TemplateKind, TreeNode } from './env';

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
  const theme = useThemeState();
  const update = useUpdateState();
  // Per-session "I clicked Later" flag for the update banner. Doesn't
  // persist across launches — if the user dismisses now, the banner
  // re-appears next launch (the update is still ready to install on
  // disk, autoUpdater re-fires `update-downloaded` from cache).
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const editorRef = useRef<SourceEditorHandle>(null);
  const wysiwygRef = useRef<WysiwygEditorHandle>(null);

  // Tabs that were freshly opened from a template — these get a small
  // dismissible hint banner above the editor reminding the user to fill
  // in the placeholders. Cleared when the user dismisses or when the
  // tab is closed.
  const [templateHintTabIds, setTemplateHintTabIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Visibility of the workspace-level "no CLAUDE.md found" banner. Driven
  // by an effect below: re-checked whenever the open folder changes and
  // when the tree refreshes (so the banner clears as soon as the user
  // creates the file via this banner OR via File → New CLAUDE.md).
  const [showMissingClaudeBanner, setShowMissingClaudeBanner] =
    useState<boolean>(false);

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

  // Create a file from a bundled template (CLAUDE.md or Skill). The
  // main process decides where it lands based on whether a workspace
  // is open: project root for CLAUDE.md, `<root>/skills/` for skills,
  // or "untitled tab with template body" if no folder is open.
  const handleCreateFromTemplate = useCallback(
    async (kind: TemplateKind): Promise<void> => {
      try {
        const result = await window.api.templates.create(
          kind,
          sidebar.rootPath,
        );
        let hintId: string | null = null;
        if (result.status === 'created') {
          hintId = file.loadFile(result.path, result.content);
          window.api.addRecent(result.path);
        } else if (result.status === 'exists') {
          // CLAUDE.md was already there — just open it. No hint, since
          // the user didn't actually create something fresh.
          await handleOpenPath(result.path);
        } else {
          // No workspace — drop the template body into a new untitled
          // tab. Tab id is generated client-side.
          hintId = file.newFileFromContent(result.content);
        }
        if (hintId !== null) {
          const id = hintId;
          setTemplateHintTabIds((prev) => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }
      } catch (err) {
        window.api.showError(
          kind === 'claude'
            ? 'Could not create CLAUDE.md'
            : 'Could not create skill file',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [file, handleOpenPath, sidebar.rootPath],
  );

  const dismissTemplateHint = useCallback((id: string) => {
    setTemplateHintTabIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Workspace banner: offer to create a CLAUDE.md when the open folder
  // doesn't have one, unless the user has explicitly dismissed it for
  // this folder. Re-runs whenever the open folder changes OR when the
  // tree refreshes (so creating the file hides the banner immediately).
  useEffect(() => {
    let cancelled = false;
    const root = sidebar.rootPath;
    if (!root) {
      setShowMissingClaudeBanner(false);
      return;
    }
    void (async () => {
      const [exists, dismissed] = await Promise.all([
        window.api.templates.claudeMdExists(root),
        window.api.templates.isClaudeBannerDismissed(root),
      ]);
      if (cancelled) return;
      setShowMissingClaudeBanner(!exists && !dismissed);
    })();
    return () => {
      cancelled = true;
    };
    // `sidebar.rootTree` ticks every time the watcher reports a change,
    // which is exactly when we want to re-check (e.g. after the user
    // creates CLAUDE.md the banner should clear).
  }, [sidebar.rootPath, sidebar.rootTree]);

  const handleDismissClaudeBanner = useCallback(() => {
    if (sidebar.rootPath) {
      window.api.templates.dismissClaudeBanner(sidebar.rootPath);
    }
    setShowMissingClaudeBanner(false);
  }, [sidebar.rootPath]);

  // Image drop / paste glue: ensure the active tab has a saved path
  // (otherwise we don't know where to put assets/), then hand off to
  // the shared imageInsert helper. Both editors call these.
  const handleImageDrop = useCallback(
    async (files: File[]): Promise<ImageInsertion[]> => {
      const path = await file.requireSavedPath();
      if (!path) return [];
      return processImageDrop(path, files);
    },
    [file],
  );

  const handleImagePaste = useCallback(
    async (snapshot: PasteImageSnapshot): Promise<ImageInsertion | null> => {
      const path = await file.requireSavedPath();
      if (!path) return null;
      return processImagePaste(path, snapshot);
    },
    [file],
  );

  const handleOpenImage = useCallback(
    (relPath: string) => {
      const mdPath = file.activeTab?.path;
      if (!mdPath) return;
      void window.api.assets.openRelative(mdPath, relPath);
    },
    [file.activeTab?.path],
  );

  // Drop hint ids whose tabs have closed. Without this the Set leaks
  // forever (tiny cost, but the next tab to take that id would
  // erroneously inherit the hint — IDs are crypto.randomUUID() so the
  // chance is vanishing, but cleaning up is also just correct).
  useEffect(() => {
    setTemplateHintTabIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(file.tabs.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [file.tabs]);

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

  // Both submit handlers follow the same shape: validate (and bail with
  // the input still open if invalid), try the IPC, only call cancelEdit
  // on success. On error the inline input stays mounted with the user's
  // typed value preserved — they can fix the conflict and re-press Enter
  // without retyping from scratch.
  const handleRenameSubmit = useCallback(
    async (oldPath: string, newName: string) => {
      if (newName === '') {
        sidebar.cancelEdit();
        return;
      }
      if (newName.includes('/') || newName.includes('\\')) {
        window.api.showError(
          'Invalid name',
          'Names cannot contain "/" or "\\".',
        );
        return; // Keep the input open so the user can correct.
      }
      try {
        const newPath = await window.api.folder.rename(oldPath, newName);
        // Keep open tabs in sync with the rename — without this the tab
        // still points at the old path and a Cmd+S would write a ghost
        // file at the original location.
        file.relocateTabs(oldPath, newPath);
        sidebar.cancelEdit();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.api.showError(
          'Could not rename',
          /EEXIST/i.test(message)
            ? `An item named "${newName}" already exists in that folder.`
            : message,
        );
        // Don't cancelEdit — leave the input visible so the user can
        // pick a different name.
      }
    },
    [sidebar, file],
  );

  const handleCreateSubmit = useCallback(
    async (parentPath: string, kind: 'file' | 'folder', name: string) => {
      if (name === '') {
        sidebar.cancelEdit();
        return;
      }
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
          sidebar.cancelEdit();
          void handleOpenPath(newPath);
        } else {
          await window.api.folder.createFolder(parentPath, name);
          sidebar.cancelEdit();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.api.showError(
          kind === 'file' ? 'Could not create file' : 'Could not create folder',
          /EEXIST/i.test(message)
            ? `An item named "${name}" already exists in that folder.`
            : message,
        );
        // Don't cancelEdit — keep the input mounted so the user's typing
        // is preserved and they can pick a different name.
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
        case 'new-claude-md':
          void handleCreateFromTemplate('claude');
          break;
        case 'new-skill-file':
          void handleCreateFromTemplate('skill');
          break;
        case 'open-file':
          void handleOpenFile();
          break;
        case 'open-path':
          if (event.payload?.path) void handleOpenPath(event.payload.path);
          break;
        case 'open-folder':
          // Route through the sidebar's openFolderDialog so the menu
          // entry has the same effect as the sidebar's "Open Folder"
          // button: pick a folder, populate the tree, swap the watcher.
          // Without this the menu fired a stub IPC that returned a path
          // and then dropped it on the floor.
          void handleOpenFolder();
          break;
        case 'close-folder':
          void sidebar.closeFolder();
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
        case 'theme-system':
          void theme.setAppPreference('system');
          break;
        case 'theme-light':
          void theme.setAppPreference('light');
          break;
        case 'theme-dark':
          void theme.setAppPreference('dark');
          break;
        case 'cycle-theme':
          void theme.cycleAppPreference();
          break;
        case 'editor-theme-system':
          void theme.setEditorPreference('system');
          break;
        case 'editor-theme-light':
          void theme.setEditorPreference('light');
          break;
        case 'editor-theme-dark':
          void theme.setEditorPreference('dark');
          break;
        case 'cycle-editor-theme':
          void theme.cycleEditorPreference();
          break;
        case 'editor-contrast-hard':
          void theme.setEditorContrast('hard');
          break;
        case 'editor-contrast-medium':
          void theme.setEditorContrast('medium');
          break;
        case 'editor-contrast-soft':
          void theme.setEditorContrast('soft');
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
    theme,
    handleNewFile,
    handleCreateFromTemplate,
    handleOpenFile,
    handleOpenFolder,
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
      {/* Gate on prefsReady so the persisted visibility wins on first
          paint — otherwise the default `false` would flash for users who
          had the sidebar shown last time, and the default `true` (used
          previously) flashed it open for users who had it hidden. Also
          require a `rootPath` — without an open folder the sidebar would
          be an empty stub redundant with the welcome screen's Open Folder
          button. */}
      {sidebar.prefsReady && sidebar.visible && sidebar.rootPath && (
        <Sidebar
          width={sidebar.width}
          onWidthChange={sidebar.setWidth}
          onWidthCommit={sidebar.commitWidth}
          rootName={sidebar.rootPath ? basenameOfPath(sidebar.rootPath) : null}
          onCollapseAll={sidebar.collapseAll}
          onCloseFolder={() => void sidebar.closeFolder()}
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
        {!updateBannerDismissed && (
          <UpdateBanner
            status={update.status}
            version={update.version}
            onInstall={update.install}
            onDismiss={() => setUpdateBannerDismissed(true)}
          />
        )}
        {showMissingClaudeBanner && (
          <WorkspaceBanner
            message="This workspace doesn't have a CLAUDE.md file. Would you like to create one from a template?"
            primaryLabel="Create"
            onPrimary={() => void handleCreateFromTemplate('claude')}
            onDismiss={handleDismissClaudeBanner}
          />
        )}
        {file.tabs.length > 0 && (
          <TabBar
            tabs={file.tabs}
            activeTabId={file.activeTabId}
            onActivate={handleSwitchTab}
            onClose={handleCloseTab}
            onReorder={file.reorderTabs}
          />
        )}
        {file.activeTab && templateHintTabIds.has(file.activeTab.id) && (
          <TemplateHintBanner
            onDismiss={() => {
              if (file.activeTab) dismissTemplateHint(file.activeTab.id);
            }}
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
              monacoThemeId={theme.monacoThemeId}
              onImageDrop={handleImageDrop}
              onImagePaste={handleImagePaste}
              onOpenImage={handleOpenImage}
              requireSavedPath={file.requireSavedPath}
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
