/// <reference types="vite/client" />

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

export interface RaiseAssetsApi {
  saveDroppedImage: (markdownPath: string, sourcePath: string) => Promise<SavedAsset>;
  savePastedImage: (
    markdownPath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ) => Promise<SavedAsset>;
  openInSystem: (absPath: string) => Promise<string>;
  openRelative: (markdownPath: string, relPath: string) => Promise<string>;
}

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type EditorContrast = 'hard' | 'medium' | 'soft';

export interface AppThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}
export interface EditorThemeState {
  preference: ThemePreference;
  contrast: EditorContrast;
  resolved: ResolvedTheme;
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
  }) => Promise<ThemeState>;
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
  trash: (itemPath: string) => Promise<void>;
  reveal: (itemPath: string) => void;
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

export interface RaiseApi {
  platform: NodeJS.Platform;
  openFolder: () => Promise<string | null>;
  confirmUnsavedChanges: (filename: string) => Promise<'save' | 'discard' | 'cancel'>;
  confirmFileReload: (filename: string, isDirty: boolean) => Promise<boolean>;
  showError: (title: string, message: string) => void;
  notifyReady: () => void;
  closeWindow: () => void;
  files: RaiseFilesApi;
  folder: RaiseFolderApi;
  templates: RaiseTemplatesApi;
  theme: RaiseThemeApi;
  assets: RaiseAssetsApi;
  pushFileMeta: (meta: {
    path: string | null;
    isDirty: boolean;
    dirtyCount: number;
  }) => void;
  getRecent: () => Promise<string[]>;
  addRecent: (filePath: string) => void;
  clearRecent: () => void;
  onMenuAction: (callback: (event: MenuActionEvent) => void) => () => void;
  onFileSavedAs: (
    callback: (event: { path: string; content: string }) => void,
  ) => () => void;
  onResolveDirty: (callback: (mode: 'save-all' | 'review') => void) => () => void;
  respondResolveDirty: (ok: boolean) => void;
}

declare global {
  interface Window {
    api: RaiseApi;
  }
}
