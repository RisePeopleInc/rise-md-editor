import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * RAISE-12: auto-update wiring.
 *
 * Flow:
 *   1. App launches. If packaged (not dev), check GitHub Releases for
 *      a newer version.
 *   2. If found, electron-updater starts the download in the background.
 *      Renderer is notified via `update:available` so it can show a
 *      non-intrusive "A new version is downloading…" banner.
 *   3. When the download completes, renderer is notified via
 *      `update:downloaded`. The banner flips to "Restart to update"
 *      with a button.
 *   4. User clicks Restart → renderer fires `update:install` → main
 *      calls `autoUpdater.quitAndInstall()`. The user is never forced.
 *
 * Skipping in dev / unpackaged builds is important — autoUpdater would
 * otherwise try to fetch GitHub Releases artifacts that don't exist for
 * a `dev` version, and log noisy errors.
 */

export interface UpdateState {
  /** Most recent state seen from autoUpdater. */
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  /** Version string of the available update, if any (e.g. '0.2.0'). */
  version?: string;
  /** Last error message — surfaced in the renderer for debug; not auto-shown. */
  error?: string;
}

let lastState: UpdateState = { status: 'idle' };

function broadcast(state: UpdateState, window: BrowserWindow | null): void {
  lastState = state;
  if (!window || window.isDestroyed()) return;
  window.webContents.send('update:state', state);
}

/**
 * Wire the autoUpdater event handlers + kick off a check. Safe to call
 * multiple times — guards against double-registration. Pass the main
 * window so update events can be pushed to the renderer.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  // Auto-download is the default but make it explicit so the contract
  // is visible at the call site. Auto-install on quit stays off — we
  // want explicit user consent via the renderer banner.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ status: 'checking' }, getWindow());
  });

  autoUpdater.on('update-available', (info) => {
    broadcast({ status: 'available', version: info.version }, getWindow());
  });

  autoUpdater.on('update-not-available', () => {
    broadcast({ status: 'not-available' }, getWindow());
  });

  autoUpdater.on('download-progress', () => {
    // We don't surface progress percentage in the UI yet — too noisy.
    // The 'downloading' status keeps the banner saying "downloading…"
    // until the 'update-downloaded' event flips it to ready-to-install.
    if (lastState.status !== 'downloading') {
      broadcast(
        { status: 'downloading', version: lastState.version },
        getWindow(),
      );
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ status: 'downloaded', version: info.version }, getWindow());
  });

  autoUpdater.on('error', (err) => {
    broadcast(
      { status: 'error', error: err instanceof Error ? err.message : String(err) },
      getWindow(),
    );
  });

  // Renderer asks "what's the latest you've heard?" on its hook init,
  // so a banner that was already triggered before the renderer mounted
  // (rare, but possible on slow machines) still shows up.
  ipcMain.handle('update:get-state', async (): Promise<UpdateState> => lastState);

  ipcMain.on('update:install', () => {
    // quitAndInstall closes all windows + relaunches with the new
    // version. `false, false` = don't be silent (show progress) and
    // run after install (open the new app).
    autoUpdater.quitAndInstall(false, true);
  });

  // Skip the actual check in dev / unpackaged. autoUpdater would log a
  // benign error ("update info file not found") otherwise.
  if (!app.isPackaged) {
    broadcast({ status: 'idle' }, getWindow());
    return;
  }

  // Defer the first check by a few seconds so it doesn't compete with
  // the window's first-paint network and the renderer has time to
  // subscribe to the 'update:state' channel.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      broadcast(
        { status: 'error', error: err instanceof Error ? err.message : String(err) },
        getWindow(),
      );
    });
  }, 5_000);
}
