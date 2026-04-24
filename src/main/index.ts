import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { buildMenu, type MenuDeps } from './menu';

const APP_NAME = 'rAIse';
const MAX_RECENT = 10;

let mainWindow: BrowserWindow | null = null;
let recentFiles: string[] = [];

app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} Rise`,
});

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

function setTitle(filename: string | null): void {
  if (!mainWindow) return;
  mainWindow.setTitle(filename ? `${filename} — ${APP_NAME}` : APP_NAME);
}

function addRecent(filePath: string): void {
  recentFiles = [filePath, ...recentFiles.filter((p) => p !== filePath)].slice(0, MAX_RECENT);
  app.addRecentDocument(filePath);
  rebuildMenu();
}

function clearRecent(): void {
  recentFiles = [];
  app.clearRecentDocuments();
  rebuildMenu();
}

async function openFileDialog(): Promise<void> {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open File',
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const filePath = result.filePaths[0]!;
  addRecent(filePath);
  mainWindow.webContents.send('menu:action', {
    type: 'open-file',
    payload: { path: filePath },
  });
}

async function openFolderDialog(): Promise<void> {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const folderPath = result.filePaths[0]!;
  mainWindow.webContents.send('menu:action', {
    type: 'open-folder',
    payload: { path: folderPath },
  });
}

const menuDeps: MenuDeps = {
  getWindow,
  getRecentFiles: () => recentFiles,
  rebuildMenu: () => rebuildMenu(),
  openFileDialog,
  openFolderDialog,
};

function rebuildMenu(): void {
  Menu.setApplicationMenu(buildMenu(menuDeps));
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // electron-vite injects ELECTRON_RENDERER_URL in dev for HMR; in prod we
  // load the built HTML from disk.
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

ipcMain.handle('dialog:open-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open File',
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0]!;
  addRecent(filePath);
  return filePath;
});

ipcMain.handle('dialog:open-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
});

ipcMain.on('window:set-title', (_, filename: string | null) => {
  setTitle(filename);
});

ipcMain.on('recent:add', (_, filePath: string) => {
  addRecent(filePath);
});

ipcMain.on('recent:clear', () => {
  clearRecent();
});

ipcMain.handle('recent:get', () => recentFiles);
