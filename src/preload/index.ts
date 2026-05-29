import { contextBridge, ipcRenderer, webUtils } from 'electron';

export type MenuActionType =
  | 'new'
  | 'new-claude-md'
  | 'new-skill-file'
  | 'open-file'
  | 'open-folder'
  | 'open-path'
  | 'close-folder'
  | 'save'
  | 'save-as'
  | 'export-pdf'
  | 'export-html'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'undo'
  | 'redo'
  | 'find'
  | 'replace'
  | 'toggle-sidebar'
  | 'read-mode'
  | 'wysiwyg-mode'
  | 'source-mode'
  | 'split-mode'
  | 'cycle-mode'
  | 'theme-system'
  | 'theme-light'
  | 'theme-dark'
  | 'cycle-theme'
  | 'editor-theme-system'
  | 'editor-theme-light'
  | 'editor-theme-dark'
  | 'cycle-editor-theme'
  | 'editor-contrast-hard'
  | 'editor-contrast-medium'
  | 'editor-contrast-soft'
  | 'toggle-word-wrap'
  | 'context-copy-as-markdown'
  | 'context-add-link'
  | 'context-open-link'
  | 'context-edit-link'
  | 'context-remove-link'
  | 'context-source-select-all'
  | 'context-preview-select-all'
  | 'paste-plain'
  | 'font-zoom-in'
  | 'font-zoom-out'
  | 'font-zoom-reset'
  | 'about';

export interface OpenedFile {
  path: string;
  content: string;
}

export interface MenuActionEvent {
  type: MenuActionType;
  payload?: {
    path?: string;
    content?: string;
  };
}

const files = {
  open: (): Promise<OpenedFile | null> => ipcRenderer.invoke('files:open'),
  openPath: (filePath: string): Promise<OpenedFile> =>
    ipcRenderer.invoke('files:open-path', filePath),
  save: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('files:save', filePath, content),
  saveAs: (content: string, suggestedName?: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('files:save-as', content, suggestedName),
  // webUtils.getPathForFile replaces the old File.path getter (removed in
  // Electron 32+) — needed for drag-and-drop in the sandboxed renderer.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

export type ItemMenuAction = 'new-file' | 'new-folder' | 'rename' | 'delete' | 'reveal' | 'open';

export type TemplateKind = 'claude' | 'skill';

export type TemplateCreateResult =
  | { status: 'created'; path: string; content: string }
  | { status: 'exists'; path: string }
  | { status: 'untitled'; content: string };

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  error?: string;
}

const update = {
  /** Read main's most recent UpdateState — used by the hook on first mount. */
  getState: (): Promise<UpdateState> => ipcRenderer.invoke('update:get-state'),
  /** Subscribe to state transitions pushed from main. */
  onStateChange: (callback: (state: UpdateState) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: UpdateState): void => callback(state);
    ipcRenderer.on('update:state', handler);
    return () => {
      ipcRenderer.off('update:state', handler);
    };
  },
  /** User clicked "Restart to update" — main calls quitAndInstall. */
  install: (): void => {
    ipcRenderer.send('update:install');
  },
};

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type EditorContrast = 'hard' | 'medium' | 'soft';
export type WordWrap = 'on' | 'off';

export interface AppThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}
export interface EditorThemeState {
  preference: ThemePreference;
  contrast: EditorContrast;
  resolved: ResolvedTheme;
  /**
   * Word-wrap mode for the Monaco source editor. Lives alongside theme
   * + contrast because it's another per-editor view preference; the
   * `theme:set-editor` IPC accepts it as part of the same payload to
   * avoid duplicating get / set / broadcast plumbing for one boolean.
   */
  wordWrap: WordWrap;
}
export interface ThemeState {
  app: AppThemeState;
  editor: EditorThemeState;
}

const theme = {
  get: (): Promise<ThemeState> => ipcRenderer.invoke('theme:get'),
  setApp: (pref: ThemePreference): Promise<ThemeState> => ipcRenderer.invoke('theme:set-app', pref),
  setEditor: (payload: {
    preference?: ThemePreference;
    contrast?: EditorContrast;
    wordWrap?: WordWrap;
  }): Promise<ThemeState> => ipcRenderer.invoke('theme:set-editor', payload),
  /**
   * Atomically flip the source-editor word-wrap mode. Resolves the
   * toggle in main against the persisted value, so back-to-back
   * presses that out-race React state updates still alternate
   * correctly.
   */
  toggleEditorWordWrap: (): Promise<ThemeState> =>
    ipcRenderer.invoke('theme:toggle-editor-word-wrap'),
  /** Subscribe to OS theme flips and explicit set events from main. */
  onChange: (callback: (state: ThemeState) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: ThemeState): void => callback(state);
    ipcRenderer.on('theme:updated', handler);
    return () => {
      ipcRenderer.off('theme:updated', handler);
    };
  },
};

export interface SavedAsset {
  /** Markdown-relative path for insertion (e.g. `assets/screenshot.png`). */
  relPath: string;
  /** Absolute on-disk path — used by "View full size" → shell.openPath. */
  absPath: string;
}

/**
 * RAISE-42: Export-to-PDF bridge.
 *
 * The renderer builds the full print-shell HTML (markdown-it preview
 * output + Rise design-system CSS + print-specific overrides) and
 * hands it to main alongside the user's modal selections. Main
 * renders into an off-screen BrowserWindow and calls
 * `webContents.printToPDF`, prompts the save dialog, and writes
 * the file. The result tells the renderer whether to show a success
 * toast (with the path), a cancellation no-op, or an error toast.
 */
export type ExportPdfPageSize = 'Letter' | 'Legal' | 'Tabloid' | 'A3' | 'A4' | 'A5';
export interface ExportPdfCustomPageSize {
  width: number; // inches
  height: number; // inches
}
export interface ExportPdfOptions {
  html: string;
  defaultBaseName: string;
  defaultDir: string | null;
  pageSize: ExportPdfPageSize | ExportPdfCustomPageSize;
  landscape: boolean;
  margins: { top: number; bottom: number; left: number; right: number };
  scale: number;
  headerFooter: {
    showHeader: boolean;
    showFooter: boolean;
    headerLeft: string;
    headerCenter: string;
    headerRight: string;
    footerLeft: string;
    footerCenter: string;
    footerRight: string;
    author: string;
    email: string;
  } | null;
  openAfter: boolean;
}
export type ExportPdfResult =
  | { status: 'saved'; path: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

/** RAISE-53: Export-to-HTML bridge. */
export type ExportHtmlImageMode = 'inline' | 'external';
export interface ExportHtmlOptions {
  html: string;
  defaultBaseName: string;
  defaultDir: string | null;
  imageMode: ExportHtmlImageMode;
  markdownPath: string | null;
  openAfter: boolean;
}
export type ExportHtmlResult =
  | { status: 'saved'; path: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

const exportApi = {
  toPdf: (opts: ExportPdfOptions): Promise<ExportPdfResult> =>
    ipcRenderer.invoke('export:to-pdf', opts),
  toHtml: (opts: ExportHtmlOptions): Promise<ExportHtmlResult> =>
    ipcRenderer.invoke('export:to-html', opts),
};

const assets = {
  saveDroppedImage: (markdownPath: string, sourcePath: string): Promise<SavedAsset> =>
    ipcRenderer.invoke('assets:save-dropped-image', { markdownPath, sourcePath }),
  savePastedImage: (
    markdownPath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<SavedAsset> =>
    ipcRenderer.invoke('assets:save-pasted-image', { markdownPath, bytes, mimeType }),
  openRelative: (markdownPath: string, relPath: string): Promise<string> =>
    ipcRenderer.invoke('assets:open-relative', { markdownPath, relPath }),
  pickAndImport: (markdownPath: string): Promise<SavedAsset | null> =>
    ipcRenderer.invoke('assets:pick-and-import', markdownPath),
};

const templates = {
  /**
   * Create a file from the named template. If a workspace is open
   * (`rootPath` non-null), the file is written to disk at the canonical
   * location and the renderer opens it as a regular tab. Without a
   * workspace, the body is handed back so the renderer can populate an
   * untitled tab from template content.
   */
  create: (kind: TemplateKind, rootPath: string | null): Promise<TemplateCreateResult> =>
    ipcRenderer.invoke('templates:create', { kind, rootPath }),
  claudeMdExists: (rootPath: string): Promise<boolean> =>
    ipcRenderer.invoke('templates:claude-md-exists', rootPath),
  isClaudeBannerDismissed: (rootPath: string): Promise<boolean> =>
    ipcRenderer.invoke('templates:is-claude-banner-dismissed', rootPath),
  dismissClaudeBanner: (rootPath: string): void => {
    ipcRenderer.send('templates:dismiss-claude-banner', rootPath);
  },
};

const folder = {
  /** Show the folder dialog, populate the sidebar, and start watching. */
  open: (): Promise<{ path: string; tree: TreeNode } | null> => ipcRenderer.invoke('folder:open'),
  /** Open a known folder path (e.g., from drag-drop or restore). */
  openPath: (folderPath: string): Promise<{ path: string; tree: TreeNode }> =>
    ipcRenderer.invoke('folder:open-path', folderPath),
  /** Re-read the tree without restarting the watcher. */
  getTree: (folderPath: string): Promise<TreeNode> =>
    ipcRenderer.invoke('folder:get-tree', folderPath),
  /** Stop watching and clear the persisted entry. */
  close: (): Promise<void> => ipcRenderer.invoke('folder:close'),
  /** Return the persisted last-opened folder + its tree if it still exists. */
  getLast: (): Promise<{ path: string; tree: TreeNode } | null> =>
    ipcRenderer.invoke('folder:get-last'),

  createFile: (parentPath: string, name: string): Promise<string> =>
    ipcRenderer.invoke('folder:create-file', parentPath, name),
  createFolder: (parentPath: string, name: string): Promise<string> =>
    ipcRenderer.invoke('folder:create-folder', parentPath, name),
  rename: (oldPath: string, newName: string): Promise<string> =>
    ipcRenderer.invoke('folder:rename', oldPath, newName),
  /**
   * RAISE-13: move a file or folder into a new parent directory.
   * Returns the new absolute path. Throws on invalid moves
   * (collision, self-into-self, descendant-of-self, cross-device).
   */
  move: (srcPath: string, destDir: string): Promise<string> =>
    ipcRenderer.invoke('folder:move', srcPath, destDir),
  /**
   * RAISE-13 follow-up: copy a file or folder into a new parent
   * directory. Same-parent copies auto-rename (`report.md` →
   * `report 2.md`); cross-parent copies require an unused name.
   */
  copy: (srcPath: string, destDir: string): Promise<string> =>
    ipcRenderer.invoke('folder:copy', srcPath, destDir),
  trash: (itemPath: string): Promise<void> => ipcRenderer.invoke('folder:trash', itemPath),
  reveal: (itemPath: string): void => {
    ipcRenderer.send('folder:reveal', itemPath);
  },
  /**
   * RAISE-13 follow-up: open a file in the OS default application
   * (`.html` → browser or VS Code per the user's file
   * associations, `.pdf` → Preview / Acrobat, etc.). Returns the
   * error string (empty on success) so the caller can decide
   * whether to surface a dialog.
   */
  openInSystem: (itemPath: string): Promise<string> =>
    ipcRenderer.invoke('folder:open-in-system', itemPath),
  confirmDelete: (name: string, isDirectory: boolean): Promise<boolean> =>
    ipcRenderer.invoke('folder:confirm-delete', name, isDirectory),
  statPath: (p: string): Promise<'file' | 'directory' | 'missing'> =>
    ipcRenderer.invoke('folder:stat-path', p),
  showItemMenu: (payload: {
    isDirectory: boolean;
    isMarkdown: boolean;
  }): Promise<ItemMenuAction | null> => ipcRenderer.invoke('folder:show-item-menu', payload),

  getSidebarPref: (): Promise<{ width: number; visible: boolean }> =>
    ipcRenderer.invoke('folder:get-sidebar-pref'),
  setSidebarWidth: (width: number): void => {
    ipcRenderer.send('folder:set-sidebar-width', width);
  },
  setSidebarVisible: (visible: boolean): void => {
    ipcRenderer.send('folder:set-sidebar-visible', visible);
  },

  onTreeChanged: (callback: (root: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: { root: string }): void =>
      callback(event.root);
    ipcRenderer.on('folder:tree-changed', handler);
    return () => {
      ipcRenderer.off('folder:tree-changed', handler);
    };
  },
  onFileChanged: (callback: (filePath: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: { path: string }): void =>
      callback(event.path);
    ipcRenderer.on('folder:file-changed', handler);
    return () => {
      ipcRenderer.off('folder:file-changed', handler);
    };
  },
};

/**
 * RAISE-28: editor-surface context menus. The renderer fires a
 * `contextmenu` DOM event, captures the relevant state (mode +
 * selection presence), and asks main to pop the native menu at the
 * cursor position. Most items use Electron `role`s (cut/copy/paste/
 * select-all); only `Copy as Markdown` (WYSIWYG only) routes back
 * through `menu:action` for the renderer to execute.
 */
export type EditorContextMode = 'wysiwyg' | 'source' | 'preview' | 'frontmatter';
/**
 * RAISE-51: clipboard read for the Paste and Match Style flow.
 * Menu accelerators (`Cmd/Ctrl+Shift+V`) don't give the renderer
 * a `DataTransfer` the way DOM paste events do, so we read the
 * system clipboard out of band.
 *
 * Initial implementation tried `import { clipboard } from 'electron'`
 * directly in the preload and exposed a sync function. That doesn't
 * work: `webPreferences.sandbox: true` (set in `main/index.ts`'s
 * BrowserWindow) bundles the preload through Electron's sandbox
 * bundler, which strips every `electron` module except `contextBridge`,
 * `ipcRenderer`, `webFrame`, `webUtils`, and `crashReporter`. The
 * `clipboard` symbol becomes `undefined` at runtime, and the
 * sync-call shape throws inside the contextBridge proxy with the
 * error invisible to the renderer (silent paste no-op — the symptom
 * the smoke-test caught).
 *
 * IPC round-trip — async — is the correct shape. `clipboard.readText()`
 * runs in main where it's actually available, and the renderer awaits.
 *
 * Returns the empty string when the clipboard has no `text/plain`
 * slot (image-only clipboards, etc.). The renderer treats empty
 * as a no-op paste, matching the ticket's "image clipboards
 * short-circuit" spec.
 */
const clipboardApi = {
  readText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
  /**
   * RAISE-51 smoke-test follow-up: WYSIWYG paste-plain prefers the
   * `text/html` slot and reduces it to `textContent` so a heading
   * copied from inside the app pastes as "Header" rather than
   * "## Header". Returns the raw HTML; the renderer's
   * `htmlToPlainText` helper does the reduction.
   */
  readHTML: (): Promise<string> => ipcRenderer.invoke('clipboard:read-html'),
};

// RAISE-74: renderer-driven menu state for the View menu's Zoom
// items. The renderer pushes the current "is monaco active?" boolean
// whenever the active tab's mode changes; main flips the three Zoom
// menu items' `enabled` flag (which also disables their accelerators)
// in response. Fire-and-forget — no reply expected.
const view = {
  setZoomEnabled: (enabled: boolean): void => {
    ipcRenderer.send('view:zoom-enabled', enabled);
  },
};

const contextMenu = {
  showEditor: (payload: {
    mode: EditorContextMode;
    hasSelection: boolean;
    /** RAISE-38: true when the right-click landed on an existing
     *  link element. Surfaces an "Edit Link…" menu item. */
    isOnLink?: boolean;
  }): Promise<void> => ipcRenderer.invoke('context-menu:show-editor', payload),
};

const api = {
  // 'darwin' | 'win32' | 'linux' | etc. Lets the renderer branch on
  // macOS without parsing navigator.userAgent.
  platform: process.platform as NodeJS.Platform,
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  confirmUnsavedChanges: (filename: string): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('dialog:confirm-unsaved', filename),
  confirmFileReload: (filename: string, isDirty: boolean): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm-reload', filename, isDirty),
  showError: (title: string, message: string): void => {
    ipcRenderer.send('dialog:show-error', { title, message });
  },
  /**
   * RAISE-38: open a URL in the user's default external browser.
   * Used by the WYSIWYG modifier-click handler and the Split-mode
   * preview pane's link click handler. Main validates the URL
   * scheme (http / https / mailto only) before forwarding to
   * shell.openExternal, so arbitrary `javascript:` or `file:` URLs
   * are silently dropped.
   */
  openExternal: (url: string): void => {
    ipcRenderer.send('shell:open-external', url);
  },
  notifyReady: (): void => {
    ipcRenderer.send('renderer:ready');
  },
  closeWindow: (): void => {
    ipcRenderer.send('window:close');
  },
  files,
  folder,
  templates,
  theme,
  assets,
  update,
  contextMenu,
  view,
  clipboard: clipboardApi,
  export: exportApi,
  // Active tab signal (path + isDirty) plus the global dirtyCount. Pushed
  // synchronously on every change so main's title and close-with-unsaved
  // decision can never read a stale flag immediately after a keystroke.
  pushFileMeta: (meta: { path: string | null; isDirty: boolean; dirtyCount: number }): void => {
    ipcRenderer.send('file:meta', meta);
  },
  getRecent: (): Promise<string[]> => ipcRenderer.invoke('recent:get'),
  addRecent: (filePath: string): void => {
    ipcRenderer.send('recent:add', filePath);
  },
  clearRecent: (): void => {
    ipcRenderer.send('recent:clear');
  },
  onMenuAction: (callback: (event: MenuActionEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: MenuActionEvent): void => callback(event);
    ipcRenderer.on('menu:action', handler);
    return () => {
      ipcRenderer.off('menu:action', handler);
    };
  },
  onFileSavedAs: (callback: (event: { path: string; content: string }) => void): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      event: { path: string; content: string },
    ): void => callback(event);
    ipcRenderer.on('file:saved-as', handler);
    return () => {
      ipcRenderer.off('file:saved-as', handler);
    };
  },
  // Window-close dirty-tab resolution. Main asks the renderer to either
  // save every dirty tab in one shot ('save-all') or walk through them
  // tab-by-tab ('review'). The renderer replies with the aggregate result.
  onResolveDirty: (callback: (mode: 'save-all' | 'review') => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, mode: 'save-all' | 'review'): void =>
      callback(mode);
    ipcRenderer.on('window:resolve-dirty', handler);
    return () => {
      ipcRenderer.off('window:resolve-dirty', handler);
    };
  },
  respondResolveDirty: (ok: boolean): void => {
    ipcRenderer.send('window:resolve-dirty:result', ok);
  },
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
