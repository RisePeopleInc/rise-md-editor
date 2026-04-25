import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { buildMenu, type MenuDeps } from './menu';
import * as fileOps from './fileOperations';
import * as recentStore from './recentFilesStore';

const APP_NAME = 'rAIse';

let mainWindow: BrowserWindow | null = null;

// The renderer is the source of truth for content and dirtiness; it pushes
// updates here so close-with-unsaved and the live window title can react.
const fileState = {
  path: null as string | null,
  content: '',
  isDirty: false,
};

function resetFileState(): void {
  fileState.path = null;
  fileState.content = '';
  fileState.isDirty = false;
}

// Menu actions are queued until the renderer signals it has subscribed to
// menu:action — that lets us safely re-open a closed window from the menu
// (e.g. macOS File→New after Cmd+W) and replay the click once React mounts.
let rendererReady = false;
const pendingMenuActions: Array<{ type: string; payload?: unknown }> = [];

function dispatchMenuAction(type: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send('menu:action', { type, payload });
    return;
  }
  pendingMenuActions.push({ type, payload });
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
}

function drainPendingMenuActions(): void {
  if (!mainWindow) return;
  while (pendingMenuActions.length > 0) {
    mainWindow.webContents.send('menu:action', pendingMenuActions.shift()!);
  }
}

app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} Rise`,
});

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

function displayName(): string {
  return fileState.path ? path.basename(fileState.path) : 'Untitled';
}

function refreshTitle(): void {
  if (!mainWindow) return;
  const dot = fileState.isDirty ? '• ' : '';
  mainWindow.setTitle(`${dot}${displayName()} — ${APP_NAME}`);
  mainWindow.setDocumentEdited(fileState.isDirty);
  mainWindow.setRepresentedFilename(fileState.path ?? '');
}

function rememberRecent(filePath: string): void {
  recentStore.addRecent(filePath);
  app.addRecentDocument(filePath);
  rebuildMenu();
}

const menuDeps: MenuDeps = {
  getWindow,
  getRecentFiles: () => recentStore.getRecent(),
  rebuildMenu: () => rebuildMenu(),
  dispatch: dispatchMenuAction,
  clearRecent: () => {
    recentStore.clearRecent();
    app.clearRecentDocuments();
    rebuildMenu();
  },
};

function rebuildMenu(): void {
  Menu.setApplicationMenu(buildMenu(menuDeps));
}

type UnsavedChoice = 'save' | 'discard' | 'cancel';

async function promptUnsavedChanges(filename = displayName()): Promise<UnsavedChoice> {
  if (!mainWindow) return 'discard';
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Do you want to save changes to ${filename}?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  if (choice.response === 0) return 'save';
  if (choice.response === 1) return 'discard';
  return 'cancel';
}

async function saveCachedFile(): Promise<boolean> {
  if (!mainWindow) return false;
  if (fileState.path) {
    await fileOps.saveFile(fileState.path, fileState.content);
    return true;
  }
  const result = await fileOps.saveFileAs(
    mainWindow,
    fileState.content,
    fileOps.suggestedNameFor(fileState.path),
  );
  if (!result) return false;
  fileState.path = result.path;
  rememberRecent(result.path);
  mainWindow.webContents.send('file:saved-as', { path: result.path });
  return true;
}

function createWindow(): void {
  // Per-window flag — never leak across windows, otherwise a "Don't Save"
  // discard on the first window would silently bypass the prompt on a
  // future window's close.
  let allowClose = false;

  rendererReady = false;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // The renderer must re-signal readiness after any reload (HMR full-page,
  // Cmd+R, etc.) so queued dispatches don't fire into a half-mounted page.
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  mainWindow.on('close', (e) => {
    if (allowClose || !fileState.isDirty) return;
    e.preventDefault();
    void (async () => {
      const choice = await promptUnsavedChanges();
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const ok = await saveCachedFile();
        if (!ok) return;
      }
      allowClose = true;
      mainWindow?.close();
    })();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    resetFileState();
  });

  // Block default file:// navigation for files dropped on the window.
  // Drag-and-drop opens go through the renderer + files.openPath flow so
  // they stream through the same recent-files / state pipeline.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) e.preventDefault();
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  rebuildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// File operations exposed to the renderer. Recent-files tracking happens
// renderer-side after a successful load — that way a canceled unsaved-changes
// prompt doesn't pollute the recents list with files that were never opened.
ipcMain.handle('files:open', async () => {
  if (!mainWindow) return null;
  return fileOps.openFile(mainWindow);
});

ipcMain.handle('files:open-path', async (_, filePath: string) => fileOps.openPath(filePath));

ipcMain.handle('files:save', async (_, filePath: string, content: string) => {
  await fileOps.saveFile(filePath, content);
});

ipcMain.handle(
  'files:save-as',
  async (_, content: string, suggestedName?: string) => {
    if (!mainWindow) return null;
    return fileOps.saveFileAs(mainWindow, content, suggestedName);
  },
);

ipcMain.handle('files:new', () => fileOps.newFile());

ipcMain.handle(
  'dialog:confirm-unsaved',
  async (_, filename?: string): Promise<UnsavedChoice> => promptUnsavedChanges(filename),
);

ipcMain.handle('dialog:open-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
});

// Renderer pushes its file state on every meaningful change
ipcMain.on(
  'file:state',
  (_, state: { path: string | null; content: string; isDirty: boolean }) => {
    fileState.path = state.path;
    fileState.content = state.content;
    fileState.isDirty = state.isDirty;
    refreshTitle();
  },
);

// Renderer signals it has subscribed to menu:action and is safe to dispatch
// queued actions. Sent every time the listener is re-attached (mount, HMR).
ipcMain.on('renderer:ready', () => {
  rendererReady = true;
  drainPendingMenuActions();
});

// Recent files
ipcMain.handle('recent:get', () => recentStore.getRecent());
ipcMain.on('recent:add', (_, filePath: string) => rememberRecent(filePath));
ipcMain.on('recent:clear', () => {
  recentStore.clearRecent();
  app.clearRecentDocuments();
  rebuildMenu();
});

// macOS: files passed via "Open With", Finder, or the dock arrive here.
// Funnel through the same dispatch — it queues until the renderer is ready
// and reopens the window if needed.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  dispatchMenuAction('open-path', { path: filePath });
});
