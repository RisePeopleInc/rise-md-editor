/// <reference types="vite/client" />

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

export interface RaiseApi {
  openFile: () => Promise<string | null>;
  openFolder: () => Promise<string | null>;
  setTitle: (filename: string | null) => void;
  addRecent: (filePath: string) => void;
  clearRecent: () => void;
  getRecent: () => Promise<string[]>;
  onMenuAction: (callback: (event: MenuActionEvent) => void) => () => void;
}

declare global {
  interface Window {
    api: RaiseApi;
  }
}
