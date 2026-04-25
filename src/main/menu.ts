import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, shell } from 'electron';
import path from 'node:path';

export type MenuAction =
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

export interface MenuDeps {
  getWindow: () => BrowserWindow | null;
  getRecentFiles: () => string[];
  rebuildMenu: () => void;
  clearRecent: () => void;
}

const isMac = process.platform === 'darwin';

function send(deps: MenuDeps, action: MenuAction, payload?: unknown): void {
  const win = deps.getWindow();
  if (!win) return;
  win.webContents.send('menu:action', { type: action, payload });
}

function buildRecentSubmenu(deps: MenuDeps): MenuItemConstructorOptions[] {
  const recent = deps.getRecentFiles();
  if (recent.length === 0) {
    return [{ label: 'No recent files', enabled: false }];
  }
  return [
    ...recent.map<MenuItemConstructorOptions>((filePath) => ({
      label: path.basename(filePath),
      sublabel: filePath,
      click: () => send(deps, 'open-path', { path: filePath }),
    })),
    { type: 'separator' },
    {
      label: 'Clear Recent',
      click: () => deps.clearRecent(),
    },
  ];
}

export function buildMenu(deps: MenuDeps): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => send(deps, 'new'),
        },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send(deps, 'open-file'),
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => send(deps, 'open-folder'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => send(deps, 'save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send(deps, 'save-as'),
        },
        { type: 'separator' },
        {
          label: 'Recent Files',
          submenu: buildRecentSubmenu(deps),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo are routed through IPC so Monaco (not the focused DOM
        // node) drives them — `role: 'undo'` would call webContents.undo()
        // and bypass Monaco's history stack.
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => send(deps, 'undo'),
        },
        {
          label: 'Redo',
          accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
          click: () => send(deps, 'redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => send(deps, 'find'),
        },
        {
          label: 'Replace',
          accelerator: isMac ? 'Cmd+Alt+F' : 'Ctrl+H',
          click: () => send(deps, 'replace'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => send(deps, 'toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: 'WYSIWYG Mode',
          accelerator: 'CmdOrCtrl+1',
          click: () => send(deps, 'wysiwyg-mode'),
        },
        {
          label: 'Source Mode',
          accelerator: 'CmdOrCtrl+2',
          click: () => send(deps, 'source-mode'),
        },
        {
          label: 'Split Mode',
          accelerator: 'CmdOrCtrl+3',
          click: () => send(deps, 'split-mode'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Theme',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => send(deps, 'toggle-theme'),
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => send(deps, 'font-zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => send(deps, 'font-zoom-out'),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => send(deps, 'font-zoom-reset'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About',
          click: () => {
            if (isMac) {
              app.showAboutPanel();
            } else {
              const win = deps.getWindow();
              const opts = {
                type: 'info' as const,
                title: 'About rAIse',
                message: 'rAIse',
                detail: `Version ${app.getVersion()}\n\nAn AI-powered editor.`,
              };
              if (win) dialog.showMessageBox(win, opts);
              else dialog.showMessageBox(opts);
            }
            send(deps, 'about');
          },
        },
        {
          label: 'Learn More',
          click: () => shell.openExternal('https://www.risepeople.com'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
