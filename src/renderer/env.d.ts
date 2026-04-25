/// <reference types="vite/client" />

export type MenuActionType =
  | 'new'
  | 'open-file'
  | 'open-folder'
  | 'open-path'
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
  | 'toggle-theme'
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

export interface RaiseApi {
  platform: NodeJS.Platform;
  openFolder: () => Promise<string | null>;
  confirmUnsavedChanges: (filename: string) => Promise<'save' | 'discard' | 'cancel'>;
  showError: (title: string, message: string) => void;
  notifyReady: () => void;
  closeWindow: () => void;
  files: RaiseFilesApi;
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
