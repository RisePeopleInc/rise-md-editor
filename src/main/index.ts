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

// Sentinel used to let close() proceed once the unsaved-changes flow has
// resolved (Save succeeded or user chose Don't Save).
let allowClose = false;

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

// Recent files
ipcMain.handle('recent:get', () => recentStore.getRecent());
ipcMain.on('recent:add', (_, filePath: string) => rememberRecent(filePath));
ipcMain.on('recent:clear', () => {
  recentStore.clearRecent();
  app.clearRecentDocuments();
  rebuildMenu();
});

// macOS: files passed via "Open With", Finder, or the dock arrive here.
// Buffer until the renderer is loaded, then dispatch through the same
// open-path flow used by the Recent Files menu (dirty-guard included).
const pendingOpens: string[] = [];

function flushPendingOpens(win: BrowserWindow): void {
  while (pendingOpens.length > 0) {
    const filePath = pendingOpens.shift()!;
    win.webContents.send('menu:action', {
      type: 'open-path',
      payload: { path: filePath },
    });
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('menu:action', {
      type: 'open-path',
      payload: { path: filePath },
    });
  } else {
    pendingOpens.push(filePath);
  }
});

app.on('browser-window-created', (_, win) => {
  win.webContents.once('did-finish-load', () => flushPendingOpens(win));
});
