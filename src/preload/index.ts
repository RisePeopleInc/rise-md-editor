import { contextBridge, ipcRenderer, webUtils } from 'electron';

export type MenuActionType =
  | 'new'
  | 'open-file'
  | 'open-folder'
  | 'open-path'
  | 'save'
  | 'save-as'
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
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  confirmUnsavedChanges: (filename: string): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('dialog:confirm-unsaved', filename),
  showError: (title: string, message: string): void => {
    ipcRenderer.send('dialog:show-error', { title, message });
  },
  notifyReady: (): void => {
    ipcRenderer.send('renderer:ready');
  },
  files,
  // Synchronous push of cheap signal (path + isDirty). Drives the window
  // title and the close-with-unsaved decision, so it must never lag behind
  // a keystroke.
  pushFileMeta: (meta: { path: string | null; isDirty: boolean }): void => {
    ipcRenderer.send('file:meta', meta);
  },
  // Debounced push of the editor content; consumed by the Save-on-close
  // path. A small lag here costs a few keystrokes, not the dirty guarantee.
  pushFileContent: (content: string): void => {
    ipcRenderer.send('file:content', content);
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
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
