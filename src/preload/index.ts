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
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'undo'
  | 'redo'
  | 'find'
  | 'replace'
  | 'toggle-sidebar'
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
  payload?: { path?: string; content?: string };
}

const files = {
  open: (): Promise<OpenedFile | null> => ipcRenderer.invoke('files:open'),
  openPath: (filePath: string): Promise<OpenedFile> =>
    ipcRenderer.invoke('files:open-path', filePath),
  save: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('files:save', filePath, content),
  saveAs: (
    content: string,
    suggestedName?: string,
  ): Promise<{ path: string } | null> =>
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

export type ItemMenuAction =
  | 'new-file'
  | 'new-folder'
  | 'rename'
  | 'delete'
  | 'reveal'
  | 'open';

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
    const handler = (_: Electron.IpcRendererEvent, state: UpdateState): void =>
      callback(state);
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
  setApp: (pref: ThemePreference): Promise<ThemeState> =>
    ipcRenderer.invoke('theme:set-app', pref),
  setEditor: (payload: {
    preference?: ThemePreference;
    contrast?: EditorContrast;
    wordWrap?: WordWrap;
  }): Promise<ThemeState> => ipcRenderer.invoke('theme:set-editor', payload),
  /** Subscribe to OS theme flips and explicit set events from main. */
  onChange: (callback: (state: ThemeState) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: ThemeState): void =>
      callback(state);
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
  create: (
    kind: TemplateKind,
    rootPath: string | null,
  ): Promise<TemplateCreateResult> =>
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
  open: (): Promise<{ path: string; tree: TreeNode } | null> =>
    ipcRenderer.invoke('folder:open'),
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
  trash: (itemPath: string): Promise<void> =>
    ipcRenderer.invoke('folder:trash', itemPath),
  reveal: (itemPath: string): void => {
    ipcRenderer.send('folder:reveal', itemPath);
  },
  confirmDelete: (name: string, isDirectory: boolean): Promise<boolean> =>
    ipcRenderer.invoke('folder:confirm-delete', name, isDirectory),
  statPath: (p: string): Promise<'file' | 'directory' | 'missing'> =>
    ipcRenderer.invoke('folder:stat-path', p),
  showItemMenu: (payload: {
    isDirectory: boolean;
    isMarkdown: boolean;
  }): Promise<ItemMenuAction | null> =>
    ipcRenderer.invoke('folder:show-item-menu', payload),

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
  // Active tab signal (path + isDirty) plus the global dirtyCount. Pushed
  // synchronously on every change so main's title and close-with-unsaved
  // decision can never read a stale flag immediately after a keystroke.
  pushFileMeta: (meta: {
    path: string | null;
    isDirty: boolean;
    dirtyCount: number;
  }): void => {
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
    const handler = (_: Electron.IpcRendererEvent, event: MenuActionEvent): void =>
      callback(event);
    ipcRenderer.on('menu:action', handler);
    return () => {
      ipcRenderer.off('menu:action', handler);
    };
  },
  onFileSavedAs: (
    callback: (event: { path: string; content: string }) => void,
  ): (() => void) => {
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
  onResolveDirty: (
    callback: (mode: 'save-all' | 'review') => void,
  ): (() => void) => {
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
