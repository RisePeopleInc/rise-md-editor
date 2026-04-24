import { contextBridge, ipcRenderer } from 'electron';

export type MenuActionType =
  | 'new'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'save-as'
  | 'open-recent'
  | 'find'
  | 'replace'
  | 'toggle-sidebar'
  | 'wysiwyg-mode'
  | 'source-mode'
  | 'split-mode'
  | 'toggle-theme'
  | 'about';

export interface MenuActionEvent {
  type: MenuActionType;
  payload?: { path?: string; clear?: boolean };
}

const api = {
  openFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-file'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  setTitle: (filename: string | null): void => {
    ipcRenderer.send('window:set-title', filename);
  },
  addRecent: (filePath: string): void => {
    ipcRenderer.send('recent:add', filePath);
  },
  clearRecent: (): void => {
    ipcRenderer.send('recent:clear');
  },
  getRecent: (): Promise<string[]> => ipcRenderer.invoke('recent:get'),
  onMenuAction: (callback: (event: MenuActionEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: MenuActionEvent): void => callback(event);
    ipcRenderer.on('menu:action', handler);
    return () => {
      ipcRenderer.off('menu:action', handler);
    };
  },
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
