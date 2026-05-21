import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  shell,
} from 'electron';
import path from 'node:path';

export type MenuAction =
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
  | 'paste-plain'
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
  | 'context-source-select-all'
  | 'context-preview-select-all'
  | 'font-zoom-in'
  | 'font-zoom-out'
  | 'font-zoom-reset'
  | 'about';

export interface MenuDeps {
  getWindow: () => BrowserWindow | null;
  getRecentFiles: () => string[];
  rebuildMenu: () => void;
  /**
   * `true` when an open workspace has a CLAUDE.md at its root. Used to
   * flip the File menu label between "New CLAUDE.md" (creates from
   * template) and "Open CLAUDE.md" (opens the existing one) — the
   * action under the hood is the same `new-claude-md` dispatch which
   * the renderer routes correctly via `templates:create`.
   */
  claudeMdPresent: () => boolean;
  /**
   * Current app theme preference — one of 'system' | 'light' | 'dark'.
   * Drives the radio-style checkmarks under View → Theme.
   */
  getThemePreference: () => 'system' | 'light' | 'dark';
  /**
   * Current editor theme preference. Independent of the app preference;
   * drives checkmarks under View → Editor Theme.
   */
  getEditorThemePreference: () => 'system' | 'light' | 'dark';
  /** Current editor contrast — drives the contrast checkmarks. */
  getEditorContrast: () => 'hard' | 'medium' | 'soft';
  /**
   * Current word-wrap mode for the source editor — drives the
   * `View → Word Wrap` checkmark.
   */
  getWordWrap: () => 'on' | 'off';
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
          // Label flips when the workspace already has a CLAUDE.md so
          // the menu reflects what the action will actually do — the
          // shortcut is the same in either case (the renderer's
          // templates:create handler returns 'exists' and opens the
          // existing file when one is there).
          label: deps.claudeMdPresent() ? 'Open CLAUDE.md' : 'New CLAUDE.md',
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
        {
          label: 'Close Folder',
          // No accelerator — infrequent action, and Cmd+Shift+W is
          // claimed by macOS for "Close All Windows".
          click: () => send(deps, 'close-folder'),
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
          label: 'Export',
          submenu: [
            // RAISE-42: PDF export. Cmd/Ctrl+Shift+E is unused
            // elsewhere (verified against the existing accelerator
            // map). The renderer dispatches the `export-pdf` event,
            // opens the modal, gathers options, and routes through
            // `window.api.export.toPdf` to main.
            {
              label: 'PDF…',
              accelerator: 'CmdOrCtrl+Shift+E',
              click: () => send(deps, 'export-pdf'),
            },
            // RAISE-53: HTML export. No accelerator — the modal is
            // fast enough that menu drill is acceptable, and we're
            // out of un-conflicted Cmd+Shift+letter combinations
            // around `Cmd+Shift+E` / `Cmd+Shift+H` (the latter is
            // a system-wide "hide others" shortcut on macOS we
            // don't want to override).
            {
              label: 'HTML…',
              click: () => send(deps, 'export-html'),
            },
          ],
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
        ...(isMac ? [] : ([{ role: 'quit' as const }] satisfies MenuItemConstructorOptions[])),
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
        // RAISE-51: Paste and Match Style (macOS naming convention) /
        // Paste without Formatting (Windows/Linux). Bypasses the
        // markdown / Turndown / image pipeline that the regular
        // `role: 'paste'` routes through — drops `text/html`, drops
        // image clipboard items, and inserts the raw `text/plain`
        // slot verbatim at the cursor. Same accelerator across both
        // platforms (`CmdOrCtrl+Shift+V`) matches Word / Google Docs /
        // Notion / Obsidian / Bear / iA Writer / Typora convention.
        {
          label: isMac ? 'Paste and Match Style' : 'Paste without Formatting',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => send(deps, 'paste-plain'),
        },
        {
          // Mirror of the WYSIWYG context-menu item. No-op when the
          // active tab isn't in WYSIWYG mode — the renderer's
          // wysiwygRef is nullable in that case and the handler
          // bails out cleanly. Cmd+Shift+C is taken (CLAUDE.md), so
          // no accelerator here for now; users who use this often
          // can be wired up via the context menu or a future
          // user-defined accelerator.
          label: 'Copy as Markdown',
          click: () => send(deps, 'context-copy-as-markdown'),
        },
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
        // RAISE-60: mode accelerators are bound to match the ModeSwitcher
        // pill's left-to-right order:
        //   Cmd+1 = Read, Cmd+2 = WYSIWYG, Cmd+3 = Source, Cmd+4 = Split.
        // Previous binding (pre-RAISE-60) was Cmd+1/2/3 = WYSIWYG/Source/
        // Split with Read at Cmd+0. Renumbered so the pill chip position
        // and the digit on the keyboard match — the "1-2-3-4 maps to
        // left-to-right" mental model wins over preserving the older
        // muscle memory, since the app is still pre-release.
        {
          label: 'Read Mode',
          accelerator: 'CmdOrCtrl+1',
          click: () => send(deps, 'read-mode'),
        },
        {
          label: 'WYSIWYG Mode',
          accelerator: 'CmdOrCtrl+2',
          click: () => send(deps, 'wysiwyg-mode'),
        },
        {
          label: 'Source Mode',
          accelerator: 'CmdOrCtrl+3',
          click: () => send(deps, 'source-mode'),
        },
        {
          label: 'Split Mode',
          accelerator: 'CmdOrCtrl+4',
          click: () => send(deps, 'split-mode'),
        },
        {
          label: 'Cycle Mode',
          accelerator: 'CmdOrCtrl+\\',
          click: () => send(deps, 'cycle-mode'),
        },
        { type: 'separator' },
        {
          // Word-wrap toggle for the Monaco source editor (Source-only
          // and the source pane in Split). Cmd+Alt+Z matches VS Code's
          // convention. WYSIWYG mode is unaffected — Milkdown always
          // wraps. Pref persists in themeStore.
          label: 'Word Wrap',
          type: 'checkbox',
          checked: deps.getWordWrap() === 'on',
          accelerator: isMac ? 'Cmd+Alt+Z' : 'Ctrl+Alt+Z',
          click: () => send(deps, 'toggle-word-wrap'),
        },
        { type: 'separator' },
        {
          // App-zone theme — controls WYSIWYG / preview / chrome /
          // welcome screen. Independent of the editor (Monaco) theme
          // below, so users can pin Gruvbox dark for code while the
          // rest of the app follows the OS, or any other combination.
          label: 'Theme',
          submenu: [
            {
              label: 'Follow System',
              type: 'checkbox',
              checked: deps.getThemePreference() === 'system',
              click: () => send(deps, 'theme-system'),
            },
            {
              label: 'Light',
              type: 'checkbox',
              checked: deps.getThemePreference() === 'light',
              click: () => send(deps, 'theme-light'),
            },
            {
              label: 'Dark',
              type: 'checkbox',
              checked: deps.getThemePreference() === 'dark',
              click: () => send(deps, 'theme-dark'),
            },
            { type: 'separator' },
            {
              // Cycle: system → light → dark → system. Preserves the
              // shortcut users already learned for the previous toggle.
              label: 'Cycle Theme',
              accelerator: 'CmdOrCtrl+Shift+T',
              click: () => send(deps, 'cycle-theme'),
            },
          ],
        },
        {
          // Editor (Monaco) theme — Gruvbox, with three contrast levels
          // and an independent light/dark/system toggle.
          label: 'Editor Theme',
          submenu: [
            {
              label: 'Follow System',
              type: 'checkbox',
              checked: deps.getEditorThemePreference() === 'system',
              click: () => send(deps, 'editor-theme-system'),
            },
            {
              label: 'Light',
              type: 'checkbox',
              checked: deps.getEditorThemePreference() === 'light',
              click: () => send(deps, 'editor-theme-light'),
            },
            {
              label: 'Dark',
              type: 'checkbox',
              checked: deps.getEditorThemePreference() === 'dark',
              click: () => send(deps, 'editor-theme-dark'),
            },
            {
              // Mirrors the app's Cmd+Shift+T cycle, with Alt added to
              // disambiguate. system → light → dark → system.
              label: 'Cycle Editor Theme',
              accelerator: 'CmdOrCtrl+Alt+Shift+T',
              click: () => send(deps, 'cycle-editor-theme'),
            },
            { type: 'separator' },
            {
              label: 'Hard contrast',
              type: 'checkbox',
              checked: deps.getEditorContrast() === 'hard',
              click: () => send(deps, 'editor-contrast-hard'),
            },
            {
              label: 'Medium contrast',
              type: 'checkbox',
              checked: deps.getEditorContrast() === 'medium',
              click: () => send(deps, 'editor-contrast-medium'),
            },
            {
              label: 'Soft contrast',
              type: 'checkbox',
              checked: deps.getEditorContrast() === 'soft',
              click: () => send(deps, 'editor-contrast-soft'),
            },
          ],
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
            // In packaged macOS builds, the native About panel reads
            // its icon + identity from the .app's Info.plist + .icns
            // — that's the right look. In dev (unpackaged) the .app
            // is Electron's, so showAboutPanel would show Electron's
            // logo. Fall back to a custom dialog with our PNG so
            // dev still looks correct.
            if (isMac && app.isPackaged) {
              app.showAboutPanel();
              send(deps, 'about');
              return;
            }
            const win = deps.getWindow();
            const iconPath = path.join(__dirname, '../../build/icon.png');
            const opts = {
              type: 'info' as const,
              title: 'About Rise MD Editor',
              message: 'Rise MD Editor',
              detail: `Version ${app.getVersion()}\n\nA markdown editor for Rise People.\n\n© ${new Date().getFullYear()} Rise People`,
              icon: nativeImage.createFromPath(iconPath),
            };
            if (win) dialog.showMessageBox(win, opts);
            else dialog.showMessageBox(opts);
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
