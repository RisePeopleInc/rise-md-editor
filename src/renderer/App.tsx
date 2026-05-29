import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { WorkspaceBanner } from './components/WorkspaceBanner';
import { TemplateHintBanner } from './components/TemplateHintBanner';
import { UpdateBanner } from './components/UpdateBanner';
import { EditorContainer } from './components/editors/EditorContainer';
import { type CursorPosition, type SourceEditorHandle } from './components/editors/SourceEditor';
import { type WysiwygEditorHandle } from './components/editors/WysiwygEditor';
import { ExportPdfModal, type ExportPdfSubmitPayload } from './components/ExportPdfModal';
import { ExportHtmlModal, type ExportHtmlSubmitPayload } from './components/ExportHtmlModal';
import { buildPrintHtml } from './state/exportPdfHtml';
import { htmlToPlainText, normalizeInvisibleSpaces } from './state/clipboardPaste';
import { Sidebar } from './components/sidebar/Sidebar';
import { FileTree } from './components/sidebar/FileTree';
import { FileProvider, isTabDirty, useFileState, type EditorMode } from './state/fileState';
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

// Cycle order for Cmd+\: Read → WYSIWYG → Source → Split → Read.
// RAISE-60 added Read at the head of the cycle to match its leftmost
// position in the ModeSwitcher pill.
const MODE_CYCLE: EditorMode[] = ['read', 'wysiwyg', 'source', 'split'];

function nextMode(mode: EditorMode): EditorMode {
  const idx = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? 'wysiwyg';
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

  // RAISE-59: mirror the latest `file` state in a ref so async callbacks
  // can re-read tab state after their initial closure capture. The
  // onFileChanged handler below defers its dirty re-check across ~250ms;
  // during that window, fileState may pick up a Milkdown emit the
  // closure-bound `file` doesn't yet see. Reassigning on every render
  // keeps the ref pointed at the same object useFileState last returned.
  const fileRef = useRef(file);
  fileRef.current = file;

  // Tabs that were freshly opened from a template — these get a small
  // dismissible hint banner above the editor reminding the user to fill
  // in the placeholders. Cleared when the user dismisses or when the
  // tab is closed.
  const [templateHintTabIds, setTemplateHintTabIds] = useState<Set<string>>(() => new Set());
  // Visibility of the workspace-level "no CLAUDE.md found" banner. Driven
  // by an effect below: re-checked whenever the open folder changes and
  // when the tree refreshes (so the banner clears as soon as the user
  // creates the file via this banner OR via File → New CLAUDE.md).
  const [showMissingClaudeBanner, setShowMissingClaudeBanner] = useState<boolean>(false);
  // RAISE-42: Export-to-PDF modal state. The modal opens via the
  // `export-pdf` menu action (File → Export → PDF…, the
  // Cmd/Ctrl+Shift+E accelerator, or context-menu later). The
  // open boolean drives mount; submit handler builds the print
  // HTML, calls main, dismisses the modal.
  const [showExportPdfModal, setShowExportPdfModal] = useState(false);
  // Captured at modal-open time. The modal needs to know whether
  // there's a non-empty selection in the active editor to enable
  // the "Selection only" radio. Sourced from the Monaco / preview
  // selection at click time rather than recomputed live.
  const [exportPdfHasSelection, setExportPdfHasSelection] = useState(false);
  const [exportPdfSelectionText, setExportPdfSelectionText] = useState('');
  // RAISE-53: HTML export uses the same selection-capture pattern as
  // PDF — Monaco's `getSelectionText` returns the markdown source
  // slice for the highlighted range; WYSIWYG selection-to-markdown
  // isn't implemented (same follow-up gap as PDF), so the modal
  // shows the "Selection only" radio disabled in WYSIWYG mode.
  const [showExportHtmlModal, setShowExportHtmlModal] = useState(false);
  const [exportHtmlHasSelection, setExportHtmlHasSelection] = useState(false);
  const [exportHtmlSelectionText, setExportHtmlSelectionText] = useState('');

  const activeMode = file.activeTab?.editorMode;
  const isWysiwyg = activeMode === 'wysiwyg';
  // RAISE-60: positive-check rather than `!isWysiwyg`. Pre-Read-mode the
  // binary `!isWysiwyg` was correct because there were only three modes
  // and the two non-WYSIWYG ones (Source, Split) both used Monaco. Read
  // mode is a third non-WYSIWYG mode with NO Monaco editor mounted, so
  // a negation now lies — it would claim Monaco is active in Read mode
  // and trigger find/replace / selection-capture against a stale or
  // null `editorRef`. Source-style editor (Monaco) drives undo/redo for
  // both Source AND Split; Read mode gets neither.
  const isMonacoActive = activeMode === 'source' || activeMode === 'split';

  // RAISE-74: push the current monaco-active state to main so the
  // View menu's Zoom In / Out / Reset items (and their accelerators)
  // are greyed out in Read and Edit modes where they're silent no-ops.
  // Only Code (Monaco) and Split modes have the zoom IPC wired into
  // Monaco's font-size today. Pushed on every change rather than only
  // on user-driven mode switches so that tab close / open / switch
  // events all converge to the right menu state.
  useEffect(() => {
    window.api.view.setZoomEnabled(isMonacoActive);
  }, [isMonacoActive]);

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
    // RAISE-84: every open path — Finder/Explorer double-click, "Open
    // With", in-app sidebar click, drag-drop, Open dialog, recents —
    // opens the new tab in the default Edit (WYSIWYG) mode. Pre-RAISE-84
    // OS-launched files defaulted to Read mode (RAISE-60), but user
    // feedback was that the more common intent is "I want to fix
    // something," so Edit is the better default. Already-open tabs keep
    // their current mode — `loadFile` deliberately doesn't touch
    // `editorMode` on re-open.
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
        const result = await window.api.templates.create(kind, sidebar.rootPath);
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
          kind === 'claude' ? 'Could not create CLAUDE.md' : 'Could not create skill file',
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
  // RAISE-13: drag-and-drop move. FileTree validates renderer-side
  // (no-op moves, self-into-self, descendant-of-self all disable the
  // drop before this fires), so by the time we get here the move
  // *should* succeed. Main re-validates and surfaces collision /
  // cross-device errors as throws — we map those to user-facing
  // dialogs and otherwise rely on chokidar's onTreeChanged signal
  // to re-render the tree from disk.
  const handleMove = useCallback(
    async (srcPath: string, destDir: string) => {
      try {
        const newPath = await window.api.folder.move(srcPath, destDir);
        // Keep open tabs aligned with the new path. `relocateTabs`
        // also rewrites descendants of a moved folder, so a file
        // open inside `srcPath/sub/foo.md` follows the move
        // automatically.
        file.relocateTabs(srcPath, newPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.api.showError(
          'Could not move',
          /EEXIST/i.test(message)
            ? message.includes('already exists')
              ? message
              : `An item with that name already exists in the destination folder.`
            : message,
        );
      }
    },
    [file],
  );

  // RAISE-13 follow-up: double-click on a non-markdown file in the
  // sidebar opens it in the OS default application. `shell.openPath`
  // returns the error string (empty on success) so we forward it to
  // the user-facing error dialog when present. Common failure modes
  // include no app associated with the extension (rare on macOS;
  // surfaces a "no default app" system dialog from the OS itself
  // before this handler even runs) and permission errors on
  // network-mounted volumes.
  const handleOpenExternal = useCallback(async (filePath: string) => {
    try {
      const errMessage = await window.api.folder.openInSystem(filePath);
      if (errMessage) {
        window.api.showError('Could not open file', errMessage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.api.showError('Could not open file', message);
    }
  }, []);

  // RAISE-13 follow-up: opt-drag / ctrl-drag duplicates the dragged
  // item. Unlike move, the source is unchanged — no `relocateTabs`
  // call needed. chokidar's tree-changed signal repaints the
  // sidebar with the new file. Same-parent copies auto-rename
  // (main does the allocation); cross-parent collisions throw
  // EEXIST just like move.
  const handleCopy = useCallback(async (srcPath: string, destDir: string) => {
    try {
      await window.api.folder.copy(srcPath, destDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.api.showError(
        'Could not copy',
        /EEXIST/i.test(message)
          ? message.includes('already exists')
            ? message
            : `An item with that name already exists in the destination folder.`
          : message,
      );
    }
  }, []);

  const handleRenameSubmit = useCallback(
    async (oldPath: string, newName: string) => {
      if (newName === '') {
        sidebar.cancelEdit();
        return;
      }
      if (newName.includes('/') || newName.includes('\\')) {
        window.api.showError('Invalid name', 'Names cannot contain "/" or "\\".');
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
        window.api.showError('Invalid name', 'Names cannot contain "/" or "\\".');
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

  // RAISE-42: open the Export → PDF modal. Captures the active
  // editor's selection state at click time and stashes it for
  // the submit handler — the modal's "Selection only" radio
  // reflects the editor's state at the moment the user invoked
  // the export, not whatever live state exists after the modal
  // steals focus.
  //
  // Smoke-test feedback round 1: the v1 implementation used
  // `window.getSelection()` for Monaco source mode, which
  // returned plain text but missed Monaco's selection because
  // Monaco's custom-rendered DOM doesn't reliably participate in
  // the document's selection model. Switched to Monaco's own
  // `editor.getSelection()` + `model.getValueInRange()` via the
  // SourceEditorHandle's `getSelectionText` method, which
  // returns the actual markdown source slice — the same string
  // we'd pass to `buildPrintHtml` to render the partial doc.
  //
  // WYSIWYG mode: still disabled. Selection-only in WYSIWYG
  // would require ProseMirror-slice → markdown serialisation
  // scoped to the selected range, which is a separate piece of
  // work (tracked as a follow-up). Modal radio stays disabled
  // when `isWysiwyg`.
  const openExportPdfModal = useCallback(() => {
    let selectionText = '';
    if (isMonacoActive) {
      selectionText = editorRef.current?.getSelectionText() ?? '';
    } else {
      // WYSIWYG: see comment block above.
      selectionText = '';
    }
    setExportPdfSelectionText(selectionText);
    setExportPdfHasSelection(selectionText.trim().length > 0);
    setShowExportPdfModal(true);
  }, [isMonacoActive]);

  // RAISE-42: submit-handler for the export modal. Builds the
  // print-shell HTML in the renderer (so we get the same markdown-
  // it pipeline the preview pane uses), then ships it to main for
  // the off-screen render + save-dialog flow. Dismisses the modal
  // unconditionally — main shows its own success / error UI.
  const handleExportPdfSubmit = useCallback(
    async (payload: ExportPdfSubmitPayload) => {
      setShowExportPdfModal(false);
      const tab = file.activeTab;
      if (!tab) return;
      // Selection-mode source. Trim leading / trailing whitespace so
      // a selection that starts mid-paragraph (with a leading newline
      // dragged in by the user) doesn't render as a blank paragraph
      // at the top of the PDF. Internal blank lines between
      // paragraphs are preserved — markdown-it needs `\n\n` to
      // recognise paragraph boundaries, and `.trim()` only touches
      // the outer edges.
      const sourceMarkdown =
        payload.range === 'selection' && exportPdfSelectionText
          ? exportPdfSelectionText.trim()
          : tab.content;
      const baseName = tab.path ? basenameOfPath(tab.path).replace(/\.[^.]+$/, '') : 'Untitled';
      const docDir = tab.path ? tab.path.replace(/[\\/][^\\/]*$/, '') : null;
      const html = buildPrintHtml({
        title: baseName,
        markdownSource: sourceMarkdown,
        markdownPath: tab.path,
        stripComments: payload.stripComments,
        outputMode: 'pdf',
      });
      const result = await window.api.export.toPdf({
        html,
        defaultBaseName: baseName,
        defaultDir: docDir,
        pageSize: payload.pageSize,
        landscape: payload.landscape,
        margins: payload.margins,
        scale: payload.scale,
        headerFooter: payload.headerFooter,
        openAfter: payload.openAfter,
      });
      if (result.status === 'error') {
        window.api.showError('Export to PDF failed', result.message);
      }
    },
    [file.activeTab, exportPdfSelectionText],
  );

  // RAISE-53: open-handler for the HTML export modal. Mirrors the
  // PDF open handler — same selection capture, same Monaco/WYSIWYG
  // mode gate. Differs only in which modal state it flips.
  const openExportHtmlModal = useCallback(() => {
    let selectionText = '';
    if (isMonacoActive) {
      selectionText = editorRef.current?.getSelectionText() ?? '';
    }
    setExportHtmlSelectionText(selectionText);
    setExportHtmlHasSelection(selectionText.trim().length > 0);
    setShowExportHtmlModal(true);
  }, [isMonacoActive]);

  // RAISE-53: submit-handler for the HTML export modal. Shares the
  // renderer-side print HTML pipeline with PDF (so the output is
  // visually identical to what `Export to PDF` would produce). Main
  // does the additional image-source transformation — either
  // inlining as data URIs or copying into a zip's assets/ folder.
  const handleExportHtmlSubmit = useCallback(
    async (payload: ExportHtmlSubmitPayload) => {
      setShowExportHtmlModal(false);
      const tab = file.activeTab;
      if (!tab) return;
      const sourceMarkdown =
        payload.range === 'selection' && exportHtmlSelectionText
          ? exportHtmlSelectionText.trim()
          : tab.content;
      const baseName = tab.path ? basenameOfPath(tab.path).replace(/\.[^.]+$/, '') : 'Untitled';
      const docDir = tab.path ? tab.path.replace(/[\\/][^\\/]*$/, '') : null;
      const html = buildPrintHtml({
        title: baseName,
        markdownSource: sourceMarkdown,
        markdownPath: tab.path,
        stripComments: payload.stripComments,
        outputMode: 'html',
      });
      const result = await window.api.export.toHtml({
        html,
        defaultBaseName: baseName,
        defaultDir: docDir,
        imageMode: payload.imageMode,
        markdownPath: tab.path,
        openAfter: payload.openAfter,
      });
      if (result.status === 'error') {
        window.api.showError('Export to HTML failed', result.message);
      }
    },
    [file.activeTab, exportHtmlSelectionText],
  );

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

  // RAISE-85: Read-mode task-list checkbox toggle. ReadView hands us the
  // full new markdown (the clicked line already flipped); we persist it.
  //
  //  - Saved file: write to disk, then `setActiveContentSaved` realigns
  //    the tab's content + savedContent + baseline so the tab stays clean
  //    (no dirty marker, no prompt — the silent-save contract). Resolves
  //    `true` so ReadView's optimistic DOM flip stands. On a write error
  //    (read-only file, permissions) resolves `false` so ReadView reverts
  //    the checkbox and shows a non-modal notice — note we deliberately
  //    do NOT call window.api.showError here (that's a blocking dialog).
  //  - Untitled file: there's no path to silently save to. Toggle
  //    in-memory via `setContent` (which marks the tab dirty, the honest
  //    state) and resolve `true` so the flip stands; the user saves it
  //    when ready via Cmd+S. Graceful, no crash.
  const handleReadToggleTask = useCallback(
    async (newContent: string): Promise<boolean> => {
      const tab = file.activeTab;
      if (!tab) return false;
      if (!tab.path) {
        // Untitled — can't silent-save. Keep the edit in memory; the tab
        // becomes dirty until the user saves it.
        file.setContent(newContent);
        return true;
      }
      try {
        await window.api.files.save(tab.path, newContent);
        file.setActiveContentSaved(newContent);
        return true;
      } catch {
        // Read-only / locked / write error — ReadView surfaces a
        // non-modal notice and reverts the optimistic flip.
        return false;
      }
    },
    [file],
  );

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
        const target = Array.from(dropped).find((f) => ACCEPTED_EXTENSIONS.test(f.name));
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
          if (event.payload?.path) {
            void handleOpenPath(event.payload.path);
          }
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
        case 'export-pdf':
          // RAISE-42: open the modal. The submit handler runs the
          // markdown-it render, ships HTML to main, kicks the save
          // dialog flow.
          openExportPdfModal();
          break;
        case 'export-html':
          // RAISE-53: same shape as export-pdf, different modal.
          openExportHtmlModal();
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
        case 'redo': {
          // RAISE-28: the YAML frontmatter textarea has its own native
          // undo stack. Without this branch, Cmd+Z when the textarea
          // is focused routes to Milkdown's history (because we're in
          // WYSIWYG mode), which leaves the textarea's recent edits
          // (e.g., a paste) un-undone.
          //
          // Targeting only the frontmatter textarea by its unique
          // class — a broader `instanceof HTMLTextAreaElement` check
          // would also match Monaco's internal hidden IME textarea
          // (`.monaco-editor .inputarea`) and break Monaco undo.
          const active = document.activeElement;
          if (active?.classList.contains('rise-md-frontmatter')) {
            // execCommand is deprecated in the spec but still works in
            // Chromium for `<textarea>` / `<input>` undo + redo. No
            // modern alternative exists for synthetic-event undo on
            // these elements.
            document.execCommand(event.type === 'undo' ? 'undo' : 'redo');
            break;
          }
          if (event.type === 'undo') {
            if (isWysiwyg) wysiwygRef.current?.triggerUndo();
            else editorRef.current?.triggerUndo();
          } else {
            if (isWysiwyg) wysiwygRef.current?.triggerRedo();
            else editorRef.current?.triggerRedo();
          }
          break;
        }
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
        case 'read-mode':
          // RAISE-60: Cmd+1 / View → Read Mode. Switches the active
          // tab to Read view (read-only rendered markdown).
          handleModeChange('read');
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
        case 'toggle-word-wrap':
          void theme.toggleEditorWordWrap();
          break;
        case 'context-copy-as-markdown':
          // RAISE-28: dispatched from the WYSIWYG context menu. The
          // WysiwygEditor handle owns the Milkdown serializer access;
          // we just route the action.
          void wysiwygRef.current?.copyAsMarkdown();
          break;
        case 'paste-plain': {
          // RAISE-51: Paste and Match Style (Cmd/Ctrl+Shift+V).
          // Read the system clipboard via the preload bridge (async
          // IPC — the sandboxed preload can't access Electron's
          // `clipboard` module directly, so main does the read).
          //
          // Mode-specific source slot:
          //
          //   - **WYSIWYG**: prefer `text/html` reduced to its visible
          //     text content (via `htmlToPlainText`). Drops every
          //     styling marker including markdown syntax. Copying a
          //     heading from Edit mode pastes "Header", not "## Header"
          //     (Milkdown puts both markdown in text/plain AND HTML
          //     in text/html on copy — the smoke-test bug was that
          //     we always used text/plain). Falls back to text/plain
          //     when no HTML slot exists (e.g. clipboard from a
          //     terminal, plain-text-only clipboard write).
          //   - **Source / Split**: use `text/plain` verbatim. The
          //     user is editing raw markdown there; if they copied
          //     `## Header` they want `## Header` back.
          //   - **Read**: no-op (no editable surface; the context-
          //     menu paste-plain item is also unreachable in Read).
          //
          // Empty result short-circuits to nothing, matching the
          // ticket's "image clipboards → no plain-text equivalent,
          // paste is a no-op" spec.
          //
          // Capture the mode flags into locals before the await —
          // by the time the promise resolves the user could have
          // switched modes; we want the paste to land where the
          // accelerator was pressed.
          const wantWysiwyg = isWysiwyg;
          const wantMonaco = isMonacoActive;
          void (async () => {
            if (wantWysiwyg) {
              const html = await window.api.clipboard.readHTML();
              // `htmlToPlainText` already normalises U+00A0 / U+FEFF.
              const fromHtml = html ? htmlToPlainText(html) : '';
              const text =
                fromHtml || normalizeInvisibleSpaces(await window.api.clipboard.readText());
              if (!text) return;
              wysiwygRef.current?.pastePlain(text);
            } else if (wantMonaco) {
              // Source / Split also benefit from U+00A0 normalisation
              // — pasted webpage text into Monaco would otherwise
              // leave non-breaking spaces in the markdown source.
              const text = normalizeInvisibleSpaces(await window.api.clipboard.readText());
              if (!text) return;
              editorRef.current?.pastePlain(text);
            }
          })();
          break;
        }
        case 'context-add-link':
          // RAISE-38: dispatched from the WYSIWYG context menu's
          // "Add Link…" item (selection-only). Routes into the
          // toolbar's existing link-prompt flow via the imperative
          // handle so right-click → Add Link uses the same modal as
          // the toolbar button.
          wysiwygRef.current?.promptLink();
          break;
        case 'context-open-link':
          // RAISE-86: right-click on a link → "Open Link". The
          // WYSIWYG right-click handler has already moved the caret
          // onto the link, so the editor resolves the link from the
          // caret position and opens it in the system browser.
          wysiwygRef.current?.openLink();
          break;
        case 'context-edit-link':
          // RAISE-86: right-click on a link → "Edit Link". Surfaces
          // the link popover's inline URL field anchored to the link.
          wysiwygRef.current?.editLink();
          break;
        case 'context-remove-link':
          // RAISE-86: right-click on a link → "Remove Link". Strips
          // the link mark from the caret's link, keeping the text.
          wysiwygRef.current?.removeLink();
          break;
        case 'context-source-select-all':
          // RAISE-28: dispatched from the Source-mode context menu.
          // Routes to Monaco's own `editor.action.selectAll` —
          // `webContents.selectAll()` (the role used by Electron menus)
          // doesn't reach Monaco's internal selection.
          editorRef.current?.selectAll();
          break;
        case 'context-preview-select-all': {
          // RAISE-28: dispatched from the preview-pane context menu.
          // Programmatic selection scoped to the preview node — looking
          // it up by data attribute rather than `.rise-md-prose` because
          // the latter is also used by the WYSIWYG body, and we want
          // to be unambiguous about which surface we're selecting.
          const preview = document.querySelector('[data-rise-md-preview-pane]');
          if (preview) {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(preview);
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          break;
        }
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
    openExportPdfModal,
    openExportHtmlModal,
  ]);

  // RAISE-56: external-change handling. When chokidar reports a content
  // change for a file that's open in a tab, the response splits on
  // whether the local copy is dirty:
  //
  //   - Clean tab: silently refresh from disk. No prompt. This is the
  //     "Claude (or any external tool) edits a file the user has open;
  //     they just see the new content" path — the canonical Cowork
  //     workflow this editor was built around.
  //
  //   - Dirty tab: prompt with the existing confirm-reload dialog
  //     so the user can choose to keep their local edits or discard
  //     them in favour of the on-disk version. Same UX as before.
  //
  // Main's `recentlyTouched` debounce (~1.5s after the editor's own
  // saves and opens) already suppresses the watcher event for I/O
  // initiated by the renderer, so this path never fires "we just
  // wrote a file → reload it?" feedback loops.
  //
  // Note: this only fires when a folder is open (Project Mode);
  // single-file mode has no watcher today. Tracked as a follow-up
  // on RAISE-56.
  useEffect(() => {
    const off = window.api.folder.onFileChanged(async (filePath) => {
      const tab = file.tabs.find((t) => t.path === filePath);
      if (!tab) return;

      if (!isTabDirty(tab)) {
        // RAISE-59: Milkdown debounces `markdownUpdated` emits ~200ms.
        // A keystroke the user just typed may have dispatched a
        // ProseMirror transaction but not yet reached fileState, so the
        // initial isTabDirty above can be a false negative. Defer 250ms
        // to let any in-flight emit settle, then re-check against the
        // latest tab state via fileRef (the closure-bound `file` won't
        // reflect updates that happen during the wait). If the user
        // typed during the deferral the tab is now dirty and we fall
        // through to the prompt path; otherwise silent reload as before.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const freshTab = fileRef.current.tabs.find((t) => t.path === filePath);
        if (!freshTab) return;
        if (!isTabDirty(freshTab)) {
          // Still clean — silently refresh.
          try {
            const result = await window.api.files.openPath(filePath);
            fileRef.current.refreshTabFromDisk(result.path, result.content);
          } catch (err) {
            // Transient FS errors (file briefly missing during atomic
            // rename, locked by another process, etc.) are uninteresting
            // for the silent path — we'll catch the next change event
            // once the write settles. Log to console for debug visibility
            // but don't pop a dialog.
            console.warn('Silent reload failed for', filePath, err);
          }
          return;
        }
        // Fell through to the prompt path because the user typed during
        // the deferral — the dirty state is now real.
      }

      // Dirty local copy — prompt as before.
      const reload = await window.api.confirmFileReload(basenameOfPath(filePath), true);
      if (!reload) return;
      try {
        const result = await window.api.files.openPath(filePath);
        fileRef.current.refreshTabFromDisk(result.path, result.content);
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
              onOpenExternal={(p) => void handleOpenExternal(p)}
              onContextMenu={handleTreeContextMenu}
              editingPath={sidebar.editingPath}
              creating={sidebar.creating}
              onRenameSubmit={(p, name) => void handleRenameSubmit(p, name)}
              onCreateSubmit={(parent, kind, name) => void handleCreateSubmit(parent, kind, name)}
              onEditCancel={sidebar.cancelEdit}
              onMove={(src, dest) => void handleMove(src, dest)}
              onCopy={(src, dest) => void handleCopy(src, dest)}
            />
          )}
        </Sidebar>
      )}
      {/*
       * `min-w-0` is the load-bearing fix for [RAISE-26](https://risepeople.atlassian.net/browse/RAISE-26).
       * This div is a row-flex child of the outer Sidebar+editor row at line
       * 706. Without `min-w-0`, the default `min-width: auto` on flex items
       * means it refuses to shrink below the intrinsic content width of its
       * descendants. In split mode that's the longest line in Monaco's
       * source view, which can be far wider than the window — causing this
       * column to grow past the row, and the WYSIWYG pane inside SplitView
       * gets pushed off the right edge of the screen. Capping inside
       * SplitView alone wasn't enough; the chain above it has to shrink too.
       */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        <main className="min-h-0 min-w-0 flex-1">
          {file.activeTab ? (
            <EditorContainer
              tab={file.activeTab}
              onContentChange={file.setContent}
              onContentBaseline={file.setMarkdownBaseline}
              onModeChange={handleModeChange}
              onCursorChange={setCursor}
              onReadScrollChange={file.setActiveReadScroll}
              onReadToggleTask={handleReadToggleTask}
              sourceRef={editorRef}
              wysiwygRef={wysiwygRef}
              monacoThemeId={theme.monacoThemeId}
              wordWrap={theme.editor.wordWrap}
              onImageDrop={handleImageDrop}
              onImagePaste={handleImagePaste}
              onOpenImage={handleOpenImage}
              requireSavedPath={file.requireSavedPath}
            />
          ) : (
            <WelcomeScreen
              onNewFile={handleNewFile}
              onOpenFile={handleOpenFile}
              onOpenFolder={handleOpenFolder}
            />
          )}
        </main>
        {file.activeTab &&
          (() => {
            // RAISE-60 follow-up: Ln/Col only makes sense in modes
            // backed by a source view (Source, Split). In Read there's
            // no cursor at all; in WYSIWYG the ProseMirror offset
            // doesn't translate to source line/col cheaply. Pass
            // undefined in those modes so the statusbar renders blank
            // instead of stale Monaco state from the last time the
            // user was in Source/Split.
            const mode = file.activeTab.editorMode;
            const hasCursor = mode === 'source' || mode === 'split';
            return (
              <StatusBar
                line={hasCursor ? cursor.line : undefined}
                column={hasCursor ? cursor.column : undefined}
                wordCount={wordCount}
                mode={mode}
              />
            );
          })()}
      </div>
      {/* RAISE-42: Export-to-PDF modal. Mounted here (top-level
          App layout) rather than inside the editor surfaces so a
          single instance survives mode swaps and tab switches. */}
      {showExportPdfModal && (
        <ExportPdfModal
          hasSelection={exportPdfHasSelection}
          onCancel={() => setShowExportPdfModal(false)}
          onSubmit={(payload) => {
            void handleExportPdfSubmit(payload);
          }}
        />
      )}
      {/* RAISE-53: HTML export modal. Same mount-at-app-root pattern as
          the PDF modal — survives mode swaps and tab switches, single
          instance per app session. */}
      {showExportHtmlModal && (
        <ExportHtmlModal
          hasSelection={exportHtmlHasSelection}
          onCancel={() => setShowExportHtmlModal(false)}
          onSubmit={(payload) => {
            void handleExportHtmlSubmit(payload);
          }}
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
