/// <reference types="vite/client" />

// `declare module 'markdown-it-task-lists'` lives in a sibling
// ambient-only file (`markdown-it-task-lists.d.ts`) so it resolves
// before the `import` in SplitView. Putting it here didn't work —
// this file's `export type` declarations make it a module, which
// in turn changes how nested `declare module` is processed.

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

export interface RaiseFilesApi {
  open: () => Promise<OpenedFile | null>;
  openPath: (filePath: string) => Promise<OpenedFile>;
  save: (filePath: string, content: string) => Promise<void>;
  saveAs: (content: string, suggestedName?: string) => Promise<{ path: string } | null>;
  getPathForFile: (file: File) => string;
}

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

export interface RaiseTemplatesApi {
  create: (kind: TemplateKind, rootPath: string | null) => Promise<TemplateCreateResult>;
  claudeMdExists: (rootPath: string) => Promise<boolean>;
  isClaudeBannerDismissed: (rootPath: string) => Promise<boolean>;
  dismissClaudeBanner: (rootPath: string) => void;
}

export interface SavedAsset {
  relPath: string;
  absPath: string;
}

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

export interface RaiseUpdateApi {
  getState: () => Promise<UpdateState>;
  onStateChange: (callback: (state: UpdateState) => void) => () => void;
  install: () => void;
}

export interface RaiseAssetsApi {
  saveDroppedImage: (markdownPath: string, sourcePath: string) => Promise<SavedAsset>;
  savePastedImage: (
    markdownPath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ) => Promise<SavedAsset>;
  openRelative: (markdownPath: string, relPath: string) => Promise<string>;
  /** Show a native image-file picker, copy the choice into assets/. */
  pickAndImport: (markdownPath: string) => Promise<SavedAsset | null>;
}

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
  wordWrap: WordWrap;
}
export interface ThemeState {
  app: AppThemeState;
  editor: EditorThemeState;
}

export interface RaiseThemeApi {
  get: () => Promise<ThemeState>;
  setApp: (pref: ThemePreference) => Promise<ThemeState>;
  setEditor: (payload: {
    preference?: ThemePreference;
    contrast?: EditorContrast;
    wordWrap?: WordWrap;
  }) => Promise<ThemeState>;
  /** Atomic word-wrap toggle, resolved against the persisted value in main. */
  toggleEditorWordWrap: () => Promise<ThemeState>;
  onChange: (callback: (state: ThemeState) => void) => () => void;
}

export interface RaiseFolderApi {
  open: () => Promise<{ path: string; tree: TreeNode } | null>;
  openPath: (folderPath: string) => Promise<{ path: string; tree: TreeNode }>;
  getTree: (folderPath: string) => Promise<TreeNode>;
  close: () => Promise<void>;
  getLast: () => Promise<{ path: string; tree: TreeNode } | null>;

  createFile: (parentPath: string, name: string) => Promise<string>;
  createFolder: (parentPath: string, name: string) => Promise<string>;
  rename: (oldPath: string, newName: string) => Promise<string>;
  /** RAISE-13: move a file or folder into a new parent directory.
   *  Returns the new absolute path. Throws on collision /
   *  self-into-self / descendant-of-self / cross-device. */
  move: (srcPath: string, destDir: string) => Promise<string>;
  /** RAISE-13 follow-up: copy a file or folder into a new parent
   *  directory. Same-parent copies auto-rename (`report.md` →
   *  `report 2.md`); cross-parent collisions throw EEXIST. */
  copy: (srcPath: string, destDir: string) => Promise<string>;
  trash: (itemPath: string) => Promise<void>;
  reveal: (itemPath: string) => void;
  /** RAISE-13 follow-up: open a file in the OS default app. Returns
   *  the error string (empty on success). */
  openInSystem: (itemPath: string) => Promise<string>;
  confirmDelete: (name: string, isDirectory: boolean) => Promise<boolean>;
  statPath: (p: string) => Promise<'file' | 'directory' | 'missing'>;
  showItemMenu: (payload: {
    isDirectory: boolean;
    isMarkdown: boolean;
  }) => Promise<ItemMenuAction | null>;

  getSidebarPref: () => Promise<{ width: number; visible: boolean }>;
  setSidebarWidth: (width: number) => void;
  setSidebarVisible: (visible: boolean) => void;

  onTreeChanged: (callback: (root: string) => void) => () => void;
  onFileChanged: (callback: (filePath: string) => void) => () => void;
}

/** RAISE-28: editor-surface context-menu requests (right-click). */
export type EditorContextMode = 'wysiwyg' | 'source' | 'preview' | 'frontmatter';
export interface RaiseContextMenuApi {
  showEditor: (payload: {
    mode: EditorContextMode;
    hasSelection: boolean;
    /** RAISE-38: true when the right-click landed on an existing
     *  link element. Surfaces an "Edit Link…" menu item. */
    isOnLink?: boolean;
  }) => Promise<void>;
}

/**
 * RAISE-51: minimal clipboard read surface for the Paste and Match
 * Style flow. Menu accelerators don't supply a DOM `DataTransfer`,
 * so we read the system clipboard out of band — via IPC, because
 * the sandboxed preload can't import Electron's `clipboard` module
 * directly (the sandbox bundler strips it).
 */
export interface RaiseClipboardApi {
  /** Returns the clipboard's `text/plain` slot, or `''` if absent. */
  readText: () => Promise<string>;
  /** Returns the clipboard's `text/html` slot, or `''` if absent. */
  readHTML: () => Promise<string>;
}

/**
 * RAISE-74: renderer-driven menu state for the View menu's zoom items.
 * The renderer pushes the current monaco-active boolean whenever the
 * active tab's mode changes; main toggles the `enabled` flag on the
 * three Zoom menu items (and their accelerators) in response.
 */
export interface RaiseViewApi {
  setZoomEnabled: (enabled: boolean) => void;
}

export type ExportPdfPageSize = 'Letter' | 'Legal' | 'Tabloid' | 'A3' | 'A4' | 'A5';
export interface ExportPdfCustomPageSize {
  width: number;
  height: number;
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
export interface RaiseExportApi {
  toPdf: (opts: ExportPdfOptions) => Promise<ExportPdfResult>;
  toHtml: (opts: ExportHtmlOptions) => Promise<ExportHtmlResult>;
}

export interface RaiseApi {
  platform: NodeJS.Platform;
  openFolder: () => Promise<string | null>;
  confirmUnsavedChanges: (filename: string) => Promise<'save' | 'discard' | 'cancel'>;
  confirmFileReload: (filename: string, isDirty: boolean) => Promise<boolean>;
  showError: (title: string, message: string) => void;
  /**
   * RAISE-38: forward a URL to the user's default external browser
   * via main's shell.openExternal. Main validates the URL scheme
   * (only http / https / mailto are allowed) so the renderer can
   * pass through whatever it sees in an `<a href>` without
   * pre-filtering.
   */
  openExternal: (url: string) => void;
  notifyReady: () => void;
  closeWindow: () => void;
  files: RaiseFilesApi;
  folder: RaiseFolderApi;
  templates: RaiseTemplatesApi;
  theme: RaiseThemeApi;
  assets: RaiseAssetsApi;
  update: RaiseUpdateApi;
  contextMenu: RaiseContextMenuApi;
  /** RAISE-74: View-menu state — currently just Zoom item enable/disable. */
  view: RaiseViewApi;
  /** RAISE-51: synchronous clipboard read for the Paste and Match Style flow. */
  clipboard: RaiseClipboardApi;
  /** RAISE-42: Export-to-PDF bridge. */
  export: RaiseExportApi;
  pushFileMeta: (meta: { path: string | null; isDirty: boolean; dirtyCount: number }) => void;
  getRecent: () => Promise<string[]>;
  addRecent: (filePath: string) => void;
  clearRecent: () => void;
  onMenuAction: (callback: (event: MenuActionEvent) => void) => () => void;
  onFileSavedAs: (callback: (event: { path: string; content: string }) => void) => () => void;
  onResolveDirty: (callback: (mode: 'save-all' | 'review') => void) => () => void;
  respondResolveDirty: (ok: boolean) => void;
}

declare global {
  interface Window {
    api: RaiseApi;
  }
}
