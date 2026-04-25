import { contextBridge, ipcRenderer, webUtils } from 'electron';

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

const api = {
  // 'darwin' | 'win32' | 'linux' | etc. Lets the renderer branch on
  // macOS without parsing navigator.userAgent.
  platform: process.platform as NodeJS.Platform,
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  confirmUnsavedChanges: (filename: string): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('dialog:confirm-unsaved', filename),
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
