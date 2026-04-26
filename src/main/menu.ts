import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, shell } from 'electron';
import path from 'node:path';

export type MenuAction =
  | 'new'
  | 'new-claude-md'
  | 'new-skill-file'
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

export interface MenuDeps {
  getWindow: () => BrowserWindow | null;
  getRecentFiles: () => string[];
  rebuildMenu: () => void;
  /**
   * Dispatch a menu action. The implementation is responsible for queuing and
   * (if needed) reopening the window — never short-circuits on a missing
   * window, so File→New / File→Open work after Cmd+W on macOS.
   */
  dispatch: (action: MenuAction, payload?: unknown) => void;
  clearRecent: () => void;
}

const isMac = process.platform === 'darwin';

function send(deps: MenuDeps, action: MenuAction, payload?: unknown): void {
  deps.dispatch(action, payload);
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
          label: 'New CLAUDE.md',
          // Cmd/Ctrl+Shift+C is unused in our app and intuitive — "C for
          // Claude". Doesn't conflict with the OS-level Copy shortcut.
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => send(deps, 'new-claude-md'),
        },
        {
          label: 'New Skill File',
          click: () => send(deps, 'new-skill-file'),
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
        // Cmd/Ctrl+W closes the active tab; only when no tabs remain does
        // the renderer fall through to closing the window. role:'close' would
        // bypass the dirty-prompt and tab-close logic.
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => send(deps, 'close-tab'),
        },
        ...(isMac
          ? []
          : ([{ role: 'quit' as const }] satisfies MenuItemConstructorOptions[])),
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
        {
          label: 'Cycle Mode',
          accelerator: 'CmdOrCtrl+\\',
          click: () => send(deps, 'cycle-mode'),
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
        // macOS: Cmd+Option+arrows is the native tab-cycle convention used
        // by Safari, Chrome, and VS Code. Cmd+Tab is reserved by the OS for
        // app switching. Win/Linux keep the standard Ctrl+Tab pair.
        {
          label: 'Next Tab',
          accelerator: isMac ? 'Cmd+Alt+Right' : 'Ctrl+Tab',
          click: () => send(deps, 'next-tab'),
        },
        {
          label: 'Previous Tab',
          accelerator: isMac ? 'Cmd+Alt+Left' : 'Ctrl+Shift+Tab',
          click: () => send(deps, 'prev-tab'),
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
