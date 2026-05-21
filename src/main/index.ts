import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMenu, type MenuDeps } from './menu';
import { showEditorContextMenu, type ShowEditorContextMenuPayload } from './contextMenu';
import * as assetOps from './assetOps';
import { initAutoUpdater } from './autoUpdater';
import * as fileOps from './fileOperations';
import * as folderOps from './folderOps';
import * as folderWatcher from './folderWatcher';
import * as lastFolderStore from './lastFolderStore';
import * as recentStore from './recentFilesStore';
import * as templates from './templates';
import * as themeStore from './themeStore';
import {
  exportToPdf,
  sweepStaleTempFiles,
  type ExportPdfOptions,
  type ExportPdfResult,
} from './exportPdf';
import { exportToHtml, type ExportHtmlOptions, type ExportHtmlResult } from './exportHtml';

const APP_NAME = 'Rise MD Editor';

// `rise-md-asset://` resolves markdown-relative image paths against their
// containing file's directory and serves the bytes from disk. The
// renderer is loaded from http://localhost in dev and file:// in
// production — relative paths in <img src=...> would otherwise resolve
// against the renderer's origin (broken icon). Translating to a custom
// protocol at render time keeps the markdown stored on disk clean
// (`assets/foo.png` stays as the saved string) while the displayed
// <img> points at a URL Chromium will actually fetch.
//
// MUST run before app.whenReady() — Electron requires
// registerSchemesAsPrivileged at startup.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rise-md-asset',
    privileges: {
      // `secure: true` so the scheme is treated as a trusted origin
      // (mixed-content rules don't block it); `supportFetchAPI` so any
      // code that pre-fetches images via fetch() works; `stream` for
      // range requests on large images.
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;

// The renderer is the source of truth for tabs and content; it mirrors
// the active tab's title-relevant signal (path + isDirty) plus the global
// dirty-tab count so main can drive the title and the close-with-unsaved
// decision without holding all tab content.
const fileState = {
  path: null as string | null,
  isDirty: false,
  dirtyCount: 0,
};

function resetFileState(): void {
  fileState.path = null;
  fileState.isDirty = false;
  fileState.dirtyCount = 0;
}

/**
 * Allowed roots for rise-md-asset:// reads + assets:open-relative
 * resolutions. The renderer renders images from:
 *   - The currently-open workspace folder (Project Mode)
 *   - The active tab's saved-file directory
 *
 * Non-active tabs aren't mounted in the editor, so we don't need to
 * track their paths here — when the user switches tabs, the new
 * active path lands via `pushFileMeta` and the set updates.
 */
function getAllowedRoots(): string[] {
  const roots: string[] = [];
  const workspace = lastFolderStore.getLastFolder();
  if (workspace) roots.push(path.resolve(workspace));
  if (fileState.path) roots.push(path.resolve(path.dirname(fileState.path)));
  return roots;
}

function isPathUnderAllowedRoot(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  for (const root of getAllowedRoots()) {
    const rel = path.relative(root, resolved);
    // `path.relative` returns '' for equal paths and a string starting
    // with '..' (or an absolute path on a different drive) when the
    // target escapes the root.
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

// Menu actions are queued until the renderer signals it has subscribed to
// menu:action — that lets us safely re-open a closed window from the menu
// (e.g. macOS File→New after Cmd+W) and replay the click once React mounts.
let rendererReady = false;
const pendingMenuActions: Array<{ type: string; payload?: unknown }> = [];

// Set by `before-quit` and consumed by the close handler so a dirty Cmd+Q
// resolves the prompt and then resumes the quit (instead of silently leaving
// the macOS app running with no windows).
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

function dispatchMenuAction(type: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send('menu:action', { type, payload });
    return;
  }
  pendingMenuActions.push({ type, payload });
  // On macOS, `app.on('open-file', ...)` can fire BEFORE `app.whenReady()`
  // resolves — Electron warns about this explicitly. Calling `new BrowserWindow()`
  // before ready throws "Cannot create BrowserWindow before app is ready"
  // and crashes the launch (RAISE-54). Gate the synchronous window creation
  // here: if ready, create now. If not, leave the action queued — the
  // `app.whenReady()` block creates the window (line 453) and the
  // `renderer:ready` IPC handler drains pendingMenuActions (line ~615),
  // so the same open-path payload lands once the window mounts.
  if ((!mainWindow || mainWindow.isDestroyed()) && app.isReady()) {
    createWindow();
  }
}

function drainPendingMenuActions(): void {
  if (!mainWindow) return;
  while (pendingMenuActions.length > 0) {
    mainWindow.webContents.send('menu:action', pendingMenuActions.shift()!);
  }
}

// `app.setName` only takes effect for the menu / About panel labels;
// the macOS menu bar's first-item label is taken from `app.name`,
// which we also seed via `productName` in package.json so that
// `app.getName()` returns 'Rise MD Editor' without needing setName.
//
// `process.title` covers the OS-level process name visible in
// Activity Monitor / `ps`. Belt-and-suspenders so the menu bar in
// dev shows 'Rise MD Editor' instead of 'Electron'.
app.setName(APP_NAME);
process.title = APP_NAME;
// `iconPath` populates the artwork in the macOS About panel
// (Apple → About Rise MD Editor). Without it the panel falls back to the
// running .app bundle's icon — Electron's own logo in dev. Same
// build/icon.png as the dock + window icons.
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} Rise`,
  iconPath: path.join(__dirname, '../../build/icon.png'),
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

// Sync stat — called from the menu builder, which runs rarely (workspace
// changes, chokidar tree ticks). The blocking I/O is fine in those
// contexts and the cache lookups are O(1) from the OS's perspective for
// a path the user is already working in.
function claudeMdPresent(): boolean {
  const root = lastFolderStore.getLastFolder();
  if (!root) return false;
  try {
    return statSync(path.join(root, 'CLAUDE.md')).isFile();
  } catch {
    return false;
  }
}

const menuDeps: MenuDeps = {
  getWindow,
  getRecentFiles: () => recentStore.getRecent(),
  rebuildMenu: () => rebuildMenu(),
  claudeMdPresent,
  getThemePreference: () => themeStore.getThemePreference(),
  getEditorThemePreference: () => themeStore.getEditorThemePreference(),
  getEditorContrast: () => themeStore.getEditorContrast(),
  getWordWrap: () => themeStore.getWordWrap(),
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

type CloseChoice = 'save-all' | 'review' | 'discard' | 'cancel';

async function promptCloseWithUnsavedTabs(count: number): Promise<CloseChoice> {
  if (!mainWindow) return 'discard';
  // With a single dirty tab "Review Each" is identical to "Save", so we
  // collapse to the original 3-button shape; multi-dirty surfaces both.
  if (count === 1) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'You have unsaved changes.',
      detail: "Your changes will be lost if you don't save them.",
    });
    if (choice.response === 0) return 'save-all';
    if (choice.response === 1) return 'discard';
    return 'cancel';
  }
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save All', 'Review Each…', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 3,
    message: `You have unsaved changes in ${count} files.`,
    detail:
      'Save All writes every dirty tab. Review Each walks through them one by one so you can choose per file.',
  });
  switch (choice.response) {
    case 0:
      return 'save-all';
    case 1:
      return 'review';
    case 2:
      return 'discard';
    default:
      return 'cancel';
  }
}

// Ask the renderer to walk the dirty-tab resolution flow (either Save All or
// per-tab Review). Resolves true on success, false if anything was canceled
// OR if the renderer never replies (window destroyed, renderer crash, or a
// stuck resolution flow). Without those guards a renderer crash mid-prompt
// would leave the close handler's promise pending forever and freeze quit.
const RESOLVE_DIRTY_TIMEOUT_MS = 30_000;

function requestResolveDirtyFromRenderer(mode: 'save-all' | 'review'): Promise<boolean> {
  if (!mainWindow) return Promise.resolve(false);
  const window = mainWindow;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('window:resolve-dirty:result', onResult);
      window.removeListener('closed', onClosed);
      clearTimeout(timeoutHandle);
      resolve(ok);
    };
    const onResult = (_e: Electron.IpcMainEvent, ok: boolean): void => settle(ok);
    const onClosed = (): void => settle(false);
    const timeoutHandle = setTimeout(() => settle(false), RESOLVE_DIRTY_TIMEOUT_MS);
    ipcMain.on('window:resolve-dirty:result', onResult);
    window.once('closed', onClosed);
    window.webContents.send('window:resolve-dirty', mode);
  });
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
    if (allowClose || fileState.dirtyCount === 0) return;
    e.preventDefault();
    // Snapshot+consume so a Cancel doesn't leave the flag tainting the next
    // window-only close (red X / Cmd+W) into a full app quit.
    const wasQuitting = quitting;
    quitting = false;
    void (async () => {
      const choice = await promptCloseWithUnsavedTabs(fileState.dirtyCount);
      if (choice === 'cancel') return;
      if (choice === 'save-all' || choice === 'review') {
        const ok = await requestResolveDirtyFromRenderer(choice);
        if (!ok) return;
      }
      allowClose = true;
      // If the user originally hit Cmd+Q we need to resume the quit; just
      // closing this window would leave the macOS app running with no UI.
      if (wasQuitting) {
        app.quit();
      } else {
        mainWindow?.close();
      }
    })();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    resetFileState();
    // Tear down the folder watcher with the window. The persisted last
    // folder is still in lastFolderStore, so a future window can restore.
    void folderWatcher.stopWatching();
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

// Find a markdown/text file argument among the platform's launch argv.
// Skips the executable (or the script in dev) and any flag-style entries.
function findFileArg(argv: readonly string[]): string | null {
  const start = app.isPackaged ? 1 : 2;
  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    if (/\.(md|markdown|txt)$/i.test(a)) return a;
  }
  return null;
}

// Single-instance lock: a second launch with a file arg should focus the
// existing window and load that file, not spawn a duplicate process.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const filePath = findFileArg(argv);
    if (filePath) dispatchMenuAction('open-path', { path: filePath });
  });

  app.whenReady().then(() => {
    // Apply the persisted theme preference to nativeTheme before any
    // window opens, so window-chrome (titlebar tint on macOS, scrollbars,
    // form-control defaults) match from the first frame.
    themeStore.bootstrapNativeTheme();

    // macOS dev-mode dock icon. In packaged builds the .icns baked
    // into the .app bundle drives the dock; in dev the bundle is
    // Electron's own (showing the default Electron mark). app.dock
    // exists only on macOS; the !isPackaged gate avoids a wasted call
    // in production where the path doesn't exist inside the asar.
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      app.dock.setIcon(path.join(__dirname, '../../build/icon.png'));
    }

    // rise-md-asset:// → filesystem read, scoped to "allowed roots":
    // the open workspace folder + the dirname of the active tab's
    // saved file. Without that gate the protocol would happily serve
    // any absolute fs path the renderer asked for — fine in practice
    // (no HTML in markdown, sandboxed renderer) but a one-line
    // hardening that backstops any future XSS.
    //
    // URL pathname is the absolute file path (URL-encoded); on
    // Windows the URL form is `rise-md-asset:///C:/Users/.../foo.png`,
    // so we strip the leading slash if the next character looks like
    // a drive letter.
    protocol.handle('rise-md-asset', async (request) => {
      try {
        const url = new URL(request.url);
        let fsPath = decodeURIComponent(url.pathname);
        if (/^\/[a-zA-Z]:/.test(fsPath)) {
          fsPath = fsPath.slice(1);
        }
        if (!isPathUnderAllowedRoot(fsPath)) {
          return new Response('Forbidden', { status: 403 });
        }
        return await net.fetch(pathToFileURL(fsPath).toString());
      } catch (err) {
        return new Response(
          `rise-md-asset error: ${err instanceof Error ? err.message : String(err)}`,
          { status: 500 },
        );
      }
    });

    rebuildMenu();
    createWindow();

    // RAISE-12: kick off the auto-update check. Safe in dev — the
    // module short-circuits when `app.isPackaged` is false.
    initAutoUpdater(() => mainWindow);

    // Win/Linux file-association launches deliver the path through argv
    // (macOS uses app.on('open-file') instead — handled below).
    // RAISE-60: tag with `fromOs: true` so the renderer opens this tab
    // in Read mode by default (Finder/Explorer double-click and
    // "Open With" → Rise MD Editor both land here).
    const filePath = findFileArg(process.argv);
    if (filePath) dispatchMenuAction('open-path', { path: filePath, fromOs: true });

    // RAISE-42: sweep `<userData>/pdf-export-tmp/` for stale `print-*.html`
    // leftovers older than 24h. Each export's finally-block usually
    // unlinks them, but a renderer/main crash mid-export — or a transient
    // EPERM during cleanup — leaves files behind. Async + best-effort:
    // fire-and-forget so startup isn't blocked, errors swallowed inside.
    void sweepStaleTempFiles();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// File operations exposed to the renderer. Recent-files tracking happens
// renderer-side after a successful load — that way a canceled unsaved-changes
// prompt doesn't pollute the recents list with files that were never opened.
ipcMain.handle('files:open', async () => {
  if (!mainWindow) return null;
  const result = await fileOps.openFile(mainWindow);
  // RAISE-25: suppress the chokidar `change` that fires when the editor first
  // reads an externally-created file in the watched folder.
  if (result) markRecentlyTouched(result.path);
  return result;
});

ipcMain.handle('files:open-path', async (_, filePath: string) => {
  const result = await fileOps.openPath(filePath);
  // RAISE-25: same suppression as `files:open`, covers drag-and-drop,
  // file-tree clicks, dock open-file events, and recents-menu re-opens
  // — all of which land here from the renderer.
  markRecentlyTouched(filePath);
  return result;
});

ipcMain.handle('files:save', async (_, filePath: string, content: string) => {
  await fileOps.saveFile(filePath, content);
  markRecentlyTouched(filePath);
});

ipcMain.handle('files:save-as', async (_, content: string, suggestedName?: string) => {
  if (!mainWindow) return null;
  const result = await fileOps.saveFileAs(mainWindow, content, suggestedName);
  if (result) markRecentlyTouched(result.path);
  return result;
});

// RAISE-42: export the active doc to PDF. The renderer builds the
// print-shell HTML (markdown-it preview output + Rise CSS + print
// overrides) and hands it here; we render via an off-screen
// BrowserWindow + `webContents.printToPDF`, prompt the save dialog,
// and write the result. See `exportPdf.ts` for the full flow.
ipcMain.handle('export:to-pdf', async (_, opts: ExportPdfOptions): Promise<ExportPdfResult> => {
  if (!mainWindow) {
    return { status: 'error', message: 'No active window' };
  }
  return exportToPdf(mainWindow, opts);
});

// RAISE-53: Export-to-HTML. Same renderer-side `buildPrintHtml`
// pipeline as PDF; main applies the @font-face substitution and
// transforms `file://` image srcs into either inline data URIs
// (single-file mode) or relative paths in a zipped assets/ folder
// (zip mode). See `exportHtml.ts` for the full flow.
ipcMain.handle('export:to-html', async (_, opts: ExportHtmlOptions): Promise<ExportHtmlResult> => {
  if (!mainWindow) {
    return { status: 'error', message: 'No active window' };
  }
  return exportToHtml(mainWindow, opts);
});

ipcMain.handle(
  'dialog:confirm-unsaved',
  async (_, filename?: string): Promise<UnsavedChoice> => promptUnsavedChanges(filename),
);

ipcMain.handle(
  'dialog:confirm-reload',
  async (_, filename: string, isDirty: boolean): Promise<boolean> => {
    if (!mainWindow) return false;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Reload', 'Keep Editing'],
      defaultId: isDirty ? 1 : 0,
      cancelId: 1,
      message: `"${filename}" has been changed on disk.`,
      detail: isDirty
        ? 'You have unsaved changes — reloading will discard them.'
        : 'Reload the file from disk?',
    });
    return result.response === 0;
  },
);

ipcMain.on('dialog:show-error', (_, payload: { title: string; message: string }) => {
  if (!mainWindow) return;
  dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: payload.title,
    message: payload.title,
    detail: payload.message,
  });
});

// RAISE-38: open a URL in the user's default external browser instead of
// inside the renderer's webContents. Called by the WYSIWYG modifier-click
// handler and the Split-mode preview pane's link click handler.
//
// Strict scheme allowlist: only forward `http:`, `https:`, and `mailto:`.
// Anything else (especially `javascript:`, `file:`, custom URI schemes
// from extension links) is silently ignored — opening an arbitrary
// scheme via shell.openExternal is a known Electron security footgun.
ipcMain.on('shell:open-external', (_, url: unknown) => {
  if (typeof url !== 'string' || !url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const allowedSchemes = new Set(['http:', 'https:', 'mailto:']);
  if (!allowedSchemes.has(parsed.protocol)) return;
  void shell.openExternal(parsed.toString());
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

// Renderer pushes the active tab's path + isDirty plus the global dirty
// count synchronously on every change, so neither the title nor the
// close-with-unsaved decision can read a stale flag after a keystroke.
ipcMain.on(
  'file:meta',
  (_, meta: { path: string | null; isDirty: boolean; dirtyCount: number }) => {
    fileState.path = meta.path;
    fileState.isDirty = meta.isDirty;
    fileState.dirtyCount = meta.dirtyCount;
    refreshTitle();
  },
);

ipcMain.on('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

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
// and reopens the window if needed. RAISE-60: tag with `fromOs: true` so
// the renderer opens the resulting tab in Read mode by default.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  dispatchMenuAction('open-path', { path: filePath, fromOs: true });
});

// ---------------------------------------------------------------------------
// Project Mode: file-tree sidebar + folder watch
// ---------------------------------------------------------------------------

// Any I/O the editor initiates — saves and opens — can land in chokidar as a
// `change` event. Mark each touched file so the watcher's onFileChanged
// can ignore it for a short window. Without this, two unrelated bugs
// surface:
//
//   1. Every Save would prompt "this file changed on disk, reload?" right
//      after writing — the user would think the editor was haunted.
//   2. Opening a file that was created outside the editor (chokidar saw it
//      appear in the watched folder) fires a spurious `change` for it
//      moments after `openPath` returns, triggering the same false
//      "reload?" prompt on first open. ([RAISE-25](https://risepeople.atlassian.net/browse/RAISE-25))
const recentlyTouched = new Map<string, ReturnType<typeof setTimeout>>();
const RECENT_TOUCH_TTL_MS = 1500;

function markRecentlyTouched(filePath: string): void {
  const existing = recentlyTouched.get(filePath);
  if (existing) clearTimeout(existing);
  recentlyTouched.set(
    filePath,
    setTimeout(() => recentlyTouched.delete(filePath), RECENT_TOUCH_TTL_MS),
  );
}

// Forward chokidar events to the renderer. Tree changes ask the renderer to
// re-fetch the tree (it's a single IPC, the doc is small); single-file
// content changes go through a separate channel so the renderer can prompt
// "this file changed on disk, reload?" if the file is open in a tab.
folderWatcher.setListener({
  onTreeChanged: (root) => {
    folderWatcher.notifyRenderer(mainWindow, { type: 'tree', path: root });
    // Tree changes can include CLAUDE.md being created/deleted, which
    // flips the File menu's "New" / "Open" CLAUDE.md label. Rebuilds
    // are cheap and chokidar already debounces 75ms upstream.
    rebuildMenu();
  },
  onFileChanged: (filePath) => {
    if (recentlyTouched.has(filePath)) {
      // Refresh the TTL — slow disks (network mounts, FUSE, large files)
      // can land chokidar `change` events well after the editor's own I/O,
      // and a fixed window risks firing a phantom "reload?" prompt for
      // a save or open the user initiated themselves. Extending on each
      // suppressed event keeps the suppression alive until I/O goes
      // quiet, at which point a real external change fires the prompt
      // ~RECENT_TOUCH_TTL_MS later.
      markRecentlyTouched(filePath);
      return;
    }
    folderWatcher.notifyRenderer(mainWindow, { type: 'file', path: filePath });
  },
});

ipcMain.handle('folder:open', async () => {
  if (!mainWindow) return null;
  const folder = await folderOps.pickFolder(mainWindow);
  if (!folder) return null;
  const tree = await folderOps.readFolderTree(folder);
  await folderWatcher.watchFolder(folder);
  lastFolderStore.setLastFolder(folder);
  // Refresh the File menu label immediately — chokidar's debounced
  // tree event will catch up later, but the user expects the menu to
  // reflect the just-opened workspace on the next click, not in 75ms.
  rebuildMenu();
  return { path: folder, tree };
});

ipcMain.handle('folder:open-path', async (_, folderPath: string) => {
  const tree = await folderOps.readFolderTree(folderPath);
  await folderWatcher.watchFolder(folderPath);
  lastFolderStore.setLastFolder(folderPath);
  rebuildMenu();
  return { path: folderPath, tree };
});

ipcMain.handle('folder:get-tree', async (_, folderPath: string) =>
  folderOps.readFolderTree(folderPath),
);

// Probe a path's kind for the renderer's drag-drop handler. Returns
// 'directory' / 'file' / 'missing' so the dropper can route to the
// folder-open or file-open flow without relying on the file extension.
ipcMain.handle(
  'folder:stat-path',
  async (_, p: string): Promise<'file' | 'directory' | 'missing'> => {
    try {
      const stats = await fs.stat(p);
      return stats.isDirectory() ? 'directory' : 'file';
    } catch {
      return 'missing';
    }
  },
);

ipcMain.handle('folder:close', async () => {
  await folderWatcher.stopWatching();
  lastFolderStore.setLastFolder(null);
  rebuildMenu();
});

ipcMain.handle('folder:create-file', async (_, parentPath: string, name: string) =>
  folderOps.createFileNamed(parentPath, name),
);

ipcMain.handle('folder:create-folder', async (_, parentPath: string, name: string) =>
  folderOps.createNewFolder(parentPath, name),
);

ipcMain.handle('folder:rename', async (_, oldPath: string, newName: string) =>
  folderOps.renamePath(oldPath, newName),
);

ipcMain.handle('folder:trash', async (_, itemPath: string) => {
  await folderOps.trashPath(itemPath);
});

ipcMain.on('folder:reveal', (_, itemPath: string) => {
  folderOps.revealInFolder(itemPath);
});

ipcMain.handle(
  'folder:confirm-delete',
  async (_, name: string, isDirectory: boolean): Promise<boolean> => {
    if (!mainWindow) return false;
    const noun = isDirectory ? 'folder' : 'file';
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Move "${name}" to the Trash?`,
      detail: `The ${noun} will be moved to the system Trash and can be restored from there.`,
    });
    return result.response === 0;
  },
);

// Returns the user's chosen action from a native context menu for a file or
// folder in the tree. The renderer dispatches the actual operation.
type ItemMenuAction = 'new-file' | 'new-folder' | 'rename' | 'delete' | 'reveal' | 'open';

ipcMain.handle(
  'folder:show-item-menu',
  async (
    _,
    payload: { isDirectory: boolean; isMarkdown: boolean },
  ): Promise<ItemMenuAction | null> => {
    if (!mainWindow) return null;
    return new Promise<ItemMenuAction | null>((resolve) => {
      let chosen: ItemMenuAction | null = null;
      const items: MenuItemConstructorOptions[] = [];
      if (payload.isDirectory) {
        items.push(
          { label: 'New File', click: () => (chosen = 'new-file') },
          { label: 'New Folder', click: () => (chosen = 'new-folder') },
          { type: 'separator' },
        );
      } else if (payload.isMarkdown) {
        items.push({ label: 'Open', click: () => (chosen = 'open') }, { type: 'separator' });
      }
      items.push(
        { label: 'Rename', click: () => (chosen = 'rename') },
        { label: 'Delete', click: () => (chosen = 'delete') },
        { type: 'separator' },
        {
          label: process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in Explorer',
          click: () => (chosen = 'reveal'),
        },
      );
      const menu = Menu.buildFromTemplate(items);
      menu.popup({
        window: mainWindow!,
        callback: () => resolve(chosen),
      });
    });
  },
);

// RAISE-28: editor surface context menu (right-click in WYSIWYG / Source /
// preview). Built in main so it can use Electron's native `role` items
// for cut/copy/paste/select-all (which auto-act on the focused web
// contents) and dispatch the custom `Copy as Markdown` action through
// the same `menu:action` channel as the app menu.
ipcMain.handle(
  'context-menu:show-editor',
  async (_, payload: ShowEditorContextMenuPayload): Promise<void> => {
    if (!mainWindow) return;
    showEditorContextMenu(mainWindow, payload, dispatchMenuAction);
  },
);

ipcMain.handle('folder:get-last', async () => {
  // Restore on launch — return the last opened folder + its tree if it
  // still exists, otherwise null. Also primes the watcher so the renderer
  // can seed the sidebar without a separate round-trip.
  const last = lastFolderStore.getLastFolder();
  if (!last) return null;
  try {
    const tree = await folderOps.readFolderTree(last);
    await folderWatcher.watchFolder(last);
    // Refresh the File menu so "Open CLAUDE.md" / "New CLAUDE.md"
    // matches the restored workspace's state on first paint.
    rebuildMenu();
    return { path: last, tree };
  } catch {
    // Folder no longer exists or is unreadable — clear the persisted entry.
    lastFolderStore.setLastFolder(null);
    return null;
  }
});

ipcMain.handle('folder:get-sidebar-pref', async () => ({
  width: lastFolderStore.getSidebarWidth(),
  visible: lastFolderStore.getSidebarVisible(),
}));

ipcMain.on('folder:set-sidebar-width', (_, width: number) => {
  lastFolderStore.setSidebarWidth(width);
});

ipcMain.on('folder:set-sidebar-visible', (_, visible: boolean) => {
  lastFolderStore.setSidebarVisible(visible);
});

// ---------------------------------------------------------------------------
// Cowork templates: CLAUDE.md and SKILL.md scaffolding
// ---------------------------------------------------------------------------

/**
 * Result of a template-create request. Three shapes:
 *
 *  - `created` — file was written to disk; `path` points at it. The
 *    renderer should open it as a tab using the loaded content.
 *  - `exists` — target already exists (CLAUDE.md path collision); the
 *    renderer should just open the existing file.
 *  - `untitled` — no workspace was open, so we hand back the template
 *    body for the renderer to drop into a fresh untitled tab.
 */
type TemplateCreateResult =
  | { status: 'created'; path: string; content: string }
  | { status: 'exists'; path: string }
  | { status: 'untitled'; content: string };

/**
 * Find an unused filename inside `parentPath` by appending `-1`, `-2`,
 * ... before the extension. Used for skill-file creation when the
 * default name is already taken.
 */
async function findFreshSkillName(parentPath: string): Promise<string> {
  const base = 'untitled-skill';
  const ext = '.md';
  let candidate = `${base}${ext}`;
  let counter = 1;
  for (;;) {
    try {
      await fs.access(path.join(parentPath, candidate));
      candidate = `${base}-${counter}${ext}`;
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

ipcMain.handle(
  'templates:create',
  async (
    _,
    payload: { kind: templates.TemplateKind; rootPath: string | null },
  ): Promise<TemplateCreateResult> => {
    const { kind, rootPath } = payload;
    const content = templates.getTemplate(kind);
    if (!rootPath) {
      // Single-file mode — renderer creates an untitled tab from this body.
      return { status: 'untitled', content };
    }

    if (kind === 'claude') {
      const target = path.join(rootPath, templates.defaultFilename(kind));
      try {
        // `wx` fails with EEXIST if the file is already there — surface
        // that as a distinct status so the renderer can just open the
        // existing CLAUDE.md instead of overwriting it.
        await fs.writeFile(target, content, { encoding: 'utf-8', flag: 'wx' });
        markRecentlyTouched(target);
        return { status: 'created', path: target, content };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return { status: 'exists', path: target };
        throw err;
      }
    }

    // Skill: ensure `<root>/skills/` exists, then pick a non-colliding name.
    const subdir = templates.workspaceSubdir(kind); // 'skills'
    const parent = subdir ? path.join(rootPath, subdir) : rootPath;
    await fs.mkdir(parent, { recursive: true });
    const name = await findFreshSkillName(parent);
    const target = path.join(parent, name);
    await fs.writeFile(target, content, { encoding: 'utf-8', flag: 'wx' });
    markRecentlyTouched(target);
    return { status: 'created', path: target, content };
  },
);

ipcMain.handle('templates:claude-md-exists', async (_, rootPath: string): Promise<boolean> => {
  try {
    await fs.access(path.join(rootPath, 'CLAUDE.md'));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle(
  'templates:is-claude-banner-dismissed',
  async (_, rootPath: string): Promise<boolean> =>
    lastFolderStore.isClaudeBannerDismissed(rootPath),
);

ipcMain.on('templates:dismiss-claude-banner', (_, rootPath: string) => {
  lastFolderStore.dismissClaudeBanner(rootPath);
});

// ---------------------------------------------------------------------------
// Theme: hybrid light / dark with optional follow-system
// ---------------------------------------------------------------------------

function snapshotThemeState() {
  return {
    app: {
      preference: themeStore.getThemePreference(),
      resolved: themeStore.getResolvedTheme(),
    },
    editor: {
      preference: themeStore.getEditorThemePreference(),
      contrast: themeStore.getEditorContrast(),
      resolved: themeStore.getResolvedEditorTheme(),
      wordWrap: themeStore.getWordWrap(),
    },
  };
}

function broadcastThemeUpdate(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('theme:updated', snapshotThemeState());
  // Menu has Light / Dark / Follow System checkmarks (both for the app
  // and the editor submenus) that need to match the new state.
  rebuildMenu();
}

ipcMain.handle('theme:get', async () => snapshotThemeState());

ipcMain.handle('theme:set-app', async (_, pref: themeStore.ThemePreference) => {
  themeStore.setThemePreference(pref);
  broadcastThemeUpdate();
  return snapshotThemeState();
});

ipcMain.handle(
  'theme:set-editor',
  async (
    _,
    payload: {
      preference?: themeStore.ThemePreference;
      contrast?: themeStore.EditorContrast;
      wordWrap?: themeStore.WordWrap;
    },
  ) => {
    // No-op short-circuit when the caller passed nothing — avoids a
    // pointless menu rebuild + broadcast.
    if (
      payload.preference === undefined &&
      payload.contrast === undefined &&
      payload.wordWrap === undefined
    ) {
      return snapshotThemeState();
    }
    if (payload.preference !== undefined) {
      themeStore.setEditorThemePreference(payload.preference);
    }
    if (payload.contrast !== undefined) {
      themeStore.setEditorContrast(payload.contrast);
    }
    if (payload.wordWrap !== undefined) {
      themeStore.setWordWrap(payload.wordWrap);
    }
    broadcastThemeUpdate();
    return snapshotThemeState();
  },
);

// Atomic toggle. The renderer used to read its local React state, flip
// it, and call `theme:set-editor` with the explicit value — but two
// rapid presses could both close over the same stale state and end up
// at the same final value (two toggles "on → off → off" instead of
// "on → off → on"). Reading current state in main and flipping it here
// makes the read-modify-write uninterruptible (Node's event loop is
// single-threaded), so back-to-back toggles always alternate.
ipcMain.handle('theme:toggle-editor-word-wrap', async () => {
  const current = themeStore.getWordWrap();
  themeStore.setWordWrap(current === 'on' ? 'off' : 'on');
  broadcastThemeUpdate();
  return snapshotThemeState();
});

// macOS / Windows fire `nativeTheme.updated` when the OS appearance
// changes. Both the app and editor zones may follow it (when their
// preference is 'system'), so refreshing both resolved values is the
// right move regardless of which zone(s) are pinned.
nativeTheme.on('updated', () => {
  broadcastThemeUpdate();
});

// ---------------------------------------------------------------------------
// Image assets — drag-and-drop + paste (RAISE-11)
// ---------------------------------------------------------------------------

ipcMain.handle(
  'assets:save-dropped-image',
  async (_, payload: { markdownPath: string; sourcePath: string }): Promise<assetOps.SavedAsset> =>
    assetOps.saveDroppedImage(payload.markdownPath, payload.sourcePath),
);

ipcMain.handle(
  'assets:save-pasted-image',
  async (
    _,
    payload: { markdownPath: string; bytes: ArrayBuffer; mimeType: string },
  ): Promise<assetOps.SavedAsset> =>
    assetOps.savePastedImage(payload.markdownPath, payload.bytes, payload.mimeType),
);

// Resolve a markdown-relative image path against its containing file
// and open it in the OS-default app (Preview on macOS, Photos on
// Windows, default image viewer on Linux). The renderer doesn't have
// node:path, and joining platform-aware paths in JS is just begging
// for slash-vs-backslash bugs on Windows.
//
// Path-traversal guard: a malicious markdown file could have
// `![pwn](../../bin/sh)`. `path.resolve` follows the `..`, and
// `shell.openPath` would launch whatever the OS associated with the
// resolved file. Rejecting any relPath that escapes the markdown
// file's dirname keeps the click-to-open flow safe.
ipcMain.handle(
  'assets:open-relative',
  async (_, payload: { markdownPath: string; relPath: string }): Promise<string> => {
    const baseDir = path.dirname(payload.markdownPath);
    const abs = path.resolve(baseDir, payload.relPath);
    const rel = path.relative(baseDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return 'Refused: path escapes the markdown file directory';
    }
    return shell.openPath(abs);
  },
);

// Open a native image-file picker, then copy the chosen file into the
// markdown's assets/ folder. Used by the WYSIWYG toolbar's image button
// — replaces the previous window.prompt('Image URL') flow that no
// longer works in our sandboxed renderer.
ipcMain.handle(
  'assets:pick-and-import',
  async (_, markdownPath: string): Promise<assetOps.SavedAsset | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Insert Image',
      properties: ['openFile'],
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return assetOps.saveDroppedImage(markdownPath, result.filePaths[0]!);
  },
);
